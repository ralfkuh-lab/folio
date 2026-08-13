/* Reine Textmanipulation fuer Tasklist-Checkbox-Toggles.
   DOM-frei und unabhaengig von Monaco (Muster wie wikilink-edit.ts), damit
   die Unit-Tests exakt diese Logik direkt testen koennen. */

/**
 * Regex fuer gueltige Markdown-Tasklist-Zeilen (GFM/CommonMark).
 *
 * Unterstuetzt:
 * - Ungeordnete Listen (`-`, `*`, `+`)
 * - Geordnete Listen (`1.`, `1)`)
 * - Fuehrende und verschachtelte Blockquote-Praefixe (`>`, `>>`, `> >`)
 * - Beliebige Einrueckung (Spaces, Tabs)
 *
 * Gruppe 1: Zeilen-Praefix inkl. Einrueckung, Blockquote-Marker, Listenmarker und oeffnender Klammer `[`
 * Gruppe 2: Checkbox-Zustand (` ` fuer unchecked, `x` oder `X` fuer checked)
 * Gruppe 3: Schliessende Klammer `]` und der gesamte verbleibende Zeilenrest
 */
export const TASK_ITEM_REGEX = /^(\s*(?:>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/;

/**
 * Togglet den Zustand einer einzelnen Task-List-Zeile.
 *
 * Tauscht ausschliesslich das Zeichen innerhalb der Klammern (`[ ]` <-> `[x]`).
 * Einrueckung, Listenmarker (`-`, `*`, `+`), Whitespace und der gesamte Rest der
 * Zeile (Text, Wikilinks, Tags etc.) bleiben unveraendert.
 *
 * @param line Die Originalzeile aus dem Markdown-Quelltext.
 * @param expectedChecked Optionaler Stale-Guard: Erwarteter Zustand vor dem Klick
 *                         (true = checked `[x]`/`[X]`, false = unchecked `[ ]`).
 *                         Weicht die Zeile vom erwarteten Zustand ab, wird `null` zurueckgegeben.
 * @returns Die modifizierte Zeile oder `null`, falls die Zeile kein gueltiges Task-Item ist
 *          oder der Stale-Guard greift.
 */
export function toggleTaskListItem(line: string, expectedChecked?: boolean): string | null {
    const match = TASK_ITEM_REGEX.exec(line);
    if (!match) return null;

    const prefix = match[1];
    const marker = match[2];
    const rest = match[3];
    const isCurrentlyChecked = marker === 'x' || marker === 'X';

    if (expectedChecked !== undefined && expectedChecked !== isCurrentlyChecked) {
        return null; // Stale-Guard: Zeile im Editor entspricht nicht dem gerenderten Stand
    }

    const newMarker = isCurrentlyChecked ? ' ' : 'x';
    return prefix + newMarker + rest;
}

export interface TaskToggleEditResult {
    fullText: string;
    changed: boolean;
}

/**
 * Togglet das Task-Item an der 1-basierten Zeilennummer `lineNumber` im Gesamtdokument.
 * Behaelt bestehende Zeilenenden (LF oder CRLF) strikt bei.
 *
 * @param fullText Der vollstaendige Dokumententext.
 * @param lineNumber 1-basierte Zeilennummer (aus `data-line` des gerenderten HTML).
 * @param expectedChecked Optionaler Stale-Guard: Erwarteter Zustand vor dem Klick.
 * @returns Modifiziertes Gesamtdokument mit `changed: true`, oder `null` bei ungueltiger Zeile / Stale-Guard.
 */
export function toggleTaskInDocument(
    fullText: string,
    lineNumber: number,
    expectedChecked?: boolean,
): TaskToggleEditResult | null {
    if (lineNumber < 1) return null;

    const eolRegex = /\r?\n/g;
    let currentLine = 1;
    let lineStart = 0;
    let match: RegExpExecArray | null;

    while (currentLine < lineNumber && (match = eolRegex.exec(fullText)) !== null) {
        currentLine++;
        lineStart = match.index + match[0].length;
    }

    if (currentLine !== lineNumber || lineStart > fullText.length) {
        return null; // Zeilennummer ausserhalb des Dokuments
    }

    eolRegex.lastIndex = lineStart;
    const endMatch = eolRegex.exec(fullText);
    const lineEnd = endMatch ? endMatch.index : fullText.length;

    const lineText = fullText.slice(lineStart, lineEnd);
    const newLineText = toggleTaskListItem(lineText, expectedChecked);
    if (newLineText === null || newLineText === lineText) {
        return null;
    }

    const newFullText = fullText.slice(0, lineStart) + newLineText + fullText.slice(lineEnd);
    return {
        fullText: newFullText,
        changed: true,
    };
}
