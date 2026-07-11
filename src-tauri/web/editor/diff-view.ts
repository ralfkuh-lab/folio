// Diff-View: Monaco-DiffEditor fuer die KI-Aktions-Review (Spec
// docs/spec-ki-actions.md, Etappe A3). Vierte Surface neben FolioEditor/
// FolioCodeView/FolioThemeEditor — teilt denselben AMD-Loader
// (`whenMonacoLoaded`). Die Original-Seite ist read-only, die
// Modified-Seite bewusst editierbar (User darf im Review nachbessern).
// Models werden bei jedem setContents/dispose explizit disposed
// (Leak-Regel wie theme-editor).

import { whenMonacoLoaded } from './mount';
import { getMonaco, setMonaco } from './state';

let editor: any = null;
let originalModel: any = null;
let modifiedModel: any = null;
let mountedElementId: string | null = null;
let pendingTheme: 'light' | 'dark' | null = null;
let modifiedListener: any = null;
let changeCallback: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let sideBySide = true;

function ensureMonaco(): Promise<any> {
    return whenMonacoLoaded().then(() => {
        if (!getMonaco() && (window as any).monaco?.editor) {
            setMonaco((window as any).monaco);
        }
        return getMonaco();
    });
}

function disposeModels(): void {
    if (modifiedListener) {
        try { modifiedListener.dispose(); } catch { /* ignore */ }
        modifiedListener = null;
    }
    if (originalModel) {
        try { originalModel.dispose(); } catch { /* ignore */ }
        originalModel = null;
    }
    if (modifiedModel) {
        try { modifiedModel.dispose(); } catch { /* ignore */ }
        modifiedModel = null;
    }
}

export function mount(elementId: string): Promise<void> {
    return ensureMonaco().then((monaco) => {
        if (!monaco) return;
        const el = document.getElementById(elementId);
        if (!el) {
            console.error(`[folio-diff-view] mount target '${elementId}' not found`);
            return;
        }
        if (editor && mountedElementId === elementId) return;
        if (editor) disposeInternal();

        const isDark = document.documentElement.classList.contains('theme-dark')
            || pendingTheme === 'dark';
        // Side-by-side nur bei ausreichender Breite; darunter Inline-Diff.
        sideBySide = el.clientWidth === 0 || el.clientWidth >= 900;
        editor = monaco.editor.createDiffEditor(el, {
            theme: isDark ? 'vs-dark' : 'vs',
            automaticLayout: true,
            renderSideBySide: sideBySide,
            originalEditable: false,
            readOnly: false,
            // Sichtbarkeit der Revert-Controls regelt der CSS-Override in ai-actions-dialog.css
            // (renderMarginRevertIcon ist inert, solange renderGutterMenu aktiv ist).
            minimap: { enabled: false },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            fontSize: 13.5,
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
            contextmenu: false,
        });
        mountedElementId = elementId;
        if (pendingTheme) {
            monaco.editor.setTheme(pendingTheme === 'dark' ? 'vs-dark' : 'vs');
            pendingTheme = null;
        }
        // Breitenabhängige Darstellung auch bei späteren Resizes
        // nachziehen (900-px-Schwelle, Spec).
        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => {
                if (!editor) return;
                const wide = el.clientWidth >= 900;
                if (wide !== sideBySide) {
                    sideBySide = wide;
                    editor.updateOptions({ renderSideBySide: wide });
                }
            });
            resizeObserver.observe(el);
        }
    });
}

export function setContents(original: string, modified: string, language: string): void {
    const monaco = getMonaco();
    if (!editor || !monaco) return;
    // Erst das Model vom Widget loesen, dann disposen — sonst wirft Monaco
    // "TextModel got disposed before DiffEditorWidget model got reset".
    try { editor.setModel(null); } catch { /* ignore */ }
    disposeModels();
    originalModel = monaco.editor.createModel(original || '', language || 'markdown');
    modifiedModel = monaco.editor.createModel(modified || '', language || 'markdown');
    editor.setModel({ original: originalModel, modified: modifiedModel });
    if (changeCallback) {
        modifiedListener = modifiedModel.onDidChangeContent(() => {
            if (changeCallback) changeCallback();
        });
    }
}

/** Callback fuer User-Edits an der Modified-Seite (Dirty-Tracking). */
export function onModifiedChange(callback: (() => void) | null): void {
    changeCallback = callback;
    if (modifiedListener) {
        try { modifiedListener.dispose(); } catch { /* ignore */ }
        modifiedListener = null;
    }
    if (callback && modifiedModel) {
        modifiedListener = modifiedModel.onDidChangeContent(() => {
            if (changeCallback) changeCallback();
        });
    }
}

export function getModified(): string {
    return modifiedModel ? modifiedModel.getValue() : '';
}

export function setTheme(mode: 'light' | 'dark'): void {
    const monaco = getMonaco();
    if (!editor || !monaco) {
        pendingTheme = mode;
        return;
    }
    monaco.editor.setTheme(mode === 'dark' ? 'vs-dark' : 'vs');
}

export function layout(): void {
    if (editor) editor.layout();
}

export function focus(): void {
    if (editor && typeof editor.getModifiedEditor === 'function') {
        editor.getModifiedEditor().focus();
    }
}

export function dispose(): void {
    disposeInternal();
}

function disposeInternal(): void {
    changeCallback = null;
    if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch { /* ignore */ }
        resizeObserver = null;
    }
    if (editor) {
        try { editor.setModel(null); } catch { /* ignore */ }
    }
    disposeModels();
    if (editor) {
        try { editor.dispose(); } catch { /* ignore */ }
        editor = null;
    }
    mountedElementId = null;
}

export function isMounted(): boolean {
    return !!editor;
}
