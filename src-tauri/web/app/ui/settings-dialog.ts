/* Settings-Dialog: bietet die Phase-1-Praeferenzen an
   (Sprache, Default-Mode pro Datei-Kind, View-Auto-Format). Persistenz
   und Validierung passieren im Backend (settings.rs, settings_get,
   settings_update); dieses Modul ist reine UI-Bindings + Patch-Dispatch. */

import { applyLogLevelFromSettings, folioLog } from '../util/log';
// Direkt aus translate, nicht dem i18n-Barrel — der re-exportiert
// event-queue und installiert den listen-Patch (würde state/document-
// Tests und andere Listener vor uiReady schlucken).
import { getCatalog, t } from '../i18n/translate';
import {
    configureSettingsTab,
    isVirtualTabActive,
    setSettingsTabOpen,
} from '../state/tabs';
import { applyViewTheme } from '../view/theme';
import { initSettingsAi } from './settings-ai';
import {
    handleSettingsThemesChanged,
    initSettingsThemes,
    renderSettingsThemes,
    renderSettingsThemesDirHint,
    syncSettingsThemeState,
    type ViewThemeInfo,
} from './settings-themes';

/** BCP-47-Tag, `"system"`, oder unbekannter gespeicherter Wert (kein TS-Union). */
export type SettingsLanguage = string;
export type DefaultViewMode = 'view' | 'edit' | 'current';
export type ExportDirMode = 'document' | 'last';
export type OpenFileTarget = 'newtab' | 'replace';
export type SearchPathDisplay = 'relative' | 'absolute';
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type SettingsData = {
    language: SettingsLanguage;
    defaultModeMarkdown: DefaultViewMode;
    defaultModeText: DefaultViewMode;
    viewAutoFormat: boolean;
    viewTheme: string;
    themeFavorites: string[];
    vaultAutoRefresh: boolean;
    vaultShowHidden: boolean;
    documentAutoReload: boolean;
    exportDirMode: ExportDirMode;
    openFileTarget: OpenFileTarget;
    searchPathDisplay: SearchPathDisplay;
    logLevel: LogLevel;
};

function isViewMode(v: string): v is DefaultViewMode {
    return v === 'view' || v === 'edit' || v === 'current';
}

function isLogLevel(v: string): v is LogLevel {
    return v === 'off' || v === 'error' || v === 'warn' || v === 'info' || v === 'debug';
}

function isOpenFileTarget(v: string): v is OpenFileTarget {
    return v === 'newtab' || v === 'replace';
}

function isSearchPathDisplay(v: string): v is SearchPathDisplay {
    return v === 'relative' || v === 'absolute';
}

function isExportDirMode(v: string): v is ExportDirMode {
    return v === 'document' || v === 'last';
}

let currentSettings: SettingsData | null = null;
let bootLanguage: SettingsLanguage | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

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
 * der Dialog noch nie geoeffnet wurde).
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
    var vaultShowHidden = $('settings-vault-show-hidden') as HTMLInputElement | null;
    var docReload = $('settings-document-auto-reload') as HTMLInputElement | null;
    var exportDirMode = $('settings-export-dir-mode') as HTMLSelectElement | null;
    var openFileTarget = $('settings-open-file-target') as HTMLSelectElement | null;
    var searchPathDisplay = $('settings-search-path-display') as HTMLSelectElement | null;
    var logLevel = $('settings-log-level') as HTMLSelectElement | null;
    var langHint = $('settings-language-hint');

    if (langSelect) {
        populateLanguageOptions(langSelect);
        syncLanguageSelect(langSelect, data.language, langHint);
    }
    if (mdSelect) mdSelect.value = data.defaultModeMarkdown;
    if (textSelect) textSelect.value = data.defaultModeText;
    if (autoFormat) autoFormat.checked = !!data.viewAutoFormat;
    if (vaultRefresh) vaultRefresh.checked = !!data.vaultAutoRefresh;
    if (vaultShowHidden) vaultShowHidden.checked = data.vaultShowHidden !== false;
    if (docReload) docReload.checked = !!data.documentAutoReload;
    if (exportDirMode) exportDirMode.value = data.exportDirMode || 'document';
    if (openFileTarget) openFileTarget.value = data.openFileTarget || 'newtab';
    if (searchPathDisplay) searchPathDisplay.value = data.searchPathDisplay || 'relative';
    if (logLevel) logLevel.value = data.logLevel || 'info';
    syncSettingsThemeState(data);

    if (langHint) {
        if (bootLanguage && data.language !== bootLanguage) {
            langHint.classList.add('settings-hint--alert');
        } else {
            langHint.classList.remove('settings-hint--alert');
        }
    }
}

export async function patchSettings(patch: Partial<SettingsData>): Promise<void> {
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
        folioLog.error('settings', 'settings_update failed', { error: String(err) });
    }
}

function installKeydownHandler(): void {
    if (keydownHandler) return;
    keydownHandler = function (e: KeyboardEvent) {
        if (e.key === 'Escape' && isVirtualTabActive('settings')) {
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
        showSettingsRegion(dlg);
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
        renderSettingsThemes(Array.isArray(themes) ? themes as ViewThemeInfo[] : []);
        renderSettingsThemesDirHint(typeof themesDir === 'string' ? themesDir : '');
        if (bootLanguage === null) bootLanguage = currentSettings.language;
        applySettingsToForm(currentSettings);
        applyLogLevelFromSettings(currentSettings.logLevel);
        showSettingsRegion(dlg);
        setTimeout(function () {
            var btn = $('settings-close') as HTMLButtonElement | null;
            if (btn) btn.focus();
        }, 0);
    }).catch(function (err) {
        folioLog.error('settings', 'settings_get failed', { error: String(err) });
    });
}

function showSettingsRegion(dlg: HTMLElement): void {
    dlg.hidden = false;
    setSettingsTabOpen(true);
    installKeydownHandler();
}

export function closeSettingsDialog(): void {
    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
    }
    setSettingsTabOpen(false);
    var dlg = $('settings-dialog');
    if (!dlg || dlg.hidden) return;
    dlg.hidden = true;
}

function appendLangOption(select: HTMLSelectElement, value: string, label: string): void {
    var opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
}

/**
 * Befüllt das Sprach-Select aus der i18n-Registry: „System" (übersetzt) +
 * Sprachen mit Flagge und Eigenbezeichnung. Ohne Katalog (Degradation): fester deutscher
 * Minimal-Fallback system/de/en — nie leeres Select.
 */
export function populateLanguageOptions(select: HTMLSelectElement): void {
    // Native <option>-Texte bleiben a11y-/tastaturfreundlich; alte Windows-Emoji-Fonts
    // zeigen Regionalindikatoren ggf. als ISO-Buchstabenpaar statt als Flagge.
    var catalog = getCatalog();
    select.innerHTML = '';
    if (!catalog || !catalog.languages || catalog.languages.length === 0) {
        // Degradationspfad: hartkodiert DE (Katalog fehlt; t() wäre Key-Fallback).
        appendLangOption(select, 'system', '🌐 System');
        appendLangOption(select, 'de', '🇩🇪 Deutsch');
        appendLangOption(select, 'en', '🇺🇸 English');
        return;
    }
    appendLangOption(select, 'system', '🌐 ' + t('settings.language.system'));
    var langs = catalog.languages || [];
    for (var i = 0; i < langs.length; i++) {
        var lang = langs[i];
        if (!lang || !lang.tag) continue;
        appendLangOption(
            select,
            lang.tag,
            (lang.flag ? lang.flag + ' ' : '') + (lang.name || lang.tag),
        );
    }
}

/**
 * Setzt das Sprach-Select inkl. unbekannter/System-Werte ohne leeres Select.
 * Optionaler `hintEl`: Unknown → Fallback-Hinweis, sonst Neustart-Hinweis.
 * @returns true wenn `language` unbekannt war (disabled Temp-Option).
 */
export function syncLanguageSelect(
    select: HTMLSelectElement,
    language: string,
    hintEl?: HTMLElement | null,
): boolean {
    // temporäre unknown-Option entfernen
    var unknown = select.querySelector('option[data-unknown-lang]');
    if (unknown) unknown.remove();
    var known = Array.from(select.options).some(function (o) {
        return o.value === language && !o.disabled;
    });
    var isUnknown = !known && !!language;
    if (isUnknown) {
        var opt = document.createElement('option');
        opt.value = language;
        opt.textContent = t('settings.language.unknown', { tag: language });
        opt.disabled = true;
        opt.selected = true;
        opt.setAttribute('data-unknown-lang', '1');
        select.appendChild(opt);
    }
    select.value = language;
    // falls value nicht greift (disabled-only), selectedIndex setzen
    if (select.value !== language) {
        for (var i = 0; i < select.options.length; i++) {
            if (select.options[i].value === language) {
                select.selectedIndex = i;
                break;
            }
        }
    }
    if (hintEl) {
        if (isUnknown) {
            hintEl.textContent = t('settings.language.unknownHint', { tag: language });
        } else {
            hintEl.textContent = t('settings.language.hint');
        }
    }
    return isUnknown;
}

function bindInputs(): void {
    var langSelect = $('settings-language') as HTMLSelectElement | null;
    if (langSelect) {
        langSelect.addEventListener('change', function () {
            var value = langSelect.value;
            if (!value || langSelect.selectedOptions[0]?.disabled) return;
            patchSettings({ language: value });
        });
    }
    var mdSelect = $('settings-default-md') as HTMLSelectElement | null;
    if (mdSelect) {
        mdSelect.addEventListener('change', function () {
            var v = mdSelect.value;
            if (!isViewMode(v)) return;
            patchSettings({ defaultModeMarkdown: v });
        });
    }
    var textSelect = $('settings-default-text') as HTMLSelectElement | null;
    if (textSelect) {
        textSelect.addEventListener('change', function () {
            var v = textSelect.value;
            if (!isViewMode(v)) return;
            patchSettings({ defaultModeText: v });
        });
    }
    var autoFormat = $('settings-view-auto-format') as HTMLInputElement | null;
    if (autoFormat) {
        autoFormat.addEventListener('change', function () {
            patchSettings({ viewAutoFormat: autoFormat.checked });
        });
    }
    var vaultRefresh = $('settings-vault-auto-refresh') as HTMLInputElement | null;
    if (vaultRefresh) {
        vaultRefresh.addEventListener('change', function () {
            patchSettings({ vaultAutoRefresh: vaultRefresh.checked });
        });
    }
    var vaultShowHidden = $('settings-vault-show-hidden') as HTMLInputElement | null;
    if (vaultShowHidden) {
        vaultShowHidden.addEventListener('change', function () {
            patchSettings({ vaultShowHidden: vaultShowHidden.checked });
        });
    }
    var docReload = $('settings-document-auto-reload') as HTMLInputElement | null;
    if (docReload) {
        docReload.addEventListener('change', function () {
            patchSettings({ documentAutoReload: docReload.checked });
        });
    }
    var exportDirMode = $('settings-export-dir-mode') as HTMLSelectElement | null;
    if (exportDirMode) {
        exportDirMode.addEventListener('change', function () {
            var v = exportDirMode.value;
            if (!isExportDirMode(v)) return;
            patchSettings({ exportDirMode: v });
        });
    }
    var openFileTarget = $('settings-open-file-target') as HTMLSelectElement | null;
    if (openFileTarget) {
        openFileTarget.addEventListener('change', function () {
            var v = openFileTarget.value;
            if (!isOpenFileTarget(v)) return;
            patchSettings({ openFileTarget: v });
        });
    }
    var searchPathDisplay = $('settings-search-path-display') as HTMLSelectElement | null;
    if (searchPathDisplay) {
        searchPathDisplay.addEventListener('change', function () {
            var v = searchPathDisplay.value;
            if (!isSearchPathDisplay(v)) return;
            patchSettings({ searchPathDisplay: v });
        });
    }
    var logLevel = $('settings-log-level') as HTMLSelectElement | null;
    if (logLevel) {
        logLevel.addEventListener('change', function () {
            var v = logLevel.value;
            if (!isLogLevel(v)) return;
            patchSettings({ logLevel: v });
        });
    }
}

export function initSettingsDialog(): void {
    var dlg = $('settings-dialog');
    if (dlg) bindTabs(dlg);
    configureSettingsTab({
        onActivate: function () { /* Region ist bereits sichtbar */ },
        onClose: closeSettingsDialog,
    });
    var closeBtn = $('settings-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSettingsDialog);
    bindInputs();
    initSettingsThemes({
        getSettings: getCachedSettings,
        patchSettings,
    });
    initSettingsAi();

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
        ev.listen('themes:changed', function () {
            handleSettingsThemesChanged();
        });
        ev.listen('menu:edit_settings', function () {
            openSettingsDialog();
        });
    }

    var invoke = getInvoke();
    if (invoke) {
        invoke('settings_get').then(function (data: any) {
            if (data && typeof data === 'object') {
                currentSettings = data as SettingsData;
                if (bootLanguage === null) bootLanguage = currentSettings.language;
                syncSettingsThemeState(currentSettings);
                applyLogLevelFromSettings(currentSettings.logLevel);
                applyViewTheme(currentSettings.viewTheme);
            }
        }).catch(function (err) {
            folioLog.warn('settings', 'settings_get on boot failed', { error: String(err) });
        });
    }
}
