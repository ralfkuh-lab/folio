/* Editor-Shell: Bridge zu window.FolioEditor + Mode-Verwaltung
   (View/Edit/Split) + Theme-Anwendung im Editor + zugehoerige
   Lifecycle-Listener (app:set_mode fusioniert, app:set_theme,
   editor:load_text, editor:apply_replace, editor:open_find,
   editor:set_find_term).

   Listener-Fusion: app:set_mode hatte zwei
   komplementaere Haelften — IIFE #1 (CSS-Mode-Toggle, focusEditor,
   Cheatsheet-/Menue-Sync, Undo/Redo-Enable) und IIFE #2 (setActiveMode
   + findBarAfterModeSwitch). Beide jetzt in einem Listener. */

import { ackHandler } from '../automation/events';
import { cheatsheetSyncMode, syncCheatsheetMenu } from '../ui/cheatsheet';
import { afterModeSwitch as findBarAfterModeSwitch, openEditorFind, setEditorFindTerm } from '../ui/find-bar';
import { highlightCodeBlocks } from '../view/code-highlight';
import { folioLog, safeInvoke } from '../util/log';

type Deps = {
    getCleanText: () => string;
    requestSaveIfDirty: () => Promise<boolean>;
};

let deps: Deps = null;
let editorMounted = false;

function invoke(cmd: string, args?: any): Promise<any> {
    return window.__TAURI__.core.invoke(cmd, args);
}

function $(id: string): HTMLElement | null { return document.getElementById(id); }

// ----- Editor-API (Monaco Editor via FolioEditor-Bundle) -----

export function isEditorMounted(): boolean { return editorMounted; }

export function ensureEditorMounted(initial?: string): Promise<boolean> {
    if (editorMounted) return Promise.resolve(true);
    if (!window.FolioEditor || typeof window.FolioEditor.mount !== 'function') {
        // eslint-disable-next-line no-console
        console.error('[folio] FolioEditor bundle not available');
        return Promise.resolve(false);
    }
    return window.FolioEditor.mount('editor-mount', initial || '').then(function () {
        editorMounted = true;
        return true;
    }).catch(function (err) {
        // eslint-disable-next-line no-console
        console.error('[folio] Editor mount failed:', err);
        folioLog.error('editor', 'Monaco mount failed', { error: String(err) });
        return false;
    });
}

export function loadEditorText(text: string, language?: string): void {
    ensureEditorMounted(text || '').then(function (ok) {
        if (!ok) return;
        window.FolioEditor.setText(text || '', language || 'plaintext');
        if (document.body.classList.contains('edit-mode')) {
            layoutEditor();
        }
    });
}

export function focusEditor(): void {
    const initial = deps && deps.getCleanText ? deps.getCleanText() : '';
    ensureEditorMounted(initial).then(function (ok) {
        if (!ok) return;
        layoutEditor();
        window.FolioEditor.focus();
    });
}

export function layoutEditor(): void {
    if (!window.FolioEditor || !editorMounted || typeof window.FolioEditor.layout !== 'function') return;
    requestAnimationFrame(function () {
        window.FolioEditor.layout();
        requestAnimationFrame(function () { window.FolioEditor.layout(); });
    });
}

export function setEditorTheme(mode: string): void {
    if (window.FolioEditor) window.FolioEditor.setTheme(mode);
    // Code-View teilt sich Monacos globalen Theme-State; setTheme dort
    // anwenden, falls die Instanz schon gemounted ist (oder ein
    // pendingTheme merken, falls noch nicht).
    if (window.FolioCodeView) {
        const normalized = mode === 'dark' ? 'dark' : 'light';
        window.FolioCodeView.setTheme(normalized);
    }
}

export function requestEditorSelection(): { start: number; length: number } | null {
    if (!window.FolioEditor) return null;
    return window.FolioEditor.getSelection();
}

export function applyEditorReplace(fullText: string, selectionStart: number, selectionLength: number): void {
    if (!window.FolioEditor) return;
    window.FolioEditor.applyReplace({
        fullText: fullText || '',
        selectionStart: selectionStart || 0,
        selectionLength: selectionLength || 0,
    });
}

// ----- Mode-Verwaltung -----

export function setEditMode(on: boolean): void {
    document.body.classList.toggle('edit-mode', !!on);
    if (on) layoutEditor();
}

// Spiegelt den View/Edit/Split-State in die Toolbar + Menue-Haekchen.
export function setActiveMode(mode: string): void {
    $('tb-mode-view')?.classList.toggle('active', mode === 'view');
    $('tb-mode-edit')?.classList.toggle('active', mode === 'edit');
    $('tb-mode-split')?.classList.toggle('active', mode === 'split');
    const sm = $('status-mode');
    if (sm) sm.textContent = mode === 'edit' ? 'Edit' : mode === 'split' ? 'Split' : 'View';
    // Cheatsheet ist eine Edit-Hilfe — auch im Split-Mode (Editor ist
    // sichtbar + bearbeitbar) sinnvoll.
    cheatsheetSyncMode(mode === 'edit' || mode === 'split');
    // View-Mode-Haekchen im Menue synchron halten (alle Pfade laufen hier
    // durch: setMode(), applyShellState, navigation:changed).
    safeInvoke('menu_set_checked', { id: 'view.mode.view', checked: mode === 'view' }, 'menu_set_checked view.mode.view', 'debug');
    safeInvoke('menu_set_checked', { id: 'view.mode.edit', checked: mode === 'edit' }, 'menu_set_checked view.mode.edit', 'debug');
    safeInvoke('menu_set_checked', { id: 'view.mode.split', checked: mode === 'split' }, 'menu_set_checked view.mode.split', 'debug');
}

export function setMode(mode: string): Promise<boolean> {
    return deps.requestSaveIfDirty().then(function (ok) {
        if (!ok) return false;
        return invoke('set_view_mode', { mode }).then(function () {
            setActiveMode(mode);
            return true;
        });
    });
}

export function initEditorShell(d: Deps): void {
    deps = d;

    const listen = window.__TAURI__.event.listen;

    // ----- shell:command (PostWebMessage von der Tauri-Core-Bridge) -----
    listen('shell:command', function (event: any) {
        const data = event && event.payload;
        if (!data || typeof data !== 'object') return;
        switch (data.type) {
            case 'loadEditorText':
                loadEditorText(data.text || '');
                break;
            case 'applyEditorReplace':
                applyEditorReplace(
                    data.fullText || '',
                    data.selectionStart || 0,
                    data.selectionLength || 0,
                );
                break;
            default:
                /* andere shell:command-Payloads (insertVaultChildren etc.) werden
                   in den jeweiligen Modulen behandelt. */
                break;
        }
    });

    // ----- Editor-spezifische Events -----
    listen('editor:load_text', function (event: any) {
        const data = event && event.payload || {};
        loadEditorText(data.text || '', data.language || '');
    });
    listen('editor:apply_replace', function (event: any) {
        const data = event && event.payload || {};
        applyEditorReplace(data.fullText || '', data.start || 0, data.length || 0);
    });
    listen('editor:open_find', function () {
        openEditorFind('');
    });
    listen('editor:set_find_term', function (event: any) {
        const data = event && event.payload || {};
        setEditorFindTerm(data.term || '');
    });

    // ----- Listener-Fusion -----
    // Vorher IIFE #1: CSS-Mode-Toggle, focusEditor, Cheatsheet-/Menue-Sync,
    // Undo/Redo-Enable.
    // Vorher IIFE #2: setActiveMode + findBarAfterModeSwitch.
    listen('app:set_mode', function (event: any) {
        const data = (event && event.payload) || {};
        const mode = data.mode || 'view';

        // ackHandler ist No-Op fuer Toolbar/Menue-Pfade ohne requestId;
        // bei POST /mode bestaetigt er nach Render-Kaskade (Microtask + rAF).
        ackHandler(invoke, data, function () {
            // 1. DOM-Class-Toggle (war IIFE #1)
            document.body.classList.toggle('edit-mode', mode === 'edit');
            document.body.classList.toggle('split-mode', mode === 'split');

            // 2. Toolbar/Statusbar + Menue-Haekchen (war IIFE #2)
            setActiveMode(mode);

            // 3. Editor-Fokus + Cheatsheet-Mode (war IIFE #1). Im Split-Mode
            // ist der Editor ebenfalls aktiv und sollte den Fokus bekommen,
            // damit Tippen sofort funktioniert.
            const editorActive = mode === 'edit' || mode === 'split';
            if (editorActive) focusEditor();
            syncCheatsheetMenu();

            // 4. Undo/Redo nur sinnvoll, wenn der Editor sichtbar ist (war IIFE #1).
            safeInvoke('menu_set_enabled', { id: 'edit.undo', enabled: editorActive }, 'menu_set_enabled edit.undo', 'debug');
            safeInvoke('menu_set_enabled', { id: 'edit.redo', enabled: editorActive }, 'menu_set_enabled edit.redo', 'debug');

            // 5. Find-Bar re-attach an den jetzt aktiven Finder (war IIFE #2).
            findBarAfterModeSwitch();
        });
    });

    // ----- app:set_theme (Theme-Switch) -----
    listen('app:set_theme', function (event: any) {
        const data = event && event.payload;
        let mode = (data && data.mode) || 'light';
        const html = document.documentElement;
        if (mode === 'toggle') {
            mode = html.classList.contains('theme-dark') ? 'light' : 'dark';
        }
        html.classList.toggle('theme-dark', mode === 'dark');
        html.classList.toggle('theme-light', mode === 'light');
        setEditorTheme(mode);
        // Code-Bloecke in der Markdown-Preview re-highlighten — colorize()
        // nutzt das aktive Monaco-Theme, also muessen wir nach dem Switch
        // einmal komplett durch (data-folio-source bewahrt den Plaintext).
        const mdBody = document.querySelector('#view-region .markdown-body');
        if (mdBody) highlightCodeBlocks(mdBody as HTMLElement);
        // Theme-Submenue-Haekchen synchron halten — egal ueber welchen Pfad
        // der Wechsel kam (Menue, Statusbar-Button, Init).
        safeInvoke('menu_set_checked', { id: 'view.theme.light', checked: mode === 'light' }, 'menu_set_checked view.theme.light', 'debug');
        safeInvoke('menu_set_checked', { id: 'view.theme.dark', checked: mode === 'dark' }, 'menu_set_checked view.theme.dark', 'debug');
    });
}
