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
        post({
            type: 'editorSelection',
            start,
            length: end - start,
            line: e.selection.getStartPosition().lineNumber,
        });
    });

    // Scroll listener (RAF-debounced) → editorScroll-Event für History-Capture
    // und Scroll-Sync. Fraktionale Zeile aus Pixel-Offset (VSCode-Ansatz)
    // statt Integer aus getVisibleRanges — ermöglicht smooth Sync.
    let scrollRafQueued = false;
    editor.onDidScrollChange(() => {
        if (scrollRafQueued) return;
        scrollRafQueued = true;
        requestAnimationFrame(() => {
            scrollRafQueued = false;
            const scrollTop = editor.getScrollTop();
            let line = 0;
            if (typeof editor.getLineNumberAtVerticalOffset === 'function'
                && typeof editor.getTopForLineNumber === 'function') {
                const lineAtTop = editor.getLineNumberAtVerticalOffset(scrollTop);
                const y1 = editor.getTopForLineNumber(lineAtTop);
                const y2 = editor.getTopForLineNumber(lineAtTop + 1);
                const h = y2 - y1;
                line = lineAtTop + (h > 0 ? (scrollTop - y1) / h : 0);
            } else {
                const ranges = typeof editor.getVisibleRanges === 'function'
                    ? editor.getVisibleRanges()
                    : [];
                line = ranges && ranges.length > 0 ? ranges[0].startLineNumber : 0;
            }
            const scrollHeight = typeof editor.getScrollHeight === 'function'
                ? editor.getScrollHeight() : 0;
            post({ type: 'editorScroll', y: scrollTop, line });
            try {
                window.dispatchEvent(
                    new CustomEvent('folio-editor-scroll', {
                        detail: { y: scrollTop, line, scrollHeight },
                    }),
                );
            } catch { /* ignored */ }
        });
    });
}
