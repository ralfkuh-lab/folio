import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';
import {
    closeSettingsDialog,
    initSettingsDialog,
    openSettingsDialog,
    syncLanguageSelect,
} from '../../app/ui/settings-dialog';
import { guardedClose } from '../../app/ui/theme-editor';

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
    openFileTarget: 'newtab',
    logLevel: 'info',
};

function buildDom(): void {
    document.body.className = '';
    document.body.innerHTML = `
        <nav id="tab-bar" hidden></nav>
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
                <select id="settings-language">
                    <option value="system">System</option>
                    <option value="de">Deutsch</option>
                    <option value="en">English</option>
                </select>
                <select id="settings-export-dir-mode">
                    <option value="document">Verzeichnis der Datei</option>
                    <option value="last">Zuletzt gewähltes Verzeichnis</option>
                </select>
                <select id="settings-open-file-target">
                    <option value="newtab">In neuem Tab öffnen</option>
                    <option value="replace">Aktuellen Tab ersetzen</option>
                </select>
            </div>
            <div role="tabpanel" data-settings-tab="diagnose" hidden>
                <select id="settings-log-level">
                    <option value="info">Normal</option>
                    <option value="debug">Debug</option>
                </select>
            </div>
            <div role="tabpanel" data-settings-tab="themes" hidden>
                <p id="settings-theme-error" hidden></p>
                <button id="settings-theme-import" type="button">Theme importieren…</button>
                <button id="settings-theme-create" type="button">Neues Theme</button>
                <div id="settings-theme-list" role="listbox"></div>
                <aside id="settings-theme-detail" tabindex="-1"></aside>
                <p id="settings-theme-hint"></p>
                <div id="theme-create-dialog" hidden>
                    <form id="theme-create-form">
                        <input id="theme-create-id" />
                        <input id="theme-create-name" />
                        <select id="theme-create-base"></select>
                        <p id="theme-create-error" hidden></p>
                        <button id="theme-create-cancel" type="button">Abbrechen</button>
                        <button id="theme-create-save" type="submit">Erstellen</button>
                    </form>
                </div>
                <div id="theme-delete-dialog" hidden>
                    <p id="theme-delete-text"></p>
                    <button id="theme-delete-cancel" type="button">Abbrechen</button>
                    <button id="theme-delete-confirm" type="button">Löschen</button>
                </div>
            </div>
            <button id="settings-close"></button>
        </div>
        <div id="theme-editor-dialog" hidden>
            <div id="theme-editor-mount"></div>
            <iframe id="theme-editor-preview"></iframe>
            <button id="theme-editor-save" disabled></button>
        </div>
    `;
}

function flush(): Promise<void> {
    return Promise.resolve().then(() => Promise.resolve());
}

describe('settings-dialog', () => {
    let handles: TauriMockHandles;
    let observedPreviews: Element[];
    let intersect: ((entries: Array<{ isIntersecting: boolean; target: Element }>) => void) | null;

    beforeEach(() => {
        closeSettingsDialog();
        handles = installTauriMock();
        observedPreviews = [];
        intersect = null;
        (window as any).IntersectionObserver = vi.fn(function (callback) {
            intersect = callback;
            return {
                observe: vi.fn((element: Element) => observedPreviews.push(element)),
                unobserve: vi.fn(),
                disconnect: vi.fn(),
            };
        });
        buildDom();
        (window as any).FolioThemeEditor = {
            mount: vi.fn().mockResolvedValue(undefined),
            setParts: vi.fn(),
            showPart: vi.fn().mockReturnValue(true),
            getPart: vi.fn(),
            getAllParts: vi.fn().mockReturnValue({ content: '.markdown-body {}' }),
            isDirty: vi.fn().mockReturnValue(false),
            onChange: vi.fn(),
            setTheme: vi.fn(),
            dispose: vi.fn(),
            layout: vi.fn(),
        };
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
            if (cmd === 'theme_clone') {
                return Promise.resolve({
                    id: args.newId,
                    name: 'Classic',
                    description: 'Serifen',
                    hasDark: false,
                    custom: true,
                });
            }
            if (cmd === 'theme_read') {
                return Promise.resolve({
                    manifest: {
                        name: 'Classic',
                        description: 'Serifen',
                        code: 'light',
                        logo: null,
                        cover: false,
                        header: false,
                        footer: false,
                        hideInlineFrontmatter: false,
                        fontBody: args?.id === 'meins' ? 'Inter, system-ui, sans-serif' : null,
                        fontMono: args?.id === 'meins' ? 'ui-monospace, monospace' : null,
                        fontSize: args?.id === 'meins' ? '15px' : null,
                        formatVersion: 1,
                    },
                    contentCss: '.markdown-body {}',
                    darkCss: null,
                    pageCss: null,
                    coverHtml: null,
                    headerHtml: null,
                    footerHtml: null,
                    assets: [],
                    source: 'directory',
                });
            }
            if (cmd === 'theme_write') {
                return Promise.resolve({
                    id: args.id,
                    name: args.files.manifest.name,
                    description: args.files.manifest.description,
                    hasDark: false,
                    custom: true,
                });
            }
            if (cmd === 'theme_delete') return Promise.resolve();
            if (cmd === 'theme_export') return Promise.resolve('/tmp/meins.mdtheme');
            if (cmd === 'theme_import') {
                return Promise.resolve({
                    id: 'importiert',
                    name: 'Importiert',
                    description: 'Aus Archiv',
                    hasDark: true,
                    custom: true,
                });
            }
            if (cmd === 'theme_preview_render') {
                return Promise.resolve('<html><body>Preview</body></html>');
            }
            if (cmd === 'theme_preview_saved') {
                return Promise.resolve(`<html><body>${args.themeId} Preview</body></html>`);
            }
            return Promise.resolve();
        });
        initSettingsDialog();
    });

    afterEach(async () => {
        await guardedClose();
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

    it('laedt und persistiert das Ziel fuer extern geoeffnete Dateien', async () => {
        openSettingsDialog();
        await flush();

        const select = document.getElementById(
            'settings-open-file-target',
        ) as HTMLSelectElement;
        expect(select.value).toBe('newtab');

        select.value = 'replace';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('settings_update', {
            patch: { openFileTarget: 'replace' },
        });
    });

    it('oeffnet als Vollflaechen-Region mit virtuellem Leisten-Tab', async () => {
        openSettingsDialog();
        await flush();

        expect(document.body.classList.contains('settings-open')).toBe(true);
        const settingsTab = document.querySelector('#tab-bar .tab-item.tab-settings');
        expect(settingsTab).not.toBeNull();
        expect(settingsTab!.getAttribute('aria-selected')).toBe('true');

        // X am virtuellen Tab schliesst die Region wieder.
        (settingsTab!.querySelector('.tab-close') as HTMLButtonElement).click();
        await flush();
        expect(document.body.classList.contains('settings-open')).toBe(false);
        expect(document.getElementById('settings-dialog')!.hidden).toBe(true);
        expect(document.querySelector('.tab-item.tab-settings')).toBeNull();
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

    it('rendert den Theme-Tab, Kartenklick oeffnet Detail und Verwenden persistiert', async () => {
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
        )!.getAttribute('aria-selected')).toBe('true');

        handles.invoke.mockClear();
        classic.click();
        await flush();
        await flush();

        expect(classic.classList.contains('selected')).toBe(true);
        expect(classic.getAttribute('aria-selected')).toBe('true');
        expect(document.getElementById('settings-theme-detail')!.textContent)
            .toContain('Classic');
        expect(handles.invoke).toHaveBeenCalledWith('theme_read', { id: 'classic' });
        expect(handles.invoke).not.toHaveBeenCalledWith('settings_update', {
            patch: { viewTheme: 'classic' },
        });

        document.getElementById('settings-theme-use')!.click();
        await flush();
        expect(handles.invoke).toHaveBeenCalledWith('settings_update', {
            patch: { viewTheme: 'classic' },
        });
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

    it('rendert Aktionen im Detail nach Theme-Quelle ohne Kartenauswahl', async () => {
        openSettingsDialog();
        await flush();

        expect(document.querySelectorAll(
            '#settings-theme-list > [data-view-theme="standard"] [data-theme-action]',
        )).toHaveLength(0);
        expect(document.querySelectorAll(
            '#settings-theme-list [data-theme-action]',
        )).toHaveLength(0);

        document.querySelector<HTMLElement>('[data-view-theme="classic"]')!.click();
        await flush();
        expect(Array.from(document.querySelectorAll(
            '#settings-theme-detail [data-theme-action]',
        )).map((element) => (element as HTMLElement).dataset.themeAction))
            .toEqual(['clone', 'export']);

        document.querySelector<HTMLElement>('[data-view-theme="meins"]')!.click();
        await flush();
        expect(Array.from(document.querySelectorAll(
            '#settings-theme-detail [data-theme-action]',
        )).map((element) => (element as HTMLElement).dataset.themeAction))
            .toEqual(['edit', 'clone', 'export', 'delete']);

        handles.invoke.mockClear();
        document.querySelector<HTMLButtonElement>(
            '#settings-theme-detail [data-theme-action="edit"]',
        )!.click();
        await flush();
        expect(handles.invoke).toHaveBeenCalledWith('theme_read', { id: 'meins' });
        expect(handles.invoke).not.toHaveBeenCalledWith('settings_update', {
            patch: { viewTheme: 'meins' },
        });

        await guardedClose();
        openSettingsDialog();
        await flush();
        document.querySelector<HTMLElement>('[data-view-theme="classic"]')!.click();
        await flush();
        handles.invoke.mockClear();
        document.querySelector<HTMLButtonElement>(
            '#settings-theme-detail [data-theme-action="clone"]',
        )!.click();
        expect(document.getElementById('theme-create-dialog')!.hidden).toBe(false);
        expect((document.getElementById('theme-create-base') as HTMLSelectElement).value)
            .toBe('classic');
        expect(document.querySelector(
            '#settings-theme-list > [data-view-theme="standard"]',
        )!
            .getAttribute('aria-selected')).toBe('false');
        expect(handles.invoke).not.toHaveBeenCalledWith('settings_update', {
            patch: { viewTheme: 'classic' },
        });
    });

    it('importiert und exportiert Themes ohne Kartenauswahl', async () => {
        openSettingsDialog();
        await flush();
        document.querySelector<HTMLElement>('[data-view-theme="classic"]')!.click();
        await flush();
        handles.invoke.mockClear();

        document.querySelector<HTMLButtonElement>(
            '#settings-theme-detail [data-theme-action="export"]',
        )!.click();
        await flush();
        expect(handles.invoke).toHaveBeenCalledWith('theme_export', { id: 'classic' });
        expect(handles.invoke).not.toHaveBeenCalledWith('settings_update', {
            patch: { viewTheme: 'classic' },
        });

        handles.invoke.mockClear();
        document.getElementById('settings-theme-import')!.click();
        await flush();
        await flush();
        expect(handles.invoke).toHaveBeenCalledWith('theme_import');
        expect(handles.invoke).toHaveBeenCalledWith('view_themes');
    });

    it('dupliziert ein Basis-Theme und schreibt den Anzeigenamen', async () => {
        openSettingsDialog();
        await flush();
        document.getElementById('settings-theme-create')!.click();
        (document.getElementById('theme-create-id') as HTMLInputElement).value = 'firma';
        (document.getElementById('theme-create-name') as HTMLInputElement).value = 'Firma';
        (document.getElementById('theme-create-base') as HTMLSelectElement).value = 'classic';

        handles.invoke.mockClear();
        document.getElementById('theme-create-form')!
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await flush();
        await flush();
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('theme_clone', {
            sourceId: 'classic',
            newId: 'firma',
        });
        expect(handles.invoke).toHaveBeenCalledWith('theme_read', { id: 'firma' });
        expect(handles.invoke).toHaveBeenCalledWith('theme_write', {
            id: 'firma',
            files: expect.objectContaining({
                manifest: expect.objectContaining({ name: 'Firma' }),
            }),
        });
        expect(handles.invoke).toHaveBeenCalledWith('view_themes');
        expect(document.getElementById('theme-create-dialog')!.hidden).toBe(true);
    });

    it('loescht Custom-Themes und aktualisiert bei themes:changed', async () => {
        openSettingsDialog();
        await flush();
        document.querySelector<HTMLElement>('[data-view-theme="meins"]')!.click();
        await flush();
        handles.invoke.mockClear();

        document.querySelector<HTMLButtonElement>(
            '#settings-theme-detail [data-theme-action="delete"]',
        )!.click();
        expect(document.getElementById('theme-delete-dialog')!.hidden).toBe(false);
        expect(document.getElementById('theme-delete-text')!.textContent)
            .toContain('Mein Theme');
        expect(handles.invoke).not.toHaveBeenCalledWith('theme_delete', { id: 'meins' });

        document.getElementById('theme-delete-confirm')!.click();
        await flush();
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('theme_delete', { id: 'meins' });
        expect(handles.invoke).toHaveBeenCalledWith('view_themes');
        expect(handles.invoke).not.toHaveBeenCalledWith('settings_update', {
            patch: { viewTheme: 'meins' },
        });

        handles.invoke.mockClear();
        handles.emitEvent('themes:changed', { id: 'firma', action: 'write' });
        await flush();
        expect(handles.invoke).toHaveBeenCalledWith('view_themes');
    });

    it('bearbeitet Name und Beschreibung im Theme-Detail', async () => {
        openSettingsDialog();
        await flush();
        document.querySelector<HTMLElement>('[data-view-theme="meins"]')!.click();
        await flush();

        document.getElementById('settings-theme-detail-edit-name')!.click();
        const name = document.getElementById(
            'settings-theme-detail-name-input',
        ) as HTMLInputElement;
        const description = document.getElementById(
            'settings-theme-detail-description-input',
        ) as HTMLInputElement;
        name.value = 'Mein Theme Neu';
        description.value = 'Neue Beschreibung';

        handles.invoke.mockClear();
        document.getElementById('settings-theme-detail-save-name')!.click();
        await flush();
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('theme_read', { id: 'meins' });
        expect(handles.invoke).toHaveBeenCalledWith('theme_write', {
            id: 'meins',
            files: expect.objectContaining({
                manifest: expect.objectContaining({
                    name: 'Mein Theme Neu',
                    description: 'Neue Beschreibung',
                }),
            }),
        });
    });

    it('zeigt gesetzte Fonts in der Theme-Detailansicht read-only an', async () => {
        openSettingsDialog();
        await flush();
        document.querySelector<HTMLElement>('[data-view-theme="meins"]')!.click();
        await flush();

        const detail = document.getElementById('settings-theme-detail')!;
        expect(detail.textContent).toContain('Body: Inter, system-ui, sans-serif');
        expect(detail.textContent).toContain('Mono: ui-monospace, monospace');
        expect(detail.textContent).toContain('Größe: 15px');
        expect(document.getElementById('settings-theme-detail-name-input')).toBeNull();
    });

    it('laedt Karten-Previews lazy per IntersectionObserver', async () => {
        openSettingsDialog();
        await flush();
        expect(observedPreviews.length).toBeGreaterThan(0);
        const classicFrame = document.querySelector<HTMLIFrameElement>(
            '[data-view-theme="classic"] .settings-theme-card__preview iframe',
        )!;

        handles.invoke.mockClear();
        intersect?.([{ isIntersecting: true, target: classicFrame }]);
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('theme_preview_saved', {
            themeId: 'classic',
            dark: false,
        });
        expect(classicFrame.srcdoc).toContain('classic Preview');
    });

    it('navigiert mit wiederholtem ArrowDown ab der fokussierten Karte weiter', async () => {
        openSettingsDialog();
        await flush();
        document.getElementById('settings-tab-themes')!.click();
        const cards = Array.from(
            document.querySelectorAll<HTMLElement>('#settings-theme-list [data-view-theme]'),
        );
        const selectedIndex = cards.findIndex((card) =>
            card.getAttribute('aria-selected') === 'true',
        );
        const first = cards[(selectedIndex + 1) % cards.length];
        const second = cards[(selectedIndex + 2) % cards.length];
        const selected = cards[selectedIndex];

        selected.focus();
        selected.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
        }));
        expect(document.activeElement).toBe(first);
        first.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
        }));
        expect(document.activeElement).toBe(second);
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


describe('settings language select (i18n I1a/I2)', () => {
    const LANG_STRINGS = {
        'settings.language.system': 'System',
        'settings.language.hint': 'Sprachänderung wird beim nächsten Start aktiv.',
        'settings.language.unknown': '{tag} (unbekannt)',
        'settings.language.unknownHint':
            'Unbekannte Sprache „{tag}“ — folio verwendet Englisch.',
    };

    async function resetI18n(): Promise<void> {
        const { __resetI18nForTests } = await import('../../app/i18n/translate');
        __resetI18nForTests();
    }

    async function seedLangCatalog(
        languages: { tag: string; name: string }[] = [
            { tag: 'de', name: 'Deutsch' },
            { tag: 'en', name: 'English' },
        ],
    ): Promise<void> {
        const { seedCatalog } = await import('../../app/i18n/translate');
        seedCatalog({
            tag: 'de',
            locale: 'de-DE',
            languages,
            strings: LANG_STRINGS,
        });
    }

    /** Echtes I2-Markup: leeres Select + Hint-Paragraph. */
    function emptyI2Markup(): { sel: HTMLSelectElement; hint: HTMLElement } {
        document.body.innerHTML = `
            <select id="settings-language" class="settings-input">
              <!-- Options filled from i18n registry (System + native names) -->
            </select>
            <p class="settings-hint" id="settings-language-hint">Sprachänderung wird beim nächsten Start aktiv.</p>`;
        return {
            sel: document.getElementById('settings-language') as HTMLSelectElement,
            hint: document.getElementById('settings-language-hint') as HTMLElement,
        };
    }

    afterEach(async () => {
        await resetI18n();
    });

    it('F1: degradation (getCatalog===null) builds DE minimal fallback on empty I2 markup', async () => {
        await resetI18n();
        const { getCatalog } = await import('../../app/i18n/translate');
        expect(getCatalog()).toBeNull();
        const { populateLanguageOptions } = await import('../../app/ui/settings-dialog');
        const { sel } = emptyI2Markup();
        expect(sel.options.length).toBe(0);
        populateLanguageOptions(sel);
        expect(sel.options.length).toBe(3);
        expect(Array.from(sel.options).map((o) => o.value)).toEqual(['system', 'de', 'en']);
        expect(sel.options[0].textContent).toBe('System');
        expect(sel.options[1].textContent).toBe('Deutsch');
        expect(sel.options[2].textContent).toBe('English');
        // system und de wählbar
        sel.value = 'system';
        expect(sel.value).toBe('system');
        sel.value = 'de';
        expect(sel.value).toBe('de');
        expect(sel.selectedOptions[0].disabled).toBe(false);
    });

    it('F6: catalog ok + system', async () => {
        await seedLangCatalog();
        const { populateLanguageOptions } = await import('../../app/ui/settings-dialog');
        const { sel, hint } = emptyI2Markup();
        populateLanguageOptions(sel);
        const unknown = syncLanguageSelect(sel, 'system', hint);
        expect(unknown).toBe(false);
        expect(sel.value).toBe('system');
        expect(sel.selectedOptions[0].textContent).toBe('System');
        expect(hint.textContent).toBe(LANG_STRINGS['settings.language.hint']);
    });

    it('F6: known registry tag value roundtrip', async () => {
        await seedLangCatalog();
        const { populateLanguageOptions } = await import('../../app/ui/settings-dialog');
        const { sel, hint } = emptyI2Markup();
        populateLanguageOptions(sel);
        syncLanguageSelect(sel, 'en', hint);
        expect(sel.value).toBe('en');
        expect(sel.selectedOptions[0].textContent).toBe('English');
        expect(sel.selectedOptions[0].disabled).toBe(false);
        // second set still works
        syncLanguageSelect(sel, 'de', hint);
        expect(sel.value).toBe('de');
        expect(hint.textContent).toBe(LANG_STRINGS['settings.language.hint']);
    });

    it('F6: empty languages array still keeps System', async () => {
        await seedLangCatalog([]);
        const { populateLanguageOptions } = await import('../../app/ui/settings-dialog');
        const { sel } = emptyI2Markup();
        populateLanguageOptions(sel);
        expect(Array.from(sel.options).map((o) => o.value)).toEqual(['system']);
        expect(sel.options[0].textContent).toBe('System');
        syncLanguageSelect(sel, 'system');
        expect(sel.value).toBe('system');
    });

    it('F6: double populate has no duplicate options', async () => {
        await seedLangCatalog();
        const { populateLanguageOptions } = await import('../../app/ui/settings-dialog');
        const { sel } = emptyI2Markup();
        populateLanguageOptions(sel);
        populateLanguageOptions(sel);
        const values = Array.from(sel.options).map((o) => o.value);
        expect(values).toEqual(['system', 'de', 'en']);
        expect(new Set(values).size).toBe(values.length);
    });

    it('F2/F6: unknown tag — disabled option + value + unknownHint', async () => {
        await seedLangCatalog();
        const { populateLanguageOptions } = await import('../../app/ui/settings-dialog');
        const { sel, hint } = emptyI2Markup();
        populateLanguageOptions(sel);
        const unknown = syncLanguageSelect(sel, 'xx-YY', hint);
        expect(unknown).toBe(true);
        const opt = sel.querySelector('option[data-unknown-lang]') as HTMLOptionElement;
        expect(opt).toBeTruthy();
        expect(opt.disabled).toBe(true);
        expect(sel.value).toBe('xx-YY');
        expect(opt.textContent).toBe('xx-YY (unbekannt)');
        expect(hint.textContent).toBe(
            'Unbekannte Sprache „xx-YY“ — folio verwendet Englisch.',
        );
        // zurück auf bekannt → Neustart-Hinweis
        syncLanguageSelect(sel, 'de', hint);
        expect(sel.querySelector('option[data-unknown-lang]')).toBeNull();
        expect(hint.textContent).toBe(LANG_STRINGS['settings.language.hint']);
    });
});
