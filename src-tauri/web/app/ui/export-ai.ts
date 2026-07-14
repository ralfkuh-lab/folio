import { populateModelPicker, AiConfig, CatalogResult } from './ai-model-picker';
import { folioLog } from '../util/log';
import { t, tPlural } from '../i18n/translate';
import { fmtNumber } from '../i18n/format';
import type { MermaidSvgEntry } from '../view/mermaid';

export const EXPORT_AI_DRAFT_ID = '__folio_export_ai_draft';

type ExportFormat = 'html' | 'pdf';

type ExportLayout = {
    id: string;
    name: string;
    description?: string;
};

type ThemeManifest = {
    name: string;
    description: string;
    code: string;
    logo?: string | null;
    cover: boolean;
    header: boolean;
    footer: boolean;
    hideInlineFrontmatter: boolean;
    fontBody?: string | null;
    fontMono?: string | null;
    fontSize?: string | null;
    formatVersion: number;
};

type ThemeDraft = {
    manifest?: Partial<ThemeManifest> | null;
    contentCss: string;
    darkCss?: string | null;
    pageCss?: string | null;
    coverHtml?: string | null;
    headerHtml?: string | null;
    footerHtml?: string | null;
};

type ThemeWriteFiles = {
    manifest: ThemeManifest;
    contentCss: string;
    darkCss?: string | null;
    pageCss?: string | null;
    coverHtml?: string | null;
    headerHtml?: string | null;
    footerHtml?: string | null;
};

type Deps = {
    invoke: <T = unknown>(cmd: string, args?: any) => Promise<T>;
    showStatus: (message: string) => void;
    selectDraftCard: () => void;
    isDraftSelected: () => boolean;
};

let deps: Deps | null = null;
let busy = false;
let draftFiles: ThemeWriteFiles | null = null;
let draftBaseThemeId: string | null = null;
let currentMermaidSvgs: MermaidSvgEntry[] | null = null;

export function setExportMermaidSvgs(svgs: MermaidSvgEntry[] | null): void {
    currentMermaidSvgs = svgs;
}

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function setError(message: string | null): void {
    const error = $('export-ai-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function setStatus(message: string): void {
    const status = $('export-ai-status');
    if (status) status.textContent = message;
}

function setBusy(next: boolean): void {
    busy = next;
    const root = $('export-ai-section');
    if (root) {
        for (const element of Array.from(
            root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
                'input, select, textarea, button',
            ),
        )) {
            if (element.id === 'export-ai-cancel') {
                element.disabled = !next;
            } else {
                element.disabled = next;
            }
        }
    }
    const start = $('export-ai-start') as HTMLButtonElement | null;
    if (start) start.textContent = next ? t('export.aiDraft.generating') : t('export.aiDraft.start.action');
    const cancel = $('export-ai-cancel') as HTMLButtonElement | null;
    if (cancel) cancel.textContent = t('dialogs.common.cancel');
}

function defaultManifest(): ThemeManifest {
    return {
        name: t('export.aiDraft.defaultName'),
        description: t('export.aiDraft.transientLabel'),
        code: 'light',
        logo: null,
        cover: false,
        header: false,
        footer: false,
        hideInlineFrontmatter: false,
        fontBody: null,
        fontMono: null,
        fontSize: null,
        formatVersion: 1,
    };
}

function draftToFiles(draft: ThemeDraft): ThemeWriteFiles {
    const manifest = Object.assign(defaultManifest(), draft.manifest || {});
    return {
        manifest,
        contentCss: draft.contentCss || '',
        darkCss: draft.darkCss || null,
        pageCss: draft.pageCss || null,
        coverHtml: draft.coverHtml || null,
        headerHtml: draft.headerHtml || null,
        footerHtml: draft.footerHtml || null,
    };
}

function slugify(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'ki-export-theme';
}

function populateBaseThemes(layouts: ExportLayout[]): void {
    const select = $('export-ai-base') as HTMLSelectElement | null;
    if (!select) return;
    select.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('export.aiDraft.base.none');
    select.appendChild(none);
    layouts.forEach((layout) => {
        const option = document.createElement('option');
        option.value = layout.id;
        option.textContent = layout.name;
        select.appendChild(option);
    });
}

async function loadModelPicker(): Promise<void> {
    if (!deps) return;
    const select = $('export-ai-model') as HTMLSelectElement | null;
    if (!select) return;
    try {
        const [config, catalog] = await Promise.all([
            deps.invoke<AiConfig>('ai_config_get'),
            deps.invoke<CatalogResult>('ai_catalog_get'),
        ]);
        populateModelPicker(select, config, catalog, { separator: ' · ' });
        if (!select.value) setError(t('errors.ai.noEnabledModel'));
    } catch (error) {
        folioLog.warn('export-ai', 'Model-Picker konnte nicht geladen werden', {
            error: String(error),
        });
        setError(String(error));
    }
}

function renderDraftCard(): void {
    const cards = $('export-cards');
    if (!cards || !draftFiles) return;
    document.getElementById('export-ai-draft-card')?.remove();
    const card = document.createElement('div');
    card.id = 'export-ai-draft-card';
    card.className = 'export-card export-ai-card';
    card.dataset.layoutId = EXPORT_AI_DRAFT_ID;
    card.tabIndex = 0;
    card.innerHTML =
        '<div class="export-card__name"></div>' +
        '<div class="export-card__desc"></div>' +
        '<div class="export-card__preview"><iframe sandbox></iframe></div>';
    const nameEl = card.querySelector('.export-card__name');
    if (nameEl) nameEl.textContent = t('export.aiDraft.card.name');
    const desc = card.querySelector('.export-card__desc');
    if (desc) desc.textContent = draftFiles.manifest.name || t('export.aiDraft.card.defaultDesc');
    card.addEventListener('click', () => deps?.selectDraftCard());
    card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        deps?.selectDraftCard();
    });
    cards.insertBefore(card, cards.firstChild);
}

async function renderDraftPreview(): Promise<void> {
    if (!deps || !draftFiles) return;
    const iframe = document.querySelector<HTMLIFrameElement>('#export-ai-draft-card iframe');
    if (!iframe) return;
    try {
        const payload: any = {
            parts: draftFiles,
            baseThemeId: draftBaseThemeId,
        };
        if (currentMermaidSvgs) payload.mermaidSvgs = currentMermaidSvgs;
        const html = await deps.invoke<string>('export_render_draft', payload);
        iframe.srcdoc = html;
    } catch (error) {
        folioLog.warn('export-ai', 'Draft-Preview fehlgeschlagen', {
            error: String(error),
        });
        setError(String(error));
    }
}

function setDraft(draft: ThemeDraft, baseThemeId: string | null): void {
    draftFiles = draftToFiles(draft);
    draftBaseThemeId = baseThemeId;
    renderDraftCard();
    void renderDraftPreview();
    const actions = $('export-ai-draft-actions');
    if (actions) actions.hidden = false;
    deps?.selectDraftCard();
    setStatus(t('export.aiDraft.status.readyResult'));
}

async function startGeneration(): Promise<void> {
    if (!deps || busy) return;
    const prompt = ($('export-ai-prompt') as HTMLTextAreaElement | null)?.value || '';
    if (!prompt.trim()) {
        setError(t('errors.ai.emptyPrompt'));
        return;
    }
    const modelValue = ($('export-ai-model') as HTMLSelectElement | null)?.value || '';
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
    const baseThemeId = (($('export-ai-base') as HTMLSelectElement | null)?.value || '').trim() || null;

    setError(null);
    setStatus(t('export.aiDraft.status.charCount', { charsPart: tPlural('ai.status.charsPart', 0, { formattedCount: fmtNumber(0) }) }));
    setBusy(true);
    try {
        const draft = await deps.invoke<ThemeDraft>('ai_theme_author', {
            prompt,
            baseId: baseThemeId,
            withDocument: true,
            providerId,
            modelId,
        });
        setBusy(false);
        setDraft(draft, baseThemeId);
    } catch (error) {
        folioLog.warn('export-ai', 'KI-Export-Draft fehlgeschlagen', {
            error: String(error),
        });
        setBusy(false);
        setError(String(error));
        setStatus(t('errors.export.aiGenerateFailed'));
    }
}

function cancelGeneration(): void {
    if (!deps || !busy) return;
    const cancel = $('export-ai-cancel') as HTMLButtonElement | null;
    if (cancel) {
        cancel.disabled = true;
        cancel.textContent = t('export.aiDraft.status.cancelling');
    }
    deps.invoke<void>('ai_theme_author_cancel').catch((error) => {
        folioLog.warn('export-ai', 'Abbruch fehlgeschlagen', {
            error: String(error),
        });
    });
}

function openSaveDialog(): void {
    if (!draftFiles) return;
    const dialog = $('export-ai-save-dialog');
    const idInput = $('export-ai-save-id') as HTMLInputElement | null;
    const nameInput = $('export-ai-save-name') as HTMLInputElement | null;
    if (!dialog || !idInput || !nameInput) return;
    nameInput.value = draftFiles.manifest.name || t('export.aiDraft.defaultName');
    idInput.value = slugify(nameInput.value);
    setSaveError(null);
    dialog.hidden = false;
    idInput.focus();
}

function closeSaveDialog(): void {
    const dialog = $('export-ai-save-dialog');
    if (dialog) dialog.hidden = true;
    setSaveError(null);
}

function setSaveError(message: string | null): void {
    const error = $('export-ai-save-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

async function saveDraftTheme(event: Event): Promise<void> {
    event.preventDefault();
    if (!deps || !draftFiles) return;
    const id = (($('export-ai-save-id') as HTMLInputElement | null)?.value || '').trim();
    const name = (($('export-ai-save-name') as HTMLInputElement | null)?.value || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
        setSaveError(t('export.aiDraft.saveDialog.idInvalid'));
        return;
    }
    if (!name) {
        setSaveError(t('export.aiDraft.saveDialog.displayNameEmpty'));
        return;
    }
    const files = {
        ...draftFiles,
        manifest: {
            ...draftFiles.manifest,
            name,
        },
    };
    try {
        await deps.invoke('theme_create', { id, files });
        closeSaveDialog();
        deps.showStatus(t('export.aiDraft.themeSaved.status', { name }));
    } catch (error) {
        folioLog.warn('export-ai', 'KI-Entwurf konnte nicht als Theme gespeichert werden', {
            themeId: id,
            error: String(error),
        });
        setSaveError(String(error));
    }
}

export function prepareExportAiOpen(layouts: ExportLayout[]): void {
    populateBaseThemes(layouts);
    setError(null);
    setStatus(t('export.aiDraft.status.ready'));
    setBusy(false);
    const actions = $('export-ai-draft-actions');
    if (actions) actions.hidden = draftFiles === null;
    void loadModelPicker();
}

export function clearExportAiDraft(): void {
    if (busy && deps) {
        deps.invoke<void>('ai_theme_author_cancel').catch((error) => {
            folioLog.warn('export-ai', 'Abbruch beim Schliessen fehlgeschlagen', {
                error: String(error),
            });
        });
    }
    busy = false;
    draftFiles = null;
    draftBaseThemeId = null;
    currentMermaidSvgs = null;
    document.getElementById('export-ai-draft-card')?.remove();
    const actions = $('export-ai-draft-actions');
    if (actions) actions.hidden = true;
    closeSaveDialog();
    setBusy(false);
    setError(null);
}

export async function exportAiDraftSave(format: ExportFormat, targetPath: string): Promise<boolean> {
    if (!deps || !draftFiles || !deps.isDraftSelected()) return false;
    const cmd = format === 'pdf' ? 'export_pdf_draft' : 'export_html_draft';
    const payload: any = {
        parts: draftFiles,
        baseThemeId: draftBaseThemeId,
        targetPath,
    };
    if (currentMermaidSvgs) payload.mermaidSvgs = currentMermaidSvgs;
    await deps.invoke(cmd, payload);
    return true;
}

export function initExportAi(nextDeps: Deps): void {
    deps = nextDeps;
    $('export-ai-start')?.addEventListener('click', () => {
        void startGeneration();
    });
    $('export-ai-regenerate')?.addEventListener('click', () => {
        void startGeneration();
    });
    $('export-ai-cancel')?.addEventListener('click', cancelGeneration);
    $('export-ai-save-theme')?.addEventListener('click', openSaveDialog);
    $('export-ai-save-cancel')?.addEventListener('click', closeSaveDialog);
    $('export-ai-save-form')?.addEventListener('submit', (event) => {
        void saveDraftTheme(event);
    });
    $('export-ai-save-dialog')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        closeSaveDialog();
    });

    const events = window.__TAURI__ && window.__TAURI__.event;
    if (events && typeof events.listen === 'function') {
        events.listen('ai:theme_stream', (event: any) => {
            if (!busy) return;
            const chars = Number(event?.payload?.chars) || 0;
            setStatus(t('export.aiDraft.status.charCount', { charsPart: tPlural('ai.status.charsPart', chars, { formattedCount: fmtNumber(chars) }) }));
        });
        events.listen('ai:theme_done', (event: any) => {
            if (!busy) return;
            const payload = event?.payload || {};
            if (!payload.ok && payload.error) setError(String(payload.error));
        });
    }
}
