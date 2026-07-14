import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const requestSaveIfDirty = vi.fn().mockResolvedValue(true);
const syncEditorTextToStore = vi.fn().mockResolvedValue(undefined);

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
    await seedDeCatalog();
    document.body.className = '';
    document.body.innerHTML = '<nav id="tab-bar" hidden></nav>';
});

describe('state/tabs', () => {
    it('renders file names, full-path titles, active state and dirty dot', async () => {
        const { renderTabs } = await import('../../app/state/tabs');

        renderTabs({
            activeIndex: 1,
            tabs: [
                { id: 1, path: '/notes/alpha.md', dirty: true, active: false },
                { id: 2, path: '/notes/beta.md', dirty: false, active: true },
            ],
        });

        const bar = document.getElementById('tab-bar')!;
        const items = bar.querySelectorAll('.tab-item');
        expect(bar.hidden).toBe(false);
        expect(items).toHaveLength(2);
        expect(items[0].querySelector('.tab-title')!.textContent).toBe('alpha.md');
        expect(items[0].getAttribute('title')).toBe('/notes/alpha.md');
        expect(items[0].querySelector('.tab-dirty')).not.toBeNull();
        expect(items[1].classList.contains('active')).toBe(true);
        expect(items[1].getAttribute('aria-selected')).toBe('true');
    });

    it('hides the bar for the single empty backend tab', async () => {
        const { renderTabs } = await import('../../app/state/tabs');

        renderTabs({
            activeIndex: 0,
            tabs: [{ id: 1, path: null, dirty: false, active: true }],
        });

        expect(document.getElementById('tab-bar')!.hidden).toBe(true);
        expect(document.querySelectorAll('.tab-item')).toHaveLength(0);
    });

    it('close button uses dirty confirmation and invokes tab_close', async () => {
        const { renderTabs } = await import('../../app/state/tabs');
        renderTabs({
            activeIndex: 0,
            tabs: [{ id: 7, path: '/notes/dirty.md', dirty: true, active: true }],
        });

        (document.querySelector('.tab-close') as HTMLButtonElement).click();

        await vi.waitFor(() => {
            expect(requestSaveIfDirty).toHaveBeenCalledWith(true);
            expect(tauri.invoke).toHaveBeenCalledWith('tab_close', { id: 7 });
        });
    });

    it('confirmAllDirtyTabs prompts every dirty tab and stops on cancel', async () => {
        const { renderTabs, confirmAllDirtyTabs } = await import('../../app/state/tabs');
        renderTabs({
            activeIndex: 0,
            tabs: [
                { id: 1, path: '/notes/a.md', dirty: true, active: true },
                { id: 2, path: '/notes/b.md', dirty: true, active: false },
                { id: 3, path: '/notes/c.md', dirty: false, active: false },
            ],
        });

        expect(await confirmAllDirtyTabs()).toBe(true);
        // Aktiver dirty Tab wird direkt geprompted, inaktiver erst aktiviert.
        expect(requestSaveIfDirty).toHaveBeenCalledTimes(2);
        expect(tauri.invoke).toHaveBeenCalledWith('tab_activate', { id: 2 });

        // Abbruch beim ersten Prompt stoppt die Kette.
        vi.clearAllMocks();
        requestSaveIfDirty.mockResolvedValueOnce(false);
        expect(await confirmAllDirtyTabs()).toBe(false);
        expect(requestSaveIfDirty).toHaveBeenCalledTimes(1);
    });

    it('registers listener before the initial tabs_list synchronization', async () => {
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'tabs_list') {
                return Promise.resolve({
                    activeIndex: 0,
                    tabs: [{ id: 3, path: '/tmp/boot.md', dirty: false, active: true }],
                });
            }
            return Promise.resolve(undefined);
        });
        const { initTabs } = await import('../../app/state/tabs');

        initTabs();

        await vi.waitFor(() => {
            expect(document.querySelector('.tab-title')!.textContent).toBe('boot.md');
        });
        expect(tauri.listeners.has('tabs:changed')).toBe(true);
    });

    it('keeps multiple virtual tabs open with exactly one active region', async () => {
        const {
            activateVirtualTab,
            registerVirtualTab,
        } = await import('../../app/state/tabs');
        const settingsActivate = vi.fn();
        const themeActivate = vi.fn();

        registerVirtualTab({
            slug: 'settings',
            label: () => '⚙ Einstellungen',
            onActivate: settingsActivate,
            onClose: vi.fn(),
        });
        registerVirtualTab({
            slug: 'theme-editor',
            label: () => '🎨 Firma',
            dirty: () => true,
            onActivate: themeActivate,
            onClose: vi.fn(),
        });

        expect(document.querySelectorAll('#tab-bar .tab-item')).toHaveLength(2);
        expect(document.querySelector('.tab-settings')).not.toBeNull();
        expect(document.querySelector('.tab-theme-editor .tab-dirty')).not.toBeNull();
        expect(document.body.classList.contains('theme-editor-open')).toBe(true);
        expect(document.body.classList.contains('settings-open')).toBe(false);

        activateVirtualTab('settings');
        expect(document.querySelector('.tab-settings')!
            .getAttribute('aria-selected')).toBe('true');
        expect(document.querySelector('.tab-theme-editor')!
            .getAttribute('aria-selected')).toBe('false');
        expect(document.body.classList.contains('settings-open')).toBe(true);
        expect(document.body.classList.contains('theme-editor-open')).toBe(false);
        expect(settingsActivate).toHaveBeenCalled();
        expect(themeActivate).toHaveBeenCalled();
    });

    it('guards document-tab activation through the active virtual close hook', async () => {
        const { registerVirtualTab, renderTabs } = await import('../../app/state/tabs');
        const onClose = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        renderTabs({
            activeIndex: 0,
            tabs: [{ id: 4, path: '/tmp/doc.md', dirty: false, active: true }],
        });
        registerVirtualTab({
            slug: 'theme-editor',
            label: () => '🎨 Firma',
            onActivate: vi.fn(),
            onClose,
        });

        (document.querySelector('[data-tab-id="4"]') as HTMLElement).click();
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(document.querySelector('.tab-theme-editor')).not.toBeNull();

        (document.querySelector('[data-tab-id="4"]') as HTMLElement).click();
        await vi.waitFor(() => {
            expect(onClose).toHaveBeenCalledTimes(2);
            expect(document.querySelector('.tab-theme-editor')).toBeNull();
        });
        expect(document.body.classList.contains('theme-editor-open')).toBe(false);
    });
});

describe('state/tabs — pointer drag reorder (8px threshold, only real reorder swallows click)', () => {
    // jsdom PointerEvent mock pattern 1:1 from vault/tree.test.ts
    function pe(type: string, opts: Record<string, any> = {}): any {
        const ev = new Event(type, { bubbles: true, cancelable: true }) as any;
        Object.assign(ev, { button: 0, pointerId: 1, clientX: 0, clientY: 0 }, opts);
        return ev;
    }

    const RECT_80 = () => ({ top: 0, bottom: 20, left: 0, right: 80, width: 80, height: 20 } as any);

    function renderTwoDocs() {
        const { renderTabs } = require('../../app/state/tabs'); // sync after reset? use dynamic in its
        // better: caller does import
    }

    it('sub-threshold movement does not start drag', async () => {
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'tabs_list') {
                return Promise.resolve({
                    activeIndex: 0,
                    tabs: [
                        { id: 10, path: '/a.md', dirty: false, active: true },
                        { id: 11, path: '/b.md', dirty: false, active: false },
                    ],
                });
            }
            return Promise.resolve(undefined);
        });
        const tabsMod = await import('../../app/state/tabs');
        tabsMod.initTabs();
        await vi.waitFor(() => {
            expect(document.querySelector('[data-tab-id="10"]')).not.toBeNull();
        });

        const itemA = document.querySelector('[data-tab-id="10"]') as HTMLElement;
        itemA.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
        document.dispatchEvent(pe('pointermove', { clientX: 3, clientY: 1 })); // dist < 8

        expect(document.querySelector('.tab-item.dragging')).toBeNull();
        expect(tauri.invoke).not.toHaveBeenCalledWith('tab_reorder', expect.anything());
    });

    it('real drag over neighbor reorders DOM, calls tab_reorder with new id order, swallows follow click', async () => {
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'tabs_list') {
                return Promise.resolve({
                    activeIndex: 0,
                    tabs: [
                        { id: 10, path: '/a.md', dirty: false, active: true },
                        { id: 11, path: '/b.md', dirty: false, active: false },
                    ],
                });
            }
            return Promise.resolve(undefined);
        });
        const tabsMod = await import('../../app/state/tabs');
        tabsMod.initTabs();
        await vi.waitFor(() => {
            expect(document.querySelector('[data-tab-id="10"]')).not.toBeNull();
        });

        // cancel any stale drag states left by prior tests (shared document listeners + closed-over tabDrag)
        document.dispatchEvent(pe('pointercancel', { pointerId: 1 }));
        document.dispatchEvent(pe('pointercancel', { pointerId: 2 }));
        document.body.classList.remove('tab-dragging');
        const itemA = document.querySelector('[data-tab-id="10"]') as HTMLElement;
        const itemB = document.querySelector('[data-tab-id="11"]') as HTMLElement;
        itemB.getBoundingClientRect = RECT_80;

        itemA.dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientX: 20, clientY: 0 })); // exceed 8px -> active
        expect(itemA.classList.contains('dragging')).toBe(true);
        expect(document.body.classList.contains('tab-dragging')).toBe(true);

        itemB.dispatchEvent(pe('pointermove', { clientX: 50, clientY: 0 })); // right half of B -> after
        expect(itemB.classList.contains('drop-over-after')).toBe(true);

        document.dispatchEvent(pe('pointerup', { clientX: 50, clientY: 0 }));

        // DOM reordered: B then A
        const children = Array.from(document.querySelectorAll('#tab-bar .tab-item'));
        expect((children[0] as HTMLElement).dataset.tabId).toBe('11');
        expect((children[1] as HTMLElement).dataset.tabId).toBe('10');

        expect(tauri.invoke).toHaveBeenCalledWith('tab_reorder', { ids: [11, 10] });

        // follow synthetic click must be swallowed (no activate)
        tauri.invoke.mockClear();
        itemA.dispatchEvent(pe('click'));
        expect(tauri.invoke).not.toHaveBeenCalledWith('tab_activate', expect.anything());
    });

    it('drag start on .tab-close does not arm drag', async () => {
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'tabs_list') {
                return Promise.resolve({
                    activeIndex: 0,
                    tabs: [
                        { id: 10, path: '/a.md', dirty: false, active: true },
                        { id: 11, path: '/b.md', dirty: false, active: false },
                    ],
                });
            }
            return Promise.resolve(undefined);
        });
        const tabsMod = await import('../../app/state/tabs');
        tabsMod.initTabs();
        await vi.waitFor(() => {
            expect(document.querySelector('[data-tab-id="10"]')).not.toBeNull();
        });

        const closeA = document.querySelector('[data-tab-id="10"] .tab-close') as HTMLElement;
        closeA.dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientX: 30, clientY: 0 }));

        expect(document.querySelector('.tab-item.dragging')).toBeNull();
    });

    it('virtual tab is neither drag source nor drop target', async () => {
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'tabs_list') {
                return Promise.resolve({
                    activeIndex: 0,
                    tabs: [
                        { id: 10, path: '/a.md', dirty: false, active: true },
                    ],
                });
            }
            return Promise.resolve(undefined);
        });
        const tabsMod = await import('../../app/state/tabs');
        tabsMod.initTabs();
        await vi.waitFor(() => {
            expect(document.querySelector('[data-tab-id="10"]')).not.toBeNull();
        });
        tabsMod.registerVirtualTab({
            slug: 'settings',
            label: () => '⚙ Einstellungen',
            onActivate: vi.fn(),
            onClose: vi.fn(),
        });

        const virt = document.querySelector('.tab-settings') as HTMLElement;
        virt.dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientX: 30 }));

        expect(document.querySelector('.tab-item.dragging')).toBeNull();

        // also a doc drag should not target the virtual
        const docItem = document.querySelector('[data-tab-id="10"]') as HTMLElement;
        docItem.dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientX: 9, clientY: 0 })); // active
        virt.getBoundingClientRect = RECT_80;
        virt.dispatchEvent(pe('pointermove', { clientX: 10 }));
        // since getDoc returns null for virtual, no marker should be on it
        expect(virt.classList.contains('drop-over-before')).toBe(false);
        expect(virt.classList.contains('drop-over-after')).toBe(false);
    });

    it('jitter click (threshold crossed but no drop target) still activates', async () => {
        tauri.invoke.mockImplementation((command: string) => {
            if (command === 'tabs_list') {
                return Promise.resolve({
                    activeIndex: 0,
                    tabs: [{ id: 42, path: '/only.md', dirty: false, active: false }],
                });
            }
            return Promise.resolve(undefined);
        });
        const tabsMod = await import('../../app/state/tabs');
        tabsMod.initTabs();
        await vi.waitFor(() => {
            expect(document.querySelector('[data-tab-id="42"]')).not.toBeNull();
        });

        document.dispatchEvent(pe('pointercancel', { pointerId: 1 }));
        document.dispatchEvent(pe('pointercancel', { pointerId: 2 }));
        const item = document.querySelector('[data-tab-id="42"]') as HTMLElement;
        item.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
        document.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 })); // active drag
        // release over same item -> no other target -> no suppress
        document.dispatchEvent(pe('pointerup', { clientX: 5, clientY: 0 }));

        tauri.invoke.mockClear();
        item.dispatchEvent(pe('click'));
        // the click handler in render does activateTab which does invoke('tab_activate')
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('tab_activate', { id: 42 });
        });
    });
});
