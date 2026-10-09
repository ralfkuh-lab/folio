/* Vault-Tree-Filter (R3/R3.1/R4) — Sicht über dem Lazy-Baum.
   Spec: docs/spec-vault-filter.md

   R3: Namensfilter blendet Datei-Zeilen ohne Match aus (Ordner immer
   sichtbar), Highlight span.vf-hit auf Datei- und Ordner-Labels. Re-Apply via
   MutationObserver auf #vault-tree (Reentranz-Guard).

   R4: Opt-in-Tiefenfilter (Chip `**`) und Ordnerbereich („In diesem Ordner
   filtern"). Aktiv bei (Chip ODER Bereich) UND Query ≥ 2 Zeichen. Das Backend
   (`vault_filter_find`) liefert die Trefferliste + Vorfahren-Ordner; die
   Ordner werden ueber `vault_expand_paths` geoeffnet (neu geoeffnete Pfade
   merken wir uns zum Aufraeumen), die Sichtbarkeit kommt aus der
   Trefferliste. Beim Verlassen werden NUR die vom Filter neu geoeffneten
   Ordner per `vault_collapse_paths` geschlossen.

   K1: Alle Baum-Operationen des Tiefenfilters (find → expand, collapse)
   laufen in EINER serialisierten Schleife `runDeepSync()` (nie doppelt,
   `deepSyncDirty` koalesziert). Jede Nutzeraktion setzt nur den Wunschzustand
   und ruft `requestDeepSync()`; die Schleife liest den Wunsch erst beim
   Ausfuehren eines Schritts. Veraltete Voll-HTML-Antworten werden nie
   angewandt (frischer `refreshVault()`), die tatsaechlich neuen `paths`
   werden IMMER eingesammelt und beim Verlassen geschlossen.

   „Nur Markdown" bleibt Backend-Lazy (options_set + refreshVault); md-only
   und `vaultShowHidden` sind Teil des Tiefen-Schluessels (K2).

   Baum-Ops: #vault-expand-roots / #vault-collapse-all. */

import { folioLog } from '../util/log';
import { t } from '../i18n/translate';
import {
    collectGitChangedDirPaths,
    GIT_STATUS_CHANGED_EVENT,
    isPathGitChanged,
    pathIsUnder,
} from './git-status';
import { refreshVault, reapplyVaultActive, renderVaultFromHtml } from './tree';

const DEBOUNCE_MS = 150;
/** Mindestlaenge der Query, ab der der Tiefenmodus greift (R4). */
const DEEP_MIN_QUERY = 2;

let barEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let mdChip: HTMLElement | null = null;
let gitChip: HTMLElement | null = null;
let deepChip: HTMLElement | null = null;
let scopeEl: HTMLElement | null = null;
let scopeNameEl: HTMLElement | null = null;
let scopeRemoveBtn: HTMLElement | null = null;
let clearBtn: HTMLElement | null = null;
let closeBtn: HTMLElement | null = null;
let toggleBtn: HTMLElement | null = null;
let treeEl: HTMLElement | null = null;
let expandRootsBtn: HTMLButtonElement | null = null;
let collapseAllBtn: HTMLElement | null = null;
let noticeEl: HTMLElement | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** Persistierte Filterzeilen-Sichtbarkeit. */
let barVisible = false;
/** Persistierter Typ-Filter. */
let markdownOnly = false;
/** Persistierter Git-Sichtfilter (nur geaenderte Dateien). */
let gitChangedOnly = false;
/** Persistierter Tiefenfilter-Chip (R4). */
let deepMode = false;
/** Fluechtiger Ordnerbereich (R4): absoluter Pfad oder null. */
let scopePath: string | null = null;
/** Committed Namensfilter (nach Debounce angewandt). */
let committedQuery = '';
/** Spiegel von `settings.vaultShowHidden` (Teil des Tiefen-Schluessels). */
let showHidden = true;
/** Letzte angewandte Tiefen-Antwort samt Schluessel (Query+Bereich+Flags). */
let deepState: { key: string; files: Set<string> } | null = null;
/** Vom Tiefenfilter NEU geoeffnete Ordner (Aufraeumen, R4 Punkt 7). */
const expandedByFilter = new Set<string>();
/** K1: serialisierte Sync-Schleife — laeuft nie doppelt, koalesziert Wünsche. */
let deepSyncRunning = false;
let deepSyncDirty = false;
/** Laeuft gerade ein Baum-IPC (expand/collapse) des Tiefenfilters. */
let deepIpcInFlight = false;
/** Fremde Baum-Mutation waehrend des IPC → kein stales Voll-HTML anwenden. */
let deepTreeMutated = false;
/** W2/W1-Rest: ein faelliger Baum-Rebuild wird im Sync-Lauf abgewartet. */
let deepRebuildWanted = false;
/** Verhindert parallele Expand-Laeufe beim Git-Filter. */
let expandGitInFlight = false;
/** Snapshot/Mutation waehrend eines Laufs → einen Durchlauf nachholen. */
let expandGitPending = false;
/** Kind-Inserts (manuelles Aufklappen) waehrend des IPC — HTML nicht clobbern. */
let treeMutatedDuringExpand = false;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Serialisierte Options-Schreibvorgänge. */
let optionsWriteChain: Promise<void> = Promise.resolve();
/** Reentranz-Guard: eigene DOM-Arbeit darf den Observer nicht retriggern. */
let applyingFilter = false;
let treeObserver: MutationObserver | null = null;

function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    return window.__TAURI__.core.invoke(cmd, args);
}

function normalizePath(path: string): string {
    return (path || '').replace(/\\/g, '/');
}

function basename(path: string): string {
    const n = normalizePath(path);
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(i + 1) : n;
}

/** Funnel-Badge: Namensfilter, md-only, git-only und/oder Ordnerbereich. */
export function isVaultFilterActive(): boolean {
    return (
        committedQuery.length > 0 ||
        markdownOnly ||
        gitChangedOnly ||
        scopePath !== null
    );
}

/** Tiefenmodus aktiv, wenn Chip ODER Bereich gesetzt ist und die Query lang
 *  genug ist (nach `trim`; `committedQuery` ist bereits getrimmt). */
function isDeepActive(): boolean {
    return (deepMode || scopePath !== null) && committedQuery.length >= DEEP_MIN_QUERY;
}

/** K1/K2: Schluessel der Tiefen-Sicht — aendert sich Query, Bereich, md-only
 *  oder `showHidden`, muss neu gesucht werden. */
function deepKey(): string {
    return [
        committedQuery,
        scopePath ?? '',
        markdownOnly ? '1' : '0',
        showHidden ? '1' : '0',
    ].join('\u0000');
}

function persistOptions(): Promise<void> {
    const md = markdownOnly;
    const bar = barVisible;
    const git = gitChangedOnly;
    const deep = deepMode;
    optionsWriteChain = optionsWriteChain
        .then(() =>
            invoke('vault_filter_options_set', {
                markdownOnly: md,
                barVisible: bar,
                gitChangedOnly: git,
                deep,
            }).then(() => undefined),
        )
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_filter_options_set failed', {
                error: String(err),
            });
        });
    return optionsWriteChain;
}

function syncBarVisibility(): void {
    if (barEl) barEl.hidden = !barVisible;
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', barVisible ? 'true' : 'false');
    }
}

function syncClearVisibility(): void {
    if (!clearBtn || !inputEl) return;
    clearBtn.hidden = !(inputEl.value.length > 0);
}

function syncMdChip(): void {
    if (!mdChip) return;
    mdChip.setAttribute('aria-pressed', markdownOnly ? 'true' : 'false');
    mdChip.classList.toggle('active', markdownOnly);
}

function syncGitChip(): void {
    if (!gitChip) return;
    gitChip.setAttribute('aria-pressed', gitChangedOnly ? 'true' : 'false');
    gitChip.classList.toggle('active', gitChangedOnly);
}

function syncDeepChip(): void {
    if (!deepChip) return;
    deepChip.setAttribute('aria-pressed', deepMode ? 'true' : 'false');
    deepChip.classList.toggle('active', deepMode);
}

function syncScopeChip(): void {
    if (!scopeEl) return;
    if (!scopePath) {
        scopeEl.hidden = true;
        scopeEl.removeAttribute('title');
        if (scopeNameEl) scopeNameEl.textContent = '';
        return;
    }
    if (scopeNameEl) scopeNameEl.textContent = basename(scopePath);
    scopeEl.title = scopePath;
    scopeEl.hidden = false;
}

/** Transienter Hinweis in #vault-tree-notice (R4: leer/cap/time). */
function showNotice(message: string): void {
    if (!noticeEl) return;
    noticeEl.textContent = message;
    noticeEl.hidden = false;
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
    }
    noticeTimer = setTimeout(() => {
        noticeTimer = null;
        if (noticeEl) noticeEl.hidden = true;
    }, 4000);
}

function hideNotice(): void {
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
    }
    if (noticeEl) noticeEl.hidden = true;
}

function showExpandCappedNotice(count: number): void {
    showNotice(t('vault.tree.expandCapped', { count: String(count) }));
}

/** Such-Antwort des Backends (nach Normalisierung). */
type FindResult = {
    files: Set<string>;
    dirs: string[];
    truncated: boolean;
    reason: string | null;
};

function parseFind(raw: unknown): FindResult {
    const r = (raw || {}) as {
        files?: unknown;
        dirs?: unknown;
        truncated?: unknown;
        reason?: unknown;
    };
    const files = new Set<string>();
    if (Array.isArray(r.files)) {
        for (let i = 0; i < r.files.length; i++) {
            const p = r.files[i];
            if (typeof p === 'string' && p) files.add(normalizePath(p));
        }
    }
    const dirs: string[] = [];
    if (Array.isArray(r.dirs)) {
        for (let i = 0; i < r.dirs.length; i++) {
            const p = r.dirs[i];
            if (typeof p === 'string' && p) dirs.push(normalizePath(p));
        }
    }
    return {
        files,
        dirs,
        truncated: r.truncated === true,
        reason: typeof r.reason === 'string' ? r.reason : null,
    };
}

/** Hinweis-Vorrang: Expand-Cap (K5) > find-truncated > leere Treffer > aus. */
function updateDeepNotice(res: FindResult): void {
    if (res.truncated) {
        showNotice(
            res.reason === 'time'
                ? t('vault.filter.notice.time')
                : t('vault.filter.notice.cap'),
        );
    } else if (res.files.size === 0) {
        showNotice(t('vault.filter.notice.noHits'));
    } else {
        hideNotice();
    }
}

// ----- K1: serialisierte Sync-Schleife --------------------------------------

/** Wunsch vormerken: laeuft die Schleife, wird nur koalesziert. */
function requestDeepSync(): void {
    if (deepSyncRunning) {
        deepSyncDirty = true;
        return;
    }
    void runDeepSync();
}

/** Faelligen Baum-Rebuild in den Sync-Lauf aufnehmen (md-Toggle, Hidden). */
function requestDeepRebuild(): void {
    deepRebuildWanted = true;
    requestDeepSync();
}

async function runDeepSync(): Promise<void> {
    deepSyncRunning = true;
    deepSyncDirty = false;
    try {
        do {
            deepSyncDirty = false;
            if (deepRebuildWanted) {
                // Der Rebuild gehoert in den serialisierten Schritt: sonst
                // ueberholt seine spaete Antwort den folgenden Deep-Expand.
                deepRebuildWanted = false;
                await refreshVault();
            }
            if (isDeepActive()) {
                await deepStepActive();
            } else {
                await deepStepInactive();
            }
        } while (deepSyncDirty || deepRebuildWanted);
    } finally {
        deepSyncRunning = false;
    }
}

/** Aktiver Schritt: nur suchen, wenn der Schluessel abweicht; danach
 *  aufklappen. Ergebnis wird verworfen, wenn waehrend des IPC ein neuer
 *  Wunsch eingetroffen ist. */
async function deepStepActive(): Promise<void> {
    const key = deepKey();
    if (deepState && deepState.key === key) return;

    const query = committedQuery;
    const scope = scopePath;
    let raw: unknown;
    try {
        raw = await invoke('vault_filter_find', { query, scope });
    } catch (err) {
        // N1: eine veraltete Fehlerantwort darf den aktuellen Wunsch nicht
        // anfassen (Bereich waere sonst weg).
        if (deepSyncDirty || deepKey() !== key) return;
        await onDeepError(err);
        return;
    }
    if (deepSyncDirty) return; // neue Query → verwerfen, Loop iteriert neu

    const res = parseFind(raw);
    deepState = { key, files: res.files };
    applyClientFilter();

    const expanded = await deepExpand(res.dirs);
    if (expanded) {
        // Diese Ordner sind im Backend offen — immer einsammeln, auch wenn
        // die Antwort schon nicht mehr gewuenscht ist (K1).
        for (let i = 0; i < expanded.paths.length; i++) {
            expandedByFilter.add(expanded.paths[i]);
        }
    }
    if (expanded && expanded.capped) {
        // K5: der Expand-Deckel erzeugt sonst ein stilles Teilergebnis.
        showExpandCappedNotice(expanded.expanded > 0 ? expanded.expanded : 1000);
    } else {
        updateDeepNotice(res);
    }
}

/** Inaktiver Schritt: Zustand verwerfen und die vom Filter geoeffneten Ordner
 *  wieder zuklappen (vorher offene bleiben offen). */
async function deepStepInactive(): Promise<void> {
    deepState = null;
    applyClientFilter();
    if (expandedByFilter.size === 0) return;

    const paths = Array.from(expandedByFilter);
    deepIpcInFlight = true;
    deepTreeMutated = false;
    let raw: unknown;
    try {
        raw = await invoke('vault_collapse_paths', { paths });
    } catch (err) {
        deepIpcInFlight = false;
        deepTreeMutated = false;
        folioLog.warn('vault-filter', 'vault_collapse_paths failed', {
            error: String(err),
        });
        return;
    }
    const stale = deepTreeMutated || deepSyncDirty;
    deepIpcInFlight = false;
    deepTreeMutated = false;
    expandedByFilter.clear();
    if (stale) {
        // Neuer Wunsch/Fremdmutation: altes Voll-HTML nie anwenden. Der
        // Refresh gehoert in den seriellen Schritt (B1-Rest).
        await refreshVault();
        return;
    }
    const html = (raw as { html?: unknown } | null)?.html;
    if (typeof html === 'string') renderVaultFromHtml(html);
}

/** `vault_expand_paths` mit Baum-Mutations-Schutz; liefert die neu
 *  geoeffneten Pfade und das `capped`-Flag. */
async function deepExpand(
    dirs: string[],
): Promise<{ paths: string[]; capped: boolean; expanded: number } | null> {
    deepIpcInFlight = true;
    deepTreeMutated = false;
    let raw: unknown;
    try {
        raw = await invoke('vault_expand_paths', { paths: dirs });
    } catch (err) {
        deepIpcInFlight = false;
        deepTreeMutated = false;
        folioLog.warn('vault-filter', 'vault_expand_paths failed', {
            error: String(err),
        });
        return null;
    }
    const stale = deepTreeMutated || deepSyncDirty;
    deepIpcInFlight = false;
    deepTreeMutated = false;
    const r = (raw || {}) as {
        html?: unknown;
        paths?: unknown;
        capped?: unknown;
        expanded?: unknown;
    };
    const paths: string[] = [];
    if (Array.isArray(r.paths)) {
        for (let i = 0; i < r.paths.length; i++) {
            const p = r.paths[i];
            if (typeof p === 'string' && p) paths.push(normalizePath(p));
        }
    }
    if (stale) {
        // B1-Rest: erst den frischen Baum abwarten, dann (im naechsten
        // Loop-Schritt) aufraeumen — sonst gewinnt eine spaete Antwort.
        await refreshVault();
    } else if (typeof r.html === 'string') {
        renderVaultFromHtml(r.html);
    }
    return {
        paths,
        capped: r.capped === true,
        expanded: typeof r.expanded === 'number' ? r.expanded : 0,
    };
}

/**
 * Backend-Fehler: Bereich entfernen und den Fehler transient zeigen. Nur
 * wenn wirklich ein Bereich entfernt wurde und der Chip weiter an ist, wird
 * ein Fallback-Lauf ohne Bereich vorgemerkt (N2: sonst kein Retry-Loop).
 * Expand-Reste des Fehlschlags werden aufgeraeumt.
 */
async function onDeepError(err: unknown): Promise<void> {
    const message = typeof err === 'string' ? err : String(err);
    const hadScope = scopePath !== null;
    if (hadScope) {
        scopePath = null;
        syncScopeChip();
        syncFunnelBadge();
    }
    deepState = null;
    applyClientFilter();
    showNotice(message);
    if (hadScope && isDeepActive()) {
        // Chip traegt den Tiefenmodus weiter → ohne Bereich erneut suchen.
        requestDeepSync();
        return;
    }
    // Kein Fallback: Schritt beenden und eigene Expand-Reste ueber den
    // gemeinsamen Aufraeumpfad zuklappen (inkl. abgewartetem Refresh, falls
    // die Collapse-Antwort inzwischen veraltet ist).
    await deepStepInactive();
}

/**
 * Pin-Wurzeln aus dem DOM. Expand bleibt frontendseitig auf diese
 * beschraenkt: `git status` liefert das ganze Repo, sichtbar ist nur der
 * Vault. Soft-Cap laeuft damit ueber die relevante Menge, nicht ueber
 * repo-weite Treffer; Watcher entstehen nicht fuer unsichtbare Zweige.
 */
function collectVisiblePinRootPaths(): string[] {
    if (!treeEl) return [];
    const roots = treeEl.querySelectorAll(
        'li.section[data-section="pinned"] > ul.children > li.node[data-path]',
    );
    const out: string[] = [];
    for (let i = 0; i < roots.length; i++) {
        const path = (roots[i] as HTMLElement).getAttribute('data-path') || '';
        if (path) out.push(path.replace(/\\/g, '/'));
    }
    return out;
}

function collectPinScopedGitDirs(): string[] {
    const pins = collectVisiblePinRootPaths();
    if (pins.length === 0) return [];
    return collectGitChangedDirPaths().filter((path) => {
        for (let i = 0; i < pins.length; i++) {
            if (pathIsUnder(path, pins[i])) return true;
        }
        return false;
    });
}

function expandGitChangedDirs(): Promise<void> {
    if (!gitChangedOnly) return Promise.resolve();
    if (expandGitInFlight) {
        expandGitPending = true;
        return Promise.resolve();
    }
    const dirs = collectPinScopedGitDirs();
    if (dirs.length === 0) return Promise.resolve();
    expandGitInFlight = true;
    treeMutatedDuringExpand = false;
    return invoke('vault_expand_paths', { paths: dirs })
        .then((raw) => {
            const result = (raw || {}) as {
                html?: string;
                capped?: boolean;
                expanded?: number;
            };
            // Waehrend des IPC aufgeklappte Ordner stehen im Backend bereits
            // in expanded_dirs. Stales Voll-HTML wuerde sie wieder zu machen
            // — deshalb nicht anwenden, sondern einen frischen Lauf nachholen.
            if (treeMutatedDuringExpand) {
                expandGitPending = true;
            } else if (typeof result.html === 'string') {
                renderVaultFromHtml(result.html);
            }
            if (result.capped) {
                const n = typeof result.expanded === 'number'
                    ? result.expanded
                    : 1000;
                showExpandCappedNotice(n);
            }
        })
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_expand_paths failed', {
                error: String(err),
            });
        })
        .then(() => {
            expandGitInFlight = false;
            if (expandGitPending) {
                expandGitPending = false;
                if (gitChangedOnly) return expandGitChangedDirs();
            }
        });
}

function syncFunnelBadge(): void {
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('filter-active', isVaultFilterActive());
}

/**
 * true, wenn es mindestens einen sichtbaren, zugeklappten Pin-Wurzel-Ordner
 * gibt (direkte li.node[data-kind=dir]-Kinder der Pinned-Section-ul;
 * vf-hidden zählt nicht).
 */
function hasCollapsedVisiblePinRoot(): boolean {
    if (!treeEl) return false;
    const roots = treeEl.querySelectorAll(
        'li.section[data-section="pinned"] > ul.children > li.node[data-kind="dir"]',
    );
    for (let i = 0; i < roots.length; i++) {
        const root = roots[i] as HTMLElement;
        if (root.classList.contains('vf-hidden')) continue;
        const caret = root.querySelector(':scope > .row > .caret');
        if (!caret) continue;
        if (!caret.classList.contains('open')) {
            return true;
        }
    }
    return false;
}

/** #vault-expand-roots: disabled, wenn keine zugeklappten Pin-Wurzeln. */
function syncExpandRootsDisabled(): void {
    if (!expandRootsBtn) return;
    expandRootsBtn.disabled = !hasCollapsedVisiblePinRoot();
}

/**
 * Entfernt alle `span.vf-hit` und stellt Text-Nodes wieder her
 * (Text-Node-sicher, normalize).
 */
function clearHighlights(root: Element): void {
    const hits = root.querySelectorAll('span.vf-hit');
    for (let i = 0; i < hits.length; i++) {
        const span = hits[i];
        const parent = span.parentNode;
        if (!parent) continue;
        while (span.firstChild) {
            parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
        if (parent.nodeType === Node.ELEMENT_NODE) {
            (parent as Element).normalize();
        }
    }
}

/**
 * Markiert in jedem `.label` das erste case-insensitive Vorkommen der
 * Query mit `<span class="vf-hit">`. Text-Node-sicher.
 */
function highlightQueryInLabels(root: Element, query: string): void {
    if (!query) return;
    const qLower = query.toLowerCase();
    if (!qLower) return;
    const labels = root.querySelectorAll('.label');
    for (let i = 0; i < labels.length; i++) {
        const label = labels[i] as HTMLElement;
        // Section-Labels (Pinned/Recent) nicht highlighten — nur Node-Labels.
        const node = label.closest('li.node');
        if (!node) continue;
        const text = label.textContent ?? '';
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(qLower);
        if (idx < 0) continue;
        const matchLen = qLower.length;
        const before = text.slice(0, idx);
        const hit = text.slice(idx, idx + matchLen);
        const after = text.slice(idx + matchLen);
        while (label.firstChild) label.removeChild(label.firstChild);
        if (before) label.appendChild(document.createTextNode(before));
        const span = document.createElement('span');
        span.className = 'vf-hit';
        span.appendChild(document.createTextNode(hit));
        label.appendChild(span);
        if (after) label.appendChild(document.createTextNode(after));
    }
}

function labelText(node: HTMLElement): string {
    const label = node.querySelector(':scope > .row > .label');
    return label?.textContent ?? '';
}

function isInRecentSection(node: HTMLElement): boolean {
    return !!node.closest('li.section[data-section="recent"]');
}

/** Ordner sichtbar im Tiefenmodus: Teil des Bereichspfads ODER Vorfahre einer
 *  sichtbaren **Pinned**-Datei (Recent-Treffer zaehlen bewusst nicht, K3). */
function isDeepDirVisible(path: string, visiblePinnedFiles: string[]): boolean {
    if (scopePath !== null && pathIsUnder(scopePath, path)) return true;
    for (let i = 0; i < visiblePinnedFiles.length; i++) {
        if (pathIsUnder(visiblePinnedFiles[i], path)) return true;
    }
    return false;
}

/** Client-Filter:
 *  - R3: Dateien ohne Namensmatch verstecken; Ordner immer da.
 *  - R4 (Tiefenmodus mit Antwort): Pinned-Datei sichtbar ⇔ in der
 *    Trefferliste, Pinned-Ordner ⇔ Vorfahre einer sichtbaren Pinned-Datei
 *    oder im Bereichspfad; Recent bleibt Namensmatch (+ Bereich). */
function applyClientFilter(): void {
    if (!treeEl) return;
    applyingFilter = true;
    try {
        clearHighlights(treeEl);
        const hidden = treeEl.querySelectorAll('li.node.vf-hidden');
        for (let i = 0; i < hidden.length; i++) {
            hidden[i].classList.remove('vf-hidden');
        }

        const q = committedQuery;
        const qLower = q.toLowerCase();
        const deepActive = isDeepActive() && deepState !== null;

        const files = treeEl.querySelectorAll('li.node[data-kind="file"]');
        const visiblePinnedFiles: string[] = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i] as HTMLElement;
            const path = normalizePath(file.getAttribute('data-path') || '');
            const name = labelText(file);
            const inRecent = isInRecentSection(file);
            let visible: boolean;
            if (deepActive && !inRecent) {
                visible = path !== '' && deepState!.files.has(path);
            } else {
                visible = !q || name.toLowerCase().includes(qLower);
                if (deepActive && scopePath !== null && !pathIsUnder(path, scopePath)) {
                    visible = false;
                }
            }
            if (visible && gitChangedOnly && !isPathGitChanged(path)) {
                visible = false;
            }
            if (!visible) {
                file.classList.add('vf-hidden');
            } else if (!inRecent && path) {
                visiblePinnedFiles.push(path);
            }
        }

        if (deepActive) {
            const dirs = treeEl.querySelectorAll('li.node[data-kind="dir"]');
            for (let i = 0; i < dirs.length; i++) {
                const dir = dirs[i] as HTMLElement;
                if (isInRecentSection(dir)) continue;
                const path = normalizePath(dir.getAttribute('data-path') || '');
                if (!isDeepDirVisible(path, visiblePinnedFiles)) {
                    dir.classList.add('vf-hidden');
                }
            }
        } else if (gitChangedOnly) {
            const dirs = treeEl.querySelectorAll('li.node[data-kind="dir"]');
            for (let i = 0; i < dirs.length; i++) {
                const dir = dirs[i] as HTMLElement;
                const path = dir.getAttribute('data-path') || '';
                if (!isPathGitChanged(path)) {
                    dir.classList.add('vf-hidden');
                }
            }
        }
        if (q) highlightQueryInLabels(treeEl, q);
        reapplyVaultActive();
    } finally {
        // Eigene childList-Mutationen (Highlight-Umbau) SYNCHRON aus der
        // Observer-Queue drainen — der Callback feuert erst als Microtask
        // NACH diesem Block, wenn applyingFilter längst wieder false ist.
        // Ohne takeRecords: Endlos-Loop Observer → Filter → Mutation → …
        treeObserver?.takeRecords();
        applyingFilter = false;
    }
}

function scheduleFromInput(): void {
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const q = (inputEl?.value || '').trim();
        applyQuery(q);
    }, DEBOUNCE_MS);
}

function applyQuery(q: string): void {
    committedQuery = q;
    applyClientFilter();
    syncFunnelBadge();
    requestDeepSync();
}

function clearQueryAndLeave(): void {
    if (inputEl) inputEl.value = '';
    syncClearVisibility();
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    applyQuery('');
}

/**
 * Zeile schließen UND Query leeren: Funnel-Toggle zu, Zeilen-X,
 * Escape bei leerem Input. Der Bereich ist flüchtig und wird mit entfernt.
 */
function closeBar(): void {
    if (inputEl) inputEl.value = '';
    syncClearVisibility();
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    committedQuery = '';
    scopePath = null;
    syncScopeChip();
    barVisible = false;
    syncBarVisibility();
    syncFunnelBadge();
    void persistOptions();
    requestDeepSync();
}

function setBarVisible(visible: boolean): void {
    if (!visible) {
        closeBar();
        return;
    }
    barVisible = true;
    syncBarVisibility();
    void persistOptions();
    if (inputEl) {
        inputEl.focus();
        inputEl.select();
    }
}

function toggleBar(): void {
    if (barVisible) {
        closeBar();
    } else {
        setBarVisible(true);
    }
}

function onMdToggle(): void {
    markdownOnly = !markdownOnly;
    syncMdChip();
    syncFunnelBadge();
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    // Lazy-Rebuild erst NACH options_set (Race, E2E-Befund 2026-07-20). Der
    // Rebuild laeuft im seriellen Sync-Schritt, damit seine spaete Antwort
    // nicht den folgenden Deep-Expand ueberholt (W1-Rest).
    void persistOptions().then(() => {
        requestDeepRebuild();
    });
}

function onGitToggle(): void {
    gitChangedOnly = !gitChangedOnly;
    syncGitChip();
    syncFunnelBadge();
    applyClientFilter();
    void persistOptions();
    if (gitChangedOnly) {
        // Aufklappen nur beim Aktivieren. Deaktivieren laesst den Baum.
        void expandGitChangedDirs();
    }
}

function onDeepToggle(): void {
    deepMode = !deepMode;
    syncDeepChip();
    syncFunnelBadge();
    void persistOptions();
    requestDeepSync();
}

/** Bereich-✕: zurück zu „alle Pins"; ob tief gefiltert wird, entscheidet der
 *  Chip. */
function onScopeRemove(e?: Event): void {
    e?.preventDefault();
    e?.stopPropagation();
    if (scopePath === null) return;
    scopePath = null;
    syncScopeChip();
    syncFunnelBadge();
    requestDeepSync();
    inputEl?.focus();
}

/**
 * Kontextmenü/Hook „In diesem Ordner filtern": öffnet die Filterzeile, setzt
 * den Ordnerbereich und fokussiert das Input. Ein erneutes Setzen ersetzt den
 * Bereich, behält aber die Query. Der Bereich impliziert den Tiefenmodus —
 * unabhängig vom persistierten Chip.
 */
export function filterInFolder(path: string): void {
    if (!path) return;
    scopePath = normalizePath(path);
    setBarVisible(true);
    syncScopeChip();
    syncFunnelBadge();
    requestDeepSync();
}

function onEscapeInInput(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    const hasText = !!(inputEl && inputEl.value.length > 0);
    if (hasText) {
        clearQueryAndLeave();
        return;
    }
    if (barVisible) {
        closeBar();
    }
}

/** K2: `vaultShowHidden` aendert den Tiefen-Schluessel (versteckte Treffer). */
function onSettingsChanged(payload: unknown): void {
    const p = (payload || {}) as { settings?: unknown; changed?: unknown };
    const changed = Array.isArray(p.changed) ? p.changed : [];
    const settings = (p.settings || {}) as { vaultShowHidden?: unknown };
    const next =
        typeof settings.vaultShowHidden === 'boolean'
            ? settings.vaultShowHidden
            : !changed.includes('vaultShowHidden');
    if (changed.includes('vaultShowHidden') && next !== showHidden) {
        showHidden = next;
        // Wie der md-Toggle: Rebuild im Sync-Schritt abwarten, dann suchen.
        requestDeepRebuild();
    }
}

function onExpandRoots(): void {
    invoke('vault_expand_roots')
        .then((raw) => {
            const result = (raw || {}) as { html?: string };
            if (typeof result.html === 'string') {
                renderVaultFromHtml(result.html);
            } else {
                return refreshVault();
            }
        })
        .then(() => {
            syncExpandRootsDisabled();
        })
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_expand_roots failed', {
                error: String(err),
            });
        });
}

function onCollapseAll(): void {
    invoke('vault_collapse_all')
        .then((raw) => {
            const result = (raw || {}) as { html?: string };
            if (typeof result.html === 'string') {
                renderVaultFromHtml(result.html);
            } else {
                return refreshVault();
            }
        })
        .then(() => {
            syncExpandRootsDisabled();
        })
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_collapse_all failed', {
                error: String(err),
            });
        });
}

/** Test-/Automation-Reset: Query leeren, Zeile zu, alle Chips aus, Bereich
 *  weg, vom Filter geoeffnete Ordner zuklappen. */
export function resetVaultFilterForAutomation(): void {
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (inputEl) inputEl.value = '';
    committedQuery = '';
    markdownOnly = false;
    gitChangedOnly = false;
    deepMode = false;
    scopePath = null;
    barVisible = false;
    deepState = null;
    deepRebuildWanted = false;
    syncClearVisibility();
    syncMdChip();
    syncGitChip();
    syncDeepChip();
    syncScopeChip();
    syncBarVisibility();
    applyClientFilter();
    syncFunnelBadge();
    syncExpandRootsDisabled();
    void persistOptions();
    requestDeepSync();
}

export function initVaultFilter(): () => void {
    barEl = document.getElementById('vault-filter');
    inputEl = document.getElementById('vault-filter-input') as HTMLInputElement | null;
    mdChip = document.getElementById('vault-filter-md');
    gitChip = document.getElementById('vault-filter-git');
    deepChip = document.getElementById('vault-filter-deep');
    scopeEl = document.getElementById('vault-filter-scope');
    scopeNameEl = document.getElementById('vault-filter-scope-name');
    scopeRemoveBtn = document.getElementById('vault-filter-scope-remove');
    clearBtn = document.getElementById('vault-filter-clear');
    closeBtn = document.getElementById('vault-filter-close');
    toggleBtn = document.getElementById('vault-filter-toggle');
    treeEl = document.getElementById('vault-tree');
    expandRootsBtn = document.getElementById(
        'vault-expand-roots',
    ) as HTMLButtonElement | null;
    collapseAllBtn = document.getElementById('vault-collapse-all');
    noticeEl = document.getElementById('vault-tree-notice');

    if (!barEl || !inputEl || !toggleBtn) {
        return () => {};
    }

    const onToggleClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        toggleBar();
    };
    const onInput = () => {
        syncClearVisibility();
        scheduleFromInput();
    };
    const onClearClick = (e: MouseEvent) => {
        e.preventDefault();
        clearQueryAndLeave();
        inputEl?.focus();
    };
    const onCloseClick = (e: MouseEvent) => {
        e.preventDefault();
        closeBar();
    };
    const onMdClick = (e: MouseEvent) => {
        e.preventDefault();
        onMdToggle();
    };
    const onGitClick = (e: MouseEvent) => {
        e.preventDefault();
        onGitToggle();
    };
    const onDeepClick = (e: MouseEvent) => {
        e.preventDefault();
        onDeepToggle();
    };
    const onScopeRemoveClick = (e: MouseEvent) => {
        onScopeRemove(e);
    };
    const onGitStatus = () => {
        if (gitChangedOnly) {
            applyClientFilter();
            void expandGitChangedDirs();
        }
    };
    const onKeydown = (e: KeyboardEvent) => onEscapeInInput(e);
    const onExpandClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onExpandRoots();
    };
    const onCollapseClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onCollapseAll();
    };
    const onSettingsEvent = (event: { payload?: unknown }) => {
        onSettingsChanged(event && event.payload);
    };

    toggleBtn.addEventListener('click', onToggleClick);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeydown);
    clearBtn?.addEventListener('click', onClearClick);
    closeBtn?.addEventListener('click', onCloseClick);
    mdChip?.addEventListener('click', onMdClick);
    gitChip?.addEventListener('click', onGitClick);
    deepChip?.addEventListener('click', onDeepClick);
    scopeRemoveBtn?.addEventListener('click', onScopeRemoveClick);
    window.addEventListener(GIT_STATUS_CHANGED_EVENT, onGitStatus);
    expandRootsBtn?.addEventListener('click', onExpandClick);
    collapseAllBtn?.addEventListener('click', onCollapseClick);

    let settingsUnlisten: (() => void) | null = null;
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && typeof ev.listen === 'function') {
        const pending = ev.listen('settings:changed', onSettingsEvent);
        if (pending && typeof (pending as Promise<unknown>).then === 'function') {
            (pending as Promise<() => void>)
                .then((fn) => {
                    settingsUnlisten = fn;
                })
                .catch(() => {});
        }
    }
    invoke('settings_get')
        .then((raw) => {
            const data = (raw || {}) as { vaultShowHidden?: unknown };
            if (typeof data.vaultShowHidden === 'boolean') {
                showHidden = data.vaultShowHidden;
            }
        })
        .catch(() => {});

    if (treeEl && typeof MutationObserver !== 'undefined') {
        treeObserver = new MutationObserver(() => {
            if (expandGitInFlight) treeMutatedDuringExpand = true;
            if (deepIpcInFlight) deepTreeMutated = true;
            if (applyingFilter) return;
            if (committedQuery.length > 0 || gitChangedOnly) {
                applyClientFilter();
            }
            // Expand-Roots-Disabled immer (nicht nur bei aktiver Query).
            syncExpandRootsDisabled();
        });
        treeObserver.observe(treeEl, { childList: true, subtree: true });
    }

    // Automation-/DevTools-Hook (Muster __folioSetLogLevel).
    (window as any).__folioVaultFilterReset = resetVaultFilterForAutomation;
    (window as any).__folioVaultFilterInFolder = filterInFolder;

    invoke('vault_filter_options_get')
        .then((raw) => {
            const opts = (raw || {}) as {
                markdownOnly?: boolean;
                barVisible?: boolean;
                gitChangedOnly?: boolean;
                deep?: boolean;
            };
            markdownOnly = !!opts.markdownOnly;
            barVisible = !!opts.barVisible;
            gitChangedOnly = !!opts.gitChangedOnly;
            deepMode = !!opts.deep;
            syncMdChip();
            syncGitChip();
            syncDeepChip();
            syncScopeChip();
            syncBarVisibility();
            syncFunnelBadge();
            if (gitChangedOnly) {
                applyClientFilter();
                void expandGitChangedDirs();
            }
        })
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_filter_options_get failed', {
                error: String(err),
            });
        });

    syncBarVisibility();
    syncClearVisibility();
    syncMdChip();
    syncGitChip();
    syncDeepChip();
    syncScopeChip();
    syncFunnelBadge();
    // Initial nach Boot-Tree (DOM kann schon befüllt sein; Observer greift
    // für spätere Rebuilds).
    syncExpandRootsDisabled();

    return () => {
        toggleBtn?.removeEventListener('click', onToggleClick);
        inputEl?.removeEventListener('input', onInput);
        inputEl?.removeEventListener('keydown', onKeydown);
        clearBtn?.removeEventListener('click', onClearClick);
        closeBtn?.removeEventListener('click', onCloseClick);
        mdChip?.removeEventListener('click', onMdClick);
        gitChip?.removeEventListener('click', onGitClick);
        deepChip?.removeEventListener('click', onDeepClick);
        scopeRemoveBtn?.removeEventListener('click', onScopeRemoveClick);
        window.removeEventListener(GIT_STATUS_CHANGED_EVENT, onGitStatus);
        expandRootsBtn?.removeEventListener('click', onExpandClick);
        collapseAllBtn?.removeEventListener('click', onCollapseClick);
        if (settingsUnlisten) settingsUnlisten();
        settingsUnlisten = null;
        treeObserver?.disconnect();
        treeObserver = null;
        if ((window as any).__folioVaultFilterReset === resetVaultFilterForAutomation) {
            delete (window as any).__folioVaultFilterReset;
        }
        if ((window as any).__folioVaultFilterInFolder === filterInFolder) {
            delete (window as any).__folioVaultFilterInFolder;
        }
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        if (noticeTimer !== null) {
            clearTimeout(noticeTimer);
            noticeTimer = null;
        }
        committedQuery = '';
        markdownOnly = false;
        gitChangedOnly = false;
        deepMode = false;
        scopePath = null;
        showHidden = true;
        deepState = null;
        expandedByFilter.clear();
        barVisible = false;
        expandGitInFlight = false;
        expandGitPending = false;
        treeMutatedDuringExpand = false;
        deepSyncRunning = false;
        deepSyncDirty = false;
        deepRebuildWanted = false;
        deepIpcInFlight = false;
        deepTreeMutated = false;
        optionsWriteChain = Promise.resolve();
    };
}
