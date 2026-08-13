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

function mountMenuDom(): void {
    document.body.innerHTML = `<nav id="context-menu" role="menu"></nav>`;
}

beforeEach(async () => {
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
        false,
        false,
        opts.isExec,
        { gitModified: opts.gitModified, isText: opts.isText },
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
