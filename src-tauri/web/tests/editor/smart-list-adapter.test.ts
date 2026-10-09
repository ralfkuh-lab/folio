/** Monaco-Adapter der Smart-List (`installSmartList`) gegen einen Fake-Editor. */
import { describe, expect, it } from 'vitest';
import { installSmartList } from '../../editor/events';

const monaco = {
    KeyCode: { Enter: 3, Tab: 2 },
    KeyMod: { Shift: 1024 },
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

/** Fake-Editor mit einer Zeile und leerem Cursor an `column` (1-basiert). */
function fakeEditor(line: string, column: number) {
    const actions: any[] = [];
    const calls: Array<[string, ...any[]]> = [];
    const editor = {
        addAction: (d: any) => { actions.push(d); },
        getModel: () => ({ getLinesContent: () => [line] }),
        getSelections: () => [{
            isEmpty: () => true,
            getPosition: () => ({ lineNumber: 1, column }),
        }],
        pushUndoStop: () => { calls.push(['pushUndoStop']); },
        executeEdits: (...a: any[]) => { calls.push(['executeEdits', ...a]); },
        trigger: (...a: any[]) => { calls.push(['trigger', ...a]); },
        revealPosition: () => {},
    };
    installSmartList(editor, monaco);
    return { actions, calls };
}

describe('installSmartList', () => {
    it('registriert drei Aktionen mit Keybindings, Precondition und Kontext', () => {
        const { actions } = fakeEditor('', 1);
        expect(actions.map((a) => a.id)).toEqual([
            'folio.markdown.continueList',
            'folio.markdown.indentListItem',
            'folio.markdown.outdentListItem',
        ]);
        expect(actions.map((a) => a.keybindings)).toEqual([
            [monaco.KeyCode.Enter],
            [monaco.KeyCode.Tab],
            [monaco.KeyMod.Shift | monaco.KeyCode.Tab],
        ]);
        for (const a of actions) {
            expect(a.precondition).toContain("editorLangId == 'markdown'");
            for (const key of [
                '!suggestWidgetVisible',
                '!inSnippetMode',
                '!editorHasSelection',
                '!editorHasMultipleSelections',
            ]) {
                expect(a.keybindingContext).toContain(key);
            }
            expect(a.label).not.toBe(a.id);
        }
    });

    it('Enter auf `- foo|`: genau ein executeEdits zwischen zwei pushUndoStop', () => {
        const { actions, calls } = fakeEditor('- foo', 6);
        actions[0].run();
        expect(calls.map((c) => c[0])).toEqual(['pushUndoStop', 'executeEdits', 'pushUndoStop']);
        const edits = calls[1][2];
        expect(edits).toHaveLength(1);
        expect(edits[0].text).toBe('\n- ');
        expect(edits[0].range).toMatchObject({ startColumn: 6, endColumn: 6 });
        expect(calls[1][3][0]).toMatchObject({ positionLineNumber: 2, positionColumn: 3 });
    });

    it('Enter auf `foo|`: Standard-Enter über type', () => {
        const { actions, calls } = fakeEditor('foo', 4);
        actions[0].run();
        expect(calls).toEqual([['trigger', 'keyboard', 'type', { text: '\n' }]]);
    });
});
