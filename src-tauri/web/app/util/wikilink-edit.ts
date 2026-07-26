/* Reine Transform des tb-wikilink-Inserts — bewusst DOM-/Monaco-frei in einem
   eigenen Modul (Muster wie util/fuzzy.ts und view/image-transform.ts), damit
   die Unit-Tests exakt DIESE Funktion pinnen statt sie nachzubauen.
   Offsets sind UTF-16-Code-Units, wie FolioEditor.getSelection() sie liefert. */

/** Edit fuer `applyReplace` + Gate, ob das Autocomplete-Widget aufgehen soll. */
export interface WikilinkEdit {
    fullText: string;
    selectionStart: number;
    selectionLength: number;
    /** Nur beim leeren `[[]]`: Autocomplete-Widget oeffnen. */
    suggest: boolean;
}

/**
 * Ohne Selektion: `[[]]` an der Cursorposition, Cursor zwischen die inneren
 * Klammern, Suggest an (die `[[`-Completion aus editor/wikilink-complete.ts
 * greift dort). Mit Selektion: `[[sel]]`, Cursor hinter die schliessenden
 * Klammern, kein Suggest — der Name steht ja schon.
 */
export function computeWikilinkEdit(text: string, start: number, length: number): WikilinkEdit {
    if (length === 0) {
        return {
            fullText: text.slice(0, start) + '[[]]' + text.slice(start),
            selectionStart: start + 2,
            selectionLength: 0,
            suggest: true,
        };
    }
    const wrapped = '[[' + text.slice(start, start + length) + ']]';
    return {
        fullText: text.slice(0, start) + wrapped + text.slice(start + length),
        selectionStart: start + wrapped.length,
        selectionLength: 0,
        suggest: false,
    };
}
