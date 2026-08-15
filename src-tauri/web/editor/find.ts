// Find subsystem for Monaco-backed surfaces. Owns the find-term state,
// match list, Monaco decorations, and the public open/close/next/prev
// API exposed via window.FolioEditor and window.FolioCodeView.

import { post } from './bridge';
import { getEditor, getMonaco } from './state';

/** Expand `$1`/`$2`/`$&`/`$0`/`$$` against Monaco capture groups (index 0 = full match). */
export function expandFindReplacement(template: string, groups: string[]): string {
    return template.replace(/\$(\$|&|0|[1-9][0-9]?)/g, function (_all, which: string) {
        if (which === '$') return '$';
        if (which === '&' || which === '0') return groups[0] ?? '';
        const n = Number(which);
        return groups[n] ?? '';
    });
}

interface FindMatch {
    from: number;
    to: number;
    groups?: string[] | null;
}

/** Decoration / counter cap. Replace-all uses REPLACE_ALL_CAP and refuses above it. */
export const FIND_DISPLAY_CAP = 5000;
/** Safety cap for replace-all. Hitting it rejects before any mutation. */
export const REPLACE_ALL_CAP = 100000;

export function findRegexFlags(caseSensitive: boolean): string {
    return caseSensitive ? 'gu' : 'giu';
}

interface FindStateSnapshot {
    term: string;
    total: number;
    active: number;
    matches: FindMatch[];
    capped?: boolean;
    invalidRegex?: boolean;
    replaceLimited?: boolean;
}

interface FindControllerOptions {
    getEditor: () => any;
    getMonaco: () => any;
    source: 'editor' | 'code-view';
    postToBridge?: boolean;
}

export interface FindController {
    openFind(initialTerm?: string): void;
    closeFind(): void;
    setFindTerm(term: string): void;
    setFindOptions(opts: ResolvedFindOptions): void;
    findNext(): void;
    findPrev(): void;
    replaceCurrent(replacement: string): boolean;
    replaceAll(replacement: string, opts?: { inSelection?: boolean }): boolean;
    recomputeMatches(revealActive?: boolean): void;
    hasActiveTerm(): boolean;
    setSuppressActive(on: boolean): void;
    clearFindDecorations(): void;
}

export function createFindController(opts: FindControllerOptions): FindController {
    let findState: FindStateSnapshot = { term: '', total: 0, active: -1, matches: [] };
    const findOptions: { caseSensitive: boolean; wholeWord: boolean; regex: boolean } = {
        caseSensitive: false,
        wholeWord: false,
        regex: false,
    };
    let matchDecorations: string[] = [];
    let lastDecoratedModel: any = null;
    let suppressActive = false;

    function activeForDecoration(idx: number): boolean {
        return !suppressActive && idx === findState.active;
    }

    function recomputeMatches(revealActive: boolean = true): void {
        const editor = opts.getEditor();
        const monaco = opts.getMonaco();
        if (!editor || !monaco) return;

        const model = editor.getModel();
        if (!model) return;
        if (model !== lastDecoratedModel) {
            matchDecorations = [];
            lastDecoratedModel = model;
        }

        const term = findState.term;
        if (!term) {
            findState = { term: '', total: 0, active: -1, matches: [], capped: false };
            clearDecorations();
            publishFindState();
            return;
        }

        if (findOptions.regex) {
            try {
                // Flags wie Monaco (`gu`/`giu`) — sonst weicht die
                // Vorvalidierung von findMatches ab (Unicode-Escapes).
                new RegExp(term, findRegexFlags(findOptions.caseSensitive));
            } catch {
                findState = { term, total: 0, active: -1, matches: [], capped: false, invalidRegex: true };
                clearDecorations();
                publishFindState();
                return;
            }
        }

        // Use Monaco's optimized model.findMatches (Befund 4).
        // wholeWord: pass separators from options (or default) so that
        // Monaco applies word-boundary logic; behavior matched to prior
        // custom impl via vitest equivalence. Regex + wholeWord is
        // disabled in the find-bar (same restriction as vault search).
        const wordSeparators = resolveWordSeparators(editor, monaco);

        const rawMatches: any[] = model.findMatches(
            term,
            false, // searchOnlyEditableRange
            !!findOptions.regex,
            !!findOptions.caseSensitive,
            wordSeparators,
            !!findOptions.regex, // captureMatches — $1/$2 for replace
            FIND_DISPLAY_CAP,
        ) || [];

        const matches: FindMatch[] = [];
        for (let i = 0; i < rawMatches.length; i++) {
            const rm = rawMatches[i];
            const r = rm && rm.range;
            if (!r) continue;
            const startPos = { lineNumber: r.startLineNumber, column: r.startColumn };
            const endPos = { lineNumber: r.endLineNumber, column: r.endColumn };
            const from = model.getOffsetAt(startPos);
            const to = model.getOffsetAt(endPos);
            matches.push({ from, to, groups: rm.matches || null });
        }

        const capped = rawMatches.length >= FIND_DISPLAY_CAP;

        // Aktiven Treffer aus dem Selektions-START ableiten (nicht aus
        // getPosition): scrollMatchIntoView selektiert den Treffer, der
        // Cursor steht danach am Treffer-ENDE. Mit getPosition wuerde beim
        // Weitertippen des Suchbegriffs ("fo" -> "foo") der aktive Treffer
        // pro Zeichen einen Treffer weiterspringen.
        const sel = editor.getSelection && editor.getSelection();
        const cursorPos = (sel && sel.getStartPosition && sel.getStartPosition())
            || (editor.getPosition && editor.getPosition());
        const cursorOffset = cursorPos ? model.getOffsetAt(cursorPos) : 0;
        let active = matches.length > 0 ? 0 : -1;
        for (let i = 0; i < matches.length; i++) {
            if (matches[i].from >= cursorOffset) {
                active = i;
                break;
            }
        }
        if (suppressActive) active = -1;

        findState = { term, total: matches.length, active, matches, capped };
        applyDecorations();
        if (!suppressActive && revealActive && active >= 0) scrollMatchIntoView(matches[active]);
        publishFindState();
    }

    function applyDecorations(): void {
        const editor = opts.getEditor();
        const monaco = opts.getMonaco();
        if (!editor || !monaco) return;

        const model = editor.getModel();
        if (!model) return;
        if (model !== lastDecoratedModel) {
            matchDecorations = [];
            lastDecoratedModel = model;
        }

        const decorations: any[] = [];
        findState.matches.forEach((m: FindMatch, idx: number) => {
            const startPos = model.getPositionAt(m.from);
            const endPos = model.getPositionAt(m.to);
            const isActive = activeForDecoration(idx);
            decorations.push({
                range: new monaco.Range(
                    startPos.lineNumber,
                    startPos.column,
                    endPos.lineNumber,
                    endPos.column,
                ),
                options: {
                    inlineClassName: isActive
                        ? 'folio-find-match-active'
                        : 'folio-find-match',
                    overviewRuler: {
                        color: isActive ? '#FF8C00' : '#FFD700',
                        position: monaco.editor.OverviewRulerLane.Center,
                    },
                    minimap: {
                        color: isActive ? '#FF8C00' : '#FFD700',
                        position: monaco.editor.MinimapPosition.Inline,
                    },
                },
            });
        });

        matchDecorations = editor.deltaDecorations(matchDecorations, decorations);
    }

    function clearDecorations(): void {
        const editor = opts.getEditor();
        if (editor) {
            matchDecorations = editor.deltaDecorations(matchDecorations, []);
            lastDecoratedModel = editor.getModel ? editor.getModel() : null;
        } else {
            matchDecorations = [];
            lastDecoratedModel = null;
        }
    }

    function scrollMatchIntoView(m: FindMatch): void {
        const editor = opts.getEditor();
        if (!editor) return;
        const model = editor.getModel();
        if (!model) return;
        const start = model.getPositionAt(m.from);
        const end = model.getPositionAt(m.to);
        // Treffer als echte Selektion setzen, nicht nur den Cursor:
        // Tippen/Einfuegen ueberschreibt damit den aktiven Treffer
        // (Standard-Editor-Verhalten). Fokus wird nicht angefasst — wer
        // in der Find-Bar tippt, tippt dort weiter.
        if (typeof editor.setSelection === 'function') {
            editor.setSelection({
                startLineNumber: start.lineNumber,
                startColumn: start.column,
                endLineNumber: end.lineNumber,
                endColumn: end.column,
            });
        } else if (typeof editor.setPosition === 'function') {
            editor.setPosition(start);
        }
        editor.revealPositionInCenterIfOutsideViewport(start);
    }

    function publishFindState(): void {
        const detail: any = {
            source: opts.source,
            term: findState.term,
            total: findState.total,
            active: findState.active,
        };
        if (findState.capped) detail.capped = true;
        if (findState.invalidRegex) detail.invalidRegex = true;
        if (findState.replaceLimited) detail.replaceLimited = true;
        if (opts.postToBridge) post({ type: 'editorFindState', ...detail });
        try {
            window.dispatchEvent(new CustomEvent('folio-find-state', { detail }));
        } catch {
            /* defensive */
        }
    }

    function openFind(initialTerm?: string): void {
        if (typeof initialTerm === 'string' && initialTerm.length > 0) {
            findState.term = initialTerm;
        }
        const editor = opts.getEditor();
        if (!editor) {
            publishFindState();
            return;
        }
        if (!findState.term) {
            const model = editor.getModel();
            const sel = editor.getSelection && editor.getSelection();
            if (model && sel && !sel.isEmpty()) {
                const start = model.getOffsetAt(sel.getStartPosition());
                const end = model.getOffsetAt(sel.getEndPosition());
                const candidate = model.getValue().substring(start, end);
                if (!candidate.includes('\n') && candidate.length < 200) {
                    findState.term = candidate;
                }
            }
        }
        recomputeMatches();
    }

    function closeFind(): void {
        const editor = opts.getEditor();
        findState = { term: '', total: 0, active: -1, matches: [], capped: false };
        suppressActive = false;
        publishFindState();
        clearDecorations();
        if (editor && opts.source === 'editor') editor.focus();
    }

    function resolveWordSeparators(editor: any, monaco: any): string | null {
        if (!findOptions.wholeWord || findOptions.regex) return null;
        try {
            const edOpt = monaco.editor && monaco.editor.EditorOption;
            if (edOpt && edOpt.wordSeparators && typeof editor.getOption === 'function') {
                const fromEditor = editor.getOption(edOpt.wordSeparators);
                if (fromEditor) return fromEditor;
            }
        } catch (_) { /* fallthrough */ }
        return '~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
    }

    function replacementText(template: string, groups: string[] | null, matched: string): string {
        if (!findOptions.regex) return template;
        const captured = groups && groups.length > 0 ? groups : [matched];
        return expandFindReplacement(template, captured);
    }

    function replaceCurrent(replacement: string): boolean {
        if (opts.source !== 'editor') return false;
        if (findState.invalidRegex) return false;
        if (findState.matches.length === 0 || findState.active < 0) return false;
        const editor = opts.getEditor();
        const monaco = opts.getMonaco();
        if (!editor || !monaco) return false;
        const model = editor.getModel();
        if (!model) return false;
        const match = findState.matches[findState.active];
        const start = model.getPositionAt(match.from);
        const end = model.getPositionAt(match.to);
        const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
        const matched = findOptions.regex ? model.getValueInRange(range) : '';
        const text = replacementText(replacement, match.groups || null, matched);
        // Kein withProgrammaticWrite: executeEdits feuert onDidChangeModelContent
        // wie eine Taste → dirty + folio-editor-text-updated + Match-Recompute.
        editor.pushUndoStop();
        editor.executeEdits('findReplace', [{ range, text }]);
        editor.pushUndoStop();
        // Recompute hat den Cursor hinter die Ersetzung gesetzt und damit
        // bereits den nächsten Treffer aktiv — nur noch einblenden.
        if (findState.matches.length > 0 && findState.active >= 0) {
            scrollMatchIntoView(findState.matches[findState.active]);
            applyDecorations();
            publishFindState();
        }
        return true;
    }

    function replaceAll(replacement: string, replaceOpts?: { inSelection?: boolean }): boolean {
        if (opts.source !== 'editor') return false;
        if (findState.invalidRegex) return false;
        const editor = opts.getEditor();
        const monaco = opts.getMonaco();
        if (!editor || !monaco) return false;
        const model = editor.getModel();
        if (!model) return false;
        if (!findState.term) return false;

        let searchScope: any = false;
        if (replaceOpts && replaceOpts.inSelection) {
            const rawSels = (typeof editor.getSelections === 'function' && editor.getSelections())
                || (editor.getSelection ? [editor.getSelection()] : []);
            const ranges: any[] = [];
            for (let i = 0; i < rawSels.length; i++) {
                const s = rawSels[i];
                if (!s) continue;
                const empty = typeof s.isEmpty === 'function' ? s.isEmpty() : false;
                if (!empty) ranges.push(s);
            }
            if (ranges.length === 0) return false;
            searchScope = ranges;
        }

        const rawMatches: any[] = model.findMatches(
            findState.term,
            searchScope,
            !!findOptions.regex,
            !!findOptions.caseSensitive,
            resolveWordSeparators(editor, monaco),
            !!findOptions.regex,
            REPLACE_ALL_CAP + 1,
        ) || [];
        if (rawMatches.length > REPLACE_ALL_CAP) {
            findState = { ...findState, replaceLimited: true };
            publishFindState();
            return false;
        }
        if (rawMatches.length === 0) return false;

        const edits: any[] = [];
        for (let i = 0; i < rawMatches.length; i++) {
            const rm = rawMatches[i];
            const r = rm && rm.range;
            if (!r) continue;
            const range = new monaco.Range(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn);
            const matched = findOptions.regex ? model.getValueInRange(range) : '';
            edits.push({
                range,
                text: replacementText(replacement, rm.matches || null, matched),
            });
        }
        if (edits.length === 0) return false;

        editor.pushUndoStop();
        editor.executeEdits('findReplaceAll', edits);
        editor.pushUndoStop();
        return true;
    }

    function setFindOptions(newOpts: ResolvedFindOptions): void {
        findOptions.caseSensitive = newOpts.caseSensitive;
        findOptions.wholeWord = newOpts.wholeWord;
        findOptions.regex = newOpts.regex;
        if (opts.getEditor() && findState.term) recomputeMatches();
    }

    function setFindTerm(term: string): void {
        findState.term = term || '';
        if (opts.getEditor()) recomputeMatches();
    }

    function findNext(): void {
        const editor = opts.getEditor();
        if (!editor || findState.matches.length === 0) return;
        if (suppressActive) {
            findState.active = -1;
            publishFindState();
            applyDecorations();
            return;
        }
        const next = (findState.active + 1) % findState.matches.length;
        findState.active = next;
        scrollMatchIntoView(findState.matches[next]);
        publishFindState();
        applyDecorations();
    }

    function findPrev(): void {
        const editor = opts.getEditor();
        if (!editor || findState.matches.length === 0) return;
        if (suppressActive) {
            findState.active = -1;
            publishFindState();
            applyDecorations();
            return;
        }
        const n = findState.matches.length;
        const prev = (findState.active - 1 + n) % n;
        findState.active = prev;
        scrollMatchIntoView(findState.matches[prev]);
        publishFindState();
        applyDecorations();
    }

    function setSuppressActive(on: boolean): void {
        const next = !!on;
        if (suppressActive === next) return;
        suppressActive = next;
        if (suppressActive) {
            findState.active = -1;
        } else if (findState.matches.length > 0) {
            findState.active = 0;
        }
        applyDecorations();
        publishFindState();
    }

    return {
        openFind,
        closeFind,
        setFindTerm,
        setFindOptions,
        findNext,
        findPrev,
        replaceCurrent,
        replaceAll,
        recomputeMatches,
        hasActiveTerm: function (): boolean {
            return findState.term.length > 0;
        },
        setSuppressActive,
        clearFindDecorations: clearDecorations,
    };
}

const editorFindController = createFindController({
    getEditor,
    getMonaco,
    source: 'editor',
    postToBridge: true,
});

export const openFind = editorFindController.openFind;
export const closeFind = editorFindController.closeFind;
export const setFindTerm = editorFindController.setFindTerm;
export const setFindOptions = editorFindController.setFindOptions;
export const findNext = editorFindController.findNext;
export const findPrev = editorFindController.findPrev;
export const replaceCurrent = editorFindController.replaceCurrent;
export const replaceAll = editorFindController.replaceAll;
export const recomputeMatches = editorFindController.recomputeMatches;
export const hasActiveTerm = editorFindController.hasActiveTerm;
export const setSuppressActive = editorFindController.setSuppressActive;
export const clearFindDecorations = editorFindController.clearFindDecorations;
