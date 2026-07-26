/**
 * Unit tests fuer den tb-wikilink-Insert (Toolbar-Button).
 * Getestet wird die exportierte Transform aus app/util/wikilink-edit.ts —
 * genau die Funktion, die toolbar-actions.ts::insertWikilink aufruft.
 * Bewusst KEIN Nachbau der Logik im Test: ein Nachbau bliebe gruen, waehrend
 * der Produktionspfad bricht.
 */

import { describe, it, expect } from 'vitest';

import { computeWikilinkEdit } from '../../app/util/wikilink-edit';

describe('computeWikilinkEdit', () => {
    it('inserts [[]] and places the cursor between the inner brackets', () => {
        const r = computeWikilinkEdit('hello', 5, 0);
        expect(r.fullText).toBe('hello[[]]');
        expect(r.selectionStart).toBe(7);
        expect(r.selectionLength).toBe(0);
        expect(r.suggest).toBe(true);
    });

    it('keeps surrounding text when inserting mid-line', () => {
        const r = computeWikilinkEdit('ab', 1, 0);
        expect(r.fullText).toBe('a[[]]b');
        expect(r.selectionStart).toBe(3);
        expect(r.suggest).toBe(true);
    });

    it('wraps a selection as [[sel]] with the cursor after the closing brackets', () => {
        const r = computeWikilinkEdit('see Notiz now', 4, 5);
        expect(r.fullText).toBe('see [[Notiz]] now');
        expect(r.selectionStart).toBe(4 + '[[Notiz]]'.length);
        expect(r.selectionLength).toBe(0);
        expect(r.suggest).toBe(false);
    });

    it('treats offsets as UTF-16 code units (astral char before the cursor)', () => {
        // '😀' belegt zwei Code-Units — Cursor dahinter ist Offset 2.
        const r = computeWikilinkEdit('😀x', 2, 0);
        expect(r.fullText).toBe('😀[[]]x');
        expect(r.selectionStart).toBe(4);
    });

    it('wraps a multi-word selection verbatim', () => {
        const r = computeWikilinkEdit('a Meine Notiz b', 2, 'Meine Notiz'.length);
        expect(r.fullText).toBe('a [[Meine Notiz]] b');
        expect(r.suggest).toBe(false);
    });
});
