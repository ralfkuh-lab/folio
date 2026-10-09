// Per-editor listener installation. Called once from `mount()` right
// after `monaco.editor.create()` returns. Holds no module-local state —
// the editor reference travels through arguments and `state.ts`.

import { post } from './bridge';
import { hasActiveTerm, recomputeMatches } from './find';
import { continueListEdit, isListItemLine } from './list-continue';
import { isProgrammaticWrite } from './state';
import { isInsideCodeFence } from './wikilink-complete';

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

    installSmartList(editor, monaco);

    editor.onDidChangeModelContent(() => {
        if (isProgrammaticWrite()) return;
        const text = editor.getValue();
        post({ type: 'editorTextChanged', text });
        // Decorations aktualisieren, aber NICHT zur naechsten
        // Fundstelle springen — der User schreibt gerade.
        if (hasActiveTerm()) recomputeMatches(false);
    });

    // Selection → Backend (History/Automation) + in-window CustomEvent
    // fuer Statusleiste (Cursor Ln/Sp + Selektions-Stats). Letzteres
    // RAF-debounced analog zum Scroll-Listener.
    let selectionRafQueued = false;
    editor.onDidChangeCursorSelection((e: any) => {
        const model = editor.getModel();
        if (!model) return;
        // Model VOR dem RAF capturen: Doc-Wechsel im selben Frame darf
        // keinen nachlaufenden RAF mit dem alten Modell abfeuern.
        const m0 = model;
        const start = model.getOffsetAt(e.selection.getStartPosition());
        const end = model.getOffsetAt(e.selection.getEndPosition());
        post({
            type: 'editorSelection',
            start,
            length: end - start,
            line: e.selection.getStartPosition().lineNumber,
        });
        if (selectionRafQueued) return;
        selectionRafQueued = true;
        requestAnimationFrame(() => {
            selectionRafQueued = false;
            if (editor.getModel() !== m0) return;
            const pos = typeof editor.getPosition === 'function' ? editor.getPosition() : null;
            if (!pos) return;
            const sel = typeof editor.getSelection === 'function' ? editor.getSelection() : null;
            if (!sel) return;
            let selChars = 0;
            let selWords = 0;
            // Leere Selektion: getValueInRange nicht aufrufen (Spec).
            const empty = typeof sel.isEmpty === 'function'
                ? sel.isEmpty()
                : (sel.startLineNumber === sel.endLineNumber
                    && sel.startColumn === sel.endColumn);
            if (!empty) {
                const selected = m0.getValueInRange(sel) || '';
                selChars = selected.length; // JS-String = UTF-16 Code Units
                selWords = (selected.match(/\S+/g) || []).length;
            }
            try {
                window.dispatchEvent(
                    new CustomEvent('folio-editor-selection', {
                        detail: {
                            line: pos.lineNumber,
                            column: pos.column,
                            selChars,
                            selWords,
                        },
                    }),
                );
            } catch { /* ignored */ }
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

// Smart-List (Enter/Tab/Shift+Tab) nur im Markdown-Haupteditor. Die
// Aktionen greifen ueber `precondition` (auch fuer editor.trigger aus E2E);
// Fokus/Suggest/Snippet/Selektion stehen in `keybindingContext`, damit die
// Taste in diesen Faellen gar nicht erst gebunden ist und Monacos eigenes
// Verhalten (Suggest-Accept, Snippet-Tab, Ersetzen der Selektion) bleibt.
const SMART_LIST_PRECONDITION = "!editorReadonly && editorLangId == 'markdown'";
const SMART_LIST_KEY_CONTEXT = 'editorTextFocus && !suggestWidgetVisible && !inSnippetMode'
    + ' && !editorHasSelection && !editorHasMultipleSelections';

export function installSmartList(editor: any, monaco: any): void {
    if (typeof editor.addAction !== 'function') return;
    // Liefert Zeile + Fence-Status, wenn genau ein leerer Cursor steht.
    const singleCursorLine = () => {
        const model = editor.getModel();
        const selections = editor.getSelections() || [];
        if (!model || selections.length !== 1 || !selections[0].isEmpty()) return null;
        const pos = selections[0].getPosition();
        const lines = model.getLinesContent();
        return {
            pos,
            line: lines[pos.lineNumber - 1] ?? '',
            inFence: isInsideCodeFence(lines, pos.lineNumber - 1),
        };
    };

    editor.addAction({
        id: 'folio.markdown.continueList',
        label: 'Continue Markdown List',
        keybindings: [monaco.KeyCode.Enter],
        precondition: SMART_LIST_PRECONDITION,
        keybindingContext: SMART_LIST_KEY_CONTEXT,
        run: () => {
            const cur = singleCursorLine();
            const edit = cur && continueListEdit(cur.line, cur.pos.column - 1, cur.inFence);
            if (!cur || !edit) {
                editor.trigger('keyboard', 'type', { text: '\n' });
                return;
            }
            const ln = cur.pos.lineNumber;
            const nl = edit.text.lastIndexOf('\n');
            const endLine = nl < 0 ? ln : ln + 1;
            const endColumn = nl < 0
                ? edit.from + edit.text.length + 1
                : edit.text.length - nl;
            editor.pushUndoStop();
            editor.executeEdits(
                'folio.markdown.continueList',
                [{
                    range: new monaco.Range(ln, edit.from + 1, ln, edit.to + 1),
                    text: edit.text,
                    forceMoveMarkers: true,
                }],
                [new monaco.Selection(endLine, endColumn, endLine, endColumn)],
            );
            editor.pushUndoStop();
            editor.revealPosition({ lineNumber: endLine, column: endColumn });
        },
    });

    const indentAction = (
        id: string, label: string, key: number, lineAction: string, fallback: string,
    ) => {
        editor.addAction({
            id,
            label,
            keybindings: [key],
            precondition: SMART_LIST_PRECONDITION,
            keybindingContext: SMART_LIST_KEY_CONTEXT + ' && !editorTabMovesFocus',
            run: () => {
                const cur = singleCursorLine();
                const onList = !!cur && isListItemLine(cur.line, cur.inFence);
                editor.trigger('keyboard', onList ? lineAction : fallback, null);
            },
        });
    };
    indentAction('folio.markdown.indentListItem', 'Indent Markdown List Item', monaco.KeyCode.Tab,
        'editor.action.indentLines', 'tab');
    indentAction('folio.markdown.outdentListItem', 'Outdent Markdown List Item',
        monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        'editor.action.outdentLines', 'outdent');
}
