/* Code-Fence-Erkennung für Markdown-Zeilen (CommonMark, inkl. Zitat-
   Tiefe). Rein, DOM- und Monaco-frei; von beiden Bundles genutzt
   (editor: Autocomplete/Smart-List/Tabellen-Formatierer, app: HTML-Paste). */

/** Zitat-Tiefe (Anzahl `>`) und Zeilenrest dahinter. */
function stripQuotes(line: string): { depth: number; rest: string } {
    let depth = 0;
    let rest = line;
    for (let m = rest.match(/^[\t ]*>[\t ]?/); m; m = rest.match(/^[\t ]*>[\t ]?/)) {
        depth += 1;
        rest = rest.slice(m[0].length);
    }
    return { depth, rest };
}

// Listenmarker (auch verschachtelt, `- 1. `) direkt vor einem Fence-Öffner.
const LIST_MARKERS_RE = /^(?:[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)+/;

/** Spaltenbreite des führenden Leerraums (Tab → nächster 4er-Stopp). */
function indentWidth(text: string): number {
    let col = 0;
    for (const ch of text) {
        if (ch === ' ') col += 1;
        else if (ch === '\t') col += 4 - (col % 4);
        else break;
    }
    return col;
}

/** Spaltenbreite von `text` (nur Leerraum und Markerzeichen erwartet). */
function columnWidth(text: string): number {
    let col = 0;
    for (const ch of text) col += ch === '\t' ? 4 - (col % 4) : 1;
    return col;
}

/**
 * True, wenn die Zeile `lineIndex` (0-basiert) in einem Code-Fence liegt.
 * Scannt Zeilen `0..lineIndex-1` nach CommonMark: Öffner ```/~~~ (bei
 * Backticks ohne Backtick im Info-String), Schließer gleiches Zeichen,
 * ≥ Länge, danach nur Leerraum, in derselben Zitat-Tiefe. Zitat-Präfixe
 * (`>`, verschachtelt) werden vorher abgeschnitten; sinkt die Zitat-Tiefe
 * unter die des Öffners, endet die Fence mit ihrem Container (auch auf der
 * gefragten Zeile). Ein Öffner direkt hinter Listenmarkern (`- ```js`,
 * `> 1. ~~~`) zählt ebenfalls; seine Fence endet zusätzlich, sobald eine
 * nicht leere Zeile weniger eingerückt ist als der Inhalt des Listenpunkts.
 * Lazy continuation wird nicht modelliert.
 */
export function isInsideCodeFence(lines: readonly string[], lineIndex: number): boolean {
    // indent: Inhaltseinzug des Listenpunkts eines Öffners mit Marker, sonst 0.
    let open: { ch: string; len: number; depth: number; indent: number } | null = null;
    const leftContainer = (depth: number, rest: string): boolean => !!open
        && (depth < open.depth
            || (open.indent > 0 && depth === open.depth && rest.trim() !== ''
                && indentWidth(rest) < open.indent));
    const limit = Math.min(lineIndex, lines.length);
    for (let i = 0; i < limit; i++) {
        const quoted = stripQuotes(lines[i] ?? '');
        const depth = quoted.depth;
        let rest = quoted.rest;
        if (leftContainer(depth, rest)) open = null;
        let indent = 0;
        if (!open) {
            // Markerzeichen sind innerhalb einer offenen Fence nur Inhalt.
            const marker = rest.match(LIST_MARKERS_RE);
            if (marker) {
                indent = columnWidth(marker[0]);
                rest = rest.slice(marker[0].length);
            }
        }
        // Fence-Zeile: optionaler Indent + ```… / ~~~… nach dem Zitat-Präfix.
        const m = rest.match(/^[\t ]*(`{3,}|~{3,})(.*)$/);
        if (!m) continue;
        const fence = m[1];
        const ch = fence[0];
        const len = fence.length;
        if (!open) {
            if (ch === '`' && m[2].includes('`')) continue;
            open = { ch, len, depth, indent };
        } else if (open.ch === ch && len >= open.len && depth === open.depth
            && m[2].trim() === '') {
            open = null;
        }
    }
    if (open && lineIndex < lines.length) {
        const { depth, rest } = stripQuotes(lines[lineIndex] ?? '');
        if (leftContainer(depth, rest)) return false;
    }
    return open !== null;
}
