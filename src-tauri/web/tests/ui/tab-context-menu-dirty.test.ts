// Integrationstest fuer den Dirty-Abbruch der Serien-Schliessung —
// portiert aus dem A/B-Kandidaten agy (Review-Konsens: dieser Test
// faehrt den ECHTEN requestCloseTab-Pfad inkl. Dirty-Bestaetigung,
// waehrend tab-context-menu.test.ts state/tabs komplett mockt).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const { requestSaveIfDirty, syncEditorTextToStore } = vi.hoisted(() => ({
    requestSaveIfDirty: vi.fn().mockResolvedValue(true),
    syncEditorTextToStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../app/state/document', () => ({
    getCurrentPath: vi.fn().mockReturnValue('/tmp/a.md'),
    requestSaveIfDirty,
    syncEditorTextToStore,
}));

let tauri: TauriMockHandles;

beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tauri = installTauriMock();
    requestSaveIfDirty.mockResolvedValue(true);
    await seedDeCatalog();
    document.body.className = '';
    document.body.innerHTML = `
        <nav id="tab-bar" hidden></nav>
        <nav id="tab-ctx-menu" role="menu"></nav>
    `;
});

describe('ui/tab-context-menu — Dirty-Serie (echter requestCloseTab-Pfad)', () => {
    it('close-others stoppt die Serie, wenn der User den Dirty-Dialog abbricht', async () => {
        const { renderTabs } = await import('../../app/state/tabs');
        const { initTabContextMenu } = await import('../../app/ui/tab-context-menu');
        initTabContextMenu();

        renderTabs({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [
                { id: 10, path: '/a.md', dirty: true, active: true },
                { id: 20, path: '/b.md', dirty: false, active: false },
                { id: 30, path: '/c.md', dirty: false, active: false },
            ],
        } as any);

        // User bricht den Dirty-Dialog des ERSTEN Serien-Ziels (Tab 10) ab.
        requestSaveIfDirty.mockResolvedValueOnce(false);

        document.querySelector('[data-tab-id="20"]')!.dispatchEvent(
            new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: 150,
                clientY: 50,
            }),
        );
        const closeOthers = document.querySelector(
            '#tab-ctx-menu [data-act="close-others"]',
        ) as HTMLElement;
        expect(closeOthers).not.toBeNull();
        closeOthers.click();

        await vi.waitFor(() => {
            expect(requestSaveIfDirty).toHaveBeenCalled();
        });
        await Promise.resolve();
        await Promise.resolve();

        // Abbruch beim dirty Tab 10: weder 10 noch das Folge-Ziel 30
        // duerfen im Backend geschlossen werden.
        expect(tauri.invoke).not.toHaveBeenCalledWith('tab_close', { id: 10 });
        expect(tauri.invoke).not.toHaveBeenCalledWith('tab_close', { id: 30 });
    });
});
