/* Vault-Tree-Filter (Namensfilter + „nur Markdown") — Frontend F2.
   Spec: docs/spec-vault-filter.md.

   Zwei Modi (A1):
   - Namensfilter aktiv (Query nichtleer) → Filter-Render-Modus: Backend
     `vault_filter`, gestutzter Baum in der Pinned-Section, Klasse
     `filtering` auf #vault-tree (Recent aus, Expand inert, Pin-Drag aus).
   - Nur markdown_only → Lazy-Modus: `vault_filter_options_set` + refreshVault.

   Stale-Guard: monotones runId, Antworten mit runId < maxRunId verwerfen.
   Debounce 150 ms. Escape-Kaskade: 1) Query leeren 2) Zeile schließen. */

import { folioLog } from '../util/log';
import { refreshVault, reapplyVaultActive } from './tree';

const DEBOUNCE_MS = 150;

let barEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let mdChip: HTMLElement | null = null;
let clearBtn: HTMLElement | null = null;
let toggleBtn: HTMLElement | null = null;
let truncatedEl: HTMLElement | null = null;
let treeEl: HTMLElement | null = null;

/** Persistierte Filterzeilen-Sichtbarkeit. */
let barVisible = false;
/** Persistierter Typ-Filter. */
let markdownOnly = false;
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

/** Filter-Render-Modus aktiv? (tree.ts: Expand inert, Refresh puffern) */
export function isVaultFilterRenderMode(): boolean {
    return filterRenderActive;
}

/** Wirksamer Filter (Query oder markdown_only) — Funnel-Badge. */
export function isVaultFilterActive(): boolean {
    return committedQuery.length > 0 || markdownOnly;
}

export function markVaultFilterRefreshPending(): void {
    pendingRefresh = true;
}

function persistOptions(): Promise<void> {
    const md = markdownOnly;
    const bar = barVisible;
    optionsWriteChain = optionsWriteChain
        .then(() =>
            invoke('vault_filter_options_set', {
                markdownOnly: md,
                barVisible: bar,
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

function syncFunnelBadge(): void {
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('filter-active', isVaultFilterActive());
}

function setTruncatedVisible(show: boolean): void {
    if (!truncatedEl) return;
    truncatedEl.hidden = !show;
}

function applyPinnedHtml(html: string): void {
    if (!treeEl) return;
    const section = treeEl.querySelector('li.section[data-section="pinned"]');
    if (!section) return;
    const ul = section.querySelector(':scope > ul.children');
    if (!ul) return;
    ul.innerHTML = html || '';
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

function requestFilterRun(query: string, mdOnly: boolean): void {
    const runId = nextRunId++;
    latestRequestRunId = runId;
    if (runId > maxRunId) maxRunId = runId;
    const modeSnapshot = mdOnly;

    invoke('vault_filter', {
        query,
        markdownOnly: modeSnapshot,
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
    requestFilterRun(q, markdownOnly);
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

function setBarVisible(visible: boolean): void {
    barVisible = visible;
    syncBarVisibility();
    void persistOptions();
    if (visible && inputEl) {
        inputEl.focus();
        inputEl.select();
    }
}

function toggleBar(): void {
    setBarVisible(!barVisible);
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
        // Filterlauf haengt nicht am persistierten State (markdownOnly
        // geht explizit mit) — kein Grund zu warten.
        requestFilterRun(q, markdownOnly);
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
        setBarVisible(false);
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
    barVisible = false;
    invalidateInFlightFilters();
    filterRenderActive = false;
    pendingRefresh = false;
    syncClearVisibility();
    syncMdChip();
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
    clearBtn = document.getElementById('vault-filter-clear');
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
    const onMdClick = (e: MouseEvent) => {
        e.preventDefault();
        onMdToggle();
    };
    const onKeydown = (e: KeyboardEvent) => onEscapeInInput(e);

    toggleBtn.addEventListener('click', onToggleClick);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeydown);
    clearBtn?.addEventListener('click', onClearClick);
    mdChip?.addEventListener('click', onMdClick);

    // Automation-/DevTools-Hook (Muster __folioSetLogLevel).
    (window as any).__folioVaultFilterReset = resetVaultFilterForAutomation;

    invoke('vault_filter_options_get')
        .then((raw) => {
            const opts = (raw || {}) as {
                markdownOnly?: boolean;
                barVisible?: boolean;
            };
            markdownOnly = !!opts.markdownOnly;
            barVisible = !!opts.barVisible;
            syncMdChip();
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
    syncFunnelBadge();
    setTruncatedVisible(false);

    return () => {
        toggleBtn?.removeEventListener('click', onToggleClick);
        inputEl?.removeEventListener('input', onInput);
        inputEl?.removeEventListener('keydown', onKeydown);
        clearBtn?.removeEventListener('click', onClearClick);
        mdChip?.removeEventListener('click', onMdClick);
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
        barVisible = false;
        maxRunId = 0;
        nextRunId = 1;
        latestRequestRunId = 0;
        optionsWriteChain = Promise.resolve();
    };
}
