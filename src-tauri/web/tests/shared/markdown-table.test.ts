/** Tabellen-Formatierer (Spec T1) — Referenzfälle A–I aus dem Auftrag. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayWidth, findTableEdits, formatMarkdownTables } from '../../shared/markdown-table';

const A_IN = [
    '| Name | Wert | Notiz |',
    '|:--|--:|:-:|',
    '| Alpha | 1 | erste Zeile |',
    '| B | 1000 | x |',
].join('\n');
const A_OUT = [
    '| Name  | Wert |    Notiz    |',
    '| :---- | ---: | :---------: |',
    '| Alpha |    1 | erste Zeile |',
    '| B     | 1000 |      x      |',
].join('\n');

const B_IN = ['a|b', '-|-', '1|x \\| y', '| 2 |'].join('\n');
const B_OUT = [
    '| a   | b      |',
    '| --- | ------ |',
    '| 1   | x \\| y |',
    '| 2   |        |',
].join('\n');

const C_IN = ['> | a | b |', '> |---|---|', '> | long cell | 1 |'].join('\n');
const C_OUT = [
    '> | a         | b   |',
    '> | --------- | --- |',
    '> | long cell | 1   |',
].join('\n');

const D_IN = ['| 名前 | x |', '|---|---|', '| ab | y |'].join('\n');
const D_OUT = ['| 名前 | x   |', '| ---- | --- |', '| ab   | y   |'].join('\n');

const E_IN = ['| a | b |', '|---|---|', '| 1 | 2 | 3 |'].join('\n');
const E_OUT = ['| a   | b   |', '| --- | --- |', '| 1   | 2   | 3 |'].join('\n');

describe('formatMarkdownTables — Referenzfälle', () => {
    it('A: Ausrichtung links/rechts/zentriert, Kopfzeile folgt der Ausrichtung', () => {
        expect(formatMarkdownTables(A_IN)).toBe(A_OUT);
    });

    it('B: ohne äußere Pipes, `\\|` bleibt Zellinhalt, fehlende Zelle aufgefüllt', () => {
        expect(formatMarkdownTables(B_IN)).toBe(B_OUT);
    });

    it('C: Zitat-Präfix bleibt', () => {
        expect(formatMarkdownTables(C_IN)).toBe(C_OUT);
    });

    it('D: CJK zählt doppelt breit', () => {
        expect(formatMarkdownTables(D_IN)).toBe(D_OUT);
    });

    it('E: überzählige Zelle bleibt, ungepolstert', () => {
        expect(formatMarkdownTables(E_IN)).toBe(E_OUT);
    });

    it('F: Tabelle innerhalb eines ```-Fence bleibt unverändert', () => {
        const text = ['```', '| a | b |', '|---|---|', '| 1 | 2 |', '```'].join('\n');
        expect(formatMarkdownTables(text)).toBe(text);
        expect(findTableEdits(text.split('\n'))).toEqual([]);
    });

    it.each([
        ['A', A_OUT], ['B', B_OUT], ['C', C_OUT], ['D', D_OUT], ['E', E_OUT],
    ])('G: formatierte Ausgabe %s erneut formatiert → identisch, kein Edit', (_name, out) => {
        expect(formatMarkdownTables(out)).toBe(out);
        expect(findTableEdits(out.split('\n'))).toEqual([]);
    });

    it('H: abweichendes Präfix in einer Zeile → Tabelle unverändert', () => {
        const text = ['> | a | b |', '> |---|---|', '| 1 | 2 |'].join('\n');
        expect(formatMarkdownTables(text)).toBe(text);
        expect(findTableEdits(text.split('\n'))).toEqual([]);
    });

    it('I: ohne Trennzeile keine Tabelle', () => {
        const text = '| a | b |';
        expect(formatMarkdownTables(text)).toBe(text);
        expect(findTableEdits([text])).toEqual([]);
    });
});

describe('findTableEdits — Zeilenbereiche', () => {
    const doc = [
        'Text davor',
        '',
        ...A_IN.split('\n'), // Zeilen 2–5
        '',
        ...E_OUT.split('\n'), // Zeilen 7–9, schon formatiert
        '',
        ...B_IN.split('\n'), // Zeilen 11–14
        'Absatz ohne Pipe',
    ];

    it('ein Edit je abweichender Tabelle, nur über deren Zeilen', () => {
        const edits = findTableEdits(doc);
        expect(edits.map((e) => [e.startLine, e.endLine])).toEqual([[2, 5], [11, 14]]);
        expect(edits[0].lines.join('\n')).toBe(A_OUT);
        expect(edits[1].lines.join('\n')).toBe(B_OUT);
    });

    it('mit Bereich nur Tabellen, die ihn berühren', () => {
        expect(findTableEdits(doc, { start: 5, end: 7 }).map((e) => e.startLine)).toEqual([2]);
        expect(findTableEdits(doc, { start: 0, end: 1 })).toEqual([]);
        expect(findTableEdits(doc, { start: 13, end: 13 }).map((e) => e.startLine)).toEqual([11]);
    });

    it('Tabelle endet an Leerzeile, Zeile ohne Pipe und Fence-Zeile', () => {
        const lines = ['| a |', '|---|', '| 1 |', '```js|x', 'code', '```'];
        const edits = findTableEdits(lines);
        expect(edits).toHaveLength(1);
        expect([edits[0].startLine, edits[0].endLine]).toEqual([0, 2]);
    });

    it('Tabelle nach einer Fence wird formatiert', () => {
        const lines = ['```', '| x |', '```', '| a |', '|-|', '| 1 |'];
        const edits = findTableEdits(lines);
        expect(edits.map((e) => e.startLine)).toEqual([3]);
        expect(edits[0].lines).toEqual(['| a   |', '| --- |', '| 1   |']);
    });

    it('Kopf- und Trennzeile mit unterschiedlicher Zellzahl → keine Tabelle', () => {
        expect(findTableEdits(['| a | b |', '|---|', '| 1 | 2 |'])).toEqual([]);
    });

    it('getrimmt wird nur Leerzeichen/Tab, NBSP bleibt Zellinhalt', () => {
        const edits = findTableEdits(['| a |', '|-|', '|\u00a0x\t|']);
        expect(edits[0].lines[2]).toBe('| \u00a0x  |');
    });

    it('Setext-Unterstrich ohne Pipe ist keine Trennzeile', () => {
        expect(findTableEdits(['a | b', '---'])).toEqual([]);
    });
});

describe('displayWidth', () => {
    it('ASCII 1, CJK/Fullwidth 2, Emoji 2, kombinierte Grapheme einmal', () => {
        expect(displayWidth('abc')).toBe(3);
        expect(displayWidth('名前')).toBe(4);
        expect(displayWidth('Ａ')).toBe(2);
        expect(displayWidth('😀')).toBe(2);
        expect(displayWidth('👍🏽')).toBe(2);
        expect(displayWidth('é')).toBe(1);
        expect(displayWidth('ä')).toBe(1);
    });
});

describe('Korrekturrunde 1', () => {
    // K1 (Review Sol R1): Fence direkt am Listenmarker.
    it('K1: Tabelle in einer Fence am Listenmarker bleibt bytegleich', () => {
        const text = '- ```text\n  | a | b |\n  |-|-|\n  | x | y |\n  ```';
        expect(formatMarkdownTables(text)).toBe(text);
        const ordered = '1. ```js\n   | a | b |\n   |-|-|\n   ```';
        expect(formatMarkdownTables(ordered)).toBe(ordered);
        const quoted = '> - ```\n>   | a | b |\n>   |-|-|\n>   ```';
        expect(formatMarkdownTables(quoted)).toBe(quoted);
    });

    it('K1: nach dem Ende des Listenpunkts ist die Tabelle wieder Markdown', () => {
        // comrak: Fence endet mit dem Listenpunkt, danach Tabelle auf oberster Ebene.
        const lines = ['- ```text', '  code', '| a | b |', '|-|-|'];
        expect(findTableEdits(lines).map((e) => e.startLine)).toEqual([2]);
    });

    // K2 (Review Argon W2): Präfixwechsel mit neuer Tabelle trennt beide.
    it('K2: Zitat-Tabelle, direkt danach Tabelle auf oberster Ebene → beide einzeln', () => {
        const text = ['> | a | b |', '> |-|-|', '| c | d |', '|-|-|', '| 1 | 2 |'].join('\n');
        expect(formatMarkdownTables(text)).toBe([
            '> | a   | b   |',
            '> | --- | --- |',
            '| c   | d   |',
            '| --- | --- |',
            '| 1   | 2   |',
        ].join('\n'));
    });

    it('K2: Tabelle, direkt danach Zitat-Tabelle → beide einzeln', () => {
        const lines = ['| a |', '|-|', '> | b |', '> |-|', '> | 2 |'];
        expect(findTableEdits(lines).map((e) => [e.startLine, e.endLine])).toEqual([[0, 1], [2, 4]]);
    });

    it('K2: Präfixwechsel ohne neue Tabelle → unverändert (wie H)', () => {
        for (const text of [
            ['| a | b |', '|---|---|', '> | 1 | 2 |'],
            ['> | a | b |', '> |---|---|', '| 1 | 2 |', '> | 3 | 4 |'],
            // gleiche Tiefe, anderer Einzug: comrak liest beides als Zeilen einer Tabelle
            ['| a |', '|-|', '  | c |', '  |-|'],
        ].map((l) => l.join('\n'))) {
            expect(formatMarkdownTables(text)).toBe(text);
        }
    });

    // K3 (Review Argon W1): CRLF.
    it('K3: CRLF bleibt erhalten, kein \\r mitten in der Zeile', () => {
        const crlf = A_IN.split('\n').join('\r\n') + '\r\n';
        expect(formatMarkdownTables(crlf)).toBe(A_OUT.split('\n').join('\r\n') + '\r\n');
        expect(formatMarkdownTables('a | b\r\n---|---')).toBe('| a   | b   |\r\n| --- | --- |');
    });

    it('K3: gemischte Zeilenenden bleiben je Zeile erhalten', () => {
        expect(formatMarkdownTables('x\r\n| a |\n|-|\r\n| 1 |\ny'))
            .toBe('x\r\n| a   |\n| --- |\r\n| 1   |\ny');
    });

    // K4 (Review Argon H2): kein unsichtbares U+FE0F im Quelltext.
    it('K4: Quelltext enthält U+FE0F nur als Escape', () => {
        const src = readFileSync(resolve(__dirname, '../../shared/markdown-table.ts'), 'utf8');
        expect(src.includes('\uFE0F')).toBe(false);
        expect(displayWidth('\u2764\uFE0F')).toBe(2);
    });
});
