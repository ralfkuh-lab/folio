// Find subsystem for the Monaco wrapper. Owns the find-term state,
// match list, Monaco decorations, and the public open/close/next/prev
// API exposed via window.FolioEditor.

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
}

let findState: FindStateSnapshot = { term: '', total: 0, active: -1, matches: [] };
let findOptions: { caseSensitive: boolean; wholeWord: boolean } = {
    caseSensitive: false,
    wholeWord: false,
};
let matchDecorations: string[] = [];

function isWordChar(ch: string): boolean {
    return /[\p{L}\p{N}_]/u.test(ch);
}

function isWholeWordHit(text: string, from: number, to: number): boolean {
    if (from > 0 && isWordChar(text.charAt(from - 1))) return false;
    if (to < text.length && isWordChar(text.charAt(to))) return false;
    return true;
}

// `revealActive` steuert, ob nach dem Neuberechnen der Cursor auf den
// aktiven Match springt. Bei Find-Bar-Term-Eingabe + explizitem Next/Prev
// wollen wir das (Default true); bei reinem Text-Change-Trigger (User
// editiert an einer Fundstelle) NICHT, sonst springt der Cursor weg.
export function recomputeMatches(revealActive: boolean = true): void {
    const editor = getEditor();
    const monaco = getMonaco();
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const term = findState.term;
    if (!term) {
        findState = { term: '', total: 0, active: -1, matches: [] };
        clearDecorations();
        publishFindState();
        return;
    }

    const text = model.getValue();
    const matches: FindMatch[] = [];

    const searchTerm = findOptions.caseSensitive ? term : term.toLowerCase();
    const searchText = findOptions.caseSensitive ? text : text.toLowerCase();
    let pos = 0;
    while (true) {
        const idx = searchText.indexOf(searchTerm, pos);
        if (idx === -1) break;
        const end = idx + term.length;
        if (!findOptions.wholeWord || isWholeWordHit(text, idx, end)) {
            matches.push({ from: idx, to: end });
        }
        pos = end;
    }

    const cursorPos = editor.getPosition();
    const cursorOffset = cursorPos ? model.getOffsetAt(cursorPos) : 0;
    let active = matches.length > 0 ? 0 : -1;
    for (let i = 0; i < matches.length; i++) {
        if (matches[i].from >= cursorOffset) {
            active = i;
            break;
        }
    }

    findState = { term, total: matches.length, active, matches };
    applyDecorations();
    if (revealActive && active >= 0) scrollMatchIntoView(matches[active]);
    publishFindState();
}

function applyDecorations(): void {
    const editor = getEditor();
    const monaco = getMonaco();
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const decorations: any[] = [];
    findState.matches.forEach((m: FindMatch, idx: number) => {
        const startPos = model.getPositionAt(m.from);
        const endPos = model.getPositionAt(m.to);
        decorations.push({
            range: new monaco.Range(
                startPos.lineNumber,
                startPos.column,
                endPos.lineNumber,
                endPos.column,
            ),
            options: {
                inlineClassName:
                    idx === findState.active
                        ? 'folio-find-match-active'
                        : 'folio-find-match',
                overviewRuler: {
                    color: idx === findState.active ? '#FF8C00' : '#FFD700',
                    position: monaco.editor.OverviewRulerLane.Center,
                },
                minimap: {
                    color: idx === findState.active ? '#FF8C00' : '#FFD700',
                    position: monaco.editor.MinimapPosition.Inline,
                },
            },
        });
    });

    matchDecorations = editor.deltaDecorations(matchDecorations, decorations);
}

function clearDecorations(): void {
    const editor = getEditor();
    if (editor) {
        matchDecorations = editor.deltaDecorations(matchDecorations, []);
    }
}

function scrollMatchIntoView(m: FindMatch): void {
    const editor = getEditor();
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const pos = model.getPositionAt(m.from);
    editor.setPosition(pos);
    editor.revealPositionInCenterIfOutsideViewport(pos);
}

function publishFindState(): void {
    const detail = {
        term: findState.term,
        total: findState.total,
        active: findState.active,
    };
    post({ type: 'editorFindState', ...detail });
    try {
        window.dispatchEvent(new CustomEvent('folio-find-state', { detail }));
    } catch {
        /* defensive */
    }
}

export function hasActiveTerm(): boolean {
    return findState.term.length > 0;
}

export function openFind(initialTerm?: string): void {
    const editor = getEditor();
    if (!editor) return;
    if (typeof initialTerm === 'string' && initialTerm.length > 0) {
        findState.term = initialTerm;
    } else if (!findState.term) {
        const model = editor.getModel();
        const sel = editor.getSelection();
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

export function closeFind(): void {
    const editor = getEditor();
    if (!editor) return;
    findState = { term: '', total: 0, active: -1, matches: [] };
    publishFindState();
    clearDecorations();
    editor.focus();
}

export function setFindOptions(opts: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
}): void {
    if (typeof opts.caseSensitive === 'boolean') findOptions.caseSensitive = opts.caseSensitive;
    if (typeof opts.wholeWord === 'boolean') findOptions.wholeWord = opts.wholeWord;
    if (getEditor() && findState.term) recomputeMatches();
}

export function setFindTerm(term: string): void {
    findState.term = term || '';
    if (getEditor()) recomputeMatches();
}

export function findNext(): void {
    const editor = getEditor();
    if (!editor || findState.matches.length === 0) return;
    const next = (findState.active + 1) % findState.matches.length;
    findState.active = next;
    scrollMatchIntoView(findState.matches[next]);
    publishFindState();
    applyDecorations();
}

export function findPrev(): void {
    const editor = getEditor();
    if (!editor || findState.matches.length === 0) return;
    const n = findState.matches.length;
    const prev = (findState.active - 1 + n) % n;
    findState.active = prev;
    scrollMatchIntoView(findState.matches[prev]);
    publishFindState();
    applyDecorations();
}
