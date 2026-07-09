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
        getPositionAt: vi.fn(computePos),
        getOffsetAt: vi.fn(computeOffset),
        findMatches: vi.fn((
            searchString: string,
            _searchOnlyEditable: boolean,
            _isRegex: boolean,
            matchCase: boolean,
            wordSeparators: string | null,
            _captureMatches: boolean,
            limitResultCount = 5000,
        ): any[] => {
            if (!searchString) return [];
            const searchTerm = matchCase ? searchString : searchString.toLowerCase();
            const searchText = matchCase ? value : value.toLowerCase();
            const res: any[] = [];
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
                    const startP = computePos(idx);
                    const endP = computePos(end);
                    res.push({
                        range: {
                            startLineNumber: startP.lineNumber,
                            startColumn: startP.column,
                            endLineNumber: endP.lineNumber,
                            endColumn: endP.column,
                        },
                    });
                    if (res.length >= limitResultCount) break;
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
        deltaDecorations: vi.fn((oldIds: string[], decorations: any[]) => {
            decorationCalls.push({ oldIds, decorations });
            return decorations.map(() => 'd' + decorationSeq++);
        }),
        setPosition: vi.fn(),
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

        controller.setFindOptions({ wholeWord: true, caseSensitive: false });
        controller.openFind('alpha');

        expect(lastState()).toMatchObject({ source: 'code-view', term: 'alpha', total: 3, active: 0 });
        let decorations = harness.decorationCalls[harness.decorationCalls.length - 1].decorations;
        expect(decorations).toHaveLength(3);
        expect(decorations[0].options.inlineClassName).toBe('folio-find-match-active');

        controller.findNext();
        expect(lastState()).toMatchObject({ total: 3, active: 1 });
        expect(harness.editor.setPosition).toHaveBeenCalled();

        controller.setFindOptions({ caseSensitive: true });
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
        harness.editor.revealPositionInCenterIfOutsideViewport.mockClear();

        controller.setSuppressActive(true);
        controller.findNext();

        expect(lastState()).toMatchObject({ total: 3, active: -1 });
        const decorations = harness.decorationCalls[harness.decorationCalls.length - 1].decorations;
        expect(decorations.every((d) => d.options.inlineClassName === 'folio-find-match')).toBe(true);
        expect(harness.editor.setPosition).not.toHaveBeenCalled();
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

    it('findMatches equivalence for case/wholeWord against prior indexOf expectations', async () => {
        const { createFindController } = await import('../../editor/find');
        const harness = createHarness('alpha alphabet Alpha alpha_1 alpha');
        const controller = createFindController({
            getEditor: () => harness.editor,
            getMonaco: () => harness.monaco,
            source: 'code-view',
        });

        controller.setFindOptions({ wholeWord: true, caseSensitive: false });
        controller.openFind('alpha');
        expect(lastState()).toMatchObject({ total: 3, active: 0 });

        controller.setFindOptions({ caseSensitive: true, wholeWord: true });
        controller.setFindTerm('alpha');
        expect(lastState()).toMatchObject({ total: 2, active: 0 });

        controller.setFindOptions({ caseSensitive: false, wholeWord: false });
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
});
