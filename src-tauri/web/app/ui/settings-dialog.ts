/* Settings-Dialog: bietet die Phase-1-Praeferenzen an
   (Sprache, Default-Mode pro Datei-Kind, View-Auto-Format). Persistenz
   und Validierung passieren im Backend (settings.rs, settings_get,
   settings_update); dieses Modul ist reine UI-Bindings + Patch-Dispatch.

   Sprachwechsel wirkt absichtlich erst beim naechsten Start: Codex-
   Review hat aufgezeigt, dass ein Live-Menue-Rebuild den vom Frontend
   nachgepflegten checked/enabled-State (Theme-Haekchen, Mode, Save-
   Enabled etc.) verliert. Konservativer Phase-1-Schnitt: persistieren
   und beim Boot via menu::build anwenden. */

type SettingsLanguage = 'de' | 'en';
export type DefaultViewMode = 'view' | 'edit' | 'current';

export type SettingsData = {
    language: SettingsLanguage;
    defaultModeMarkdown: DefaultViewMode;
    defaultModeText: DefaultViewMode;
    viewAutoFormat: boolean;
    vaultAutoRefresh: boolean;
    documentAutoReload: boolean;
};

function isViewMode(v: string): v is DefaultViewMode {
    return v === 'view' || v === 'edit' || v === 'current';
}

let currentSettings: SettingsData | null = null;
let bootLanguage: SettingsLanguage | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

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
    var langHint = $('settings-language-hint');

    if (langSelect) langSelect.value = data.language;
    if (mdSelect) mdSelect.value = data.defaultModeMarkdown;
    if (textSelect) textSelect.value = data.defaultModeText;
    if (autoFormat) autoFormat.checked = !!data.viewAutoFormat;
    if (vaultRefresh) vaultRefresh.checked = !!data.vaultAutoRefresh;
    if (docReload) docReload.checked = !!data.documentAutoReload;

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

async function patchSettings(patch: Partial<SettingsData>): Promise<void> {
    var invoke = getInvoke();
    if (!invoke) return;
    try {
        var data = await invoke('settings_update', { patch });
        if (data && typeof data === 'object') {
            currentSettings = data as SettingsData;
            applySettingsToForm(currentSettings);
        }
    } catch (err) {
        console.error('settings_update failed', err);
    }
}

export function openSettingsDialog(): void {
    var dlg = $('settings-dialog');
    if (!dlg) return;
    var invoke = getInvoke();
    if (!invoke) {
        dlg.hidden = false;
        return;
    }
    invoke('settings_get').then(function (data: any) {
        if (!data || typeof data !== 'object') return;
        currentSettings = data as SettingsData;
        if (bootLanguage === null) bootLanguage = currentSettings.language;
        applySettingsToForm(currentSettings);
        dlg.hidden = false;
        setTimeout(function () {
            var btn = $('settings-close') as HTMLButtonElement | null;
            if (btn) btn.focus();
        }, 0);
    }).catch(function (err) {
        console.error('settings_get failed', err);
    });

    if (!keydownHandler) {
        keydownHandler = function (e: KeyboardEvent) {
            if (e.key === 'Escape' || e.key === 'Enter') {
                e.preventDefault();
                closeSettingsDialog();
            }
        };
        document.addEventListener('keydown', keydownHandler);
    }
}

export function closeSettingsDialog(): void {
    var dlg = $('settings-dialog');
    if (!dlg || dlg.hidden) return;
    dlg.hidden = true;
    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
    }
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
}

export function initSettingsDialog(): void {
    var dlg = $('settings-dialog');
    if (dlg) {
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
            }
        }).catch(function () {});
    }
}
