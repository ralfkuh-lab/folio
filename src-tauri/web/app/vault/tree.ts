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

import { openContextMenu, closeContextMenu, runOrOpenFile } from './context-menu';
import {
    isVaultFilterRenderMode,
    markVaultFilterRefreshPending,
} from './filter';
import { folioLog, safeInvoke } from '../util/log';
import { t } from '../i18n/translate';

type Deps = {
    openDocument: (path: string) => void;
};

let deps: Deps = null;
let ROOT: HTMLElement = null;       // #vault-tree (li-Container des Haupttrees)
let REGION: HTMLElement = null;     // .vault-region (Wrapper inkl. Header + Tree)
let currentActivePath = '';

const fileIconCache: Record<string, string> = {};
const fileIconPending: Record<string, Promise<string>> = {};

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

export function setVaultPinned(html: string): void {
    const section = ROOT.querySelector('li.section[data-section="pinned"]');
    if (!section) return;
    const ul = section.querySelector(':scope > ul.children');
    if (ul) ul.innerHTML = html || '';
    // Kein draggable-Attribut noetig: das Reordering laeuft delegiert
    // ueber Pointer-Events (siehe initVaultTree), nicht ueber HTML5-DnD.
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
        // textContent only — never interpolate t() into innerHTML.
        ROOT.replaceChildren();
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = t('vault.tree.empty');
        ROOT.appendChild(empty);
        return;
    }
    ROOT.innerHTML = html;
    applyIconsToNode(ROOT);
    // Pin-Reordering laeuft delegiert ueber Pointer-Events (initVaultTree),
    // daher kein draggable-Attribut-Setup mehr noetig.
    reapplyActiveMarker();
}

export function refreshVault(): Promise<void> {
    return invoke('vault_build_tree').then(function (html) {
        // FX2: späte Lazy-Antwort darf den Filter-Render-Baum nicht
        // überschreiben — verwerfen und Refresh fürs Verlassen merken.
        if (isVaultFilterRenderMode()) {
            markVaultFilterRefreshPending();
            return;
        }
        renderVault(html);
    }).catch(function (err) {
        folioLog.warn('vault', 'vault_build_tree failed', { error: String(err) });
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
            if (kind === 'dir') {
                // Filter-Render-Modus: Baum ist voll aufgeklappt — Expand/
                // Collapse würde expanded_dirs verschmutzen (Spec F2).
                if (isVaultFilterRenderMode()) return;
                toggleDir(node);
                return;
            }
            if (kind === 'file') {
                const p = node.getAttribute('data-path');
                if (!p) return;
                // Ctrl/Cmd+Klick: in neuem Tab oeffnen (Browser-Konvention);
                // normaler Klick ersetzt das Dokument im aktiven Tab.
                if (e.ctrlKey || e.metaKey) {
                    safeInvoke('tab_open', { path: p }, 'tab_open');
                } else {
                    deps.openDocument(p);
                }
                return;
            }
        }
        const section = findAncestor(row.parentElement, 'section');
        if (section) toggleSection(section);
    });

    // Mittelklick auf eine Datei-Row: in neuem Tab oeffnen (Browser-
    // Konvention). auxclick statt click, weil Browser fuer button!=0
    // kein click-Event garantieren.
    REGION.addEventListener('auxclick', function (e: MouseEvent) {
        if (e.button !== 1) return;
        let row: HTMLElement | null = e.target as HTMLElement;
        while (row && row !== ROOT && !(row.classList && row.classList.contains('row'))) {
            row = row.parentElement;
        }
        if (!row || row === ROOT) return;
        const node = findAncestor(row.parentElement, 'node');
        if (!node || node.getAttribute('data-kind') !== 'file') return;
        const p = node.getAttribute('data-path');
        if (!p) return;
        e.preventDefault();
        safeInvoke('tab_open', { path: p }, 'tab_open');
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

    // Der fruehere `.vault-item`-Klickpfad ist entfernt: das Markup wird
    // vom Backend nirgends mehr erzeugt (Tree besteht aus .node/.row),
    // und der Pfad rief vault_expand_dir ohne VaultWatcher-Sync.
    ROOT.addEventListener('contextmenu', function (e: MouseEvent) {
        const item = (e.target as HTMLElement).closest('li.node') as HTMLElement;
        if (!item) return;
        e.preventDefault();
        const path = item.getAttribute('data-path');
        const isDir = item.getAttribute('data-kind') === 'dir';
        const inPinned = isDirectChildOfSection(item, 'pinned');
        const inRecent = isDirectChildOfSection(item, 'recent');
        const isExec = item.getAttribute('data-exec') === '1';
        openContextMenu(e.clientX, e.clientY, path, isDir, inPinned, inRecent, isExec);
    });

    // Doppelklick auf eine Datei loest die externe Aktion aus (ausfuehren /
    // mit Standardprogramm oeffnen) — "fast wie im Explorer". Der Einzelklick
    // (in Folio oeffnen) bleibt unveraendert und lief beim Doppelklick bereits;
    // diese Geste kommt bewusst zusaetzlich obendrauf. preventDefault
    // unterdrueckt die Wort-Selektion im Label. Verzeichnisse werden ignoriert.
    ROOT.addEventListener('dblclick', function (e: MouseEvent) {
        if (e.button !== 0) return;
        const item = (e.target as HTMLElement).closest('li.node') as HTMLElement;
        if (!item || item.getAttribute('data-kind') !== 'file') return;
        const p = item.getAttribute('data-path');
        if (!p) return;
        e.preventDefault();
        const isExec = item.getAttribute('data-exec') === '1';
        runOrOpenFile(p, isExec);
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

    // ----- Reordering der angepinnten Root-Items (Pointer-basiert) -----
    // BEWUSST kein HTML5-Drag&Drop: auf Windows/WebView2 faengt Tauris
    // OS-Level-Drag-Handler (dragDropEnabled=true, noetig fuers
    // Datei-Drop-zum-Oeffnen, siehe ui/drag-drop.ts) saemtliche
    // Drag-Operationen ab und liefert keine dragover/drop-Events mehr in
    // die WebView. Pointer-Events laufen unabhaengig davon und sind
    // plattformuebergreifend robust. Bewusst OHNE setPointerCapture:
    // ohne Capture ist e.target waehrend pointermove das Element unter
    // dem Cursor (normales Hit-Testing) — genau das, was wir zur
    // Drop-Ziel-Bestimmung brauchen, und in jsdom testbar.
    // Unterscheidet Klick (oeffnen) von Drag. 8 px statt frueher 4: bei
    // hochaufloesenden Maeusen/zittriger Hand akkumuliert ein normaler
    // Klick leicht >= 4 px zwischen pointerdown und pointerup und wurde
    // dann faelschlich als Drag gewertet (Klick verschluckt).
    const DRAG_THRESHOLD_PX = 8;

    function getDirectPinnedItem(target: HTMLElement | null): HTMLElement | null {
        let el: HTMLElement | null = target;
        while (el && el !== ROOT) {
            if (el.classList && el.classList.contains('node') && isDirectChildOfSection(el, 'pinned')) {
                return el;
            }
            el = el.parentElement;
        }
        return null;
    }

    function clearPinDropMarkers(): void {
        const marks = ROOT.querySelectorAll('.drop-over-before, .drop-over-after');
        marks.forEach(el => el.classList.remove('drop-over-before', 'drop-over-after'));
    }

    function commitPinReorder(draggedEl: HTMLElement, targetItem: HTMLElement, isBefore: boolean): void {
        const ul = targetItem.parentElement;
        if (!ul || draggedEl.parentElement !== ul || draggedEl === targetItem) return;
        if (isBefore) {
            ul.insertBefore(draggedEl, targetItem);
        } else {
            ul.insertBefore(draggedEl, targetItem.nextSibling);
        }
        const newPaths = Array.from(ul.children)
            .map(el => el.getAttribute('data-path'))
            .filter(Boolean) as string[];
        safeInvoke('workspace_reorder_pinned', { paths: newPaths }, 'workspace_reorder_pinned');
    }

    // { item, pointerId, startX, startY, active }
    let pinDrag: {
        item: HTMLElement;
        pointerId: number;
        startX: number;
        startY: number;
        active: boolean;
    } | null = null;
    // Nach einem echten Drag muss der vom Browser nachgereichte Klick
    // unterdrueckt werden, damit das angepinnte Dokument nicht geoeffnet wird.
    let suppressNextClick = false;

    function endPinDrag(): void {
        if (pinDrag) {
            pinDrag.item.classList.remove('dragging');
            pinDrag = null;
        }
        document.body.classList.remove('pin-dragging');
        clearPinDropMarkers();
    }

    ROOT.addEventListener('pointerdown', function (e: PointerEvent) {
        if (e.button !== 0) return;
        suppressNextClick = false;
        // Gefilterte Ansicht ist keine Reorder-Basis (Spec F2).
        if (ROOT.classList.contains('filtering') || isVaultFilterRenderMode()) return;
        const item = getDirectPinnedItem(e.target as HTMLElement);
        if (!item || !item.getAttribute('data-path')) return;
        // Drag nur ueber die EIGENE Zeile des Root-Items starten — nicht aus
        // verschachtelten Kind-Eintraegen eines aufgeklappten Pin-Ordners
        // (getDirectPinnedItem klettert sonst zum Eltern-Root). Als Drop-ZIEL
        // bleibt der gesamte Subtree gueltig (siehe pointermove/up).
        const ownRow = item.querySelector(':scope > .row');
        if (!ownRow || !ownRow.contains(e.target as Node)) return;
        pinDrag = {
            item,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            active: false,
        };
    });

    document.addEventListener('pointermove', function (e: PointerEvent) {
        if (!pinDrag || e.pointerId !== pinDrag.pointerId) return;

        if (!pinDrag.active) {
            const dx = e.clientX - pinDrag.startX;
            const dy = e.clientY - pinDrag.startY;
            if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
            pinDrag.active = true;
            pinDrag.item.classList.add('dragging');
            document.body.classList.add('pin-dragging');
        }
        e.preventDefault(); // Text-Selektion waehrend des Drags verhindern

        const targetItem = getDirectPinnedItem(e.target as HTMLElement);
        clearPinDropMarkers();
        if (!targetItem || targetItem === pinDrag.item) return;
        const rect = targetItem.getBoundingClientRect();
        const isBefore = (e.clientY - rect.top) < rect.height / 2;
        targetItem.classList.add(isBefore ? 'drop-over-before' : 'drop-over-after');
    });

    document.addEventListener('pointerup', function (e: PointerEvent) {
        if (!pinDrag || e.pointerId !== pinDrag.pointerId) return;
        const draggedEl = pinDrag.item;
        const wasActive = pinDrag.active;
        const beforeTarget = ROOT.querySelector('.drop-over-before') as HTMLElement | null;
        const afterTarget = ROOT.querySelector('.drop-over-after') as HTMLElement | null;
        endPinDrag();
        if (!wasActive) return;
        const targetItem = beforeTarget || afterTarget;
        // Den Folge-Klick nur schlucken, wenn wirklich umsortiert wurde.
        // Ein aktiver Drag OHNE Drop-Ziel ist praktisch immer ein
        // Wackel-Klick (Bewegung ueber dem eigenen Item) — der muss als
        // normaler Klick durchgehen, sonst reagiert die Row gefuehlt
        // "gar nicht" und der User klickt mehrfach.
        if (!targetItem) return;
        suppressNextClick = true;
        // Endet der Drag ausserhalb der Vault-Region, dispatcht der
        // Browser den Folge-Klick auf den gemeinsamen Ancestor — der
        // Capture-Listener unten feuert nie und das Flag bliebe armiert
        // (der naechste Klick auf die Header-Buttons wuerde geschluckt).
        // Der echte synthetische Klick kommt vor dem Timer-Fire
        // (Input-Queue vor Timer-Queue), danach wird entwaffnet.
        window.setTimeout(function () { suppressNextClick = false; }, 0);
        commitPinReorder(draggedEl, targetItem, !!beforeTarget);
    });

    document.addEventListener('pointercancel', function (e: PointerEvent) {
        if (!pinDrag || e.pointerId !== pinDrag.pointerId) return;
        endPinDrag();
    });

    // Capture-Phase vor dem REGION/ROOT-Klick-Routing: schluckt den
    // synthetischen Klick, der einem echten Pin-Drag folgt.
    REGION.addEventListener('click', function (e: MouseEvent) {
        if (suppressNextClick) {
            suppressNextClick = false;
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true);

    // ----- Listener-Fusion -----
    // Vorher in IIFE #1: pinned/recent aus Event-Payload setzen.
    // Vorher in IIFE #2: kompletter Tree-Rebuild via invoke('vault_build_tree').
    // Fusioniert: pinned/recent sync zuerst (kurzes DOM-Update vor dem
    // async vault_build_tree-Roundtrip), dann refreshVault async.
    window.__TAURI__.event.listen('vault:refresh', function (event) {
        const data = (event && event.payload) || {};
        // Filter-Render-Modus: Filterbaum nicht überschreiben; Refresh
        // beim Verlassen nachziehen (Spec F2). Automation-Ack trotzdem.
        if (isVaultFilterRenderMode()) {
            markVaultFilterRefreshPending();
            if (typeof data.requestId === 'number') {
                requestAnimationFrame(function () {
                    invoke('automation_ack', { id: data.requestId }).catch(function () {});
                });
            }
            return;
        }
        if (data.pinned) setVaultPinned(data.pinned);
        if (data.recent) setVaultRecent(data.recent);
        refreshVault().then(function () {
            if (typeof data.requestId !== 'number') return;
            requestAnimationFrame(function () {
                invoke('automation_ack', { id: data.requestId }).catch(function () {});
            });
        });
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
            // Filter-Render-Modus: Events puffern, kein expand-dir.
            if (isVaultFilterRenderMode()) {
                markVaultFilterRefreshPending();
                return;
            }
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
