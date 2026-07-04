import { beforeEach, describe, expect, it } from 'vitest';
import { initSettingsAi } from '../../app/ui/settings-ai';
import { installTauriMock, TauriMockHandles } from '../helpers';

const catalog = {
    catalog: {
        openai: {
            id: 'openai',
            name: 'OpenAI',
            api: 'https://api.openai.test/v1',
            doc: 'https://docs.openai.test',
            models: {
                'gpt-4o': {
                    id: 'gpt-4o',
                    name: 'GPT-4o',
                    reasoning: true,
                    tool_call: true,
                    limit: { context: 200_000 },
                    cost: { input: 3, output: 15 },
                },
                'gpt-4o-mini': {
                    id: 'gpt-4o-mini',
                    name: 'GPT-4o Mini',
                },
            },
        },
        anthropic: {
            id: 'anthropic',
            name: 'Anthropic',
            api: 'https://api.anthropic.test',
            models: {
                sonnet: { id: 'sonnet', name: 'Claude Sonnet' },
            },
        },
    },
    source: 'snapshot',
    updatedAt: '2026-07-04',
};

const initialConfig = {
    provider: {
        openai: {
            enabled: true,
            whitelist: ['gpt-4o'],
            models: {},
        },
        local: {
            enabled: true,
            custom: true,
            name: 'Lokales Modell',
            options: { baseURL: 'http://localhost:11434/v1' },
            models: { llama: { name: 'Llama Lokal' } },
            whitelist: ['llama'],
        },
    },
    defaultModel: { provider: 'openai', model: 'gpt-4o' },
};

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function buildDom(): void {
    document.body.innerHTML = `
        <button id="settings-tab-ki-anbieter"></button>
        <button id="settings-tab-ki-modelle"></button>
        <div id="settings-panel-ki-anbieter">
            <p id="ai-providers-error" hidden></p>
            <div id="ai-provider-list"></div>
            <button id="ai-custom-add"></button>
            <div id="ai-custom-provider-list"></div>
            <div id="ai-custom-dialog" hidden>
                <form id="ai-custom-form">
                    <h3 id="ai-custom-title"></h3>
                    <input id="ai-custom-id" />
                    <input id="ai-custom-name" />
                    <input id="ai-custom-base-url" />
                    <input id="ai-custom-key" type="password" />
                    <p id="ai-custom-error" hidden></p>
                    <button id="ai-custom-cancel" type="button"></button>
                    <button id="ai-custom-save" type="submit"></button>
                </form>
            </div>
        </div>
        <div id="settings-panel-ki-modelle">
            <input id="ai-model-search" />
            <button id="ai-catalog-refresh"></button>
            <p id="ai-catalog-updated"></p>
            <p id="ai-models-error" hidden></p>
            <select id="ai-default-model"></select>
            <div id="ai-model-list"></div>
        </div>
    `;
}

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('settings-ai', () => {
    let handles: TauriMockHandles;
    let config: any;
    let authStored: boolean;

    beforeEach(() => {
        buildDom();
        handles = installTauriMock();
        config = clone(initialConfig);
        authStored = false;
        handles.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'ai_catalog_get') return Promise.resolve(clone(catalog));
            if (cmd === 'ai_config_get') return Promise.resolve(clone(config));
            if (cmd === 'ai_auth_status') {
                return Promise.resolve(authStored ? { openai: true } : {});
            }
            if (cmd === 'ai_provider_enable') {
                config.provider[args.providerId] ||= { whitelist: [], models: {} };
                config.provider[args.providerId].enabled = args.enabled;
                return Promise.resolve(clone(config));
            }
            if (cmd === 'ai_model_toggle') {
                const whitelist = config.provider[args.providerId].whitelist;
                config.provider[args.providerId].whitelist = args.on
                    ? Array.from(new Set([...whitelist, args.modelId]))
                    : whitelist.filter((id: string) => id !== args.modelId);
                return Promise.resolve(clone(config));
            }
            if (cmd === 'ai_auth_set') {
                authStored = true;
                return Promise.resolve({ openai: true });
            }
            if (cmd === 'ai_auth_remove') {
                authStored = false;
                return Promise.resolve({});
            }
            if (cmd === 'ai_default_model_set') {
                config.defaultModel = args.providerId
                    ? { provider: args.providerId, model: args.modelId }
                    : null;
                return Promise.resolve(clone(config));
            }
            return Promise.resolve(undefined);
        });
        initSettingsAi();
    });

    it('rendert Katalog, Config und kompakte Modellmetadaten', async () => {
        document.getElementById('settings-tab-ki-anbieter')!.click();
        await settle();

        const cards = Array.from(
            document.querySelectorAll<HTMLElement>('#ai-provider-list [data-ai-provider-id]'),
        );
        expect(cards.map((card) => card.dataset.aiProviderId))
            .toEqual(['anthropic', 'openai']);
        expect(cards[1].textContent).toContain('https://api.openai.test/v1');
        expect(document.querySelector('[data-ai-provider-id="local"]')!.textContent)
            .toContain('Lokales Modell');

        document.getElementById('settings-tab-ki-modelle')!.click();
        await settle();
        const model = document.querySelector<HTMLElement>('[data-ai-model-id="gpt-4o"]')!;
        expect(model.textContent).toContain('Kontext 200k');
        expect(model.textContent).toContain('Reasoning');
        expect(model.textContent).toContain('Tools');
        expect(model.textContent).toContain('$3/$15 je 1M');
        expect(document.getElementById('ai-catalog-updated')!.textContent)
            .toContain('Snapshot');
    });

    it('ruft Provider- und Modell-Toggles mit den richtigen Payloads auf', async () => {
        document.getElementById('settings-tab-ki-anbieter')!.click();
        await settle();

        (document.getElementById('ai-provider-enabled-anthropic') as HTMLInputElement)
            .click();
        await settle();
        expect(handles.invoke).toHaveBeenCalledWith('ai_provider_enable', {
            providerId: 'anthropic',
            enabled: true,
        });

        document.getElementById('settings-tab-ki-modelle')!.click();
        await settle();
        (document.getElementById(
            'ai-model-toggle-openai-gpt-4o',
        ) as HTMLInputElement).click();
        await settle();
        expect(handles.invoke).toHaveBeenCalledWith('ai_model_toggle', {
            providerId: 'openai',
            modelId: 'gpt-4o',
            on: false,
        });
    });

    it('verwendet nur Passwortfelder und leert den Schlüssel nach dem Speichern', async () => {
        document.getElementById('settings-tab-ki-anbieter')!.click();
        await settle();
        document.getElementById('ai-auth-edit-openai')!.click();

        const keyInput = document.getElementById('ai-auth-key-openai') as HTMLInputElement;
        expect(keyInput.type).toBe('password');
        expect(keyInput.value).toBe('');
        keyInput.value = 'top-secret-key';
        document.getElementById('ai-auth-save-openai')!.click();
        await settle();

        expect(handles.invoke).toHaveBeenCalledWith('ai_auth_set', {
            providerId: 'openai',
            key: 'top-secret-key',
        });
        expect(keyInput.value).toBe('');
        expect(document.documentElement.outerHTML).not.toContain('top-secret-key');
        expect(document.body.textContent).not.toContain('top-secret-key');
        expect(document.getElementById('ai-auth-key-openai')!.getAttribute('value'))
            .toBeNull();
        expect(document.querySelector('[data-ai-auth-provider="openai"]')!.textContent)
            .toContain('Schlüssel hinterlegt');
        expect(handles.invoke.mock.calls.filter(([cmd]) => cmd === 'ai_auth_status').length)
            .toBeGreaterThan(1);
    });

    it('filtert live über Modellnamen', async () => {
        document.getElementById('settings-tab-ki-modelle')!.click();
        await settle();
        const search = document.getElementById('ai-model-search') as HTMLInputElement;
        search.value = 'mini';
        search.dispatchEvent(new Event('input', { bubbles: true }));

        expect(document.querySelector('[data-ai-model-id="gpt-4o-mini"]')).not.toBeNull();
        expect(document.querySelector('[data-ai-model-id="gpt-4o"]')).toBeNull();
        expect(document.querySelector('[data-ai-model-provider="local"]')).toBeNull();
    });

    it('baut das Default-Dropdown aus Whitelists aktivierter Provider', async () => {
        document.getElementById('settings-tab-ki-modelle')!.click();
        await settle();

        const defaultModel = document.getElementById('ai-default-model') as HTMLSelectElement;
        expect(Array.from(defaultModel.options).map((option) => option.textContent))
            .toEqual(['(keins)', 'Lokales Modell — Llama Lokal', 'OpenAI — GPT-4o']);
        expect(defaultModel.value).toBe(JSON.stringify(['openai', 'gpt-4o']));

        defaultModel.value = '';
        defaultModel.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(handles.invoke).toHaveBeenCalledWith('ai_default_model_set', {
            providerId: null,
            modelId: null,
        });
    });
});
