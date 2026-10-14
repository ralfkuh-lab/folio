// Text-, Selection-, Scroll-, Replace- und Sprach-Operationen auf der
// laufenden Monaco-Instanz. Reine Reads (getText/getSelection/...) sind
// best-effort: liefern Defaults, solange `mount()` nicht durch ist.
// Programmatic Writes (`applyReplace`, `setSelection`) deferren via
// `deferUntilMounted` (single-shot auf whenReady + Editor-Guard),
// damit Pre-Mount-Calls nicht silent verloren gehen und niemals eine
// Endlos-Microtask-Schleife entsteht.

import { post } from './bridge';
import { hasActiveTerm, recomputeMatches } from './find';
import { layout, whenReady } from './mount';
import { getEditor, getMonaco, withProgrammaticWrite } from './state';
import { isInsideCodeFence } from './wikilink-complete';

// Pre-Mount-Defer: genau EIN Retry nach dem ersten Mount, und nur wenn
// der Editor dann wirklich existiert. Niemals unbedingt rekursieren —
// ein resolved whenReady() ohne Editor (fehlgeschlagener Mount) wuerde
// sonst zur Endlos-Microtask-Schleife, die den JS-Thread verhungern
// laesst (Boot-Killer-Bug 2026-05-19 und 2026-07-04).
function deferUntilMounted(retry: () => void): void {
    whenReady().then(() => {
        if (getEditor()) retry();
    });
}

export function getText(): string {
    const editor = getEditor();
    return editor ? editor.getValue() : '';
}

export function getVersionId(): number | null {
    const editor = getEditor();
    if (!editor) return null;
    const model = editor.getModel();
    return model ? model.getVersionId() : null;
}

export function getLanguage(): string {
    const editor = getEditor();
    if (!editor) return '';
    const model = editor.getModel();
    return model ? model.getLanguageId() : '';
}

export function setLanguage(language: string): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => setLanguage(language));
        return;
    }
    const monaco = getMonaco();
    const model = editor.getModel();
    if (!model) return;
    const lang = (language && language.trim()) || 'plaintext';
    if (model.getLanguageId() === lang) return;
    monaco.editor.setModelLanguage(model, lang);
}

export function listLanguages(): Array<{ id: string; label: string; aliases: string[] }> {
    const monaco = getMonaco();
    if (!monaco) return [];
    return monaco.languages.getLanguages().map((l: any) => {
        const aliases: string[] = Array.isArray(l.aliases) ? l.aliases.slice() : [];
        const label = aliases[0] || l.id;
        return { id: l.id, label, aliases };
    });
}

export function getSelection(): { start: number; length: number } {
    const editor = getEditor();
    if (!editor) return { start: 0, length: 0 };
    const model = editor.getModel();
    if (!model) return { start: 0, length: 0 };
    const sel = editor.getSelection();
    if (!sel) return { start: 0, length: 0 };
    const start = model.getOffsetAt(sel.getStartPosition());
    const end = model.getOffsetAt(sel.getEndPosition());
    return { start, length: end - start };
}

export function setSelection(start: number, length: number): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => setSelection(start, length));
        return;
    }
    const model = editor.getModel();
    if (!model) return;
    const monaco = getMonaco();
    const docLen = model.getValueLength();
    const from = Math.max(0, Math.min(start, docLen));
    const to = Math.max(0, Math.min(start + length, docLen));
    const startPos = model.getPositionAt(from);
    const endPos = model.getPositionAt(to);
    editor.setSelection(
        new monaco.Selection(
            startPos.lineNumber,
            startPos.column,
            endPos.lineNumber,
            endPos.column,
        ),
    );
}

/**
 * Springt zu einer Fundstelle (Vault-Suche): zentriert die Zeile und selektiert
 * den Treffer. Monaco-Spalten sind 1-basiert in UTF-16-Code-Units — exakt das
 * `colUtf16`/`lenUtf16`-Format aus `search.rs`, daher keine Umrechnung nötig.
 */
export function revealMatch(line: number, colUtf16: number, lenUtf16: number): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => revealMatch(line, colUtf16, lenUtf16));
        return;
    }
    const model = editor.getModel();
    if (!model) return;
    const monaco = getMonaco();
    const ln = Math.max(1, Math.min(Math.floor(line || 1), model.getLineCount()));
    const maxCol = model.getLineMaxColumn(ln);
    const startCol = Math.max(1, Math.min(Math.floor(colUtf16 || 1), maxCol));
    const endCol = Math.max(startCol, Math.min(startCol + Math.max(0, Math.floor(lenUtf16 || 0)), maxCol));
    editor.setSelection(new monaco.Selection(ln, startCol, ln, endCol));
    if (typeof editor.revealLineInCenter === 'function') {
        editor.revealLineInCenter(ln);
    } else {
        revealLineNearTop(ln);
    }
    editor.focus();
}

export function getScroll(): number {
    const editor = getEditor();
    return editor ? editor.getScrollTop() : 0;
}

export function getCursorLine(): number {
    const editor = getEditor();
    if (!editor) return 0;
    const pos = editor.getPosition();
    return pos ? pos.lineNumber : 0;
}

export function revealLineNearTop(line: number): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => revealLineNearTop(line));
        return;
    }
    const target = Math.max(1, Math.floor(line || 1));
    if (typeof editor.revealLineNearTop === 'function') {
        editor.revealLineNearTop(target);
        return;
    }
    if (typeof editor.getTopForLineNumber === 'function') {
        editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(target) - 80));
    }
}

export function revealLineFractionNearTop(line: number): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => revealLineFractionNearTop(line));
        return;
    }

    const target = Math.max(1, line || 1);
    if (typeof editor.getTopForLineNumber !== 'function' || typeof editor.setScrollTop !== 'function') {
        revealLineNearTop(Math.round(target));
        return;
    }

    const lowerLine = Math.max(1, Math.floor(target));
    const upperLine = Math.max(lowerLine, Math.ceil(target));
    const lowerTop = editor.getTopForLineNumber(lowerLine);
    const upperTop = editor.getTopForLineNumber(upperLine);
    const ratio = upperLine === lowerLine ? 0 : target - lowerLine;
    const top = lowerTop + (upperTop - lowerTop) * ratio;
    editor.setScrollTop(Math.max(0, top - 80));
}

export function setScroll(y: number): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => setScroll(y));
        return;
    }
    editor.setScrollTop(Math.max(0, y));
}

export function getScrollHeight(): number {
    const editor = getEditor();
    return editor && typeof editor.getScrollHeight === 'function'
        ? editor.getScrollHeight() : 0;
}

export function getVisibleHeight(): number {
    const editor = getEditor();
    if (!editor) return 0;
    const layout = typeof editor.getLayoutInfo === 'function'
        ? editor.getLayoutInfo() : null;
    return layout ? layout.height : 0;
}

export function applyReplace(args: {
    fullText: string;
    selectionStart: number;
    selectionLength: number;
    noReveal?: boolean;
}): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => applyReplace(args));
        return;
    }
    const model = editor.getModel();
    if (!model) return;
    const monaco = getMonaco();

    withProgrammaticWrite(() => {
        // executeEdits statt setValue: ein Voll-Range-Replace landet
        // als EIN Edit im Monaco-Undo-Stack, undo-bar wie ein regulaerer
        // User-Edit. `setValue` ist Monacos Hard-Reset und clearet den
        // Stack — Toolbar-Befehle (Bold-Wrap, Heading-Toggle, ...) waeren
        // sonst destruktiv fuer die Edit-Historie. Siehe
        // docs/e2e-headless-caveats.md Abschnitt 7 fuer die Diagnose.
        //
        // pushUndoStop davor und danach: ohne den expliziten Stop
        // verschmilzt Monaco unseren Voll-Range-Replace mit einem
        // unmittelbar vorhergegangenen Type-Edit (z.B. ein insertText
        // gefolgt von tb-bold) zu einem einzigen Undo-Eintrag — Undo
        // entfernt dann beides auf einmal, der Type-Edit ist nicht
        // separat rueckgaengig zu machen (Regression-Sperre in
        // 09_undo_redo: Bold-Wrap muss undo-bar sein OHNE den
        // vorherigen "X"-Insert mitzunehmen).
        editor.pushUndoStop();
        const fullRange = model.getFullModelRange();
        editor.executeEdits('applyReplace', [{
            range: fullRange,
            text: args.fullText || '',
        }]);
        editor.pushUndoStop();
        const startPos = model.getPositionAt(args.selectionStart || 0);
        const endPos = model.getPositionAt(
            (args.selectionStart || 0) + (args.selectionLength || 0),
        );
        editor.setSelection(
            new monaco.Selection(
                startPos.lineNumber,
                startPos.column,
                endPos.lineNumber,
                endPos.column,
            ),
        );
        if (!args.noReveal) {
            editor.revealPositionInCenterIfOutsideViewport(startPos);
        }
    });
    post({ type: 'editorTextChanged', text: editor.getValue() });
    // Nach apply_editor_command (Bold-Wrap etc.) Decorations refreshen,
    // aber den eben gesetzten Selektions-Cursor NICHT durch Sprung zur
    // naechsten Fundstelle ueberschreiben.
    if (hasActiveTerm()) recomputeMatches(false);
}

/**
 * Fuegt konvertiertes Markdown als EINEN Undo-Schritt an der aktuellen
 * Selektion ein (Paste-Handler, Strg+V im Markdown-Editor). Bewusst
 * `executeEdits` statt `trigger('type')`: kein Auto-Closing/Auto-Indent,
 * der Text landet byte-genau. `false` = nichts eingefuegt und nichts
 * getan — der Aufrufer laesst dann Monacos Default-Paste greifen.
 */
export function pasteText(text: string): boolean {
    const editor = getEditor();
    if (!editor) return false; // kein Defer: Pre-Mount darf nichts einhängen
    const model = editor.getModel();
    if (!model) return false;
    if (model.getLanguageId() !== 'markdown') return false;
    const monaco = getMonaco();
    // Read-only vor JEDER Schreiboperation (auch pushUndoStop) pruefen —
    // executeEdits liefert sonst still false, ohne etwas zu schreiben.
    if (typeof editor.getOption === 'function' && monaco && monaco.editor
        && monaco.editor.EditorOption
        && editor.getOption(monaco.editor.EditorOption.readOnly)) {
        return false;
    }
    const selections = typeof editor.getSelections === 'function' ? editor.getSelections() : null;
    if (!selections || selections.length !== 1) return false;
    const sel = selections[0];
    const startPos = sel.getStartPosition();
    const endPos = sel.getEndPosition();
    const lines = model.getLinesContent();
    const lineIndex = startPos.lineNumber - 1;
    // In der Fence oder auf der Fence-Zeile selbst: nicht einmischen.
    // Ein Statuswechsel zwischen Zeile und Folgezeile markiert genau eine
    // Fence-Zeile (Oeffner: false→true, Schliesser: true→false).
    if (isInsideCodeFence(lines, lineIndex)) return false;
    if (isInsideCodeFence(lines, lineIndex) !== isInsideCodeFence(lines, lineIndex + 1)) {
        return false;
    }

    const insert = text || '';
    let caret = startPos;
    let ok = false;
    withProgrammaticWrite(() => {
        editor.pushUndoStop();
        ok = editor.executeEdits('folio.pasteText', [{
            range: new monaco.Range(
                startPos.lineNumber,
                startPos.column,
                endPos.lineNumber,
                endPos.column,
            ),
            text: insert,
            forceMoveMarkers: true,
        }], (inverse: any[]) => {
            // Monacos inverse Operation liefert den Range des eingefuegten
            // Texts. Dessen Ende ist die korrekte Caret-Position — auch in
            // CRLF-Modellen, die `insert` auf `\r\n` normalisieren, wo
            // `Offset + insert.length` zu kurz greifen wuerde.
            const range = inverse && inverse[0] && inverse[0].range;
            if (range) {
                caret = typeof range.getEndPosition === 'function'
                    ? range.getEndPosition()
                    : { lineNumber: range.endLineNumber, column: range.endColumn };
            }
            return [new monaco.Selection(
                caret.lineNumber,
                caret.column,
                caret.lineNumber,
                caret.column,
            )];
        }) !== false;
        editor.pushUndoStop();
        editor.revealPositionInCenterIfOutsideViewport(caret);
    });
    if (!ok) return false;
    post({ type: 'editorTextChanged', text: editor.getValue() });
    if (hasActiveTerm()) recomputeMatches(false);
    return true;
}

export function focus(): void {
    const editor = getEditor();
    if (!editor) return;
    layout();
    editor.focus();
}

export function undo(): void {
    const editor = getEditor();
    if (!editor) return;
    editor.focus();
    editor.trigger('menu', 'undo', null);
}

// Realistische Texteingabe ueber Monacos eigenen Keyboard-Type-Trigger.
// Anders als `applyReplace` (das via setValue() den Undo-Stack clearet)
// landet das Insert hier korrekt als Edit-Operation im Stack — dadurch
// werden `undo`/`redo` von oben testbar und Synthetic-KeyboardEvents
// (die in Monaco fragil sind) vermieden.
export function insertText(text: string): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => insertText(text));
        return;
    }
    editor.focus();
    editor.trigger('automation', 'type', { text: text || '' });
}

export function redo(): void {
    const editor = getEditor();
    if (!editor) return;
    editor.focus();
    editor.trigger('menu', 'redo', null);
}

/** Opens Monaco's suggest widget on the main editor (e.g. after inserting `[[`). */
export function triggerSuggest(): void {
    const editor = getEditor();
    if (!editor) {
        deferUntilMounted(() => triggerSuggest());
        return;
    }
    editor.focus();
    editor.trigger('folio', 'editor.action.triggerSuggest', null);
}
