/* Git-Status-Dots im Vault-Baum.

   Backend emittiert `vault:git_status` (repoRoot + entries + generation)
   asynchron. Hier nur Klassen nachtragen — kein Re-Render. Letzter Stand
   je Repo bleibt liegen, damit lazy nachgeladene Knoten denselben
   Snapshot bekommen. Generation ist monoton pro Repo (wie document:*
   seq): aeltere Events werden verworfen. MutationObserver auf
   #vault-tree; takeRecords() im finally ist Pflicht (siehe
   vault/filter.ts). */

const CLASS_MODIFIED = 'git-modified';
const CLASS_UNTRACKED = 'git-untracked';

type GitStatus = 'modified' | 'untracked';
type Snapshot = Map<string, GitStatus>;

const lastByRepo = new Map<string, Snapshot>();
/** Hoechste bereits angewandte Generation je Repo. */
const lastGenByRepo = new Map<string, number>();

let treeEl: HTMLElement | null = null;
let treeObserver: MutationObserver | null = null;
let applying = false;

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

/** Test-Reset: Snapshot leeren und Klassen entfernen. */
export function __resetVaultGitStatusForTests(): void {
    lastByRepo.clear();
    lastGenByRepo.clear();
    if (treeEl) {
        const marked = treeEl.querySelectorAll(
            `li.node.${CLASS_MODIFIED}, li.node.${CLASS_UNTRACKED}`,
        );
        for (let i = 0; i < marked.length; i++) {
            marked[i].classList.remove(CLASS_MODIFIED, CLASS_UNTRACKED);
        }
    }
}
