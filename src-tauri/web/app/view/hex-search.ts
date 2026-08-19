/* DOM-freie Suchmathematik fuer die Hex-Ansicht: Pattern-Parser,
   Wrap-around-Plan und Zeilen-Highlight-Bereiche. */

import { BYTES_PER_ROW, formatOffset } from './hex-format';

export type HexPatternMode = 'text' | 'hex';

export type ParsedHexPattern =
    | { ok: true; bytes: number[] }
    | { ok: false; reason: 'empty' | 'invalid' };

export type HexSearchPlan = {
    from: number;
    wrapFrom: number | null;
};

export type HexRowHighlight = {
    start: number;
    end: number;
};

const HEX_DIGIT = /[0-9a-fA-F]/;

function nonNegativeSafeInteger(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

/** Text → UTF-8-Bytes; Hex → tolerant gegen Leerzeichen, Kommas und 0x. */
export function parseHexSearchPattern(raw: string, mode: HexPatternMode): ParsedHexPattern {
    if (mode === 'text') {
        if (raw.length === 0) return { ok: false, reason: 'empty' };
        return { ok: true, bytes: Array.from(new TextEncoder().encode(raw)) };
    }

    const tokens = raw.split(/[\s,]+/);
    const digits: string[] = [];
    for (let t = 0; t < tokens.length; t += 1) {
        let body = tokens[t];
        if (!body) continue;
        if (body.length >= 2 && body.charCodeAt(0) === 48 && (body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88)) {
            body = body.slice(2);
        }
        if (!body) continue;
        for (let i = 0; i < body.length; i += 1) {
            const ch = body.charAt(i);
            if (!HEX_DIGIT.test(ch)) return { ok: false, reason: 'invalid' };
            digits.push(ch);
        }
    }
    if (digits.length === 0) return { ok: false, reason: 'empty' };
    if (digits.length % 2 !== 0) return { ok: false, reason: 'invalid' };

    const bytes: number[] = [];
    for (let i = 0; i < digits.length; i += 2) {
        bytes.push(parseInt(digits[i] + digits[i + 1], 16));
    }
    return { ok: true, bytes };
}

/**
 * Naechster Backend-`from`-Wert plus einmaliges Wrap-Ziel.
 * `current === null` startet am Dateianfang (vorwaerts) bzw. am EOF (rueckwaerts).
 * Wrap-around ist Sache des Aufrufers: `wrapFrom === null` heisst, ein
 * zweiter Call waere derselbe Start und darf nicht als Neuversuch laufen.
 *
 * Richtungsasymmetrie ist der Backend-Vertrag, kein Versehen: vorwaerts ist
 * `from` die **inklusive** Untergrenze (deshalb `current + 1`, sonst faende
 * der Scan denselben Treffer erneut), rueckwaerts die **exklusive**
 * Obergrenze (deshalb `current`, nicht `current - 1` — sonst uebersprungen
 * der Scan den direkten Nachbarn bei `current - 1`).
 */
export function planHexSearch(args: {
    current: number | null;
    backwards: boolean;
    fileSize: number;
}): HexSearchPlan {
    const fileSize = nonNegativeSafeInteger(args.fileSize);
    const eof = fileSize;
    if (fileSize <= 0) return { from: 0, wrapFrom: null };

    if (args.current === null || !Number.isFinite(args.current)) {
        return args.backwards
            ? { from: eof, wrapFrom: null }
            : { from: 0, wrapFrom: null };
    }

    const current = Math.min(Math.max(0, Math.floor(args.current)), fileSize);
    if (args.backwards) {
        if (current <= 0) return { from: eof, wrapFrom: null };
        return { from: current, wrapFrom: current >= eof ? null : eof };
    }
    if (current + 1 >= fileSize) return { from: 0, wrapFrom: null };
    return { from: current + 1, wrapFrom: 0 };
}

/** Byte-Indizes (0..16) in einer 16-Byte-Zeile, die den Treffer schneiden. */
export function rowHighlightRange(
    rowStart: number,
    matchOffset: number,
    matchLength: number,
): HexRowHighlight | null {
    if (!Number.isFinite(matchLength) || matchLength <= 0) return null;
    if (!Number.isFinite(matchOffset) || matchOffset < 0) return null;
    if (!Number.isFinite(rowStart) || rowStart < 0) return null;
    const rowEnd = rowStart + BYTES_PER_ROW;
    const matchEnd = matchOffset + matchLength;
    const start = Math.max(rowStart, matchOffset);
    const end = Math.min(rowEnd, matchEnd);
    if (end <= start) return null;
    return { start: start - rowStart, end: end - rowStart };
}

/** Zaehler-Label analog zur Spec-Beispielform `0x00600012`. */
export function formatMatchOffset(offset: number): string {
    const safe = nonNegativeSafeInteger(offset);
    const width = Math.max(8, safe.toString(16).length);
    return '0x' + formatOffset(safe, width);
}
