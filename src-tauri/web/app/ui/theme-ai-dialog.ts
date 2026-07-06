import { populateModelPicker, AiConfig, CatalogResult } from './ai-model-picker';
import { applyThemeDraft, getCurrentThemeId } from './theme-editor';
import { folioLog } from '../util/log';

export type ThemeDraft = {
    manifest?: {
        name: string;
        description: string;
        code: string;
        logo?: string | null;
        cover: boolean;
        header: boolean;
        footer: boolean;
        hideInlineFrontmatter: boolean;
        formatVersion: number;
    } | null;
    contentCss: string;
    darkCss?: string | null;
    pageCss?: string | null;
    coverHtml?: string | null;
    headerHtml?: string | null;
    footerHtml?: string | null;
};

let busy = false;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function invoke<T>(cmd: string, args?: any): Promise<T> {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') {
        return Promise.reject(new Error('Tauri core invoke not available'));
    }
    return core.invoke(cmd, args) as Promise<T>;
}

function setError(message: string | null): void {
    const error = $('theme-ai-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function setBusy(next: boolean): void {
    busy = next;
    const dialog = $('theme-ai-dialog');
    if (dialog) {
        for (const element of Array.from(
            dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
                'input, select, textarea, button',
            ),
        )) {
            if (element.id === 'theme-ai-cancel') {
                element.disabled = false;
                continue;
            }
            element.disabled = next;
        }
    }
    const startBtn = $('theme-ai-start') as HTMLButtonElement | null;
    if (startBtn) {
        startBtn.textContent = next ? 'Erzeuge…' : 'Starten';
    }
    const statusDiv = $('theme-ai-status');
    if (statusDiv) {
        statusDiv.hidden = !next;
    }
    const cancelBtn = $('theme-ai-cancel') as HTMLButtonElement | null;
    if (cancelBtn) {
        cancelBtn.textContent = 'Abbrechen';
        cancelBtn.disabled = false;
    }
}

function updateStatusText(text: string): void {
    const label = $('theme-ai-status-text');
    if (label) label.textContent = text;
}

export function closeThemeAiDialog(): void {
    if (busy) return;
    const dialog = $('theme-ai-dialog');
    if (dialog) dialog.hidden = true;
    setError(null);
}

export async function openThemeAiDialog(): Promise<void> {
    const dialog = $('theme-ai-dialog');
    if (!dialog) return;
    setError(null);
    setBusy(false);
    updateStatusText('Warte auf KI...');
    const promptArea = $('theme-ai-prompt') as HTMLTextAreaElement | null;
    if (promptArea) promptArea.value = '';

    try {
        const [config, catalog] = await Promise.all([
            invoke<AiConfig>('ai_config_get'),
            invoke<CatalogResult>('ai_catalog_get'),
        ]);
        const modelSelect = $('theme-ai-model') as HTMLSelectElement | null;
        if (modelSelect) {
            populateModelPicker(modelSelect, config, catalog, { separator: ' · ' });
            if (!modelSelect.value) {
                setError('Kein freigeschaltetes Modell verfügbar.');
            }
        }
        dialog.hidden = false;
        promptArea?.focus();
    } catch (error) {
        folioLog.warn('theme-ai', 'KI-Theme-Dialog konnte nicht geladen werden', {
            error: String(error),
        });
        dialog.hidden = false;
        setError(String(error));
    }
}

async function startGeneration(): Promise<void> {
    const prompt = ($('theme-ai-prompt') as HTMLTextAreaElement | null)?.value || '';
    if (!prompt.trim()) {
        setError('Bitte einen Prompt eingeben.');
        return;
    }
    const modelSelect = $('theme-ai-model') as HTMLSelectElement | null;
    const modelValue = modelSelect?.value;
    if (!modelValue) {
        setError('Bitte ein Modell auswählen.');
        return;
    }
    let providerId: string;
    let modelId: string;
    try {
        [providerId, modelId] = JSON.parse(modelValue) as [string, string];
    } catch {
        setError('Die Modellauswahl ist ungültig.');
        return;
    }

    setError(null);
    setBusy(true);
    updateStatusText('KI-Generierung · 0 Zeichen');

    const baseId = getCurrentThemeId();

    invoke<ThemeDraft>('ai_theme_author', {
        prompt,
        baseId,
        providerId,
        modelId,
    }).then((draft) => {
        setBusy(false);
        const openThemeId = getCurrentThemeId();
        if (!baseId || openThemeId !== baseId) {
            folioLog.warn('theme-ai', 'KI-Theme-Draft wegen Theme-Wechsel verworfen', {
                requestedThemeId: baseId,
                openThemeId,
            });
            closeThemeAiDialog();
            return;
        }
        applyThemeDraft(draft);
        closeThemeAiDialog();
    }).catch((error) => {
        folioLog.warn('theme-ai', 'KI-Theme-Generierung fehlgeschlagen', {
            error: String(error),
        });
        setBusy(false);
        setError(String(error));
    });
}

export function initThemeAiDialog(): void {
    const dialog = $('theme-ai-dialog');
    if (!dialog) return;

    $('theme-ai-cancel')?.addEventListener('click', () => {
        if (busy) {
            const button = $('theme-ai-cancel') as HTMLButtonElement | null;
            if (button) {
                button.disabled = true;
                button.textContent = 'Bricht ab…';
            }
            invoke<void>('ai_theme_author_cancel').catch((error) => {
                folioLog.warn('theme-ai', 'Abbruch fehlgeschlagen', {
                    error: String(error),
                });
                if (button) {
                    button.disabled = false;
                    button.textContent = 'Abbrechen';
                }
            });
        } else {
            closeThemeAiDialog();
        }
    });

    $('theme-ai-start')?.addEventListener('click', () => {
        void startGeneration();
    });

    dialog.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || busy) return;
        event.preventDefault();
        event.stopPropagation();
        closeThemeAiDialog();
    });

    const events = window.__TAURI__ && window.__TAURI__.event;
    if (events && typeof events.listen === 'function') {
        events.listen('ai:theme_stream', (event: any) => {
            const data = event?.payload || {};
            const chars = Number(data.chars) || 0;
            updateStatusText(`KI-Generierung · ${chars.toLocaleString('de-DE')} Zeichen`);
        });
        events.listen('ai:theme_done', (event: any) => {
            const data = event?.payload || {};
            if (!data.ok) {
                setError(data.error || 'Generierung fehlgeschlagen.');
            }
        });
    }
}
