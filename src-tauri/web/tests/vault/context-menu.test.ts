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
    opts: { isDir: boolean; isExec: boolean },
): Promise<HTMLElement> {
    const mod = await import('../../app/vault/context-menu');
    mod.initContextMenu({
        openDocument: vi.fn(),
        refreshVault: vi.fn(),
        showStatus: vi.fn(),
    });
    mod.openContextMenu(0, 0, '/foo/a.sh', opts.isDir, false, false, opts.isExec);
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
