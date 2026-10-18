/* GFM-Tabellen im Markdown-Quelltext ausrichten (Prettier-Stil).
   Rein, DOM- und Monaco-frei; von beiden Bundles genutzt (editor:
   Formatting-Provider, app: HTML-Paste). Spec: docs/spec-tables.md (T1). */

import { isInsideCodeFence } from './code-fence';

type Align = '' | 'left' | 'right' | 'center';

/** Ersetzt die Zeilen `startLine..endLine` (0-basiert, inklusive). */
export type TableEdit = { startLine: number; endLine: number; lines: string[] };

// Zitat-Marker und Einrückung vor der Tabelle; bleibt unverändert stehen.
const PREFIX_RE = /^(?:[ \t]*>[ \t]?)*[ \t]*/;
const DELIMITER_CELL_RE = /^:?-+:?$/;
// Beginn eines anderen Blocks beendet die Tabelle (GFM): Fence, ATX-
// Überschrift, Listenpunkt. Sonst würde z. B. eine Fence-Zeile mit `|` im
// Info-String als Tabellenzeile umgebaut.
const BLOCK_START_RE = /^(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/;

// Nur Leerzeichen/Tab, wie GFM — `String.trim()` nähme auch NBSP & Co. mit.
function trimCell(text: string): string {
    return text.replace(/^[ \t]+|[ \t]+$/g, '');
}

function splitPrefix(line: string): { prefix: string; body: string } {
    const prefix = (line.match(PREFIX_RE) || [''])[0];
    return { prefix, body: line.slice(prefix.length) };
}

/** Zellen an unmaskierten `|`; `\|` (und jedes andere `\x`) bleibt Inhalt.
 *  Äußere Pipes sind optional. Zellinhalt getrimmt, sonst unverändert. */
function splitCells(body: string): string[] {
    const raw: string[] = [];
    let cur = '';
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '\\' && i + 1 < body.length) {
            cur += ch + body[i + 1];
            i++;
        } else if (ch === '|') {
            raw.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    raw.push(cur);
    const hasSeparator = raw.length > 1;
    if (trimCell(body).startsWith('|')) raw.shift();
    if (hasSeparator && raw.length > 0 && trimCell(raw[raw.length - 1]) === '') raw.pop();
    return raw.map(trimCell);
}

function parseDelimiter(body: string): Align[] | null {
    if (!body.includes('|')) return null;
    const cells = splitCells(body);
    if (cells.length === 0) return null;
    const aligns: Align[] = [];
    for (const c of cells) {
        if (!DELIMITER_CELL_RE.test(c)) return null;
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : '');
    }
    return aligns;
}

// ----- Zeichenbreite --------------------------------------------------------

const segmenter: any = typeof Intl !== 'undefined' && (Intl as any).Segmenter
    ? new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' })
    : null;
const EMOJI_RE = /\p{Emoji_Presentation}|\uFE0F/u;

// East-Asian-Wide/Fullwidth (Hauptblöcke, best effort).
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
    [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
    [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x2fffd],
    [0x30000, 0x3fffd],
];

function isWide(cp: number): boolean {
    for (const [lo, hi] of WIDE_RANGES) {
        if (cp < lo) return false;
        if (cp <= hi) return true;
    }
    return false;
}

/** Anzeigebreite in Monaco-Spalten: Grapheme, CJK-Wide/Emoji = 2. */
export function displayWidth(text: string): number {
    const graphemes: string[] = segmenter
        ? Array.from(segmenter.segment(text), (s: any) => s.segment as string)
        : Array.from(text);
    let width = 0;
    for (const g of graphemes) {
        width += isWide(g.codePointAt(0) || 0) || EMOJI_RE.test(g) ? 2 : 1;
    }
    return width;
}

// ----- Ausgabe -------------------------------------------------------------

function pad(text: string, width: number, align: Align): string {
    const rest = width - displayWidth(text);
    if (rest <= 0) return text;
    if (align === 'right') return ' '.repeat(rest) + text;
    if (align === 'center') {
        const left = Math.floor(rest / 2);
        return ' '.repeat(left) + text + ' '.repeat(rest - left);
    }
    return text + ' '.repeat(rest);
}

function delimiterCell(width: number, align: Align): string {
    if (align === 'left') return ':' + '-'.repeat(width - 1);
    if (align === 'right') return '-'.repeat(width - 1) + ':';
    if (align === 'center') return ':' + '-'.repeat(width - 2) + ':';
    return '-'.repeat(width);
}

function formatTable(prefix: string, header: string[], aligns: Align[], rows: string[][]): string[] {
    const widths = aligns.map((_, i) => {
        let w = Math.max(3, displayWidth(header[i]));
        for (const r of rows) w = Math.max(w, displayWidth(r[i] ?? ''));
        return w;
    });
    const line = (cells: string[]) => {
        const parts = widths.map((w, i) => pad(cells[i] ?? '', w, aligns[i]));
        // Überzählige Zellen (GFM ignoriert sie) bleiben, ungepolstert.
        for (let i = widths.length; i < cells.length; i++) parts.push(cells[i]);
        return prefix + '| ' + parts.join(' | ') + ' |';
    };
    return [
        line(header),
        prefix + '| ' + widths.map((w, i) => delimiterCell(w, aligns[i])).join(' | ') + ' |',
        ...rows.map(line),
    ];
}

// ----- Erkennung -----------------------------------------------------------

type TableHead = { prefix: string; header: string[]; aligns: Align[] };

/** Kopf- + Trennzeile ab `k` (Präfix beider Zeilen egal), sonst null. */
function tableHeadAt(lines: readonly string[], k: number): TableHead | null {
    if (k + 1 >= lines.length) return null;
    const head = splitPrefix(lines[k]);
    if (!head.body.includes('|') || BLOCK_START_RE.test(head.body)) return null;
    const aligns = parseDelimiter(splitPrefix(lines[k + 1]).body);
    if (!aligns) return null;
    const header = splitCells(head.body);
    return header.length === aligns.length ? { prefix: head.prefix, header, aligns } : null;
}

function quoteDepth(prefix: string): number {
    return prefix.split('>').length - 1;
}

/**
 * Edits für alle GFM-Tabellen in `lines`, deren formatierte Fassung vom
 * Bestand abweicht (bereits formatierte Tabellen → kein Edit). Mit `range`
 * (0-basierte Zeilen, inklusive) nur Tabellen, die den Bereich berühren.
 * Tabellen in Code-Fences und Tabellen mit abweichendem Zeilenpräfix bleiben
 * unangetastet.
 *
 * Präfixwechsel: Beginnt auf der Zeile mit anderer Zitat-Tiefe eine eigene
 * Tabelle (Kopf + Trennzeile), endet die bisherige davor — comrak schließt
 * dort den Zitat-Container, beide Tabellen werden einzeln behandelt.
 * Jede andere Abweichung (fehlendes/zusätzliches `>` an einer einzelnen
 * Zeile, anderer Einzug bei gleicher Tiefe, den comrak noch als Zeile
 * derselben Tabelle liest) lässt die Tabelle unverändert: Formatieren hieße
 * dort, Präfixe umzuschreiben oder eine vermutlich gemeinte Zeile
 * abzutrennen.
 */
export function findTableEdits(
    lines: readonly string[],
    range?: { start: number; end: number },
): TableEdit[] {
    const edits: TableEdit[] = [];
    let i = 0;
    while (i + 1 < lines.length) {
        const table = tableHeadAt(lines, i);
        if (!table || isInsideCodeFence(lines, i)) {
            i++;
            continue;
        }
        const { prefix, header, aligns } = table;
        let deviant = splitPrefix(lines[i + 1]).prefix !== prefix;
        let end = i + 1;
        while (end + 1 < lines.length) {
            const next = splitPrefix(lines[end + 1]);
            if (trimCell(next.body) === '' || !next.body.includes('|') || BLOCK_START_RE.test(next.body)) break;
            if (next.prefix !== prefix) {
                const own = quoteDepth(next.prefix) !== quoteDepth(prefix) && tableHeadAt(lines, end + 1);
                if (own && splitPrefix(lines[end + 2]).prefix === next.prefix) break;
                deviant = true;
            }
            end++;
        }
        const start = i;
        i = end + 1;
        if (deviant || (range && (start > range.end || end < range.start))) continue;
        const original = lines.slice(start, end + 1);
        const rows = original.slice(2).map((l) => splitCells(splitPrefix(l).body));
        const formatted = formatTable(prefix, header, aligns, rows);
        if (formatted.every((l, k) => l === original[k])) continue;
        edits.push({ startLine: start, endLine: end, lines: formatted });
    }
    return edits;
}

/** Formatiert alle Tabellen in `text`. Zeilenenden (`\n`/`\r\n`, auch
 *  gemischt) bleiben je Zeile erhalten; Formatieren ändert die Zeilenzahl
 *  einer Tabelle nicht. */
export function formatMarkdownTables(text: string): string {
    const parts = text.split(/(\r?\n)/);
    const lines = parts.filter((_, k) => k % 2 === 0);
    for (const e of findTableEdits(lines)) {
        e.lines.forEach((l, k) => { parts[(e.startLine + k) * 2] = l; });
    }
    return parts.join('');
}
