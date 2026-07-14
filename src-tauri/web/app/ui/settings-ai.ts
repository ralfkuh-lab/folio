import { folioLog, safeInvoke } from '../util/log';
import { t } from '../i18n/translate';
import { fmtNumber, fmtDate, compareStrings, normalizeForSearch } from '../i18n/format';
import { initAiChatTest, openAiChatTest } from './ai-chat-test';
import { populateModelPicker } from './ai-model-picker';
import { makeToggle } from './controls';

type CatalogModel = {
    id: string;
    name?: string;
    reasoning?: boolean;
    tool_call?: boolean;
    limit?: { context?: number };
    cost?: { input?: number; output?: number };
};

type CatalogProvider = {
    id: string;
    name?: string;
    api?: string;
    doc?: string;
    models: Record<string, CatalogModel>;
};

type CatalogResult = {
    catalog: Record<string, CatalogProvider>;
    source: 'snapshot' | 'cache';
    updatedAt: string;
};

type ConfiguredModel = { name?: string };

type ProviderConfig = {
    enabled: boolean;
    name?: string;
    custom?: boolean;
    options?: { baseURL: string };
    models?: Record<string, ConfiguredModel>;
    whitelist: string[];
};

type AiConfig = {
    provider: Record<string, ProviderConfig>;
    defaultModel?: { provider: string; model: string } | null;
};

type InvokeResult<T> = { value: T; error?: never } | { value?: never; error: string };

let catalogResult: CatalogResult | null = null;
let aiConfig: AiConfig | null = null;
let authStatus: Record<string, boolean> = {};
let loadPromise: Promise<void> | null = null;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function input(id: string): HTMLInputElement | null {
    return $(id) as HTMLInputElement | null;
}

function select(id: string): HTMLSelectElement | null {
    return $(id) as HTMLSelectElement | null;
}

function getInvoke(): ((cmd: string, args?: any) => Promise<any>) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

async function invokeUi<T>(cmd: string, args: any, operation: string): Promise<InvokeResult<T>> {
    const invoke = getInvoke();
    if (!invoke) return { error: t('errors.ai.tauriUnavailable') };
    try {
        const value = await invoke(cmd, args) as T;
        document.dispatchEvent(new CustomEvent('folio-ai-invoke-complete', { detail: value }));
        return { value };
    } catch (error) {
        folioLog.warn('settings-ai', operation, { cmd, error: String(error) });
        return { error: String(error) };
    }
}

function setError(id: string, message: string | null): void {
    const element = $(id);
    if (!element) return;
    element.textContent = message || '';
    element.hidden = !message;
}

function providerName(id: string, provider?: CatalogProvider, configured?: ProviderConfig): string {
    return configured?.name || provider?.name || id;
}

function button(text: string, className = 'settings-ai-button'): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = text;
    return element;
}

function renderAuthRow(providerId: string, isCustom = false): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-ai-auth';
    row.dataset.aiAuthProvider = providerId;

    const stored = authStatus[providerId] === true;
    const status = document.createElement('span');
    status.className = 'settings-ai-auth__status';
    if (stored || !isCustom) {
        // Bei Custom-Providern ist der Schlüssel optional — kein "fehlt"-Status.
        const dot = document.createElement('span');
        dot.className = 'settings-ai-status-dot' +
            (stored ? ' settings-ai-status-dot--stored' : '');
        dot.setAttribute('aria-hidden', 'true');
        const statusText = document.createElement('span');
        statusText.textContent = stored ? t('settings.ai.auth.keyStored') : t('settings.ai.auth.keyMissing');
        status.append(dot, statusText);
    }

    const edit = button(
        stored ? t('settings.ai.auth.changeKey.action') : isCustom ? t('settings.ai.auth.setKeyOptional.action') : t('settings.ai.auth.setKey.action'),
    );
    edit.id = `ai-auth-edit-${providerId}`;
    edit.dataset.aiAuthEdit = providerId;
    const remove = button(t('settings.ai.auth.remove.action'));
    remove.id = `ai-auth-remove-${providerId}`;
    remove.dataset.aiAuthRemove = providerId;
    remove.hidden = !stored;

    const editor = document.createElement('div');
    editor.className = 'settings-ai-auth__editor';
    editor.hidden = true;
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.id = `ai-auth-key-${providerId}`;
    keyInput.dataset.aiAuthInput = providerId;
    keyInput.className = 'settings-input';
    keyInput.autocomplete = 'new-password';
    keyInput.setAttribute('aria-label', t('settings.ai.auth.keyAriaLabel', { providerId }));
    const save = button(t('dialogs.common.save'));
    save.id = `ai-auth-save-${providerId}`;
    save.dataset.aiAuthSave = providerId;
    const cancel = button(t('dialogs.common.cancel'));
    editor.append(keyInput, save, cancel);

    const error = document.createElement('p');
    error.className = 'settings-ai-error';
    error.id = `ai-auth-error-${providerId}`;
    error.hidden = true;

    edit.addEventListener('click', () => {
        keyInput.value = '';
        editor.hidden = false;
        keyInput.focus();
    });
    cancel.addEventListener('click', () => {
        keyInput.value = '';
        editor.hidden = true;
        setError(error.id, null);
    });
    save.addEventListener('click', () => saveAuth(providerId, keyInput));
    remove.addEventListener('click', () => removeAuth(providerId, error.id));
    if (status.childElementCount > 0) row.append(status);
    row.append(edit, remove, editor, error);
    return row;
}

async function reloadAuthStatus(): Promise<boolean> {
    const result = await invokeUi<Record<string, boolean>>(
        'ai_auth_status',
        undefined,
        'KI-Schlüsselstatus konnte nicht geladen werden',
    );
    if (result.error) return false;
    authStatus = result.value || {};
    return true;
}

async function saveAuth(providerId: string, keyInput: HTMLInputElement): Promise<void> {
    const key = keyInput.value;
    const errorId = `ai-auth-error-${providerId}`;
    if (!key.trim()) {
        setError(errorId, t('settings.ai.auth.keyEmpty'));
        return;
    }
    setError(errorId, null);
    const result = await invokeUi<Record<string, boolean>>(
        'ai_auth_set',
        { providerId, key },
        'KI-Schlüssel konnte nicht gespeichert werden',
    );
    keyInput.value = '';
    if (result.value) authStatus = result.value;
    await reloadAuthStatus();
    if (result.error) {
        setError(errorId, result.error);
        return;
    }
    renderProviders();
}

async function removeAuth(providerId: string, errorId: string): Promise<void> {
    setError(errorId, null);
    const result = await invokeUi<Record<string, boolean>>(
        'ai_auth_remove',
        { providerId },
        'KI-Schlüssel konnte nicht entfernt werden',
    );
    if (result.value) authStatus = result.value;
    await reloadAuthStatus();
    if (result.error) {
        setError(errorId, result.error);
        return;
    }
    renderProviders();
}

async function setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
    const result = await invokeUi<AiConfig>(
        'ai_provider_enable',
        { providerId, enabled },
        'KI-Anbieter konnte nicht geändert werden',
    );
    if (result.error) {
        setError('ai-providers-error', result.error);
        renderProviders();
        return;
    }
    aiConfig = result.value;
    setError('ai-providers-error', null);
    renderProviders();
    renderModels();
}

function providerCard(
    providerId: string,
    name: string,
    enabled: boolean,
    api?: string,
    doc?: string,
    isCustom = false,
): HTMLElement {
    const card = document.createElement('article');
    card.className = 'settings-ai-card';
    card.dataset.aiProviderId = providerId;

    const header = document.createElement('div');
    header.className = 'settings-ai-card__header';
    const title = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = name;
    const idText = document.createElement('span');
    idText.className = 'settings-ai-card__id';
    idText.textContent = providerId;
    title.append(strong, idText);
    header.append(
        title,
        makeToggle(
            `ai-provider-enabled-${providerId}`,
            enabled,
            t('settings.ai.auth.active.label'),
            (checked) => setProviderEnabled(providerId, checked),
        ),
    );
    card.appendChild(header);

    if (api || doc) {
        const details = document.createElement('div');
        details.className = 'settings-ai-card__details';
        if (api) {
            const endpoint = document.createElement('span');
            endpoint.textContent = t('settings.ai.providers.apiLabel', { api });
            details.appendChild(endpoint);
        }
        if (doc) {
            const documentation = document.createElement('span');
            documentation.textContent = t('settings.ai.providers.docLabel', { doc });
            details.appendChild(documentation);
        }
        card.appendChild(details);
    }
    card.appendChild(renderAuthRow(providerId, isCustom));
    return card;
}

// Rang für die Anbieter-Sortierung: aktive zuerst (0), dann verwendbare —
// hinterlegter Schlüssel oder Custom-Eintrag (Schlüssel dort optional) (1) —,
// dann der Rest (2). Innerhalb jeder Gruppe alphabetisch.
function providerRank(id: string): number {
    const cfg = aiConfig?.provider[id];
    if (cfg?.enabled) return 0;
    if (cfg?.custom || authStatus[id] === true) return 1;
    return 2;
}

function providerMatchesTerm(id: string, name: string, term: string): boolean {
    return !term || normalizeForSearch(`${name} ${id}`).includes(term);
}

type ProviderListEntry = {
    id: string;
    name: string;
    custom: boolean;
    api?: string;
    doc?: string;
};

function renderProviders(): void {
    const list = $('ai-provider-list');
    if (!list || !catalogResult || !aiConfig) return;
    list.textContent = '';
    const term = normalizeForSearch((input('ai-provider-search')?.value || '').trim());

    // Katalog- und Custom-Provider in EINER Liste, sortiert nach providerRank.
    const entries: ProviderListEntry[] = Object.entries(catalogResult.catalog)
        .filter(([id]) => !aiConfig!.provider[id]?.custom)
        .map(([id, provider]) => ({
            id,
            name: providerName(id, provider),
            custom: false,
            api: provider.api,
            doc: provider.doc,
        }));
    for (const [id, provider] of Object.entries(aiConfig.provider)) {
        if (!provider.custom) continue;
        entries.push({
            id,
            name: providerName(id, undefined, provider),
            custom: true,
            api: provider.options?.baseURL,
        });
    }

    const providers = entries
        .filter((entry) => providerMatchesTerm(entry.id, entry.name, term))
        .sort((a, b) => {
            const byRank = providerRank(a.id) - providerRank(b.id);
            return byRank !== 0 ? byRank : compareStrings(a.name, b.name);
        });
    if (providers.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'settings-hint';
        empty.textContent = term ? t('settings.ai.providers.noneMatch') : t('settings.ai.providers.empty');
        list.appendChild(empty);
    }
    for (const entry of providers) {
        const card = providerCard(
            entry.id,
            entry.name,
            aiConfig.provider[entry.id]?.enabled === true,
            entry.api,
            entry.doc,
            entry.custom,
        );
        if (entry.custom) {
            card.classList.add('settings-ai-card--custom');
            const actions = document.createElement('div');
            actions.className = 'settings-ai-card__actions';
            const edit = button(t('settings.ai.edit.action'));
            edit.id = `ai-custom-edit-${entry.id}`;
            edit.dataset.aiCustomEdit = entry.id;
            edit.addEventListener('click', () => openCustomDialog(entry.id));
            const remove = button(t('settings.themes.delete.action'));
            remove.id = `ai-custom-delete-${entry.id}`;
            remove.dataset.aiCustomDelete = entry.id;
            remove.addEventListener('click', () => deleteCustomProvider(entry.id));
            actions.append(edit, remove);
            card.appendChild(actions);
        }
        list.appendChild(card);
    }
}

function openCustomDialog(providerId?: string): void {
    const dialog = $('ai-custom-dialog');
    const idInput = input('ai-custom-id');
    const nameInput = input('ai-custom-name');
    const baseUrlInput = input('ai-custom-base-url');
    const keyInput = input('ai-custom-key');
    if (!dialog || !idInput || !nameInput || !baseUrlInput || !keyInput) return;
    const provider = providerId ? aiConfig?.provider[providerId] : undefined;
    $('ai-custom-title')!.textContent = provider ? t('settings.ai.custom.edit.title') : t('settings.ai.providers.addDialog.title');
    idInput.value = providerId || '';
    idInput.disabled = !!provider;
    nameInput.value = provider?.name || '';
    baseUrlInput.value = provider?.options?.baseURL || '';
    keyInput.value = '';
    setError('ai-custom-error', null);
    dialog.hidden = false;
    (provider ? nameInput : idInput).focus();
}

function closeCustomDialog(): void {
    const dialog = $('ai-custom-dialog');
    const keyInput = input('ai-custom-key');
    if (keyInput) keyInput.value = '';
    if (dialog) dialog.hidden = true;
    setError('ai-custom-error', null);
}

async function saveCustomProvider(event: Event): Promise<void> {
    event.preventDefault();
    const idInput = input('ai-custom-id');
    const nameInput = input('ai-custom-name');
    const baseUrlInput = input('ai-custom-base-url');
    const keyInput = input('ai-custom-key');
    if (!idInput || !nameInput || !baseUrlInput || !keyInput) return;
    setError('ai-custom-error', null);
    const definition = {
        id: idInput.value.trim(),
        name: nameInput.value.trim(),
        baseURL: baseUrlInput.value.trim(),
    };
    const result = await invokeUi<AiConfig>(
        'ai_custom_upsert',
        { definition },
        'Custom-Provider konnte nicht gespeichert werden',
    );
    if (result.error) {
        setError('ai-custom-error', result.error);
        return;
    }
    aiConfig = result.value;

    const key = keyInput.value;
    keyInput.value = '';
    if (key.trim()) {
        const authResult = await invokeUi<Record<string, boolean>>(
            'ai_auth_set',
            { providerId: definition.id, key },
            'Schlüssel des Custom-Providers konnte nicht gespeichert werden',
        );
        await reloadAuthStatus();
        if (authResult.error) {
            setError('ai-custom-error', authResult.error);
            renderProviders();
            return;
        }
    }
    closeCustomDialog();
    renderProviders();
    renderModels();
}

async function deleteCustomProvider(providerId: string): Promise<void> {
    const result = await invokeUi<AiConfig>(
        'ai_custom_delete',
        { id: providerId },
        'Custom-Provider konnte nicht gelöscht werden',
    );
    if (result.error) {
        setError('ai-providers-error', result.error);
        return;
    }
    aiConfig = result.value;
    renderProviders();
    renderModels();
}

function formatCount(value: number): string {
    if (value >= 1_000_000) return fmtNumber(value / 1_000_000, { maximumFractionDigits: 1 }) + 'm';
    if (value >= 1_000) return fmtNumber(value / 1_000, { maximumFractionDigits: 1 }) + 'k';
    return fmtNumber(value);
}

function formatCost(value: number): string {
    return Number.isInteger(value)
        ? fmtNumber(value)
        : fmtNumber(value, { maximumFractionDigits: 3 });
}

function modelBadges(model?: CatalogModel): string[] {
    if (!model) return [];
    const badges: string[] = [];
    if (model.limit?.context) badges.push(t('settings.ai.model.contextBadge', { count: formatCount(model.limit.context) }));
    if (model.reasoning) badges.push(t('settings.ai.model.reasoningBadge'));
    if (model.tool_call) badges.push(t('settings.ai.model.toolsBadge'));
    if (model.cost?.input !== undefined && model.cost.output !== undefined) {
        badges.push(
            t('settings.ai.model.costBadge', {
                input: '$' + formatCost(model.cost.input),
                output: '$' + formatCost(model.cost.output),
            }),
        );
    }
    return badges;
}

function configuredModels(
    providerId: string,
    provider: ProviderConfig,
): Array<[string, CatalogModel | ConfiguredModel]> {
    const source: Record<string, CatalogModel | ConfiguredModel> = provider.custom
        ? provider.models || {}
        : catalogResult?.catalog[providerId]?.models || {};
    const ids = new Set([...Object.keys(source), ...(provider.whitelist || [])]);
    const whitelisted = new Set(provider.whitelist || []);
    return Array.from(ids)
        .map((id) => [id, source[id] || {}] as [string, CatalogModel | ConfiguredModel])
        .sort(([idA, a], [idB, b]) => {
            // Verwendete (whitelistete) Modelle zuerst, danach der Rest —
            // jede Gruppe alphabetisch.
            const byUse = (whitelisted.has(idA) ? 0 : 1) - (whitelisted.has(idB) ? 0 : 1);
            if (byUse !== 0) return byUse;
            return compareStrings(a.name || idA, b.name || idB);
        });
}

async function toggleModel(providerId: string, modelId: string, on: boolean): Promise<void> {
    const result = await invokeUi<AiConfig>(
        'ai_model_toggle',
        { providerId, modelId, on },
        'KI-Modell konnte nicht geändert werden',
    );
    if (result.error) {
        setError('ai-models-error', result.error);
        renderModels();
        return;
    }
    aiConfig = result.value;
    setError('ai-models-error', null);
    renderModels();
}

function modelRow(
    providerId: string,
    provider: ProviderConfig,
    modelId: string,
    model: CatalogModel | ConfiguredModel,
): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-ai-model';
    row.dataset.aiModelId = modelId;
    const text = document.createElement('div');
    text.className = 'settings-ai-model__text';
    const name = document.createElement('strong');
    name.textContent = model.name || modelId;
    const id = document.createElement('span');
    id.textContent = modelId;
    text.append(name, id);
    const badges = document.createElement('div');
    badges.className = 'settings-ai-model__badges';
    for (const badgeText of modelBadges(provider.custom ? undefined : model as CatalogModel)) {
        const badge = document.createElement('span');
        badge.textContent = badgeText;
        badges.appendChild(badge);
    }
    const toggle = makeToggle(
        `ai-model-toggle-${providerId}-${modelId}`,
        provider.whitelist?.includes(modelId) === true,
        t('settings.ai.model.use.label'),
        (checked) => toggleModel(providerId, modelId, checked),
    );
    if (provider.whitelist?.includes(modelId) === true) {
        // Chat-Test nur für freigeschaltete Modelle anbieten.
        const actions = document.createElement('div');
        actions.className = 'settings-ai-model__actions';
        const test = button(t('settings.ai.model.test.action'), 'settings-ai-button settings-ai-button--small');
        test.id = `ai-model-test-${providerId}-${modelId}`;
        test.dataset.aiModelTest = `${providerId}/${modelId}`;
        test.addEventListener('click', (event) => {
            event.stopPropagation();
            openAiChatTest(
                providerId,
                modelId,
                `${providerName(providerId, catalogResult?.catalog[providerId], provider)} — ${model.name || modelId}`,
            );
        });
        actions.append(test, toggle);
        row.append(text, badges, actions);
        return row;
    }
    row.append(text, badges, toggle);
    return row;
}

function renderDefaultModels(): void {
    const element = select('ai-default-model');
    if (!element || !aiConfig) return;
    populateModelPicker(element, aiConfig, catalogResult || { catalog: {} }, {
        includeEmptyOption: true,
        emptyOptionLabel: t('settings.ai.defaultModel.none'),
        separator: ' — ',
    });
}

function renderModels(): void {
    const list = $('ai-model-list');
    if (!list || !aiConfig || !catalogResult) return;
    list.textContent = '';
    renderDefaultModels();
    const term = normalizeForSearch((input('ai-model-search')?.value || '').trim());
    const providers = Object.entries(aiConfig.provider)
        .filter(([, provider]) => provider.enabled)
        .sort(([idA, a], [idB, b]) =>
            compareStrings(
                providerName(idA, catalogResult!.catalog[idA], a),
                providerName(idB, catalogResult!.catalog[idB], b),
            ));
    if (providers.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'settings-ai-empty';
        empty.textContent = t('settings.ai.models.enableProviderFirst');
        list.appendChild(empty);
        return;
    }

    let rendered = 0;
    for (const [providerId, provider] of providers) {
        const name = providerName(
            providerId,
            catalogResult.catalog[providerId],
            provider,
        );
        const providerMatches = normalizeForSearch(`${name} ${providerId}`).includes(term);
        const models = configuredModels(providerId, provider)
            .filter(([modelId, model]) =>
                !term || providerMatches ||
                normalizeForSearch(`${model.name || ''} ${modelId}`).includes(term));
        if (term && !providerMatches && models.length === 0) continue;

        const group = document.createElement('section');
        group.className = 'settings-ai-model-group';
        group.dataset.aiModelProvider = providerId;
        const header = document.createElement('div');
        header.className = 'settings-ai-model-group__header';
        const title = document.createElement('h3');
        title.textContent = name;
        header.appendChild(title);
        if (provider.custom) {
            const fetch = button(t('settings.ai.providers.fetchModels.action'));
            fetch.id = `ai-models-fetch-${providerId}`;
            fetch.dataset.aiModelsFetch = providerId;
            fetch.addEventListener('click', () => fetchCustomModels(providerId, fetch));
            header.appendChild(fetch);
        }
        group.appendChild(header);
        const error = document.createElement('p');
        error.id = `ai-models-fetch-error-${providerId}`;
        error.className = 'settings-ai-error';
        error.hidden = true;
        group.appendChild(error);
        if (models.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'settings-hint';
            empty.textContent = provider.custom
                ? t('settings.ai.providers.models.empty')
                : t('settings.ai.models.noneMatch');
            group.appendChild(empty);
        } else {
            for (const [modelId, model] of models) {
                group.appendChild(modelRow(providerId, provider, modelId, model));
            }
        }
        list.appendChild(group);
        rendered += 1;
    }
    if (rendered === 0) {
        const empty = document.createElement('p');
        empty.className = 'settings-ai-empty';
        empty.textContent = t('settings.ai.models.noneMatch');
        list.appendChild(empty);
    }
}

async function fetchCustomModels(
    providerId: string,
    fetchButton: HTMLButtonElement,
): Promise<void> {
    const errorId = `ai-models-fetch-error-${providerId}`;
    setError(errorId, null);
    fetchButton.disabled = true;
    fetchButton.textContent = t('settings.ai.providers.fetchModels.status');
    const result = await invokeUi<AiConfig>(
        'ai_custom_models_fetch',
        { providerId },
        'Modelle des Custom-Providers konnten nicht abgerufen werden',
    );
    if (result.error) {
        fetchButton.disabled = false;
        fetchButton.textContent = t('settings.ai.providers.fetchModels.action');
        setError(errorId, result.error);
        return;
    }
    aiConfig = result.value;
    renderModels();
}

function formatCatalogDate(updatedAt: string): string {
    let date: Date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) {
        const [year, month, day] = updatedAt.split('-').map(Number);
        date = new Date(year, month - 1, day);
    } else {
        date = new Date(Number(updatedAt) * 1000);
    }
    return Number.isNaN(date.getTime())
        ? updatedAt
        : fmtDate(date, { dateStyle: 'medium' });
}

function renderCatalogUpdated(): void {
    const element = $('ai-catalog-updated');
    if (!element || !catalogResult) return;
    const source = catalogResult.source === 'cache'
        ? t('settings.ai.catalog.sourceCache')
        : t('settings.ai.catalog.sourceSnapshot');
    element.textContent = t('settings.ai.models.catalogAge', {
        date: formatCatalogDate(catalogResult.updatedAt),
        source,
    });
}

async function refreshCatalog(): Promise<void> {
    const refresh = $('ai-catalog-refresh') as HTMLButtonElement | null;
    if (!refresh) return;
    refresh.disabled = true;
    refresh.textContent = t('settings.ai.models.refreshCatalog.status');
    setError('ai-models-error', null);
    const result = await invokeUi<CatalogResult>(
        'ai_catalog_refresh',
        undefined,
        'KI-Katalog konnte nicht aktualisiert werden',
    );
    refresh.disabled = false;
    refresh.textContent = t('settings.ai.models.refreshCatalog.action');
    if (result.error) {
        setError('ai-models-error', result.error);
        return;
    }
    catalogResult = result.value;
    renderCatalogUpdated();
    renderProviders();
    renderModels();
}

async function setDefaultModel(value: string): Promise<void> {
    let providerId: string | null = null;
    let modelId: string | null = null;
    if (value) {
        [providerId, modelId] = JSON.parse(value) as [string, string];
    }
    const result = await invokeUi<AiConfig>(
        'ai_default_model_set',
        { providerId, modelId },
        'Default-Modell konnte nicht gespeichert werden',
    );
    if (result.error) {
        setError('ai-models-error', result.error);
        renderDefaultModels();
        return;
    }
    aiConfig = result.value;
    setError('ai-models-error', null);
    renderDefaultModels();
}

async function loadAiData(): Promise<void> {
    if (loadPromise) return loadPromise;
    const providerList = $('ai-provider-list');
    const modelList = $('ai-model-list');
    if (providerList) providerList.textContent = t('settings.ai.loading.status');
    if (modelList) modelList.textContent = t('settings.ai.loading.status');
    loadPromise = Promise.all([
        safeInvoke<CatalogResult>('ai_catalog_get', undefined, 'KI-Katalog laden'),
        safeInvoke<AiConfig>('ai_config_get', undefined, 'KI-Konfiguration laden'),
        safeInvoke<Record<string, boolean>>(
            'ai_auth_status',
            undefined,
            'KI-Schlüsselstatus laden',
        ),
    ]).then(([catalog, config, status]) => {
        if (!catalog || !config || !status) {
            setError('ai-providers-error', t('settings.ai.loadFailed'));
            setError('ai-models-error', t('settings.ai.loadFailed'));
            return;
        }
        catalogResult = catalog;
        aiConfig = config;
        authStatus = status;
        setError('ai-providers-error', null);
        setError('ai-models-error', null);
        renderCatalogUpdated();
        renderProviders();
        renderModels();
    }).finally(() => {
        loadPromise = null;
    });
    return loadPromise;
}

export function initSettingsAi(): void {
    if (!$('settings-panel-ki-anbieter') && !$('settings-panel-ki-modelle')) return;
    catalogResult = null;
    aiConfig = null;
    authStatus = {};
    loadPromise = null;
    $('settings-tab-ki-anbieter')?.addEventListener('click', () => loadAiData());
    $('settings-tab-ki-modelle')?.addEventListener('click', () => loadAiData());
    $('ai-custom-add')?.addEventListener('click', () => openCustomDialog());
    $('ai-custom-cancel')?.addEventListener('click', closeCustomDialog);
    $('ai-custom-form')?.addEventListener('submit', saveCustomProvider);
    $('ai-custom-dialog')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeCustomDialog();
    });
    input('ai-provider-search')?.addEventListener('input', renderProviders);
    input('ai-model-search')?.addEventListener('input', renderModels);
    $('ai-catalog-refresh')?.addEventListener('click', refreshCatalog);
    select('ai-default-model')?.addEventListener('change', (event) => {
        setDefaultModel((event.currentTarget as HTMLSelectElement).value);
    });
    initAiChatTest();
}
