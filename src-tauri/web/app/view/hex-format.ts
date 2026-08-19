/* Reine Formatierungs- und Offset-Mathematik fuer die Hex-Ansicht.
   WebKit deckelt Elementhoehen bei rund 33,5 Mio. px. Ein einzelner
   Spacer fuer etwa 1 GB kollabiert deshalb still; danach stimmen
   Scrollposition und Byte-Offset nicht mehr ueberein. Die Ansicht teilt
   Dateien in feste, hoehenbegrenzte Fenster und virtualisiert nur darin. */

export const BYTES_PER_ROW = 16;
export const SAFE_HEIGHT_PX = 8_000_000;
export const MAX_WINDOW_BYTES = 4 * 1024 * 1024;
export const MIN_WINDOW_BYTES = BYTES_PER_ROW;

export type HexLineByte = number | null;
export type HexLineInput = Uint8Array | readonly HexLineByte[];
export type HexLineCell = {
    hex: string;
    ascii: string;
};
export type FormattedHexLine = {
    offset: string;
    bytes: string;
    ascii: string;
};
export type ParsedOffset =
    | { ok: true; offset: number }
    | { ok: false; reason: 'empty' | 'invalid' | 'range' };

const HEX_PLACEHOLDER = '··';
const ASCII_PLACEHOLDER = '·';

function nonNegativeSafeInteger(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function positiveSafeInteger(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(value)));
}

function normalizedWindowBytes(value: number): number {
    const safe = positiveSafeInteger(value, MIN_WINDOW_BYTES);
    return Math.max(MIN_WINDOW_BYTES, Math.floor(safe / BYTES_PER_ROW) * BYTES_PER_ROW);
}

/** Bytezahl eines Fensters fuer die gemessene feste Zeilenhoehe. */
export function windowBytesFor(lineHeightPx: number): number {
    if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) {
        return MIN_WINDOW_BYTES;
    }
    const maxLines = Math.max(1, Math.floor(SAFE_HEIGHT_PX / lineHeightPx));
    // Vor der Multiplikation klemmen, damit auch extrem kleine positive
    // lineHeight-Werte keine unendliche/unsichere Zwischenzahl erzeugen.
    if (maxLines >= MAX_WINDOW_BYTES / BYTES_PER_ROW) {
        return MAX_WINDOW_BYTES;
    }
    return Math.max(MIN_WINDOW_BYTES, maxLines * BYTES_PER_ROW);
}

/** Start der festen, nicht ueberlappenden Seite, die target enthaelt. */
export function windowStartFor(target: number, windowBytes: number): number {
    const safeTarget = nonNegativeSafeInteger(target);
    const pageBytes = normalizedWindowBytes(windowBytes);
    const start = Math.floor(safeTarget / pageBytes) * pageBytes;
    // Der mathematische Wert liegt immer <= target. Der Guard schuetzt
    // zusaetzlich gegen eine Rundung nach oben bei sehr grossen Zahlen.
    return start <= safeTarget ? start : Math.max(0, start - pageBytes);
}

/** Exklusives Fensterende; die Grenzpruefung ist bewusst subtraktiv. */
export function windowEndExclusive(
    windowStart: number,
    windowBytes: number,
    fileSize: number,
): number {
    const size = nonNegativeSafeInteger(fileSize);
    const start = Math.min(nonNegativeSafeInteger(windowStart), size);
    const pageBytes = normalizedWindowBytes(windowBytes);
    const remaining = size - start;
    return remaining <= pageBytes ? size : start + pageBytes;
}

/** Globaler Byte-Offset einer Zeile, ohne Number.MAX_SAFE_INTEGER zu ueberlaufen. */
export function rowOffset(windowStart: number, rowIndex: number): number {
    const start = nonNegativeSafeInteger(windowStart);
    const index = nonNegativeSafeInteger(rowIndex);
    const maxRows = Math.floor((Number.MAX_SAFE_INTEGER - start) / BYTES_PER_ROW);
    return start + Math.min(index, maxRows) * BYTES_PER_ROW;
}

/** Start des Blocks, der offset enthaelt. */
export function chunkStartFor(offset: number, chunkBytes: number): number {
    const safeOffset = nonNegativeSafeInteger(offset);
    const blockBytes = positiveSafeInteger(chunkBytes, 1);
    const start = Math.floor(safeOffset / blockBytes) * blockBytes;
    return start <= safeOffset ? start : Math.max(0, start - blockBytes);
}

/** Feste Offsetbreite fuer ein Dokument, bezogen auf dessen letzten Byte-Offset. */
export function offsetWidthFor(fileSize: number): number {
    const size = nonNegativeSafeInteger(fileSize);
    const lastOffset = size > 0 ? size - 1 : 0;
    return Math.max(8, lastOffset.toString(16).length);
}

/** Kleingeschriebener Hex-Offset mit fuehrenden Nullen. */
export function formatOffset(offset: number, width: number): string {
    const safeOffset = nonNegativeSafeInteger(offset);
    const safeWidth = positiveSafeInteger(width, 1);
    return safeOffset.toString(16).padStart(safeWidth, '0');
}

function byteAt(input: HexLineInput, index: number): HexLineByte | undefined {
    if (index >= input.length) return undefined;
    const value = input[index];
    if (value === null) return null;
    if (!Number.isInteger(value) || value < 0 || value > 0xff) return null;
    return value;
}

/** Eine 16-Byte-Zeile als Zellen; fehlende Eintraege sind EOF-Padding. */
export function formatLineCells(input: HexLineInput): HexLineCell[] {
    const cells: HexLineCell[] = [];
    for (let index = 0; index < BYTES_PER_ROW; index += 1) {
        const value = byteAt(input, index);
        if (value === undefined) {
            cells.push({ hex: '  ', ascii: ' ' });
        } else if (value === null) {
            cells.push({ hex: HEX_PLACEHOLDER, ascii: ASCII_PLACEHOLDER });
        } else {
            cells.push({
                hex: value.toString(16).padStart(2, '0'),
                ascii: value >= 0x20 && value <= 0x7e
                    ? String.fromCharCode(value)
                    : '.',
            });
        }
    }
    return cells;
}

/**
 * Formatiert genau eine 16-Byte-Zeile. Fehlende Array-Eintraege bedeuten
 * EOF-Padding; explizite `null`-Eintraege bedeuten noch nicht geladene Bytes
 * und werden eindeutig als Platzhalter dargestellt.
 */
export function formatLine(
    input: HexLineInput,
    offset: number,
    width: number,
): FormattedHexLine {
    const cells = formatLineCells(input);
    const hexTokens = cells.map(function (cell) { return cell.hex; });
    return {
        offset: formatOffset(offset, width),
        bytes: hexTokens.slice(0, 8).join(' ') + '  ' + hexTokens.slice(8).join(' '),
        ascii: cells.map(function (cell) { return cell.ascii; }).join(''),
    };
}

/** Dezimaler oder 0x-praefigierter Offset innerhalb [0, fileSize]. */
export function parseOffsetInput(raw: string, fileSize: number): ParsedOffset {
    const value = raw.trim();
    if (value.length === 0) return { ok: false, reason: 'empty' };

    const negativeInteger = /^-(?:[0-9]+|0[xX][0-9a-fA-F]+)$/.test(value);
    if (negativeInteger) return { ok: false, reason: 'range' };

    const decimal = /^[0-9]+$/.test(value);
    const hexadecimal = /^0[xX][0-9a-fA-F]+$/.test(value);
    if (!decimal && !hexadecimal) return { ok: false, reason: 'invalid' };

    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
        return { ok: false, reason: 'range' };
    }
    const offset = Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > fileSize) {
        return { ok: false, reason: 'range' };
    }
    return { ok: true, offset };
}
