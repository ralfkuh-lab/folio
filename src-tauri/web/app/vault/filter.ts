/* Vault-Tree-Filter (R3) — clientseitige Sicht über dem Lazy-Baum.
   Spec: docs/spec-vault-filter.md

   Namensfilter blendet Datei-Zeilen ohne Match aus (Ordner immer sichtbar),
   Highlight span.vf-hit auf Datei- und Ordner-Labels. Re-Apply via
   MutationObserver auf #vault-tree (Reentranz-Guard).

   „Nur Markdown" bleibt Backend-Lazy (options_set + refreshVault).
   Schließen = Aufräumen (Query leeren). Badge nur bei markdownOnly.

   Baum-Ops: #vault-expand-level / #vault-collapse-all. */

import { folioLog } from '../util/log';
import { refreshVault, reapplyVaultActive, renderVaultFromHtml } from './tree';
import { t } from '../i18n/translate';

const DEBOUNCE_MS = 150;
const NOTICE_MS = 4000;

let barEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let mdChip: HTMLElement | null = null;
let clearBtn: HTMLElement | null = null;
let closeBtn: HTMLElement | null = null;
let toggleBtn: HTMLElement | null = null;
let noticeEl: HTMLElement | null = null;
let treeEl: HTMLElement | null = null;
let expandLevelBtn: HTMLElement | null = null;
let collapseAllBtn: HTMLElement | null = null;

/** Persistierte Filterzeilen-Sichtbarkeit. */
let barVisible = false;
/** Persistierter Typ-Filter. */
let markdownOnly = false;
/** Committed Namensfilter (nach Debounce angewandt). */
let committedQuery = '';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
/** Serialisierte Options-Schreibvorgänge. */
let optionsWriteChain: Promise<void> = Promise.resolve();
/** Reentranz-Guard: eigene DOM-Arbeit darf den Observer nicht retriggern. */
let applyingFilter = false;
let treeObserver: MutationObserver | null = null;

function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    return window.__TAURI__.core.invoke(cmd, args);
}

/** Funnel-Badge: nur persistente Präferenz markdownOnly (R3). */
export function isVaultFilterActive(): boolean {
    return markdownOnly;
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

function showTreeNotice(message: string): void {
    if (!noticeEl) return;
    noticeEl.textContent = message;
    noticeEl.hidden = false;
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
    }
    noticeTimer = setTimeout(() => {
        noticeTimer = null;
        if (noticeEl) {
            noticeEl.hidden = true;
            noticeEl.textContent = '';
        }
    }, NOTICE_MS);
}

function hideTreeNotice(): void {
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
    }
    if (noticeEl) {
        noticeEl.hidden = true;
        noticeEl.textContent = '';
    }
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

/** Client-Filter: Dateien ohne Namensmatch verstecken; Ordner immer da. */
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
        if (!q) {
            reapplyVaultActive();
            return;
        }
        const qLower = q.toLowerCase();
        const files = treeEl.querySelectorAll('li.node[data-kind="file"]');
        for (let i = 0; i < files.length; i++) {
            const file = files[i] as HTMLElement;
            const label = file.querySelector(':scope > .row > .label');
            const text = label?.textContent ?? '';
            if (!text.toLowerCase().includes(qLower)) {
                file.classList.add('vf-hidden');
            }
        }
        highlightQueryInLabels(treeEl, q);
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
 * Escape bei leerem Input.
 */
function closeBar(): void {
    if (inputEl) inputEl.value = '';
    syncClearVisibility();
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    committedQuery = '';
    applyClientFilter();
    barVisible = false;
    syncBarVisibility();
    syncFunnelBadge();
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
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    // Lazy-Rebuild erst NACH options_set (Race, E2E-Befund 2026-07-20).
    void persistOptions().then(() => refreshVault());
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

function onExpandLevel(): void {
    invoke('vault_expand_level')
        .then((raw) => {
            const result = (raw || {}) as { html?: string; capped?: boolean };
            if (typeof result.html === 'string') {
                renderVaultFromHtml(result.html);
            } else {
                return refreshVault().then(() => {
                    if (result.capped) {
                        showTreeNotice(t('vault.tree.expandLevel.capped'));
                    }
                });
            }
            if (result.capped) {
                showTreeNotice(t('vault.tree.expandLevel.capped'));
            }
        })
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_expand_level failed', {
                error: String(err),
            });
        });
}

function onCollapseAll(): void {
    hideTreeNotice();
    invoke('vault_collapse_all')
        .then((raw) => {
            const result = (raw || {}) as { html?: string };
            if (typeof result.html === 'string') {
                renderVaultFromHtml(result.html);
            } else {
                return refreshVault();
            }
        })
        .catch((err) => {
            folioLog.warn('vault-filter', 'vault_collapse_all failed', {
                error: String(err),
            });
        });
}

/** Test-/Automation-Reset: Query leeren, Zeile zu, md-only aus. */
export function resetVaultFilterForAutomation(): void {
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (inputEl) inputEl.value = '';
    committedQuery = '';
    markdownOnly = false;
    barVisible = false;
    hideTreeNotice();
    syncClearVisibility();
    syncMdChip();
    syncBarVisibility();
    applyClientFilter();
    syncFunnelBadge();
    void persistOptions();
    void refreshVault();
}

export function initVaultFilter(): () => void {
    barEl = document.getElementById('vault-filter');
    inputEl = document.getElementById('vault-filter-input') as HTMLInputElement | null;
    mdChip = document.getElementById('vault-filter-md');
    clearBtn = document.getElementById('vault-filter-clear');
    closeBtn = document.getElementById('vault-filter-close');
    toggleBtn = document.getElementById('vault-filter-toggle');
    noticeEl = document.getElementById('vault-tree-notice');
    treeEl = document.getElementById('vault-tree');
    expandLevelBtn = document.getElementById('vault-expand-level');
    collapseAllBtn = document.getElementById('vault-collapse-all');

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
    const onKeydown = (e: KeyboardEvent) => onEscapeInInput(e);
    const onExpandClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onExpandLevel();
    };
    const onCollapseClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onCollapseAll();
    };

    toggleBtn.addEventListener('click', onToggleClick);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeydown);
    clearBtn?.addEventListener('click', onClearClick);
    closeBtn?.addEventListener('click', onCloseClick);
    mdChip?.addEventListener('click', onMdClick);
    expandLevelBtn?.addEventListener('click', onExpandClick);
    collapseAllBtn?.addEventListener('click', onCollapseClick);

    if (treeEl && typeof MutationObserver !== 'undefined') {
        treeObserver = new MutationObserver(() => {
            if (applyingFilter) return;
            if (committedQuery.length > 0) {
                applyClientFilter();
            }
        });
        treeObserver.observe(treeEl, { childList: true, subtree: true });
    }

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
    hideTreeNotice();

    return () => {
        toggleBtn?.removeEventListener('click', onToggleClick);
        inputEl?.removeEventListener('input', onInput);
        inputEl?.removeEventListener('keydown', onKeydown);
        clearBtn?.removeEventListener('click', onClearClick);
        closeBtn?.removeEventListener('click', onCloseClick);
        mdChip?.removeEventListener('click', onMdClick);
        expandLevelBtn?.removeEventListener('click', onExpandClick);
        collapseAllBtn?.removeEventListener('click', onCollapseClick);
        treeObserver?.disconnect();
        treeObserver = null;
        if ((window as any).__folioVaultFilterReset === resetVaultFilterForAutomation) {
            delete (window as any).__folioVaultFilterReset;
        }
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        hideTreeNotice();
        committedQuery = '';
        markdownOnly = false;
        barVisible = false;
        optionsWriteChain = Promise.resolve();
    };
}
