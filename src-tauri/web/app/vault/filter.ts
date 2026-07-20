/* Vault-Tree-Filter (Namensfilter + „nur Markdown" + Match-Art) — Frontend.
   Spec: docs/spec-vault-filter.md (A6/A7 UX-Revision 2).

   Zwei Modi (A1):
   - Namensfilter aktiv (Query nichtleer) → Filter-Render-Modus: Backend
     `vault_filter`, gestutzter Baum in der Pinned-Section, Klasse
     `filtering` auf #vault-tree (Recent aus, Expand clientseitig, Pin-Drag aus).
   - Nur markdown_only → Lazy-Modus: `vault_filter_options_set` + refreshVault.

   Schließen = Aufräumen (A7): Funnel-Toggle zu, Zeilen-X, Escape-bei-leerem
   Input leeren die Query und verlassen den Filter-Render-Modus.

   Stale-Guard: monotones runId, Antworten mit runId < maxRunId verwerfen.
   Debounce 150 ms. Escape-Kaskade: 1) Query leeren 2) Zeile schließen. */

import { folioLog } from '../util/log';
import { refreshVault, reapplyVaultActive } from './tree';

const DEBOUNCE_MS = 150;

let barEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let mdChip: HTMLElement | null = null;
let filesChip: HTMLElement | null = null;
let dirsChip: HTMLElement | null = null;
let clearBtn: HTMLElement | null = null;
let closeBtn: HTMLElement | null = null;
let toggleBtn: HTMLElement | null = null;
let truncatedEl: HTMLElement | null = null;
let treeEl: HTMLElement | null = null;

/** Persistierte Filterzeilen-Sichtbarkeit. */
let barVisible = false;
/** Persistierter Typ-Filter. */
let markdownOnly = false;
/** Persistierte Match-Art (A7): Dateien dürfen matchen. Default true. */
let matchFiles = true;
/** Persistierte Match-Art (A7): Ordner dürfen matchen. Default true. */
let matchDirs = true;
/** Committed Namensfilter (nach Debounce angewandt). */
let committedQuery = '';
/** true, solange Filter-Render-Modus aktiv (Query nichtleer angewandt). */
let filterRenderActive = false;
/** vault:refresh/dir_changed während Filter-Render — nachziehen beim Verlassen. */
let pendingRefresh = false;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let nextRunId = 1;
let maxRunId = 0;
/** runId des zuletzt angeforderten Laufs (für In-Flight-Discard). */
let latestRequestRunId = 0;

/** Serialisierte Options-Schreibvorgänge (FX3 Doppelklick-Schutz). */
let optionsWriteChain: Promise<void> = Promise.resolve();

function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    return window.__TAURI__.core.invoke(cmd, args);
}

/** Filter-Render-Modus aktiv? (tree.ts: Expand clientseitig, Refresh puffern) */
export function isVaultFilterRenderMode(): boolean {
    return filterRenderActive;
}

/**
 * Funnel-Badge: nur persistente Präferenzen (A7).
 * Query zählt nicht — sie kann die Zeile nicht überleben.
 */
export function isVaultFilterActive(): boolean {
    return markdownOnly || !matchFiles || !matchDirs;
}

export function markVaultFilterRefreshPending(): void {
    pendingRefresh = true;
}

function persistOptions(): Promise<void> {
    const md = markdownOnly;
    const bar = barVisible;
    const files = matchFiles;
    const dirs = matchDirs;
    optionsWriteChain = optionsWriteChain
        .then(() =>
            invoke('vault_filter_options_set', {
                markdownOnly: md,
                barVisible: bar,
                matchFiles: files,
                matchDirs: dirs,
            }).then(() => undefined),
        )
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_filter_options_set failed', {
                error: String(err),
            });
        });
    return optionsWriteChain;
}

/** In-Flight-Filterantworten verwerfen (maxRunId vor next id anheben). */
function invalidateInFlightFilters(): void {
    maxRunId = Math.max(maxRunId, nextRunId);
    latestRequestRunId = 0;
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

function syncMatchChips(): void {
    if (filesChip) {
        filesChip.setAttribute('aria-pressed', matchFiles ? 'true' : 'false');
        filesChip.classList.toggle('active', matchFiles);
    }
    if (dirsChip) {
        dirsChip.setAttribute('aria-pressed', matchDirs ? 'true' : 'false');
        dirsChip.classList.toggle('active', matchDirs);
    }
}

function syncFunnelBadge(): void {
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('filter-active', isVaultFilterActive());
}

function setTruncatedVisible(show: boolean): void {
    if (!truncatedEl) return;
    truncatedEl.hidden = !show;
}

/**
 * Markiert in jedem `.label` das erste case-insensitive Vorkommen der
 * Query mit `<span class="vf-hit">`. Text-Node-sicher (kein innerHTML-
 * String-Replace) — Escaping bleibt intakt.
 */
function highlightQueryInLabels(root: Element, query: string): void {
    if (!query) return;
    const qLower = query.toLowerCase();
    if (!qLower) return;
    const labels = root.querySelectorAll('.label');
    for (let i = 0; i < labels.length; i++) {
        const label = labels[i] as HTMLElement;
        const text = label.textContent ?? '';
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(qLower);
        if (idx < 0) continue;
        const matchLen = qLower.length;
        const before = text.slice(0, idx);
        const hit = text.slice(idx, idx + matchLen);
        const after = text.slice(idx + matchLen);
        // Text-Nodes neu aufbauen — kein Markup-String-Replace.
        while (label.firstChild) label.removeChild(label.firstChild);
        if (before) label.appendChild(document.createTextNode(before));
        const span = document.createElement('span');
        span.className = 'vf-hit';
        span.appendChild(document.createTextNode(hit));
        label.appendChild(span);
        if (after) label.appendChild(document.createTextNode(after));
    }
}

function applyPinnedHtml(html: string): void {
    if (!treeEl) return;
    const section = treeEl.querySelector('li.section[data-section="pinned"]');
    if (!section) return;
    const ul = section.querySelector(':scope > ul.children');
    if (!ul) return;
    ul.innerHTML = html || '';
    if (committedQuery.length > 0) {
        highlightQueryInLabels(ul, committedQuery);
    }
    reapplyVaultActive();
}

function enterFilterRenderMode(html: string, truncated: boolean): void {
    filterRenderActive = true;
    if (treeEl) treeEl.classList.add('filtering');
    applyPinnedHtml(html);
    setTruncatedVisible(truncated);
    syncFunnelBadge();
}

function leaveFilterRenderMode(): Promise<void> {
    const wasActive = filterRenderActive;
    filterRenderActive = false;
    if (treeEl) treeEl.classList.remove('filtering');
    setTruncatedVisible(false);
    syncFunnelBadge();
    if (wasActive || pendingRefresh) {
        pendingRefresh = false;
        return refreshVault();
    }
    return Promise.resolve();
}

interface FilterResponse {
    html?: string;
    truncated?: boolean;
    nodeCount?: number;
    runId?: number;
}

function requestFilterRun(
    query: string,
    mdOnly: boolean,
    files: boolean,
    dirs: boolean,
): void {
    const runId = nextRunId++;
    latestRequestRunId = runId;
    if (runId > maxRunId) maxRunId = runId;

    invoke('vault_filter', {
        query,
        markdownOnly: mdOnly,
        matchFiles: files,
        matchDirs: dirs,
        runId,
    }).then((raw) => {
        const result = (raw || {}) as FilterResponse;
        const rid = typeof result.runId === 'number' ? result.runId : -1;
        if (rid < maxRunId || rid !== latestRequestRunId) {
            return;
        }
        if (query.length === 0) {
            return;
        }
        committedQuery = query;
        enterFilterRenderMode(result.html || '', !!result.truncated);
    }).catch((err) => {
        folioLog.warn('vault-filter', 'vault_filter failed', { error: String(err) });
    });
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
    if (q.length === 0) {
        committedQuery = '';
        invalidateInFlightFilters();
        leaveFilterRenderMode().then(() => {
            syncFunnelBadge();
        });
        return;
    }
    requestFilterRun(q, markdownOnly, matchFiles, matchDirs);
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
 * Zeile schließen UND Query leeren (A7): ein Pfad für Funnel-Toggle zu,
 * Zeilen-X und Escape bei leerem Input.
 */
function closeBar(): void {
    if (inputEl) inputEl.value = '';
    syncClearVisibility();
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    committedQuery = '';
    invalidateInFlightFilters();
    barVisible = false;
    syncBarVisibility();
    void leaveFilterRenderMode().then(() => {
        syncFunnelBadge();
    });
    void persistOptions();
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
    // FX3: In-Flight sofort invalidieren; Live-Input ist Quelle der Wahrheit.
    invalidateInFlightFilters();
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    const q = (inputEl?.value || '').trim();
    const write = persistOptions();
    if (q.length > 0) {
        // Filterlauf hängt nicht am persistierten State (markdownOnly
        // geht explizit mit) — kein Grund zu warten.
        requestFilterRun(q, markdownOnly, matchFiles, matchDirs);
    } else {
        committedQuery = '';
        // Lazy-Modus rendert aus panel_state: der Rebuild darf erst
        // NACH dem options_set laufen, sonst liest vault_build_tree
        // den alten Toggle-Wert (Race, E2E-Befund 2026-07-20).
        void write.then(() => {
            if (filterRenderActive || pendingRefresh) {
                return leaveFilterRenderMode();
            }
            return refreshVault();
        });
    }
}

/**
 * Match-Art-Chip: Umschalt-Geste — Klick auf den letzten aktiven Chip
 * aktiviert stattdessen den anderen (nie beide aus, A7).
 */
function onMatchFilesToggle(): void {
    if (matchFiles) {
        if (!matchDirs) {
            // Letzter aktiver Chip → umschalten auf nur Ordner.
            matchFiles = false;
            matchDirs = true;
        } else {
            matchFiles = false;
        }
    } else {
        matchFiles = true;
    }
    afterMatchKindChange();
}

function onMatchDirsToggle(): void {
    if (matchDirs) {
        if (!matchFiles) {
            // Letzter aktiver Chip → umschalten auf nur Dateien.
            matchDirs = false;
            matchFiles = true;
        } else {
            matchDirs = false;
        }
    } else {
        matchDirs = true;
    }
    afterMatchKindChange();
}

function afterMatchKindChange(): void {
    syncMatchChips();
    syncFunnelBadge();
    invalidateInFlightFilters();
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    const q = (inputEl?.value || '').trim();
    void persistOptions();
    if (q.length > 0) {
        // Live-Input als Query-Quelle (Muster onMdToggle).
        requestFilterRun(q, markdownOnly, matchFiles, matchDirs);
    }
    // Ohne Query nur persistieren — Match-Art wirkt nicht im Lazy-Baum.
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

/** Test-/Automation-Reset (FX10): Filterzustand auf Defaults. */
export function resetVaultFilterForAutomation(): void {
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (inputEl) inputEl.value = '';
    committedQuery = '';
    markdownOnly = false;
    matchFiles = true;
    matchDirs = true;
    barVisible = false;
    invalidateInFlightFilters();
    filterRenderActive = false;
    pendingRefresh = false;
    syncClearVisibility();
    syncMdChip();
    syncMatchChips();
    syncBarVisibility();
    setTruncatedVisible(false);
    if (treeEl) treeEl.classList.remove('filtering');
    syncFunnelBadge();
    void persistOptions();
    void refreshVault();
}

export function initVaultFilter(): () => void {
    barEl = document.getElementById('vault-filter');
    inputEl = document.getElementById('vault-filter-input') as HTMLInputElement | null;
    mdChip = document.getElementById('vault-filter-md');
    filesChip = document.getElementById('vault-filter-files');
    dirsChip = document.getElementById('vault-filter-dirs');
    clearBtn = document.getElementById('vault-filter-clear');
    closeBtn = document.getElementById('vault-filter-close');
    toggleBtn = document.getElementById('vault-filter-toggle');
    truncatedEl = document.getElementById('vault-filter-truncated');
    treeEl = document.getElementById('vault-tree');

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
    const onFilesClick = (e: MouseEvent) => {
        e.preventDefault();
        onMatchFilesToggle();
    };
    const onDirsClick = (e: MouseEvent) => {
        e.preventDefault();
        onMatchDirsToggle();
    };
    const onKeydown = (e: KeyboardEvent) => onEscapeInInput(e);

    toggleBtn.addEventListener('click', onToggleClick);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeydown);
    clearBtn?.addEventListener('click', onClearClick);
    closeBtn?.addEventListener('click', onCloseClick);
    mdChip?.addEventListener('click', onMdClick);
    filesChip?.addEventListener('click', onFilesClick);
    dirsChip?.addEventListener('click', onDirsClick);

    // Automation-/DevTools-Hook (Muster __folioSetLogLevel).
    (window as any).__folioVaultFilterReset = resetVaultFilterForAutomation;

    invoke('vault_filter_options_get')
        .then((raw) => {
            const opts = (raw || {}) as {
                markdownOnly?: boolean;
                barVisible?: boolean;
                matchFiles?: boolean;
                matchDirs?: boolean;
            };
            markdownOnly = !!opts.markdownOnly;
            barVisible = !!opts.barVisible;
            // Default true wenn Feld fehlt (ältere Persistenz).
            matchFiles = opts.matchFiles !== false;
            matchDirs = opts.matchDirs !== false;
            syncMdChip();
            syncMatchChips();
            syncBarVisibility();
            syncFunnelBadge();
        })
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_filter_options_get failed', {
                error: String(err),
            });
        });

    syncBarVisibility();
    syncClearVisibility();
    syncMdChip();
    syncMatchChips();
    syncFunnelBadge();
    setTruncatedVisible(false);

    return () => {
        toggleBtn?.removeEventListener('click', onToggleClick);
        inputEl?.removeEventListener('input', onInput);
        inputEl?.removeEventListener('keydown', onKeydown);
        clearBtn?.removeEventListener('click', onClearClick);
        closeBtn?.removeEventListener('click', onCloseClick);
        mdChip?.removeEventListener('click', onMdClick);
        filesChip?.removeEventListener('click', onFilesClick);
        dirsChip?.removeEventListener('click', onDirsClick);
        if ((window as any).__folioVaultFilterReset === resetVaultFilterForAutomation) {
            delete (window as any).__folioVaultFilterReset;
        }
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        filterRenderActive = false;
        pendingRefresh = false;
        committedQuery = '';
        markdownOnly = false;
        matchFiles = true;
        matchDirs = true;
        barVisible = false;
        maxRunId = 0;
        nextRunId = 1;
        latestRequestRunId = 0;
        optionsWriteChain = Promise.resolve();
    };
}
