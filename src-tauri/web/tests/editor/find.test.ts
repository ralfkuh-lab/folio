import { beforeEach, describe, expect, it, vi } from 'vitest';

type Pos = { lineNumber: number; column: number };

function createModel(value: string) {
    const computePos = (offset: number): Pos => {
        const before = value.slice(0, offset).split('\n');
        return {
            lineNumber: before.length,
            column: before[before.length - 1].length + 1,
        };
    };
    const computeOffset = (pos: Pos): number => {
        const lines = value.split('\n');
        let offset = 0;
        for (let i = 0; i < pos.lineNumber - 1; i++) offset += lines[i].length + 1;
        return offset + pos.column - 1;
    };
    return {
        value,
        getValue: vi.fn(() => value),
        getValueInRange: vi.fn((range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => {
            const from = computeOffset({ lineNumber: range.startLineNumber, column: range.startColumn });
            const to = computeOffset({ lineNumber: range.endLineNumber, column: range.endColumn });
            return value.slice(from, to);
        }),
        getPositionAt: vi.fn(computePos),
        getOffsetAt: vi.fn(computeOffset),
        findMatches: vi.fn((
            searchString: string,
            _searchOnlyEditable: boolean,
            isRegex: boolean,
            matchCase: boolean,
            wordSeparators: string | null,
            _captureMatches: boolean,
            limitResultCount = 5000,
        ): any[] => {
            if (!searchString) return [];
            const res: any[] = [];
            function pushRange(from: number, to: number, groups?: string[] | null): boolean {
                const startP = computePos(from);
                const endP = computePos(to);
                const hit: any = {
                    range: {
                        startLineNumber: startP.lineNumber,
                        startColumn: startP.column,
                        endLineNumber: endP.lineNumber,
                        endColumn: endP.column,
                    },
                };
                if (groups) hit.matches = groups;
                res.push(hit);
                return res.length >= limitResultCount;
            }
            const scope = _searchOnlyEditable as boolean | { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
            let scopeFrom = 0;
            let scopeTo = value.length;
            if (scope && typeof scope === 'object' && typeof scope.startLineNumber === 'number') {
                scopeFrom = computeOffset({ lineNumber: scope.startLineNumber, column: scope.startColumn });
                scopeTo = computeOffset({ lineNumber: scope.endLineNumber, column: scope.endColumn });
            }
            if (isRegex) {
                let re: RegExp;
                try {
                    re = new RegExp(searchString, matchCase ? 'gu' : 'giu');
                } catch {
                    return [];
                }
                let m: RegExpExecArray | null;
                while ((m = re.exec(value))) {
                    if (m[0].length === 0) {
                        re.lastIndex++;
                        continue;
                    }
                    const from = m.index;
                    const to = m.index + m[0].length;
                    if (from < scopeFrom || to > scopeTo) continue;
                    const groups = _captureMatches ? Array.from(m) : null;
                    if (pushRange(from, to, groups)) break;
                }
                return res;
            }
            const searchTerm = matchCase ? searchString : searchString.toLowerCase();
            const searchText = matchCase ? value : value.toLowerCase();
            let pos = 0;
            const useWhole = wordSeparators != null;
            function isWordChar(ch: string): boolean { return /[\p{L}\p{N}_]/u.test(ch); }
            function isWholeWordHit(t: string, from: number, to: number): boolean {
                if (from > 0 && isWordChar(t.charAt(from - 1))) return false;
                if (to < t.length && isWordChar(t.charAt(to))) return false;
                return true;
            }
            while (true) {
                const idx = searchText.indexOf(searchTerm, pos);
                if (idx === -1) break;
                const end = idx + searchString.length;
                if (!useWhole || isWholeWordHit(value, idx, end)) {
                    if (pushRange(idx, end)) break;
                }
                pos = end;
            }
            return res;
        }),
    };
}

function createHarness(initialText: string) {
    let model = createModel(initialText);
    let decorationSeq = 0;
    const decorationCalls: Array<{ oldIds: string[]; decorations: any[] }> = [];
    const editor = {
        getModel: vi.fn(() => model),
        setModel(next: any) { model = next; },
        getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
        getSelection: vi.fn(() => null),
        getSelections: vi.fn(() => []),
        pushUndoStop: vi.fn(),
        executeEdits: vi.fn((_source: string, edits: any[]) => {
            const items = edits.map((e) => ({
                from: model.getOffsetAt({
                    lineNumber: e.range.startLineNumber,
                    column: e.range.startColumn,
                }),
                to: model.getOffsetAt({
                    lineNumber: e.range.endLineNumber,
                    column: e.range.endColumn,
                }),
                text: e.text as string,
            })).sort((a, b) => b.from - a.from);
            let text = model.getValue();
            for (const it of items) {
                text = text.slice(0, it.from) + it.text + text.slice(it.to);
            }
            model = createModel(text);
        }),
        deltaDecorations: vi.fn((oldIds: string[], decorations: any[]) => {
            decorationCalls.push({ oldIds, decorations });
            return decorations.map(() => 'd' + decorationSeq++);
        }),
        setPosition: vi.fn(),
        setSelection: vi.fn(),
        revealPositionInCenterIfOutsideViewport: vi.fn(),
        focus: vi.fn(),
    };
    const monaco = {
        Range: vi.fn(function Range(
            startLineNumber: number,
            startColumn: number,
            endLineNumber: number,
            endColumn: number,
        ) {
            return { startLineNumber, startColumn, endLineNumber, endColumn };
        }),
        editor: {
            OverviewRulerLane: { Center: 2 },
            MinimapPosition: { Inline: 1 },
        },
    };
    return {
        editor,
        monaco,
        get model() { return model; },
        setModelText(text: string) {
            const next = createModel(text);
            editor.setModel(next);
            return next;
        },
        decorationCalls,
    };
}

function lastState(): any {
    return (window as any).__lastFindState;
}

beforeEach(() => {
    vi.resetModules();
    (window as any).__lastFindState = null;
    window.addEventListener('folio-find-state', ((event: CustomEvent) => {
        (window as any).__lastFindState = event.detail;
    }) as EventListener, { once: false });
});

describe('editor/find createFindController', () => {
    it('computes matches, active index, case sensitivity and whole-word filtering', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('alpha alphabet Alpha alpha_1 alpha');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'code-view',
        });

        controller.setFindOptions({ wholeWord: true, caseSensitive: false, regex: false });
        controller.openFind('alpha');

        expect(lastState()).toMatchObject({ source: 'code-view', term: 'alpha', total: 3, active: 0 });
        let decorations = harness.decorationCalls[harness.decorationCalls.length - 1].decorations;
        expect(decorations).toHaveLength(3);
        expect(decorations[0].options.inlineClassName).toBe('folio-find-match-active');

        controller.findNext();
        expect(lastState()).toMatchObject({ total: 3, active: 1 });
        // Treffer wird als Selektion gesetzt (Tippen ueberschreibt ihn),
        // nicht nur als Cursor-Position: "Alpha" = Spalte 16..21.
        expect(harness.editor.setSelection).toHaveBeenLastCalledWith({
            startLineNumber: 1,
            startColumn: 16,
            endLineNumber: 1,
            endColumn: 21,
        });
        expect(harness.editor.setPosition).not.toHaveBeenCalled();

        controller.setFindOptions({ caseSensitive: true, wholeWord: true, regex: false });
        expect(lastState()).toMatchObject({ term: 'alpha', total: 2, active: 0 });
    });

    it('suppresses active decoration and scrolling for passive split surfaces', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('one one one');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'code-view',
        });

        controller.openFind('one');
        harness.editor.setPosition.mockClear();
        harness.editor.setSelection.mockClear();
        harness.editor.revealPositionInCenterIfOutsideViewport.mockClear();

        controller.setSuppressActive(true);
        controller.findNext();

        expect(lastState()).toMatchObject({ total: 3, active: -1 });
        const decorations = harness.decorationCalls[harness.decorationCalls.length - 1].decorations;
        expect(decorations.every((d) => d.options.inlineClassName === 'folio-find-match')).toBe(true);
        expect(harness.editor.setPosition).not.toHaveBeenCalled();
        expect(harness.editor.setSelection).not.toHaveBeenCalled();
        expect(harness.editor.revealPositionInCenterIfOutsideViewport).not.toHaveBeenCalled();
    });

    it('recomputes cleanly after a model switch', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('target target');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'code-view',
        });

        controller.openFind('target');
        expect(lastState()).toMatchObject({ total: 2 });
        harness.setModelText('target');
        controller.recomputeMatches(false);

        expect(lastState()).toMatchObject({ total: 1 });
        const finalCall = harness.decorationCalls[harness.decorationCalls.length - 1];
        expect(finalCall.oldIds).toEqual([]);
        expect(finalCall.decorations).toHaveLength(1);
    });

    it('openFind seeds term from editor selection when no initialTerm (Ctrl+F with selection)', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('hello world hello');
        // selection covering first "hello"
        harness.editor.getSelection = vi.fn(() => ({
            isEmpty: () => false,
            getStartPosition: () => ({ lineNumber: 1, column: 1 }),
            getEndPosition: () => ({ lineNumber: 1, column: 6 }),
        }));
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });

        // open without initial (as keydown + bar does) → seeds
        controller.openFind('');
        expect(lastState()).toMatchObject({ source: 'editor', term: 'hello', total: 2, active: 0 });
    });

    it('keeps active match stable while term grows despite cursor at selection end', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('foo foo foo');
        // Zustand nach scrollMatchIntoView: erster Treffer "fo" selektiert,
        // Cursor (getPosition) steht am Selektions-ENDE (Spalte 3). Wuerde
        // recomputeMatches den aktiven Treffer aus getPosition ableiten,
        // spraenge er beim Weitertippen ("fo" -> "foo") auf Treffer 1.
        harness.editor.getPosition = vi.fn(() => ({ lineNumber: 1, column: 3 }));
        harness.editor.getSelection = vi.fn(() => ({
            isEmpty: () => false,
            getStartPosition: () => ({ lineNumber: 1, column: 1 }),
            getEndPosition: () => ({ lineNumber: 1, column: 3 }),
        }));
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });

        controller.setFindTerm('foo');
        expect(lastState()).toMatchObject({ total: 3, active: 0 });
    });

    it('findMatches equivalence for case/wholeWord against prior indexOf expectations', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('alpha alphabet Alpha alpha_1 alpha');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'code-view',
        });

        controller.setFindOptions({ wholeWord: true, caseSensitive: false, regex: false });
        controller.openFind('alpha');
        expect(lastState()).toMatchObject({ total: 3, active: 0 });

        controller.setFindOptions({ caseSensitive: true, wholeWord: true, regex: false });
        controller.setFindTerm('alpha');
        expect(lastState()).toMatchObject({ total: 2, active: 0 });

        controller.setFindOptions({ caseSensitive: false, wholeWord: false, regex: false });
        controller.setFindTerm('alpha');
        expect(lastState()).toMatchObject({ total: 5, active: 0 });
        // NOTE: Monaco findMatches semantics are mocked here (via harness);
        // real behavioral equivalence for wholeWord/case is carried by the
        // E2E find scenarios (06, 40, etc.).
    });

    it('caps matches at 5000 and flags capped for counter', async () => {
        const { createFindController } = await import('../../editor/find');
        // ~5100 matches, non-overlapping
        const text = ' needle'.repeat(5100);
        const harness = createHarness(text);
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });

        controller.openFind('needle');
        const st = lastState();
        expect(st.total).toBe(5000);
        expect(st.capped).toBe(true);
    });

    it('passes isRegex to findMatches and reports invalid patterns', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('cat dog bird');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });

        controller.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        controller.openFind('cat|bird');
        expect(lastState()).toMatchObject({ term: 'cat|bird', total: 2, active: 0 });
        expect(harness.model.findMatches).toHaveBeenCalledWith(
            'cat|bird',
            false,
            true,
            false,
            null,
            true,
            5000,
        );

        controller.setFindTerm('(');
        expect(lastState()).toMatchObject({
            term: '(',
            total: 0,
            active: -1,
            invalidRegex: true,
        });
        const afterInvalid = harness.decorationCalls[harness.decorationCalls.length - 1];
        expect(afterInvalid.decorations).toHaveLength(0);

        controller.setFindTerm('dog');
        expect(lastState()).toMatchObject({ term: 'dog', total: 1, active: 0 });
        expect(lastState().invalidRegex).toBeUndefined();
    });

    it('replaceCurrent writes one edit', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('foo bar foo');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });
        controller.setFindOptions({ caseSensitive: false, wholeWord: false, regex: false });
        controller.openFind('foo');
        expect(controller.replaceCurrent('qux')).toBe(true);
        expect(harness.editor.pushUndoStop).toHaveBeenCalledTimes(2);
        expect(harness.editor.executeEdits).toHaveBeenCalledTimes(1);
        expect(harness.editor.executeEdits.mock.calls[0][1]).toHaveLength(1);
        expect(harness.model.getValue()).toBe('qux bar foo');
    });

    it('replaceAll batches three matches in one executeEdits', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('foo foo foo');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });
        controller.setFindOptions({ caseSensitive: false, wholeWord: false, regex: false });
        controller.openFind('foo');
        expect(lastState()).toMatchObject({ total: 3 });
        expect(controller.replaceAll('foofoo')).toBe(true);
        expect(harness.editor.pushUndoStop).toHaveBeenCalledTimes(2);
        expect(harness.editor.executeEdits).toHaveBeenCalledTimes(1);
        expect(harness.editor.executeEdits.mock.calls[0][1]).toHaveLength(3);
        expect(harness.model.getValue()).toBe('foofoo foofoo foofoo');
    });

    it('replaceAll with zero matches is a no-op', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('nothing here');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });
        controller.setFindOptions({ caseSensitive: false, wholeWord: false, regex: false });
        controller.openFind('zzz');
        expect(controller.replaceAll('nope')).toBe(false);
        expect(harness.editor.executeEdits).not.toHaveBeenCalled();
        expect(harness.model.getValue()).toBe('nothing here');
    });

    it('regex replace expands capture groups', async () => {
        const { createFindController, expandFindReplacement } = await import('../../editor/find');
        expect(expandFindReplacement('$2-$1', ['ab', 'a', 'b'])).toBe('b-a');
        expect(expandFindReplacement('$$', ['x'])).toBe('$');

        const harness = createHarness('cat-dog');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });
        controller.setFindOptions({ caseSensitive: false, wholeWord: false, regex: true });
        controller.openFind('(cat)-(dog)');
        expect(controller.replaceCurrent('$2/$1')).toBe(true);
        expect(harness.model.getValue()).toBe('dog/cat');
    });

    it('accepts Unicode-escape regex that Monaco compiles with the u-flag', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('hello');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });
        controller.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        controller.openFind('[\\u{1F600}-\\u{1F64F}]');
        expect(lastState().invalidRegex).toBeUndefined();
    });

    it('replaceAll refuses when the match snapshot exceeds the safety cap', async () => {
        const { createFindController, REPLACE_ALL_CAP } = await import('../../editor/find');
        const harness = createHarness('foo');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'editor',
        });
        controller.setFindOptions({ caseSensitive: false, wholeWord: false, regex: false });
        controller.openFind('foo');
        harness.model.findMatches.mockReturnValueOnce(
            Array.from({ length: REPLACE_ALL_CAP + 1 }, () => ({
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
            })),
        );
        expect(controller.replaceAll('x')).toBe(false);
        expect(harness.editor.executeEdits).not.toHaveBeenCalled();
        expect(lastState().replaceLimited).toBe(true);
    });
});
