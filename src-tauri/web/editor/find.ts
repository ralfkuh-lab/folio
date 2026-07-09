// Find subsystem for Monaco-backed surfaces. Owns the find-term state,
// match list, Monaco decorations, and the public open/close/next/prev
// API exposed via window.FolioEditor and window.FolioCodeView.

import { post } from './bridge';
import { getEditor, getMonaco } from './state';

interface FindMatch {
    from: number;
    to: number;
}

interface FindStateSnapshot {
    term: string;
    total: number;
    active: number;
    matches: FindMatch[];
    capped?: boolean;
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
    setFindOptions(opts: { caseSensitive?: boolean; wholeWord?: boolean }): void;
    findNext(): void;
    findPrev(): void;
    recomputeMatches(revealActive?: boolean): void;
    hasActiveTerm(): boolean;
    setSuppressActive(on: boolean): void;
    clearFindDecorations(): void;
}

function isWordChar(ch: string): boolean {
    return /[\p{L}\p{N}_]/u.test(ch);
}

function isWholeWordHit(text: string, from: number, to: number): boolean {
    if (from > 0 && isWordChar(text.charAt(from - 1))) return false;
    if (to < text.length && isWordChar(text.charAt(to))) return false;
    return true;
}

export function createFindController(opts: FindControllerOptions): FindController {
    let findState: FindStateSnapshot = { term: '', total: 0, active: -1, matches: [] };
    const findOptions: { caseSensitive: boolean; wholeWord: boolean } = {
        caseSensitive: false,
        wholeWord: false,
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

        // Use Monaco's optimized model.findMatches (Befund 4).
        // wholeWord: pass separators from options (or default) so that
        // Monaco applies word-boundary logic; behavior matched to prior
        // custom impl via vitest equivalence.
        let wordSeparators: string | null = null;
        if (findOptions.wholeWord) {
            try {
                const edOpt = monaco.editor && monaco.editor.EditorOption;
                if (edOpt && edOpt.wordSeparators && typeof editor.getOption === 'function') {
                    wordSeparators = editor.getOption(edOpt.wordSeparators);
                }
            } catch (_) { /* fallthrough */ }
            if (!wordSeparators) {
                wordSeparators = '~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
            }
        }

        const rawMatches: any[] = model.findMatches(
            term,
            false, // searchOnlyEditableRange
            false, // isRegex
            !!findOptions.caseSensitive,
            wordSeparators,
            false, // captureMatches
            5000,  // limitResultCount
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
            matches.push({ from, to });
        }

        const capped = rawMatches.length >= 5000;

        const cursorPos = editor.getPosition && editor.getPosition();
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
        const pos = model.getPositionAt(m.from);
        editor.setPosition(pos);
        editor.revealPositionInCenterIfOutsideViewport(pos);
    }

    function publishFindState(): void {
        const detail: any = {
            source: opts.source,
            term: findState.term,
            total: findState.total,
            active: findState.active,
        };
        if (findState.capped) detail.capped = true;
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

    function setFindOptions(newOpts: {
        caseSensitive?: boolean;
        wholeWord?: boolean;
    }): void {
        if (typeof newOpts.caseSensitive === 'boolean') findOptions.caseSensitive = newOpts.caseSensitive;
        if (typeof newOpts.wholeWord === 'boolean') findOptions.wholeWord = newOpts.wholeWord;
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
export const recomputeMatches = editorFindController.recomputeMatches;
export const hasActiveTerm = editorFindController.hasActiveTerm;
export const setSuppressActive = editorFindController.setSuppressActive;
export const clearFindDecorations = editorFindController.clearFindDecorations;
