// Tests fuer view/hex-search.ts — Pattern-Parser, Wrap-Plan, Zeilen-Highlight.

import { describe, expect, it } from 'vitest';
import {
    formatMatchOffset,
    parseHexSearchPattern,
    planHexSearch,
    rowHighlightRange,
} from '../../app/view/hex-search';

describe('parseHexSearchPattern — text', () => {
    it('encodes the raw input as UTF-8, including spaces', () => {
        expect(parseHexSearchPattern('Folio', 'text')).toEqual({
            ok: true,
            bytes: [0x46, 0x6f, 0x6c, 0x69, 0x6f],
        });
        expect(parseHexSearchPattern('A B', 'text')).toEqual({
            ok: true,
            bytes: [0x41, 0x20, 0x42],
        });
    });

    it('encodes non-ASCII as multi-byte UTF-8', () => {
        expect(parseHexSearchPattern('ä', 'text')).toEqual({
            ok: true,
            bytes: [0xc3, 0xa4],
        });
    });

    it('treats an empty string as empty, not invalid', () => {
        expect(parseHexSearchPattern('', 'text')).toEqual({ ok: false, reason: 'empty' });
    });
});

describe('parseHexSearchPattern — hex', () => {
    it('accepts compact digits and mixed separators', () => {
        expect(parseHexSearchPattern('466f6c696f', 'hex')).toEqual({
            ok: true,
            bytes: [0x46, 0x6f, 0x6c, 0x69, 0x6f],
        });
        expect(parseHexSearchPattern('46 6F,6c  0x69,0X6F', 'hex')).toEqual({
            ok: true,
            bytes: [0x46, 0x6f, 0x6c, 0x69, 0x6f],
        });
    });

    it('ignores case of hex digits and 0x prefixes', () => {
        expect(parseHexSearchPattern('0xAa 0Xbb', 'hex')).toEqual({
            ok: true,
            bytes: [0xaa, 0xbb],
        });
    });

    it('treats whitespace-only and bare 0x as empty', () => {
        expect(parseHexSearchPattern('   ,  , ', 'hex')).toEqual({ ok: false, reason: 'empty' });
        expect(parseHexSearchPattern('0x', 'hex')).toEqual({ ok: false, reason: 'empty' });
        expect(parseHexSearchPattern('', 'hex')).toEqual({ ok: false, reason: 'empty' });
    });

    it('rejects an odd number of digits as a visible error', () => {
        expect(parseHexSearchPattern('123', 'hex')).toEqual({ ok: false, reason: 'invalid' });
        expect(parseHexSearchPattern('1 2 3', 'hex')).toEqual({ ok: false, reason: 'invalid' });
        expect(parseHexSearchPattern('0x1', 'hex')).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects non-hex characters', () => {
        expect(parseHexSearchPattern('gg', 'hex')).toEqual({ ok: false, reason: 'invalid' });
        expect(parseHexSearchPattern('46xyz', 'hex')).toEqual({ ok: false, reason: 'invalid' });
        expect(parseHexSearchPattern('0xGG', 'hex')).toEqual({ ok: false, reason: 'invalid' });
    });
});

describe('planHexSearch wrap-around', () => {
    it('starts at 0 forward and at EOF backward when there is no current hit', () => {
        expect(planHexSearch({ current: null, backwards: false, fileSize: 100 }))
            .toEqual({ from: 0, wrapFrom: null });
        expect(planHexSearch({ current: null, backwards: true, fileSize: 100 }))
            .toEqual({ from: 100, wrapFrom: null });
    });

    it('continues after the current hit and wraps once', () => {
        expect(planHexSearch({ current: 5, backwards: false, fileSize: 100 }))
            .toEqual({ from: 6, wrapFrom: 0 });
        // Rueckwaerts ist `from` die exklusive Obergrenze: `current` selbst,
        // sonst faellt der direkte Nachbar bei `current - 1` heraus.
        expect(planHexSearch({ current: 5, backwards: true, fileSize: 100 }))
            .toEqual({ from: 5, wrapFrom: 100 });
        expect(planHexSearch({ current: 1, backwards: true, fileSize: 100 }))
            .toEqual({ from: 1, wrapFrom: 100 });
    });

    it('does not repeat the same backward scan at EOF', () => {
        expect(planHexSearch({ current: 100, backwards: true, fileSize: 100 }))
            .toEqual({ from: 100, wrapFrom: null });
    });

    it('does not schedule a second call when the first from is already the wrap start', () => {
        expect(planHexSearch({ current: 99, backwards: false, fileSize: 100 }))
            .toEqual({ from: 0, wrapFrom: null });
        expect(planHexSearch({ current: 0, backwards: true, fileSize: 100 }))
            .toEqual({ from: 100, wrapFrom: null });
    });

    it('is a no-op plan on an empty file', () => {
        expect(planHexSearch({ current: null, backwards: false, fileSize: 0 }))
            .toEqual({ from: 0, wrapFrom: null });
        expect(planHexSearch({ current: 0, backwards: true, fileSize: 0 }))
            .toEqual({ from: 0, wrapFrom: null });
    });
});

describe('rowHighlightRange', () => {
    it('marks a match that stays inside one row', () => {
        expect(rowHighlightRange(0, 2, 3)).toEqual({ start: 2, end: 5 });
    });

    it('splits a match that crosses a 16-byte row boundary', () => {
        expect(rowHighlightRange(0, 14, 4)).toEqual({ start: 14, end: 16 });
        expect(rowHighlightRange(16, 14, 4)).toEqual({ start: 0, end: 2 });
        expect(rowHighlightRange(32, 14, 4)).toBeNull();
    });

    it('returns null for empty or disjoint ranges', () => {
        expect(rowHighlightRange(0, 16, 4)).toBeNull();
        expect(rowHighlightRange(16, 0, 4)).toBeNull();
        expect(rowHighlightRange(0, 0, 0)).toBeNull();
    });
});

describe('formatMatchOffset', () => {
    it('uses a 0x prefix and at least eight hex digits', () => {
        expect(formatMatchOffset(1)).toBe('0x00000001');
        expect(formatMatchOffset(0x00600012)).toBe('0x00600012');
        expect(formatMatchOffset(0x100000000)).toBe('0x100000000');
    });
});
