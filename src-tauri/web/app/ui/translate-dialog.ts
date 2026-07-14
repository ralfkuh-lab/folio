import { syncEditorTextToStoreRequired } from '../state/document';
import { getActiveTabId } from '../state/tabs';
import { renderPreviewText } from '../view/preview';
import { folioLog, safeInvoke } from '../util/log';
import { populateModelPicker } from './ai-model-picker';
import { t, tPlural } from '../i18n/translate';
import { fmtNumber } from '../i18n/format';

type CatalogModel = { id: string; name?: string };
type CatalogProvider = {
    id: string;
    name?: string;
    models?: Record<string, CatalogModel>;
};
type CatalogResult = { catalog: Record<string, CatalogProvider> };
type ProviderConfig = {
    enabled: boolean;
    name?: string;
    custom?: boolean;
    models?: Record<string, { name?: string }>;
    whitelist: string[];
};
type AiConfig = {
    provider: Record<string, ProviderConfig>;
    defaultModel?: { provider: string; model: string } | null;
    translate?: { recentLanguages?: string[] };
};

const PRESET_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ja', 'zh'];
let configCache: AiConfig | null = null;
let catalogCache: CatalogResult | null = null;
let documentIsMarkdown = document.body.classList.contains('kind-markdown');
let busy = false;
let refreshScheduled = false;
let runningLanguages: string[] = [];

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function select(id: string): HTMLSelectElement | null {
    return $(id) as HTMLSelectElement | null;
}

function input(id: string): HTMLInputElement | null {
    return $(id) as HTMLInputElement | null;
}

function invoke<T>(cmd: string, args?: any): Promise<T> {
    return window.__TAURI__.core.invoke(cmd, args) as Promise<T>;
}

function hasWhitelistedModel(config: AiConfig | null): boolean {
    return !!config && Object.values(config.provider).some(
        (provider) => provider.enabled && (provider.whitelist || []).length > 0,
    );
}

function syncMenuEnabled(): void {
    const enabled = documentIsMarkdown && hasWhitelistedModel(configCache);
    const button = $('tb-ai-translate') as HTMLButtonElement | null;
    if (button) button.disabled = !enabled;
    safeInvoke(
        'menu_set_enabled',
        {
            id: 'edit.ai_translate',
            enabled,
        },
        'menu_set_enabled edit.ai_translate',
        'debug',
    );
}

function looksLikeConfig(value: unknown): value is AiConfig {
    return !!value && typeof value === 'object' &&
        !!(value as AiConfig).provider &&
        typeof (value as AiConfig).provider === 'object';
}

export async function refreshAiTranslateAvailability(
    knownConfig?: unknown,
): Promise<void> {
    if (looksLikeConfig(knownConfig)) {
        configCache = knownConfig;
        syncMenuEnabled();
        return;
    }
    const config = await safeInvoke<AiConfig>(
        'ai_config_get',
        undefined,
        'KI-Konfiguration für Übersetzungsmenü laden',
        'debug',
    );
    configCache = config || null;
    syncMenuEnabled();
}

function scheduleAvailabilityRefresh(knownConfig?: unknown): void {
    if (looksLikeConfig(knownConfig)) {
        void refreshAiTranslateAvailability(knownConfig);
        return;
    }
    if (refreshScheduled) return;
    refreshScheduled = true;
    Promise.resolve().then(() => {
        refreshScheduled = false;
        void refreshAiTranslateAvailability();
    });
}

function setError(message: string | null): void {
    const error = $('ai-translate-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function renderModels(config: AiConfig, catalog: CatalogResult): void {
    const modelSelect = select('ai-translate-model');
    if (!modelSelect) return;
    populateModelPicker(modelSelect, config, catalog, { separator: ' · ' });
}

function applyRecentLanguages(config: AiConfig): void {
    const recent = config.translate?.recentLanguages || [];
    for (const language of PRESET_LANGUAGES) {
        const checkbox = input(`ai-translate-lang-${language}`);
        if (checkbox) checkbox.checked = recent.includes(language);
    }
    const extra = input('ai-translate-langs-extra');
    if (extra) {
        extra.value = recent
            .filter((language) => !PRESET_LANGUAGES.includes(language))
            .join(', ');
    }
}

function selectedLanguages(): string[] {
    const result = PRESET_LANGUAGES.filter(
        (language) => input(`ai-translate-lang-${language}`)?.checked,
    );
    const extra = (input('ai-translate-langs-extra')?.value || '')
        .split(',')
        .map((language) => language.trim())
        .filter(Boolean);
    for (const language of extra) {
        if (!result.includes(language)) result.push(language);
    }
    return result;
}

function setBusy(next: boolean): void {
    busy = next;
    const dialog = $('ai-translate-dialog');
    if (dialog) {
        for (const element of Array.from(
            dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
                'input, select, button',
            ),
        )) {
            element.disabled = next;
        }
    }
    const start = $('ai-translate-start') as HTMLButtonElement | null;
    if (start) start.textContent = next ? t('ai.translate.status.running') : t('ai.translate.submit.action');
}

function showStatus(language: string): void {
    const status = $('ai-translate-status');
    if (!status) return;
    status.hidden = false;
    status.classList.add('ai-status-running');
    updateStatusText(t('ai.translate.status.charCount', {
        language,
        charsPart: tPlural('ai.status.charsPart', 0, { formattedCount: fmtNumber(0) }),
    }));
    const cancel = $('ai-translate-status-cancel') as HTMLButtonElement | null;
    if (cancel) {
        cancel.disabled = false;
        cancel.textContent = t('dialogs.common.cancel');
    }
}

function hideStatus(): void {
    const status = $('ai-translate-status');
    if (status) {
        status.classList.remove('ai-status-running');
        status.hidden = true;
    }
}

function updateStatusText(text: string): void {
    const label = $('ai-translate-status-text');
    if (label) label.textContent = text;
}

function reopenTranslateDialogWithError(error: unknown): void {
    const dialog = $('ai-translate-dialog');
    if (dialog) dialog.hidden = false;
    setError(String(error));
}

function closeTranslateDialog(): void {
    if (busy) return;
    const dialog = $('ai-translate-dialog');
    if (dialog) dialog.hidden = true;
    setError(null);
}

export async function openTranslateDialog(): Promise<void> {
    const dialog = $('ai-translate-dialog');
    if (!dialog) return;
    setError(null);
    setBusy(false);
    try {
        const [config, catalog] = await Promise.all([
            invoke<AiConfig>('ai_config_get'),
            invoke<CatalogResult>('ai_catalog_get'),
        ]);
        configCache = config;
        catalogCache = catalog;
        syncMenuEnabled();
        renderModels(config, catalog);
        applyRecentLanguages(config);
        if (!select('ai-translate-model')?.value) {
            setError(t('errors.ai.noEnabledModel'));
        }
        dialog.hidden = false;
        input('ai-translate-lang-en')?.focus();
    } catch (error) {
        folioLog.warn('translate', 'Übersetzungsdialog konnte nicht geladen werden', {
            error: String(error),
        });
        dialog.hidden = false;
        setError(String(error));
    }
}

async function startTranslation(): Promise<void> {
    const languages = selectedLanguages();
    if (languages.length === 0) {
        setError(t('errors.ai.noTargetLanguage'));
        return;
    }
    const modelValue = select('ai-translate-model')?.value;
    if (!modelValue) {
        setError(t('errors.ai.noModelSelected'));
        return;
    }
    let providerId: string;
    let modelId: string;
    try {
        [providerId, modelId] = JSON.parse(modelValue) as [string, string];
    } catch {
        setError(t('errors.ai.invalidModelSelection'));
        return;
    }

    setError(null);
    setBusy(true);
    try {
        await syncEditorTextToStoreRequired();
    } catch (error) {
        folioLog.warn('translate', 'Editorinhalt konnte nicht synchronisiert werden', {
            error: String(error),
        });
        setBusy(false);
        setError(String(error));
        return;
    }

    runningLanguages = languages;
    const dialog = $('ai-translate-dialog');
    if (dialog) dialog.hidden = true;
    showStatus(languages[0]);
    invoke<string[]>('ai_translate_document', {
        languages,
        providerId,
        modelId,
    }).then(() => {
        setBusy(false);
        hideStatus();
        runningLanguages = [];
        scheduleAvailabilityRefresh();
    }).catch((error) => {
        folioLog.warn('translate', 'Dokumentübersetzung fehlgeschlagen', {
            error: String(error),
        });
        setBusy(false);
        hideStatus();
        runningLanguages = [];
        reopenTranslateDialogWithError(error);
    });
}

export function initTranslateDialog(): void {
    if (!$('ai-translate-dialog')) return;
    documentIsMarkdown = document.body.classList.contains('kind-markdown');
    $('ai-translate-cancel')?.addEventListener('click', closeTranslateDialog);
    $('ai-translate-start')?.addEventListener('click', () => void startTranslation());
    $('ai-translate-status-cancel')?.addEventListener('click', () => {
        const button = $('ai-translate-status-cancel') as HTMLButtonElement | null;
        if (button) {
            button.disabled = true;
            button.textContent = t('ai.translate.status.cancelling');
        }
        invoke<void>('ai_translate_cancel').catch((error) => {
            folioLog.warn('translate', 'Abbruch der Dokumentübersetzung fehlgeschlagen', {
                error: String(error),
            });
            if (button) {
                button.disabled = false;
                button.textContent = t('dialogs.common.cancel');
            }
        });
    });
    $('ai-translate-dialog')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || busy) return;
        event.preventDefault();
        event.stopPropagation();
        closeTranslateDialog();
    });
    document.addEventListener('folio-ai-invoke-complete', (event) => {
        scheduleAvailabilityRefresh((event as CustomEvent).detail);
    });

    // Statt eigener Tauri-Listener auf document:loaded/closed (die dem
    // state/document applyDocKind-Race unterlagen) jetzt Window-Event,
    // das am Ende von applyDocKind dispatched wird (nach class + menus).
    window.addEventListener('folio-doc-kind-changed', () => {
        documentIsMarkdown = document.body.classList.contains('kind-markdown');
        syncMenuEnabled();
    });

    const events = window.__TAURI__ && window.__TAURI__.event;
    if (events && typeof events.listen === 'function') {
        events.listen('menu:edit_ai_translate', () => void openTranslateDialog());
        events.listen('ai:translate_stream', (event: any) => {
            const data = event?.payload || {};
            const language = String(data.language || '');
            const chars = Number(data.chars) || 0;
            updateStatusText(t('ai.translate.status.charCount', {
                language,
                charsPart: tPlural('ai.status.charsPart', chars, { formattedCount: fmtNumber(chars) }),
            }));
            if (typeof data.tabId === 'number'
                && data.tabId === getActiveTabId()
                && typeof data.text === 'string') {
                void renderPreviewText(data.text);
            }
        });
        events.listen('ai:translate_done', (event: any) => {
            const data = event?.payload || {};
            const language = String(data.language || '');
            const index = runningLanguages.indexOf(language);
            const next = index >= 0 ? runningLanguages[index + 1] : undefined;
            updateStatusText(next
                ? t('ai.translate.status.doneWithNext', {
                    language,
                    next,
                    charsPart: tPlural('ai.status.charsPart', 0, { formattedCount: fmtNumber(0) }),
                })
                : t('ai.translate.status.done', { language }));
        });
    }
    void refreshAiTranslateAvailability();
}
