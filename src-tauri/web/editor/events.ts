// Per-editor listener installation. Called once from `mount()` right
// after `monaco.editor.create()` returns. Holds no module-local state —
// the editor reference travels through arguments and `state.ts`.

import { post } from './bridge';
import { hasActiveTerm, recomputeMatches } from './find';
import { isProgrammaticWrite } from './state';

export function attachEditorListeners(editor: any, monaco: any): void {
    // Find-Shortcuts: Monacos eigenes Find-Widget bleibt deaktiviert,
    // stattdessen die Shell-Find-Bar öffnen / weiterspringen. Monaco
    // schluckt die Tasten in seinem Bubble-Handler, also müssen die
    // addCommand-Callbacks die window-Funktionen selbst aufrufen.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
        const open = (window as any).openEditorFind;
        if (typeof open !== 'function') return;
        // Einzeilige Selektion als Seed übernehmen (VS-Code-Verhalten);
        // mehrzeilige Selektion ignorieren — der Find-Term ist Single-Line.
        let seed = '';
        const sel = editor.getSelection();
        const model = editor.getModel();
        if (sel && model && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) {
            seed = model.getValueInRange(sel) || '';
        }
        open(seed);
    });
    editor.addCommand(monaco.KeyCode.F3, () => {
        const next = (window as any).findNext;
        if (typeof next === 'function') next();
    });
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F3, () => {
        const prev = (window as any).findPrev;
        if (typeof prev === 'function') prev();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        post({ type: 'editorSaveRequested' });
    });

    editor.onDidChangeModelContent(() => {
        if (isProgrammaticWrite()) return;
        const text = editor.getValue();
        post({ type: 'editorTextChanged', text });
        // Decorations aktualisieren, aber NICHT zur naechsten
        // Fundstelle springen — der User schreibt gerade.
        if (hasActiveTerm()) recomputeMatches(false);
    });

    editor.onDidChangeCursorSelection((e: any) => {
        const model = editor.getModel();
        if (!model) return;
        const start = model.getOffsetAt(e.selection.getStartPosition());
        const end = model.getOffsetAt(e.selection.getEndPosition());
        post({ type: 'editorSelection', start, length: end - start });
    });

    // Scroll listener (RAF-debounced) → editorScroll-Event für History-Capture.
    let scrollRafQueued = false;
    editor.onDidScrollChange(() => {
        if (scrollRafQueued) return;
        scrollRafQueued = true;
        requestAnimationFrame(() => {
            scrollRafQueued = false;
            post({ type: 'editorScroll', y: editor.getScrollTop() });
        });
    });
}
