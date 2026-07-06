import {
    activateVirtualTab,
    isVirtualTabActive,
    refreshVirtualTabs,
    registerVirtualTab,
    unregisterVirtualTab,
} from '../state/tabs';
import { getCleanText, getCurrentPath } from '../state/document';
import { showUnsavedDialog } from './dialogs';
import { folioLog } from '../util/log';
import { openThemeAiDialog } from './theme-ai-dialog';

type ThemeManifest = {
    name: string;
    description: string;
    code: string;
    logo?: string | null;
    cover: boolean;
    header: boolean;
    footer: boolean;
    hideInlineFrontmatter: boolean;
    formatVersion: number;
};

type ThemeFiles = {
    manifest: ThemeManifest;
    contentCss: string;
    darkCss?: string | null;
    pageCss?: string | null;
    coverHtml?: string | null;
    headerHtml?: string | null;
    footerHtml?: string | null;
    assets: AssetInfo[];
    source: string;
};

type AssetInfo = {
    filename: string;
    size: number;
    mime: string;
};

const PART_LABELS: Record<FolioThemePart, string> = {
    content: 'content.css',
    dark: 'content.dark.css',
    page: 'page.css',
    cover: 'cover.html',
    header: 'header.html',
    footer: 'footer.html',
};
const DEBOUNCE_MS = 150;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

let currentId: string | null = null;
let currentFiles: ThemeFiles | null = null;
let manifestDirty = false;
let pendingTimer: number | null = null;
let renderGen = 0;
let closePromise: Promise<boolean> | null = null;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') {
        return Promise.reject(new Error('Tauri core invoke not available'));
    }
    return core.invoke<T>(command, args);
}

function editor(): FolioThemeEditorSurface | null {
    return window.FolioThemeEditor || null;
}

function filesToParts(files: ThemeFiles): FolioThemeParts {
    const parts: FolioThemeParts = { content: files.contentCss || '' };
    if (files.darkCss != null) parts.dark = files.darkCss;
    if (files.pageCss != null) parts.page = files.pageCss;
    if (files.manifest.cover || files.coverHtml != null) {
        parts.cover = files.coverHtml || '';
    }
    if (files.manifest.header || files.headerHtml != null) {
        parts.header = files.headerHtml || '';
    }
    if (files.manifest.footer || files.footerHtml != null) {
        parts.footer = files.footerHtml || '';
    }
    return parts;
}

function hasPart(parts: FolioThemeParts, part: FolioThemePart): boolean {
    return Object.prototype.hasOwnProperty.call(parts, part);
}

function partsToWriteFiles(parts: FolioThemeParts): ThemeFiles | null {
    if (!currentFiles) return null;
    return {
        ...currentFiles,
        contentCss: parts.content || '',
        darkCss: hasPart(parts, 'dark') ? parts.dark || '' : null,
        pageCss: hasPart(parts, 'page') ? parts.page || '' : null,
        coverHtml: hasPart(parts, 'cover') ? parts.cover || '' : null,
        headerHtml: hasPart(parts, 'header') ? parts.header || '' : null,
        footerHtml: hasPart(parts, 'footer') ? parts.footer || '' : null,
    };
}

function renderPartSwitcher(parts: FolioThemeParts): void {
    const select = $('theme-editor-part') as HTMLSelectElement | null;
    if (!select) return;
    const previous = select.value as FolioThemePart | '';
    select.textContent = '';
    for (const part of Object.keys(PART_LABELS) as FolioThemePart[]) {
        if (!hasPart(parts, part)) continue;
        const option = document.createElement('option');
        option.value = part;
        option.textContent = PART_LABELS[part];
        select.appendChild(option);
    }
    // Previous Part bleiben aktiv, solange er noch existiert.
    if (previous && hasPart(parts, previous as FolioThemePart)) {
        select.value = previous;
    } else {
        select.value = 'content';
    }
}

function refreshPartsFromManifest(): void {
    const surface = editor();
    if (!surface || !currentFiles) return;
    const current = surface.getAllParts();
    const manifest = currentFiles.manifest;
    const desired: FolioThemeParts = { ...current };
    // Cover/Header/Footer nur aktivieren, wenn der Flag gerade angeschaltet
    // wurde; nie destruktiv entfernen (User könnte den Buffer behalten
    // wollen). Undo-Stacks fuer bestehende Parts bleiben erhalten, weil
    // setParts bei identischen Werten frueh zurueckkehrt.
    if (manifest.cover && !hasPart(desired, 'cover')) {
        desired.cover = currentFiles.coverHtml || '';
    }
    if (manifest.header && !hasPart(desired, 'header')) {
        desired.header = currentFiles.headerHtml || '';
    }
    if (manifest.footer && !hasPart(desired, 'footer')) {
        desired.footer = currentFiles.footerHtml || '';
    }
    const grew = Object.keys(desired).length !== Object.keys(current).length;
    if (grew) surface.setParts(desired);
    renderPartSwitcher(desired);
    schedulePreview();
}

function syncManifestFlags(manifest: ThemeManifest): void {
    const cover = $('theme-editor-flag-cover') as HTMLInputElement | null;
    const header = $('theme-editor-flag-header') as HTMLInputElement | null;
    const footer = $('theme-editor-flag-footer') as HTMLInputElement | null;
    const hideFm = $('theme-editor-flag-hide-fm') as HTMLInputElement | null;
    if (cover) cover.checked = !!manifest.cover;
    if (header) header.checked = !!manifest.header;
    if (footer) footer.checked = !!manifest.footer;
    if (hideFm) hideFm.checked = !!manifest.hideInlineFrontmatter;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function renderAssetList(): void {
    const list = $('theme-editor-asset-list');
    const logoName = $('theme-editor-logo-name');
    if (!list || !currentFiles) return;
    const assets = currentFiles.assets || [];
    const logo = currentFiles.manifest.logo || null;
    list.textContent = '';
    for (const asset of assets) {
        const li = document.createElement('li');
        if (asset.filename === logo) li.classList.add('is-logo');
        const label = document.createElement('span');
        label.textContent = asset.filename + ' · ' + formatSize(asset.size);
        li.appendChild(label);
        const actions = document.createElement('span');
        const useAsLogo = document.createElement('button');
        useAsLogo.type = 'button';
        useAsLogo.className = 'link-button';
        useAsLogo.textContent = 'als Logo';
        useAsLogo.addEventListener('click', () => setLogo(asset.filename));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'theme-editor-assets__remove';
        remove.textContent = '×';
        remove.title = 'Asset entfernen';
        remove.addEventListener('click', () => removeAsset(asset.filename));
        actions.appendChild(useAsLogo);
        actions.appendChild(remove);
        li.appendChild(actions);
        list.appendChild(li);
    }
    if (logoName) logoName.textContent = logo || '(kein)';
}

function setAssetError(message: string | null): void {
    const error = $('theme-editor-asset-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (typeof result !== 'string') {
                reject(new Error('FileReader liefert keinen Data-URI'));
                return;
            }
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : '');
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

async function uploadAsset(file: File): Promise<void> {
    if (!currentId || !currentFiles) return;
    setAssetError(null);
    if (file.size > MAX_ASSET_BYTES) {
        setAssetError('Das Asset darf höchstens 5 MB groß sein.');
        return;
    }
    const filename = file.name;
    if (!filename) return;
    let base64: string;
    try {
        base64 = await fileToBase64(file);
    } catch (error) {
        folioLog.warn('theme-editor', 'logo base64 failed', { error: String(error) });
        setAssetError(String(error));
        return;
    }
    let info: AssetInfo;
    try {
        info = await invoke<AssetInfo>('theme_asset_add', {
            id: currentId,
            filename,
            bytesBase64: base64,
        });
    } catch (error) {
        folioLog.warn('theme-editor', 'theme_asset_add failed', {
            id: currentId,
            filename,
            error: String(error),
        });
        setAssetError(String(error));
        return;
    }
    const existing = (currentFiles.assets || []).filter(
        (a) => a.filename !== info.filename,
    );
    existing.push(info);
    currentFiles.assets = existing;
    // Erstes Asset ohne Logo wird automatisch zum Logo.
    if (!currentFiles.manifest.logo) {
        currentFiles.manifest.logo = info.filename;
    }
    manifestDirty = true;
    renderAssetList();
    syncDirtyUi();
    await renderPreviewNow();
}

async function removeAsset(filename: string): Promise<void> {
    if (!currentId || !currentFiles) return;
    try {
        await invoke('theme_asset_remove', { id: currentId, filename });
    } catch (error) {
        folioLog.warn('theme-editor', 'theme_asset_remove failed', {
            id: currentId,
            filename,
            error: String(error),
        });
        return;
    }
    currentFiles.assets = (currentFiles.assets || []).filter(
        (a) => a.filename !== filename,
    );
    if (currentFiles.manifest.logo === filename) {
        currentFiles.manifest.logo = null;
    }
    manifestDirty = true;
    renderAssetList();
    syncDirtyUi();
    await renderPreviewNow();
}

function setLogo(filename: string): void {
    if (!currentFiles) return;
    if (currentFiles.manifest.logo === filename) return;
    currentFiles.manifest.logo = filename;
    manifestDirty = true;
    renderAssetList();
    syncDirtyUi();
    schedulePreview();
}

function clearLogo(): void {
    if (!currentFiles) return;
    if (!currentFiles.manifest.logo) return;
    currentFiles.manifest.logo = null;
    manifestDirty = true;
    renderAssetList();
    syncDirtyUi();
    schedulePreview();
}

function isDirty(): boolean {
    return !!editor()?.isDirty() || manifestDirty;
}

function syncDirtyUi(): void {
    const dirty = isDirty();
    const save = $('theme-editor-save') as HTMLButtonElement | null;
    if (save) save.disabled = !dirty;
    refreshVirtualTabs();
}

function currentMarkdown(): string | undefined {
    if (!getCurrentPath()) return undefined;
    const documentEditor = window.FolioEditor;
    if (documentEditor
        && typeof documentEditor.hasEditor === 'function'
        && documentEditor.hasEditor()
        && typeof documentEditor.getText === 'function') {
        return documentEditor.getText();
    }
    return getCleanText();
}

function schedulePreview(): void {
    const generation = ++renderGen;
    if (pendingTimer != null) window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(function () {
        pendingTimer = null;
        runPreview(generation);
    }, DEBOUNCE_MS);
}

function renderPreviewNow(): Promise<void> {
    if (pendingTimer != null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    return runPreview(++renderGen);
}

async function runPreview(generation: number): Promise<void> {
    const surface = editor();
    const parts = surface?.getAllParts();
    const files = parts && partsToWriteFiles(parts);
    if (!currentId || !surface || !files) return;
    const dark = !!($('theme-editor-dark') as HTMLInputElement | null)?.checked;
    const markdown = currentMarkdown();
    let html: string;
    try {
        html = await invoke<string>('theme_preview_render', {
            markdown,
            parts: files,
            dark,
            themeId: currentId,
        });
    } catch (error) {
        folioLog.warn('theme-editor', 'theme_preview_render failed', {
            error: String(error),
        });
        return;
    }
    if (generation !== renderGen || !currentId) return;
    const dialog = $('theme-editor-dialog');
    const frame = $('theme-editor-preview') as HTMLIFrameElement | null;
    if (!dialog || dialog.hidden || !frame || !frame.isConnected) return;
    frame.srcdoc = html;
}

export async function openThemeEditor(id: string): Promise<boolean> {
    if (!id) return false;
    if (currentId === id) {
        activateVirtualTab('theme-editor');
        return true;
    }
    if (currentId && currentId !== id && !await guardedClose()) return false;
    const surface = editor();
    const dialog = $('theme-editor-dialog');
    if (!surface || !dialog) return false;

    let files: ThemeFiles;
    try {
        files = await invoke<ThemeFiles>('theme_read', { id });
    } catch (error) {
        folioLog.warn('theme-editor', 'theme_read failed', { id, error: String(error) });
        return false;
    }

    currentId = id;
    currentFiles = files;
    manifestDirty = false;
    setAssetError(null);
    dialog.hidden = false;
    await surface.mount('theme-editor-mount');
    const parts = filesToParts(files);
    surface.setParts(parts);
    surface.showPart('content');
    surface.onChange(function () {
        syncDirtyUi();
        schedulePreview();
    });
    renderPartSwitcher(parts);
    syncManifestFlags(files.manifest);
    renderAssetList();
    syncDirtyUi();
    registerVirtualTab({
        slug: 'theme-editor',
        label: () => '\ud83c\udfa8 ' + (currentFiles?.manifest.name || currentId || 'Theme'),
        dirty: isDirty,
        onActivate: function () {
            const region = $('theme-editor-dialog');
            if (region) region.hidden = false;
            requestAnimationFrame(function () { editor()?.layout(); });
        },
        onClose: guardedClose,
    });
    await renderPreviewNow();
    return true;
}

export async function saveThemeEditor(): Promise<boolean> {
    const surface = editor();
    if (!currentId || !currentFiles || !surface) return false;
    const parts = surface.getAllParts();
    const files = partsToWriteFiles(parts);
    if (!files) return false;
    try {
        await invoke('theme_write', { id: currentId, files });
        currentFiles = files;
        manifestDirty = false;
        // Derselbe Part-Satz mit identischen Werten setzt in der Surface
        // nur die Clean-Baseline neu; Models und Undo-Stacks bleiben.
        surface.setParts(parts);
        syncDirtyUi();
        return true;
    } catch (error) {
        folioLog.warn('theme-editor', 'theme_write failed', {
            id: currentId,
            error: String(error),
        });
        return false;
    }
}

export function guardedClose(): Promise<boolean> {
    if (closePromise) return closePromise;
    closePromise = (async function () {
        if (isDirty()) {
            const decision = await showUnsavedDialog();
            if (decision === 'cancel') return false;
            if (decision === 'save' && !await saveThemeEditor()) return false;
        }
        finishClose();
        return true;
    })().finally(function () {
        closePromise = null;
    });
    return closePromise;
}

function finishClose(): void {
    renderGen++;
    if (pendingTimer != null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    const frame = $('theme-editor-preview') as HTMLIFrameElement | null;
    if (frame) frame.srcdoc = '';
    editor()?.dispose();
    const dialog = $('theme-editor-dialog');
    if (dialog) dialog.hidden = true;
    currentId = null;
    currentFiles = null;
    manifestDirty = false;
    setAssetError(null);
    unregisterVirtualTab('theme-editor');
}

export function initThemeEditor(): void {
    ($('theme-editor-part') as HTMLSelectElement | null)
        ?.addEventListener('change', function (event) {
            const part = (event.currentTarget as HTMLSelectElement).value as FolioThemePart;
            editor()?.showPart(part);
        });
    $('theme-editor-dark')?.addEventListener('change', function () {
        renderPreviewNow();
    });
    $('theme-editor-save')?.addEventListener('click', function () {
        saveThemeEditor();
    });
    $('theme-editor-ai')?.addEventListener('click', function () {
        openThemeAiDialog();
    });
    $('theme-editor-close')?.addEventListener('click', function () {
        guardedClose();
    });
    const fileInput = $('theme-editor-logo-input') as HTMLInputElement | null;
    if (fileInput) {
        fileInput.addEventListener('change', function (event) {
            const target = event.currentTarget as HTMLInputElement;
            const file = target.files && target.files[0];
            target.value = '';
            if (file) uploadAsset(file);
        });
    }
    $('theme-editor-logo-clear')?.addEventListener('click', function () {
        clearLogo();
    });
    const flags: Array<[string, keyof ThemeManifest]> = [
        ['theme-editor-flag-cover', 'cover'],
        ['theme-editor-flag-header', 'header'],
        ['theme-editor-flag-footer', 'footer'],
        ['theme-editor-flag-hide-fm', 'hideInlineFrontmatter'],
    ];
    for (const [id, key] of flags) {
        (document.getElementById(id) as HTMLInputElement | null)
            ?.addEventListener('change', function (event) {
                if (!currentFiles) return;
                const checked = (event.currentTarget as HTMLInputElement).checked;
                (currentFiles.manifest as unknown as Record<string, unknown>)[key as string] =
                    checked;
                manifestDirty = true;
                syncDirtyUi();
                refreshPartsFromManifest();
            });
    }
    document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !isVirtualTabActive('theme-editor')) return;
        event.preventDefault();
        guardedClose();
    });
}

export function getCurrentThemeId(): string | null {
    return currentId;
}

export function applyThemeDraft(draft: {
    manifest?: ThemeManifest | null;
    contentCss: string;
    darkCss?: string | null;
    pageCss?: string | null;
    coverHtml?: string | null;
    headerHtml?: string | null;
    footerHtml?: string | null;
}): void {
    const surface = editor();
    if (!surface || !currentFiles) return;

    const originalParts = filesToParts(currentFiles);
    const currentParts = surface.getAllParts();

    if (draft.manifest != null) {
        currentFiles.manifest = {
            ...currentFiles.manifest,
            ...draft.manifest,
        };
        manifestDirty = true;
    }

    const draftParts: FolioThemeParts = {
        ...currentParts,
        content: draft.contentCss || '',
    };
    if (draft.darkCss != null) draftParts.dark = draft.darkCss;
    if (draft.pageCss != null) draftParts.page = draft.pageCss;
    if (draft.coverHtml != null) draftParts.cover = draft.coverHtml;
    if (draft.headerHtml != null) draftParts.header = draft.headerHtml;
    if (draft.footerHtml != null) draftParts.footer = draft.footerHtml;

    surface.setParts(draftParts, originalParts);
    syncManifestFlags(currentFiles.manifest);
    renderPartSwitcher(draftParts);
    syncDirtyUi();
    schedulePreview();
}
