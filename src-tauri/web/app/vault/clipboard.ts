/* Vault-Zwischenablage für Ausschneiden/Kopieren/Einfügen.
   Reiner Modul-State, keine Persistenz. Die Klasse `vault-cut` markiert
   den ausgeschnittenen Eintrag im Baum, bis eingefügt oder ersetzt. */

export type VaultClipMode = 'cut' | 'copy';
export type VaultClip = { path: string; mode: VaultClipMode };

let clip: VaultClip | null = null;
let treeRoot: HTMLElement | null = null;
let treeObserver: MutationObserver | null = null;
let applying = false;

function normalizePath(path: string): string {
    return (path || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

export function getClip(): VaultClip | null {
    return clip ? { path: clip.path, mode: clip.mode } : null;
}

export function setClip(path: string, mode: VaultClipMode): void {
    const normalized = normalizePath(path);
    if (!normalized || normalized === '/') {
        clearClip();
        return;
    }
    clip = { path: normalized, mode };
    applyVaultCutMarks();
}

export function clearClip(): void {
    clip = null;
    applyVaultCutMarks();
}

function isUnder(path: string, root: string): boolean {
    const p = normalizePath(path);
    const r = normalizePath(root);
    if (r === '/') return p !== '/';
    return p === r || p.startsWith(r + '/');
}

export function remapClip(oldRoot: string, newRoot: string): void {
    if (!clip) return;
    const oldR = normalizePath(oldRoot);
    const newR = normalizePath(newRoot);
    if (clip.path === oldR) {
        clip = { path: newR, mode: clip.mode };
    } else if (oldR !== '/' && clip.path.startsWith(oldR + '/')) {
        clip = { path: newR + clip.path.slice(oldR.length), mode: clip.mode };
    } else {
        return;
    }
    applyVaultCutMarks();
}

export function clearClipIfUnder(root: string): void {
    if (clip && isUnder(clip.path, root)) clearClip();
}

export function applyVaultCutMarks(root?: ParentNode | null): void {
    const host = root || treeRoot || document.getElementById('vault-tree');
    if (!host) return;
    const nodes = host.querySelectorAll('li.node.vault-cut');
    for (let i = 0; i < nodes.length; i++) {
        nodes[i].classList.remove('vault-cut');
    }
    if (!clip || clip.mode !== 'cut') return;
    const wanted = clip.path;
    const all = host.querySelectorAll('li.node[data-path]');
    for (let i = 0; i < all.length; i++) {
        const node = all[i] as HTMLElement;
        const path = normalizePath(node.getAttribute('data-path') || '');
        if (path === wanted) node.classList.add('vault-cut');
    }
}

export function initVaultClipboard(root?: HTMLElement | null): void {
    treeRoot = root || document.getElementById('vault-tree');
    if (!treeRoot || treeObserver) return;
    treeObserver = new MutationObserver(function () {
        if (applying) return;
        applying = true;
        try {
            applyVaultCutMarks(treeRoot);
        } finally {
            treeObserver?.takeRecords();
            applying = false;
        }
    });
    treeObserver.observe(treeRoot, { childList: true, subtree: true });
    applyVaultCutMarks(treeRoot);
}

/** Test-Hook: Modul-State und Observer zurücksetzen. */
export function __resetVaultClipboardForTests(): void {
    clip = null;
    if (treeObserver) {
        treeObserver.disconnect();
        treeObserver = null;
    }
    treeRoot = null;
    applying = false;
}
