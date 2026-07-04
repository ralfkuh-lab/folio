import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockModel = {
    value: string;
    language: string;
    disposed: boolean;
    undoDepth: number;
    getValue(): string;
    getLanguageId(): string;
    dispose(): void;
};

function createMonacoMock() {
    const models: MockModel[] = [];
    let editorInstance: any;

    function createModel(value: string, language: string): MockModel {
        const model: MockModel = {
            value,
            language,
            disposed: false,
            undoDepth: 0,
            getValue() { return this.value; },
            getLanguageId() { return this.language; },
            dispose() { this.disposed = true; },
        };
        models.push(model);
        return model;
    }

    const monaco = {
        KeyMod: { CtrlCmd: 1, Shift: 2 },
        KeyCode: { KeyF: 10, KeyS: 11, F3: 12 },
        editor: {
            createModel: vi.fn(createModel),
            setModelLanguage: vi.fn((model: MockModel, language: string) => {
                model.language = language;
            }),
            setTheme: vi.fn(),
            create: vi.fn((_element: HTMLElement, options: any) => {
                let model: MockModel | null = createModel(options.value, options.language);
                editorInstance = {
                    getModel: vi.fn(() => model),
                    setModel: vi.fn((next: MockModel | null) => { model = next; }),
                    getValue: vi.fn(() => model ? model.value : ''),
                    setValue: vi.fn((value: string) => {
                        if (model) model.value = value;
                    }),
                    saveViewState: vi.fn(() => ({ cursor: model && model.value })),
                    restoreViewState: vi.fn(),
                    addCommand: vi.fn(),
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
});
