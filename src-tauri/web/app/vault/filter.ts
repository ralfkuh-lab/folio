/* Vault-Tree-Filter (R3/R3.1) — clientseitige Sicht über dem Lazy-Baum.
   Spec: docs/spec-vault-filter.md

   Namensfilter blendet Datei-Zeilen ohne Match aus (Ordner immer sichtbar),
   Highlight span.vf-hit auf Datei- und Ordner-Labels. Re-Apply via
   MutationObserver auf #vault-tree (Reentranz-Guard).

   „Nur Markdown" bleibt Backend-Lazy (options_set + refreshVault).
   Schließen = Aufräumen (Query leeren). Badge nur bei markdownOnly.

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

let barEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let mdChip: HTMLElement | null = null;
let gitChip: HTMLElement | null = null;
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
/** Committed Namensfilter (nach Debounce angewandt). */
let committedQuery = '';
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

/** Funnel-Badge: persistente Praeferenzen (md-only und/oder git-only). */
export function isVaultFilterActive(): boolean {
    return markdownOnly || gitChangedOnly;
}

function persistOptions(): Promise<void> {
    const md = markdownOnly;
    const bar = barVisible;
    const git = gitChangedOnly;
    optionsWriteChain = optionsWriteChain
        .then(() =>
            invoke('vault_filter_options_set', {
                markdownOnly: md,
                barVisible: bar,
                gitChangedOnly: git,
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

function showExpandCappedNotice(count: number): void {
    if (!noticeEl) return;
    noticeEl.textContent = t('vault.tree.expandCapped', { count: String(count) });
    noticeEl.hidden = false;
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
    }
    noticeTimer = setTimeout(() => {
        noticeTimer = null;
        if (noticeEl) noticeEl.hidden = true;
    }, 4000);
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
        const qLower = q.toLowerCase();
        const files = treeEl.querySelectorAll('li.node[data-kind="file"]');
        for (let i = 0; i < files.length; i++) {
            const file = files[i] as HTMLElement;
            const path = file.getAttribute('data-path') || '';
            if (gitChangedOnly && !isPathGitChanged(path)) {
                file.classList.add('vf-hidden');
                continue;
            }
            if (q) {
                const label = file.querySelector(':scope > .row > .label');
                const text = label?.textContent ?? '';
                if (!text.toLowerCase().includes(qLower)) {
                    file.classList.add('vf-hidden');
                }
            }
        }
        if (gitChangedOnly) {
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

/** Test-/Automation-Reset: Query leeren, Zeile zu, md-only aus. */
export function resetVaultFilterForAutomation(): void {
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (inputEl) inputEl.value = '';
    committedQuery = '';
    markdownOnly = false;
    gitChangedOnly = false;
    barVisible = false;
    syncClearVisibility();
    syncMdChip();
    syncGitChip();
    syncBarVisibility();
    applyClientFilter();
    syncFunnelBadge();
    syncExpandRootsDisabled();
    void persistOptions();
    void refreshVault();
}

export function initVaultFilter(): () => void {
    barEl = document.getElementById('vault-filter');
    inputEl = document.getElementById('vault-filter-input') as HTMLInputElement | null;
    mdChip = document.getElementById('vault-filter-md');
    gitChip = document.getElementById('vault-filter-git');
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

    toggleBtn.addEventListener('click', onToggleClick);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeydown);
    clearBtn?.addEventListener('click', onClearClick);
    closeBtn?.addEventListener('click', onCloseClick);
    mdChip?.addEventListener('click', onMdClick);
    gitChip?.addEventListener('click', onGitClick);
    window.addEventListener(GIT_STATUS_CHANGED_EVENT, onGitStatus);
    expandRootsBtn?.addEventListener('click', onExpandClick);
    collapseAllBtn?.addEventListener('click', onCollapseClick);

    if (treeEl && typeof MutationObserver !== 'undefined') {
        treeObserver = new MutationObserver(() => {
            if (expandGitInFlight) treeMutatedDuringExpand = true;
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

    invoke('vault_filter_options_get')
        .then((raw) => {
            const opts = (raw || {}) as {
                markdownOnly?: boolean;
                barVisible?: boolean;
                gitChangedOnly?: boolean;
            };
            markdownOnly = !!opts.markdownOnly;
            barVisible = !!opts.barVisible;
            gitChangedOnly = !!opts.gitChangedOnly;
            syncMdChip();
            syncGitChip();
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
        window.removeEventListener(GIT_STATUS_CHANGED_EVENT, onGitStatus);
        expandRootsBtn?.removeEventListener('click', onExpandClick);
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
        if (noticeTimer !== null) {
            clearTimeout(noticeTimer);
            noticeTimer = null;
        }
        committedQuery = '';
        markdownOnly = false;
        gitChangedOnly = false;
        barVisible = false;
        expandGitInFlight = false;
        expandGitPending = false;
        treeMutatedDuringExpand = false;
        optionsWriteChain = Promise.resolve();
    };
}
