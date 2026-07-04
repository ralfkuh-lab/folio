import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';
import {
    closeSettingsDialog,
    initSettingsDialog,
    openSettingsDialog,
} from '../../app/ui/settings-dialog';

const settings = {
    language: 'de',
    defaultModeMarkdown: 'current',
    defaultModeText: 'current',
    viewAutoFormat: true,
    viewTheme: 'standard',
    themeFavorites: [],
    vaultAutoRefresh: true,
    documentAutoReload: true,
    exportDirMode: 'document',
    logLevel: 'info',
};

function buildDom(): void {
    document.body.innerHTML = `
        <div id="settings-dialog" hidden>
            <div role="tablist" aria-orientation="vertical">
                <button type="button" id="settings-tab-allgemein"
                    class="settings-dialog__tab settings-dialog__tab--active"
                    role="tab" aria-selected="true">Allgemein</button>
                <button type="button" id="settings-tab-diagnose"
                    class="settings-dialog__tab"
                    role="tab" aria-selected="false" tabindex="-1">Diagnose</button>
                <button type="button" id="settings-tab-themes"
                    class="settings-dialog__tab"
                    role="tab" aria-selected="false" tabindex="-1">Markdown-Themes</button>
            </div>
            <div role="tabpanel" data-settings-tab="allgemein">
                <select id="settings-export-dir-mode">
                    <option value="document">Verzeichnis der Datei</option>
                    <option value="last">Zuletzt gewähltes Verzeichnis</option>
                </select>
            </div>
            <div role="tabpanel" data-settings-tab="diagnose" hidden>
                <select id="settings-log-level">
                    <option value="info">Normal</option>
                    <option value="debug">Debug</option>
                </select>
            </div>
            <div role="tabpanel" data-settings-tab="themes" hidden>
                <div id="settings-theme-list" role="radiogroup"></div>
                <p id="settings-theme-hint"></p>
            </div>
            <button id="settings-close"></button>
        </div>
    `;
}

function flush(): Promise<void> {
    return Promise.resolve().then(() => Promise.resolve());
}

describe('settings-dialog', () => {
    let handles: TauriMockHandles;

    beforeEach(() => {
        closeSettingsDialog();
        handles = installTauriMock();
        buildDom();
        handles.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'settings_get') return Promise.resolve(settings);
            if (cmd === 'view_themes') {
                return Promise.resolve([
                    {
                        id: 'standard',
                        name: 'Standard',
                        description: 'Folio',
                        hasDark: true,
                        custom: false,
                    },
                    {
                        id: 'classic',
                        name: 'Classic',
                        description: 'Serifen',
                        hasDark: false,
                        custom: false,
                    },
                    {
                        id: 'meins',
                        name: 'Mein Theme',
                        description: 'Eigene Farben',
                        hasDark: true,
                        custom: true,
                    },
                ]);
            }
            if (cmd === 'themes_dir_path') {
                return Promise.resolve('/home/test/.config/folio/themes');
            }
            if (cmd === 'view_theme_css') return Promise.resolve('');
            if (cmd === 'settings_update') {
                return Promise.resolve({ ...settings, ...args.patch });
            }
            return Promise.resolve();
        });
        initSettingsDialog();
    });

    afterEach(() => {
        closeSettingsDialog();
    });

    it('lädt den Default und persistiert den ausgewählten Modus', async () => {
        openSettingsDialog();
        await flush();

        const select = document.getElementById(
            'settings-export-dir-mode',
        ) as HTMLSelectElement;
        expect(select.value).toBe('document');

        select.value = 'last';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('settings_update', {
            patch: { exportDirMode: 'last' },
        });
        expect(select.value).toBe('last');
    });

    it('wechselt per Klick vom Allgemein- zum Diagnose-Panel', async () => {
        openSettingsDialog();
        await flush();

        const allgemeinTab = document.getElementById('settings-tab-allgemein')!;
        const diagnoseTab = document.getElementById('settings-tab-diagnose')!;
        const allgemeinPanel = document.querySelector<HTMLElement>(
            '[data-settings-tab="allgemein"]',
        )!;
        const diagnosePanel = document.querySelector<HTMLElement>(
            '[data-settings-tab="diagnose"]',
        )!;

        diagnoseTab.click();

        expect(diagnoseTab.getAttribute('aria-selected')).toBe('true');
        expect(diagnoseTab.classList.contains('settings-dialog__tab--active')).toBe(true);
        expect(allgemeinTab.getAttribute('aria-selected')).toBe('false');
        expect(allgemeinPanel.hidden).toBe(true);
        expect(diagnosePanel.hidden).toBe(false);
    });

    it('rendert den Theme-Tab und persistiert die Auswahl', async () => {
        openSettingsDialog();
        await flush();
        document.getElementById('settings-tab-themes')!.click();

        const classic = document.querySelector<HTMLElement>(
            '[data-view-theme="classic"]',
        )!;
        expect(classic.textContent).toContain('Classic');
        expect(classic.textContent).toContain('Nur hell');
        const custom = document.querySelector<HTMLElement>(
            '[data-view-theme="meins"]',
        )!;
        expect(custom.textContent).toContain('Eigenes Theme');
        expect(custom.textContent).toContain('Hell/Dunkel');
        expect(document.getElementById('settings-theme-hint')!.textContent)
            .toContain('/home/test/.config/folio/themes');
        expect(document.querySelector<HTMLElement>(
            '#settings-theme-list [data-view-theme="standard"]',
        )!.getAttribute('aria-checked')).toBe('true');

        classic.click();
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('settings_update', {
            patch: { viewTheme: 'classic' },
        });
        expect(classic.classList.contains('selected')).toBe(true);
        expect(classic.getAttribute('aria-checked')).toBe('true');
    });

    it('rendert Favoriten-Sterne und toggelt nur die Favoritenliste', async () => {
        openSettingsDialog();
        await flush();

        expect(document.querySelector('[data-view-theme-fav="standard"]')).toBeNull();
        expect(document.querySelectorAll('[data-view-theme-fav]')).toHaveLength(2);

        handles.invoke.mockClear();
        const favorite = document.querySelector<HTMLButtonElement>(
            '[data-view-theme-fav="classic"]',
        )!;
        favorite.click();
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('settings_update', {
            patch: { themeFavorites: ['classic'] },
        });
        expect(handles.invoke).not.toHaveBeenCalledWith('settings_update', {
            patch: { viewTheme: 'classic' },
        });
        expect(document.querySelector('#settings-theme-list [data-view-theme="standard"]')!
            .getAttribute('aria-checked')).toBe('true');
        expect(favorite.getAttribute('aria-pressed')).toBe('true');
        expect(favorite.getAttribute('aria-label')).toBe('Favorit entfernen');
        expect(favorite.textContent).toBe('★');

        handles.emitEvent('settings:changed', {
            settings: { ...settings, themeFavorites: [] },
            changed: ['themeFavorites'],
        });
        expect(favorite.getAttribute('aria-pressed')).toBe('false');
        expect(favorite.textContent).toBe('☆');
    });

    it('setzt beim erneuten Öffnen auf Allgemein zurück', async () => {
        openSettingsDialog();
        await flush();
        document.getElementById('settings-tab-diagnose')!.click();
        document.getElementById('settings-close')!.click();

        openSettingsDialog();
        await flush();

        expect(document.getElementById('settings-tab-allgemein')!
            .getAttribute('aria-selected')).toBe('true');
        expect(document.querySelector<HTMLElement>(
            '[data-settings-tab="allgemein"]',
        )!.hidden).toBe(false);
        expect(document.querySelector<HTMLElement>(
            '[data-settings-tab="diagnose"]',
        )!.hidden).toBe(true);
    });
});
