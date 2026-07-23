/* Command Palette (Strg+P) — Overlay + Filter + Tabs/Recents/Walk/Commands/#.
   Spec: docs/spec-command-palette.md (P1–P3 + Review-Fixes FXP1–FXP7). */

import { t } from '../i18n/translate';
import { folioLog, safeInvoke } from '../util/log';
import { applyHighlight, fuzzyMatch, fuzzyMatchFile } from '../util/fuzzy';
import {
    activateTab,
    getTabsSnapshot,
    type TabSummary,
} from '../state/tabs';
import { openDocument } from '../state/document';
import { listEnabledCommands, type PaletteCommand } from './palette-commands';

const MAX_ROWS = 50;

export type FileSource = 'tab' | 'recent' | 'file';

type PaletteMode = 'files' | 'commands' | 'headings';

type PaletteRow =
    | {
        kind: 'file';
        source: FileSource;
        id: string;
        tabId: number | null;
        label: string;
        detail: string;
        relative: string;
        score: number;
        namePositions: number[] | null;
        pathPositions: number[] | null;
        path: string;
    }
    | {
        kind: 'command';
        id: string;
        label: string;
        detail: string;
        score: number;
        namePositions: number[] | null;
        cmd: PaletteCommand;
    }
    | {
        kind: 'heading';
        id: string;
        slug: string;
        label: string;
        detail: string;
        score: number;
        namePositions: number[] | null;
    };

export type WalkFile = { path: string; name: string; relative: string };

export type FileCandidate = {
    path: string;
    name: string;
    relative: string;
    source: FileSource;
    tabId: number | null;
};

let rootEl: HTMLElement | null = null;
let backdropEl: HTMLElement | null = null;
let panelEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let open = false;
let rows: PaletteRow[] = [];
let activeIdx = 0;
let prevFocus: HTMLElement | null = null;
let inited = false;

/** Walk-Ergebnisse der aktuellen Öffnung (frisch pro open). */
let walkFiles: WalkFile[] = [];
/** Recents aus workspace_get (nicht DOM). */
let recentFiles: WalkFile[] = [];
let walkTruncated = false;
/** Gemeinsamer Stale-Guard für Walk + Recents. */
let sourcesGen = 0;
let walkLoading = false;

function fileName(path: string): string {
    const norm = path.replace(/\\/g, '/');
    const parts = norm.split('/');
    return parts[parts.length - 1] || path;
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
}

/**
 * Sichtbarkeit: eigenes `hidden`/display + verborgene Vorfahren.
 * (Kein reines ID-Listen-Gate — FXP2.)
 */
export function isElementEffectivelyVisible(el: Element): boolean {
    let cur: Element | null = el;
    while (cur) {
        if (cur instanceof HTMLElement) {
            if (cur.hidden) return false;
            // Attribut hidden auch ohne .hidden-Property (SVG etc.)
            if (cur.hasAttribute('hidden')) return false;
            const inline = cur.style;
            if (inline && (inline.display === 'none' || inline.visibility === 'hidden')) {
                return false;
            }
        }
        if (typeof getComputedStyle === 'function') {
            try {
                const cs = getComputedStyle(cur);
                if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            } catch {
                // jsdom/getComputedStyle edge
            }
        }
        cur = cur.parentElement;
    }
    return true;
}

/**
 * Blockiert, wenn ein sichtbares Modal offen ist.
 * Selektor: `[role="dialog"][aria-modal="true"]`; `#cmd-palette` ausgenommen.
 */
export function isBlockingModalOpen(): boolean {
    const dialogs = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]',
    );
    for (let i = 0; i < dialogs.length; i++) {
        const el = dialogs[i];
        if (el.id === 'cmd-palette' || el.closest('#cmd-palette')) continue;
        if (isElementEffectivelyVisible(el)) return true;
    }
    return false;
}

function setOpenClass(on: boolean): void {
    document.body.classList.toggle('palette-open', on);
    if (rootEl) rootEl.hidden = !on;
}

export function parseQuery(raw: string): { mode: PaletteMode; query: string } {
    if (raw.startsWith('>')) {
        return { mode: 'commands', query: raw.slice(1).trimStart() };
    }
    if (raw.startsWith('#')) {
        return { mode: 'headings', query: raw.slice(1).trimStart() };
    }
    return { mode: 'files', query: raw };
}

/**
 * Überschriften aus dem gerenderten TOC (`#toc-region ul.toc`).
 */
export function collectHeadingsFromDom(): Array<{
    slug: string;
    text: string;
    level: string;
}> {
    const entries = document.querySelectorAll(
        '#toc-region ul.toc li.entry[data-slug]',
    );
    const out: Array<{ slug: string; text: string; level: string }> = [];
    for (let i = 0; i < entries.length; i++) {
        const el = entries[i] as HTMLElement;
        const slug = el.getAttribute('data-slug') || '';
        if (!slug) continue;
        const textEl = el.querySelector('.text');
        const text = (textEl ? textEl.textContent : el.textContent) || '';
        const level = el.getAttribute('data-level') || '1';
        out.push({ slug, text: text.trim(), level });
    }
    return out;
}

const SOURCE_RANK: Record<FileSource, number> = {
    tab: 0,
    recent: 1,
    file: 2,
};

/**
 * Dedup Tab > Recent > Walk. Walk-relative **anreichern** auf bestehende
 * Tab/Recent-Einträge (Quelle/Badge/tabId bleiben) — FXP1.
 */
export function mergeFileCandidates(
    tabs: Array<{ path: string; tabId: number }>,
    recents: WalkFile[],
    walk: WalkFile[],
): FileCandidate[] {
    const map = new Map<string, FileCandidate>();

    for (let i = 0; i < tabs.length; i++) {
        const path = normalizePath(tabs[i].path);
        const name = fileName(path);
        map.set(path, {
            path,
            name,
            // bis Walk-Enrichment: nur name; Match nutzt dann Vollpfad
            relative: name,
            source: 'tab',
            tabId: tabs[i].tabId,
        });
    }
    for (let i = 0; i < recents.length; i++) {
        const path = normalizePath(recents[i].path);
        if (map.has(path)) continue;
        const name = recents[i].name || fileName(path);
        map.set(path, {
            path,
            name,
            relative: recents[i].relative || name,
            source: 'recent',
            tabId: null,
        });
    }
    for (let i = 0; i < walk.length; i++) {
        const path = normalizePath(walk[i].path);
        const walkRel = walk[i].relative || walk[i].name || fileName(path);
        const existing = map.get(path);
        if (existing) {
            // Anreichern: Walk-relative behalten, Quelle/Badge/tabId unangetastet
            if (walkRel && walkRel !== existing.name) {
                existing.relative = walkRel;
            } else if (walkRel) {
                existing.relative = walkRel;
            }
            continue;
        }
        map.set(path, {
            path,
            name: walk[i].name || fileName(path),
            relative: walkRel,
            source: 'file',
            tabId: null,
        });
    }
    return Array.from(map.values());
}

/**
 * Path-Haystack für Fuzzy: Walk-relative wenn vorhanden (enthält `/`),
 * sonst normalisierter Vollpfad (Tab/Recent vor Walk) — FXP1.
 */
export function pathHaystackForMatch(c: FileCandidate): string {
    const rel = c.relative || '';
    if (rel.indexOf('/') >= 0 || rel.indexOf('\\') >= 0) {
        return normalizePath(rel);
    }
    // relative === name (noch kein Walk-Enrichment) → Vollpfad
    return c.path;
}

function collectFileRows(query: string): PaletteRow[] {
    const snap = getTabsSnapshot();
    const tabs = snap.tabs
        .filter((tab: TabSummary) => !!tab.path)
        .map((tab) => ({ path: tab.path as string, tabId: tab.id }));
    const merged = mergeFileCandidates(tabs, recentFiles, walkFiles);
    const out: PaletteRow[] = [];

    for (let i = 0; i < merged.length; i++) {
        const m = merged[i];
        const name = m.name;
        const relative = m.relative;
        const pathHay = pathHaystackForMatch(m);
        if (!query) {
            out.push({
                kind: 'file',
                source: m.source,
                id: 'file:' + m.path,
                tabId: m.tabId,
                label: name,
                detail: relative !== name
                    ? relative
                    : (m.source === 'tab' ? m.path : relative),
                relative,
                score: 0,
                namePositions: null,
                pathPositions: null,
                path: m.path,
            });
            continue;
        }
        const hit = fuzzyMatchFile(query, name, pathHay);
        if (!hit) continue;
        // Detail: relative anzeigen wenn Walk-enriched, sonst path
        const detail = hit.pathPositions
            ? pathHay
            : (relative !== name ? relative : m.path);
        out.push({
            kind: 'file',
            source: m.source,
            id: 'file:' + m.path,
            tabId: m.tabId,
            label: name,
            detail,
            relative,
            score: hit.score,
            namePositions: hit.namePositions,
            // Positions indizieren pathHay — Detail muss denselben String nutzen
            pathPositions: hit.pathPositions,
            path: m.path,
        });
    }
    return out;
}

function collectCommandRows(query: string): PaletteRow[] {
    const cmds = listEnabledCommands();
    const out: PaletteRow[] = [];
    for (let i = 0; i < cmds.length; i++) {
        const cmd = cmds[i];
        const label = cmd.label();
        if (!query) {
            out.push({
                kind: 'command',
                id: 'cmd:' + cmd.id,
                label,
                detail: cmd.shortcut || '',
                score: 0,
                namePositions: null,
                cmd,
            });
            continue;
        }
        const hit = fuzzyMatch(query, label);
        if (!hit) {
            const idHit = fuzzyMatch(query, cmd.id.replace(/\./g, ' '));
            if (!idHit) continue;
            out.push({
                kind: 'command',
                id: 'cmd:' + cmd.id,
                label,
                detail: cmd.shortcut || '',
                score: idHit.score - 20,
                namePositions: null,
                cmd,
            });
            continue;
        }
        out.push({
            kind: 'command',
            id: 'cmd:' + cmd.id,
            label,
            detail: cmd.shortcut || '',
            score: hit.score,
            namePositions: hit.positions,
            cmd,
        });
    }
    return out;
}

function collectHeadingRows(query: string): PaletteRow[] | 'not-markdown' {
    if (!document.body.classList.contains('kind-markdown')) {
        return 'not-markdown';
    }
    const headings = collectHeadingsFromDom();
    const out: PaletteRow[] = [];
    for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        const label = h.text || h.slug;
        const detail = 'H' + h.level;
        if (!query) {
            out.push({
                kind: 'heading',
                id: 'heading:' + h.slug,
                slug: h.slug,
                label,
                detail,
                score: 0,
                namePositions: null,
            });
            continue;
        }
        const hit = fuzzyMatch(query, label);
        if (!hit) continue;
        out.push({
            kind: 'heading',
            id: 'heading:' + h.slug,
            slug: h.slug,
            label,
            detail,
            score: hit.score,
            namePositions: hit.positions,
        });
    }
    return out;
}

function sortRows(list: PaletteRow[]): PaletteRow[] {
    return list.slice().sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (a.kind === 'file' && b.kind === 'file') {
            const ra = SOURCE_RANK[a.source];
            const rb = SOURCE_RANK[b.source];
            if (ra !== rb) return ra - rb;
        }
        if (a.kind !== b.kind) {
            return a.kind.localeCompare(b.kind);
        }
        // Headings behalten bei Score-Gleichstand die Dokumentreihenfolge
        // (sort ist stabil) — alphabetisch waere fuer ein TOC falsch.
        if (a.kind === 'heading') return 0;
        return a.label.localeCompare(b.label);
    });
}

function badgeLabel(row: PaletteRow): string {
    if (row.kind === 'file') {
        if (row.source === 'tab') return t('palette.badge.tab');
        if (row.source === 'recent') return t('palette.badge.recent');
        return t('palette.badge.file');
    }
    if (row.kind === 'command') return t('palette.badge.command');
    return t('palette.badge.heading');
}

function selectionKey(row: PaletteRow): string {
    if (row.kind === 'file') return 'path:' + row.path;
    if (row.kind === 'heading') return 'slug:' + row.slug;
    return 'cmd:' + row.id;
}

function currentSelectionKey(): string | null {
    const visible = rows.slice(0, MAX_ROWS);
    if (activeIdx < 0 || activeIdx >= visible.length) return null;
    return selectionKey(visible[activeIdx]);
}

function restoreSelection(key: string | null): void {
    if (!key || rows.length === 0) {
        activeIdx = rows.length > 0 ? 0 : -1;
        return;
    }
    const visible = rows.slice(0, MAX_ROWS);
    for (let i = 0; i < visible.length; i++) {
        if (selectionKey(visible[i]) === key) {
            activeIdx = i;
            return;
        }
    }
    activeIdx = 0;
}

function renderList(extraHints: string[] = []): void {
    if (!listEl) return;
    listEl.replaceChildren();
    const total = rows.length;
    const visible = rows.slice(0, MAX_ROWS);

    if (visible.length === 0) {
        // Immer „Keine Treffer"; zusätzliche Hinweise (truncated) darunter (FXP7)
        const empty = document.createElement('li');
        empty.className = 'cmd-palette-empty';
        empty.setAttribute('role', 'option');
        empty.setAttribute('aria-disabled', 'true');
        empty.textContent = t('palette.noResults');
        listEl.appendChild(empty);
        for (let h = 0; h < extraHints.length; h++) {
            const hint = document.createElement('li');
            hint.className = 'cmd-palette-hint';
            hint.setAttribute('role', 'option');
            hint.setAttribute('aria-disabled', 'true');
            hint.textContent = extraHints[h];
            listEl.appendChild(hint);
        }
        activeIdx = -1;
        return;
    }

    if (activeIdx < 0 || activeIdx >= visible.length) {
        activeIdx = 0;
    }

    for (let i = 0; i < visible.length; i++) {
        const row = visible[i];
        const li = document.createElement('li');
        li.className = 'cmd-palette-item';
        li.setAttribute('role', 'option');
        li.setAttribute('data-idx', String(i));
        li.setAttribute('data-id', row.id);
        if (row.kind === 'file') {
            li.setAttribute('data-path', row.path);
            li.setAttribute('data-source', row.source);
        }
        if (i === activeIdx) {
            li.setAttribute('aria-selected', 'true');
            li.classList.add('active');
        } else {
            li.setAttribute('aria-selected', 'false');
        }

        const badge = document.createElement('span');
        badge.className = 'cmd-palette-badge cmd-palette-badge--'
            + (row.kind === 'file' ? row.source : row.kind);
        badge.textContent = badgeLabel(row);

        const label = document.createElement('span');
        label.className = 'cmd-palette-label';
        applyHighlight(label, row.label, row.namePositions);

        const detail = document.createElement('span');
        detail.className = 'cmd-palette-detail';
        if (row.kind === 'file' && row.pathPositions) {
            applyHighlight(detail, row.detail, row.pathPositions);
        } else {
            detail.textContent = row.detail;
        }

        li.appendChild(badge);
        li.appendChild(label);
        li.appendChild(detail);
        listEl.appendChild(li);
    }

    if (total > MAX_ROWS) {
        const more = document.createElement('li');
        more.className = 'cmd-palette-hint';
        more.setAttribute('role', 'option');
        more.setAttribute('aria-disabled', 'true');
        more.textContent = t('palette.results.truncated');
        listEl.appendChild(more);
    }
    for (let h = 0; h < extraHints.length; h++) {
        const hint = document.createElement('li');
        hint.className = 'cmd-palette-hint';
        hint.setAttribute('role', 'option');
        hint.setAttribute('aria-disabled', 'true');
        hint.textContent = extraHints[h];
        listEl.appendChild(hint);
    }

    const activeEl = listEl.querySelector('.cmd-palette-item.active') as HTMLElement | null;
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ block: 'nearest' });
    }
}

function rebuildFromInput(preserveSelection: boolean): void {
    if (!inputEl) return;
    const raw = inputEl.value || '';
    const { mode, query } = parseQuery(raw);
    const q = query.trim();
    const prevKey = preserveSelection ? currentSelectionKey() : null;
    const hints: string[] = [];

    if (mode === 'commands') {
        rows = sortRows(collectCommandRows(q));
    } else if (mode === 'headings') {
        const result = collectHeadingRows(q);
        if (result === 'not-markdown') {
            rows = [];
            hints.push(t('palette.headings.notMarkdown'));
        } else {
            rows = sortRows(result);
        }
    } else {
        rows = sortRows(collectFileRows(q));
        if (walkTruncated) {
            hints.push(t('palette.files.truncated'));
        }
    }

    if (preserveSelection) {
        restoreSelection(prevKey);
    } else {
        activeIdx = rows.length > 0 ? 0 : -1;
    }
    renderList(hints);
}

function moveActive(delta: number): void {
    const visibleCount = Math.min(rows.length, MAX_ROWS);
    if (visibleCount <= 0) return;
    activeIdx = (activeIdx + delta + visibleCount) % visibleCount;
    renderList(walkTruncated && parseQuery(inputEl?.value || '').mode === 'files'
        ? [t('palette.files.truncated')]
        : []);
}

async function openFilePath(path: string, newTab: boolean): Promise<void> {
    if (newTab) {
        safeInvoke('tab_open', { path }, 'tab_open', 'warn');
        return;
    }
    try {
        await openDocument(path);
    } catch (err) {
        folioLog.warn('palette', 'openDocument failed', { error: String(err) });
    }
}

async function runRow(row: PaletteRow, newTab: boolean): Promise<void> {
    closePalette();
    if (row.kind === 'file') {
        if (!newTab && row.source === 'tab' && row.tabId != null) {
            try {
                await activateTab(row.tabId);
            } catch (err) {
                folioLog.warn('palette', 'activateTab failed', { error: String(err) });
            }
            return;
        }
        await openFilePath(row.path, newTab);
        return;
    }
    if (row.kind === 'heading') {
        safeInvoke('toc_click', { anchor: row.slug }, 'toc_click', 'debug');
        return;
    }
    const cmd = row.cmd;
    // Unmittelbar vor Dispatch erneut enabled prüfen (FXP5 save-dirty)
    try {
        if (!cmd.enabled()) return;
    } catch {
        return;
    }
    if (cmd.menuAction) {
        safeInvoke(
            'menu_dispatch',
            { id: cmd.menuAction },
            'menu_dispatch ' + cmd.menuAction,
        );
        return;
    }
    if (typeof cmd.run === 'function') {
        cmd.run();
    }
}

function activateCurrent(newTab: boolean): void {
    const visible = rows.slice(0, MAX_ROWS);
    if (activeIdx < 0 || activeIdx >= visible.length) return;
    void runRow(visible[activeIdx], newTab);
}

function onInputKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePalette();
        return;
    }
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveActive(1);
        return;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveActive(-1);
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        const newTab = e.ctrlKey || e.metaKey;
        activateCurrent(newTab);
    }
}

function onListClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const item = target.closest('.cmd-palette-item') as HTMLElement | null;
    if (!item || !listEl || !listEl.contains(item)) return;
    const idx = Number(item.getAttribute('data-idx'));
    if (!Number.isFinite(idx) || idx < 0 || idx >= rows.length) return;
    activeIdx = idx;
    const newTab = e.ctrlKey || e.metaKey;
    void runRow(rows[idx], newTab);
}

function onBackdropClick(e: MouseEvent): void {
    if (e.target === backdropEl) {
        closePalette();
    }
}

function parseWalkResponse(res: any): { files: WalkFile[]; truncated: boolean } {
    const files = Array.isArray(res && res.files) ? res.files : [];
    return {
        files: files.map(function (f: any): WalkFile {
            return {
                path: normalizePath(String(f.path || '')),
                name: String(f.name || fileName(String(f.path || ''))),
                relative: String(f.relative || f.name || ''),
            };
        }).filter(function (f: WalkFile) { return !!f.path; }),
        truncated: !!(res && res.truncated),
    };
}

function parseRecentFromWorkspace(ws: any): WalkFile[] {
    const recent = Array.isArray(ws && ws.recent) ? ws.recent : [];
    const out: WalkFile[] = [];
    for (let i = 0; i < recent.length; i++) {
        const path = recent[i] && recent[i].path;
        if (typeof path !== 'string' || !path) continue;
        const norm = normalizePath(path);
        const name = fileName(norm);
        out.push({ path: norm, name, relative: name });
    }
    return out;
}

/** Walk + Recents parallel, gemeinsamer Stale-Guard (FXP3). */
function startSourcesLoad(): void {
    sourcesGen += 1;
    const gen = sourcesGen;
    walkFiles = [];
    recentFiles = [];
    walkTruncated = false;
    walkLoading = true;

    const invoke = window.__TAURI__ && window.__TAURI__.core
        ? window.__TAURI__.core.invoke
        : null;
    if (!invoke) {
        walkLoading = false;
        return;
    }

    Promise.all([
        invoke('palette_files').catch(function (err: unknown) {
            folioLog.warn('palette', 'palette_files failed', { error: String(err) });
            return { files: [], truncated: false };
        }),
        invoke('workspace_get').catch(function (err: unknown) {
            folioLog.warn('palette', 'workspace_get failed', { error: String(err) });
            return { recent: [] };
        }),
    ]).then(function (pair) {
        if (gen !== sourcesGen || !open) return;
        walkLoading = false;
        const walk = parseWalkResponse(pair[0]);
        walkFiles = walk.files;
        walkTruncated = walk.truncated;
        recentFiles = parseRecentFromWorkspace(pair[1]);
        // Nachmischen: Query + Auswahl behalten
        rebuildFromInput(true);
    });
}

export function isPaletteOpen(): boolean {
    return open;
}

/** Test-Hook: Walk/Recents-State lesen. */
export function getWalkStateForTests(): {
    files: WalkFile[];
    recents: WalkFile[];
    truncated: boolean;
    loading: boolean;
    sourcesGen: number;
} {
    return {
        files: walkFiles.slice(),
        recents: recentFiles.slice(),
        truncated: walkTruncated,
        loading: walkLoading,
        sourcesGen,
    };
}

/** Test-Hook: Walk-Ergebnisse injizieren und neu mischen. */
export function applyWalkResultForTests(
    files: WalkFile[],
    truncated: boolean,
    recents?: WalkFile[],
): void {
    walkFiles = files.slice();
    walkTruncated = truncated;
    if (recents) recentFiles = recents.slice();
    walkLoading = false;
    if (open) rebuildFromInput(true);
}

export function closePalette(): void {
    if (!open) return;
    open = false;
    setOpenClass(false);
    if (inputEl) inputEl.value = '';
    rows = [];
    activeIdx = -1;
    walkFiles = [];
    recentFiles = [];
    walkTruncated = false;
    walkLoading = false;
    sourcesGen += 1; // invalidiert pending Roundtrips
    if (listEl) listEl.replaceChildren();

    const restore = prevFocus;
    prevFocus = null;
    if (restore && typeof restore.focus === 'function') {
        try {
            restore.focus();
        } catch {
            // best effort
        }
    }
}

/** Explizit öffnen (Hook/Automation). Bereits offen → Prefill + Refokus. */
export function openPalette(prefill?: string): void {
    if (!rootEl || !inputEl) return;
    if (isBlockingModalOpen()) return;
    if (open) {
        inputEl.value = typeof prefill === 'string' ? prefill : inputEl.value;
        rebuildFromInput(false);
        inputEl.focus();
        inputEl.select();
        return;
    }
    const ae = document.activeElement;
    prevFocus = ae instanceof HTMLElement ? ae : null;
    open = true;
    setOpenClass(true);
    inputEl.value = typeof prefill === 'string' ? prefill : '';
    walkFiles = [];
    recentFiles = [];
    walkTruncated = false;
    rebuildFromInput(false);
    startSourcesLoad();
    requestAnimationFrame(function () {
        if (inputEl && open) {
            inputEl.focus();
            inputEl.select();
        }
    });
}

/** Strg+P: Toggle. */
export function togglePalette(): void {
    if (open) closePalette();
    else openPalette();
}

export function initCommandPalette(): void {
    if (inited) return;
    rootEl = document.getElementById('cmd-palette');
    if (!rootEl) {
        folioLog.warn('palette', '#cmd-palette missing in DOM');
        return;
    }
    backdropEl = rootEl.querySelector('.cmd-palette-backdrop') as HTMLElement | null;
    panelEl = rootEl.querySelector('.cmd-palette-panel') as HTMLElement | null;
    inputEl = document.getElementById('cmd-palette-input') as HTMLInputElement | null;
    listEl = document.getElementById('cmd-palette-list');
    if (!inputEl || !listEl) {
        folioLog.warn('palette', 'palette input/list missing');
        return;
    }
    inited = true;

    rootEl.hidden = true;
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('spellcheck', 'false');
    inputEl.setAttribute('role', 'combobox');
    inputEl.setAttribute('aria-autocomplete', 'list');
    inputEl.setAttribute('aria-controls', 'cmd-palette-list');
    listEl.setAttribute('role', 'listbox');

    inputEl.addEventListener('input', function () {
        rebuildFromInput(false);
    });
    inputEl.addEventListener('keydown', onInputKeydown);
    listEl.addEventListener('click', onListClick);
    if (backdropEl) {
        backdropEl.addEventListener('click', onBackdropClick);
    }
    if (panelEl) {
        panelEl.addEventListener('mousedown', function () { /* no-op */ });
    }

    document.addEventListener('keydown', function (e) {
        if (!open) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closePalette();
        }
    });

    (window as any).__folioOpenPalette = function (prefill?: string) {
        openPalette(prefill);
    };
    (window as any).__folioClosePalette = function () {
        closePalette();
    };
}
