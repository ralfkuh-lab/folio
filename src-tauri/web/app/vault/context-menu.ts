/* Vault-Kontextmenue + Inline-Rename. Das #context-menu-Element wird per
   openContextMenu() positioniert und mit Items befuellt; item-Click
   dispatcht die jeweilige Aktion (open / pin / unpin / remove-recent /
   rename / show / terminal / copy). startInlineRename ersetzt das
   .label-span des Tree-Eintrags temporaer durch ein <input>. */

type Deps = {
    openDocument: (path: string) => void;
    refreshVault: () => void;
    showStatus: (msg: string) => void;
};

import { safeInvoke } from '../util/log';
import { confirmRunFile, showConfirmDialog, showRenameDialog } from '../ui/dialogs';

// Monochrome 16x16-Feather-Icons je data-act. Kein width/height im SVG
// (CSS steuert die Groesse), stroke=currentColor faerbt mit Hover/Theme mit.
const ICONS: Record<string, string> = {
    open: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5V5.5H13"/></svg>',
    'open-newtab': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5V5.5H13"/><path d="M8 8v4M6 10h4"/></svg>',
    run: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3l8 5-8 5z"/></svg>',
    'open-default': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7"/><path d="M10 2h4v4"/><path d="M7 9l7-7"/></svg>',
    'new-file': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5V5.5H13"/><path d="M8 8.5v3M6.5 10h3"/></svg>',
    rename: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10z"/></svg>',
    pin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h4M9 2v5l2 2v1H5V9l2-2V2M8 10v4"/></svg>',
    unpin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h4M9 2v5l2 2v1H5V9l2-2V2M8 10v4"/><path d="M2 2l12 12"/></svg>',
    'remove-recent': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l3 1.5"/></svg>',
    show: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
    terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 7l2 2-2 2M9 11h3"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v.5"/></svg>',
    delete: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M5 4.5l.5 8a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1l.5-8"/></svg>',
};

// Baut ein Kontextmenue-Item mit Icon + Label. Ersetzt die frueheren
// inline-duplizierten HTML-Strings (weniger Fehlerquellen bei Punkt 3/4).
function item(act: string, label: string, extraClass?: string): string {
    const cls = extraClass ? `ctx-item ${extraClass}` : 'ctx-item';
    return `<div class="${cls}" data-act="${act}"><span class="ctx-icon">${ICONS[act] || ''}</span><span class="ctx-label">${label}</span></div>`;
}

function basename(p: string): string {
    const n = p.replace(/\\/g, '/');
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(i + 1) : n;
}

// Externe Datei-Aktion, geteilt von Kontextmenü und Doppelklick im Tree:
// ausführbare Dateien werden nach Bestätigung als Prozess gestartet, alle
// anderen mit dem Standardprogramm des OS geöffnet.
export function runOrOpenFile(path: string, isExec: boolean): void {
    if (isExec) {
        confirmRunFile(basename(path)).then(function (ok) {
            if (ok) safeInvoke('run_file', { path }, 'run_file', 'warn');
        });
    } else {
        safeInvoke('open_with_default', { path }, 'open_with_default', 'warn');
    }
}

let deps: Deps = null;
let ctxMenu: HTMLElement | null = null;
let ctxTarget: { path: string; isDirectory: boolean } | null = null;

function invoke(cmd: string, args?: any): Promise<any> {
    return window.__TAURI__.core.invoke(cmd, args);
}

export function openContextMenu(
    x: number,
    y: number,
    path: string,
    isDir: boolean,
    inPinned: boolean,
    inRecent: boolean,
    isExec: boolean,
): void {
    if (!ctxMenu) return;
    ctxTarget = { path, isDirectory: isDir };
    const parts: string[] = [];
    if (!isDir) parts.push(item('open', 'Öffnen'));
    if (!isDir) parts.push(item('open-newtab', 'In neuem Tab öffnen'));
    if (!isDir) {
        if (isExec) parts.push(item('run', 'Ausführen'));
        else parts.push(item('open-default', 'Mit Standardprogramm öffnen'));
    }
    const actionsBefore = parts.length;
    const actions: string[] = [];
    // Verzeichnis: „Neue Datei…" wird erstes Item; Datei: in der mittleren
    // Aktions-Gruppe bei „Umbenennen".
    if (isDir) actions.push(item('new-file', 'Neue Datei…'));
    if (!isDir) actions.push(item('rename', 'Umbenennen'));
    if (!isDir) actions.push(item('new-file', 'Neue Datei…'));
    if (!inPinned) actions.push(item('pin', 'Anpinnen'));
    if (inPinned) actions.push(item('unpin', 'Vom Pin lösen'));
    if (inRecent) actions.push(item('remove-recent', 'Aus „Zuletzt" entfernen'));
    if (actions.length && actionsBefore) parts.push('<div class="ctx-sep"></div>');
    parts.push(...actions);
    const tail = [
        item('show', 'Im Explorer zeigen'),
        item('terminal', 'Terminal hier öffnen'),
        item('copy', 'Pfad kopieren'),
    ];
    if (parts.length) parts.push('<div class="ctx-sep"></div>');
    parts.push(...tail);
    // Löschen (nur Dateien) ganz unten, durch Separator abgesetzt.
    if (!isDir) {
        parts.push('<div class="ctx-sep"></div>');
        parts.push(item('delete', 'Löschen', 'ctx-item-danger'));
    }
    ctxMenu.innerHTML = parts.join('');

    // Punkt 1: provisorisch positionieren, dann gemessene Groesse am
    // Viewport-Rand clampen, damit das Menue nie abgeschnitten wird.
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.classList.add('open');
    const margin = 4;
    const rect = ctxMenu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (x + rect.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (y + rect.height > window.innerHeight - margin) {
        top = Math.max(margin, y - rect.height);
    }
    ctxMenu.style.left = left + 'px';
    ctxMenu.style.top = top + 'px';
}

export function closeContextMenu(): void {
    if (ctxMenu) ctxMenu.classList.remove('open');
    ctxTarget = null;
}

/* Inline-Rename im Vault-Baum (Explorer-Feeling): ersetzt das .label-Span
   temporär durch ein <input>, vorselektiert den Stamm ohne Endung. Enter/
   Blur committen, Escape bricht ab. Nach erfolgreichem rename_file
   emittiert das Backend vault:refresh, das den Baum neu baut — das Input
   verschwindet damit automatisch. */
export function startInlineRename(path: string): void {
    if (!path) return;
    const nodes = document.querySelectorAll('#vault-tree li.node[data-path]');
    let nodeEl: HTMLElement | null = null;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i] as HTMLElement;
        if (n.getAttribute('data-path') === path && n.getAttribute('data-kind') !== 'dir') {
            nodeEl = n;
            break;
        }
    }
    if (!nodeEl) return;
    const labelEl = nodeEl.querySelector(':scope > .row > .label') as HTMLElement;
    if (!labelEl || labelEl.dataset.editing === '1') return;
    const originalText = labelEl.textContent || '';
    const basename = originalText;
    labelEl.dataset.editing = '1';
    labelEl.classList.add('editing');
    labelEl.textContent = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'vault-rename-input';
    input.value = basename;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('data-rename-input', '1');
    labelEl.appendChild(input);

    function stop(e: Event): void { e.stopPropagation(); }
    input.addEventListener('click', stop);
    input.addEventListener('mousedown', stop);
    input.addEventListener('dblclick', stop);
    input.addEventListener('contextmenu', stop);

    let finished = false;
    function cleanup(): void {
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', onBlur);
        labelEl.classList.remove('editing');
        delete labelEl.dataset.editing;
    }
    function restore(): void {
        cleanup();
        labelEl.textContent = originalText;
    }
    function commit(): void {
        if (finished) return;
        finished = true;
        const newName = (input.value || '').trim();
        if (!newName || newName === originalText) {
            restore();
            return;
        }
        cleanup();
        labelEl.textContent = newName; // optimistisch bis vault:refresh kommt
        const normalized = path.replace(/\\/g, '/');
        const lastSlash = normalized.lastIndexOf('/');
        const parent = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
        const newPath = parent + newName;
        invoke('rename_file', { oldPath: path, newPath }).catch(function (err) {
            deps.showStatus(typeof err === 'string' ? err : 'Umbenennen fehlgeschlagen');
            deps.refreshVault();
        });
    }
    function cancel(): void {
        if (finished) return;
        finished = true;
        restore();
    }
    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        else { e.stopPropagation(); }
    }
    function onBlur(): void { commit(); }
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);

    input.focus();
    const dot = basename.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
}

export function initContextMenu(d: Deps): void {
    deps = d;
    ctxMenu = document.getElementById('context-menu');
    if (!ctxMenu) return;

    ctxMenu.addEventListener('click', function (e) {
        const item = (e.target as HTMLElement).closest('.ctx-item') as HTMLElement;
        if (!item || item.classList.contains('disabled') || !ctxTarget) return;
        const act = item.getAttribute('data-act');
        const path = ctxTarget.path;
        const isDir = ctxTarget.isDirectory;
        closeContextMenu();
        if (act === 'open' && !isDir) {
            deps.openDocument(path);
        } else if (act === 'open-newtab' && !isDir) {
            safeInvoke('tab_open', { path }, 'tab_open');
        } else if (act === 'run' && !isDir) {
            runOrOpenFile(path, true);
        } else if (act === 'open-default' && !isDir) {
            runOrOpenFile(path, false);
        } else if (act === 'pin') {
            safeInvoke('workspace_pin', { path, isDirectory: isDir }, 'workspace_pin');
        } else if (act === 'unpin') {
            safeInvoke('workspace_unpin', { path }, 'workspace_unpin');
        } else if (act === 'remove-recent') {
            safeInvoke('workspace_remove_recent', { path }, 'workspace_remove_recent');
        } else if (act === 'rename') {
            startInlineRename(path);
        } else if (act === 'show') {
            safeInvoke('show_in_file_manager', { path }, 'show_in_file_manager');
        } else if (act === 'terminal') {
            safeInvoke('open_terminal_at', { path }, 'open_terminal_at');
        } else if (act === 'copy') {
            if (navigator.clipboard) navigator.clipboard.writeText(path).catch(function () { /* clipboard write may reject silently */ });
        } else if (act === 'new-file') {
            const dir = isDir ? path : path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
            showRenameDialog('untitled.md', 'Dateinamen eingeben:', { title: 'Neue Datei', okLabel: 'Anlegen' }).then(function (name) {
                const trimmed = (name || '').trim();
                if (!trimmed) return; // leer/whitespace → abbrechen
                if (/[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
                    deps.showStatus('Ungültiger Dateiname');
                    return;
                }
                const newPath = dir.replace(/\/$/, '') + '/' + trimmed;
                invoke('create_file', { path: newPath }).then(function (p) {
                    safeInvoke('tab_open', { path: p }, 'tab_open', 'warn');
                }).catch(function (err) {
                    deps.showStatus(typeof err === 'string' ? err : 'Anlegen fehlgeschlagen');
                });
            });
        } else if (act === 'delete' && !isDir) {
            const name = basename(path);
            showConfirmDialog(`„${name}" in den Papierkorb verschieben?`, { title: 'Datei löschen', okLabel: 'Löschen' }).then(function (ok) {
                if (ok) safeInvoke('trash_file', { path }, 'trash_file', 'warn');
            });
        }
    });
    document.addEventListener('click', function (e) {
        if (!ctxMenu.contains(e.target as Node)) closeContextMenu();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeContextMenu();
    });
}
