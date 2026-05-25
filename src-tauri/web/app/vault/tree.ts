/* Vault-Tree-Rendering + Interaktion. Kapselt:
   - Tree-DOM (#vault-tree, vault-region), Node-Lookup, Active-Marker,
   - Lazy-Children (insertVaultChildren), Pinned/Recent-Setter,
   - Klick-Routing (Tree-Reihen + Header-Buttons + vault-item-Klicks),
   - Rechtsklick-Routing (zur ui/context-menu),
   - File-Icon-Lookup mit Cache + MutationObserver,
   - refreshVault (kompletter Rebuild via vault_build_tree).

   Listener-Fusion: vault:refresh-Handler vereinigt die
   bisher zwei komplementaeren Haelften aus IIFE #1 (pinned/recent setzen
   aus Event-Payload) und IIFE #2 (Tree-Rebuild via invoke). Reihenfolge:
   pinned/recent zuerst (sync DOM-Patches), dann refreshVault async. */

import { openContextMenu, closeContextMenu } from './context-menu';
import { folioLog, safeInvoke } from '../util/log';

type Deps = {
    openDocument: (path: string) => void;
};

let deps: Deps = null;
let ROOT: HTMLElement = null;       // #vault-tree (li-Container des Haupttrees)
let REGION: HTMLElement = null;     // .vault-region (Wrapper inkl. Header + Tree)
let currentActivePath = '';

const fileIconCache: Record<string, string> = {};
const fileIconPending: Record<string, Promise<string>> = {};
const PIN_DRAG_TYPE = 'application/x-folio-pin';

function post(msg: any): void {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('shell:event', msg);
    }
}

function invoke(cmd: string, args?: any): Promise<any> {
    return window.__TAURI__.core.invoke(cmd, args);
}

function findNodeByPath(path: string): HTMLElement | null {
    if (!path) return null;
    const nodes = ROOT.querySelectorAll('.node');
    for (let i = 0; i < nodes.length; i++) {
        if ((nodes[i] as HTMLElement).getAttribute('data-path') === path) return nodes[i] as HTMLElement;
    }
    return null;
}

function findAllNodesByPath(path: string): HTMLElement[] {
    if (!path) return [];
    const matches: HTMLElement[] = [];
    const nodes = ROOT.querySelectorAll('.node');
    for (let i = 0; i < nodes.length; i++) {
        if ((nodes[i] as HTMLElement).getAttribute('data-path') === path) matches.push(nodes[i] as HTMLElement);
    }
    return matches;
}

function findAncestor(el: HTMLElement, cls: string): HTMLElement | null {
    while (el && el !== ROOT && el.nodeType === 1) {
        if (el.classList && el.classList.contains(cls)) return el;
        el = el.parentElement;
    }
    return null;
}

function reapplyActiveMarker(): void {
    const prev = ROOT.querySelectorAll('.node.active');
    for (let i = 0; i < prev.length; i++) prev[i].classList.remove('active');
    if (!currentActivePath) return;
    const nodes = findAllNodesByPath(currentActivePath);
    for (let n = 0; n < nodes.length; n++) nodes[n].classList.add('active');
}

function makePinnedItemsDraggable(): void {
    const section = ROOT.querySelector('li.section[data-section="pinned"]');
    if (!section) return;
    const ul = section.querySelector(':scope > ul.children');
    if (!ul) return;
    const items = Array.from(ul.children) as HTMLElement[];
    items.forEach((item: HTMLElement) => {
        if (item.classList.contains('node')) {
            item.setAttribute('draggable', 'true');
        }
    });
}

export function setVaultPinned(html: string): void {
    const section = ROOT.querySelector('li.section[data-section="pinned"]');
    if (!section) return;
    const ul = section.querySelector(':scope > ul.children');
    if (ul) ul.innerHTML = html || '';
    makePinnedItemsDraggable();
    reapplyActiveMarker();
}

export function setVaultRecent(html: string): void {
    const section = ROOT.querySelector('li.section[data-section="recent"]');
    if (!section) return;
    const ul = section.querySelector(':scope > ul.children');
    if (ul) ul.innerHTML = html || '';
    reapplyActiveMarker();
}

export function insertVaultChildren(path: string, html: string): void {
    // Pfad kann mehrfach im Baum vorkommen (z. B. neu angepinntes Unterverzeichnis
    // eines bereits angepinnten Ordners). Alle Vorkommen aktualisieren, sonst
    // landen die Children im falschen (ersten) Node.
    const lis = findAllNodesByPath(path);
    for (let n = 0; n < lis.length; n++) {
        const li = lis[n];
        const ul = li.querySelector(':scope > ul.children');
        if (!ul) continue;
        ul.innerHTML = html || '';
        ul.classList.remove('collapsed');
        const caret = li.querySelector(':scope > .row > .caret');
        if (caret) caret.classList.add('open');
        const iconEl = li.querySelector(':scope > .row > .icon');
        if (iconEl) iconEl.textContent = '📂';
    }
    reapplyActiveMarker();
}

export function setVaultActive(path: string): void {
    currentActivePath = path || '';
    reapplyActiveMarker();
}

export function reapplyVaultActive(): void {
    reapplyActiveMarker();
}

function toggleSection(section: HTMLElement): void {
    const key = section.getAttribute('data-section');
    const caret = section.querySelector(':scope > .row > .caret');
    const ul = section.querySelector(':scope > ul.children');
    const nowExpanded = !(caret && caret.classList.contains('open'));
    if (caret) caret.classList.toggle('open', nowExpanded);
    if (ul) ul.classList.toggle('collapsed', !nowExpanded);
    post({ type: 'toggle-section', section: key, expanded: nowExpanded });
}

function toggleDir(node: HTMLElement): void {
    const caret = node.querySelector(':scope > .row > .caret');
    const ul = node.querySelector(':scope > ul.children');
    const iconEl = node.querySelector(':scope > .row > .icon');
    const path = node.getAttribute('data-path');
    const open = caret && caret.classList.contains('open');
    if (open) {
        if (caret) caret.classList.remove('open');
        if (ul) ul.classList.add('collapsed');
        if (iconEl) iconEl.textContent = '📁';
        post({ type: 'collapse-dir', path });
    } else {
        if (caret) caret.classList.add('open');
        if (ul) ul.classList.remove('collapsed');
        if (iconEl) iconEl.textContent = '📂';
        // Immer neu vom Backend lesen — kein data-loaded-Cache. Das ist
        // der Auto-Refresh-Pfad: externe Dateiaenderungen im Ordner
        // werden so bei jedem Aufklappen sichtbar. Kombiniert mit dem
        // rekursiven Prune in Vault::on_collapse startet ein erneutes
        // Aufklappen mit komplett kollabiertem Subtree.
        post({ type: 'expand-dir', path });
    }
}

function resolveFileIcon(ext: string): Promise<string> {
    if (fileIconCache[ext] !== undefined) {
        return Promise.resolve(fileIconCache[ext]);
    }
    if (fileIconPending[ext]) return fileIconPending[ext];
    const p = invoke('file_icon_data_uri', { ext }).then(function (uri) {
        fileIconCache[ext] = uri || '';
        delete fileIconPending[ext];
        return fileIconCache[ext];
    }).catch(function () {
        fileIconCache[ext] = '';
        delete fileIconPending[ext];
        return '';
    });
    fileIconPending[ext] = p;
    return p;
}

function applyIconsToNode(rootNode: Element): void {
    if (!rootNode) return;
    let imgs: NodeListOf<Element> | Element[];
    if ((rootNode as HTMLElement).matches && (rootNode as HTMLElement).matches('img.ftype-icon')) {
        imgs = [rootNode];
    } else if (rootNode.querySelectorAll) {
        imgs = rootNode.querySelectorAll('img.ftype-icon');
    } else {
        return;
    }

    // Alle noch nicht aufgelösten Extensions sammeln und in einem Batch-Call
    // holen, statt pro Extension einen eigenen IPC-Roundtrip zu machen.
    const pending: { img: HTMLImageElement; ext: string }[] = [];
    const batchExts: string[] = [];
    for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i] as HTMLImageElement;
        if (img.src) continue;
        const ext = img.getAttribute('data-ext') || '';
        if (fileIconCache[ext] !== undefined) {
            if (fileIconCache[ext]) img.src = fileIconCache[ext];
        } else {
            pending.push({ img, ext });
            if (!fileIconPending[ext] && batchExts.indexOf(ext) === -1) {
                batchExts.push(ext);
            }
        }
    }

    if (pending.length === 0) return;

    if (batchExts.length > 0) {
        // Einzelne Promise für den gesamten Batch anlegen, damit parallele
        // MutationObserver-Aufrufe nicht doppelt feuern.
        const batchPromise = invoke('file_icons_batch', { exts: batchExts }).then(
            function (result: Record<string, string>) {
                for (const ext of batchExts) {
                    fileIconCache[ext] = result[ext] || '';
                    delete fileIconPending[ext];
                }
                return result;
            }
        ).catch(function () {
            for (const ext of batchExts) {
                fileIconCache[ext] = '';
                delete fileIconPending[ext];
            }
            return {} as Record<string, string>;
        });
        for (const ext of batchExts) {
            fileIconPending[ext] = batchPromise.then(function (r) { return r[ext] || ''; });
        }
    }

    // Jedes img wartet auf seinen Eintrag im Cache (via pending-Promise oder
    // direkt, falls ein anderer Batch gerade schon läuft).
    for (const { img, ext } of pending) {
        const p: Promise<string> = fileIconPending[ext]
            ? fileIconPending[ext]
            : Promise.resolve(fileIconCache[ext] || '');
        p.then(function (uri) { if (uri) img.src = uri; });
    }
}

function renderVault(html: string): void {
    if (!ROOT) return;
    if (!html || html.length === 0) {
        ROOT.innerHTML = '<li class="empty">Keine Einträge. Datei öffnen oder per Drag&amp;Drop ablegen.</li>';
        return;
    }
    ROOT.innerHTML = html;
    applyIconsToNode(ROOT);
    makePinnedItemsDraggable();
    reapplyActiveMarker();
}

export function refreshVault(): void {
    invoke('vault_build_tree').then(renderVault).catch(function (err) {
        // eslint-disable-next-line no-console
        console.warn('vault_build_tree failed:', err);
    });
}

function isDirectChildOfSection(node: HTMLElement, sectionKey: string): boolean {
    let n = node.parentElement;
    while (n) {
        if (n.classList && n.classList.contains('section')
            && n.getAttribute('data-section') === sectionKey) return true;
        if (n.classList && n.classList.contains('node')) return false;
        n = n.parentElement;
    }
    return false;
}

function hasPinDragType(dataTransfer: DataTransfer): boolean {
    const types = dataTransfer.types as any;
    if (!types) return false;
    if (typeof types.includes === 'function') return types.includes(PIN_DRAG_TYPE);
    if (typeof types.contains === 'function') return types.contains(PIN_DRAG_TYPE);
    for (let i = 0; i < types.length; i++) {
        if (types[i] === PIN_DRAG_TYPE) return true;
    }
    return false;
}

export function initVaultTree(d: Deps): void {
    deps = d;
    ROOT = document.getElementById('vault-tree');
    REGION = document.getElementById('vault-region');
    if (!ROOT || !REGION) return;

    // ----- Klick-Routing auf Tree-Reihen (Haupt-Tree) + Header-Buttons -----
    REGION.addEventListener('click', function (e: MouseEvent) {
        if (e.button !== 0) return;
        // Header-Buttons (addFile/addFolder)
        let cmdBtn = e.target as HTMLElement;
        while (cmdBtn && cmdBtn !== REGION && !(cmdBtn.classList && cmdBtn.classList.contains('vault-cmd'))) {
            cmdBtn = cmdBtn.parentElement;
        }
        if (cmdBtn && cmdBtn !== REGION && cmdBtn.classList.contains('vault-cmd')) {
            e.preventDefault();
            e.stopPropagation();
            const cmd = cmdBtn.getAttribute('data-cmd');
            if (cmd === 'addFile') {
                invoke('pick_file').then(function (path) {
                    if (path) deps.openDocument(path);
                }).catch(function (err) {
                    folioLog.warn('vault', 'pick_file failed', { error: String(err) });
                });
            } else if (cmd === 'addFolder') {
                invoke('pick_folder').then(function (path) {
                    if (path) safeInvoke('workspace_pin', { path, isDirectory: true }, 'workspace_pin');
                }).catch(function (err) {
                    folioLog.warn('vault', 'pick_folder failed', { error: String(err) });
                });
            }
            return;
        }
        // Tree-Rows
        let row: HTMLElement | null = e.target as HTMLElement;
        while (row && row !== ROOT && !(row.classList && row.classList.contains('row'))) {
            row = row.parentElement;
        }
        if (!row || row === ROOT) return;
        const node = findAncestor(row.parentElement, 'node');
        if (node) {
            const kind = node.getAttribute('data-kind');
            if (kind === 'dir') { toggleDir(node); return; }
            if (kind === 'file') {
                const p = node.getAttribute('data-path');
                if (p) deps.openDocument(p);
                return;
            }
        }
        const section = findAncestor(row.parentElement, 'section');
        if (section) toggleSection(section);
    });

    // Rechtsklick auf Tree-Reihen → Backend signalisieren (legacy-Pfad fuer
    // shell:event-context). UI-Side: openContextMenu wird unten beim
    // vaultTree-contextmenu fuer pinned/recent .vault-item-Strukturen
    // direkt aufgerufen.
    REGION.addEventListener('contextmenu', function (e: MouseEvent) {
        e.preventDefault();
        const node = findAncestor(e.target as HTMLElement, 'node');
        if (!node) {
            post({ type: 'context', path: null, x: e.clientX, y: e.clientY });
            return;
        }
        post({
            type: 'context',
            path: node.getAttribute('data-path'),
            kind: node.getAttribute('data-kind'),
            isPinned: node.getAttribute('data-pinned') === '1',
            isInRecent: node.getAttribute('data-recent') === '1',
            x: e.clientX,
            y: e.clientY,
        });
    });

    // ----- vault-item-Klicks (Pinned/Recent-Sections) + lokales Kontextmenue -----
    ROOT.addEventListener('click', function (e: MouseEvent) {
        const item = (e.target as HTMLElement).closest('.vault-item') as HTMLElement;
        if (!item) return;
        const path = item.getAttribute('data-path');
        const isDir = item.getAttribute('data-directory') === 'true';
        if (!path) return;
        if (isDir) {
            safeInvoke('vault_expand_dir', { path }, 'vault_expand_dir');
        } else {
            deps.openDocument(path);
        }
    });
    ROOT.addEventListener('contextmenu', function (e: MouseEvent) {
        const item = (e.target as HTMLElement).closest('li.node') as HTMLElement;
        if (!item) return;
        e.preventDefault();
        const path = item.getAttribute('data-path');
        const isDir = item.getAttribute('data-kind') === 'dir';
        const inPinned = isDirectChildOfSection(item, 'pinned');
        const inRecent = isDirectChildOfSection(item, 'recent');
        openContextMenu(e.clientX, e.clientY, path, isDir, inPinned, inRecent);
    });

    // ----- MutationObserver: File-Icons fuer neu hinzugefuegte Tree-Knoten -----
    if (typeof MutationObserver === 'function') {
        const iconObserver = new MutationObserver(function (mutations) {
            for (let m = 0; m < mutations.length; m++) {
                const added = mutations[m].addedNodes;
                for (let n = 0; n < added.length; n++) {
                    if (added[n].nodeType === 1) applyIconsToNode(added[n] as Element);
                }
            }
        });
        iconObserver.observe(ROOT, { childList: true, subtree: true });
    }

    // ----- Drag & Drop: Reordering of Pinned Items -----
    function getDirectPinnedItem(target: HTMLElement): HTMLElement | null {
        let el: HTMLElement | null = target;
        while (el && el !== ROOT) {
            if (el.classList && el.classList.contains('node') && isDirectChildOfSection(el, 'pinned')) {
                return el;
            }
            el = el.parentElement;
        }
        return null;
    }

    ROOT.addEventListener('dragstart', function (e: DragEvent) {
        if (!e.dataTransfer) return;
        const draggedItem = getDirectPinnedItem(e.target as HTMLElement);
        if (!draggedItem) {
            e.preventDefault();
            return;
        }
        const path = draggedItem.getAttribute('data-path') || '';
        if (!path) {
            e.preventDefault();
            return;
        }
        e.dataTransfer.setData(PIN_DRAG_TYPE, path);
        e.dataTransfer.effectAllowed = 'move';
        draggedItem.classList.add('dragging');
    });

    ROOT.addEventListener('dragend', function (e: DragEvent) {
        const draggedItem = getDirectPinnedItem(e.target as HTMLElement);
        if (draggedItem) {
            draggedItem.classList.remove('dragging');
        }
        const dropOvers = ROOT.querySelectorAll('.drop-over-before, .drop-over-after');
        dropOvers.forEach(el => {
            el.classList.remove('drop-over-before', 'drop-over-after');
        });
    });

    ROOT.addEventListener('dragover', function (e: DragEvent) {
        if (!e.dataTransfer) return;
        if (!hasPinDragType(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const targetItem = getDirectPinnedItem(e.target as HTMLElement);
        if (!targetItem || targetItem.classList.contains('dragging')) return;

        const rect = targetItem.getBoundingClientRect();
        const relativeY = e.clientY - rect.top;
        const isBefore = relativeY < rect.height / 2;

        const otherItems = ROOT.querySelectorAll('li.section[data-section="pinned"] > ul.children > li.node');
        otherItems.forEach((el: HTMLElement) => {
            if (el !== targetItem) {
                el.classList.remove('drop-over-before', 'drop-over-after');
            }
        });

        if (isBefore) {
            targetItem.classList.remove('drop-over-after');
            targetItem.classList.add('drop-over-before');
        } else {
            targetItem.classList.remove('drop-over-before');
            targetItem.classList.add('drop-over-after');
        }
    });

    ROOT.addEventListener('dragleave', function (e: DragEvent) {
        const targetItem = getDirectPinnedItem(e.target as HTMLElement);
        if (targetItem) {
            const related = e.relatedTarget as HTMLElement;
            if (!related || !targetItem.contains(related)) {
                targetItem.classList.remove('drop-over-before', 'drop-over-after');
            }
        }
    });

    ROOT.addEventListener('drop', function (e: DragEvent) {
        if (!e.dataTransfer) return;
        if (!hasPinDragType(e.dataTransfer)) return;
        e.preventDefault();
        const dragPath = e.dataTransfer.getData(PIN_DRAG_TYPE);
        if (!dragPath) return;

        const targetItem = getDirectPinnedItem(e.target as HTMLElement);
        if (!targetItem) return;

        const targetPath = targetItem.getAttribute('data-path');
        if (!targetPath || dragPath === targetPath) return;

        const ul = targetItem.parentElement;
        if (!ul) return;

        let draggedEl: HTMLElement | null = null;
        const children = Array.from(ul.children) as HTMLElement[];
        for (const child of children) {
            if (child.getAttribute('data-path') === dragPath) {
                draggedEl = child;
                break;
            }
        }
        if (!draggedEl) return;

        const isBefore = targetItem.classList.contains('drop-over-before');
        targetItem.classList.remove('drop-over-before', 'drop-over-after');

        if (isBefore) {
            ul.insertBefore(draggedEl, targetItem);
        } else {
            ul.insertBefore(draggedEl, targetItem.nextSibling);
        }

        const newPaths = Array.from(ul.children)
            .map(el => el.getAttribute('data-path'))
            .filter(Boolean) as string[];

        safeInvoke('workspace_reorder_pinned', { paths: newPaths }, 'workspace_reorder_pinned');
    });

    // ----- Listener-Fusion -----
    // Vorher in IIFE #1: pinned/recent aus Event-Payload setzen.
    // Vorher in IIFE #2: kompletter Tree-Rebuild via invoke('vault_build_tree').
    // Fusioniert: pinned/recent sync zuerst (kurzes DOM-Update vor dem
    // async vault_build_tree-Roundtrip), dann refreshVault async.
    window.__TAURI__.event.listen('vault:refresh', function (event) {
        const data = (event && event.payload) || {};
        if (data.pinned) setVaultPinned(data.pinned);
        if (data.recent) setVaultRecent(data.recent);
        refreshVault();
    });

    // vault:dir_changed feuert aus dem VaultWatcher (Backend) bei
    // Create/Delete/Modify/Rename im aktuell aufgeklappten Ordner.
    // Wir ruefen den expand-dir-Pfad genau fuer diesen Ordner neu —
    // damit landet der frische Inhalt sofort im Tree.
    // Bei Bursts (z.B. mehrere File-Saves) reicht ein Re-Build aus,
    // der VaultWatcher debounct schon im Worker-Thread.
    var ev = window.__TAURI__.event;
    if (ev && typeof ev.listen === 'function') {
        ev.listen('vault:dir_changed', function (event: any) {
            var data = (event && event.payload) || {};
            var path = data.path;
            if (!path || typeof path !== 'string') return;
            // Pfad-Normalisierung wie im Vault-Render: Backend liefert
            // aus notify-Events u.U. Backslash-Pfade.
            var normalized = path.replace(/\\/g, '/');
            // Nur refreshen, wenn der Ordner aktuell im DOM aufgeklappt
            // ist — der Watcher wird beim collapse zwar entfernt, aber
            // ein laufendes Event kann noch in der Queue stehen.
            var node = findAllNodesByPath(normalized)[0];
            if (!node) return;
            var ul = node.querySelector(':scope > ul.children') as HTMLElement | null;
            if (!ul || ul.classList.contains('collapsed')) return;
            window.__TAURI__.event.emit('shell:event', {
                type: 'expand-dir',
                path: normalized,
            });
        });
    }

    // Initial-Load
    refreshVault();
}
