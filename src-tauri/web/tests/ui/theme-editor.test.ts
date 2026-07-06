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
});
