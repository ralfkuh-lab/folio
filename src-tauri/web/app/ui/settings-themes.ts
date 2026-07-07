import { folioLog } from '../util/log';
import { makeToggle } from './controls';
import { openThemeEditor } from './theme-editor';
import type { SettingsData } from './settings-dialog';

export type ViewThemeInfo = {
    id: string;
    name: string;
    description: string;
    hasDark: boolean;
    custom: boolean;
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

type ThemeFiles = {
    manifest: ThemeManifest;
    contentCss: string;
    darkCss?: string | null;
    pageCss?: string | null;
    coverHtml?: string | null;
    headerHtml?: string | null;
    footerHtml?: string | null;
    assets: unknown[];
    source: 'builtin' | 'directory' | 'legacyFlat' | string;
};

type ThemePartKey =
    | 'contentCss'
    | 'darkCss'
    | 'pageCss'
    | 'coverHtml'
    | 'headerHtml'
    | 'footerHtml';

type ThemePartOption = {
    key: ThemePartKey;
    label: string;
    value: string;
};

type InitOptions = {
    getSettings: () => SettingsData | null;
    patchSettings: (patch: Partial<SettingsData>) => Promise<void>;
};

const PART_LABELS: Array<[ThemePartKey, string]> = [
    ['contentCss', 'content.css'],
    ['darkCss', 'content.dark.css'],
    ['pageCss', 'page.css'],
    ['coverHtml', 'cover.html'],
    ['headerHtml', 'header.html'],
    ['footerHtml', 'footer.html'],
];

let options: InitOptions | null = null;
let viewThemes: ViewThemeInfo[] = [];
let selectedThemeId = 'standard';
let detailFiles: ThemeFiles | null = null;
let pendingDeleteTheme: ViewThemeInfo | null = null;
let previewObserver: IntersectionObserver | null = null;
let previewCache = new Map<string, string>();
let previewGeneration = 0;
let detailDark = false;
let editManifest = false;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function getInvoke(): ((cmd: string, args?: any) => Promise<any>) | null {
    var core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

function themeById(id: string): ViewThemeInfo | null {
    return viewThemes.find(function (theme) { return theme.id === id; }) || null;
}

function activeThemeId(): string {
    var settings = options?.getSettings();
    var requested = settings?.viewTheme || 'standard';
    return themeById(requested) ? requested : 'standard';
}

function favoriteIds(): Set<string> {
    var settings = options?.getSettings();
    return new Set(settings?.themeFavorites || []);
}

function isExportTheme(theme: ViewThemeInfo): boolean {
    return theme.id !== 'standard';
}

function setThemeError(message: string | null): void {
    var error = $('settings-theme-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function setThemeDialogError(message: string | null): void {
    var error = $('theme-create-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function setDetailError(message: string | null): void {
    var error = $('settings-theme-detail-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

export function syncSettingsThemeState(_settings: SettingsData): void {
    syncSelectionUi();
    syncFavoriteViewThemes();
    if (editManifest) return;
    renderDetail();
}

function syncSelectionUi(): void {
    var list = $('settings-theme-list');
    if (!list) return;
    var active = activeThemeId();
    var selected = themeById(selectedThemeId) ? selectedThemeId : active;
    selectedThemeId = selected;
    list.querySelectorAll<HTMLElement>('[data-view-theme]').forEach(function (entry) {
        var id = entry.dataset.viewTheme || '';
        var isSelected = id === selected;
        var isActive = id === active;
        entry.classList.toggle('selected', isSelected);
        entry.classList.toggle('is-active', isActive);
        entry.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        entry.tabIndex = isSelected ? 0 : -1;
        var badge = entry.querySelector<HTMLElement>('[data-theme-active-badge]');
        if (badge) badge.hidden = !isActive;
    });
}

function syncFavoriteViewThemes(): void {
    var favorites = favoriteIds();
    document.querySelectorAll<HTMLButtonElement>('[data-view-theme-fav]')
        .forEach(function (button) {
            var active = favorites.has(button.dataset.viewThemeFav || '');
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
            button.setAttribute(
                'aria-label',
                active ? 'Favorit entfernen' : 'Als Favorit markieren',
            );
            button.textContent = active ? '★' : '☆';
        });
}

function toggleThemeFavorite(themeId: string): void {
    if (!options) return;
    var settings = options.getSettings();
    if (!settings) return;
    var knownIds = new Set(viewThemes
        .filter(function (theme) { return isExportTheme(theme); })
        .map(function (theme) { return theme.id; }));
    var favorites = (settings.themeFavorites || [])
        .filter(function (id) { return knownIds.has(id); });
    var index = favorites.indexOf(themeId);
    if (index >= 0) {
        favorites.splice(index, 1);
    } else {
        favorites.push(themeId);
    }
    options.patchSettings({ themeFavorites: favorites });
}

export async function refreshSettingsThemes(): Promise<void> {
    var invoke = getInvoke();
    if (!invoke) return;
    try {
        var themes = await invoke('view_themes');
        renderSettingsThemes(Array.isArray(themes) ? themes as ViewThemeInfo[] : []);
    } catch (err) {
        folioLog.error('settings-themes', 'view_themes failed', { error: String(err) });
    }
}

export function handleSettingsThemesChanged(): void {
    previewGeneration++;
    previewCache.clear();
    refreshSettingsThemes();
}

function themeAction(
    label: string,
    action: string,
    theme: ViewThemeInfo,
    onClick: () => void,
): HTMLButtonElement {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-theme-button settings-theme-card__action';
    button.dataset.themeAction = action;
    button.dataset.themeId = theme.id;
    button.textContent = label;
    button.addEventListener('click', function (event) {
        event.stopPropagation();
        onClick();
    });
    button.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
    return button;
}

function loadPreview(themeId: string, dark: boolean): Promise<string> {
    var key = themeId + '|' + (dark ? 'dark' : 'light');
    var cached = previewCache.get(key);
    if (cached != null) return Promise.resolve(cached);
    var invoke = getInvoke();
    if (!invoke) return Promise.resolve('');
    return invoke('theme_preview_saved', { themeId, dark }).then(function (html: string) {
        var value = typeof html === 'string' ? html : '';
        previewCache.set(key, value);
        return value;
    }, function (err: unknown) {
        folioLog.warn('settings-themes', 'theme_preview_saved failed', {
            themeId,
            dark,
            error: String(err),
        });
        return '';
    });
}

function setFramePreview(frame: HTMLIFrameElement, themeId: string, dark: boolean): void {
    var generation = previewGeneration;
    loadPreview(themeId, dark).then(function (html) {
        if (generation !== previewGeneration || !frame.isConnected) return;
        frame.srcdoc = html;
    });
}

function attachLazyPreview(frame: HTMLIFrameElement, themeId: string): void {
    frame.dataset.previewTheme = themeId;
    if (!previewObserver && typeof IntersectionObserver !== 'undefined') {
        previewObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var target = entry.target as HTMLIFrameElement;
                previewObserver?.unobserve(target);
                var id = target.dataset.previewTheme || '';
                if (id) setFramePreview(target, id, false);
            });
        }, { root: $('settings-theme-list') || undefined, threshold: 0.01 });
    }
    if (previewObserver) {
        previewObserver.observe(frame);
    } else {
        setFramePreview(frame, themeId, false);
    }
}

function cardPreview(theme: ViewThemeInfo): HTMLElement {
    var preview = document.createElement('div');
    preview.className = 'settings-theme-card__preview';
    var frame = document.createElement('iframe');
    frame.title = theme.name + ' Vorschau';
    frame.setAttribute('sandbox', '');
    preview.appendChild(frame);
    attachLazyPreview(frame, theme.id);
    return preview;
}

function renderBadges(theme: ViewThemeInfo): HTMLElement {
    var badges = document.createElement('span');
    badges.className = 'settings-theme-card__badges';
    var activeBadge = document.createElement('span');
    activeBadge.className = 'settings-theme-card__badge settings-theme-card__badge--active';
    activeBadge.dataset.themeActiveBadge = 'true';
    activeBadge.textContent = '● Aktiv';
    badges.appendChild(activeBadge);
    if (theme.custom) {
        var customBadge = document.createElement('span');
        customBadge.className =
            'settings-theme-card__badge settings-theme-card__badge--custom';
        customBadge.textContent = 'Eigenes Theme';
        badges.appendChild(customBadge);
    } else {
        var builtinBadge = document.createElement('span');
        builtinBadge.className = 'settings-theme-card__badge';
        builtinBadge.textContent = 'Built-in';
        badges.appendChild(builtinBadge);
    }
    var variantBadge = document.createElement('span');
    variantBadge.className = 'settings-theme-card__badge';
    variantBadge.textContent = theme.hasDark ? 'Hell/Dunkel' : 'Nur hell';
    badges.appendChild(variantBadge);
    return badges;
}

function selectThemeDetail(themeId: string, focusDetail = false): void {
    if (!themeById(themeId)) return;
    selectedThemeId = themeId;
    detailFiles = null;
    editManifest = false;
    syncSelectionUi();
    renderDetail();
    readSelectedTheme();
    if (focusDetail) {
        ($('settings-theme-detail') as HTMLElement | null)?.focus();
    }
}

function renderCard(theme: ViewThemeInfo): HTMLElement {
    var entry = document.createElement('article');
    entry.className = 'settings-theme-card';
    entry.dataset.viewTheme = theme.id;
    entry.setAttribute('role', 'option');
    entry.setAttribute('aria-selected', 'false');
    entry.tabIndex = -1;

    entry.appendChild(cardPreview(theme));

    var body = document.createElement('div');
    body.className = 'settings-theme-card__body';
    var top = document.createElement('div');
    top.className = 'settings-theme-card__top';
    var name = document.createElement('span');
    name.className = 'settings-theme-card__name';
    name.textContent = theme.name;
    top.appendChild(name);
    if (isExportTheme(theme)) {
        var favorite = document.createElement('button');
        favorite.type = 'button';
        favorite.className = 'settings-theme-card__fav';
        favorite.dataset.viewThemeFav = theme.id;
        favorite.setAttribute('aria-label', 'Als Favorit markieren');
        favorite.setAttribute('aria-pressed', 'false');
        favorite.textContent = '☆';
        favorite.addEventListener('click', function (event) {
            event.stopPropagation();
            toggleThemeFavorite(theme.id);
        });
        favorite.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
        });
        top.appendChild(favorite);
    }
    var description = document.createElement('span');
    description.className = 'settings-theme-card__description';
    description.textContent = theme.description;
    body.append(top, description, renderBadges(theme));
    if (theme.id === 'standard') {
        var note = document.createElement('span');
        note.className = 'settings-theme-card__note';
        note.textContent = 'Folgt dem App-Theme · nur Ansicht, kein Export-Layout';
        body.appendChild(note);
    }
    entry.appendChild(body);
    entry.addEventListener('click', function () {
        selectThemeDetail(theme.id);
    });
    entry.addEventListener('keydown', function (event) {
        if (event.target !== entry || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.stopPropagation();
        selectThemeDetail(theme.id, true);
    });
    return entry;
}

export function renderSettingsThemes(themes: ViewThemeInfo[]): void {
    var list = $('settings-theme-list');
    if (!list) return;
    if (previewObserver) {
        previewObserver.disconnect();
        previewObserver = null;
    }
    viewThemes = themes;
    if (!themeById(selectedThemeId)) selectedThemeId = activeThemeId();
    list.textContent = '';
    themes.forEach(function (theme) {
        list.appendChild(renderCard(theme));
    });
    syncSelectionUi();
    syncFavoriteViewThemes();
    renderDetail();
    readSelectedTheme();
    populateThemeBaseOptions(selectedThemeId);
}

export function renderSettingsThemesDirHint(path: string): void {
    var hint = $('settings-theme-hint');
    if (!hint) return;
    hint.textContent = 'Eigene Themes: CSS-Dateien in ' + path +
        ' ablegen (name.css, optional name.dark.css / name.page.css).';
}

function partOptions(files: ThemeFiles): ThemePartOption[] {
    return PART_LABELS.flatMap(function ([key, label]) {
        var value = files[key];
        if (key !== 'contentCss' && value == null) return [];
        return [{ key, label, value: value || '' }];
    });
}

function selectedPartValue(files: ThemeFiles): string {
    var select = $('settings-theme-detail-part') as HTMLSelectElement | null;
    var parts = partOptions(files);
    var selected = parts.find(function (part) { return part.key === select?.value; }) || parts[0];
    return selected?.value || '';
}

function renderDetailPartControls(files: ThemeFiles): void {
    var select = $('settings-theme-detail-part') as HTMLSelectElement | null;
    var pre = $('settings-theme-detail-code') as HTMLPreElement | null;
    if (!select || !pre) return;
    var previous = select.value;
    select.textContent = '';
    var parts = partOptions(files);
    parts.forEach(function (part) {
        var option = document.createElement('option');
        option.value = part.key;
        option.textContent = part.label;
        select.appendChild(option);
    });
    if (parts.some(function (part) { return part.key === previous; })) {
        select.value = previous;
    }
    pre.textContent = selectedPartValue(files);
}

function detailActions(theme: ViewThemeInfo): HTMLElement {
    var actions = document.createElement('div');
    actions.className = 'settings-theme-detail__actions';
    var use = document.createElement('button');
    use.type = 'button';
    use.id = 'settings-theme-use';
    use.className = 'settings-theme-button primary';
    var active = activeThemeId() === theme.id;
    use.disabled = active;
    use.textContent = active ? 'Wird verwendet ✓' : 'Als Ansicht verwenden';
    use.addEventListener('click', function () {
        options?.patchSettings({ viewTheme: theme.id });
    });
    actions.appendChild(use);
    if (!isExportTheme(theme)) return actions;
    if (theme.custom) {
        actions.appendChild(themeAction('Bearbeiten', 'edit', theme, function () {
            openThemeEditor(theme.id);
        }));
    }
    actions.appendChild(themeAction('Duplizieren', 'clone', theme, function () {
        openThemeCreateDialog(theme);
    }));
    actions.appendChild(themeAction('Exportieren…', 'export', theme, function () {
        exportTheme(theme);
    }));
    if (theme.custom) {
        actions.appendChild(themeAction('Löschen', 'delete', theme, function () {
            openThemeDeleteDialog(theme);
        }));
    }
    return actions;
}

function renderDetailHeader(theme: ViewThemeInfo, files: ThemeFiles | null): HTMLElement {
    var header = document.createElement('div');
    header.className = 'settings-theme-detail__header';
    var text = document.createElement('div');
    text.className = 'settings-theme-detail__titleblock';
    if (editManifest && theme.custom && files) {
        var nameInput = document.createElement('input');
        nameInput.id = 'settings-theme-detail-name-input';
        nameInput.className = 'settings-input';
        nameInput.value = files.manifest.name || theme.name;
        nameInput.setAttribute('aria-label', 'Theme-Name');
        var descInput = document.createElement('input');
        descInput.id = 'settings-theme-detail-description-input';
        descInput.className = 'settings-input';
        descInput.value = files.manifest.description || theme.description;
        descInput.setAttribute('aria-label', 'Theme-Beschreibung');
        text.append(nameInput, descInput);
    } else {
        var title = document.createElement('h3');
        title.className = 'settings-theme-detail__title';
        title.textContent = files?.manifest.name || theme.name;
        var description = document.createElement('p');
        description.className = 'settings-theme-detail__description';
        description.textContent = files?.manifest.description || theme.description;
        text.append(title, description);
    }
    header.appendChild(text);
    if (theme.custom) {
        var edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'settings-theme-icon-button';
        edit.id = editManifest ? 'settings-theme-detail-save-name' : 'settings-theme-detail-edit-name';
        edit.title = editManifest ? 'Name und Beschreibung speichern' : 'Name und Beschreibung bearbeiten';
        edit.textContent = editManifest ? '✓' : '✎';
        edit.addEventListener('click', function () {
            if (editManifest) {
                saveDetailManifest();
            } else {
                editManifest = true;
                renderDetail();
                (document.getElementById('settings-theme-detail-name-input') as HTMLInputElement | null)
                    ?.focus();
            }
        });
        header.appendChild(edit);
    }
    return header;
}

function renderDetail(): void {
    var detail = $('settings-theme-detail');
    if (!detail) return;
    var theme = themeById(selectedThemeId);
    detail.textContent = '';
    if (!theme) {
        var empty = document.createElement('p');
        empty.className = 'settings-hint';
        empty.textContent = 'Theme auswählen.';
        detail.appendChild(empty);
        return;
    }
    detail.appendChild(renderDetailHeader(theme, detailFiles));
    var meta = document.createElement('div');
    meta.className = 'settings-theme-detail__badges';
    var source = document.createElement('span');
    source.className = 'settings-theme-card__badge';
    source.textContent = theme.custom ? 'Eigenes Theme' : 'Built-in';
    var variant = document.createElement('span');
    variant.className = 'settings-theme-card__badge';
    variant.textContent = theme.hasDark ? 'Hell/Dunkel' : 'Nur hell';
    meta.append(source, variant);
    if (theme.id === 'standard') {
        var note = document.createElement('span');
        note.className = 'settings-theme-detail__note';
        note.textContent = 'Folgt dem App-Theme · nur Ansicht, kein Export-Layout';
        meta.appendChild(note);
    }
    detail.appendChild(meta);
    if (detailFiles) {
        var fontItems = [
            ['Body', detailFiles.manifest.fontBody],
            ['Mono', detailFiles.manifest.fontMono],
            ['Größe', detailFiles.manifest.fontSize],
        ].filter(function (item) { return !!item[1]; });
        if (fontItems.length) {
            var fonts = document.createElement('p');
            fonts.className = 'settings-theme-detail__fonts';
            fonts.textContent = fontItems.map(function (item) {
                return item[0] + ': ' + item[1];
            }).join(' · ');
            detail.appendChild(fonts);
        }
    }

    var preview = document.createElement('div');
    preview.className = 'settings-theme-detail__preview';
    var frame = document.createElement('iframe');
    frame.id = 'settings-theme-detail-preview';
    frame.title = theme.name + ' Detail-Vorschau';
    frame.setAttribute('sandbox', '');
    preview.appendChild(frame);
    detail.appendChild(preview);

    var previewRow = document.createElement('div');
    previewRow.className = 'settings-theme-detail__preview-row';
    var toggle = makeToggle(
        'settings-theme-detail-dark',
        detailDark,
        'Dunkle Vorschau',
        function (checked) {
            detailDark = checked;
            renderDetailPreview();
        },
    );
    var toggleText = document.createElement('span');
    toggleText.textContent = 'Dunkle Vorschau';
    previewRow.append(toggle, toggleText);
    detail.appendChild(previewRow);

    var fileRow = document.createElement('label');
    fileRow.className = 'settings-theme-detail__file';
    fileRow.textContent = 'Datei: ';
    var select = document.createElement('select');
    select.id = 'settings-theme-detail-part';
    select.className = 'settings-input';
    select.addEventListener('change', function () {
        if (!detailFiles) return;
        var pre = $('settings-theme-detail-code') as HTMLPreElement | null;
        if (pre) pre.textContent = selectedPartValue(detailFiles);
    });
    fileRow.appendChild(select);
    detail.appendChild(fileRow);
    var code = document.createElement('pre');
    code.id = 'settings-theme-detail-code';
    code.className = 'settings-theme-detail__code';
    detail.appendChild(code);

    var error = document.createElement('p');
    error.id = 'settings-theme-detail-error';
    error.className = 'settings-ai-error';
    error.hidden = true;
    detail.appendChild(error);
    detail.appendChild(detailActions(theme));

    if (detailFiles) renderDetailPartControls(detailFiles);
    renderDetailPreview();
}

function renderDetailPreview(): void {
    var frame = $('settings-theme-detail-preview') as HTMLIFrameElement | null;
    if (!frame) return;
    setFramePreview(frame, selectedThemeId, detailDark);
}

async function readSelectedTheme(): Promise<void> {
    var invoke = getInvoke();
    var themeId = selectedThemeId;
    if (!invoke || !themeById(themeId)) return;
    setDetailError(null);
    try {
        var files = await invoke('theme_read', { id: themeId }) as ThemeFiles;
        if (themeId !== selectedThemeId) return;
        detailFiles = files;
        renderDetail();
    } catch (err) {
        folioLog.warn('settings-themes', 'theme_read failed', {
            themeId,
            error: String(err),
        });
        if (themeId === selectedThemeId) setDetailError(String(err));
    }
}

async function saveDetailManifest(): Promise<void> {
    var invoke = getInvoke();
    var theme = themeById(selectedThemeId);
    var nameInput = $('settings-theme-detail-name-input') as HTMLInputElement | null;
    var descInput = $('settings-theme-detail-description-input') as HTMLInputElement | null;
    if (!invoke || !theme || !theme.custom || !nameInput || !descInput) return;
    var name = nameInput.value.trim();
    var description = descInput.value.trim();
    if (!name) {
        setDetailError('Anzeigename darf nicht leer sein.');
        return;
    }
    setDetailError(null);
    try {
        var files = await invoke('theme_read', { id: theme.id }) as ThemeFiles;
        files.manifest.name = name;
        files.manifest.description = description;
        await invoke('theme_write', { id: theme.id, files });
        editManifest = false;
        detailFiles = files;
        await refreshSettingsThemes();
    } catch (err) {
        folioLog.warn('settings-themes', 'theme_write manifest failed', {
            themeId: theme.id,
            error: String(err),
        });
        setDetailError(String(err));
    }
}

function populateThemeBaseOptions(selectedId?: string): void {
    var select = $('theme-create-base') as HTMLSelectElement | null;
    if (!select) return;
    select.textContent = '';
    viewThemes.filter(function (theme) {
        return isExportTheme(theme);
    }).forEach(function (theme) {
        var option = document.createElement('option');
        option.value = theme.id;
        option.textContent = theme.name;
        select.appendChild(option);
    });
    var selected = selectedId || (viewThemes.some(function (theme) {
        return theme.id === 'clean';
    }) ? 'clean' : select.options[0]?.value);
    if (selected) select.value = selected;
}

function openThemeCreateDialog(baseTheme?: ViewThemeInfo): void {
    var dialog = $('theme-create-dialog');
    var idInput = $('theme-create-id') as HTMLInputElement | null;
    var nameInput = $('theme-create-name') as HTMLInputElement | null;
    if (!dialog || !idInput || !nameInput) return;
    idInput.value = baseTheme ? baseTheme.id + '-copy' : '';
    nameInput.value = baseTheme ? baseTheme.name + ' Kopie' : '';
    populateThemeBaseOptions(baseTheme?.id);
    setThemeDialogError(null);
    dialog.hidden = false;
    idInput.focus();
}

function closeThemeCreateDialog(): void {
    var dialog = $('theme-create-dialog');
    if (dialog) dialog.hidden = true;
    setThemeDialogError(null);
}

async function saveThemeCreateDialog(event: Event): Promise<void> {
    event.preventDefault();
    var invoke = getInvoke();
    var idInput = $('theme-create-id') as HTMLInputElement | null;
    var nameInput = $('theme-create-name') as HTMLInputElement | null;
    var baseSelect = $('theme-create-base') as HTMLSelectElement | null;
    if (!invoke || !idInput || !nameInput || !baseSelect) return;
    var id = idInput.value.trim();
    var name = nameInput.value.trim();
    var sourceId = baseSelect.value;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
        setThemeDialogError('ID: nur Kleinbuchstaben, Zahlen, - und _.');
        return;
    }
    if (!name) {
        setThemeDialogError('Anzeigename darf nicht leer sein.');
        return;
    }
    if (!sourceId) {
        setThemeDialogError('Bitte ein Basis-Theme wählen.');
        return;
    }
    setThemeDialogError(null);
    try {
        await invoke('theme_clone', { sourceId, newId: id });
        var files = await invoke('theme_read', { id }) as ThemeFiles;
        if (files && files.manifest) {
            files.manifest.name = name;
            await invoke('theme_write', { id, files });
        }
        closeThemeCreateDialog();
        await refreshSettingsThemes();
        await openThemeEditor(id);
    } catch (err) {
        setThemeDialogError(String(err));
    }
}

async function deleteTheme(theme: ViewThemeInfo): Promise<void> {
    var invoke = getInvoke();
    if (!invoke) return;
    try {
        await invoke('theme_delete', { id: theme.id });
        await refreshSettingsThemes();
    } catch (err) {
        folioLog.error('settings-themes', 'theme_delete failed', {
            themeId: theme.id,
            error: String(err),
        });
    }
}

function openThemeDeleteDialog(theme: ViewThemeInfo): void {
    pendingDeleteTheme = theme;
    var dialog = $('theme-delete-dialog');
    var text = $('theme-delete-text');
    if (text) text.textContent = 'Theme „' + theme.name + '“ wirklich löschen?';
    if (dialog) dialog.hidden = false;
    $('theme-delete-cancel')?.focus();
}

function closeThemeDeleteDialog(): void {
    pendingDeleteTheme = null;
    var dialog = $('theme-delete-dialog');
    if (dialog) dialog.hidden = true;
}

async function confirmThemeDelete(): Promise<void> {
    var theme = pendingDeleteTheme;
    closeThemeDeleteDialog();
    if (theme) await deleteTheme(theme);
}

async function exportTheme(theme: ViewThemeInfo): Promise<void> {
    var invoke = getInvoke();
    if (!invoke) return;
    setThemeError(null);
    try {
        await invoke('theme_export', { id: theme.id });
    } catch (err) {
        setThemeError(String(err));
    }
}

async function importTheme(): Promise<void> {
    var invoke = getInvoke();
    if (!invoke) return;
    setThemeError(null);
    try {
        var imported = await invoke('theme_import');
        if (imported) await refreshSettingsThemes();
    } catch (err) {
        setThemeError(String(err));
    }
}

function navigateCards(event: KeyboardEvent): void {
    var list = $('settings-theme-list');
    if (!list) return;
    var cards = Array.from(list.querySelectorAll<HTMLElement>('[data-view-theme]'));
    if (!cards.length) return;
    var activeElement = document.activeElement as HTMLElement | null;
    var activeCard = activeElement?.closest<HTMLElement>('[data-view-theme]')
        || (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-view-theme]');
    var current = activeCard
        ? cards.indexOf(activeCard)
        : cards.findIndex(function (card) {
        return card.dataset.viewTheme === selectedThemeId;
    });
    var nextIndex = current < 0 ? 0 : current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (nextIndex + 1) % cards.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (nextIndex - 1 + cards.length) % cards.length;
    } else if (event.key === 'Home') {
        nextIndex = 0;
    } else if (event.key === 'End') {
        nextIndex = cards.length - 1;
    } else {
        return;
    }
    event.preventDefault();
    cards.forEach(function (card) { card.tabIndex = -1; });
    cards[nextIndex].tabIndex = 0;
    cards[nextIndex].focus();
}

export function initSettingsThemes(initOptions: InitOptions): void {
    options = initOptions;
    $('settings-theme-create')?.addEventListener('click', function () {
        openThemeCreateDialog();
    });
    $('settings-theme-import')?.addEventListener('click', importTheme);
    $('theme-create-cancel')?.addEventListener('click', closeThemeCreateDialog);
    $('theme-create-form')?.addEventListener('submit', saveThemeCreateDialog);
    $('theme-create-dialog')?.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeThemeCreateDialog();
    });
    $('theme-delete-cancel')?.addEventListener('click', closeThemeDeleteDialog);
    $('theme-delete-confirm')?.addEventListener('click', confirmThemeDelete);
    $('theme-delete-dialog')?.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeThemeDeleteDialog();
    });
    $('settings-theme-list')?.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            var target = event.target as HTMLElement | null;
            var card = target?.closest<HTMLElement>('[data-view-theme]');
            if (!card) return;
            event.preventDefault();
            selectThemeDetail(card.dataset.viewTheme || '', true);
            return;
        }
        navigateCards(event);
    });
}
