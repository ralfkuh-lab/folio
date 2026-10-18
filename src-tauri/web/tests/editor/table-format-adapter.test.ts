/** Monaco-Adapter der Tabellen-Formatierung (`installTableFormatting`). */
import { describe, expect, it } from 'vitest';
import { installTableFormatting } from '../../editor/events';

class Range {
    constructor(
        public startLineNumber: number, public startColumn: number,
        public endLineNumber: number, public endColumn: number,
    ) {}
}

const providers: Record<string, any> = {};
const monaco = {
    Range,
    languages: {
        registerDocumentFormattingEditProvider: (lang: string, p: any) => {
            providers['doc:' + lang] = p;
        },
        registerDocumentRangeFormattingEditProvider: (lang: string, p: any) => {
            providers['range:' + lang] = p;
        },
    },
};

function model(lines: string[], eol = '\n') {
    return {
        getLinesContent: () => lines,
        getLineMaxColumn: (n: number) => lines[n - 1].length + 1,
        getEOL: () => eol,
    };
}

const DOC = ['# T', '', '| a | b |', '|-|-|', '| 1 | 22 |', '', '| x   |', '| --- |'];

describe('installTableFormatting', () => {
    installTableFormatting(monaco);
    installTableFormatting(monaco); // einmalig, zweiter Aufruf ist No-op

    it('registriert Dokument- und Bereichs-Provider für markdown', () => {
        expect(Object.keys(providers).sort()).toEqual(['doc:markdown', 'range:markdown']);
    });

    it('ein TextEdit je abweichender Tabelle über deren Zeilen, mit Model-EOL', () => {
        const edits = providers['doc:markdown'].provideDocumentFormattingEdits(model(DOC, '\r\n'));
        expect(edits).toEqual([{
            range: new Range(3, 1, 5, 11),
            text: '| a   | b   |\r\n| --- | --- |\r\n| 1   | 22  |',
        }]);
    });

    it('formatierte Tabelle → kein Edit', () => {
        const lines = ['| a   |', '| --- |', '| 1   |'];
        expect(providers['doc:markdown'].provideDocumentFormattingEdits(model(lines))).toEqual([]);
    });

    it('Bereich außerhalb jeder Tabelle → kein Edit', () => {
        const edits = providers['range:markdown'].provideDocumentRangeFormattingEdits(
            model(DOC), new Range(1, 1, 2, 1));
        expect(edits).toEqual([]);
        const hit = providers['range:markdown'].provideDocumentRangeFormattingEdits(
            model(DOC), new Range(4, 2, 4, 3));
        expect(hit).toHaveLength(1);
    });
});
