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
    assets: unknown[];
    source: string;
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

let currentId: string | null = null;
let currentFiles: ThemeFiles | null = null;
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
    select.textContent = '';
    for (const part of Object.keys(PART_LABELS) as FolioThemePart[]) {
        if (!hasPart(parts, part)) continue;
        const option = document.createElement('option');
        option.value = part;
        option.textContent = PART_LABELS[part];
        select.appendChild(option);
    }
    select.value = 'content';
}

function syncDirtyUi(): void {
    const dirty = !!editor()?.isDirty();
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
    syncDirtyUi();
    registerVirtualTab({
        slug: 'theme-editor',
        label: () => '\ud83c\udfa8 ' + (currentFiles?.manifest.name || currentId || 'Theme'),
        dirty: () => !!editor()?.isDirty(),
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
        const surface = editor();
        if (surface?.isDirty()) {
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
    $('theme-editor-close')?.addEventListener('click', function () {
        guardedClose();
    });
    document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !isVirtualTabActive('theme-editor')) return;
        event.preventDefault();
        guardedClose();
    });
}
