/* Markdown-Cheat-Sheet als drag- und persistierbares Overlay. Sichtbar nur
   im Edit-Mode bei Markdown-Dokumenten (CSS-gegated in styles/overlays.css).
   Modul kapselt: Position-/Visibility-Persistenz, Drag-Choreografie,
   Mode-Sync, Menue-Enabled-Sync. Init wird aus main.ts gerufen, damit die
   Reihenfolge der DOM-Zugriffe erhalten bleibt. */

import { safeInvoke } from '../util/log';

const STORAGE_KEY = 'folio.cheatsheet';

export const cheatSheetRows: Array<[string, string]> = [
    ['Überschrift',     '# H1   ## H2   ### H3'],
    ['Fett / Kursiv',   '**fett**   *kursiv*'],
    ['Durchgestrichen', '~~text~~'],
    ['Inline-Code',     '`code`'],
    ['Codeblock',       '```codeblock```'],
    ['Link',            '[Text](https://…)'],
    ['Bild',            '![alt](pfad.png)'],
    ['Aufzählung',      '- Item   * Item'],
    ['Nummeriert',      '1. Item'],
    ['Zitat',           '> Text'],
    ['Trennlinie',      '---'],
    ['Tabelle',         '| col | col |\n|---|---|'],
    ['Aufgabe',         '- [ ] offen   - [x] erledigt'],
];

// Lazy-initialized Modul-State — gesetzt in initCheatsheet().
let overlay: HTMLElement = null;
let dragHeader: HTMLElement = null;
let body: HTMLElement = null;
let dragState: { x: number; y: number; r: number; t: number } | null = null;
let rightOffset = 16;
let topOffset = 80;
let wantsVisible = false;
let lastRows: Array<{ label: string; code: string }> | null = null;

function post(msg: any): void {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('shell:event', msg);
    }
}

function loadStored(): void {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (typeof s.right === 'number' && s.right >= 0) rightOffset = s.right;
        if (typeof s.top === 'number' && s.top >= 0) topOffset = s.top;
        if (typeof s.visible === 'boolean') wantsVisible = s.visible;
    } catch (_) { /* ignore */ }
}

function saveStored(): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            right: rightOffset, top: topOffset, visible: wantsVisible
        }));
    } catch (_) { /* ignore */ }
}

function applyPosition(): void {
    overlay.style.right = rightOffset + 'px';
    overlay.style.top = topOffset + 'px';
    overlay.style.left = 'auto';
    overlay.style.bottom = 'auto';
}

function verticalBounds(): { top: number; bottom: number } {
    const tb = document.getElementById('toolbar');
    const sb = document.getElementById('statusbar');
    const top = tb ? tb.getBoundingClientRect().bottom : 0;
    const bottom = sb ? sb.getBoundingClientRect().top : window.innerHeight;
    return { top: Math.max(0, top), bottom: Math.max(top, bottom) };
}

function clampInsideViewport(): void {
    const rect = overlay.getBoundingClientRect();
    const winW = window.innerWidth;
    const bounds = verticalBounds();
    if (rect.right > winW - 1) rightOffset = 0;
    if (rect.left < 0) rightOffset = Math.max(0, winW - rect.width);
    if (rect.bottom > bounds.bottom) topOffset = Math.max(bounds.top, bounds.bottom - rect.height);
    if (rect.top < bounds.top) topOffset = bounds.top;
    applyPosition();
}

function renderRows(rowsJson: string | any[]): void {
    body.innerHTML = '';
    try {
        const rows = (typeof rowsJson === 'string') ? JSON.parse(rowsJson) : rowsJson;
        if (Array.isArray(rows)) {
            lastRows = rows;
            rows.forEach(function (r) {
                const l = document.createElement('div'); l.className = 'label'; l.textContent = r.label || '';
                const c = document.createElement('div'); c.className = 'code'; c.textContent = r.code || '';
                body.appendChild(l); body.appendChild(c);
            });
        }
    } catch (_) { /* defensive */ }
}

export function showCheatSheet(rowsJson: string | any[]): void {
    wantsVisible = true;
    saveStored();
    renderRows(rowsJson);
    overlay.hidden = false;
    applyPosition();
    requestAnimationFrame(clampInsideViewport);
}

export function hideCheatSheet(): void {
    wantsVisible = false;
    saveStored();
    if (overlay.hidden) return;
    overlay.hidden = true;
    post({ type: 'cheatsheetClosed', rightOffset, topOffset });
}

// Vom Mode-Switch im Editor-Shell gerufen. Aendert wantsVisible nicht —
// das Overlay merkt sich, ob der User es zuletzt offen haben wollte.
export function cheatsheetSyncMode(isEdit: boolean): void {
    if (isEdit) {
        if (wantsVisible) {
            const rows = lastRows || cheatSheetRows.map(r => ({ label: r[0], code: r[1] }));
            renderRows(rows);
            overlay.hidden = false;
            applyPosition();
            requestAnimationFrame(clampInsideViewport);
        }
    } else {
        if (!overlay.hidden) {
            overlay.hidden = true;
        }
    }
}

export function cheatsheetWantsVisible(): boolean {
    return wantsVisible;
}

// Tauri-Menue-Items, die nur im Edit-Mode bei Markdown-Dokumenten Sinn
// ergeben (help.cheatsheet, view.minimap), enable/disable in einem Rutsch.
// Name historisch — beide Items teilen sich die Aktivierungs-Bedingung,
// daher hier zentral.
export function syncCheatsheetMenu(): void {
    if (!window.__TAURI__ || !window.__TAURI__.core) return;
    const editorActive = document.body.classList.contains('edit-mode')
        || document.body.classList.contains('split-mode');
    const enabled = editorActive
        && document.body.classList.contains('kind-markdown');
    safeInvoke('menu_set_enabled', { id: 'help.cheatsheet', enabled }, 'menu_set_enabled help.cheatsheet', 'debug');
    safeInvoke('menu_set_enabled', { id: 'view.minimap', enabled }, 'menu_set_enabled view.minimap', 'debug');
}

export function initCheatsheet(): void {
    overlay = document.getElementById('cheatsheet-overlay');
    dragHeader = overlay.querySelector('.overlay__drag');
    body = document.getElementById('cheatsheet-body');

    loadStored();

    // Drag am Header
    dragHeader.addEventListener('pointerdown', function (e: PointerEvent) {
        try { dragHeader.setPointerCapture(e.pointerId); } catch (_) {}
        dragState = { x: e.clientX, y: e.clientY, r: rightOffset, t: topOffset };
        e.preventDefault();
    });
    dragHeader.addEventListener('pointermove', function (e: PointerEvent) {
        if (!dragState) return;
        const dx = e.clientX - dragState.x;
        const dy = e.clientY - dragState.y;
        const rect = overlay.getBoundingClientRect();
        const winW = window.innerWidth;
        const bounds = verticalBounds();
        const maxR = Math.max(0, winW - rect.width);
        const maxT = Math.max(bounds.top, bounds.bottom - rect.height);
        rightOffset = Math.min(maxR, Math.max(0, dragState.r - dx));
        topOffset = Math.min(maxT, Math.max(bounds.top, dragState.t + dy));
        applyPosition();
    });
    function endDrag(e: PointerEvent): void {
        if (!dragState) return;
        try { dragHeader.releasePointerCapture(e.pointerId); } catch (_) {}
        dragState = null;
        saveStored();
    }
    dragHeader.addEventListener('pointerup', endDrag);
    dragHeader.addEventListener('pointercancel', endDrag);

    // Window-Resize: in den Viewport zurueckholen.
    window.addEventListener('resize', function () {
        if (overlay.hidden) return;
        clampInsideViewport();
    });
}
