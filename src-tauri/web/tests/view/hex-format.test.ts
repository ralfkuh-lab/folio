// Tests fuer view/hex-format.ts — reine Formatierung und Mathematik ohne DOM.

import { describe, expect, it } from 'vitest';
import {
    BYTES_PER_ROW,
    MAX_WINDOW_BYTES,
    MIN_WINDOW_BYTES,
    chunkStartFor,
    formatLine,
    formatOffset,
    offsetWidthFor,
    parseOffsetInput,
    rowOffset,
    windowBytesFor,
    windowEndExclusive,
    windowStartFor,
} from '../../app/view/hex-format';

describe('view/hex-format', () => {
    describe('window and chunk mathematics', () => {
        it('caps an 18 px line height at 4 MiB', () => {
            expect(windowBytesFor(18)).toBe(MAX_WINDOW_BYTES);
        });

        it('derives the smaller height-budget window for 36 px rows', () => {
            expect(windowBytesFor(36)).toBe(Math.floor(8_000_000 / 36) * BYTES_PER_ROW);
            expect(windowBytesFor(36) % BYTES_PER_ROW).toBe(0);
        });

        it('falls back to one row for nonsensical line heights', () => {
            expect(windowBytesFor(0)).toBe(MIN_WINDOW_BYTES);
            expect(windowBytesFor(-1)).toBe(MIN_WINDOW_BYTES);
            expect(windowBytesFor(Number.NaN)).toBe(MIN_WINDOW_BYTES);
            expect(windowBytesFor(Number.POSITIVE_INFINITY)).toBe(MIN_WINDOW_BYTES);
        });

        it('uses fixed, aligned, non-overlapping pages', () => {
            const page = MAX_WINDOW_BYTES;
            expect(windowStartFor(0, page)).toBe(0);
            expect(windowStartFor(page - 1, page)).toBe(0);
            expect(windowStartFor(page, page)).toBe(page);
            expect(windowStartFor(page + 123, page)).toBe(page);
        });

        it('clamps small and partial last windows to fileSize', () => {
            const page = MAX_WINDOW_BYTES;
            expect(windowEndExclusive(0, page, 1234)).toBe(1234);
            expect(windowEndExclusive(page, page, page + 123)).toBe(page + 123);
            expect(windowEndExclusive(page, page, page)).toBe(page);
            expect(windowEndExclusive(0, page, 0)).toBe(0);
        });

        it('keeps the final-window calculation within MAX_SAFE_INTEGER', () => {
            const fileSize = Number.MAX_SAFE_INTEGER;
            const start = windowStartFor(fileSize, MAX_WINDOW_BYTES);
            expect(start).toBeLessThanOrEqual(fileSize);
            expect(windowEndExclusive(start, MAX_WINDOW_BYTES, fileSize)).toBe(fileSize);
            expect(rowOffset(start, Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(fileSize);
        });

        it('computes row and chunk starts', () => {
            expect(rowOffset(1024, 3)).toBe(1024 + 3 * BYTES_PER_ROW);
            expect(chunkStartFor(0, 64 * 1024)).toBe(0);
            expect(chunkStartFor(64 * 1024 - 1, 64 * 1024)).toBe(0);
            expect(chunkStartFor(64 * 1024, 64 * 1024)).toBe(64 * 1024);
        });
    });

    describe('offset formatting', () => {
        it('uses the last byte offset and a minimum width of eight', () => {
            expect(offsetWidthFor(0)).toBe(8);
            expect(offsetWidthFor(1)).toBe(8);
            expect(offsetWidthFor(0xffffffff)).toBe(8);
            expect(offsetWidthFor(0x100000000)).toBe(8);
            expect(offsetWidthFor(0x100000001)).toBe(9);
        });

        it('formats lowercase hex with leading zeroes', () => {
            expect(formatOffset(0xabcdef, 8)).toBe('00abcdef');
            expect(formatOffset(0, 8)).toBe('00000000');
        });
    });

    describe('line formatting', () => {
        it('formats 16 bytes with a separator between the groups', () => {
            const line = formatLine(new Uint8Array([
                0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00,
                0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00,
            ]), 0, 8);

            expect(line).toEqual({
                offset: '00000000',
                bytes: '4d 5a 90 00 03 00 00 00  04 00 00 00 ff ff 00 00',
                ascii: 'MZ..............',
            });
        });

        it('pads a final partial line to the full byte and ASCII width', () => {
            const line = formatLine(new Uint8Array([0x41, 0x00, 0x7e]), 0x20, 8);
            const tokens = ['41', '00', '7e', ...Array(13).fill('  ')];
            const expectedBytes = tokens.slice(0, 8).join(' ')
                + '  '
                + tokens.slice(8).join(' ');

            expect(line.offset).toBe('00000020');
            expect(line.bytes).toBe(expectedBytes);
            expect(line.bytes).toHaveLength(48);
            expect(line.ascii).toBe('A.~' + ' '.repeat(13));
            expect(line.ascii).toHaveLength(BYTES_PER_ROW);
        });

        it('uses explicit placeholders for bytes that are not loaded yet', () => {
            const line = formatLine([0x41, null, 0x42], 0, 8);
            expect(line.bytes.startsWith('41 ·· 42')).toBe(true);
            expect(line.bytes).toHaveLength(48);
            expect(line.ascii).toBe('A·B' + ' '.repeat(13));
        });

        it('maps only printable ASCII bytes directly', () => {
            const line = formatLine(new Uint8Array([0x1f, 0x20, 0x7e, 0x7f]), 0, 8);
            expect(line.ascii).toBe('. ~.' + ' '.repeat(12));
        });
    });

    describe('offset parser', () => {
        it('accepts trimmed decimal and hexadecimal input', () => {
            expect(parseOffsetInput(' 42 ', 100)).toEqual({ ok: true, offset: 42 });
            expect(parseOffsetInput('0x2a', 100)).toEqual({ ok: true, offset: 42 });
            expect(parseOffsetInput('0X2A', 100)).toEqual({ ok: true, offset: 42 });
        });

        it('accepts zero for an empty file and the exact EOF offset', () => {
            expect(parseOffsetInput('0', 0)).toEqual({ ok: true, offset: 0 });
            expect(parseOffsetInput('100', 100)).toEqual({ ok: true, offset: 100 });
        });

        it('distinguishes empty, invalid, and range failures', () => {
            expect(parseOffsetInput('   ', 100)).toEqual({ ok: false, reason: 'empty' });
            expect(parseOffsetInput('wat', 100)).toEqual({ ok: false, reason: 'invalid' });
            expect(parseOffsetInput('1.5', 100)).toEqual({ ok: false, reason: 'invalid' });
            expect(parseOffsetInput('0x', 100)).toEqual({ ok: false, reason: 'invalid' });
            expect(parseOffsetInput('-1', 100)).toEqual({ ok: false, reason: 'range' });
            expect(parseOffsetInput('101', 100)).toEqual({ ok: false, reason: 'range' });
            expect(parseOffsetInput('1', 0)).toEqual({ ok: false, reason: 'range' });
        });

        it('rejects integers beyond the safe addressing range', () => {
            const max = Number.MAX_SAFE_INTEGER;
            expect(parseOffsetInput(String(max), max)).toEqual({ ok: true, offset: max });
            expect(parseOffsetInput('9007199254740992', max)).toEqual({
                ok: false,
                reason: 'range',
            });
        });
    });
});
