/** pasteText — Fence-Gate und Mehrfach-Selektion am Editor-Adapter. */
import { afterEach, describe, expect, it, vi } from 'vitest';

// text.ts importiert `layout`/`whenReady` aus mount.ts; mount.ts startet am
// Modul-Top den Monaco-AMD-Load (im Test ohne `window.require` ein Reject).
// Fuer die reine Adapter-Logik genuegt der Mock (Muster: theme-editor.test).
vi.mock('../../editor/mount', () => ({
    layout: vi.fn(),
    whenReady: () => Promise.resolve(),
}));

import { setEditor, setMonaco } from '../../editor/state';
import { pasteText } from '../../editor/text';

const lines = ['a', '```', 'x', '```', 'b'];

const monaco = {
    Range: class {
        constructor(
            public startLineNumber: number, public startColumn: number,
            public endLineNumber: number, public endColumn: number,
        ) {}
    },
    Selection: class {
        constructor(
            public selectionStartLineNumber: number, public selectionStartColumn: number,
            public positionLineNumber: number, public positionColumn: number,
        ) {}
    },
};

function installEditor(lineNumber: number, selectionsCount = 1, overrides: any = {}): { calls: any[] } {
    const calls: any[] = [];
    const model = {
        getLanguageId: () => 'markdown',
        getLinesContent: () => lines,
        getValue: () => lines.join('\n'),
        getOffsetAt: () => 0,
        getPositionAt: () => ({ lineNumber: 1, column: 1 }),
    };
    const selections = Array.from({ length: selectionsCount }, () => ({
        getStartPosition: () => ({ lineNumber, column: 1 }),
        getEndPosition: () => ({ lineNumber, column: 1 }),
    }));
    setMonaco(monaco);
    setEditor({
        getModel: () => model,
        getSelections: () => selections,
        pushUndoStop: () => calls.push('pushUndoStop'),
        // Explizit `true`: vorher lieferte `calls.push(...)` zufaellig die
        // Array-Laenge zurueck. Der Rueckgabewert wird jetzt ausgewertet,
        // der Mock muss Erfolg/Ablehnung bewusst abbilden.
        executeEdits: (...a: any[]) => {
            calls.push(['executeEdits', ...a]);
            return true;
        },
        setSelection: () => {},
        revealPositionInCenterIfOutsideViewport: () => {},
        getValue: () => lines.join('\n'),
        ...overrides,
    });
    return { calls };
}

afterEach(() => {
    setEditor(null);
    setMonaco(null);
});

describe('pasteText', () => {
    it('E1: Cursor in der Fence → false, hinter der Fence → true', () => {
        installEditor(3);
        expect(pasteText('x')).toBe(false);

        installEditor(5);
        expect(pasteText('x')).toBe(true);
    });

    it('E1b: Cursor auf der Oeffner-Fence-Zeile → false', () => {
        installEditor(2);
        expect(pasteText('x')).toBe(false);
    });

    it('E2: zwei Selektionen → false', () => {
        installEditor(5, 2);
        expect(pasteText('x')).toBe(false);
    });

    it('E3: Nicht-Markdown-Modell → false', () => {
        const { calls } = installEditor(5);
        setEditor({
            getModel: () => ({ getLanguageId: () => 'plaintext' }),
            getSelections: () => [],
            pushUndoStop: () => calls.push('pushUndoStop'),
            executeEdits: () => {},
            setSelection: () => {},
            revealPositionInCenterIfOutsideViewport: () => {},
            getValue: () => '',
        });
        expect(pasteText('x')).toBe(false);
    });

    it('E4: Caret kommt aus der inversen Operation, nicht aus Offset+Laenge', () => {
        setMonaco(monaco);
        const revealed: any[] = [];
        let endCursor: any = null;
        // Bewusst OHNE getOffsetAt/getPositionAt: die alte Berechnung
        // (`getOffsetAt(startPos) + insert.length`) wuerde hier werfen.
        const model = {
            getLanguageId: () => 'markdown',
            getLinesContent: () => ['a', 'b'],
        };
        setEditor({
            getModel: () => model,
            getSelections: () => [{
                getStartPosition: () => ({ lineNumber: 1, column: 1 }),
                getEndPosition: () => ({ lineNumber: 1, column: 1 }),
            }],
            pushUndoStop: () => {},
            executeEdits: (_src: string, _edits: any[], computer?: any) => {
                endCursor = computer;
                // Inverse Operation: Range des eingefuegten Texts. Ein
                // CRLF-Modell expandiert `x\ny` auf `x\r\ny`.
                computer([{ range: { endLineNumber: 2, endColumn: 2 } }]);
                return true;
            },
            setSelection: () => {},
            revealPositionInCenterIfOutsideViewport: (p: any) => revealed.push(p),
            getValue: () => 'a\nb',
        });
        expect(pasteText('x\ny')).toBe(true);
        expect(typeof endCursor).toBe('function');
        expect(revealed[0]).toEqual({ lineNumber: 2, column: 2 });
    });

    it('E5: readOnly → false, executeEdits wird nicht aufgerufen', () => {
        setMonaco({ ...monaco, editor: { EditorOption: { readOnly: 1 } } });
        const calls: any[] = [];
        setEditor({
            getModel: () => ({ getLanguageId: () => 'markdown', getLinesContent: () => lines }),
            getSelections: () => [{
                getStartPosition: () => ({ lineNumber: 5, column: 1 }),
                getEndPosition: () => ({ lineNumber: 5, column: 1 }),
            }],
            getOption: (id: any) => id === 1,
            pushUndoStop: () => calls.push('pushUndoStop'),
            executeEdits: () => { calls.push('executeEdits'); return true; },
            revealPositionInCenterIfOutsideViewport: () => {},
            getValue: () => lines.join('\n'),
        });
        expect(pasteText('x')).toBe(false);
        expect(calls).toEqual([]);
    });

    it('E6: executeEdits false → false, keine editorTextChanged-Nachricht', () => {
        const emit = (window as any).__TAURI__.event.emit as ReturnType<typeof vi.fn>;
        installEditor(5, 1, { executeEdits: () => false });
        expect(pasteText('x')).toBe(false);
        expect(emit).not.toHaveBeenCalled();
    });
});
