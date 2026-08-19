// Tests fuer vault/context-menu.ts. Schwerpunkt: die datei-spezifische
// Render-Verzweigung in openContextMenu — ausfuehrbare Dateien bekommen
// einen "Ausführen"-Eintrag (data-act="run"), nicht-ausfuehrbare einen
// "Mit Standardprogramm öffnen"-Eintrag (data-act="open-default"),
// Verzeichnisse keinen von beiden. Der eigentliche Command-Aufruf + das
// Bestaetigungs-Modal werden NICHT getestet (Tauri/IPC ist hier gemockt
// und nur der Render-Pfad ist von Interesse).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

vi.mock('../../app/ui/git-diff', () => ({
    openGitDiff: vi.fn(),
}));

const tabSnapshot = {
    tabs: [] as Array<{ id: number; path: string | null; dirty: boolean; active: boolean }>,
    activeIndex: 0,
    recentlyClosedCount: 0,
};

vi.mock('../../app/state/tabs', () => ({
    getTabsSnapshot: () => ({
        tabs: tabSnapshot.tabs.slice(),
        activeIndex: tabSnapshot.activeIndex,
        recentlyClosedCount: tabSnapshot.recentlyClosedCount,
    }),
}));

vi.mock('../../app/ui/dialogs', async () => {
    const actual = await vi.importActual<typeof import('../../app/ui/dialogs')>(
        '../../app/ui/dialogs',
    );
    return {
        ...actual,
        showConfirmDialog: vi.fn().mockResolvedValue(false),
    };
});

function mountMenuDom(): void {
    document.body.innerHTML = `<nav id="context-menu" role="menu"></nav>`;
}

beforeEach(async () => {
    tabSnapshot.tabs = [];
    tabSnapshot.activeIndex = 0;
    tabSnapshot.recentlyClosedCount = 0;
    installTauriMock();
    mountMenuDom();
    vi.resetModules();
    await seedDeCatalog();
});

async function openMenu(
    opts: {
        isDir: boolean;
        isExec: boolean;
        gitModified?: boolean;
        isText?: boolean;
        path?: string;
        inPinned?: boolean;
        wikilinkRoot?: boolean;
    },
): Promise<HTMLElement> {
    const mod = await import('../../app/vault/context-menu');
    mod.initContextMenu({
        openDocument: vi.fn(),
        refreshVault: vi.fn(),
        showStatus: vi.fn(),
    });
    mod.openContextMenu(
        0,
        0,
        opts.path || '/foo/a.sh',
        opts.isDir,
        opts.inPinned === true,
        false,
        opts.isExec,
        {
            gitModified: opts.gitModified,
            isText: opts.isText,
            wikilinkRoot: opts.wikilinkRoot,
        },
    );
    return document.getElementById('context-menu') as HTMLElement;
}

describe('vault/context-menu — Ausführen/Öffnen-Verzweigung', () => {
    it('zeigt für ausführbare Dateien den "Ausführen"-Eintrag', async () => {
        const menu = await openMenu({ isDir: false, isExec: true });
        const run = menu.querySelector('[data-act="run"]');
        expect(run).not.toBeNull();
        expect(run!.textContent).toBe('Ausführen');
        expect(menu.querySelector('[data-act="open-default"]')).toBeNull();
    });

    it('zeigt für nicht-ausführbare Dateien den "Standardprogramm"-Eintrag', async () => {
        const menu = await openMenu({ isDir: false, isExec: false });
        const open = menu.querySelector('[data-act="open-default"]');
        expect(open).not.toBeNull();
        expect(open!.textContent).toBe('Mit Standardprogramm öffnen');
        expect(menu.querySelector('[data-act="run"]')).toBeNull();
    });

    it('bietet auf einer Pin-Wurzel kein Löschen, wohl aber Unpin', async () => {
        // Ein Fehlklick würde sonst ein ganzes Projektverzeichnis in den
        // Papierkorb schieben; gemeint ist dort „Aus Vault entfernen".
        const menu = await openMenu({ isDir: true, isExec: false, inPinned: true });
        expect(menu.querySelector('[data-act="delete"]')).toBeNull();
        expect(menu.querySelector('[data-act="unpin"]')).not.toBeNull();
        expect(menu.querySelector('[data-act="rename"]')).not.toBeNull();
        expect(menu.querySelector('[data-act="new-folder"]')).not.toBeNull();
    });

    it('bietet auf einem Unterordner Löschen an', async () => {
        const menu = await openMenu({ isDir: true, isExec: false, inPinned: false });
        expect(menu.querySelector('[data-act="delete"]')).not.toBeNull();
    });

    it('bietet auf einer gepinnten Einzeldatei weiterhin Löschen an', async () => {
        const menu = await openMenu({ isDir: false, isExec: false, inPinned: true });
        expect(menu.querySelector('[data-act="delete"]')).not.toBeNull();
    });

    it('zeigt für Verzeichnisse weder Ausführen/Öffnen-Default noch Öffnen', async () => {
        const menu = await openMenu({ isDir: true, isExec: false });
        expect(menu.querySelector('[data-act="run"]')).toBeNull();
        expect(menu.querySelector('[data-act="open-default"]')).toBeNull();
        expect(menu.querySelector('[data-act="open"]')).toBeNull();
    });
});

describe('vault/context-menu — Git-Diff-Eintrag', () => {
    it('zeigt Änderungen anzeigen nur bei modified + Text', async () => {
        const menu = await openMenu({
            isDir: false,
            isExec: false,
            gitModified: true,
            isText: true,
            path: '/repo/a.md',
        });
        const item = menu.querySelector('[data-act="show-changes"]');
        expect(item).not.toBeNull();
        expect(item!.textContent).toBe('Änderungen anzeigen');
    });

    it('zeigt den Eintrag nicht für untracked (kein gitModified)', async () => {
        const menu = await openMenu({
            isDir: false,
            isExec: false,
            gitModified: false,
            isText: true,
            path: '/repo/neu.md',
        });
        expect(menu.querySelector('[data-act="show-changes"]')).toBeNull();
    });

    it('zeigt den Eintrag nicht für Ordner', async () => {
        const menu = await openMenu({
            isDir: true,
            isExec: false,
            gitModified: true,
            isText: false,
            path: '/repo/src',
        });
        expect(menu.querySelector('[data-act="show-changes"]')).toBeNull();
    });

    it('zeigt den Eintrag nicht für Bilder', async () => {
        const menu = await openMenu({
            isDir: false,
            isExec: false,
            gitModified: true,
            isText: false,
            path: '/repo/pic.png',
        });
        expect(menu.querySelector('[data-act="show-changes"]')).toBeNull();
    });
});

describe('vault/context-menu — Ordner-Parität V1', () => {
    function acts(menu: HTMLElement): string[] {
        return Array.from(menu.querySelectorAll('[data-act]')).map(
            (el) => el.getAttribute('data-act') || '',
        );
    }

    it('zeigt für Verzeichnisse Neuer Ordner, Umbenennen und Löschen', async () => {
        const menu = await openMenu({ isDir: true, isExec: false, path: '/vault/notes' });
        const items = acts(menu);
        expect(items).toContain('new-folder');
        expect(items).toContain('rename');
        expect(items).toContain('delete');
        expect(items).toContain('new-file');
        expect(items.indexOf('new-folder')).toBeGreaterThan(items.indexOf('new-file'));
        expect(items[items.length - 1]).toBe('delete');
        expect(menu.querySelector('[data-act="delete"]')!.classList.contains('ctx-item-danger')).toBe(
            true,
        );
        expect(menu.querySelector('[data-act="new-folder"]')!.textContent).toBe('Neuer Ordner…');
        expect(menu.querySelector('[data-act="rename"]')!.textContent).toBe('Umbenennen');
        expect(menu.querySelector('[data-act="delete"]')!.textContent).toBe('Löschen');
    });

    it('zeigt für Dateien Neuer Ordner neben Neue Datei', async () => {
        const menu = await openMenu({ isDir: false, isExec: false, path: '/vault/a.md' });
        const items = acts(menu);
        expect(items).toContain('new-file');
        expect(items).toContain('new-folder');
        expect(items).toContain('rename');
        expect(items).toContain('delete');
        expect(items.indexOf('new-folder')).toBe(items.indexOf('new-file') + 1);
    });
});

describe('vault/context-menu — Inline-Rename Selektion', () => {
    function mountTree(kind: 'dir' | 'file', path: string, label: string): void {
        document.body.innerHTML = `
            <nav id="context-menu" role="menu"></nav>
            <ul id="vault-tree">
              <li class="node" data-path="${path}" data-kind="${kind}">
                <div class="row"><span class="label">${label}</span></div>
              </li>
            </ul>`;
    }

    it('selektiert bei Ordnern den ganzen Namen inkl. Punkt', async () => {
        mountTree('dir', '/vault/notes.old', 'notes.old');
        const { startInlineRename } = await import('../../app/vault/context-menu');
        startInlineRename('/vault/notes.old');
        const input = document.querySelector('.vault-rename-input') as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(input.value).toBe('notes.old');
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe('notes.old'.length);
    });

    it('selektiert bei Dateien nur den Stamm vor der Endung', async () => {
        mountTree('file', '/vault/file.md', 'file.md');
        const { startInlineRename } = await import('../../app/vault/context-menu');
        startInlineRename('/vault/file.md');
        const input = document.querySelector('.vault-rename-input') as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(input.value).toBe('file.md');
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(4);
    });

    it('lehnt pfadqualifizierte Inline-Namen ab', async () => {
        mountTree('dir', '/vault/notes', 'notes');
        const showStatus = vi.fn();
        const { initContextMenu, startInlineRename } = await import('../../app/vault/context-menu');
        initContextMenu({
            openDocument: vi.fn(),
            refreshVault: vi.fn(),
            showStatus,
        });
        startInlineRename('/vault/notes');
        const input = document.querySelector('.vault-rename-input') as HTMLInputElement;
        input.value = '../outside';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(showStatus).toHaveBeenCalledWith('Ungültiger Dateiname');
        expect(document.querySelector('.vault-rename-input')).toBeNull();
        expect((document.querySelector('.label') as HTMLElement).textContent).toBe('notes');
    });
});

describe('vault/context-menu — Ordner löschen mit ungespeicherten Tabs', () => {
    it('nennt ungespeicherte Tabs im Bestätigungsdialog', async () => {
        tabSnapshot.tabs = [
            { id: 1, path: '/vault/notes/a.md', dirty: true, active: true },
        ];
        const menu = await openMenu({ isDir: true, isExec: false, path: '/vault/notes' });
        const { showConfirmDialog } = await import('../../app/ui/dialogs');
        vi.mocked(showConfirmDialog).mockClear();
        (menu.querySelector('[data-act="delete"]') as HTMLElement).click();
        expect(showConfirmDialog).toHaveBeenCalledTimes(1);
        const [message, options] = vi.mocked(showConfirmDialog).mock.calls[0];
        expect(message).toContain('notes');
        expect(message).toContain('ungespeicherte Tabs');
        expect(options).toMatchObject({ title: 'Ordner löschen' });
    });
});

describe('vault/context-menu — Clip V2', () => {
    function acts(menu: HTMLElement): string[] {
        return Array.from(menu.querySelectorAll('[data-act]')).map(
            (el) => el.getAttribute('data-act') || '',
        );
    }

    it('zeigt Ausschneiden/Kopieren/Duplizieren für Datei und Ordner', async () => {
        const file = await openMenu({ isDir: false, isExec: false, path: '/vault/a.md' });
        expect(acts(file)).toEqual(expect.arrayContaining(['cut', 'clip-copy', 'duplicate']));
        expect(file.querySelector('[data-act="paste"]')).toBeNull();
        const dir = await openMenu({ isDir: true, isExec: false, path: '/vault/notes' });
        expect(acts(dir)).toEqual(expect.arrayContaining(['cut', 'clip-copy', 'duplicate']));
        expect(dir.querySelector('[data-act="paste"]')).toBeNull();
    });

    it('zeigt Einfügen nur wenn der Clip gefüllt ist', async () => {
        const { setClip } = await import('../../app/vault/clipboard');
        setClip('/vault/a.md', 'copy');
        const menu = await openMenu({ isDir: true, isExec: false, path: '/vault/notes' });
        const paste = menu.querySelector('[data-act="paste"]');
        expect(paste).not.toBeNull();
        expect(paste!.textContent).toBe('Einfügen');
    });

    it('zeigt Ausschneiden auf einer Pin-Wurzel, Löschen bleibt weg', async () => {
        const menu = await openMenu({
            isDir: true,
            isExec: false,
            path: '/vault',
            inPinned: true,
        });
        const items = acts(menu);
        expect(items).toContain('cut');
        expect(items).not.toContain('delete');
        expect(items).toContain('clip-copy');
        expect(items).toContain('duplicate');
    });
});

describe('vault/context-menu — Click-Handler V2', () => {
    it('duplicate ruft duplicate_entry auf', async () => {
        const menu = await openMenu({ isDir: false, isExec: false, path: '/vault/a.md' });
        const invoke = (window as unknown as { __TAURI__: { core: { invoke: ReturnType<typeof vi.fn> } } })
            .__TAURI__.core.invoke;
        invoke.mockClear();
        (menu.querySelector('[data-act="duplicate"]') as HTMLElement).click();
        expect(invoke).toHaveBeenCalledWith('duplicate_entry', { path: '/vault/a.md' });
    });

    it('cut und clip-copy setzen den Clip', async () => {
        const { getClip } = await import('../../app/vault/clipboard');
        const fileMenu = await openMenu({ isDir: false, isExec: false, path: '/vault/a.md' });
        (fileMenu.querySelector('[data-act="cut"]') as HTMLElement).click();
        expect(getClip()).toEqual({ path: '/vault/a.md', mode: 'cut' });
        const again = await openMenu({ isDir: false, isExec: false, path: '/vault/b.md' });
        (again.querySelector('[data-act="clip-copy"]') as HTMLElement).click();
        expect(getClip()).toEqual({ path: '/vault/b.md', mode: 'copy' });
    });

    it('paste im Cut-Modus ruft move_entry und leert den Clip', async () => {
        const { setClip, getClip } = await import('../../app/vault/clipboard');
        setClip('/vault/a.md', 'cut');
        const menu = await openMenu({ isDir: true, isExec: false, path: '/vault/notes' });
        const invoke = (window as unknown as { __TAURI__: { core: { invoke: ReturnType<typeof vi.fn> } } })
            .__TAURI__.core.invoke;
        invoke.mockClear();
        invoke.mockResolvedValue('/vault/notes/a.md');
        (menu.querySelector('[data-act="paste"]') as HTMLElement).click();
        await Promise.resolve();
        expect(invoke).toHaveBeenCalledWith('move_entry', { src: '/vault/a.md', destDir: '/vault/notes' });
        expect(getClip()).toBeNull();
    });

    it('leert den Clip bei sourceMissing nach Paste', async () => {
        const { setClip, getClip } = await import('../../app/vault/clipboard');
        const { t } = await import('../../app/i18n/translate');
        setClip('/vault/a.md', 'copy');
        const menu = await openMenu({ isDir: true, isExec: false, path: '/vault/notes' });
        const invoke = (window as unknown as { __TAURI__: { core: { invoke: ReturnType<typeof vi.fn> } } })
            .__TAURI__.core.invoke;
        invoke.mockRejectedValue(t('errors.file.sourceMissing', { detail: '/vault/a.md' }));
        (menu.querySelector('[data-act="paste"]') as HTMLElement).click();
        await Promise.resolve();
        await Promise.resolve();
        expect(getClip()).toBeNull();
    });
});

describe('vault/context-menu — Wikilink-/Tag-Wurzel-Toggle (W8)', () => {
    function acts(menu: HTMLElement): string[] {
        return Array.from(menu.querySelectorAll('.ctx-item')).map(
            (el) => el.getAttribute('data-act') || '',
        );
    }

    it('bietet den Toggle nur auf Pin-Wurzeln an', async () => {
        const inTree = await openMenu({ isDir: true, isExec: false, path: '/vault/sub' });
        expect(acts(inTree)).not.toContain('wikilink-root-on');
        expect(acts(inTree)).not.toContain('wikilink-root-off');

        const pinRoot = await openMenu({
            isDir: true,
            isExec: false,
            path: '/vault',
            inPinned: true,
        });
        expect(acts(pinRoot)).toContain('wikilink-root-on');
    });

    it('zeigt Aktivieren bzw. Deaktivieren je nach Opt-in-Zustand', async () => {
        const off = await openMenu({
            isDir: true,
            isExec: false,
            path: '/vault',
            inPinned: true,
            wikilinkRoot: false,
        });
        expect(off.querySelector('[data-act="wikilink-root-on"]')!.textContent).toBe(
            'Wikilinks & Tags hier aktivieren',
        );
        expect(off.querySelector('[data-act="wikilink-root-off"]')).toBeNull();

        const on = await openMenu({
            isDir: true,
            isExec: false,
            path: '/vault',
            inPinned: true,
            wikilinkRoot: true,
        });
        expect(on.querySelector('[data-act="wikilink-root-off"]')!.textContent).toBe(
            'Wikilinks & Tags hier deaktivieren',
        );
        expect(on.querySelector('[data-act="wikilink-root-on"]')).toBeNull();
    });

    it('gilt auch fuer gepinnte Einzeldateien', async () => {
        const menu = await openMenu({
            isDir: false,
            isExec: false,
            path: '/vault/notiz.md',
            inPinned: true,
        });
        expect(acts(menu)).toContain('wikilink-root-on');
    });

    it('ruft workspace_wikilink_root_set mit dem passenden enabled-Flag', async () => {
        const off = await openMenu({
            isDir: true,
            isExec: false,
            path: '/vault',
            inPinned: true,
            wikilinkRoot: false,
        });
        const invoke = (window as unknown as { __TAURI__: { core: { invoke: ReturnType<typeof vi.fn> } } })
            .__TAURI__.core.invoke;
        invoke.mockClear();
        (off.querySelector('[data-act="wikilink-root-on"]') as HTMLElement).click();
        expect(invoke).toHaveBeenCalledWith('workspace_wikilink_root_set', {
            path: '/vault',
            enabled: true,
        });

        const on = await openMenu({
            isDir: true,
            isExec: false,
            path: '/vault',
            inPinned: true,
            wikilinkRoot: true,
        });
        invoke.mockClear();
        (on.querySelector('[data-act="wikilink-root-off"]') as HTMLElement).click();
        expect(invoke).toHaveBeenCalledWith('workspace_wikilink_root_set', {
            path: '/vault',
            enabled: false,
        });
    });
});
