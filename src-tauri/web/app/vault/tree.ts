/* Vault-Tree-Rendering + Interaktion. Kapselt:
   - Tree-DOM (#vault-tree, vault-region), Node-Lookup, Active-Marker,
   - Lazy-Children (insertVaultChildren), Pinned/Recent-Setter,
   - Klick-Routing (Tree-Reihen + Header-Buttons + vault-item-Klicks),
   - Rechtsklick-Routing (zur ui/context-menu),
   - File-Icon-Lookup mit Cache + MutationObserver,
   - refreshVault (kompletter Rebuild via vault_build_tree).

   Listener-Fusion (Plan-Phase 4.4): vault:refresh-Handler vereinigt die
   bisher zwei komplementaeren Haelften aus IIFE #1 (pinned/recent setzen
   aus Event-Payload) und IIFE #2 (Tree-Rebuild via invoke). Reihenfolge:
   pinned/recent zuerst (sync DOM-Patches), dann refreshVault async. */

import { openContextMenu, closeContextMenu } from './context-menu';

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
        li.setAttribute('data-loaded', '1');
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
    for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i] as HTMLImageElement;
        if (img.src) continue;
        const ext = img.getAttribute('data-ext') || '';
        (function (target, e) {
            resolveFileIcon(e).then(function (uri) {
                if (uri) target.src = uri;
            });
        })(img, ext);
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
                }).catch(function () {});
            } else if (cmd === 'addFolder') {
                invoke('pick_folder').then(function (path) {
                    if (path) invoke('workspace_pin', { path, isDirectory: true }).catch(function () {});
                }).catch(function () {});
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
            invoke('vault_expand_dir', { path }).catch(function () {});
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

    // ----- Listener-Fusion (Plan-Phase 4.4) -----
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

    // Initial-Load
    refreshVault();
}
