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
import { showConfirmDialog } from './dialogs';
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

// Favoriten (Etappe A4a): geordnete Template-IDs + Hash-Pinning für
// Custom-Templates (Spec: geänderte Disk-Templates führen im
// Schnellzugriff zurück in den Dialog statt blind auszuführen).
let favorites: string[] = [];
let favoriteHashes: Record<string, string> = {};

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

/** Inhalts-Hash eines Templates für das Favoriten-Pinning. */
function templateContentHash(template: ActionTemplate): Promise<string> {
    return sha256Hex(JSON.stringify([
        template.prompt,
        template.masking,
        template.scope,
        template.target,
        template.suffix,
    ]));
}

async function loadFavoritesFromSettings(): Promise<void> {
    const settings = await safeInvoke<any>(
        'settings_get',
        undefined,
        'Settings für KI-Aktions-Favoriten laden',
        'debug',
    );
    favorites = Array.isArray(settings?.aiActionFavorites)
        ? settings.aiActionFavorites.slice()
        : [];
    favoriteHashes = settings?.aiActionFavoriteHashes
        && typeof settings.aiActionFavoriteHashes === 'object'
        ? { ...settings.aiActionFavoriteHashes }
        : {};
}

function patchFavorites(): Promise<unknown> {
    return invoke('settings_update', {
        patch: {
            aiActionFavorites: favorites,
            aiActionFavoriteHashes: favoriteHashes,
        },
    });
}

async function toggleFavorite(id: string): Promise<void> {
    const index = favorites.indexOf(id);
    if (index >= 0) {
        favorites.splice(index, 1);
        delete favoriteHashes[id];
    } else {
        favorites.push(id);
        const template = templateById(id);
        if (template && !template.builtin) {
            favoriteHashes[id] = await templateContentHash(template);
        }
    }
    try {
        await patchFavorites();
    } catch (error) {
        folioLog.warn('ai-actions', 'Favoriten konnten nicht gespeichert werden', {
            error: String(error),
        });
    }
    renderActionList();
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
    const caret = $('tb-ai-actions-menu') as HTMLButtonElement | null;
    if (caret) {
        caret.disabled = !enabled;
        if (!enabled) closeFavMenu();
    }
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

/** Favoriten (gespeicherte Reihenfolge) zuerst, dann Built-ins, dann
 *  eigene Templates, zuletzt der Custom-Eintrag; verschwundene
 *  Favoriten-IDs werden ausgeblendet. */
function orderedTemplates(): ActionTemplate[] {
    const favored = favorites
        .map((id) => templateById(id))
        .filter((template): template is ActionTemplate => !!template);
    const rest = templates.filter((template) => !favorites.includes(template.id));
    return [
        ...favored,
        ...rest.filter((template) => template.builtin),
        ...rest.filter((template) => !template.builtin),
    ];
}

function renderActionList(): void {
    const list = $('ai-actions-list');
    if (!list) return;
    list.textContent = '';
    const entries: Array<ActionTemplate | null> = [...orderedTemplates(), null];
    for (const template of entries) {
        const id = template?.id ?? CUSTOM_ENTRY_ID;
        const item = document.createElement('li');
        item.className = 'ai-actions-dialog__item';
        item.setAttribute('role', 'option');
        item.dataset.actionId = id;
        item.setAttribute('aria-selected', String(id === selectedId));

        const row = document.createElement('span');
        row.className = 'ai-actions-dialog__item-row';
        const name = document.createElement('span');
        name.className = 'ai-actions-dialog__item-name';
        name.textContent = template?.name ?? 'Eigener Prompt';
        row.appendChild(name);
        if (template) {
            const fav = document.createElement('button');
            fav.type = 'button';
            fav.className = 'ai-actions-dialog__fav';
            fav.dataset.aiActionFav = id;
            const active = favorites.includes(id);
            fav.setAttribute('aria-pressed', String(active));
            fav.setAttribute('aria-label', active
                ? 'Favorit entfernen'
                : 'Als Favorit markieren');
            fav.textContent = active ? '★' : '☆';
            fav.addEventListener('click', (event) => {
                event.stopPropagation();
                void toggleFavorite(id);
            });
            row.appendChild(fav);
            if (!template.builtin) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'ai-actions-dialog__delete';
                del.dataset.aiActionDelete = id;
                del.setAttribute('aria-label', 'Vorlage löschen');
                del.textContent = '✕';
                del.addEventListener('click', (event) => {
                    event.stopPropagation();
                    void deleteTemplate(id);
                });
                row.appendChild(del);
            }
        }
        item.appendChild(row);

        const descriptionText = template?.description
            ?? 'Freie Anweisung ohne Vorlage.';
        if (descriptionText) {
            const description = document.createElement('span');
            description.className = 'ai-actions-dialog__item-desc';
            description.textContent = descriptionText;
            item.appendChild(description);
        }
        if (template && !template.builtin) {
            const badge = document.createElement('span');
            badge.className = 'ai-actions-dialog__item-badge';
            badge.textContent = 'Eigene Vorlage';
            item.appendChild(badge);
        }
        item.addEventListener('click', () => applySelection(id));
        list.appendChild(item);
    }
}

async function deleteTemplate(id: string): Promise<void> {
    const template = templateById(id);
    if (!template || template.builtin) return;
    const ok = await showConfirmDialog(
        `Die Vorlage „${template.name}" löschen?`,
        { title: 'KI-Aktionen', okLabel: 'Löschen' },
    );
    if (!ok) return;
    try {
        await invoke('ai_action_template_delete', { id });
    } catch (error) {
        setError(String(error));
        return;
    }
    templates = templates.filter((entry) => entry.id !== id);
    if (favorites.includes(id)) {
        favorites = favorites.filter((entry) => entry !== id);
        delete favoriteHashes[id];
        patchFavorites().catch(() => {});
    }
    if (selectedId === id) applySelection(CUSTOM_ENTRY_ID);
    renderActionList();
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
    syncSaveTemplateVisibility();
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
            loadFavoritesFromSettings(),
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
    dispatchRun({
        template,
        prompt,
        providerId,
        modelId,
        target,
        masking: effectiveMasking(),
        suffix: effectiveSuffix(),
        scope: currentScopePayload(),
        requestSource: source,
        reopenOnError: true,
    });
}

type RunParams = {
    template: ActionTemplate | null;
    prompt: string;
    providerId: string;
    modelId: string;
    target: 'new-file' | 'replace';
    masking: boolean;
    suffix: string;
    scope: { start: number; length: number } | null;
    requestSource: SourceContext;
    reopenOnError: boolean;
};

/** Gemeinsamer Run-Kern für Dialog-Start und Favoriten-Direktausführung. */
function dispatchRun(params: RunParams): void {
    const { template, requestSource, scope } = params;
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentRequestId = requestId;
    currentRunId = null;
    abortRequested = false;
    currentActionName = template?.name || 'Eigener Prompt';
    state = 'running';
    const dialog = $('ai-actions-dialog');
    if (dialog) dialog.hidden = true;
    showStatus(currentActionName);

    const actionName = currentActionName;
    invoke<{ kind: string; runId: number; path?: string; text?: string }>('ai_action_run', {
        request: {
            actionId: template?.id ?? null,
            requestId,
            prompt: params.prompt,
            providerId: params.providerId,
            modelId: params.modelId,
            target: params.target,
            masking: params.masking,
            suffix: params.suffix,
            scope,
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
                selection: scope,
                resultText: outcome.text,
                actionName,
            });
        }
    }).catch((error) => {
        if (currentRequestId !== requestId) return;
        finishRun();
        folioLog.warn('ai-actions', 'KI-Aktion fehlgeschlagen', { error: String(error) });
        // Fehler-Reopen nur, wenn die Quelle noch da ist; sonst nur Status.
        if (params.reopenOnError && getCurrentPath() === requestSource.path) {
            const dialogElement = $('ai-actions-dialog');
            if (dialogElement) dialogElement.hidden = false;
            state = 'ready';
            setError(String(error));
        } else {
            updateStatusText(`✕ ${actionName}: ${String(error)}`);
        }
    });
}

/** Quellkontext frisch einfrieren (für die Direktausführung). */
async function freezeSource(): Promise<SourceContext | null> {
    const tabId = getActiveTabId();
    const path = getCurrentPath();
    if (tabId === null || !path) return null;
    const text = getEditorText();
    let selection: { start: number; length: number } | null = null;
    if (window.FolioEditor && typeof window.FolioEditor.getSelection === 'function') {
        const raw = window.FolioEditor.getSelection();
        if (raw && raw.length > 0) selection = { start: raw.start, length: raw.length };
    }
    return { tabId, path, text, sha256: await sha256Hex(text), selection };
}

/**
 * Favoriten-Direktausführung (Split-Button): Template-Defaults +
 * Default-Modell, ohne Dialog. Fällt in den Dialog zurück, wenn kein
 * Default-Modell existiert oder ein Custom-Template seit dem
 * Favorisieren verändert wurde (Hash-Pinning).
 */
export async function runFavoriteAction(id: string): Promise<void> {
    if (state === 'running') return;
    closeFavMenu();
    const config = configCache;
    const defaultModel = config?.defaultModel;
    let template = templateById(id);
    if (!template) {
        // Liste ggf. veraltet (Popover ohne vorherigen Dialog-Open).
        try {
            templates = await invoke<ActionTemplate[]>('ai_actions_list');
        } catch {
            templates = [];
        }
        template = templateById(id);
    }
    if (!template) return;
    if (!defaultModel?.provider || !defaultModel?.model) {
        await openAiActionsDialog();
        return;
    }
    if (!template.builtin) {
        const pinned = favoriteHashes[id];
        const current = await templateContentHash(template);
        if (pinned && pinned !== current) {
            folioLog.info('ai-actions', 'Favoriten-Hash weicht ab — öffne Dialog', { id });
            await openAiActionsDialog();
            return;
        }
    }
    if (template.target === 'replace' && isAiReviewOpen()) {
        updateStatusText('Erst die offene KI-Review abschließen.');
        const status = $('ai-action-status');
        if (status) status.hidden = false;
        return;
    }
    const requestSource = await freezeSource();
    if (!requestSource) return;
    try {
        await syncEditorTextToStoreForTab(requestSource.tabId, requestSource.text);
    } catch (error) {
        folioLog.warn('ai-actions', 'Sync für Direktausführung fehlgeschlagen', {
            error: String(error),
        });
        return;
    }
    const useSelection = !!requestSource.selection && template.scope !== 'document';
    dispatchRun({
        template,
        prompt: template.prompt,
        providerId: defaultModel.provider,
        modelId: defaultModel.model,
        target: template.target,
        masking: template.masking,
        suffix: template.suffix,
        scope: useSelection ? requestSource.selection : null,
        requestSource,
        reopenOnError: false,
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

function favMenuOpen(): boolean {
    const menu = $('ai-actions-fav-menu');
    return !!menu && !menu.hidden;
}

function closeFavMenu(): void {
    const menu = $('ai-actions-fav-menu');
    if (menu) menu.hidden = true;
    const caret = $('tb-ai-actions-menu');
    if (caret) caret.setAttribute('aria-expanded', 'false');
}

async function toggleFavMenu(): Promise<void> {
    const menu = $('ai-actions-fav-menu');
    const caret = $('tb-ai-actions-menu');
    if (!menu || !caret) return;
    if (!menu.hidden) {
        closeFavMenu();
        return;
    }
    // Aktuelle Templates + Favoriten laden (Popover kann vor jedem
    // Dialog-Open benutzt werden).
    try {
        const [templateList] = await Promise.all([
            invoke<ActionTemplate[]>('ai_actions_list'),
            loadFavoritesFromSettings(),
        ]);
        templates = templateList;
    } catch (error) {
        folioLog.warn('ai-actions', 'Favoriten-Menü konnte nicht geladen werden', {
            error: String(error),
        });
    }
    menu.textContent = '';
    const entries = favorites
        .map((id) => templateById(id))
        .filter((template): template is ActionTemplate => !!template);
    if (entries.length === 0) {
        const hint = document.createElement('span');
        hint.className = 'ai-actions-fav-menu__hint';
        hint.textContent = 'Favoriten im ✨-Dialog markieren.';
        menu.appendChild(hint);
    }
    for (const template of entries) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ai-actions-fav-menu__item';
        item.setAttribute('role', 'menuitem');
        item.dataset.aiFavRun = template.id;
        item.textContent = `${template.name}`;
        item.title = template.description;
        item.addEventListener('click', () => void runFavoriteAction(template.id));
        menu.appendChild(item);
    }
    const rect = caret.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.left = `${Math.round(Math.max(8, rect.right - 240))}px`;
    menu.hidden = false;
    caret.setAttribute('aria-expanded', 'true');
}

/** „Als Vorlage speichern" ist bei Eigener-Prompt-Auswahl oder
 *  editiertem Template-Prompt sichtbar. */
function syncSaveTemplateVisibility(): void {
    const button = $('ai-actions-save-template') as HTMLButtonElement | null;
    if (!button) return;
    const prompt = ($('ai-actions-prompt') as HTMLTextAreaElement | null)?.value ?? '';
    const template = selectedTemplate();
    const edited = template ? prompt.trim() !== template.prompt.trim() : prompt.trim().length > 0;
    button.hidden = !edited && selectedId !== CUSTOM_ENTRY_ID;
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
}

function openSaveTemplateOverlay(): void {
    const overlay = $('ai-actions-save-overlay');
    if (!overlay) return;
    const nameInput = $('ai-actions-save-name') as HTMLInputElement | null;
    const idInput = $('ai-actions-save-id') as HTMLInputElement | null;
    const error = $('ai-actions-save-error');
    if (error) error.hidden = true;
    if (nameInput) nameInput.value = '';
    if (idInput) idInput.value = '';
    overlay.hidden = false;
    nameInput?.focus();
}

function closeSaveTemplateOverlay(): void {
    const overlay = $('ai-actions-save-overlay');
    if (overlay) overlay.hidden = true;
}

async function submitSaveTemplate(): Promise<void> {
    const nameInput = $('ai-actions-save-name') as HTMLInputElement | null;
    const idInput = $('ai-actions-save-id') as HTMLInputElement | null;
    const error = $('ai-actions-save-error');
    const showError = (message: string) => {
        if (error) {
            error.textContent = message;
            error.hidden = false;
        }
    };
    const name = (nameInput?.value || '').trim();
    const id = (idInput?.value || '').trim() || slugify(name);
    if (!name) {
        showError('Bitte einen Namen angeben.');
        return;
    }
    const prompt = ($('ai-actions-prompt') as HTMLTextAreaElement | null)?.value.trim() || '';
    if (!prompt) {
        showError('Der Prompt darf nicht leer sein.');
        return;
    }
    const replaceRadio = $('ai-actions-target-replace') as HTMLInputElement | null;
    const template: ActionTemplate = {
        id,
        name,
        description: '',
        prompt,
        masking: effectiveMasking(),
        scope: 'auto',
        target: replaceRadio?.checked ? 'replace' : 'new-file',
        suffix: id,
        builtin: false,
    };
    try {
        const saved = await invoke<ActionTemplate>('ai_action_template_save', { template });
        templates = templates.filter((entry) => entry.id !== saved.id);
        templates.push(saved);
        closeSaveTemplateOverlay();
        renderActionList();
        applySelection(saved.id);
        syncSaveTemplateVisibility();
    } catch (saveError) {
        showError(String(saveError));
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
    favorites = [];
    favoriteHashes = {};
    documentIsMarkdown = document.body.classList.contains('kind-markdown');

    const toolbarButton = $('tb-ai-actions');
    toolbarButton?.addEventListener('click', () => void openAiActionsDialog());
    $('tb-ai-actions-menu')?.addEventListener('click', (event) => {
        event.stopPropagation();
        void toggleFavMenu();
    });
    document.addEventListener('click', (event) => {
        if (!favMenuOpen()) return;
        const menu = $('ai-actions-fav-menu');
        if (menu && !menu.contains(event.target as Node)) closeFavMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && favMenuOpen()) {
            event.preventDefault();
            closeFavMenu();
        }
    });
    $('ai-actions-prompt')?.addEventListener('input', syncSaveTemplateVisibility);
    $('ai-actions-save-template')?.addEventListener('click', openSaveTemplateOverlay);
    $('ai-actions-save-cancel')?.addEventListener('click', closeSaveTemplateOverlay);
    $('ai-actions-save-name')?.addEventListener('input', () => {
        const idInput = $('ai-actions-save-id') as HTMLInputElement | null;
        const nameInput = $('ai-actions-save-name') as HTMLInputElement | null;
        if (idInput && nameInput && !idInput.dataset.touched) {
            idInput.value = slugify(nameInput.value);
        }
    });
    $('ai-actions-save-id')?.addEventListener('input', () => {
        const idInput = $('ai-actions-save-id') as HTMLInputElement | null;
        if (idInput) idInput.dataset.touched = '1';
    });
    $('ai-actions-save-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        void submitSaveTemplate();
    });
    $('ai-actions-save-overlay')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeSaveTemplateOverlay();
    });
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
