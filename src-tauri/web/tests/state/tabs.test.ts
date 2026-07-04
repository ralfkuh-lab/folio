import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';

const requestSaveIfDirty = vi.fn().mockResolvedValue(true);
const syncEditorTextToStore = vi.fn().mockResolvedValue(undefined);

vi.mock('../../app/state/document', () => ({
    getCurrentPath: vi.fn().mockReturnValue('/tmp/a.md'),
    requestSaveIfDirty,
    syncEditorTextToStore,
}));

let tauri: TauriMockHandles;

beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    tauri = installTauriMock();
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
});
