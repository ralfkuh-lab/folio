/* Backlinks-Panel unter dem TOC (#backlinks-section).
   Refresh bei document:loaded/saved (debounced), Stale-Guard per Generation
   (Muster view/preview.ts renderGen). Single-Flight + tabId/Pfad-Gates
   (Review F6). Collapse flüchtig, kein panel_state. */

import { t } from '../i18n/translate';
import { openDocument } from '../state/document';
import { getActiveTabId } from '../state/tabs';
import { folioLog, safeInvoke } from '../util/log';

export type BacklinkHit = {
    line: number;
    snippet: string;
};

export type BacklinkSource = {
    path: string;
    name: string;
    hits: BacklinkHit[];
};

export type BacklinksResult = {
    sources: BacklinkSource[];
    truncated: boolean;
};

const DEBOUNCE_MS = 300;

let fetchGen = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let collapsed = false;
let lastResult: BacklinksResult | null = null;
/** Pfad, für den das Panel zuletzt geplant/geladen wurde. */
let lastBacklinksPath: string | null = null;
/** Höchstens ein laufender backlinks_for-Request. */
let inFlight = false;
/** Latest-wins: während inFlight angeforderter Folge-Pfad + gen. */
let pendingFetch: { path: string; gen: number } | null = null;
let wired = false;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function invokeCommand(): ((cmd: string, args?: any) => Promise<any>) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

function pathsEqual(a: string, b: string): boolean {
    return normalizePath(a) === normalizePath(b);
}

/** Gesamte Trefferzahl über alle Quellen (für Header-Zähler). */
export function totalBacklinkCount(result: BacklinksResult | null | undefined): number {
    if (!result || !result.sources) return 0;
    let n = 0;
    for (const s of result.sources) {
        n += (s.hits && s.hits.length) || 0;
    }
    // Fallback: wenn keine Hits, trotzdem Quellen zählen (sollte nicht vorkommen).
    if (n === 0) return result.sources.length;
    return n;
}

/** Panel gilt als leer, wenn keine Quellen. */
export function isBacklinksPanelEmpty(): boolean {
    return !lastResult || !lastResult.sources || lastResult.sources.length === 0;
}

/**
 * Save-Refresh-Entscheidung (exportiert für Tests).
 * false → kein scheduleBacklinksRefresh.
 */
export function shouldRefreshBacklinksOnSaved(payload: {
    path?: unknown;
    tabId?: unknown;
    text?: unknown;
}): boolean {
    const path = typeof payload.path === 'string' ? payload.path : null;
    if (!path) return false;

    // a: nur aktiver Tab
    if (typeof payload.tabId === 'number') {
        const active = getActiveTabId();
        if (active !== null && payload.tabId !== active) {
            return false;
        }
    }

    // a: nur wenn Save zum angezeigten Backlinks-Dokument gehört
    if (lastBacklinksPath && !pathsEqual(path, lastBacklinksPath)) {
        return false;
    }

    // c: kein `[[` im Text und Panel leer → Skip
    if (typeof payload.text === 'string' && !payload.text.includes('[[') && isBacklinksPanelEmpty()) {
        return false;
    }

    return true;
}

/** Header-Text aus Ergebnis (i18n). Exportiert für Tests. */
export function formatBacklinksHeader(result: BacklinksResult | null | undefined): string {
    const count = totalBacklinkCount(result);
    return t('wikilinks.backlinks.header', { count });
}

/** Rendert ein Backlinks-Ergebnis in die Rail-Sektion. Exportiert für Tests. */
export function renderBacklinks(result: BacklinksResult | null | undefined): void {
    lastResult = result || { sources: [], truncated: false };
    const title = $('backlinks-title');
    const empty = $('backlinks-empty');
    const list = $('backlinks-list');
    const section = $('backlinks-section');
    if (!title || !empty || !list) return;

    title.textContent = formatBacklinksHeader(lastResult);
    applyCollapsed(section);

    // Truncated-Hinweis: altes Element entfernen falls vorhanden.
    const body = $('backlinks-body');
    if (body) {
        const oldHint = body.querySelector('.backlinks-truncated');
        if (oldHint) oldHint.remove();
    }

    const sources = lastResult.sources || [];
    if (sources.length === 0) {
        empty.hidden = false;
        empty.textContent = t('wikilinks.backlinks.empty');
        list.hidden = true;
        list.innerHTML = '';
        return;
    }

    empty.hidden = true;
    list.hidden = false;
    list.innerHTML = '';

    for (const src of sources) {
        const li = document.createElement('li');
        li.className = 'backlinks-source';
        li.dataset.path = src.path;

        const row = document.createElement('div');
        row.className = 'backlinks-source-row';
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.title = src.path;
        row.dataset.path = src.path;

        const name = document.createElement('span');
        name.className = 'backlinks-source-name';
        name.textContent = src.name || src.path;
        row.appendChild(name);

        const hitCount = (src.hits && src.hits.length) || 0;
        if (hitCount > 1) {
            const cnt = document.createElement('span');
            cnt.className = 'backlinks-source-count';
            cnt.textContent = String(hitCount);
            row.appendChild(cnt);
        }
        li.appendChild(row);

        if (src.hits && src.hits.length) {
            const hitsUl = document.createElement('ul');
            hitsUl.className = 'backlinks-hits';
            for (const hit of src.hits) {
                const hitLi = document.createElement('li');
                hitLi.className = 'backlinks-hit';
                hitLi.dataset.path = src.path;
                hitLi.dataset.line = String(hit.line);
                hitLi.title = src.path + ':' + hit.line;
                hitLi.textContent = hit.snippet || '';
                hitsUl.appendChild(hitLi);
            }
            li.appendChild(hitsUl);
        }

        list.appendChild(li);
    }

    if (lastResult.truncated && body) {
        const hint = document.createElement('div');
        hint.className = 'backlinks-truncated';
        hint.textContent = t('wikilinks.backlinks.truncated');
        body.appendChild(hint);
    }
}

function applyCollapsed(section: HTMLElement | null): void {
    if (!section) return;
    section.classList.toggle('collapsed', collapsed);
    const header = $('backlinks-header');
    if (header) header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function openPath(path: string, newTab: boolean): void {
    if (!path) return;
    if (newTab) {
        safeInvoke('tab_open', { path }, 'tab_open', 'warn');
    } else {
        void openDocument(path);
    }
}

/**
 * Plant einen Backlinks-Fetch für `path`. Debounced; Stale-Guard verwirft
 * Antworten, deren Generation nicht mehr die neueste ist.
 */
export function scheduleBacklinksRefresh(path: string | null | undefined): void {
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    const gen = ++fetchGen;
    if (!path) {
        lastBacklinksPath = null;
        pendingFetch = null;
        renderBacklinks({ sources: [], truncated: false });
        return;
    }
    lastBacklinksPath = path;
    debounceTimer = setTimeout(function () {
        debounceTimer = null;
        void runFetch(path, gen);
    }, DEBOUNCE_MS);
}

/** Sofortiger Fetch (ohne Debounce) — Tests / Flush. */
export function refreshBacklinksNow(path: string | null | undefined): Promise<void> {
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    const gen = ++fetchGen;
    if (!path) {
        lastBacklinksPath = null;
        pendingFetch = null;
        renderBacklinks({ sources: [], truncated: false });
        return Promise.resolve();
    }
    lastBacklinksPath = path;
    return runFetch(path, gen);
}

/**
 * Single-Flight: höchstens ein laufender Request. Währenddessen merken wir
 * den neuesten Pfad und starten nach Abschluss GENAU EINEN Folge-Fetch
 * (latest-wins). Generation-Guard bleibt fürs Rendern.
 */
async function runFetch(path: string, gen: number): Promise<void> {
    if (inFlight) {
        pendingFetch = { path, gen };
        return;
    }
    inFlight = true;
    try {
        await doFetch(path, gen);
    } finally {
        inFlight = false;
        const next = pendingFetch;
        pendingFetch = null;
        if (next) {
            // latest-wins: nur wenn die gemerkte Gen noch aktuell ist,
            // sonst wurde inzwischen etwas Neueres geplant (oder null).
            if (next.gen === fetchGen) {
                await runFetch(next.path, next.gen);
            }
        }
    }
}

async function doFetch(path: string, gen: number): Promise<void> {
    const invoke = invokeCommand();
    if (!invoke) {
        if (gen === fetchGen) renderBacklinks({ sources: [], truncated: false });
        return;
    }
    try {
        const result = (await invoke('backlinks_for', { path })) as BacklinksResult;
        if (gen !== fetchGen) {
            folioLog.debug('backlinks', 'stale response dropped', { path, gen, fetchGen });
            return;
        }
        renderBacklinks(result || { sources: [], truncated: false });
    } catch (err) {
        if (gen !== fetchGen) return;
        folioLog.warn('backlinks', 'backlinks_for failed', { path, error: String(err) });
        renderBacklinks({ sources: [], truncated: false });
    }
}

/**
 * Der Wikilink-Index wurde im Hintergrund fertig gebaut
 * (Backend-Event `wikilink:index_ready`, Spec W8): das angezeigte Panel
 * beruht dann noch auf dem leeren/alten Index. Debounced über denselben
 * Pfad wie document:loaded; ohne angezeigtes Dokument ein No-op.
 */
export function refreshBacklinksAfterIndexReady(): void {
    if (!lastBacklinksPath) return;
    scheduleBacklinksRefresh(lastBacklinksPath);
}

/** document:saved-Handler (exportiert für Tests). */
export function onDocumentSaved(payload: {
    path?: unknown;
    tabId?: unknown;
    text?: unknown;
}): void {
    if (!shouldRefreshBacklinksOnSaved(payload)) return;
    const path = typeof payload.path === 'string' ? payload.path : null;
    if (!path) return;
    scheduleBacklinksRefresh(path);
}

/** Test-Hook: aktuelle Generation (nach schedule/refresh). */
export function __backlinksFetchGenForTests(): number {
    return fetchGen;
}

/** Test-Hook: lastBacklinksPath. */
export function __lastBacklinksPathForTests(): string | null {
    return lastBacklinksPath;
}

/** Test-Hook: lastBacklinksPath setzen (ohne Fetch). */
export function __setLastBacklinksPathForTests(path: string | null): void {
    lastBacklinksPath = path;
}

/** Test-Hook: Reset State. */
export function __resetBacklinksForTests(): void {
    fetchGen = 0;
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    collapsed = false;
    lastResult = null;
    lastBacklinksPath = null;
    inFlight = false;
    pendingFetch = null;
    // Listeners bleiben (einmalig); DOM wird vom Test neu gesetzt.
}

function onHeaderActivate(): void {
    collapsed = !collapsed;
    applyCollapsed($('backlinks-section'));
}

function onListClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const row = target.closest('[data-path]') as HTMLElement | null;
    if (!row) return;
    const path = row.dataset.path;
    if (!path) return;
    e.preventDefault();
    openPath(path, e.ctrlKey || e.metaKey);
}

function onListKey(e: KeyboardEvent): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement | null;
    if (!target || !target.classList.contains('backlinks-source-row')) return;
    const path = target.dataset.path;
    if (!path) return;
    e.preventDefault();
    openPath(path, e.ctrlKey || e.metaKey);
}

export function initBacklinks(): void {
    if (wired) return;
    wired = true;

    const header = $('backlinks-header');
    if (header) {
        header.addEventListener('click', onHeaderActivate);
        header.addEventListener('keydown', function (e: KeyboardEvent) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onHeaderActivate();
            }
        });
    }

    const list = $('backlinks-list');
    if (list) {
        list.addEventListener('click', onListClick);
        list.addEventListener('keydown', onListKey);
    }

    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && typeof ev.listen === 'function') {
        void ev.listen('document:loaded', function (event: any) {
            const data = (event && event.payload) || {};
            const path = typeof data.path === 'string' ? data.path : null;
            // Nur Markdown-Docs; sonst leeren.
            const kind = data.kind || '';
            if (kind && kind !== 'markdown') {
                scheduleBacklinksRefresh(null);
                return;
            }
            scheduleBacklinksRefresh(path);
        });
        void ev.listen('document:saved', function (event: any) {
            const data = (event && event.payload) || {};
            onDocumentSaved(data);
        });
        void ev.listen('document:closed', function () {
            scheduleBacklinksRefresh(null);
        });
    }

    // Initialer leerer Zustand.
    renderBacklinks({ sources: [], truncated: false });
}
