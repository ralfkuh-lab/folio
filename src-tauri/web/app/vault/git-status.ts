/* Git-Status-Dots im Vault-Baum.

   Backend emittiert `vault:git_status` (repoRoot + entries + generation)
   asynchron. Hier nur Klassen nachtragen — kein Re-Render. Letzter Stand
   je Repo bleibt liegen, damit lazy nachgeladene Knoten denselben
   Snapshot bekommen. Generation ist monoton pro Repo (wie document:*
   seq): aeltere Events werden verworfen. MutationObserver auf
   #vault-tree; takeRecords() im finally ist Pflicht (siehe
   vault/filter.ts). */

import { t } from '../i18n/translate';

const CLASS_MODIFIED = 'git-modified';
const CLASS_UNTRACKED = 'git-untracked';
const TITLE_BASE_ATTR = 'data-title-base';

export type GitStatus = 'modified' | 'untracked';
type Snapshot = Map<string, GitStatus>;

const lastByRepo = new Map<string, Snapshot>();
/** Hoechste bereits angewandte Generation je Repo. */
const lastGenByRepo = new Map<string, number>();

let treeEl: HTMLElement | null = null;
let treeObserver: MutationObserver | null = null;
let applying = false;

/** Window-Event nach jedem angewandten Snapshot (Tabs, Toolbar, Filter). */
export const GIT_STATUS_CHANGED_EVENT = 'folio-git-status-changed';

function notifyGitStatusChanged(): void {
    window.dispatchEvent(new CustomEvent(GIT_STATUS_CHANGED_EVENT));
}

export function normalizeGitPath(path: string): string {
    return (path || '').replace(/\\/g, '/');
}

/** Segmentgrenze: `/repo/neu` matcht `/repo/neu/a.md`, nicht `/repo/neues.md`. */
export function pathIsUnder(path: string, parent: string): boolean {
    const child = normalizeGitPath(path);
    const root = normalizeGitPath(parent);
    if (!child || !root) return false;
    return child === root || child.startsWith(root + '/');
}

type PayloadEntry = { path?: unknown; status?: unknown };
type Payload = {
    repoRoot?: unknown;
    entries?: unknown;
    generation?: unknown;
    activeRoots?: unknown;
};

function isStatus(value: unknown): value is GitStatus {
    return value === 'modified' || value === 'untracked';
}

function mergeSnapshots(): Map<string, GitStatus> {
    const merged = new Map<string, GitStatus>();
    lastByRepo.forEach((snap) => {
        snap.forEach((status, path) => {
            merged.set(path, status);
        });
    });
    return merged;
}

/** Letzter bekannter Status fuer einen Vault-/Tab-Pfad, oder undefined. */
export function getPathGitStatus(path: string): GitStatus | undefined {
    const norm = normalizeGitPath(path);
    if (!norm) return undefined;
    const merged = mergeSnapshots();
    return merged.get(norm) ?? merged.get(path);
}

/** true nur bei modified (nicht untracked) — Diff gegen HEAD ist nur dann sinnvoll. */
export function isPathGitModified(path: string): boolean {
    return getPathGitStatus(path) === 'modified';
}

/**
 * Datei/Ordner zaehlt als geaendert bei exaktem Snapshot-Treffer ODER
 * unterhalb eines untracked-VERZEICHNISSES. `git status --untracked-files=normal`
 * meldet einen neuen Ordner als einen Eintrag; die Kinder fehlen im Snapshot.
 * Datei-Eintraege (DOM `data-kind=file`) sind keine Praefixe.
 */
export function isPathGitChanged(path: string): boolean {
    if (getPathGitStatus(path) !== undefined) return true;
    return isUnderUntrackedDir(path);
}

function snapshotPathIsFile(path: string): boolean {
    if (!treeEl) return false;
    const nodes = treeEl.querySelectorAll('li.node[data-kind="file"][data-path]');
    for (let i = 0; i < nodes.length; i++) {
        const nodePath = normalizeGitPath(
            (nodes[i] as HTMLElement).getAttribute('data-path') || '',
        );
        if (nodePath && nodePath === path) return true;
    }
    return false;
}

function isLeafUntrackedDir(snapPath: string, merged: Snapshot): boolean {
    if (merged.get(snapPath) !== 'untracked') return false;
    if (snapshotPathIsFile(snapPath)) return false;
    // Aggregierte Vorfahren haben weitere Snapshot-Pfade unter sich
    // (`?? neu/` ist ein Blatt ohne Kind-Eintraege).
    let hasSnapChild = false;
    merged.forEach((_status, other) => {
        if (hasSnapChild || other === snapPath) return;
        if (other.startsWith(snapPath + '/')) hasSnapChild = true;
    });
    return !hasSnapChild;
}

function isUnderUntrackedDir(path: string): boolean {
    const norm = normalizeGitPath(path);
    if (!norm) return false;
    const merged = mergeSnapshots();
    let hit = false;
    merged.forEach((_status, snapPath) => {
        if (hit || !isLeafUntrackedDir(snapPath, merged)) return;
        if (norm.startsWith(snapPath + '/')) hit = true;
    });
    return hit;
}

/**
 * Pfade aus dem Git-Snapshot, flach zuerst. Dateien filtert das Backend
 * (`is_dir`); die Aggregation liefert die Ordner bereits mit.
 */
export function collectGitChangedDirPaths(): string[] {
    const merged = mergeSnapshots();
    const out: string[] = [];
    merged.forEach((_status, path) => {
        if (path) out.push(path);
    });
    out.sort((a, b) => {
        const da = a.split('/').length;
        const db = b.split('/').length;
        return da - db || (a < b ? -1 : a > b ? 1 : 0);
    });
    return out;
}

function titleLineFor(status: GitStatus): string {
    return status === 'modified'
        ? t('vault.git.tooltip.modified')
        : t('vault.git.tooltip.untracked');
}

function applyTooltip(node: HTMLElement, status: GitStatus | undefined): void {
    // Basis ist der Backend-title (Pfad, optional Branch/gitignored).
    // Einmal merken, dann bei jedem Event aus der Basis neu aufbauen —
    // idempotent bei Doppel-Events, rueckstandsfrei wenn der Status weg ist.
    let base = node.getAttribute(TITLE_BASE_ATTR);
    if (base === null) {
        base = node.getAttribute('title') || '';
        node.setAttribute(TITLE_BASE_ATTR, base);
    }
    if (status) {
        const next = base ? `${base}\n${titleLineFor(status)}` : titleLineFor(status);
        node.setAttribute('title', next);
    } else {
        node.setAttribute('title', base);
    }
}

function clearTooltip(node: HTMLElement): void {
    const base = node.getAttribute(TITLE_BASE_ATTR);
    if (base !== null) {
        node.setAttribute('title', base);
        node.removeAttribute(TITLE_BASE_ATTR);
    }
}

function setNodeStatus(node: HTMLElement, status: GitStatus | undefined): void {
    if (status === 'modified') {
        node.classList.remove(CLASS_UNTRACKED);
        node.classList.add(CLASS_MODIFIED);
    } else if (status === 'untracked') {
        node.classList.remove(CLASS_MODIFIED);
        node.classList.add(CLASS_UNTRACKED);
    } else {
        node.classList.remove(CLASS_MODIFIED, CLASS_UNTRACKED);
    }
    applyTooltip(node, status);
}

function applyAll(): void {
    if (!treeEl) return;
    applying = true;
    try {
        const merged = mergeSnapshots();
        const nodes = treeEl.querySelectorAll('li.node[data-path]');
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i] as HTMLElement;
            const path = node.getAttribute('data-path') || '';
            setNodeStatus(node, path ? merged.get(path) : undefined);
        }
    } finally {
        // Eigene Klassen-Umbauten aus der Observer-Queue drainen — der
        // Callback feuert erst als Microtask NACH diesem Block, wenn
        // applying laengst wieder false ist. Ohne takeRecords: Endlos-
        // Loop, analog vault/filter.ts.
        treeObserver?.takeRecords();
        applying = false;
    }
}

function pruneInactiveRoots(activeRoots: unknown): void {
    if (!Array.isArray(activeRoots)) return;
    const keep = new Set<string>();
    for (let i = 0; i < activeRoots.length; i++) {
        const root = activeRoots[i];
        if (typeof root === 'string' && root) keep.add(root);
    }
    lastByRepo.forEach((_snap, root) => {
        if (!keep.has(root)) {
            lastByRepo.delete(root);
            lastGenByRepo.delete(root);
        }
    });
}

function onPayload(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const payload = raw as Payload;
    if (typeof payload.repoRoot !== 'string' || !payload.repoRoot) return;
    if (typeof payload.generation !== 'number' || !Number.isFinite(payload.generation)) return;
    if (!Array.isArray(payload.entries)) return;

    const prev = lastGenByRepo.get(payload.repoRoot);
    // Wie document:* seq: nur streng aeltere Snapshots verwerfen.
    // Gleiche Generation (Cache-Re-Emit nach Reload) bleibt erlaubt.
    if (prev !== undefined && payload.generation < prev) return;

    const snap: Snapshot = new Map();
    const entries = payload.entries as PayloadEntry[];
    let accepted = 0;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || typeof entry.path !== 'string' || !entry.path) continue;
        if (!isStatus(entry.status)) continue;
        snap.set(entry.path, entry.status);
        accepted += 1;
    }
    // Nichtleeres Array ohne einen gültigen Eintrag ist Müll, kein
    // bewusster Clear (`entries: []`). Zustand bleibt stehen.
    if (entries.length > 0 && accepted === 0) return;

    lastGenByRepo.set(payload.repoRoot, payload.generation);
    lastByRepo.set(payload.repoRoot, snap);
    pruneInactiveRoots(payload.activeRoots);
    applyAll();
    notifyGitStatusChanged();
}

export function initVaultGitStatus(): () => void {
    treeEl = document.getElementById('vault-tree');
    if (!treeEl) return () => {};

    const ev = window.__TAURI__ && window.__TAURI__.event;
    let unlisten: (() => void) | null = null;
    if (ev && typeof ev.listen === 'function') {
        const pending = ev.listen('vault:git_status', (event: { payload?: unknown }) => {
            onPayload(event && event.payload);
        });
        if (pending && typeof (pending as Promise<unknown>).then === 'function') {
            (pending as Promise<() => void>).then((fn) => {
                unlisten = fn;
            }).catch(() => {});
        }
    }

    if (typeof MutationObserver !== 'undefined') {
        treeObserver = new MutationObserver(() => {
            if (applying) return;
            if (lastByRepo.size === 0) return;
            applyAll();
        });
        treeObserver.observe(treeEl, { childList: true, subtree: true });
    }

    return () => {
        if (unlisten) unlisten();
        treeObserver?.disconnect();
        treeObserver = null;
        lastByRepo.clear();
        lastGenByRepo.clear();
        treeEl = null;
        applying = false;
    };
}

/** Test-Reset: Snapshot leeren und Klassen/Tooltip-Zusatz entfernen. */
export function __resetVaultGitStatusForTests(): void {
    lastByRepo.clear();
    lastGenByRepo.clear();
    if (treeEl) {
        const marked = treeEl.querySelectorAll(
            `li.node.${CLASS_MODIFIED}, li.node.${CLASS_UNTRACKED}, li.node[${TITLE_BASE_ATTR}]`,
        );
        for (let i = 0; i < marked.length; i++) {
            const node = marked[i] as HTMLElement;
            node.classList.remove(CLASS_MODIFIED, CLASS_UNTRACKED);
            clearTooltip(node);
        }
    }
}

/** Test-Helfer: Snapshot setzen, ohne Event-Payload. */
export function __setGitStatusSnapshotForTests(
    entries: Array<{ path: string; status: GitStatus }>,
): void {
    lastByRepo.clear();
    lastGenByRepo.clear();
    const snap: Snapshot = new Map();
    for (let i = 0; i < entries.length; i++) {
        snap.set(entries[i].path, entries[i].status);
    }
    if (snap.size > 0) {
        lastByRepo.set('__test__', snap);
        lastGenByRepo.set('__test__', 1);
    }
    applyAll();
    notifyGitStatusChanged();
}
