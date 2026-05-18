// Text-, Selection-, Scroll-, Replace- und Sprach-Operationen auf der
// laufenden Monaco-Instanz. Reine Reads (getText/getSelection/...) sind
// best-effort: liefern Defaults, solange `mount()` nicht durch ist.
// Programmatic Writes (`applyReplace`, `setSelection`) deferren auf
// `whenReady()`, damit Pre-Mount-Calls nicht silent verloren gehen.

import { post } from './bridge';
import { hasActiveTerm, recomputeMatches } from './find';
import { layout, whenReady } from './mount';
import { getEditor, getMonaco, withProgrammaticWrite } from './state';

export function getText(): string {
    const editor = getEditor();
    return editor ? editor.getValue() : '';
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
        whenReady().then(() => setLanguage(language));
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
        whenReady().then(() => setSelection(start, length));
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

export function getScroll(): number {
    const editor = getEditor();
    return editor ? editor.getScrollTop() : 0;
}

export function setScroll(y: number): void {
    const editor = getEditor();
    if (!editor) {
        whenReady().then(() => setScroll(y));
        return;
    }
    editor.setScrollTop(Math.max(0, y));
}

export function applyReplace(args: {
    fullText: string;
    selectionStart: number;
    selectionLength: number;
}): void {
    const editor = getEditor();
    if (!editor) {
        whenReady().then(() => applyReplace(args));
        return;
    }
    const model = editor.getModel();
    if (!model) return;
    const monaco = getMonaco();

    withProgrammaticWrite(() => {
        editor.setValue(args.fullText || '');
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
        editor.revealPositionInCenterIfOutsideViewport(startPos);
    });
    post({ type: 'editorTextChanged', text: editor.getValue() });
    // Nach apply_editor_command (Bold-Wrap etc.) Decorations refreshen,
    // aber den eben gesetzten Selektions-Cursor NICHT durch Sprung zur
    // naechsten Fundstelle ueberschreiben.
    if (hasActiveTerm()) recomputeMatches(false);
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

export function redo(): void {
    const editor = getEditor();
    if (!editor) return;
    editor.focus();
    editor.trigger('menu', 'redo', null);
}
