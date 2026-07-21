/* Command Palette (Strg+P) — Overlay + Filter + Tabs/Commands (P1).
   Spec: docs/spec-command-palette.md. Backend-Walk und `#`-TOC folgen in P2. */

import { t } from '../i18n/translate';
import { folioLog, safeInvoke } from '../util/log';
import { applyHighlight, fuzzyMatch, fuzzyMatchFile } from '../util/fuzzy';
import {
    activateTab,
    getTabsSnapshot,
    type TabSummary,
} from '../state/tabs';
import { listEnabledCommands, type PaletteCommand } from './palette-commands';

const MAX_ROWS = 50;

type SourceKind = 'tab' | 'command';

type PaletteRow =
    | {
        kind: 'tab';
        id: string;
        tabId: number;
        label: string;
        detail: string;
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

function fileName(path: string): string {
    const norm = path.replace(/\\/g, '/');
    const parts = norm.split('/');
    return parts[parts.length - 1] || path;
}

function parentDir(path: string): string {
    const norm = path.replace(/\\/g, '/');
    const i = norm.lastIndexOf('/');
    return i >= 0 ? norm.slice(0, i) : '';
}

/** Echte Modals (nicht Settings-Region) — Palette öffnet nicht darüber. */
function isBlockingModalOpen(): boolean {
    const ids = [
        'unsaved-dialog',
        'rename-dialog',
        'confirm-dialog',
        'run-confirm-dialog',
        'vault-search-dialog',
        'export-dialog',
        'ai-translate-dialog',
        'ai-actions-dialog',
        'about-dialog',
        'image-dialog',
    ];
    for (let i = 0; i < ids.length; i++) {
        const el = document.getElementById(ids[i]);
        if (el && !el.hidden) return true;
    }
    return false;
}

function setOpenClass(on: boolean): void {
    document.body.classList.toggle('palette-open', on);
    if (rootEl) rootEl.hidden = !on;
}

function parseQuery(raw: string): { mode: 'files' | 'commands'; query: string } {
    if (raw.startsWith('>')) {
        return { mode: 'commands', query: raw.slice(1).trimStart() };
    }
    // P2: '#' headings — in P1 wie Dateimodus behandeln (Prefix belassen)
    return { mode: 'files', query: raw };
}

function collectTabRows(query: string): PaletteRow[] {
    const snap = getTabsSnapshot();
    const out: PaletteRow[] = [];
    const tabs = snap.tabs.filter((tab: TabSummary) => !!tab.path);
    for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const path = tab.path as string;
        const name = fileName(path);
        const relative = parentDir(path);
        if (!query) {
            out.push({
                kind: 'tab',
                id: 'tab:' + tab.id,
                tabId: tab.id,
                label: name,
                detail: relative || path,
                score: 0,
                namePositions: null,
                pathPositions: null,
                path,
            });
            continue;
        }
        const hit = fuzzyMatchFile(query, name, path);
        if (!hit) continue;
        // pathPositions indizieren den vollen path — Detail dann full path,
        // sonst Elternordner (oder path) ohne Highlight.
        const detail = hit.pathPositions ? path : (relative || path);
        out.push({
            kind: 'tab',
            id: 'tab:' + tab.id,
            tabId: tab.id,
            label: name,
            detail,
            score: hit.score,
            namePositions: hit.namePositions,
            pathPositions: hit.pathPositions,
            path,
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
            // auch gegen id matchen (z. B. "export", "theme")
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

function sortRows(list: PaletteRow[]): PaletteRow[] {
    return list.slice().sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        // Quelle: Tabs vor Commands (P1 hat nur eine Quelle je Modus)
        if (a.kind !== b.kind) {
            if (a.kind === 'tab') return -1;
            if (b.kind === 'tab') return 1;
        }
        return a.label.localeCompare(b.label);
    });
}

function badgeLabel(kind: SourceKind): string {
    return kind === 'tab' ? t('palette.badge.tab') : t('palette.badge.command');
}

function renderList(): void {
    if (!listEl) return;
    listEl.replaceChildren();
    const total = rows.length;
    const visible = rows.slice(0, MAX_ROWS);

    if (visible.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'cmd-palette-empty';
        empty.setAttribute('role', 'option');
        empty.setAttribute('aria-disabled', 'true');
        empty.textContent = t('palette.noResults');
        listEl.appendChild(empty);
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
        if (i === activeIdx) {
            li.setAttribute('aria-selected', 'true');
            li.classList.add('active');
        } else {
            li.setAttribute('aria-selected', 'false');
        }

        const badge = document.createElement('span');
        badge.className = 'cmd-palette-badge cmd-palette-badge--' + row.kind;
        badge.textContent = badgeLabel(row.kind);

        const label = document.createElement('span');
        label.className = 'cmd-palette-label';
        applyHighlight(label, row.label, row.namePositions);

        const detail = document.createElement('span');
        detail.className = 'cmd-palette-detail';
        if (row.kind === 'tab' && row.pathPositions) {
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

    const activeEl = listEl.querySelector('.cmd-palette-item.active') as HTMLElement | null;
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ block: 'nearest' });
    }
}

function rebuildFromInput(): void {
    if (!inputEl) return;
    const raw = inputEl.value || '';
    const { mode, query } = parseQuery(raw);
    const q = query.trim();
    if (mode === 'commands') {
        rows = sortRows(collectCommandRows(q));
    } else {
        rows = sortRows(collectTabRows(q));
    }
    activeIdx = rows.length > 0 ? 0 : -1;
    renderList();
}

function moveActive(delta: number): void {
    const visibleCount = Math.min(rows.length, MAX_ROWS);
    if (visibleCount <= 0) return;
    activeIdx = (activeIdx + delta + visibleCount) % visibleCount;
    renderList();
}

async function runRow(row: PaletteRow): Promise<void> {
    closePalette();
    if (row.kind === 'tab') {
        try {
            await activateTab(row.tabId);
        } catch (err) {
            folioLog.warn('palette', 'activateTab failed', { error: String(err) });
        }
        return;
    }
    const cmd = row.cmd;
    if (cmd.menuAction) {
        safeInvoke(
            'menu_dispatch',
            { id: cmd.menuAction },
            'menu_dispatch ' + cmd.menuAction,
        );
        return;
    }
    if (cmd.specialInvoke) {
        safeInvoke(cmd.specialInvoke, {}, cmd.specialInvoke, 'warn');
    }
}

function activateCurrent(): void {
    const visible = rows.slice(0, MAX_ROWS);
    if (activeIdx < 0 || activeIdx >= visible.length) return;
    void runRow(visible[activeIdx]);
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
        // P1: Strg+Enter bei Tabs wie Enter (kein tab_open für Dateien hier)
        activateCurrent();
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
    void runRow(rows[idx]);
}

function onBackdropClick(e: MouseEvent): void {
    if (e.target === backdropEl) {
        closePalette();
    }
}

export function isPaletteOpen(): boolean {
    return open;
}

export function closePalette(): void {
    if (!open) return;
    open = false;
    setOpenClass(false);
    if (inputEl) inputEl.value = '';
    rows = [];
    activeIdx = -1;
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
        rebuildFromInput();
        inputEl.focus();
        inputEl.select();
        return;
    }
    const ae = document.activeElement;
    prevFocus = ae instanceof HTMLElement ? ae : null;
    open = true;
    setOpenClass(true);
    inputEl.value = typeof prefill === 'string' ? prefill : '';
    rebuildFromInput();
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
        rebuildFromInput();
    });
    inputEl.addEventListener('keydown', onInputKeydown);
    listEl.addEventListener('click', onListClick);
    if (backdropEl) {
        backdropEl.addEventListener('click', onBackdropClick);
    }
    // Klick auf Panel soll Input-Fokus behalten / nicht schließen
    if (panelEl) {
        panelEl.addEventListener('mousedown', function (e) {
            // preventDefault auf nicht-Input verhindert Fokus-Diebstahl
            if (e.target !== inputEl) {
                // erlaubt Klicks auf Items, aber hält Fokus im Input wenn möglich
            }
        });
    }

    // Document-Esc als Fallback (falls Fokus nicht im Input)
    document.addEventListener('keydown', function (e) {
        if (!open) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closePalette();
        }
    });

    // Automation-/Test-Hook (Muster __folioVaultFilterReset)
    (window as any).__folioOpenPalette = function (prefill?: string) {
        openPalette(prefill);
    };
}
