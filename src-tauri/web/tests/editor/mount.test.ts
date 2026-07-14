import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockModel = {
    value: string;
    language: string;
    disposed: boolean;
    undoDepth: number;
    getValue(): string;
    getLanguageId(): string;
    getPositionAt(offset: number): { lineNumber: number; column: number };
    getOffsetAt(pos: { lineNumber: number; column: number }): number;
    dispose(): void;
    isDisposed(): boolean;
};

function createMonacoMock() {
    const models: MockModel[] = [];
    let editorInstance: any;
    let decorationSeq = 0;

    function createModel(value: string, language: string): MockModel {
        const model: MockModel = {
            value,
            language,
            disposed: false,
            undoDepth: 0,
            getValue() { return this.value; },
            getLanguageId() { return this.language; },
            getPositionAt(offset: number) {
                const before = this.value.slice(0, offset).split('\n');
                return {
                    lineNumber: before.length,
                    column: before[before.length - 1].length + 1,
                };
            },
            getOffsetAt(pos: { lineNumber: number; column: number }) {
                const lines = this.value.split('\n');
                let offset = 0;
                for (let i = 0; i < pos.lineNumber - 1; i++) offset += lines[i].length + 1;
                return offset + pos.column - 1;
            },
            dispose() { this.disposed = true; },
            isDisposed() { return this.disposed; },
            findMatches(term: string, _a?: any, _b?: any, _c?: any, _d?: any, _e?: any, _lim = 5000) {
                // minimal impl to keep find-decoration tests working (case-insens contains)
                if (!term || !this.value) return [];
                const t = this.value.toLowerCase();
                const s = term.toLowerCase();
                const res: any[] = [];
                let p = 0;
                while (true) {
                    const i = t.indexOf(s, p);
                    if (i < 0) break;
                    const startP = this.getPositionAt(i);
                    const endP = this.getPositionAt(i + term.length);
                    res.push({ range: { startLineNumber: startP.lineNumber, startColumn: startP.column, endLineNumber: endP.lineNumber, endColumn: endP.column } });
                    if (res.length >= _lim) break;
                    p = i + term.length;
                }
                return res;
            },
        };
        models.push(model);
        return model;
    }

    const monaco = {
        Range: vi.fn(function Range(
            startLineNumber: number,
            startColumn: number,
            endLineNumber: number,
            endColumn: number,
        ) {
            return { startLineNumber, startColumn, endLineNumber, endColumn };
        }),
        KeyMod: { CtrlCmd: 1, Shift: 2 },
        KeyCode: { KeyF: 10, KeyS: 11, F3: 12 },
        editor: {
            OverviewRulerLane: { Center: 2 },
            MinimapPosition: { Inline: 1 },
            createModel: vi.fn(createModel),
            setModelLanguage: vi.fn((model: MockModel, language: string) => {
                model.language = language;
            }),
            setTheme: vi.fn(),
            create: vi.fn((_element: HTMLElement, options: any) => {
                // Bestand: mount() erzeugt das Model EXPLIZIT (options.model);
                // options.value existiert nur noch als Fallback fuer Alt-Pfade.
                let model: MockModel | null = options.model
                    ?? createModel(options.value, options.language);
                editorInstance = {
                    getModel: vi.fn(() => model),
                    setModel: vi.fn((next: MockModel | null) => { model = next; }),
                    getValue: vi.fn(() => model ? model.value : ''),
                    getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
                    getSelection: vi.fn(() => null),
                    setValue: vi.fn((value: string) => {
                        if (model) model.value = value;
                    }),
                    deltaDecorations: vi.fn((_oldIds: string[], decorations: any[]) => {
                        return decorations.map(() => 'd' + decorationSeq++);
                    }),
                    setPosition: vi.fn(),
                    revealPositionInCenterIfOutsideViewport: vi.fn(),
                    focus: vi.fn(),
                    saveViewState: vi.fn(() => ({ cursor: model && model.value })),
                    restoreViewState: vi.fn(),
                    addCommand: vi.fn(),
                    setScrollTop: vi.fn(),
                    onDidChangeModelContent: vi.fn(),
                    onDidChangeCursorSelection: vi.fn(),
                    onDidScrollChange: vi.fn(),
                    layout: vi.fn(),
                    dispose: vi.fn(),
                };
                return editorInstance;
            }),
        },
    };
    return { monaco, models, getEditor: () => editorInstance };
}

beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="editor-mount"></div>';
    document.documentElement.className = 'theme-light';
});

describe('editor/mount tab model cache', () => {
    it('reuses each tab model with its text and undo state', async () => {
        const mock = createMonacoMock();
        (window as any).monaco = mock.monaco;
        const mount = await import('../../editor/mount');
        await mount.mount('editor-mount', 'alpha');

        mount.setDocument(1, '/tmp/a.md', 'alpha', 'markdown');
        const modelA = mock.getEditor().getModel() as MockModel;
        modelA.value = 'alpha edited';
        modelA.undoDepth = 1;

        mount.setDocument(2, '/tmp/b.md', 'beta', 'markdown');
        const modelB = mock.getEditor().getModel() as MockModel;
        expect(modelB).not.toBe(modelA);
        expect(modelB.value).toBe('beta');

        // Backend-Payload enthaelt den aktuellen Store-Text. Der Cache ist
        // trotzdem massgeblich und darf nicht per setValue ersetzt werden.
        mount.setDocument(1, '/tmp/a.md', 'alpha from backend', 'markdown');
        expect(mock.getEditor().getModel()).toBe(modelA);
        expect(modelA.value).toBe('alpha edited');
        expect(modelA.undoDepth).toBe(1);
        expect(mock.getEditor().restoreViewState).toHaveBeenCalled();
    });

    it('updates same-tab reloads in place and disposes closed-tab models', async () => {
        const mock = createMonacoMock();
        (window as any).monaco = mock.monaco;
        const mount = await import('../../editor/mount');
        await mount.mount('editor-mount', 'old');

        mount.setDocument(10, '/tmp/a.json', 'old', 'json');
        const modelA = mock.getEditor().getModel() as MockModel;
        mount.setDocument(10, '/tmp/a.json', 'reloaded', 'json');
        expect(mock.getEditor().getModel()).toBe(modelA);
        expect(modelA.value).toBe('reloaded');

        modelA.undoDepth = 2;
        mount.setDocument(10, '/tmp/a.md', 'reloaded', 'markdown');
        expect(mock.getEditor().getModel()).toBe(modelA);
        expect(modelA.language).toBe('markdown');
        expect(modelA.undoDepth).toBe(2);

        mount.setDocument(11, '/tmp/b.md', 'other', 'markdown');
        const modelB = mock.getEditor().getModel() as MockModel;
        mount.syncTabModels([10]);
        expect(modelB.disposed).toBe(true);
        expect(modelA.disposed).toBe(false);
    });

    it('mount creates an explicit model owned by the tab cache', async () => {
        const mock = createMonacoMock();
        (window as any).monaco = mock.monaco;
        const mount = await import('../../editor/mount');
        await mount.mount('editor-mount', 'boot');

        // Regression: das create()-eigene implizite Model wird von Monaco
        // beim ersten setModel disposed — mount MUSS deshalb ein explizit
        // erzeugtes Model uebergeben (options.model statt options.value).
        const createOptions = (mock.monaco.editor.create as any).mock.calls[0][1];
        expect(createOptions.model).toBeTruthy();
        expect(createOptions.value).toBeUndefined();
        expect(createOptions.contextmenu).toBe(false);
        expect(mock.monaco.editor.createModel).toHaveBeenCalled();
    });

    it('self-heals when a cached tab model was disposed externally', async () => {
        const mock = createMonacoMock();
        (window as any).monaco = mock.monaco;
        const mount = await import('../../editor/mount');
        await mount.mount('editor-mount', 'doc a');

        mount.setDocument(40, '/tmp/a.md', 'doc a', 'markdown');
        const modelA = mock.getEditor().getModel() as MockModel;
        mount.setDocument(41, '/tmp/b.md', 'doc b', 'markdown');

        // Simuliertes Fremd-Disposal der gecachten Referenz von Tab 40.
        modelA.dispose();
        mount.setDocument(40, '/tmp/a.md', 'doc a', 'markdown');
        const healed = mock.getEditor().getModel() as MockModel;
        expect(healed).not.toBe(modelA);
        expect(healed.disposed).toBe(false);
        expect(healed.getValue()).toBe('doc a');
    });

    it('pre-mount setScroll neither spins the microtask queue nor gets lost', async () => {
        const mock = createMonacoMock();
        (window as any).monaco = mock.monaco;
        const text = await import('../../editor/text');

        // Vor dem ersten mount(): darf nicht in einer Endlos-Microtask-
        // Schleife rekursieren (der Test wuerde sonst nie fertig) ...
        text.setScroll(120);
        await Promise.resolve();
        await Promise.resolve();

        // ... und wird nach dem ersten Mount genau einmal angewendet.
        const mount = await import('../../editor/mount');
        await mount.mount('editor-mount', 'hallo');
        await Promise.resolve();
        expect(mock.getEditor().setScrollTop).toHaveBeenCalledWith(120);
    });

    it('replace-open in same tab sets the new text, save-as keeps undo', async () => {
        const mock = createMonacoMock();
        (window as any).monaco = mock.monaco;
        const mount = await import('../../editor/mount');
        await mount.mount('editor-mount', 'doc a');

        mount.setDocument(20, '/tmp/a.md', 'doc a', 'markdown');
        const modelA = mock.getEditor().getModel() as MockModel;
        modelA.undoDepth = 3;

        // Save-As: gleicher Tab, neuer Pfad, unveraenderter Inhalt —
        // Model + Undo-Stack bleiben erhalten.
        mount.setDocument(20, '/tmp/renamed.md', 'doc a', 'markdown');
        expect(mock.getEditor().getModel()).toBe(modelA);
        expect(modelA.undoDepth).toBe(3);

        // Ersetzen-Open (Vault-Klick/History): gleicher Tab, neuer Pfad,
        // ANDERER Inhalt — der neue Text muss im Editor landen.
        mount.setDocument(20, '/tmp/b.md', 'doc b', 'markdown');
        expect(mock.getEditor().getValue()).toBe('doc b');
    });

    it('clears current find decorations before swapping tab models', async () => {
        const mock = createMonacoMock();
        (window as any).monaco = mock.monaco;
        const mount = await import('../../editor/mount');
        const find = await import('../../editor/find');
        await mount.mount('editor-mount', 'alpha alpha');

        mount.setDocument(1, '/tmp/a.md', 'alpha alpha', 'markdown');
        find.openFind('alpha');
        const editor = mock.getEditor();
        expect(editor.deltaDecorations).toHaveBeenCalledWith([], expect.any(Array));

        editor.deltaDecorations.mockClear();
        editor.setModel.mockClear();
        mount.setDocument(2, '/tmp/b.md', 'beta alpha', 'markdown');
        expect(editor.deltaDecorations).toHaveBeenCalledWith(expect.arrayContaining(['d0', 'd1']), []);
        expect(editor.deltaDecorations.mock.invocationCallOrder[0])
            .toBeLessThan(editor.setModel.mock.invocationCallOrder[0]);

        editor.deltaDecorations.mockClear();
        editor.setModel.mockClear();
        mount.setDocument(1, '/tmp/a.md', 'alpha alpha', 'markdown');
        expect(editor.deltaDecorations).toHaveBeenCalledWith(expect.arrayContaining(['d2']), []);
        expect(editor.deltaDecorations.mock.invocationCallOrder[0])
            .toBeLessThan(editor.setModel.mock.invocationCallOrder[0]);
    });
});
