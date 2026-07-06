import { describe, expect, it } from 'vitest';
import { populateModelPicker, AiConfig, CatalogResult } from '../../app/ui/ai-model-picker';

describe('ai-model-picker', () => {
    const catalog: CatalogResult = {
        catalog: {
            openai: {
                id: 'openai',
                name: 'OpenAI',
                models: {
                    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' },
                    'gpt-4o-mini': { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
                },
            },
            anthropic: {
                id: 'anthropic',
                name: 'Anthropic',
                models: {
                    'claude-sonnet': { id: 'claude-sonnet', name: 'Claude Sonnet' },
                },
            },
        },
    };

    const config: AiConfig = {
        provider: {
            openai: {
                enabled: true,
                whitelist: ['gpt-4o'],
            },
            anthropic: {
                enabled: false,
                whitelist: ['claude-sonnet'],
            },
            custom: {
                enabled: true,
                custom: true,
                name: 'Custom Provider',
                models: {
                    'custom-model': { name: 'My Custom Model' },
                },
                whitelist: ['custom-model'],
            },
        },
        defaultModel: { provider: 'custom', model: 'custom-model' },
    };

    it('populates select options from provider whitelist and filters out disabled providers', () => {
        const select = document.createElement('select');
        populateModelPicker(select, config, catalog);

        expect(select.options.length).toBe(2);
        
        // Options should be sorted alphabetically by label:
        // "Custom Provider · My Custom Model" (custom)
        // "OpenAI · GPT-4o" (openai)
        expect(select.options[0].textContent).toBe('Custom Provider · My Custom Model');
        expect(select.options[0].value).toBe(JSON.stringify(['custom', 'custom-model']));

        expect(select.options[1].textContent).toBe('OpenAI · GPT-4o');
        expect(select.options[1].value).toBe(JSON.stringify(['openai', 'gpt-4o']));
    });

    it('preselects defaultModel if it is available', () => {
        const select = document.createElement('select');
        populateModelPicker(select, config, catalog);
        expect(select.value).toBe(JSON.stringify(['custom', 'custom-model']));
    });

    it('preselects first option if defaultModel is not whitelisted', () => {
        const select = document.createElement('select');
        const customConfig = {
            ...config,
            defaultModel: { provider: 'anthropic', model: 'claude-sonnet' }, // anthropic is disabled
        };
        populateModelPicker(select, customConfig, catalog);
        expect(select.value).toBe(JSON.stringify(['custom', 'custom-model']));
    });

    it('includes empty option and sets it as fallback if defaultModel is missing', () => {
        const select = document.createElement('select');
        const customConfig = {
            ...config,
            defaultModel: null,
        };
        populateModelPicker(select, customConfig, catalog, {
            includeEmptyOption: true,
            emptyOptionLabel: '(keins)',
            separator: ' — ',
        });

        expect(select.options.length).toBe(3);
        expect(select.options[0].textContent).toBe('(keins)');
        expect(select.options[0].value).toBe('');
        expect(select.options[1].textContent).toBe('Custom Provider — My Custom Model');
        expect(select.value).toBe('');
    });
});
