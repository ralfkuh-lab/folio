// KI-Aktionen-Dialog (Spec docs/spec-ki-actions.md, Etappe A2):
// Funktionsliste links, editierbarer Prompt rechts, Ziel/Scope/Modell.
// Der Lauf ist atomar an den Quell-Tab gebunden (eingefrorener Snapshot
// + sha256 + tab-gebundener Sync); Cancel/Events korrelieren über die
// runId aus dem `ai:action_started`-Handshake. Das Replace-Ziel liefert
// `kind:"text"` und öffnet die Diff-Review (ai-diff-review.ts, A3) —
// nichts fasst das Original vor der expliziten Übernahme an.

import {
    getCurrentPath,
    getEditorText,
    syncEditorTextToStoreForTab,
} from '../state/document';
import { getActiveTabId } from '../state/tabs';
import { renderPreviewText } from '../view/preview';
import { folioLog, safeInvoke } from '../util/log';
import { isAiReviewOpen, openAiDiffReview } from './ai-diff-review';
import { populateModelPicker, type AiConfig, type CatalogResult } from './ai-model-picker';

export type ActionTemplate = {
    id: string;
    name: string;
    description: string;
    prompt: string;
    masking: boolean;
    scope: 'document' | 'selection' | 'auto';
    target: 'new-file' | 'replace';
    suffix: string;
    builtin: boolean;
};

type DialogState = 'closed' | 'loading' | 'ready' | 'running';

type SourceContext = {
    tabId: number;
    path: string;
    text: string;
    sha256: string;
    selection: { start: number; length: number } | null;
};

const CUSTOM_ENTRY_ID = '__custom__';

let state: DialogState = 'closed';
let openGeneration = 0;
let templates: ActionTemplate[] = [];
let selectedId: string = CUSTOM_ENTRY_ID;
let source: SourceContext | null = null;
let configCache: AiConfig | null = null;
let documentIsMarkdown = document.body.classList.contains('kind-markdown');
let refreshScheduled = false;

// Laufender Versuch: requestId lokal erzeugt; runId kommt erst mit dem
// Started-Handshake. Cancel vor Started merkt nur das Abort-Flag.
let currentRequestId: string | null = null;
let currentRunId: number | null = null;
let currentActionName = '';
let abortRequested = false;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function invoke<T>(cmd: string, args?: any): Promise<T> {
    return window.__TAURI__.core.invoke(cmd, args) as Promise<T>;
}

function codePoints(text: string): number {
    return [...text].length;
}

async function sha256Hex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function hasWhitelistedModel(config: AiConfig | null): boolean {
    return !!config && Object.values(config.provider).some(
        (provider) => provider.enabled && (provider.whitelist || []).length > 0,
    );
}

function syncMenuEnabled(): void {
    const enabled = documentIsMarkdown && hasWhitelistedModel(configCache);
    const button = $('tb-ai-actions') as HTMLButtonElement | null;
    if (button) button.disabled = !enabled;
    safeInvoke(
        'menu_set_enabled',
        { id: 'edit.ai_actions', enabled },
        'menu_set_enabled edit.ai_actions',
        'debug',
    );
}

function looksLikeConfig(value: unknown): value is AiConfig {
    return !!value && typeof value === 'object' &&
        !!(value as AiConfig).provider &&
        typeof (value as AiConfig).provider === 'object';
}

export async function refreshAiActionsAvailability(knownConfig?: unknown): Promise<void> {
    if (looksLikeConfig(knownConfig)) {
        configCache = knownConfig;
        syncMenuEnabled();
        return;
    }
    const config = await safeInvoke<AiConfig>(
        'ai_config_get',
        undefined,
        'KI-Konfiguration für Aktionsmenü laden',
        'debug',
    );
    configCache = config || null;
    syncMenuEnabled();
}

function scheduleAvailabilityRefresh(knownConfig?: unknown): void {
    if (looksLikeConfig(knownConfig)) {
        void refreshAiActionsAvailability(knownConfig);
        return;
    }
    if (refreshScheduled) return;
    refreshScheduled = true;
    Promise.resolve().then(() => {
        refreshScheduled = false;
        void refreshAiActionsAvailability();
    });
}

function setError(message: string | null): void {
    const error = $('ai-actions-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function setBusy(busy: boolean): void {
    const dialog = $('ai-actions-dialog');
    if (dialog) {
        for (const element of Array.from(
            dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>(
                'input, select, button, textarea',
            ),
        )) {
            element.disabled = busy;
        }
    }
    // Dialog-Abbrechen bleibt immer bedienbar.
    const cancel = $('ai-actions-cancel') as HTMLButtonElement | null;
    if (cancel) cancel.disabled = false;
    const start = $('ai-actions-start') as HTMLButtonElement | null;
    if (start) start.textContent = busy ? 'Läuft…' : 'Ausführen';
}

function templateById(id: string): ActionTemplate | null {
    return templates.find((template) => template.id === id) || null;
}

function selectedTemplate(): ActionTemplate | null {
    return selectedId === CUSTOM_ENTRY_ID ? null : templateById(selectedId);
}

function effectiveSuffix(): string {
    return selectedTemplate()?.suffix || 'ai';
}

function effectiveMasking(): boolean {
    return selectedTemplate()?.masking ?? false;
}

function renderActionList(): void {
    const list = $('ai-actions-list');
    if (!list) return;
    list.textContent = '';
    const entries: Array<{ id: string; name: string; description: string; badge: string | null }> = [
        ...templates.filter((template) => template.builtin).map((template) => ({
            id: template.id,
            name: template.name,
            description: template.description,
            badge: null,
        })),
        ...templates.filter((template) => !template.builtin).map((template) => ({
            id: template.id,
            name: template.name,
            description: template.description,
            badge: 'Eigene Vorlage',
        })),
        {
            id: CUSTOM_ENTRY_ID,
            name: 'Eigener Prompt',
            description: 'Freie Anweisung ohne Vorlage.',
            badge: null,
        },
    ];
    for (const entry of entries) {
        const item = document.createElement('li');
        item.className = 'ai-actions-dialog__item';
        item.setAttribute('role', 'option');
        item.dataset.actionId = entry.id;
        item.setAttribute('aria-selected', String(entry.id === selectedId));
        const name = document.createElement('span');
        name.className = 'ai-actions-dialog__item-name';
        name.textContent = entry.name;
        item.appendChild(name);
        if (entry.description) {
            const description = document.createElement('span');
            description.className = 'ai-actions-dialog__item-desc';
            description.textContent = entry.description;
            item.appendChild(description);
        }
        if (entry.badge) {
            const badge = document.createElement('span');
            badge.className = 'ai-actions-dialog__item-badge';
            badge.textContent = entry.badge;
            item.appendChild(badge);
        }
        item.addEventListener('click', () => applySelection(entry.id));
        list.appendChild(item);
    }
}

function applySelection(id: string): void {
    selectedId = id;
    const list = $('ai-actions-list');
    if (list) {
        for (const item of Array.from(list.querySelectorAll('.ai-actions-dialog__item'))) {
            item.setAttribute(
                'aria-selected',
                String((item as HTMLElement).dataset.actionId === id),
            );
        }
    }
    const template = selectedTemplate();
    const prompt = $('ai-actions-prompt') as HTMLTextAreaElement | null;
    if (prompt) prompt.value = template?.prompt || '';

    const preferReplace = template?.target === 'replace';
    const newFile = $('ai-actions-target-newfile') as HTMLInputElement | null;
    const replace = $('ai-actions-target-replace') as HTMLInputElement | null;
    if (newFile) newFile.checked = !preferReplace;
    if (replace) replace.checked = preferReplace;

    const selectionRadio = $('ai-actions-scope-selection') as HTMLInputElement | null;
    const documentRadio = $('ai-actions-scope-document') as HTMLInputElement | null;
    const preferSelection = !!source?.selection
        && (template ? template.scope !== 'document' : true);
    if (selectionRadio) selectionRadio.checked = preferSelection;
    if (documentRadio) documentRadio.checked = !preferSelection;
}

function syncScopeRow(): void {
    const row = $('ai-actions-scope-row');
    if (!row) return;
    const selection = source?.selection || null;
    row.hidden = !selection;
    if (selection && source) {
        const label = $('ai-actions-scope-selection-label');
        if (label) {
            const utf16Start = selection.start;
            const utf16End = selection.start + selection.length;
            const selectedText = source.text.slice(utf16Start, utf16End);
            label.textContent =
                `Selektion (${codePoints(selectedText).toLocaleString('de-DE')} Zeichen)`;
        }
    }
}

function showStatus(actionName: string): void {
    const status = $('ai-action-status');
    if (!status) return;
    status.hidden = false;
    updateStatusText(`✨ ${actionName} · 0 Zeichen`);
    const cancel = $('ai-action-status-cancel') as HTMLButtonElement | null;
    if (cancel) {
        cancel.disabled = false;
        cancel.textContent = 'Abbrechen';
    }
}

function hideStatus(): void {
    const status = $('ai-action-status');
    if (status) status.hidden = true;
}

function updateStatusText(text: string): void {
    const label = $('ai-action-status-text');
    if (label) label.textContent = text;
}

function closeDialog(): void {
    if (state === 'running') return;
    openGeneration += 1;
    state = 'closed';
    const dialog = $('ai-actions-dialog');
    if (dialog) dialog.hidden = true;
    setError(null);
    source = null;
}

export async function openAiActionsDialog(): Promise<void> {
    const dialog = $('ai-actions-dialog');
    if (!dialog || state === 'running') return;
    const generation = ++openGeneration;
    state = 'loading';
    setError(null);
    setBusy(false);

    // Quelle einfrieren: Tab, Pfad, Snapshot, Hash, Selektion.
    const tabId = getActiveTabId();
    const path = getCurrentPath();
    if (tabId === null || !path) {
        state = 'closed';
        return;
    }
    const text = getEditorText();
    let selection: { start: number; length: number } | null = null;
    if (window.FolioEditor && typeof window.FolioEditor.getSelection === 'function') {
        const raw = window.FolioEditor.getSelection();
        if (raw && raw.length > 0) selection = { start: raw.start, length: raw.length };
    }

    try {
        const [config, catalog, templateList, digest] = await Promise.all([
            invoke<AiConfig>('ai_config_get'),
            invoke<CatalogResult>('ai_catalog_get'),
            invoke<ActionTemplate[]>('ai_actions_list'),
            sha256Hex(text),
        ]);
        // Close während des Ladens invalidiert das Resultat — kein
        // Geister-Reopen (openGeneration-Token, Spec-Zustandsautomat).
        if (generation !== openGeneration) return;
        configCache = config;
        templates = templateList;
        source = { tabId, path, text, sha256: digest, selection };
        syncMenuEnabled();

        const modelSelect = $('ai-actions-model') as HTMLSelectElement | null;
        if (modelSelect) populateModelPicker(modelSelect, config, catalog, { separator: ' · ' });
        renderActionList();
        applySelection(templates.find((template) => template.builtin)?.id || CUSTOM_ENTRY_ID);
        syncScopeRow();
        if (!modelSelect?.value) setError('Kein freigeschaltetes Modell verfügbar.');

        state = 'ready';
        dialog.hidden = false;
        ($('ai-actions-prompt') as HTMLTextAreaElement | null)?.focus();
    } catch (error) {
        if (generation !== openGeneration) return;
        folioLog.warn('ai-actions', 'KI-Aktionen-Dialog konnte nicht geladen werden', {
            error: String(error),
        });
        state = 'ready';
        dialog.hidden = false;
        setError(String(error));
    }
}

function currentScopePayload(): { start: number; length: number } | null {
    const selectionRadio = $('ai-actions-scope-selection') as HTMLInputElement | null;
    if (!source?.selection || !selectionRadio?.checked) return null;
    return source.selection;
}

async function startAction(): Promise<void> {
    if (!source) return;
    const promptField = $('ai-actions-prompt') as HTMLTextAreaElement | null;
    const prompt = (promptField?.value || '').trim();
    if (!prompt) {
        setError('Der Prompt darf nicht leer sein.');
        return;
    }
    const modelValue = ($('ai-actions-model') as HTMLSelectElement | null)?.value;
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

    // Revalidierung: aktiver Tab und Snapshot müssen der eingefrorenen
    // Quelle entsprechen — sonst würde der Sync fremden Text verankern.
    if (getActiveTabId() !== source.tabId || getCurrentPath() !== source.path) {
        setError('Die Quelle hat sich geändert — Dialog bitte neu öffnen.');
        return;
    }
    if (getEditorText() !== source.text) {
        setError('Das Dokument wurde zwischenzeitlich geändert — Dialog bitte neu öffnen.');
        return;
    }

    setError(null);
    setBusy(true);
    try {
        await syncEditorTextToStoreForTab(source.tabId, source.text);
    } catch (error) {
        setBusy(false);
        setError(String(error));
        return;
    }

    const template = selectedTemplate();
    const replaceRadio = $('ai-actions-target-replace') as HTMLInputElement | null;
    const target: 'new-file' | 'replace' = replaceRadio?.checked ? 'replace' : 'new-file';
    if (target === 'replace' && isAiReviewOpen()) {
        setError('Erst die offene KI-Review abschließen.');
        setBusy(false);
        return;
    }
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentRequestId = requestId;
    currentRunId = null;
    abortRequested = false;
    currentActionName = template?.name || 'Eigener Prompt';
    state = 'running';
    const dialog = $('ai-actions-dialog');
    if (dialog) dialog.hidden = true;
    showStatus(currentActionName);

    const requestSource = source;
    const scopePayload = currentScopePayload();
    const actionName = currentActionName;
    invoke<{ kind: string; runId: number; path?: string; text?: string }>('ai_action_run', {
        request: {
            actionId: template?.id ?? null,
            requestId,
            prompt,
            providerId,
            modelId,
            target,
            masking: effectiveMasking(),
            suffix: effectiveSuffix(),
            scope: scopePayload,
            sourceTabId: requestSource.tabId,
            sourcePath: requestSource.path,
            sourceTextSha256: requestSource.sha256,
        },
    }).then((outcome) => {
        if (currentRequestId !== requestId) return;
        finishRun();
        scheduleAvailabilityRefresh();
        folioLog.info('ai-actions', 'KI-Aktion abgeschlossen', {
            kind: outcome?.kind || '',
            runId: outcome?.runId ?? -1,
        });
        if (outcome?.kind === 'text' && typeof outcome.text === 'string') {
            void openAiDiffReview({
                runId: outcome.runId,
                sourceTabId: requestSource.tabId,
                sourcePath: requestSource.path,
                originalFull: requestSource.text,
                selection: scopePayload,
                resultText: outcome.text,
                actionName,
            });
        }
    }).catch((error) => {
        if (currentRequestId !== requestId) return;
        finishRun();
        folioLog.warn('ai-actions', 'KI-Aktion fehlgeschlagen', { error: String(error) });
        // Fehler-Reopen nur, wenn die Quelle noch da ist; sonst nur Status.
        if (getCurrentPath() === requestSource.path) {
            const dialogElement = $('ai-actions-dialog');
            if (dialogElement) dialogElement.hidden = false;
            state = 'ready';
            setError(String(error));
        }
    });
}

function finishRun(): void {
    state = 'closed';
    currentRequestId = null;
    currentRunId = null;
    abortRequested = false;
    hideStatus();
    setBusy(false);
}

function requestCancel(): void {
    const button = $('ai-action-status-cancel') as HTMLButtonElement | null;
    if (button) {
        button.disabled = true;
        button.textContent = 'Bricht ab…';
    }
    if (currentRunId !== null) {
        invoke<void>('ai_action_cancel', { runId: currentRunId }).catch((error) => {
            folioLog.warn('ai-actions', 'Abbruch fehlgeschlagen', { error: String(error) });
            if (button) {
                button.disabled = false;
                button.textContent = 'Abbrechen';
            }
        });
    } else {
        // Vor dem Started-Handshake: Abort merken; sobald die runId
        // eintrifft, wird der Cancel nachgeschickt.
        abortRequested = true;
    }
}

export function initAiActionsDialog(): void {
    if (!$('ai-actions-dialog')) return;
    // Init setzt den Modul-State vollständig zurück — in der App läuft
    // das genau einmal beim Boot; in vitest macht es die Tests unabhängig.
    state = 'closed';
    source = null;
    templates = [];
    selectedId = CUSTOM_ENTRY_ID;
    currentRequestId = null;
    currentRunId = null;
    abortRequested = false;
    documentIsMarkdown = document.body.classList.contains('kind-markdown');

    const toolbarButton = $('tb-ai-actions');
    toolbarButton?.addEventListener('click', () => void openAiActionsDialog());
    $('ai-actions-cancel')?.addEventListener('click', closeDialog);
    $('ai-actions-start')?.addEventListener('click', () => void startAction());
    $('ai-action-status-cancel')?.addEventListener('click', requestCancel);
    $('ai-actions-dialog')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || state === 'running') return;
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
    });
    document.addEventListener('folio-ai-invoke-complete', (event) => {
        scheduleAvailabilityRefresh((event as CustomEvent).detail);
    });

    const events = window.__TAURI__ && window.__TAURI__.event;
    if (events && typeof events.listen === 'function') {
        events.listen('menu:edit_ai_actions', () => void openAiActionsDialog());
        events.listen('document:loaded', () => {
            documentIsMarkdown = document.body.classList.contains('kind-markdown');
            syncMenuEnabled();
        });
        events.listen('document:closed', () => {
            documentIsMarkdown = document.body.classList.contains('kind-markdown');
            syncMenuEnabled();
        });
        events.listen('ai:action_started', (event: any) => {
            const data = event?.payload || {};
            if (!currentRequestId || data.requestId !== currentRequestId) return;
            currentRunId = Number(data.runId);
            if (abortRequested) {
                abortRequested = false;
                invoke<void>('ai_action_cancel', { runId: currentRunId }).catch(() => {});
            }
        });
        events.listen('ai:action_stream', (event: any) => {
            const data = event?.payload || {};
            if (currentRunId === null || data.runId !== currentRunId) return;
            const chars = Number(data.chars) || 0;
            updateStatusText(
                `✨ ${currentActionName} · ${chars.toLocaleString('de-DE')} Zeichen`,
            );
            if (typeof data.tabId === 'number'
                && data.tabId === getActiveTabId()
                && typeof data.text === 'string') {
                void renderPreviewText(data.text);
            }
        });
        events.listen('ai:action_done', (event: any) => {
            const data = event?.payload || {};
            if (currentRunId === null || data.runId !== currentRunId) return;
            if (data.ok) updateStatusText(`✓ ${currentActionName}`);
        });
    }
    void refreshAiActionsAvailability();
}
