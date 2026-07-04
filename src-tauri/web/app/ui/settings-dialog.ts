/* Settings-Dialog: bietet die Phase-1-Praeferenzen an
   (Sprache, Default-Mode pro Datei-Kind, View-Auto-Format). Persistenz
   und Validierung passieren im Backend (settings.rs, settings_get,
   settings_update); dieses Modul ist reine UI-Bindings + Patch-Dispatch.

   Sprachwechsel wirkt absichtlich erst beim naechsten Start: Codex-
   Review hat aufgezeigt, dass ein Live-Menue-Rebuild den vom Frontend
   nachgepflegten checked/enabled-State (Theme-Haekchen, Mode, Save-
   Enabled etc.) verliert. Konservativer Phase-1-Schnitt: persistieren
   und beim Boot via menu::build anwenden. */

import { applyLogLevelFromSettings, folioLog } from '../util/log';
import { applyViewTheme } from '../view/theme';

type SettingsLanguage = 'de' | 'en';
export type DefaultViewMode = 'view' | 'edit' | 'current';
export type ExportDirMode = 'document' | 'last';
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type ViewThemeInfo = {
    id: string;
    name: string;
    description: string;
    hasDark: boolean;
    custom: boolean;
};

export type SettingsData = {
    language: SettingsLanguage;
    defaultModeMarkdown: DefaultViewMode;
    defaultModeText: DefaultViewMode;
    viewAutoFormat: boolean;
    viewTheme: string;
    themeFavorites: string[];
    vaultAutoRefresh: boolean;
    documentAutoReload: boolean;
    exportDirMode: ExportDirMode;
    logLevel: LogLevel;
};

function isViewMode(v: string): v is DefaultViewMode {
    return v === 'view' || v === 'edit' || v === 'current';
}

function isLogLevel(v: string): v is LogLevel {
    return v === 'off' || v === 'error' || v === 'warn' || v === 'info' || v === 'debug';
}

function isExportDirMode(v: string): v is ExportDirMode {
    return v === 'document' || v === 'last';
}

let currentSettings: SettingsData | null = null;
let bootLanguage: SettingsLanguage | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let viewThemes: ViewThemeInfo[] = [];

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function settingsTabs(dlg: HTMLElement): HTMLButtonElement[] {
    return Array.from(dlg.querySelectorAll<HTMLButtonElement>(
        '[role="tab"][id^="settings-tab-"]',
    ));
}

function activateSettingsTab(slug: string): void {
    var dlg = $('settings-dialog');
    if (!dlg) return;
    settingsTabs(dlg).forEach(function (tab) {
        var active = tab.id === 'settings-tab-' + slug;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.classList.toggle('settings-dialog__tab--active', active);
        tab.tabIndex = active ? 0 : -1;
    });
    dlg.querySelectorAll<HTMLElement>('[role="tabpanel"][data-settings-tab]')
        .forEach(function (panel) {
            panel.hidden = panel.dataset.settingsTab !== slug;
        });
}

function bindTabs(dlg: HTMLElement): void {
    var tabs = settingsTabs(dlg);
    tabs.forEach(function (tab, index) {
        tab.addEventListener('click', function () {
            activateSettingsTab(tab.id.slice('settings-tab-'.length));
        });
        tab.addEventListener('keydown', function (e) {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            var offset = e.key === 'ArrowDown' ? 1 : -1;
            var next = tabs[(index + offset + tabs.length) % tabs.length];
            next.click();
            next.focus();
        });
    });
}

function getInvoke(): ((cmd: string, args?: any) => Promise<any>) | null {
    var core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

/**
 * Liefert die zuletzt vom Backend geladenen Settings (oder `null`, falls
 * der Dialog noch nie geoeffnet wurde). Andere Module (Document-Open,
 * View-Code) koennen das ohne Roundtrip lesen — wir halten den Cache
 * via `settings:changed`-Listener aktuell.
 */
export function getCachedSettings(): SettingsData | null {
    return currentSettings;
}

function applySettingsToForm(data: SettingsData): void {
    var langSelect = $('settings-language') as HTMLSelectElement | null;
    var mdSelect = $('settings-default-md') as HTMLSelectElement | null;
    var textSelect = $('settings-default-text') as HTMLSelectElement | null;
    var autoFormat = $('settings-view-auto-format') as HTMLInputElement | null;
    var vaultRefresh = $('settings-vault-auto-refresh') as HTMLInputElement | null;
    var docReload = $('settings-document-auto-reload') as HTMLInputElement | null;
    var exportDirMode = $('settings-export-dir-mode') as HTMLSelectElement | null;
    var logLevel = $('settings-log-level') as HTMLSelectElement | null;
    var langHint = $('settings-language-hint');

    if (langSelect) langSelect.value = data.language;
    if (mdSelect) mdSelect.value = data.defaultModeMarkdown;
    if (textSelect) textSelect.value = data.defaultModeText;
    if (autoFormat) autoFormat.checked = !!data.viewAutoFormat;
    if (vaultRefresh) vaultRefresh.checked = !!data.vaultAutoRefresh;
    if (docReload) docReload.checked = !!data.documentAutoReload;
    if (exportDirMode) exportDirMode.value = data.exportDirMode || 'document';
    if (logLevel) logLevel.value = data.logLevel || 'info';
    syncSelectedViewTheme(data.viewTheme);
    syncFavoriteViewThemes(data.themeFavorites || []);

    if (langHint) {
        // Hinweis nur akzentuieren, wenn die aktuelle Auswahl von der
        // Boot-Sprache abweicht — dann ist ein Restart faellig.
        if (bootLanguage && data.language !== bootLanguage) {
            langHint.textContent = 'Sprachänderung wird beim nächsten Start aktiv.';
            langHint.classList.add('settings-hint--alert');
        } else {
            langHint.textContent = 'Sprachänderung wird beim nächsten Start aktiv.';
            langHint.classList.remove('settings-hint--alert');
        }
    }
}

function syncSelectedViewTheme(themeId: string): void {
    var list = $('settings-theme-list');
    if (!list) return;
    var known = viewThemes.some(function (theme) { return theme.id === themeId; });
    var selected = known ? themeId : 'standard';
    list.querySelectorAll<HTMLElement>('[data-view-theme]').forEach(function (entry) {
        var active = entry.dataset.viewTheme === selected;
        entry.classList.toggle('selected', active);
        entry.setAttribute('aria-checked', active ? 'true' : 'false');
        entry.tabIndex = active ? 0 : -1;
    });
}

function syncFavoriteViewThemes(favorites: string[]): void {
    var favoriteIds = new Set(favorites);
    document.querySelectorAll<HTMLButtonElement>('[data-view-theme-fav]')
        .forEach(function (button) {
            var active = favoriteIds.has(button.dataset.viewThemeFav || '');
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
            button.setAttribute(
                'aria-label',
                active ? 'Favorit entfernen' : 'Als Favorit markieren',
            );
            button.textContent = active ? '★' : '☆';
        });
}

function toggleThemeFavorite(themeId: string): void {
    if (!currentSettings) return;
    var knownIds = new Set(viewThemes
        .filter(function (theme) { return theme.id !== 'standard'; })
        .map(function (theme) { return theme.id; }));
    var favorites = (currentSettings.themeFavorites || [])
        .filter(function (id) { return knownIds.has(id); });
    var index = favorites.indexOf(themeId);
    if (index >= 0) {
        favorites.splice(index, 1);
    } else {
        favorites.push(themeId);
    }
    patchSettings({ themeFavorites: favorites });
}

function renderViewThemes(themes: ViewThemeInfo[]): void {
    var list = $('settings-theme-list');
    if (!list) return;
    list.textContent = '';
    themes.forEach(function (theme) {
        var entry = document.createElement('div');
        entry.className = 'settings-theme-card';
        entry.dataset.viewTheme = theme.id;
        entry.setAttribute('role', 'radio');
        entry.setAttribute('aria-checked', 'false');
        entry.tabIndex = -1;

        var text = document.createElement('span');
        text.className = 'settings-theme-card__text';
        var name = document.createElement('span');
        name.className = 'settings-theme-card__name';
        name.textContent = theme.name;
        var description = document.createElement('span');
        description.className = 'settings-theme-card__description';
        description.textContent = theme.description;
        text.append(name, description);

        var badges = document.createElement('span');
        badges.className = 'settings-theme-card__badges';
        if (theme.custom) {
            var customBadge = document.createElement('span');
            customBadge.className =
                'settings-theme-card__badge settings-theme-card__badge--custom';
            customBadge.textContent = 'Eigenes Theme';
            badges.appendChild(customBadge);
        }
        var variantBadge = document.createElement('span');
        variantBadge.className = 'settings-theme-card__badge';
        variantBadge.textContent = theme.hasDark ? 'Hell/Dunkel' : 'Nur hell';
        badges.appendChild(variantBadge);
        entry.appendChild(text);
        if (theme.id !== 'standard') {
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
                if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation();
                }
            });
            entry.appendChild(favorite);
        }
        entry.appendChild(badges);
        entry.addEventListener('click', function () {
            patchSettings({ viewTheme: theme.id });
        });
        entry.addEventListener('keydown', function (event) {
            if (event.target !== entry || (event.key !== 'Enter' && event.key !== ' ')) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            patchSettings({ viewTheme: theme.id });
        });
        list.appendChild(entry);
    });
    syncSelectedViewTheme(currentSettings ? currentSettings.viewTheme : 'standard');
    syncFavoriteViewThemes(currentSettings ? currentSettings.themeFavorites || [] : []);
}

function renderThemesDirHint(path: string): void {
    var hint = $('settings-theme-hint');
    if (!hint) return;
    hint.textContent = 'Eigene Themes: CSS-Dateien in ' + path +
        ' ablegen (name.css, optional name.dark.css / name.page.css).';
}

async function patchSettings(patch: Partial<SettingsData>): Promise<void> {
    var invoke = getInvoke();
    if (!invoke) return;
    try {
        var data = await invoke('settings_update', { patch });
        if (data && typeof data === 'object') {
            currentSettings = data as SettingsData;
            applySettingsToForm(currentSettings);
            applyLogLevelFromSettings(currentSettings.logLevel);
        }
    } catch (err) {
        console.error('settings_update failed', err);
        folioLog.error('settings', 'settings_update failed', { error: String(err) });
    }
}

// Keydown-Handler erst registrieren, wenn der Dialog tatsaechlich
// sichtbar wird — vorher konnte ein fehlgeschlagenes settings_get einen
// Zombie-Handler hinterlassen (Dialog nie sichtbar, closeSettingsDialog
// returnte am hidden-Check vor dem removeEventListener, und ab dann
// wurde jede Enter/Escape-Taste app-weit preventDefault'd).
function installKeydownHandler(): void {
    if (keydownHandler) return;
    keydownHandler = function (e: KeyboardEvent) {
        if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault();
            closeSettingsDialog();
        }
    };
    document.addEventListener('keydown', keydownHandler);
}

export function openSettingsDialog(): void {
    var dlg = $('settings-dialog');
    if (!dlg) return;
    activateSettingsTab('allgemein');
    var invoke = getInvoke();
    if (!invoke) {
        dlg.hidden = false;
        installKeydownHandler();
        return;
    }
    Promise.all([
        invoke('settings_get'),
        invoke('view_themes'),
        invoke('themes_dir_path'),
    ]).then(function (result: any[]) {
        var data = result[0];
        var themes = result[1];
        var themesDir = result[2];
        if (!data || typeof data !== 'object') return;
        currentSettings = data as SettingsData;
        viewThemes = Array.isArray(themes) ? themes as ViewThemeInfo[] : [];
        renderViewThemes(viewThemes);
        renderThemesDirHint(typeof themesDir === 'string' ? themesDir : '');
        if (bootLanguage === null) bootLanguage = currentSettings.language;
        applySettingsToForm(currentSettings);
        applyLogLevelFromSettings(currentSettings.logLevel);
        dlg.hidden = false;
        installKeydownHandler();
        setTimeout(function () {
            var btn = $('settings-close') as HTMLButtonElement | null;
            if (btn) btn.focus();
        }, 0);
    }).catch(function (err) {
        console.error('settings_get failed', err);
        folioLog.error('settings', 'settings_get failed', { error: String(err) });
    });
}

export function closeSettingsDialog(): void {
    // Handler-Removal VOR dem hidden-Early-Return — sonst bliebe er bei
    // einem inkonsistenten Zustand (Handler da, Dialog hidden) haengen.
    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
    }
    var dlg = $('settings-dialog');
    if (!dlg || dlg.hidden) return;
    dlg.hidden = true;
}

function bindInputs(): void {
    var langSelect = $('settings-language') as HTMLSelectElement | null;
    if (langSelect) {
        langSelect.addEventListener('change', function () {
            var value = langSelect!.value;
            if (value !== 'de' && value !== 'en') return;
            patchSettings({ language: value as SettingsLanguage });
        });
    }
    var mdSelect = $('settings-default-md') as HTMLSelectElement | null;
    if (mdSelect) {
        mdSelect.addEventListener('change', function () {
            var v = mdSelect!.value;
            if (!isViewMode(v)) return;
            patchSettings({ defaultModeMarkdown: v });
        });
    }
    var textSelect = $('settings-default-text') as HTMLSelectElement | null;
    if (textSelect) {
        textSelect.addEventListener('change', function () {
            var v = textSelect!.value;
            if (!isViewMode(v)) return;
            patchSettings({ defaultModeText: v });
        });
    }
    var autoFormat = $('settings-view-auto-format') as HTMLInputElement | null;
    if (autoFormat) {
        autoFormat.addEventListener('change', function () {
            patchSettings({ viewAutoFormat: autoFormat!.checked });
        });
    }
    var vaultRefresh = $('settings-vault-auto-refresh') as HTMLInputElement | null;
    if (vaultRefresh) {
        vaultRefresh.addEventListener('change', function () {
            patchSettings({ vaultAutoRefresh: vaultRefresh!.checked });
        });
    }
    var docReload = $('settings-document-auto-reload') as HTMLInputElement | null;
    if (docReload) {
        docReload.addEventListener('change', function () {
            patchSettings({ documentAutoReload: docReload!.checked });
        });
    }
    var exportDirMode = $('settings-export-dir-mode') as HTMLSelectElement | null;
    if (exportDirMode) {
        exportDirMode.addEventListener('change', function () {
            var v = exportDirMode!.value;
            if (!isExportDirMode(v)) return;
            patchSettings({ exportDirMode: v });
        });
    }
    var logLevel = $('settings-log-level') as HTMLSelectElement | null;
    if (logLevel) {
        logLevel.addEventListener('change', function () {
            var v = logLevel!.value;
            if (!isLogLevel(v)) return;
            patchSettings({ logLevel: v });
        });
    }
}

export function initSettingsDialog(): void {
    var dlg = $('settings-dialog');
    if (dlg) {
        bindTabs(dlg);
        dlg.addEventListener('click', function (e) {
            if (e.target === dlg) closeSettingsDialog();
        });
    }
    var closeBtn = $('settings-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSettingsDialog);
    bindInputs();

    // Settings-Cache via 'settings:changed' aktuell halten (z.B. wenn
    // mehrere Webviews / Automation-API patchen). Boot-Sprache wird beim
    // ersten Snapshot eingefroren — Hint laeuft dagegen.
    var ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && typeof ev.listen === 'function') {
        ev.listen('settings:changed', function (event: any) {
            var payload = (event && event.payload) || {};
            if (payload.settings && typeof payload.settings === 'object') {
                currentSettings = payload.settings as SettingsData;
                if (bootLanguage === null) bootLanguage = currentSettings.language;
                applySettingsToForm(currentSettings);
            }
        });
        ev.listen('menu:edit_settings', function () {
            openSettingsDialog();
        });
    }

    // Beim Boot Settings einmal vorladen, damit getCachedSettings() schon
    // vor dem ersten Dialog-Open Aufrufer (Document-Open-Pfad) bedient.
    var invoke = getInvoke();
    if (invoke) {
        invoke('settings_get').then(function (data: any) {
            if (data && typeof data === 'object') {
                currentSettings = data as SettingsData;
                if (bootLanguage === null) bootLanguage = currentSettings.language;
                applyLogLevelFromSettings(currentSettings.logLevel);
                applyViewTheme(currentSettings.viewTheme);
            }
        }).catch(function (err) {
            folioLog.warn('settings', 'settings_get on boot failed', { error: String(err) });
        });
    }
}
