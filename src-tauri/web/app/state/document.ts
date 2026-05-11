// @ts-nocheck
/* Dokument-State + Lifecycle-Events. Kapselt:
   - currentPath / cleanText / isDirty,
   - markDirty, applyWindowTitle, setStatusPath, updateWordCount, showStatus,
   - applyDocKind (Body-Class kind-*, Toolbar-Disable, Menue-Enable/-Check),
   - openDocument (read_file -> applyDocKind -> Mode-Switch bei non-MD),
   - saveCurrent / requestSaveIfDirty / syncEditorTextToStore,
   - fusionierter document:loaded-Handler + document:dirty_changed /
     document:closed / document:saved.

   Listener-Fusion (Plan-Phase 4.5): document:loaded hatte zwei
   komplementaere Haelften — IIFE #1 (UI-Rendering: loadEditorText,
   setTocList, body.innerHTML, rewriteRelativeAssets, setVaultActive)
   und IIFE #2 (State-Tracking: currentPath, cleanText, dirty-Flag,
   Statusbar, Word-Count, applyDocKind, workspace_add_recent, Find-
   Highlight-Restore). Fusioniert: State-Setup zuerst, dann UI-Rendering. */

import { setTocList, rewriteRelativeAssets, ViewFinder } from '../view/markdown';
import { setVaultActive } from '../vault/tree';
import { setEditorLanguageDisplay } from '../ui/language-picker';
import { syncCheatsheetMenu } from '../ui/cheatsheet';
import { showUnsavedDialog } from '../ui/dialogs';
import { isEditorMounted, loadEditorText } from '../editor/shell';

type Deps = {
    setActiveMode: (mode: string) => void;
};

let deps: Deps = null;
let currentPath: string | null = null;
let cleanText = '';
let isDirty = false;

function invoke(cmd: string, args?: any): Promise<any> {
    return window.__TAURI__.core.invoke(cmd, args);
}

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export function getCurrentPath(): string | null { return currentPath; }
export function getCleanText(): string { return cleanText; }
export function getIsDirty(): boolean { return isDirty; }

function fileFullName(p: string | null): string | null {
    if (!p) return null;
    return p.replace(/\\/g, '/').split('/').pop() || p;
}

export function applyWindowTitle(): void {
    const name = fileFullName(currentPath);
    const title = name
        ? (isDirty ? '* ' + name : name) + ' — Folio'
        : 'Folio';
    document.title = title;
    invoke('set_window_title', { title }).catch(function () { /* ignore */ });
}

export function markDirty(dirty: boolean): void {
    isDirty = !!dirty;
    const el = $('status-path');
    if (el) el.classList.toggle('dirty', isDirty);
    const btn = $('tb-save') as HTMLButtonElement;
    if (btn) btn.disabled = !isDirty;
    invoke('menu_set_enabled', { id: 'file.save', enabled: isDirty }).catch(function () {});
    applyWindowTitle();
}

export function setStatusPath(path: string, dirty: boolean): void {
    const el = $('status-path');
    if (!el) return;
    el.textContent = path || 'Bereit';
    el.classList.toggle('dirty', !!dirty);
}

export function updateWordCount(text: string): void {
    const el = $('status-wordcount');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    const chars = text.length;
    const words = (text.match(/\S+/g) || []).length;
    const lines = text.split(/\r\n|\r|\n/).length;
    el.hidden = false;
    el.textContent = words + ' Wörter · ' + chars + ' Zeichen · ' + lines + ' Zeilen';
}

export function showStatus(msg: string): void {
    const el = $('status-path');
    if (el) el.textContent = msg;
}

function editorText(): string {
    // Nur fragen, wenn der Editor wirklich gemountet ist — sonst gibt
    // FolioEditor.getText() im View-Mode "" zurueck und der Dirty-Check
    // schlaegt faelschlich an (Bug: Save-Dialog beim Dateiwechsel im View-Mode).
    if (isEditorMounted() && window.FolioEditor && typeof window.FolioEditor.getText === 'function') {
        return window.FolioEditor.getText();
    }
    return cleanText;
}

function refreshDirtyFromEditor(): boolean {
    const dirty = !!currentPath && editorText() !== cleanText;
    markDirty(dirty);
    return dirty;
}

export function syncEditorTextToStore(): Promise<unknown> {
    if (!currentPath) return Promise.resolve();
    return invoke('editor_text_changed', { text: editorText() }).catch(function () {});
}

export function saveCurrent(): Promise<boolean> {
    return syncEditorTextToStore().then(function () {
        return invoke('editor_save_requested');
    }).then(function (saved) {
        if (saved) {
            cleanText = editorText();
            markDirty(false);
        }
        return !!saved;
    }).catch(function () { return false; });
}

export function requestSaveIfDirty(): Promise<boolean> {
    const dirty = refreshDirtyFromEditor();
    if (!dirty && !isDirty) return Promise.resolve(true);
    return syncEditorTextToStore().then(showUnsavedDialog).then(function (decision) {
        if (decision === 'cancel') return false;
        if (decision === 'discard') {
            return invoke('discard_editor_changes').then(function () {
                cleanText = editorText();
                markDirty(false);
                return true;
            }).catch(function () { return false; });
        }
        return invoke('editor_save_requested').then(function (saved) {
            if (saved) {
                cleanText = editorText();
                markDirty(false);
            }
            return !!saved;
        }).catch(function () { return false; });
    });
}

const DOC_KIND_CLASSES = ['kind-markdown', 'kind-text', 'kind-binary', 'kind-unknown'];

// Liest den aktuellen Mode aus body.classList und setzt die Haekchen im
// Ansicht-Menue. Kein State neben dem DOM — gleiche Strategie wie
// syncCheatsheetMenu.
function syncViewModeMenuChecks(): void {
    const body = document.body;
    // Ohne geladenes Dokument soll kein Mode angehakt sein, auch wenn
    // edit-mode/split-mode-Klassen noch im DOM stehen.
    const hasDoc = !body.classList.contains('kind-unknown')
                && !body.classList.contains('kind-binary');
    const mode = !hasDoc ? null
              : body.classList.contains('edit-mode') ? 'edit'
              : body.classList.contains('split-mode') ? 'split'
              : 'view';
    invoke('menu_set_checked', { id: 'view.mode.view', checked: mode === 'view' }).catch(function () {});
    invoke('menu_set_checked', { id: 'view.mode.edit', checked: mode === 'edit' }).catch(function () {});
    invoke('menu_set_checked', { id: 'view.mode.split', checked: mode === 'split' }).catch(function () {});
}

export function applyDocKind(kind: string | null): void {
    const resolved = kind || 'unknown';
    const body = document.body;
    DOC_KIND_CLASSES.forEach(function (c) { body.classList.remove(c); });
    body.classList.add('kind-' + resolved);

    const md = resolved === 'markdown';
    const hasDoc = resolved !== 'unknown' && resolved !== 'binary';
    const btnView = $('tb-mode-view') as HTMLButtonElement;
    if (btnView) {
        btnView.disabled = !md;
        btnView.title = md ? 'View (Ctrl+1)' : 'View nur für Markdown verfügbar';
    }
    const btnEdit = $('tb-mode-edit') as HTMLButtonElement;
    if (btnEdit) {
        btnEdit.disabled = !hasDoc;
        btnEdit.title = hasDoc ? 'Edit (Ctrl+2)' : 'Kein Dokument geladen';
    }
    const btnExport = $('tb-export') as HTMLButtonElement;
    if (btnExport) {
        btnExport.disabled = !md;
        btnExport.title = md ? 'Exportieren…' : 'Export nur für Markdown verfügbar';
    }
    // Menue-Items synchron halten: View-Mode nur bei MD, Save-As bei jedem
    // geladenen, lesbaren Dokument (also nicht 'unknown').
    invoke('menu_set_enabled', { id: 'view.mode.view', enabled: md }).catch(function () {});
    invoke('menu_set_enabled', { id: 'view.mode.edit', enabled: hasDoc }).catch(function () {});
    invoke('menu_set_enabled', { id: 'file.save_as', enabled: hasDoc }).catch(function () {});
    invoke('menu_set_enabled', { id: 'file.rename', enabled: hasDoc }).catch(function () {});
    invoke('menu_set_enabled', { id: 'file.close', enabled: hasDoc }).catch(function () {});
    syncCheatsheetMenu();
    // Haekchen nach dem Enable-Wechsel erneut anwenden — Tauri scheint
    // set_checked auf disabled Items zu verwerfen, sodass beim ersten
    // Doc-Laden der View/Edit-Mode-Haken sonst leer bleibt, bis der
    // User selbst umschaltet.
    syncViewModeMenuChecks();
}

export function openDocument(path: string): Promise<boolean> {
    return requestSaveIfDirty().then(function (ok) {
        if (!ok) return false;
        return invoke('read_file', { path }).then(function (data) {
            invoke('workspace_add_recent', { path }).catch(function () {});
            const kind = data && data.kind;
            if (kind && kind !== 'markdown'
                && !document.body.classList.contains('edit-mode')) {
                invoke('set_view_mode', { mode: 'edit' }).then(function () {
                    deps.setActiveMode('edit');
                }).catch(function () {});
            }
            applyDocKind(kind);
            return true;
        }).catch(function (err) {
            showStatus(typeof err === 'string' ? err : 'Datei konnte nicht geöffnet werden');
            return false;
        });
    });
}

function renderDocumentPayload(data: any): void {
    if (!data || typeof data !== 'object') return;
    setTocList(data.tocHtml || data.toc_html || '');
    const view = document.getElementById('view-region');
    const body = view && view.querySelector('.markdown-body');
    if (body) {
        body.innerHTML = data.content || data.html || '';
        rewriteRelativeAssets(body as HTMLElement, data.path || currentPath);
    }
}

export function initDocumentState(d: Deps): void {
    deps = d;

    const listen = window.__TAURI__.event.listen;

    // ----- Listener-Fusion (Plan-Phase 4.5) -----
    // Vorher IIFE #1: UI-Rendering (loadEditorText, setTocList, body.innerHTML,
    // rewriteRelativeAssets, setVaultActive, setEditorLanguageDisplay).
    // Vorher IIFE #2: State-Tracking (currentPath, cleanText, dirty-Flag,
    // Statusbar, Word-Count, applyDocKind, workspace_add_recent, Find-
    // Highlight-Restore).
    // Reihenfolge im fusionierten Handler: State zuerst, dann UI-Rendering.
    listen('document:loaded', function (event: any) {
        const data = (event && event.payload) || {};

        // 1. State-Setup
        currentPath = data.path || null;
        cleanText = data.text || '';
        markDirty(false);
        setStatusPath(data.path || 'Bereit', false);
        updateWordCount(data.text || '');
        applyDocKind(data.kind || 'unknown');
        invoke('workspace_add_recent', { path: data.path }).catch(function () {});

        // 2. UI-Rendering. loadEditorText kuemmert sich um den
        // ensureEditorMounted-Pfad (mount-on-demand bei erstem Edit-Switch).
        loadEditorText(data.text || '', data.language || '');
        setEditorLanguageDisplay(data.language || 'plaintext');
        setTocList(data.tocHtml || data.toc_html || '');
        const contentEl = document.getElementById('view-region');
        const body = contentEl && contentEl.querySelector('.markdown-body');
        if (body) {
            // Nur Markdown wird in der View-Region gerendert. Fuer Text/Code-
            // Dateien wuerde sonst der Roh-Inhalt durch den MD-Renderer kurz
            // aufflackern, bevor applyDocKind in den Edit-Mode wechselt.
            const isMd = data.kind === 'markdown';
            (body as HTMLElement).innerHTML = isMd ? (data.content || data.html || '') : '';
            if (isMd) rewriteRelativeAssets(body as HTMLElement, data.path || '');
        }
        setVaultActive(data.path || '');

        // 3. Such-Highlights restaurieren — gehen im View-Mode beim
        // innerHTML-Replace verloren.
        const bar = document.getElementById('find-bar');
        if (bar && bar.classList.contains('open')
            && !document.body.classList.contains('edit-mode')) {
            const input = document.getElementById('find-input') as HTMLInputElement;
            if (input && input.value) {
                setTimeout(function () { ViewFinder.setFindTerm(input.value); }, 0);
            }
        }
    });

    listen('document:dirty_changed', function (event: any) {
        const dirty = event && event.payload && (event.payload.is_dirty || event.payload.isDirty);
        markDirty(!!dirty);
    });

    // Externe Datei-Aenderung (notify-Watcher im DocumentStore). Im View-
    // Mode lautlos reloaden, im Edit-/Split-Mode nur wenn nicht dirty —
    // sonst wuerden ungespeicherte Edits durch den Reload verworfen.
    // reload_document selbst ist no-op, wenn Disk-Text == Store-Text
    // (z. B. unser eigener Save triggert den Watcher mit).
    listen('document:external_changed', function (event: any) {
        const data = (event && event.payload) || {};
        if (!currentPath) return;
        if (data.path && data.path !== currentPath) return;
        if (isDirty) {
            showStatus('Datei extern geändert (ungespeicherte Änderungen) — Reload via Save oder Verwerfen');
            return;
        }
        invoke('reload_document').catch(function () {});
    });

    // document:closed wird vom close_document-Command emittiert. Wir setzen
    // die Frontend-Sicht analog zum Boot-Zustand zurueck: kein Pfad, leerer
    // Editor, "Bereit"-Statusbar, kein Word-Count.
    listen('document:closed', function () {
        currentPath = null;
        cleanText = '';
        markDirty(false);
        if (window.FolioEditor && typeof window.FolioEditor.setText === 'function') {
            window.FolioEditor.setText('', 'plaintext');
        }
        // View-Region und TOC zuruecksetzen, sonst bleibt das zuletzt gerenderte
        // HTML stehen.
        const view = document.getElementById('view-region');
        const body = view && view.querySelector('.markdown-body');
        if (body) (body as HTMLElement).innerHTML = '';
        setTocList('');
        applyDocKind('unknown');
        setStatusPath('Bereit', false);
        updateWordCount('');
        applyWindowTitle();
    });

    listen('document:saved', function (event: any) {
        const data = (event && event.payload) || {};
        cleanText = data.text || editorText();
        markDirty(false);
        renderDocumentPayload(data);
        updateWordCount(data.text || '');
        // Statusbar zuruecksetzen, falls vorher noch ein showStatus-Hinweis
        // (z. B. "Datei extern geaendert") im status-path-Element stand.
        setStatusPath(data.path || currentPath || 'Bereit', false);
    });

    applyDocKind('unknown');
}
