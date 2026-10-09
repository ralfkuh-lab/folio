/* Smart-List-Fortsetzung für Markdown (Enter/Tab im Haupt-Editor).
   Reine Zeilen-Logik, DOM- und Monaco-frei (vitest). Die Monaco-
   Anbindung sitzt in `events.ts`. */

/** Ersetzt im Zeilentext `[from, to)` (0-basierte Spalten) durch `text`;
 *  der Cursor steht danach am Ende von `text`. */
export type ListEdit = { from: number; to: number; text: string };

type ListPrefix = {
    /** Blockquote-Präfix inkl. Einrückung davor, z. B. `> > `. */
    quote: string;
    /** Listen-Teil hinter dem Zitat; null = reine Zitatzeile. */
    list: {
        indent: string;
        bullet: string | null;
        number: number | null;
        delimiter: string;
        spacing: string;
        /** Whitespace hinter `[ ]`/`[x]`; null = kein Task-Item. */
        taskSpacing: string | null;
    } | null;
    /** Länge des gesamten Präfixes; davor ist der Cursor „im Marker“. */
    end: number;
};

const QUOTE_RE = /^(?:[ \t]*>[ \t]?)*/;
// Marker braucht Whitespace dahinter: `-foo`, `1.foo`, `---`, `**fett**`
// sind keine Listenpunkte.
const LIST_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)/;
const TASK_RE = /^\[([ xX])\]([ \t]+|$)/;
// CommonMark: `* * *`, `- - -` sind Trennlinien, keine Listen.
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

function parsePrefix(line: string): ListPrefix | null {
    const quote = (line.match(QUOTE_RE) || [''])[0];
    const body = line.slice(quote.length);
    if (THEMATIC_BREAK_RE.test(body)) return null;
    const m = body.match(LIST_RE);
    if (!m) {
        if (!quote) return null;
        return { quote, list: null, end: quote.length };
    }
    let end = quote.length + m[0].length;
    let taskSpacing: string | null = null;
    const t = line.slice(end).match(TASK_RE);
    if (t) {
        taskSpacing = t[2];
        end += t[0].length;
    }
    return {
        quote,
        list: {
            indent: m[1],
            bullet: m[2] || null,
            number: m[3] ? parseInt(m[3], 10) : null,
            delimiter: m[4] || '',
            spacing: m[5],
            taskSpacing,
        },
        end,
    };
}

/**
 * Edit für Enter an Spalte `column` (0-basiert) oder `null`, wenn das
 * Standard-Enter greifen soll.
 */
export function continueListEdit(
    line: string,
    column: number,
    inCodeFence: boolean,
): ListEdit | null {
    if (inCodeFence) return null;
    const p = parsePrefix(line);
    if (!p || column < p.end) return null;

    if (line.slice(p.end).trim() === '') {
        // Leeres Item beendet die Liste: Listenteil entfernen, ein
        // umgebendes Zitat bleibt stehen; leeres Zitat wird ganz geleert.
        const keep = p.list ? p.quote : '';
        return { from: 0, to: line.length, text: keep };
    }

    let next = p.quote;
    const l = p.list;
    if (l) {
        const marker = l.bullet !== null
            ? l.bullet
            : String((l.number as number) + 1) + l.delimiter;
        next += l.indent + marker + l.spacing;
        if (l.taskSpacing !== null) next += '[ ]' + (l.taskSpacing || ' ');
    }
    return { from: column, to: column, text: '\n' + next };
}

/** Listenzeile (inkl. Task-Item, ohne reine Zitatzeile) für Tab/Shift+Tab. */
export function isListItemLine(line: string, inCodeFence: boolean): boolean {
    if (inCodeFence) return false;
    const p = parsePrefix(line);
    return !!(p && p.list);
}
