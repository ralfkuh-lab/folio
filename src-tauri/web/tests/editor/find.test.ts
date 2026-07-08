import { beforeEach, describe, expect, it, vi } from 'vitest';

type Pos = { lineNumber: number; column: number };

function createModel(value: string) {
    return {
        value,
        getValue: vi.fn(() => value),
        getPositionAt: vi.fn((offset: number): Pos => {
            const before = value.slice(0, offset).split('\n');
            return {
                lineNumber: before.length,
                column: before[before.length - 1].length + 1,
            };
        }),
        getOffsetAt: vi.fn((pos: Pos): number => {
            const lines = value.split('\n');
            let offset = 0;
            for (let i = 0; i < pos.lineNumber - 1; i++) offset += lines[i].length + 1;
            return offset + pos.column - 1;
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
});
