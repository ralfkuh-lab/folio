/** Smart-List-Fortsetzung — reine Zeilenlogik, kein Monaco, kein DOM. */
import { describe, expect, it } from 'vitest';
import { continueListEdit, isListItemLine } from '../../editor/list-continue';
import { isInsideCodeFence } from '../../editor/wikilink-complete';

/** `|` markiert den Cursor; liefert das Ergebnis (mit `|`) oder null. */
function enter(withCursor: string, inFence = false): string | null {
    const column = withCursor.indexOf('|');
    const line = withCursor.slice(0, column) + withCursor.slice(column + 1);
    const edit = continueListEdit(line, column, inFence);
    if (!edit) return null;
    return line.slice(0, edit.from) + edit.text + '|' + line.slice(edit.to);
}

describe('continueListEdit — Fortsetzung', () => {
    it('1: Bullet -', () => {
        expect(enter('- foo|')).toBe('- foo\n- |');
    });

    it('2: Bullet * und +', () => {
        expect(enter('* foo|')).toBe('* foo\n* |');
        expect(enter('+ foo|')).toBe('+ foo\n+ |');
    });

    it('3: Einrückung bleibt', () => {
        expect(enter('  - foo|')).toBe('  - foo\n  - |');
    });

    it('4: Nummerierung 1. → 2.', () => {
        expect(enter('1. foo|')).toBe('1. foo\n2. |');
    });

    it('5: 9) → 10)', () => {
        expect(enter('9) foo|')).toBe('9) foo\n10) |');
    });

    it('6: Task-Items setzen den Haken zurück', () => {
        expect(enter('- [x] erledigt|')).toBe('- [x] erledigt\n- [ ] |');
        expect(enter('- [ ] offen|')).toBe('- [ ] offen\n- [ ] |');
        expect(enter('- [X] gross|')).toBe('- [X] gross\n- [ ] |');
    });

    it('7: nummeriertes Task-Item', () => {
        expect(enter('3. [x] a|')).toBe('3. [x] a\n4. [ ] |');
    });

    it('8: Zitat', () => {
        expect(enter('> zitat|')).toBe('> zitat\n> |');
    });

    it('9: Liste im Zitat und verschachteltes Zitat', () => {
        expect(enter('> - foo|')).toBe('> - foo\n> - |');
        expect(enter('> > foo|')).toBe('> > foo\n> > |');
    });

    it('10: Rest hinter dem Cursor wandert mit', () => {
        expect(enter('- foo|bar')).toBe('- foo\n- |bar');
    });

    it('16: führende Nullen werden nicht erhalten', () => {
        expect(enter('09. a|')).toBe('09. a\n10. |');
    });
});

describe('continueListEdit — leeres Item beendet die Liste', () => {
    it('11: Zeile wird leer, kein Zeilenumbruch', () => {
        expect(enter('- |')).toBe('|');
        expect(enter('  - |')).toBe('|');
        expect(enter('2. |')).toBe('|');
        expect(enter('- [ ] |')).toBe('|');
        expect(enter('> |')).toBe('|');
    });

    it('15: nur Whitespace hinter dem Marker', () => {
        expect(enter('-   |')).toBe('|');
    });
});

describe('continueListEdit — Standard-Enter (null)', () => {
    it('12: Cursor im Marker', () => {
        expect(enter('-| foo')).toBeNull();
        expect(enter('|- foo')).toBeNull();
    });

    it('13: keine Listenpunkte', () => {
        expect(enter('foo|')).toBeNull();
        expect(enter('-foo|')).toBeNull();
        expect(enter('1.foo|')).toBeNull();
        expect(enter('---|')).toBeNull();
        expect(enter('**fett**|')).toBeNull();
    });

    it('14: in Code-Fence', () => {
        expect(enter('- foo|', true)).toBeNull();
        expect(enter('> zitat|', true)).toBeNull();
    });

    it('14: Fence-Erkennung über isInsideCodeFence', () => {
        const lines = ['text', '```', '- foo', '```', '- bar'];
        expect(isInsideCodeFence(lines, 2)).toBe(true);
        expect(isInsideCodeFence(lines, 4)).toBe(false);
    });
});

describe('isListItemLine (Tab/Shift+Tab)', () => {
    it('erkennt Bullet-, Nummern- und Task-Items', () => {
        expect(isListItemLine('- foo', false)).toBe(true);
        expect(isListItemLine('  1. foo', false)).toBe(true);
        expect(isListItemLine('- [ ] offen', false)).toBe(true);
        expect(isListItemLine('> - foo', false)).toBe(true);
    });

    it('ignoriert Zitat allein, Fließtext, Trennlinien und Fences', () => {
        expect(isListItemLine('> zitat', false)).toBe(false);
        expect(isListItemLine('foo', false)).toBe(false);
        expect(isListItemLine('---', false)).toBe(false);
        expect(isListItemLine('* * *', false)).toBe(false);
        expect(isListItemLine('- foo', true)).toBe(false);
    });
});
