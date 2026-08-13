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
        // Persistente Instanz (Bug 2026-07-11): existiert das Widget schon,
        // wird es wiederverwendet statt neu erstellt — ein zweites
        // createDiffEditor hinterließe wegen Monacos dispose-Leck einen
        // aktiven Zombie-Keybinding-Handler. Im Review-Flow ist der Container
        // immer #ai-diff-mount; ein Wechsel käme nur bei einem echten Umbau
        // vor und wird bewusst als No-op behandelt (bestehendes Widget bleibt).
        if (editor) {
            if (mountedElementId !== elementId) {
                console.warn(`[folio-diff-view] mount auf abweichenden Container '${elementId}' ignoriert (persistente Instanz, aktiv: '${mountedElementId}')`);
            }
            return;
        }
        // Sicherheitsgurt: verwaisten DOM aus einem früheren Zustand entfernen,
        // bevor das erste Widget in den Container gesetzt wird.
        if (el.firstChild) el.replaceChildren();

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

export type SetContentsOptions = {
    /** Modified-Seite sperren. Default (undefined/false) bleibt editierbar
     *  — die KI-Review braucht das. */
    readOnly?: boolean;
};

export function setContents(
    original: string,
    modified: string,
    language: string,
    options?: SetContentsOptions,
): void {
    const monaco = getMonaco();
    if (!editor || !monaco) return;
    // Erst das Model vom Widget loesen, dann disposen — sonst wirft Monaco
    // "TextModel got disposed before DiffEditorWidget model got reset".
    try { editor.setModel(null); } catch { /* ignore */ }
    disposeModels();
    originalModel = monaco.editor.createModel(original || '', language || 'markdown');
    modifiedModel = monaco.editor.createModel(modified || '', language || 'markdown');
    editor.setModel({ original: originalModel, modified: modifiedModel });
    const readOnly = !!(options && options.readOnly);
    editor.updateOptions({ readOnly });
    if (typeof editor.getModifiedEditor === 'function') {
        editor.getModifiedEditor().updateOptions({ readOnly });
    }
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

/**
 * Leert den Review-Inhalt OHNE das DiffEditor-Widget zu zerstören
 * (Bug 2026-07-11 „Tasten zählen doppelt"): Monacos
 * `createDiffEditor(...).dispose()` entfernt das Widget NICHT aus
 * `monaco.editor.getDiffEditors()` und hinterlässt seinen document-level
 * Keybinding-Handler aktiv — pro Review-Zyklus akkumulierte das zu N-facher
 * Tasteneingabe. Deshalb wird die Instanz jetzt persistent gehalten (wie der
 * Haupteditor) und zwischen Reviews nur der Inhalt gewechselt. `clear` gibt
 * die Models frei und trennt sie sauber vom Widget; das Widget bleibt für den
 * nächsten `setContents` bestehen. `dispose` ist damit dem echten Teardown
 * vorbehalten (heute nirgends im Review-Flow gerufen).
 */
export function clear(): void {
    if (modifiedListener) {
        try { modifiedListener.dispose(); } catch { /* ignore */ }
        modifiedListener = null;
    }
    changeCallback = null;
    if (editor) {
        try { editor.setModel(null); } catch { /* ignore */ }
    }
    disposeModels();
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

/**
 * BEWUSST kein echtes Widget-Teardown (Bug 2026-07-11 „Tasten zählen
 * doppelt"): Monacos `createDiffEditor(...).dispose()` entfernt das Widget
 * nachweislich NICHT aus `monaco.editor.getDiffEditors()` und lässt seinen
 * document-level Keybinding-Handler aktiv (empirisch: base=0 → create=1 →
 * nach dispose bleibt 1, auch nach 1,5 s). Ein anschließender Remount würde
 * so einen zweiten aktiven Handler hinterlassen. Da ein echtes Widget-
 * Teardown mit dieser Monaco-Version nicht sauber möglich und im Review-Flow
 * auch nicht nötig ist (die Instanz lebt bis zum Fenster-Close), delegiert
 * `dispose` auf `clear`: der Inhalt wird freigegeben, das Widget bleibt
 * persistent und wiederverwendbar. Der Container-Reset in `mount` bleibt als
 * Sicherheitsgurt, falls je auf einen anderen Container gemountet wird.
 */
export function dispose(): void {
    clear();
}

export function isMounted(): boolean {
    return !!editor;
}
