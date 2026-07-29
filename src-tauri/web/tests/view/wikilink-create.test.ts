import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';
import {
    documentDirectory,
    ensureMdExtension,
    initialNameFromWikilink,
    isFolioNewHref,
    parseFolioNewName,
} from '../../app/view/wikilink-create';
import { isInvalidFileName, joinDirFile } from '../../app/util/filename';

describe('wikilink-create helpers', () => {
    it('detects folio-new: scheme', () => {
        expect(isFolioNewHref('folio-new:Note')).toBe(true);
        expect(isFolioNewHref('folio-new:')).toBe(true);
        expect(isFolioNewHref('notes.md')).toBe(false);
        expect(isFolioNewHref('https://example.com')).toBe(false);
    });

    it('decodeURIComponent on the name (space, umlaut, slash)', () => {
        expect(parseFolioNewName('folio-new:Hello%20World')).toBe('Hello World');
        expect(parseFolioNewName('folio-new:B%C3%A4r')).toBe('Bär');
        expect(parseFolioNewName('folio-new:a%2Fb')).toBe('a/b');
        expect(parseFolioNewName('folio-new:plain')).toBe('plain');
    });

    it('tolerates malformed percent-encoding', () => {
        expect(parseFolioNewName('folio-new:%E0%A4%A')).toBe('%E0%A4%A');
    });

    it('ensures .md extension', () => {
        expect(ensureMdExtension('Note')).toBe('Note.md');
        expect(ensureMdExtension('Note.md')).toBe('Note.md');
        expect(ensureMdExtension('Note.MD')).toBe('Note.MD');
        expect(ensureMdExtension('  ')).toBe('untitled.md');
    });

    it('derives document directory with POSIX slashes', () => {
        expect(documentDirectory('/vault/notes/a.md')).toBe('/vault/notes');
        expect(documentDirectory('C:\\vault\\a.md')).toBe('C:/vault');
        expect(documentDirectory(null)).toBe(null);
        expect(documentDirectory('')).toBe(null);
    });

    it('joins dir + file without double slashes', () => {
        expect(joinDirFile('/vault/notes/', 'x.md')).toBe('/vault/notes/x.md');
        expect(joinDirFile('/vault/notes', 'x.md')).toBe('/vault/notes/x.md');
    });

    it('rejects path traversal in file names', () => {
        expect(isInvalidFileName('ok.md')).toBe(false);
        expect(isInvalidFileName('../evil.md')).toBe(true);
        expect(isInvalidFileName('a/b.md')).toBe(true);
        expect(isInvalidFileName('')).toBe(true);
    });

    it('F8b: path-qualified name uses only last component', () => {
        expect(initialNameFromWikilink('Ordner/Name')).toBe('Name.md');
        expect(initialNameFromWikilink('a/b/c/Note')).toBe('Note.md');
        expect(initialNameFromWikilink('Note')).toBe('Note.md');
        expect(initialNameFromWikilink('Ordner/Name.md')).toBe('Name.md');
        expect(initialNameFromWikilink('a\\b\\Note')).toBe('Note.md');
    });
});

describe('handleFolioNewClick + dialog', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.restoreAllMocks();
        installTauriMock();
        document.body.innerHTML = `
            <div id="rename-dialog" hidden>
                <div id="rename-title"></div>
                <div id="rename-subtitle"></div>
                <input id="rename-input" />
                <div id="rename-error" hidden></div>
                <button id="rename-ok"></button>
                <button id="rename-cancel"></button>
            </div>
        `;
        await seedDeCatalog();
    });

    it('F8a: reentrant folio-new clicks are ignored while dialog open', async () => {
        const tauri = installTauriMock();
        tauri.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'create_file') return Promise.resolve(args.path);
            if (cmd === 'read_file') {
                return Promise.resolve({
                    path: args.path,
                    content: '',
                    kind: 'markdown',
                    language: 'markdown',
                    encoding: 'utf8',
                    line_ending: 'lf',
                });
            }
            return Promise.resolve(undefined);
        });

        vi.doMock('../../app/state/document', async () => {
            const actual = await vi.importActual<typeof import('../../app/state/document')>(
                '../../app/state/document',
            );
            return {
                ...actual,
                getCurrentPath: () => '/vault/notes/current.md',
                openDocument: vi.fn().mockResolvedValue(true),
            };
        });

        const { handleFolioNewClick } = await import('../../app/view/wikilink-create');

        const p1 = handleFolioNewClick('folio-new:First');
        await Promise.resolve();
        const input = document.getElementById('rename-input') as HTMLInputElement;
        expect(input.value).toBe('First.md');

        // Second click while dialog open must be ignored (no double handlers).
        const p2 = handleFolioNewClick('folio-new:Second');
        await Promise.resolve();
        expect(input.value).toBe('First.md'); // not overwritten

        document.getElementById('rename-cancel')!.click();
        await Promise.all([p1, p2]);
        expect(document.getElementById('rename-dialog')!.hidden).toBe(true);
    });

    it('F8b: path-qualified folio-new prefills last component only', async () => {
        const tauri = installTauriMock();
        tauri.invoke.mockResolvedValue(undefined);
        vi.doMock('../../app/state/document', async () => {
            const actual = await vi.importActual<typeof import('../../app/state/document')>(
                '../../app/state/document',
            );
            return {
                ...actual,
                getCurrentPath: () => '/vault/notes/current.md',
                openDocument: vi.fn(),
            };
        });
        const { handleFolioNewClick } = await import('../../app/view/wikilink-create');
        const p = handleFolioNewClick('folio-new:Ordner%2FNeue');
        await Promise.resolve();
        const input = document.getElementById('rename-input') as HTMLInputElement;
        expect(input.value).toBe('Neue.md');
        document.getElementById('rename-cancel')!.click();
        await p;
    });

    it('opens create dialog with decoded name and creates file on OK', async () => {
        const tauri = installTauriMock();
        tauri.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'create_file') return Promise.resolve(args.path);
            if (cmd === 'read_file') {
                return Promise.resolve({
                    path: args.path,
                    content: '',
                    kind: 'markdown',
                    language: 'markdown',
                    encoding: 'utf8',
                    line_ending: 'lf',
                });
            }
            return Promise.resolve(undefined);
        });

        vi.doMock('../../app/state/document', async () => {
            const actual = await vi.importActual<typeof import('../../app/state/document')>(
                '../../app/state/document',
            );
            return {
                ...actual,
                getCurrentPath: () => '/vault/notes/current.md',
                openDocument: vi.fn().mockResolvedValue(true),
            };
        });

        const { handleFolioNewClick } = await import('../../app/view/wikilink-create');
        const { openDocument } = await import('../../app/state/document');

        const p = handleFolioNewClick('folio-new:Neue%20Notiz');
        // Dialog should be visible with prefilled name
        await Promise.resolve();
        const input = document.getElementById('rename-input') as HTMLInputElement;
        expect(document.getElementById('rename-dialog')!.hidden).toBe(false);
        expect(input.value).toBe('Neue Notiz.md');
        expect(document.getElementById('rename-title')!.textContent).toContain('Notiz');
        expect(document.getElementById('rename-subtitle')!.textContent).toContain('/vault/notes');

        document.getElementById('rename-ok')!.click();
        await p;

        expect(tauri.invoke).toHaveBeenCalledWith('create_file', {
            path: '/vault/notes/Neue Notiz.md',
        });
        expect(openDocument).toHaveBeenCalledWith('/vault/notes/Neue Notiz.md');
        expect(document.getElementById('rename-dialog')!.hidden).toBe(true);
    });

    it('keeps dialog open and shows error when create_file fails', async () => {
        const tauri = installTauriMock();
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'create_file') return Promise.reject('Datei existiert bereits: x.md');
            return Promise.resolve(undefined);
        });

        vi.doMock('../../app/state/document', async () => {
            const actual = await vi.importActual<typeof import('../../app/state/document')>(
                '../../app/state/document',
            );
            return {
                ...actual,
                getCurrentPath: () => '/vault/a.md',
                openDocument: vi.fn(),
            };
        });

        const { handleFolioNewClick } = await import('../../app/view/wikilink-create');
        const p = handleFolioNewClick('folio-new:x');
        await Promise.resolve();
        document.getElementById('rename-ok')!.click();
        // wait for reject path
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(document.getElementById('rename-dialog')!.hidden).toBe(false);
        expect(document.getElementById('rename-error')!.textContent).toContain('existiert');
        expect(document.getElementById('rename-error')!.hasAttribute('hidden')).toBe(false);

        document.getElementById('rename-cancel')!.click();
        await p;
    });

    it('cancel does nothing', async () => {
        const tauri = installTauriMock();
        vi.doMock('../../app/state/document', async () => {
            const actual = await vi.importActual<typeof import('../../app/state/document')>(
                '../../app/state/document',
            );
            return {
                ...actual,
                getCurrentPath: () => '/vault/a.md',
                openDocument: vi.fn(),
            };
        });

        const { handleFolioNewClick } = await import('../../app/view/wikilink-create');
        const { openDocument } = await import('../../app/state/document');
        const p = handleFolioNewClick('folio-new:Skip');
        await Promise.resolve();
        document.getElementById('rename-cancel')!.click();
        await p;

        expect(tauri.invoke).not.toHaveBeenCalledWith('create_file', expect.anything());
        expect(openDocument).not.toHaveBeenCalled();
    });
});
