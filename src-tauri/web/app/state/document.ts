/* Dokument-State + Lifecycle-Events. Kapselt:
   - currentPath / cleanText / isDirty,
   - markDirty, applyWindowTitle, setStatusPath, updateWordCount, showStatus,
   - applyDocKind (Body-Class kind-*, Toolbar-Disable, Menue-Enable/-Check),
   - openDocument (read_file -> applyDocKind -> Mode-Switch bei non-MD),
   - saveCurrent / requestSaveIfDirty / syncEditorTextToStore,
   - fusionierter document:loaded-Handler + document:dirty_changed /
     document:closed / document:saved.

   document:loaded setzt zuerst den State und rendert danach die passende
   View: Markdown-HTML, HTML-iframe oder read-only Code-View. */

import { setTocList, rewriteRelativeAssets, ViewFinder } from '../view/markdown';
import { highlightCodeBlocks } from '../view/code-highlight';
import { clearHtmlView, HtmlFinder, isHtmlDocument, mountHtmlView } from '../view/html';
import { setVaultActive } from '../vault/tree';
import { setEditorLanguageDisplay } from '../ui/language-picker';
import { syncCheatsheetMenu } from '../ui/cheatsheet';
import { showUnsavedDialog } from '../ui/dialogs';
import { isEditorMounted, loadEditorText } from '../editor/shell';
import { getCachedSettings } from '../ui/settings-dialog';
import { folioLog, safeInvoke } from '../util/log';
// getCachedSettings wird im FolioCodeView-Mount-Pfad weiter genutzt
// (autoFormat-Flag); der Default-Mode-Switch laeuft jetzt im Backend
// (document_service::open). Frontend-Resolver entfernt — sonst doppelter
// set_view_mode-Aufruf neben dem backendseitigen app:set_mode-Emit.

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
    safeInvoke('set_window_title', { title }, 'set_window_title', 'debug');
}

export function markDirty(dirty: boolean): void {
    isDirty = !!dirty;
    const el = $('status-path');
    if (el) el.classList.toggle('dirty', isDirty);
    const btn = $('tb-save') as HTMLButtonElement;
    if (btn) btn.disabled = !isDirty;
    safeInvoke('menu_set_enabled', { id: 'file.save', enabled: isDirty }, 'menu_set_enabled file.save', 'debug');
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

/// tb-reload markiert den "extern geaenderte Datei wartet auf Reload"-
/// Zustand. Wird im document:external_changed-Handler bei
/// documentAutoReload=false gesetzt und beim erfolgreichen Reload /
/// dem Doc-Wechsel zurueckgesetzt.
export function setReloadButtonPending(pending: boolean): void {
    const btn = $('tb-reload') as HTMLButtonElement | null;
    if (!btn) return;
    btn.hidden = !pending;
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
    return safeInvoke('editor_text_changed', { text: editorText() }, 'editor_text_changed', 'debug');
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
    }).catch(function (err) {
        folioLog.warn('document', 'saveCurrent failed', { error: String(err) });
        return false;
    });
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
            }).catch(function (err) {
                folioLog.warn('document', 'discard_editor_changes failed', { error: String(err) });
                return false;
            });
        }
        return invoke('editor_save_requested').then(function (saved) {
            if (saved) {
                cleanText = editorText();
                markDirty(false);
            }
            return !!saved;
        }).catch(function (err) {
            folioLog.warn('document', 'editor_save_requested failed', { error: String(err) });
            return false;
        });
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
    safeInvoke('menu_set_checked', { id: 'view.mode.view', checked: mode === 'view' }, 'menu_set_checked view.mode.view', 'debug');
    safeInvoke('menu_set_checked', { id: 'view.mode.edit', checked: mode === 'edit' }, 'menu_set_checked view.mode.edit', 'debug');
    safeInvoke('menu_set_checked', { id: 'view.mode.split', checked: mode === 'split' }, 'menu_set_checked view.mode.split', 'debug');
}

export function applyDocKind(kind: string | null): void {
    const resolved = kind || 'unknown';
    const body = document.body;
    DOC_KIND_CLASSES.forEach(function (c) { body.classList.remove(c); });
    body.classList.add('kind-' + resolved);

    const md = resolved === 'markdown';
    const hasDoc = resolved !== 'unknown' && resolved !== 'binary';
    // View-Mode ist jetzt auch fuer Text/Code-Dateien verfuegbar: dort
    // zeigt eine read-only Monaco-Instanz (FolioCodeView) den Inhalt
    // mit Syntax-Highlighting an, fuer JSON zusaetzlich pretty-geprinted.
    const hasViewMode = md || resolved === 'text';
    const btnView = $('tb-mode-view') as HTMLButtonElement;
    if (btnView) {
        btnView.disabled = !hasViewMode;
        btnView.title = hasViewMode ? 'View (Ctrl+1)' : 'Kein Dokument geladen';
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
    // Menue-Items synchron halten: View-Mode auch fuer Text/Code,
    // Save-As bei jedem geladenen, lesbaren Dokument (also nicht 'unknown').
    safeInvoke('menu_set_enabled', { id: 'view.mode.view', enabled: hasViewMode }, 'menu_set_enabled view.mode.view', 'debug');
    safeInvoke('menu_set_enabled', { id: 'view.mode.edit', enabled: hasDoc }, 'menu_set_enabled view.mode.edit', 'debug');
    safeInvoke('menu_set_enabled', { id: 'file.save_as', enabled: hasDoc }, 'menu_set_enabled file.save_as', 'debug');
    safeInvoke('menu_set_enabled', { id: 'file.rename', enabled: hasDoc }, 'menu_set_enabled file.rename', 'debug');
    safeInvoke('menu_set_enabled', { id: 'file.close', enabled: hasDoc }, 'menu_set_enabled file.close', 'debug');
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
            safeInvoke('workspace_add_recent', { path }, 'workspace_add_recent', 'debug');
            applyDocKind(data && data.kind);
            // Per-Typ-Default-Mode greift im Backend (document_service::open)
            // und emittiert dort `app:set_mode` — Frontend muss nichts tun.
            return true;
        }).catch(function (err) {
            folioLog.warn('document', 'read_file failed', { path, error: String(err) });
            showStatus(typeof err === 'string' ? err : 'Datei konnte nicht geöffnet werden');
            return false;
        });
    });
}

function renderDocumentPayload(data: any): void {
    if (!data || typeof data !== 'object') return;
    setTocList(data.tocHtml || data.toc_html || '');
    const path = data.path || currentPath || '';
    const language = data.language || (/\.html?$/i.test(path) ? 'html' : '');
    const isHtml = isHtmlDocument(data.kind || (document.body.classList.contains('kind-text') ? 'text' : ''), language, path);
    const view = document.getElementById('view-region');
    const body = view && view.querySelector('.markdown-body');
    if (body) {
        const isMd = document.body.classList.contains('kind-markdown');
        body.innerHTML = isMd ? (data.content || data.html || '') : '';
        if (isMd) {
            rewriteRelativeAssets(body as HTMLElement, path);
            highlightCodeBlocks(body as HTMLElement);
        }
    }
    document.body.classList.toggle('html-preview-mode', isHtml);
    if (isHtml) {
        mountHtmlView('html-view-frame', data.text || '', path, requestSaveIfDirty);
    } else {
        clearHtmlView();
    }
}

export function initDocumentState(d: Deps): void {
    deps = d;

    const listen = window.__TAURI__.event.listen;

    // Reihenfolge: State zuerst, dann UI-Rendering.
    listen('document:loaded', function (event: any) {
        const data = (event && event.payload) || {};

        // 1. State-Setup
        currentPath = data.path || null;
        cleanText = data.text || '';
        markDirty(false);
        setReloadButtonPending(false);
        setStatusPath(data.path || 'Bereit', false);
        updateWordCount(data.text || '');
        applyDocKind(data.kind || 'unknown');
        safeInvoke('workspace_add_recent', { path: data.path }, 'workspace_add_recent', 'debug');

        // 2. UI-Rendering. loadEditorText kuemmert sich um den
        // ensureEditorMounted-Pfad (mount-on-demand bei erstem Edit-Switch).
        loadEditorText(data.text || '', data.language || '');
        setEditorLanguageDisplay(data.language || 'plaintext');
        setTocList(data.tocHtml || data.toc_html || '');
        const isHtml = isHtmlDocument(data.kind, data.language || '', data.path || '');
        document.body.classList.toggle('html-preview-mode', isHtml);
        const contentEl = document.getElementById('view-region');
        const body = contentEl && contentEl.querySelector('.markdown-body');
        if (body) {
            // Nur Markdown wird in der View-Region gerendert. Fuer Text/Code-
            // Dateien uebernimmt FolioCodeView die Read-Only-Anzeige in
            // einer eigenen Monaco-Instanz (Container `#code-view-mount`).
            const isMd = data.kind === 'markdown';
            (body as HTMLElement).innerHTML = isMd ? (data.content || data.html || '') : '';
            if (isMd) {
                rewriteRelativeAssets(body as HTMLElement, data.path || '');
                highlightCodeBlocks(body as HTMLElement);
            }
        }
        if (isHtml) {
            if (window.FolioCodeView) window.FolioCodeView.dispose();
            mountHtmlView('html-view-frame', data.text || '', data.path || '', requestSaveIfDirty);
        } else {
            clearHtmlView();
        }
        // Code-View fuer Non-Markdown-Text-Dateien: Read-Only Monaco mit
        // Syntax-Highlighting. Mount ist idempotent — re-use der Instanz
        // beim Wechsel zwischen Dateien.
        if (window.FolioCodeView) {
            if (data.kind === 'text' && !isHtml) {
                var settings = getCachedSettings();
                var autoFormat = settings ? !!settings.viewAutoFormat : true;
                window.FolioCodeView.mount(
                    'code-view-mount',
                    data.text || '',
                    data.language || 'plaintext',
                    { autoFormat: autoFormat },
                );
            } else {
                window.FolioCodeView.dispose();
            }
        }
        setVaultActive(data.path || '');

        // 3. Such-Highlights restaurieren — gehen im View-Mode beim
        // innerHTML-Replace verloren.
        const bar = document.getElementById('find-bar');
        if (bar && bar.classList.contains('open')
            && !document.body.classList.contains('edit-mode')) {
            const input = document.getElementById('find-input') as HTMLInputElement;
            if (input && input.value) {
                setTimeout(function () {
                    if (document.body.classList.contains('html-preview-mode')) {
                        HtmlFinder.setFindTerm(input.value);
                    } else {
                        ViewFinder.setFindTerm(input.value);
                    }
                }, 0);
            }
        }
    });

    listen('document:dirty_changed', function (event: any) {
        const dirty = event && event.payload && (event.payload.is_dirty || event.payload.isDirty);
        markDirty(!!dirty);
    });

    // Externe Datei-Aenderung (notify-Watcher im DocumentStore).
    // Drei Faelle:
    // 1) dirty                              → showStatus, keine Aktion
    // 2) !dirty + documentAutoReload=true   → silent reload (alte Logik)
    // 3) !dirty + documentAutoReload=false  → tb-reload-Button anzeigen,
    //    User entscheidet selbst wann reloaded wird (z.B. Log-Datei).
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
        var settings = getCachedSettings();
        var autoReload = settings ? !!settings.documentAutoReload : true;
        if (autoReload) {
            safeInvoke('reload_document', undefined, 'reload_document', 'warn');
        } else {
            setReloadButtonPending(true);
            showStatus('Datei extern geändert — Reload-Button zum Übernehmen');
        }
    });

    // document:closed wird vom close_document-Command emittiert. Wir setzen
    // die Frontend-Sicht analog zum Boot-Zustand zurueck: kein Pfad, leerer
    // Editor, "Bereit"-Statusbar, kein Word-Count.
    listen('document:closed', function () {
        currentPath = null;
        cleanText = '';
        markDirty(false);
        setReloadButtonPending(false);
        if (window.FolioEditor && typeof window.FolioEditor.setText === 'function') {
            window.FolioEditor.setText('', 'plaintext');
        }
        // View-Region und TOC zuruecksetzen, sonst bleibt das zuletzt gerenderte
        // HTML stehen.
        const view = document.getElementById('view-region');
        const body = view && view.querySelector('.markdown-body');
        if (body) (body as HTMLElement).innerHTML = '';
        clearHtmlView();
        document.body.classList.remove('html-preview-mode');
        // Code-View ebenfalls leeren — die zweite Monaco-Instanz bleibt
        // sonst mit dem zuletzt angezeigten Inhalt sichtbar, wenn der
        // User waehrend des Close-Vorgangs im View-Mode war.
        if (window.FolioCodeView) window.FolioCodeView.dispose();
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
        setReloadButtonPending(false);
        renderDocumentPayload(data);
        updateWordCount(data.text || '');
        // Statusbar zuruecksetzen, falls vorher noch ein showStatus-Hinweis
        // (z. B. "Datei extern geaendert") im status-path-Element stand.
        setStatusPath(data.path || currentPath || 'Bereit', false);
    });

    applyDocKind('unknown');
}
