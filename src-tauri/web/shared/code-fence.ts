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

/**
 * True, wenn die Zeile `lineIndex` (0-basiert) in einem Code-Fence liegt.
 * Scannt Zeilen `0..lineIndex-1` nach CommonMark: Öffner ```/~~~ (bei
 * Backticks ohne Backtick im Info-String), Schließer gleiches Zeichen,
 * ≥ Länge, danach nur Leerraum, in derselben Zitat-Tiefe. Zitat-Präfixe
 * (`>`, verschachtelt) werden vorher abgeschnitten; sinkt die Zitat-Tiefe
 * unter die des Öffners, endet die Fence mit ihrem Container (auch auf der
 * gefragten Zeile). Lazy continuation wird nicht modelliert.
 */
export function isInsideCodeFence(lines: readonly string[], lineIndex: number): boolean {
    let open: { ch: string; len: number; depth: number } | null = null;
    const limit = Math.min(lineIndex, lines.length);
    for (let i = 0; i < limit; i++) {
        const { depth, rest } = stripQuotes(lines[i] ?? '');
        if (open && depth < open.depth) open = null;
        // Fence-Zeile: optionaler Indent + ```… / ~~~… nach dem Zitat-Präfix.
        const m = rest.match(/^[\t ]*(`{3,}|~{3,})(.*)$/);
        if (!m) continue;
        const fence = m[1];
        const ch = fence[0];
        const len = fence.length;
        if (!open) {
            if (ch === '`' && m[2].includes('`')) continue;
            open = { ch, len, depth };
        } else if (open.ch === ch && len >= open.len && depth === open.depth
            && m[2].trim() === '') {
            open = null;
        }
    }
    if (open && lineIndex < lines.length
        && stripQuotes(lines[lineIndex] ?? '').depth < open.depth) {
        return false;
    }
    return open !== null;
}
