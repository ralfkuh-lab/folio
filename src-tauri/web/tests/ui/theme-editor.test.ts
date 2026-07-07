import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';

vi.mock('../../app/state/document', () => ({
    getCleanText: vi.fn().mockReturnValue('# Aktuelles Dokument'),
    getCurrentPath: vi.fn().mockReturnValue('/tmp/doc.md'),
}));

type SurfaceHarness = {
    surface: any;
    setDirty(value: boolean): void;
    emitChange(): void;
};

function buildDom(): void {
    document.body.className = '';
    document.body.innerHTML = `
        <nav id="tab-bar" hidden></nav>
        <div id="theme-editor-dialog" hidden>
            <select id="theme-editor-part"></select>
            <input id="theme-editor-dark" type="checkbox" />
            <button id="theme-editor-save" disabled>Speichern</button>
            <button id="theme-editor-close">Schließen</button>
            <div id="theme-editor-mount"></div>
            <div id="theme-editor-assets" class="theme-editor-assets">
                <div class="theme-editor-assets__head"><strong>Manifest</strong></div>
                <div class="theme-editor-manifest-fields">
                    <label for="theme-editor-manifest-name">Name</label>
                    <input id="theme-editor-manifest-name" />
                    <label for="theme-editor-manifest-description">Beschreibung</label>
                    <input id="theme-editor-manifest-description" />
                </div>
                <div class="theme-editor-flags">
                    <label><input type="checkbox" id="theme-editor-flag-cover" /> Cover</label>
                    <label><input type="checkbox" id="theme-editor-flag-header" /> Kopfzeile</label>
                    <label><input type="checkbox" id="theme-editor-flag-footer" /> Fußzeile</label>
                    <label><input type="checkbox" id="theme-editor-flag-hide-fm" /> Frontmatter verbergen</label>
                </div>
                <div class="theme-editor-assets__head">
                    <strong>Assets</strong>
                    <label class="theme-editor-assets__upload">
                        <input type="file" id="theme-editor-logo-input" accept="image/*" />
                        <span>＋ Hochladen</span>
                    </label>
                </div>
                <ul id="theme-editor-asset-list" class="theme-editor-assets__list"></ul>
                <p id="theme-editor-asset-error" hidden></p>
                <p class="theme-editor-assets__hint">
                    Logo: <code id="theme-editor-logo-name">(kein)</code>
                    <button type="button" id="theme-editor-logo-clear" class="link-button">zurücksetzen</button>
                </p>
            </div>
            <iframe id="theme-editor-preview"></iframe>
        </div>
        <div id="unsaved-dialog" hidden>
            <button id="unsaved-save">Speichern</button>
            <button id="unsaved-discard">Verwerfen</button>
            <button id="unsaved-cancel">Abbrechen</button>
        </div>
    `;
}

function installSurface(): SurfaceHarness {
    let dirty = false;
    let parts: Record<string, string> = {};
    let change: (() => void) | null = null;
    const surface = {
        mount: vi.fn().mockResolvedValue(undefined),
        setParts: vi.fn((next: Record<string, string>) => {
            parts = { ...next };
            dirty = false;
        }),
        showPart: vi.fn().mockReturnValue(true),
        getPart: vi.fn((part: string) => parts[part] ?? null),
        getAllParts: vi.fn(() => ({ ...parts })),
        isDirty: vi.fn(() => dirty),
        onChange: vi.fn((handler: () => void) => { change = handler; }),
        setTheme: vi.fn(),
        dispose: vi.fn(),
        layout: vi.fn(),
    };
    (window as any).FolioThemeEditor = surface;
    return {
        surface,
        setDirty(value: boolean) { dirty = value; },
        emitChange() { change?.(); },
    };
}

function themeFiles() {
    return {
        manifest: {
            name: 'Firma',
            description: 'Corporate',
            code: 'light',
            logo: null,
            cover: true,
            header: false,
            footer: false,
            hideInlineFrontmatter: false,
            formatVersion: 1,
        },
        contentCss: '.markdown-body { color: blue; }',
        darkCss: '.markdown-body { color: white; }',
        pageCss: null,
        coverHtml: '<section>Cover</section>',
        headerHtml: null,
        footerHtml: null,
        assets: [],
        source: 'directory',
    };
}

describe('ui/theme-editor', () => {
    let tauri: TauriMockHandles;
    let harness: SurfaceHarness;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        buildDom();
        tauri = installTauriMock();
        harness = installSurface();
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'theme_read') return Promise.resolve(themeFiles());
            if (command === 'theme_preview_render') {
                return Promise.resolve('<html><body>Vorschau</body></html>');
            }
            if (command === 'theme_write') {
                return Promise.resolve({
                    id: 'firma',
                    name: 'Firma',
                    description: 'Corporate',
                    hasDark: true,
                    custom: true,
                });
            }
            return Promise.resolve(undefined);
        });
    });

    it('loads parts, registers the virtual tab and renders a preview', async () => {
        const { initThemeEditor, openThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();

        expect(await openThemeEditor('firma')).toBe(true);

        expect(tauri.invoke).toHaveBeenCalledWith('theme_read', { id: 'firma' });
        expect(harness.surface.setParts).toHaveBeenCalledWith({
            content: '.markdown-body { color: blue; }',
            dark: '.markdown-body { color: white; }',
            cover: '<section>Cover</section>',
        });
        expect(Array.from(
            (document.getElementById('theme-editor-part') as HTMLSelectElement).options,
        ).map((option) => option.value)).toEqual(['content', 'dark', 'cover']);
        expect(document.querySelector('.tab-theme-editor .tab-title')!.textContent)
            .toContain('Firma');
        expect((document.getElementById('theme-editor-manifest-name') as HTMLInputElement).value)
            .toBe('Firma');
        expect((document.getElementById(
            'theme-editor-manifest-description',
        ) as HTMLInputElement).value).toBe('Corporate');
        expect(document.body.classList.contains('theme-editor-open')).toBe(true);
        expect(tauri.invoke).toHaveBeenCalledWith(
            'theme_preview_render',
            expect.objectContaining({
                markdown: '# Aktuelles Dokument',
                dark: false,
            }),
        );
        expect((document.getElementById('theme-editor-preview') as HTMLIFrameElement).srcdoc)
            .toContain('Vorschau');
    });

    it('enables save on change and resets dirty state after write', async () => {
        const { initThemeEditor, openThemeEditor, saveThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        await openThemeEditor('firma');
        harness.setDirty(true);
        harness.emitChange();

        expect((document.getElementById('theme-editor-save') as HTMLButtonElement).disabled)
            .toBe(false);
        expect(document.querySelector('.tab-theme-editor .tab-dirty')).not.toBeNull();

        expect(await saveThemeEditor()).toBe(true);
        expect(tauri.invoke).toHaveBeenCalledWith('theme_write', {
            id: 'firma',
            files: expect.objectContaining({
                contentCss: '.markdown-body { color: blue; }',
                darkCss: '.markdown-body { color: white; }',
            }),
        });
        expect((document.getElementById('theme-editor-save') as HTMLButtonElement).disabled)
            .toBe(true);
    });

    it('guards Escape close and keeps the editor open on cancel', async () => {
        const { initThemeEditor, openThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        await openThemeEditor('firma');
        harness.setDirty(true);
        harness.emitChange();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.getElementById('unsaved-dialog')!.hidden).toBe(false);
        document.getElementById('unsaved-cancel')!.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(document.getElementById('theme-editor-dialog')!.hidden).toBe(false);
        expect(document.querySelector('.tab-theme-editor')).not.toBeNull();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.getElementById('unsaved-dialog')!.hidden).toBe(false);
        document.getElementById('unsaved-discard')!.click();
        await vi.waitFor(() => {
            expect(document.getElementById('theme-editor-dialog')!.hidden).toBe(true);
            expect(document.querySelector('.tab-theme-editor')).toBeNull();
        });
        expect(harness.surface.dispose).toHaveBeenCalled();
    });

    it('syncs manifest flags and toggling cover adds the part to the editor', async () => {
        const { initThemeEditor, openThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        await openThemeEditor('firma');

        const cover = document.getElementById('theme-editor-flag-cover') as HTMLInputElement;
        const header = document.getElementById('theme-editor-flag-header') as HTMLInputElement;
        expect(cover.checked).toBe(true);
        expect(header.checked).toBe(false);
        const initialOptionsCount = (document.getElementById('theme-editor-part') as HTMLSelectElement).options.length;

        header.checked = true;
        header.dispatchEvent(new Event('change'));

        expect(harness.surface.setParts).toHaveBeenCalledWith(expect.objectContaining({
            content: '.markdown-body { color: blue; }',
            header: '',
        }));
        const afterOptionsCount = (document.getElementById('theme-editor-part') as HTMLSelectElement).options.length;
        expect(afterOptionsCount).toBe(initialOptionsCount + 1);
        expect((document.getElementById('theme-editor-save') as HTMLButtonElement).disabled)
            .toBe(false);
        expect(document.querySelector('.tab-theme-editor .tab-dirty')).not.toBeNull();

        const { saveThemeEditor } = await import('../../app/ui/theme-editor');
        expect(await saveThemeEditor()).toBe(true);
        expect((document.getElementById('theme-editor-save') as HTMLButtonElement).disabled)
            .toBe(true);
    });

    it('refreshes clean manifest text fields after external theme changes', async () => {
        const { initThemeEditor, openThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        const initial = themeFiles();
        const changed = themeFiles();
        changed.manifest.name = 'Firma Neu';
        changed.manifest.description = 'Extern geändert';
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'theme_read') {
                return Promise.resolve(
                    tauri.invoke.mock.calls.filter(([cmd]) => cmd === 'theme_read').length <= 1
                        ? initial
                        : changed,
                );
            }
            if (command === 'theme_preview_render') return Promise.resolve('<html></html>');
            return Promise.resolve(undefined);
        });

        await openThemeEditor('firma');
        const setPartsCalls = harness.surface.setParts.mock.calls.length;
        tauri.emitEvent('themes:changed', { id: 'firma', action: 'write' });

        await vi.waitFor(() => {
            expect((document.getElementById(
                'theme-editor-manifest-name',
            ) as HTMLInputElement).value).toBe('Firma Neu');
            expect((document.getElementById(
                'theme-editor-manifest-description',
            ) as HTMLInputElement).value).toBe('Extern geändert');
        });
        expect(document.querySelector('.tab-theme-editor .tab-title')!.textContent)
            .toContain('Firma Neu');
        expect(harness.surface.setParts.mock.calls.length).toBe(setPartsCalls);
    });

    it('uploads an asset, appends it to the list and preselects as logo', async () => {
        const { initThemeEditor, openThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        tauri.invoke.mockImplementation((command: string, args: any) => {
            if (command === 'theme_read') return Promise.resolve(themeFiles());
            if (command === 'theme_preview_render') return Promise.resolve('<html></html>');
            if (command === 'theme_asset_add') {
                return Promise.resolve({
                    filename: args.filename,
                    size: 12,
                    mime: 'image/png',
                });
            }
            return Promise.resolve(undefined);
        });
        await openThemeEditor('firma');

        const input = document.getElementById('theme-editor-logo-input') as HTMLInputElement;
        const file = new File([new Uint8Array([1, 2, 3, 4])], 'logo.png', { type: 'image/png' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('theme_asset_add', expect.objectContaining({
                id: 'firma',
                filename: 'logo.png',
            }));
        });
        await vi.waitFor(() => {
            const list = document.getElementById('theme-editor-asset-list')!;
            expect(list.querySelectorAll('li').length).toBe(1);
            expect(list.querySelector('li.is-logo')).not.toBeNull();
            expect((document.getElementById('theme-editor-logo-name') as HTMLElement).textContent)
                .toBe('logo.png');
            expect((document.getElementById('theme-editor-save') as HTMLButtonElement).disabled)
                .toBe(false);
        });
    });

    it('removes an asset via the remove button and clears logo if matched', async () => {
        const { initThemeEditor, openThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        const baseFiles = themeFiles();
        baseFiles.assets = [
            { filename: 'logo.png', size: 12, mime: 'image/png' },
            { filename: 'watermark.svg', size: 200, mime: 'image/svg+xml' },
        ];
        baseFiles.manifest.logo = 'logo.png';
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'theme_read') return Promise.resolve(baseFiles);
            if (command === 'theme_preview_render') return Promise.resolve('<html></html>');
            return Promise.resolve(undefined);
        });
        await openThemeEditor('firma');

        const list = document.getElementById('theme-editor-asset-list')!;
        expect(list.querySelectorAll('li').length).toBe(2);
        const removeLogo = list.querySelector('li.is-logo .theme-editor-assets__remove') as HTMLButtonElement;
        removeLogo.click();
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('theme_asset_remove', {
                id: 'firma',
                filename: 'logo.png',
            });
        });
        await vi.waitFor(() => {
            expect(document.getElementById('theme-editor-asset-list')!.querySelectorAll('li').length).toBe(1);
            expect((document.getElementById('theme-editor-logo-name') as HTMLElement).textContent)
                .toBe('(kein)');
            expect((document.getElementById('theme-editor-save') as HTMLButtonElement).disabled)
                .toBe(false);
        });
    });

    it('clears the manifest logo via the reset button only', async () => {
        const { initThemeEditor, openThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        const baseFiles = themeFiles();
        baseFiles.assets = [{ filename: 'logo.png', size: 12, mime: 'image/png' }];
        baseFiles.manifest.logo = 'logo.png';
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'theme_read') return Promise.resolve(baseFiles);
            if (command === 'theme_preview_render') return Promise.resolve('<html></html>');
            return Promise.resolve(undefined);
        });
        await openThemeEditor('firma');

        document.getElementById('theme-editor-logo-clear')!.click();
        expect((document.getElementById('theme-editor-logo-name') as HTMLElement).textContent)
            .toBe('(kein)');
        expect(document.getElementById('theme-editor-asset-list')!.querySelectorAll('li').length)
            .toBe(1);
        expect((document.getElementById('theme-editor-save') as HTMLButtonElement).disabled)
            .toBe(false);
    });

    it('keeps manifest and null draft parts unchanged when AI omits them', async () => {
        const { initThemeEditor, openThemeEditor, applyThemeDraft, saveThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        const baseFiles = themeFiles();
        baseFiles.manifest.logo = 'logo.png';
        baseFiles.assets = [{ filename: 'logo.png', size: 12, mime: 'image/png' }];
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'theme_read') return Promise.resolve(baseFiles);
            if (command === 'theme_preview_render') return Promise.resolve('<html></html>');
            return Promise.resolve(undefined);
        });
        await openThemeEditor('firma');

        applyThemeDraft({
            contentCss: '.markdown-body { color: green; }',
            manifest: null,
            darkCss: null,
            pageCss: null,
            coverHtml: null,
            headerHtml: null,
            footerHtml: null,
        });

        expect(harness.surface.setParts).toHaveBeenLastCalledWith({
            content: '.markdown-body { color: green; }',
            dark: '.markdown-body { color: white; }',
            cover: '<section>Cover</section>',
        }, {
            content: '.markdown-body { color: blue; }',
            dark: '.markdown-body { color: white; }',
            cover: '<section>Cover</section>',
        });

        expect(await saveThemeEditor()).toBe(true);
        expect(tauri.invoke).toHaveBeenCalledWith('theme_write', {
            id: 'firma',
            files: expect.objectContaining({
                manifest: expect.objectContaining({
                    name: 'Firma',
                    logo: 'logo.png',
                    cover: true,
                }),
                contentCss: '.markdown-body { color: green; }',
                darkCss: '.markdown-body { color: white; }',
                coverHtml: '<section>Cover</section>',
            }),
        });
    });

    it('guards manifest-only changes when closing', async () => {
        const { initThemeEditor, openThemeEditor, guardedClose } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        await openThemeEditor('firma');

        const hideFm = document.getElementById('theme-editor-flag-hide-fm') as HTMLInputElement;
        hideFm.checked = true;
        hideFm.dispatchEvent(new Event('change'));

        const closing = guardedClose();
        expect(document.getElementById('unsaved-dialog')!.hidden).toBe(false);
        document.getElementById('unsaved-cancel')!.click();
        await expect(closing).resolves.toBe(false);
        expect(document.getElementById('theme-editor-dialog')!.hidden).toBe(false);
    });

    it('rejects assets over 5 MB before FileReader runs', async () => {
        const { initThemeEditor, openThemeEditor } =
            await import('../../app/ui/theme-editor');
        initThemeEditor();
        await openThemeEditor('firma');
        const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL');

        const input = document.getElementById('theme-editor-logo-input') as HTMLInputElement;
        const file = new File(
            [new Uint8Array(5 * 1024 * 1024 + 1)],
            'too-large.png',
            { type: 'image/png' },
        );
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));

        expect(readSpy).not.toHaveBeenCalled();
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'theme_asset_add',
            expect.anything(),
        );
        const error = document.getElementById('theme-editor-asset-error')!;
        expect(error.hidden).toBe(false);
        expect(error.textContent).toContain('5 MB');
    });
});
