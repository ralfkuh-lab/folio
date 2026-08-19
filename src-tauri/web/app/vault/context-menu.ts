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

import { isInvalidFileName, joinDirFile } from '../util/filename';
import { safeInvoke } from '../util/log';
import { confirmRunFile, showConfirmDialog, showRenameDialog } from '../ui/dialogs';
import { searchInFolder } from './search';
import { t } from '../i18n/translate';
import { openGitDiff } from '../ui/git-diff';
import { getTabsSnapshot } from '../state/tabs';
import { clearClip, clearClipIfUnder, getClip, remapClip, setClip } from './clipboard';

// Monochrome 16x16-Feather-Icons je data-act. Kein width/height im SVG
// (CSS steuert die Groesse), stroke=currentColor faerbt mit Hover/Theme mit.
const ICONS: Record<string, string> = {
    open: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5V5.5H13"/></svg>',
    'open-newtab': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5V5.5H13"/><path d="M8 8v4M6 10h4"/></svg>',
    run: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3l8 5-8 5z"/></svg>',
    'open-default': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7"/><path d="M10 2h4v4"/><path d="M7 9l7-7"/></svg>',
    'new-file': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5V5.5H13"/><path d="M8 8.5v3M6.5 10h3"/></svg>',
    'new-folder': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M8 7.5v4M6 9.5h4"/></svg>',
    rename: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10z"/></svg>',
    pin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h4M9 2v5l2 2v1H5V9l2-2V2M8 10v4"/></svg>',
    unpin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h4M9 2v5l2 2v1H5V9l2-2V2M8 10v4"/><path d="M2 2l12 12"/></svg>',
    'remove-recent': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l3 1.5"/></svg>',
    show: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
    terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 7l2 2-2 2M9 11h3"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v.5"/></svg>',
    cut: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/><path d="M8 8.5L4.5 12M8 8.5L11.5 12M8 8.5L13 2.5M8 8.5L3 2.5"/></svg>',
    'clip-copy': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v.5"/></svg>',
    duplicate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v.5"/><path d="M9.5 8v3M8 9.5h3"/></svg>',
    paste: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="9" height="11" rx="1"/><path d="M6 3.5V3a2 2 0 0 1 4 0v.5"/><path d="M6.5 8.5h3M8 7v3"/></svg>',
    delete: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M5 4.5l.5 8a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1l.5-8"/></svg>',
    'search-folder': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
    'show-changes': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.5h4.5M3 8h3M3 12.5h4.5"/><path d="M10 3.5h3v9h-3z"/></svg>',
    'wikilink-root-on': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5l3-3"/><path d="M8.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1"/><path d="M7.5 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"/></svg>',
    'wikilink-root-off': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1"/><path d="M7.5 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"/><path d="M2 2l12 12"/></svg>',
};

// Baut ein Kontextmenue-Item mit Icon + Label als DOM-Nodes.
// t()-Werte nur via textContent — nie in innerHTML interpolieren (i18n Spec).
function appendItem(parent: HTMLElement, act: string, label: string, extraClass?: string): void {
    const div = document.createElement('div');
    div.className = extraClass ? `ctx-item ${extraClass}` : 'ctx-item';
    div.setAttribute('data-act', act);
    const icon = document.createElement('span');
    icon.className = 'ctx-icon';
    // Static SVG constants only — never user/t() content.
    icon.innerHTML = ICONS[act] || '';
    const lab = document.createElement('span');
    lab.className = 'ctx-label';
    lab.textContent = label;
    div.appendChild(icon);
    div.appendChild(lab);
    parent.appendChild(div);
}

function appendSep(parent: HTMLElement): void {
    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    parent.appendChild(sep);
}

function basename(p: string): string {
    const n = p.replace(/\\/g, '/');
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(i + 1) : n;
}

function isPathUnder(path: string, root: string): boolean {
    const p = path.replace(/\\/g, '/');
    const r = root.replace(/\\/g, '/');
    return p === r || p.startsWith(r + '/');
}

function hasDirtyTabsUnder(root: string): boolean {
    return getTabsSnapshot().tabs.some(function (tab) {
        return !!tab.dirty && !!tab.path && isPathUnder(tab.path, root);
    });
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

export type ContextMenuOptions = {
    gitModified?: boolean;
    isText?: boolean;
    /** Pin-Wurzel ist als Wikilink-/Tag-Wurzel freigeschaltet
     *  (`data-wikilink-root="1"` aus dem Backend-Markup, Spec W8). */
    wikilinkRoot?: boolean;
};

export function openContextMenu(
    x: number,
    y: number,
    path: string,
    isDir: boolean,
    inPinned: boolean,
    inRecent: boolean,
    isExec: boolean,
    options?: ContextMenuOptions,
): void {
    if (!ctxMenu) return;
    ctxTarget = { path, isDirectory: isDir };
    ctxMenu.replaceChildren();
    let headCount = 0;
    if (!isDir) {
        appendItem(ctxMenu, 'open', t('vault.contextMenu.open'));
        appendItem(ctxMenu, 'open-newtab', t('vault.contextMenu.openNewTab'));
        if (isExec) appendItem(ctxMenu, 'run', t('vault.contextMenu.run'));
        else appendItem(ctxMenu, 'open-default', t('vault.contextMenu.openWithDefault'));
        headCount = 3;
    }
    // Verzeichnis: „Neue Datei…" / „Neuer Ordner…" zuerst; Datei: in der
    // mittleren Aktions-Gruppe bei „Umbenennen".
    const mid: Array<[string, string]> = [];
    if (isDir) mid.push(['new-file', t('vault.contextMenu.newFile')]);
    if (isDir) mid.push(['new-folder', t('vault.contextMenu.newFolder')]);
    if (isDir) mid.push(['search-folder', t('vault.contextMenu.searchInFolder')]);
    mid.push(['rename', t('vault.contextMenu.rename')]);
    if (!isDir && options?.gitModified && options?.isText) {
        mid.push(['show-changes', t('vault.contextMenu.showChanges')]);
    }
    const isPinRootDir = isDir && inPinned;
    mid.push(['cut', t('vault.contextMenu.cut')]);
    mid.push(['clip-copy', t('vault.contextMenu.copy')]);
    mid.push(['duplicate', t('vault.contextMenu.duplicate')]);
    if (isDir && getClip()) mid.push(['paste', t('vault.contextMenu.paste')]);
    if (!isDir) mid.push(['new-file', t('vault.contextMenu.newFile')]);
    if (!isDir) mid.push(['new-folder', t('vault.contextMenu.newFolder')]);
    if (!inPinned) mid.push(['pin', t('vault.contextMenu.pin')]);
    if (inPinned) mid.push(['unpin', t('vault.contextMenu.unpin')]);
    // Wikilink-/Tag-Opt-in gibt es nur auf Pin-Wurzeln (Verzeichnis wie
    // Einzeldatei) — der Suchraum des Index ist eine Teilmenge der Pins.
    // Toggle über zwei Labels statt eines Häkchens: das ctx-Menü kennt
    // keinen Checked-Zustand.
    if (inPinned) {
        mid.push(
            options?.wikilinkRoot
                ? ['wikilink-root-off', t('vault.contextMenu.wikilinkRootDisable')]
                : ['wikilink-root-on', t('vault.contextMenu.wikilinkRootEnable')],
        );
    }
    if (inRecent) mid.push(['remove-recent', t('vault.contextMenu.removeRecent')]);
    if (mid.length && headCount) appendSep(ctxMenu);
    for (const [act, label] of mid) appendItem(ctxMenu, act, label);
    if (headCount + mid.length > 0) appendSep(ctxMenu);
    appendItem(ctxMenu, 'show', t('vault.contextMenu.showInExplorer'));
    appendItem(ctxMenu, 'terminal', t('vault.contextMenu.openTerminal'));
    appendItem(ctxMenu, 'copy', t('vault.contextMenu.copyPath'));
    // Löschen ganz unten, durch Separator abgesetzt. NICHT auf einer
    // Pin-Wurzel-Verzeichnis-Zeile: dort ist fast immer „Aus Vault
    // entfernen" (unpin) gemeint, und ein Fehlklick schöbe ein ganzes
    // Projektverzeichnis in den Papierkorb. Gepinnte Einzeldateien bleiben
    // löschbar — dort ist der Schaden lokal und das Verhalten alt.
    if (!isPinRootDir) {
        appendSep(ctxMenu);
        appendItem(ctxMenu, 'delete', t('vault.contextMenu.delete'), 'ctx-item-danger');
    }

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
        if (n.getAttribute('data-path') === path) {
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
        if (isInvalidFileName(newName)) {
            restore();
            deps.showStatus(t('errors.file.invalidName'));
            return;
        }
        cleanup();
        labelEl.textContent = newName; // optimistisch bis vault:refresh kommt
        const normalized = path.replace(/\\/g, '/');
        const lastSlash = normalized.lastIndexOf('/');
        const parent = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
        const newPath = parent + newName;
        invoke('rename_file', { oldPath: path, newPath }).then(function () {
            remapClip(path, newPath);
        }).catch(function (err) {
            deps.showStatus(typeof err === 'string' ? err : t('errors.vault.renameFailed'));
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
    const isDir = nodeEl.getAttribute('data-kind') === 'dir';
    if (isDir) {
        input.select();
    } else {
        const dot = basename.lastIndexOf('.');
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    }
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
        } else if (act === 'wikilink-root-on' || act === 'wikilink-root-off') {
            safeInvoke(
                'workspace_wikilink_root_set',
                { path, enabled: act === 'wikilink-root-on' },
                'workspace_wikilink_root_set',
            );
        } else if (act === 'remove-recent') {
            safeInvoke('workspace_remove_recent', { path }, 'workspace_remove_recent');
        } else if (act === 'search-folder' && isDir) {
            searchInFolder(path);
        } else if (act === 'show-changes' && !isDir) {
            void openGitDiff(path, deps.showStatus);
        } else if (act === 'rename') {
            startInlineRename(path);
        } else if (act === 'show') {
            safeInvoke('show_in_file_manager', { path }, 'show_in_file_manager');
        } else if (act === 'terminal') {
            safeInvoke('open_terminal_at', { path }, 'open_terminal_at');
        } else if (act === 'copy') {
            if (navigator.clipboard) navigator.clipboard.writeText(path).catch(function () { /* clipboard write may reject silently */ });
        } else if (act === 'cut') {
            setClip(path, 'cut');
        } else if (act === 'clip-copy') {
            setClip(path, 'copy');
        } else if (act === 'duplicate') {
            invoke('duplicate_entry', { path }).catch(function (err) {
                deps.showStatus(typeof err === 'string' ? err : t('errors.file.copyTreeFailed', { detail: String(err) }));
            });
        } else if (act === 'paste' && isDir) {
            const held = getClip();
            if (!held) return;
            const cmd = held.mode === 'cut' ? 'move_entry' : 'copy_entry';
            invoke(cmd, { src: held.path, destDir: path }).then(function () {
                if (held.mode === 'cut') clearClip();
            }).catch(function (err) {
                const message = typeof err === 'string' ? err : t('errors.file.copyTreeFailed', { detail: String(err) });
                if (typeof err === 'string' && err === t('errors.file.sourceMissing', { detail: held.path })) {
                    clearClip();
                }
                deps.showStatus(message);
            });
        } else if (act === 'new-file') {
            const dir = isDir ? path : path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
            showRenameDialog('untitled.md', t('vault.contextMenu.newFile.prompt'), { title: t('vault.contextMenu.newFile.title'), okLabel: t('vault.contextMenu.newFile.action') }).then(function (name) {
                const trimmed = (name || '').trim();
                if (!trimmed) return; // leer/whitespace → abbrechen
                if (isInvalidFileName(trimmed)) {
                    deps.showStatus(t('errors.file.invalidName'));
                    return;
                }
                const newPath = joinDirFile(dir, trimmed);
                invoke('create_file', { path: newPath }).then(function (p) {
                    safeInvoke('tab_open', { path: p }, 'tab_open', 'warn');
                }).catch(function (err) {
                    deps.showStatus(typeof err === 'string' ? err : t('errors.vault.createFailed'));
                });
            });
        } else if (act === 'new-folder') {
            const dir = isDir ? path : path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
            showRenameDialog('untitled', t('vault.contextMenu.newFolder.prompt'), { title: t('vault.contextMenu.newFolder.title'), okLabel: t('vault.contextMenu.newFolder.action') }).then(function (name) {
                const trimmed = (name || '').trim();
                if (!trimmed) return;
                if (isInvalidFileName(trimmed)) {
                    deps.showStatus(t('errors.file.invalidName'));
                    return;
                }
                const newPath = joinDirFile(dir, trimmed);
                invoke('create_directory', { path: newPath }).catch(function (err) {
                    deps.showStatus(typeof err === 'string' ? err : t('errors.vault.createFailed'));
                });
            });
        } else if (act === 'delete') {
            const name = basename(path);
            const confirmOpts = isDir
                ? {
                    title: t('vault.contextMenu.deleteFolder.title'),
                    okLabel: t('vault.contextMenu.delete.action'),
                }
                : {
                    title: t('vault.contextMenu.delete.title'),
                    okLabel: t('vault.contextMenu.delete.action'),
                };
            const message = isDir
                ? (hasDirtyTabsUnder(path)
                    ? t('vault.contextMenu.deleteFolderConfirmUnsaved', { name })
                    : t('vault.contextMenu.deleteFolderConfirm', { name }))
                : t('vault.contextMenu.deleteConfirm', { name });
            showConfirmDialog(message, confirmOpts).then(function (ok) {
                if (ok) {
                    clearClipIfUnder(path);
                    safeInvoke('trash_path', { path }, 'trash_path', 'warn');
                }
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
