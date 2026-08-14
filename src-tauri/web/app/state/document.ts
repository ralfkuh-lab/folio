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

import { setTocList, rewriteRelativeAssets, prepareMarkdownView } from '../view/markdown';
import { highlightCodeBlocks } from '../view/code-highlight';
import { addCodeCopyButtons } from '../view/code-copy';
import { renderMermaidBlocks } from '../view/mermaid';
import { clearHtmlView, invalidateHtmlLive, isHtmlDocument, mountHtmlView } from '../view/html';
import { clearImageView, isImageDocument, mountImageView, reloadImageView } from '../view/image';
import { invalidateCodeLive } from '../view/code-live';
import { invalidatePreview } from '../view/preview';
import { clearMarkdownHeadingMap, setMarkdownHeadingMap } from '../view/scroll-sync';
import { setVaultActive } from '../vault/tree';
import { setEditorLanguageDisplay } from '../ui/language-picker';
import { syncCheatsheetMenu } from '../ui/cheatsheet';
import { afterDocumentSwitch } from '../ui/find-bar';
import { showUnsavedDialog } from '../ui/dialogs';
import { isEditorMounted, loadEditorText } from '../editor/shell';
import { getCachedSettings } from '../ui/settings-dialog';
import { folioLog, safeInvoke } from '../util/log';
// Direct modules — avoid app/i18n barrel (event-queue listen patch side-effect).
import { t, tPlural } from '../i18n/translate';
import { getActiveTabId } from './tabs';
// getCachedSettings wird im FolioCodeView-Mount-Pfad weiter genutzt
// (autoFormat-Flag); der Default-Mode-Switch laeuft jetzt im Backend
// (document_service::open). Frontend-Resolver entfernt — sonst doppelter
// set_view_mode-Aufruf neben dem backendseitigen app:set_mode-Emit.

let currentPath: string | null = null;
let cleanText = '';
let isDirty = false;
// Hoechste bereits angewandte Sequenznummer ueber ALLE document:*-Lifecycle-Events
// (loaded/closed/saved/dirty_changed). Gemeinsamer monotoner Counter im Backend.
let lastLifecycleSeq = 0;
// Tab-ID des zuletzt angewandten document:loaded. WICHTIG als primaere
// Referenz fuer die tabId-Validierung von saved/dirty_changed: das Backend
// emittiert bei Tab-Aktivierung loaded -> dirty_changed -> tabs:changed —
// getActiveTabId() (gespeist aus tabs:changed) hinkt also hinterher und
// wuerde das legitime dirty des frisch aktivierten Tabs als "fremd"
// verwerfen. loaded kommt per seq-Ordnung garantiert vor seinem dirty.
let lastLoadedTabId: number | null = null;

/** Erwartete Tab-ID fuer saved/dirty_changed-Validierung: primaer der
 *  zuletzt geladene Tab, Fallback auf die tabs:changed-Sicht. */
function expectedLifecycleTabId(): number | null {
    if (lastLoadedTabId !== null) return lastLoadedTabId;
    return getActiveTabId();
}

function invoke(cmd: string, args?: any): Promise<any> {
    return window.__TAURI__.core.invoke(cmd, args);
}

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export function getCurrentPath(): string | null { return currentPath; }
export function getCleanText(): string { return cleanText; }
export function getIsDirty(): boolean { return isDirty; }

/** Gemeinsamer Stale-Check fuer alle vier document:*-Lifecycle-Events.
 *  Reiner Vergleich OHNE Seiteneffekt — die Sequenz rueckt erst
 *  commitLifecycleSeq() vor, und zwar NUR fuer tatsaechlich angewandte
 *  Events (nach allen Validierungen). Sonst wuerde ein per tabId
 *  verworfenes Fremd-Event die Sequenz vorruecken und spaetere legitime
 *  Events mit kleinerer seq unterdruecken ("last APPLIED"-Semantik).
 *  Events ohne seq (Alt-Pfade, Tests) laufen durch. Reihenfolge-Semantik:
 *  dirty_changed ist hochfrequent — ein loaded mit kleinerer seq NACH einem
 *  angewandten dirty wird korrekt verworfen (fruehere Lifecycle-Phase).
 */
function isStaleLifecycleEvent(data: any): boolean {
    if (typeof data.seq !== 'number') return false;
    if (data.seq <= lastLifecycleSeq) {
        folioLog.debug('document', 'stale lifecycle event verworfen', {
            seq: data.seq,
            lastApplied: lastLifecycleSeq,
            path: data.path || '',
            tabId: data.tabId,
        });
        return true;
    }
    return false;
}

/** Rueckt die Lifecycle-Sequenz vor — aufrufen NACHDEM ein Event alle
 *  Validierungen passiert hat und angewandt wird. */
function commitLifecycleSeq(data: any): void {
    if (typeof data.seq === 'number' && data.seq > lastLifecycleSeq) {
        lastLifecycleSeq = data.seq;
    }
}

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
    el.textContent = path || t('statusBar.ready');
    el.classList.toggle('dirty', !!dirty);
}

// Zuletzt gerenderte Dokument-Stats — bei Selektion werden Selektions-
// Stats angezeigt; bei leerer Selektion (oder Doc-Wechsel) restauriert.
let lastDocWordCountText = '';
let lastDocWordCountHidden = true;
// Aktuelles EOL-Label des geladenen Docs (`lf` | `crlf` | null).
let currentEol: string | null = null;
// Referenz-EOL von Load/Save (analog cleanText). Backend-EOL-Dirty
// darf durch refreshDirtyFromEditor nicht still verworfen werden.
let cleanEol: string | null = null;

export function updateWordCount(text: string): void {
    const el = $('status-wordcount');
    if (!el) return;
    if (!text) {
        el.hidden = true;
        el.textContent = '';
        lastDocWordCountText = '';
        lastDocWordCountHidden = true;
        return;
    }
    const chars = text.length;
    const words = (text.match(/\S+/g) || []).length;
    const lines = text.split(/\r\n|\r|\n/).length;
    const rendered = t('statusBar.wordCount.template', {
        wordsPart: tPlural('statusBar.wordCount.wordsPart', words),
        charsPart: tPlural('statusBar.wordCount.charsPart', chars),
        linesPart: tPlural('statusBar.wordCount.linesPart', lines),
    });
    lastDocWordCountText = rendered;
    lastDocWordCountHidden = false;
    el.hidden = false;
    el.textContent = rendered;
}

/** Zeigt Selektions-Stats in `#status-wordcount` (selChars > 0). */
export function updateSelectionWordCount(selChars: number, selWords: number): void {
    const el = $('status-wordcount');
    if (!el) return;
    if (selChars <= 0) {
        el.hidden = lastDocWordCountHidden;
        el.textContent = lastDocWordCountText;
        return;
    }
    el.hidden = false;
    el.textContent = t('statusBar.wordCount.selectionTemplate', {
        wordsPart: tPlural('statusBar.wordCount.wordsPart', selWords),
        charsPart: tPlural('statusBar.wordCount.charsPart', selChars),
    });
}

/** Cursor-Zelle (Ln/Sp). Hidden bis zum ersten Selection-Event nach Load. */
export function updateCursorStatus(line: number, column: number): void {
    const el = $('status-cursor');
    if (!el) return;
    el.hidden = false;
    el.textContent = t('statusBar.cursor.template', {
        line: String(line),
        column: String(column),
    });
}

export function hideCursorStatus(): void {
    const el = $('status-cursor');
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
}

/** Technisches Label fuer ein Encoding-Payload-Feld. `null` = keine Zelle
 *  (reines UTF-8 ohne BOM ist der Normalfall). Werte NICHT uebersetzen. */
function encodingLabel(encoding: string | null | undefined): string | null {
    switch (encoding) {
        case 'utf8-bom': return 'UTF-8 BOM';
        case 'utf16le': return 'UTF-16 LE';
        case 'utf16be': return 'UTF-16 BE';
        case 'windows1252': return 'Windows-1252';
        default: return null; // 'utf8' / undefined -> versteckt
    }
}

/** Leitet den aktuell geladenen Dokumenttyp aus der `body.kind-*`-Klasse
 *  ab (Single Source of Truth, gesetzt von `applyDocKind`). Fuer den
 *  `document:encoding_changed`-Pfad, der keinen kind im Payload traegt. */
function currentDocKindFromBody(): string | null {
    const cl = document.body.classList;
    if (cl.contains('kind-markdown')) return 'markdown';
    if (cl.contains('kind-text')) return 'text';
    if (cl.contains('kind-image')) return 'image';
    if (cl.contains('kind-binary')) return 'binary';
    return null;
}

/** Encoding-Zelle in der Statusleiste. Bewusst NUR sichtbar, wenn das
 *  Encoding NICHT reines UTF-8 ohne BOM ist UND ein Text-/Markdown-Dokument
 *  geladen ist. Begruendung: UTF-8 ist der Normalfall — eine immer sichtbare
 *  Zelle wuerde saemtliche E2E-Visual-Baselines verschieben. */
export function updateEncoding(
    encoding: string | null | undefined,
    kind: string | null | undefined,
): void {
    const el = $('status-encoding');
    if (!el) return;
    const label = encodingLabel(encoding);
    const isTextual = kind === 'markdown' || kind === 'text';
    if (!label || !isTextual) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.textContent = label;
}

/** EOL-Zelle (`LF`/`CRLF`, technische Labels). Sichtbar fuer markdown/text. */
export function updateLineEnding(
    eol: string | null | undefined,
    kind: string | null | undefined,
): void {
    const el = $('status-eol') as HTMLButtonElement | null;
    if (!el) return;
    const isTextual = kind === 'markdown' || kind === 'text';
    const display = eol === 'lf' ? 'LF' : eol === 'crlf' ? 'CRLF' : null;
    if (!display || !isTextual) {
        el.hidden = true;
        el.textContent = '';
        currentEol = null;
        return;
    }
    el.hidden = false;
    el.textContent = display;
    currentEol = eol === 'lf' || eol === 'crlf' ? eol : null;
}

function toggleLineEnding(): void {
    if (!currentEol) return;
    const next = currentEol === 'lf' ? 'crlf' : 'lf';
    safeInvoke('set_line_ending', { eol: next }, 'set_line_ending', 'warn');
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
    // Text- ODER EOL-Abweichung — analog Backend is_content_dirty.
    const dirty = !!currentPath && (
        editorText() !== cleanText
        || currentEol !== cleanEol
    );
    markDirty(dirty);
    return dirty;
}

export function syncEditorTextToStore(): Promise<unknown> {
    if (!currentPath) return Promise.resolve();
    return safeInvoke('editor_text_changed', { text: editorText() }, 'editor_text_changed', 'debug');
}

/** Variante für Abläufe, die ohne erfolgreichen Sync nicht fortfahren dürfen. */
export function syncEditorTextToStoreRequired(): Promise<unknown> {
    if (!currentPath) return Promise.resolve();
    return invoke('editor_text_changed', { text: editorText() });
}

/** Aktueller Editor-Stand (bzw. cleanText, solange kein Editor gemountet ist). */
export function getEditorText(): string {
    return editorText();
}

/**
 * Tab-gebundener Sync für KI-Aktionen (Spec docs/spec-ki-actions.md):
 * schreibt den EINGEFRORENEN Snapshot gezielt in den Quell-Tab statt in
 * den gerade aktiven — das Backend lehnt ab, wenn der Tab nicht mehr
 * existiert oder das Dokument Lone-CR-Zeilenenden hat.
 */
export function syncEditorTextToStoreForTab(tabId: number, text: string): Promise<unknown> {
    return invoke('editor_text_changed', { text, tabId });
}

/** Macht eine Save-Fehlermeldung in der Statusleiste sichtbar. Die
 *  Backend-Commands liefern bereits die lokalisierte Meldung als
 *  Rejection-String (z. B. `errors.file.encodingUnmappable`, wenn eine
 *  Windows-1252-Datei ein Emoji enthaelt); Nicht-String-Fehler bekommen den
 *  generischen `saveFailed`-Rahmen. Ohne das blieb der handlungsrelevante
 *  Fehler frueher nur im Log. */
function showSaveError(err: unknown): void {
    showStatus(typeof err === 'string'
        ? err
        : t('errors.file.saveFailed', { detail: String(err) }));
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
        showSaveError(err);
        return false;
    });
}

export function requestSaveIfDirty(forceDirty = false): Promise<boolean> {
    const dirty = refreshDirtyFromEditor();
    if (!forceDirty && !dirty && !isDirty) return Promise.resolve(true);
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
            showSaveError(err);
            return false;
        });
    });
}

const DOC_KIND_CLASSES = ['kind-markdown', 'kind-text', 'kind-image', 'kind-binary', 'kind-unknown'];

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

export function applyDocKind(kind: string | null, path?: string | null): void {
    const resolved = kind || 'unknown';
    const body = document.body;
    DOC_KIND_CLASSES.forEach(function (c) { body.classList.remove(c); });
    body.classList.add('kind-' + resolved);

    const md = resolved === 'markdown';
    const isImage = resolved === 'image';
    const hasDoc = resolved !== 'unknown' && resolved !== 'binary';
    // View-Mode: Markdown (HTML-Render), Text (read-only Monaco) und
    // Image (`<img>`-Preview). Edit-Mode dagegen nur fuer Markdown/Text
    // — Bilder sind heute nicht editierbar (`document_store.load_opaque`
    // legt keinen Text ab; ein Edit-Switch waere ein "leerer Editor").
    const hasViewMode = md || resolved === 'text' || isImage;
    const canEdit = md || resolved === 'text';
    const noneLoaded = t('errors.document.noneLoaded');
    const imageReadOnly = t('errors.document.imageReadOnly');
    const btnView = $('tb-mode-view') as HTMLButtonElement;
    if (btnView) {
        btnView.disabled = !hasViewMode;
        btnView.title = hasViewMode ? t('toolbar.modeView.tooltip') : noneLoaded;
    }
    const btnEdit = $('tb-mode-edit') as HTMLButtonElement;
    if (btnEdit) {
        btnEdit.disabled = !canEdit;
        btnEdit.title = canEdit
            ? t('toolbar.modeEdit.tooltip')
            : (isImage ? imageReadOnly : noneLoaded);
    }
    // Split braucht eine editierbare Datei (Editor-Seite) + eine
    // anzeigbare Seite — also dieselbe Bedingung wie Edit. Bilder sind
    // bewusst aussen vor.
    const btnSplit = $('tb-mode-split') as HTMLButtonElement;
    if (btnSplit) {
        btnSplit.disabled = !canEdit;
        btnSplit.title = canEdit
            ? t('toolbar.modeSplit.tooltip')
            : (isImage ? imageReadOnly : noneLoaded);
    }
    const btnExport = $('tb-export') as HTMLButtonElement;
    if (btnExport) {
        btnExport.disabled = !md;
        btnExport.title = md ? t('toolbar.export.tooltip') : t('statusBar.exportMarkdownOnly');
    }
    // Menue-Items synchron halten: View-Mode auch fuer Text/Code/Image,
    // Edit-Mode nur fuer editierbare Kinds, Save-As/Rename/Close fuer
    // alle geladenen Dokumente (Rename + Close arbeiten auf FS-Ebene,
    // sind also auch fuer Bilder sinnvoll).
    safeInvoke('menu_set_enabled', { id: 'view.mode.view', enabled: hasViewMode }, 'menu_set_enabled view.mode.view', 'debug');
    safeInvoke('menu_set_enabled', { id: 'view.mode.edit', enabled: canEdit }, 'menu_set_enabled view.mode.edit', 'debug');
    safeInvoke('menu_set_enabled', { id: 'view.mode.split', enabled: canEdit }, 'menu_set_enabled view.mode.split', 'debug');
    safeInvoke('menu_set_enabled', { id: 'file.save_as', enabled: canEdit }, 'menu_set_enabled file.save_as', 'debug');
    safeInvoke('menu_set_enabled', { id: 'file.rename', enabled: hasDoc }, 'menu_set_enabled file.rename', 'debug');
    safeInvoke('menu_set_enabled', { id: 'file.export', enabled: md }, 'menu_set_enabled file.export', 'debug');
    safeInvoke('menu_set_enabled', { id: 'file.close', enabled: hasDoc }, 'menu_set_enabled file.close', 'debug');
    syncCheatsheetMenu();
    // Haekchen nach dem Enable-Wechsel erneut anwenden — Tauri scheint
    // set_checked auf disabled Items zu verwerfen, sodass beim ersten
    // Doc-Laden der View/Edit-Mode-Haken sonst leer bleibt, bis der
    // User selbst umschaltet.
    syncViewModeMenuChecks();

    // Konsumenten (KI-Button-Gating etc.) brauchen einen deterministischen
    // Zeitpunkt NACH dem Klassen-Setzen; eigene document:loaded-Listener
    // wären eine Registrierungs-Reihenfolge-Race und hätten keinen seq-Stale-Guard.
    // path additiv: explizit (openDocument, bevor currentPath steht)
    // oder der aktuelle Stand (document:loaded setzt den Pfad vorher).
    const eventPath = path !== undefined ? path : getCurrentPath();
    window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
        detail: { kind: resolved, path: eventPath },
    }));
}

export function openDocument(path: string): Promise<boolean> {
    return requestSaveIfDirty().then(function (ok) {
        if (!ok) return false;
        return invoke('read_file', { path }).then(function (data) {
            safeInvoke('workspace_add_recent', { path }, 'workspace_add_recent', 'debug');
            applyDocKind(data && data.kind, path);
            // Per-Typ-Default-Mode greift im Backend (document_service::open)
            // und emittiert dort `app:set_mode` — Frontend muss nichts tun.
            return true;
        }).catch(function (err) {
            folioLog.warn('document', 'read_file failed', { path, error: String(err) });
            showStatus(typeof err === 'string' ? err : t('errors.file.openFailed'));
            return false;
        });
    });
}

function renderDocumentPayload(data: any): void {
    if (!data || typeof data !== 'object') return;
    setTocList(data.tocHtml || data.toc_html || '');
    setMarkdownHeadingMap(data.headingMap || data.heading_map || []);
    const path = data.path || currentPath || '';
    // language/kind kommen seit dem saved-Payload-Ausbau direkt vom
    // Backend; Endungs-Test und body-Klasse sind bewusste Backstops fuer
    // Payloads ohne die Felder (Source of Truth bleibt kind/language).
    const language = data.language || (/\.html?$/i.test(path) ? 'html' : '');
    const kind = data.kind || (document.body.classList.contains('kind-text') ? 'text' : '');
    const isHtml = isHtmlDocument(kind, language, path);
    const view = document.getElementById('view-region');
    const body = view && view.querySelector('.markdown-body');
    if (body) {
        const isMd = document.body.classList.contains('kind-markdown');
        body.innerHTML = isMd ? (data.content || data.html || '') : '';
        if (isMd) {
            rewriteRelativeAssets(body as HTMLElement, path);
            highlightCodeBlocks(body as HTMLElement);
            addCodeCopyButtons(body as HTMLElement);
            renderMermaidBlocks(body as HTMLElement);
            prepareMarkdownView(body as HTMLElement);
        }
    }
    document.body.classList.toggle('html-preview-mode', isHtml);
    if (isHtml) {
        mountHtmlView('html-view-frame', data.text || '', path, requestSaveIfDirty);
    } else {
        clearHtmlView();
    }
    // Code-View mit dem kanonischen Save-Text aktualisieren — vorher
    // zeigte die Read-Only-Instanz nach einem Save im Edit-Mode den
    // Stand vom letzten document:loaded.
    if (window.FolioCodeView && kind === 'text' && !isHtml) {
        const settings = getCachedSettings();
        const autoFormat = settings ? !!settings.viewAutoFormat : true;
        window.FolioCodeView.mount(
            'code-view-mount',
            data.text || '',
            language || 'plaintext',
            { autoFormat: autoFormat },
        );
    }
    if (!document.body.classList.contains('kind-markdown')) {
        clearMarkdownHeadingMap();
    }
}

export function initDocumentState(): void {
    const listen = window.__TAURI__.event.listen;

    // EOL-Toggle-Button (LF ↔ CRLF).
    const eolBtn = $('status-eol');
    if (eolBtn) {
        eolBtn.addEventListener('click', function (e: Event) {
            e.stopPropagation();
            toggleLineEnding();
        });
    }

    // Cursor/Selektion aus dem Editor-Bundle (RAF-debounced CustomEvent).
    window.addEventListener('folio-editor-selection', function (event: Event) {
        const detail = (event as CustomEvent).detail || {};
        if (typeof detail.line === 'number' && typeof detail.column === 'number') {
            updateCursorStatus(detail.line, detail.column);
        }
        if (typeof detail.selChars === 'number') {
            updateSelectionWordCount(detail.selChars, detail.selWords || 0);
        }
    });

    // Reihenfolge: State zuerst, dann UI-Rendering.
    listen('document:loaded', function (event: any) {
        const data = (event && event.payload) || {};

        if (isStaleLifecycleEvent(data)) return;
        commitLifecycleSeq(data);

        // Pending Live-Preview-Renders verwerfen — sonst koennte eine
        // verspaetete Antwort aus dem alten Dirty-Text den frischen
        // kanonischen Render aus dem document:loaded ueberschreiben.
        invalidatePreview({ resetDebounce: true });
        invalidateHtmlLive();
        invalidateCodeLive();

        // 1. State-Setup
        currentPath = data.path || null;
        // Editor-Bundle liest das für `[[#`-Heading-Complete (W4).
        try { (window as any).__folioCurrentPath = currentPath; } catch { /* ignore */ }
        cleanText = data.text || '';
        lastLoadedTabId = typeof data.tabId === 'number' ? data.tabId : null;
        markDirty(false);
        setReloadButtonPending(false);
        setStatusPath(data.path || t('statusBar.ready'), false);
        updateWordCount(data.text || '');
        updateEncoding(data.encoding, data.kind);
        // lineEnding (camelCase aus Backend) — Alt-Payloads ohne Feld → hidden.
        updateLineEnding(data.lineEnding || data.line_ending, data.kind);
        // Referenz-EOL nach Load = aktuelle Anzeige (clean).
        cleanEol = currentEol;
        hideCursorStatus();
        applyDocKind(data.kind || 'unknown');
        safeInvoke('workspace_add_recent', { path: data.path }, 'workspace_add_recent', 'debug');

        // 2. UI-Rendering. loadEditorText kuemmert sich um den
        // ensureEditorMounted-Pfad (mount-on-demand bei erstem Edit-Switch).
        loadEditorText(
            data.text || '',
            data.language || '',
            typeof data.tabId === 'number' ? data.tabId : undefined,
            data.path || '',
        );
        setEditorLanguageDisplay(data.language || 'plaintext');
        setTocList(data.tocHtml || data.toc_html || '');
        setMarkdownHeadingMap(data.headingMap || data.heading_map || []);
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
                addCodeCopyButtons(body as HTMLElement);
                renderMermaidBlocks(body as HTMLElement);
                prepareMarkdownView(body as HTMLElement);
            }
        }
        if (isHtml) {
            if (window.FolioCodeView) window.FolioCodeView.dispose();
            mountHtmlView('html-view-frame', data.text || '', data.path || '', requestSaveIfDirty);
        } else {
            clearHtmlView();
        }
        if (data.kind !== 'markdown') {
            clearMarkdownHeadingMap();
        }
        // Code-View fuer Non-Markdown-Text-Dateien: Read-Only Monaco mit
        // Syntax-Highlighting. Mount ist idempotent — re-use der Instanz
        // beim Wechsel zwischen Dateien.
        const isImage = isImageDocument(data.kind);
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
        // Image-View: nur sichtbar wenn kind=image. Bei Wechsel auf ein
        // anderes Kind wird der Container geleert, damit das vorherige
        // Bild nicht durchscheint.
        if (isImage) {
            mountImageView(data.path || '');
        } else {
            clearImageView();
        }
        setVaultActive(data.path || '');

        // 3. Such-Highlights/Counter auf das neue Dokument umhaengen.
        afterDocumentSwitch();
    });

    listen('document:dirty_changed', function (event: any) {
        const data = (event && event.payload) || {};
        if (isStaleLifecycleEvent(data)) return;
        // tabId-Validierung: nur fuer saved/dirty_changed; loaded/closed
        // duerfen nicht gefiltert werden (loaded wechselt aktiv, closed
        // raeumt). Referenz ist expectedLifecycleTabId() — NICHT direkt
        // getActiveTabId(), siehe Kommentar an lastLoadedTabId.
        if (typeof data.tabId === 'number') {
            const expected = expectedLifecycleTabId();
            if (expected !== null && data.tabId !== expected) {
                folioLog.debug('document', 'document:dirty_changed von fremdem Tab verworfen', {
                    tabId: data.tabId,
                    expected,
                });
                return;
            }
        }
        commitLifecycleSeq(data);
        const dirty = data.is_dirty || data.isDirty;
        markDirty(!!dirty);
        // Backend clean → EOL-Referenz = aktuelle Anzeige (Format-only-Reload
        // feuert eol_changed VOR dirty_changed, currentEol ist bereits neu).
        if (!dirty) {
            cleanEol = currentEol;
        }
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
        // Image-Branch VOR dem Text-Reload-Pfad: fuer Bilder den
        // reload_document-Command niemals aufrufen (der wuerde Binary
        // als Text lesen). Nutze vorhandenen kind-Mechanismus
        // (body.kind-image via applyDocKind), keine neue Heuristik.
        if (document.body.classList.contains('kind-image')) {
            reloadImageView();
            return;
        }
        if (isDirty) {
            showStatus(t('statusBar.externalChangedDirty'));
            return;
        }
        var settings = getCachedSettings();
        var autoReload = settings ? !!settings.documentAutoReload : true;
        if (autoReload) {
            safeInvoke('reload_document', undefined, 'reload_document', 'warn');
        } else {
            setReloadButtonPending(true);
            showStatus(t('statusBar.externalChangedClean'));
        }
    });

    // document:closed wird vom close_document-Command emittiert. Wir setzen
    // die Frontend-Sicht analog zum Boot-Zustand zurueck: kein Pfad, leerer
    // Editor, "Bereit"-Statusbar, kein Word-Count.
    listen('document:closed', function (event: any) {
        const data = (event && event.payload) || {};
        if (isStaleLifecycleEvent(data)) return;
        commitLifecycleSeq(data);
        invalidatePreview({ resetDebounce: true });
        invalidateHtmlLive();
        invalidateCodeLive();
        currentPath = null;
        try { (window as any).__folioCurrentPath = null; } catch { /* ignore */ }
        cleanText = '';
        cleanEol = null;
        lastLoadedTabId = null;
        markDirty(false);
        setReloadButtonPending(false);
        if (window.FolioEditor && typeof window.FolioEditor.closeDocument === 'function'
            && typeof data.tabId === 'number') {
            window.FolioEditor.closeDocument(data.tabId);
        } else if (window.FolioEditor && typeof window.FolioEditor.setText === 'function') {
            window.FolioEditor.setText('', 'plaintext');
        }
        // View-Region und TOC zuruecksetzen, sonst bleibt das zuletzt gerenderte
        // HTML stehen.
        const view = document.getElementById('view-region');
        const body = view && view.querySelector('.markdown-body');
        if (body) (body as HTMLElement).innerHTML = '';
        clearHtmlView();
        clearImageView();
        clearMarkdownHeadingMap();
        document.body.classList.remove('html-preview-mode');
        // Code-View ebenfalls leeren — die zweite Monaco-Instanz bleibt
        // sonst mit dem zuletzt angezeigten Inhalt sichtbar, wenn der
        // User waehrend des Close-Vorgangs im View-Mode war.
        if (window.FolioCodeView) window.FolioCodeView.dispose();
        setTocList('');
        applyDocKind('unknown');
        setStatusPath(t('statusBar.ready'), false);
        updateWordCount('');
        updateEncoding(null, null);
        updateLineEnding(null, null);
        hideCursorStatus();
        applyWindowTitle();
    });

    listen('document:saved', function (event: any) {
        const data = (event && event.payload) || {};
        if (isStaleLifecycleEvent(data)) return;
        // tabId-Validierung nur fuer saved (und dirty) — Referenz wie dort
        // expectedLifecycleTabId(), nicht die nachlaufende tabs:changed-Sicht.
        if (typeof data.tabId === 'number') {
            const expected = expectedLifecycleTabId();
            if (expected !== null && data.tabId !== expected) {
                folioLog.debug('document', 'document:saved von fremdem Tab verworfen', {
                    tabId: data.tabId,
                    expected,
                });
                return;
            }
        }
        commitLifecycleSeq(data);
        // Kanonischer Render kommt im Payload — pending Preview-Renders aus
        // dem Pre-Save-Dirty-Text duerfen den nicht ueberschreiben.
        invalidatePreview();
        invalidateHtmlLive();
        invalidateCodeLive();
        cleanText = data.text || editorText();
        // Save schreibt mit currentEol → Referenz = aktuelle Anzeige.
        cleanEol = currentEol;
        markDirty(false);
        setReloadButtonPending(false);
        renderDocumentPayload(data);
        updateWordCount(data.text || '');
        // Statusbar zuruecksetzen, falls vorher noch ein showStatus-Hinweis
        // (z. B. "Datei extern geaendert") im status-path-Element stand.
        setStatusPath(data.path || currentPath || t('statusBar.ready'), false);
    });

    // Metadaten-only-Reload (externes Tool aendert nur BOM/Encoding bei
    // identischem Text): kein document:loaded, nur die Encoding-Zelle
    // nachziehen. tabId-Validierung wie saved/dirty_changed; der kind
    // stammt aus der body.kind-*-Klasse (Payload traegt keinen).
    listen('document:encoding_changed', function (event: any) {
        const data = (event && event.payload) || {};
        if (typeof data.tabId === 'number') {
            const expected = expectedLifecycleTabId();
            if (expected !== null && data.tabId !== expected) return;
        }
        updateEncoding(data.encoding, currentDocKindFromBody());
    });

    // EOL-Umschalter (set_line_ending): Zelle nachziehen. tabId-Guard
    // wie saved/dirty_changed/encoding_changed.
    listen('document:eol_changed', function (event: any) {
        const data = (event && event.payload) || {};
        if (typeof data.tabId === 'number') {
            const expected = expectedLifecycleTabId();
            if (expected !== null && data.tabId !== expected) return;
        }
        updateLineEnding(data.eol, currentDocKindFromBody());
    });

    // Fire-and-forget-Save-Fehler aus dem Monaco-Strg+S-Pfad
    // (editorSaveRequested, kein invoke-Rueckkanal): lokalisierte Meldung
    // sichtbar machen — z. B. Windows-1252-Datei mit unmappbarem Zeichen.
    listen('document:save_error', function (event: any) {
        const data = (event && event.payload) || {};
        if (data && typeof data.message === 'string' && data.message) {
            showStatus(data.message);
        }
    });

    applyDocKind('unknown');
}
