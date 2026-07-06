import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { initThemeAiDialog, openThemeAiDialog, closeThemeAiDialog } from '../../app/ui/theme-ai-dialog';

const catalog = {
    catalog: {
        openai: {
            id: 'openai',
            name: 'OpenAI',
            models: {
                'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' },
            },
        },
    },
};

const aiConfig = {
    provider: {
        openai: {
            enabled: true,
            whitelist: ['gpt-4o'],
        },
    },
    defaultModel: { provider: 'openai', model: 'gpt-4o' },
};

const dummyDraft = {
    manifest: {
        name: 'AI Corporate',
        description: 'Generated',
        code: 'light',
        cover: true,
        header: false,
        footer: false,
        hideInlineFrontmatter: false,
        formatVersion: 1,
    },
    contentCss: '.markdown-body { color: green; }',
};

function buildDom(): void {
    document.body.innerHTML = `
        <div id="theme-editor-dialog">
            <button id="theme-editor-ai"></button>
            <div id="theme-ai-dialog" hidden>
                <textarea id="theme-ai-prompt"></textarea>
                <select id="theme-ai-model"></select>
                <div id="theme-ai-status" hidden>
                    <span id="theme-ai-status-text"></span>
                </div>
                <p id="theme-ai-error" hidden></p>
                <button id="theme-ai-cancel">Abbrechen</button>
                <button id="theme-ai-start">Starten</button>
            </div>
        </div>
    `;
}

interface SurfaceHarness {
    surface: any;
}

function installSurface(): SurfaceHarness {
    const surface = {
        setParts: vi.fn(),
        getAllParts: vi.fn().mockReturnValue({ content: '.markdown-body { color: blue; }' }),
        showPart: vi.fn(),
        getPart: vi.fn(),
        isDirty: vi.fn().mockReturnValue(false),
        onChange: vi.fn(),
        setTheme: vi.fn(),
        dispose: vi.fn(),
        layout: vi.fn(),
    };
    (window as any).FolioThemeEditor = surface;
    return { surface };
}

describe('theme-ai-dialog', () => {
    let tauri: TauriMockHandles;
    let harness: SurfaceHarness;

    beforeEach(() => {
        vi.clearAllMocks();
        buildDom();
        tauri = installTauriMock();
        harness = installSurface();

        // Mock document functions that theme-editor relies on
        vi.mock('../../app/state/document', () => ({
            getCleanText: vi.fn().mockReturnValue('# Aktuelles Dokument'),
            getCurrentPath: vi.fn().mockReturnValue('/tmp/doc.md'),
        }));
        // We mock theme-editor exports since they are in a different module
        vi.mock('../../app/ui/theme-editor', () => ({
            getCurrentThemeId: vi.fn().mockReturnValue('firma'),
            applyThemeDraft: vi.fn((draft) => {
                const surface = (window as any).FolioThemeEditor;
                surface.setParts(draft);
            }),
        }));

        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'ai_config_get') return Promise.resolve(aiConfig);
            if (command === 'ai_catalog_get') return Promise.resolve(catalog);
            if (command === 'ai_theme_author') return Promise.resolve(dummyDraft);
            if (command === 'ai_theme_author_cancel') return Promise.resolve();
            return Promise.resolve(undefined);
        });

        initThemeAiDialog();
    });

    it('opens and closes the dialog and fetches catalog', async () => {
        await openThemeAiDialog();

        expect(tauri.invoke).toHaveBeenCalledWith('ai_config_get', undefined);
        expect(tauri.invoke).toHaveBeenCalledWith('ai_catalog_get', undefined);
        expect(document.getElementById('theme-ai-dialog')!.hidden).toBe(false);

        const modelSelect = document.getElementById('theme-ai-model') as HTMLSelectElement;
        expect(modelSelect.options.length).toBe(1);
        expect(modelSelect.options[0].textContent).toBe('OpenAI · GPT-4o');

        closeThemeAiDialog();
        expect(document.getElementById('theme-ai-dialog')!.hidden).toBe(true);
    });

    it('starts AI theme generation, invokes command with correct arguments, and writes result to buffer', async () => {
        await openThemeAiDialog();

        const promptArea = document.getElementById('theme-ai-prompt') as HTMLTextAreaElement;
        promptArea.value = 'Make it neon green';

        document.getElementById('theme-ai-start')!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(tauri.invoke).toHaveBeenCalledWith('ai_theme_author', {
            prompt: 'Make it neon green',
            baseId: 'firma',
            providerId: 'openai',
            modelId: 'gpt-4o',
        });

        expect(harness.surface.setParts).toHaveBeenCalledWith(dummyDraft);
        expect(document.getElementById('theme-ai-dialog')!.hidden).toBe(true);
    });

    it('displays characters from streaming events and can cancel active run', async () => {
        let resolveGen: (value: any) => void = () => {};
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'ai_config_get') return Promise.resolve(aiConfig);
            if (command === 'ai_catalog_get') return Promise.resolve(catalog);
            if (command === 'ai_theme_author') {
                return new Promise((resolve) => {
                    resolveGen = resolve;
                });
            }
            if (command === 'ai_theme_author_cancel') return Promise.resolve();
            return Promise.resolve(undefined);
        });

        await openThemeAiDialog();
        const promptArea = document.getElementById('theme-ai-prompt') as HTMLTextAreaElement;
        promptArea.value = 'Make it neon green';

        document.getElementById('theme-ai-start')!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById('theme-ai-status')!.hidden).toBe(false);

        tauri.emitEvent('ai:theme_stream', { chars: 250 });
        expect(document.getElementById('theme-ai-status-text')!.textContent).toContain('250 Zeichen');

        // Cancel the run
        document.getElementById('theme-ai-cancel')!.click();
        expect(tauri.invoke).toHaveBeenCalledWith('ai_theme_author_cancel', undefined);

        resolveGen(dummyDraft);
    });
});
