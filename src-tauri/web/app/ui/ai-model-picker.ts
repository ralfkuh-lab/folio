import { compareStrings } from '../i18n/format';
export type CatalogModel = { id: string; name?: string };
export type CatalogProvider = {
    id: string;
    name?: string;
    models?: Record<string, CatalogModel>;
};
export type CatalogResult = { catalog: Record<string, CatalogProvider> };
export type ProviderConfig = {
    enabled: boolean;
    name?: string;
    custom?: boolean;
    models?: Record<string, { name?: string }>;
    whitelist: string[];
};
export type AiConfig = {
    provider: Record<string, ProviderConfig>;
    defaultModel?: { provider: string; model: string } | null;
};

export function populateModelPicker(
    selectElement: HTMLSelectElement,
    config: AiConfig,
    catalog: CatalogResult,
    options: {
        includeEmptyOption?: boolean;
        emptyOptionLabel?: string;
        separator?: string;
    } = {}
): void {
    const includeEmptyOption = options.includeEmptyOption ?? false;
    const emptyOptionLabel = options.emptyOptionLabel ?? '(keins)';
    const separator = options.separator ?? ' · ';

    selectElement.textContent = '';

    if (includeEmptyOption) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = emptyOptionLabel;
        selectElement.appendChild(empty);
    }

    const choices: Array<{ value: string; label: string }> = [];
    for (const [providerId, provider] of Object.entries(config.provider)) {
        if (!provider.enabled) continue;
        
        const pName = provider.name || catalog.catalog[providerId]?.name || providerId;
        
        for (const modelId of new Set(provider.whitelist || [])) {
            const mName = provider.custom
                ? provider.models?.[modelId]?.name || modelId
                : catalog.catalog[providerId]?.models?.[modelId]?.name || modelId;

            choices.push({
                value: JSON.stringify([providerId, modelId]),
                label: `${pName}${separator}${mName}`,
            });
        }
    }

    choices.sort((a, b) => compareStrings(a.label, b.label));

    for (const choice of choices) {
        const option = document.createElement('option');
        option.value = choice.value;
        option.textContent = choice.label;
        selectElement.appendChild(option);
    }

    const preferred = config.defaultModel
        ? JSON.stringify([config.defaultModel.provider, config.defaultModel.model])
        : '';

    const hasPreferred = choices.some((choice) => choice.value === preferred);
    if (hasPreferred) {
        selectElement.value = preferred;
    } else {
        selectElement.value = includeEmptyOption ? '' : (choices[0]?.value || '');
    }
}
