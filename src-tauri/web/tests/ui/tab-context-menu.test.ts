import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const requestCloseTab = vi.fn().mockResolvedValue(true);
const getTabsSnapshot = vi.fn();
const restoreLastTab = vi.fn();

vi.mock('../../app/state/tabs', () => ({
    requestCloseTab,
    getTabsSnapshot,
    restoreLastTab,
}));

let tauri: TauriMockHandles;

function mountDom(): void {
    document.body.innerHTML = `
      <nav id="tab-bar" role="tablist">
        <div class="tab-item" data-tab-id="1" title="/a.md"><span class="tab-title">a.md</span></div>
        <div class="tab-item" data-tab-id="2" title="/b.md"><span class="tab-title">b.md</span></div>
        <div class="tab-item" data-tab-id="3" title="/c.md"><span class="tab-title">c.md</span></div>
        <div class="tab-item tab-settings" data-tab-id="settings"><span class="tab-title">⚙</span></div>
      </nav>
      <nav id="tab-ctx-menu" role="menu"></nav>
    `;
}

function snapThree(recentlyClosedCount = 0) {
    return {
        activeIndex: 1,
        recentlyClosedCount,
        tabs: [
            { id: 1, path: '/a.md', dirty: false, active: false },
            { id: 2, path: '/b.md', dirty: false, active: true },
            { id: 3, path: '/c.md', dirty: false, active: false },
        ],
    };
}

beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tauri = installTauriMock();
    requestCloseTab.mockResolvedValue(true);
    getTabsSnapshot.mockReturnValue(snapThree(1));
    mountDom();
    await seedDeCatalog();
});

describe('computeMenuState', () => {
    it('disables close-others with one tab, close-right without right neighbor, restore on empty stack', async () => {
        const { computeMenuState } = await import('../../app/ui/tab-context-menu');
        const one = [{ id: 1, path: '/a.md', dirty: false, active: true }];
        const s1 = computeMenuState(one, 1, 0);
        expect(s1.closeOthersDisabled).toBe(true);
        expect(s1.closeRightDisabled).toBe(true);
        expect(s1.restoreDisabled).toBe(true);

        const three = snapThree().tabs;
        const mid = computeMenuState(three, 2, 2);
        expect(mid.closeOthersDisabled).toBe(false);
        expect(mid.closeRightDisabled).toBe(false);
        expect(mid.restoreDisabled).toBe(false);
        expect(mid.closeOthersIds).toEqual([1, 3]);
        expect(mid.closeRightIds).toEqual([3]);

        const last = computeMenuState(three, 3, 1);
        expect(last.closeRightDisabled).toBe(true);
        expect(last.closeRightIds).toEqual([]);
    });
});

describe('tab context menu UI', () => {
    async function init() {
        const mod = await import('../../app/ui/tab-context-menu');
        mod.initTabContextMenu();
        return mod;
    }

    it('opens only on document tabs, not virtual tabs', async () => {
        await init();
        const menu = document.getElementById('tab-ctx-menu')!;
        const settings = document.querySelector('[data-tab-id="settings"]')!;
        settings.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, clientX: 10, clientY: 10, cancelable: true,
        }));
        expect(menu.classList.contains('open')).toBe(false);

        const mid = document.querySelector('[data-tab-id="2"]')!;
        mid.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, clientX: 20, clientY: 20, cancelable: true,
        }));
        expect(menu.classList.contains('open')).toBe(true);
        const acts = Array.from(menu.querySelectorAll('.ctx-item')).map(
            (el) => el.getAttribute('data-act'),
        );
        expect(acts).toEqual(['close', 'close-others', 'close-right', 'restore']);
        expect(menu.querySelector('.ctx-sep')).not.toBeNull();
    });

    it('marks disabled items from snapshot (one tab / empty stack)', async () => {
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [{ id: 1, path: '/a.md', dirty: false, active: true }],
        });
        // DOM still has 3 items but snapshot drives disabled state
        document.body.innerHTML = `
          <nav id="tab-bar"><div class="tab-item" data-tab-id="1"></div></nav>
          <nav id="tab-ctx-menu"></nav>
        `;
        await init();
        document.querySelector('[data-tab-id="1"]')!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0, cancelable: true }),
        );
        const menu = document.getElementById('tab-ctx-menu')!;
        expect(menu.querySelector('[data-act="close-others"]')!.classList.contains('disabled')).toBe(true);
        expect(menu.querySelector('[data-act="close-right"]')!.classList.contains('disabled')).toBe(true);
        expect(menu.querySelector('[data-act="restore"]')!.classList.contains('disabled')).toBe(true);
        expect(menu.querySelector('[data-act="close"]')!.classList.contains('disabled')).toBe(false);
    });

    it('close-others closes exactly the other ids in bar order', async () => {
        await init();
        document.querySelector('[data-tab-id="2"]')!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0, cancelable: true }),
        );
        (document.querySelector('#tab-ctx-menu [data-act="close-others"]') as HTMLElement).click();
        await vi.waitFor(() => {
            expect(requestCloseTab).toHaveBeenCalledTimes(2);
        });
        expect(requestCloseTab.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    });

    it('abort during series stops remaining closes', async () => {
        // Review-Befund (beide Reviewer): mit nur zwei Zielen war der
        // Test wirkungslos — vier Tabs, Abbruch beim ZWEITEN von drei
        // Zielen, das dritte darf nie drankommen.
        requestCloseTab
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [
                { id: 1, path: '/a.md', dirty: false, active: true },
                { id: 2, path: '/b.md', dirty: false, active: false },
                { id: 3, path: '/c.md', dirty: true, active: false },
                { id: 4, path: '/d.md', dirty: false, active: false },
            ],
        });
        await init();
        const bar = document.getElementById('tab-bar')!;
        const extra = document.createElement('div');
        extra.className = 'tab-item';
        extra.dataset.tabId = '4';
        extra.innerHTML = '<span class="tab-title">d.md</span>';
        bar.insertBefore(extra, bar.querySelector('.tab-settings'));

        document.querySelector('[data-tab-id="1"]')!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0, cancelable: true }),
        );
        (document.querySelector('#tab-ctx-menu [data-act="close-others"]') as HTMLElement).click();
        await vi.waitFor(() => {
            expect(requestCloseTab).toHaveBeenCalledTimes(2);
        });
        // Serie: [2, 3, 4] — 3 liefert false, 4 darf nie aufgerufen werden.
        await Promise.resolve();
        await Promise.resolve();
        expect(requestCloseTab).toHaveBeenCalledTimes(2);
        expect(requestCloseTab.mock.calls.map((c) => c[0])).toEqual([2, 3]);
    });

    it('right-click on virtual tab closes an open document menu', async () => {
        await init();
        document.querySelector('[data-tab-id="2"]')!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0, cancelable: true }),
        );
        expect(document.getElementById('tab-ctx-menu')!.classList.contains('open')).toBe(true);

        document.querySelector('[data-tab-id="settings"]')!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0, cancelable: true }),
        );
        expect(document.getElementById('tab-ctx-menu')!.classList.contains('open')).toBe(false);
    });

    it('restore calls restoreLastTab()', async () => {
        await init();
        document.querySelector('[data-tab-id="2"]')!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0, cancelable: true }),
        );
        (document.querySelector('#tab-ctx-menu [data-act="restore"]') as HTMLElement).click();
        expect(restoreLastTab).toHaveBeenCalled();
    });
});
