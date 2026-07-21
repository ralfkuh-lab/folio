import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const activateTab = vi.fn().mockResolvedValue(true);
const getTabsSnapshot = vi.fn();

vi.mock('../../app/state/tabs', () => ({
    activateTab,
    getTabsSnapshot,
}));

let tauri: TauriMockHandles;

function mountDom(): void {
    document.body.className = 'kind-markdown view-mode';
    document.body.innerHTML = `
      <button id="prev-focus" type="button">focus</button>
      <div id="unsaved-dialog" hidden></div>
      <div id="cmd-palette" hidden>
        <div class="cmd-palette-backdrop"></div>
        <div class="cmd-palette-panel">
          <input type="text" id="cmd-palette-input" />
          <ul id="cmd-palette-list" role="listbox"></ul>
        </div>
      </div>
    `;
}

function snapTabs() {
    return {
        activeIndex: 0,
        recentlyClosedCount: 1,
        tabs: [
            { id: 1, path: '/vault/notes/readme.md', dirty: false, active: true },
            { id: 2, path: '/vault/src/main.ts', dirty: false, active: false },
            { id: 3, path: '/vault/docs/guide.md', dirty: false, active: false },
        ],
    };
}

async function init(): Promise<typeof import('../../app/ui/command-palette')> {
    const mod = await import('../../app/ui/command-palette');
    mod.initCommandPalette();
    return mod;
}

beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tauri = installTauriMock();
    activateTab.mockResolvedValue(true);
    getTabsSnapshot.mockReturnValue(snapTabs());
    mountDom();
    await seedDeCatalog();
});

describe('command palette', () => {
    it('opens via __folioOpenPalette hook and closes via Esc', async () => {
        await init();
        const root = document.getElementById('cmd-palette')!;
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        const prev = document.getElementById('prev-focus') as HTMLButtonElement;
        prev.focus();
        expect(document.activeElement).toBe(prev);

        (window as any).__folioOpenPalette();
        expect(root.hidden).toBe(false);
        expect(document.body.classList.contains('palette-open')).toBe(true);

        // focus moves to input (rAF)
        await new Promise((r) => requestAnimationFrame(r));
        expect(document.activeElement).toBe(input);

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        expect(root.hidden).toBe(true);
        expect(document.body.classList.contains('palette-open')).toBe(false);
        // Fokus-Restore
        expect(document.activeElement).toBe(prev);
    });

    it('closes on backdrop click', async () => {
        await init();
        (window as any).__folioOpenPalette();
        const root = document.getElementById('cmd-palette')!;
        expect(root.hidden).toBe(false);
        const backdrop = root.querySelector('.cmd-palette-backdrop')!;
        backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(root.hidden).toBe(true);
    });

    it('does not open when unsaved-dialog is visible', async () => {
        await init();
        document.getElementById('unsaved-dialog')!.hidden = false;
        (window as any).__folioOpenPalette();
        expect(document.getElementById('cmd-palette')!.hidden).toBe(true);
    });

    it('filters open tabs by query and highlights matches', async () => {
        await init();
        (window as any).__folioOpenPalette();
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = 'main';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        const list = document.getElementById('cmd-palette-list')!;
        const items = list.querySelectorAll('.cmd-palette-item');
        expect(items.length).toBe(1);
        expect(items[0].textContent).toContain('main.ts');
        expect(items[0].querySelector('.cp-hit')).not.toBeNull();
        expect(items[0].querySelector('.cmd-palette-badge')!.textContent).toMatch(/Tab/i);
    });

    it('> mode shows only enabled commands and dispatches menu_dispatch', async () => {
        // Image: edit/split disabled; export disabled
        document.body.className = 'kind-image view-mode';
        await init();
        (window as any).__folioOpenPalette('>');
        const list = document.getElementById('cmd-palette-list')!;
        const labels = Array.from(list.querySelectorAll('.cmd-palette-label'))
            .map((el) => el.textContent || '');
        // Edit-Mode should be hidden for image
        expect(labels.some((l) => /Edit/i.test(l) || /Bearbeiten/i.test(l))).toBe(false);
        // Settings always enabled
        expect(labels.some((l) => /Einstell/i.test(l) || /Settings/i.test(l))).toBe(true);

        // Filter to settings and Enter
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = '>Einstell';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // German catalog: "Einstellungen…"
        const items = list.querySelectorAll('.cmd-palette-item');
        expect(items.length).toBeGreaterThanOrEqual(1);

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(tauri.invoke).toHaveBeenCalledWith(
            'menu_dispatch',
            expect.objectContaining({ id: 'edit.settings' }),
        );
    });

    it('command mode with exact mode action uses menu_dispatch view.mode.edit', async () => {
        document.body.className = 'kind-markdown view-mode';
        await init();
        (window as any).__folioOpenPalette('>Edit');
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        // Ensure query settled
        input.value = '>Edit';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const list = document.getElementById('cmd-palette-list')!;
        const items = Array.from(list.querySelectorAll('.cmd-palette-item'));
        // Prefer the edit-mode item
        const editItem = items.find((el) =>
            /Edit-Modus|Edit Mode|Bearbeitungsmodus/i.test(el.textContent || ''),
        ) || items[0];
        expect(editItem).toBeTruthy();
        (editItem as HTMLElement).click();
        expect(tauri.invoke).toHaveBeenCalledWith(
            'menu_dispatch',
            expect.objectContaining({ id: 'view.mode.edit' }),
        );
    });

    it('keyboard nav moves aria-selected and Enter activates tab', async () => {
        await init();
        (window as any).__folioOpenPalette();
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        const list = document.getElementById('cmd-palette-list')!;

        // empty query → all 3 tabs
        let items = list.querySelectorAll('.cmd-palette-item');
        expect(items.length).toBe(3);
        expect(items[0].getAttribute('aria-selected')).toBe('true');

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown', bubbles: true, cancelable: true,
        }));
        items = list.querySelectorAll('.cmd-palette-item');
        expect(items[1].getAttribute('aria-selected')).toBe('true');
        expect(items[0].getAttribute('aria-selected')).toBe('false');

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        // second tab in sort order by label: guide.md, main.ts, readme.md
        // activeIdx 1 after one ArrowDown from 0
        expect(activateTab).toHaveBeenCalled();
        expect(document.getElementById('cmd-palette')!.hidden).toBe(true);
    });

    it('togglePalette opens and closes', async () => {
        const mod = await init();
        expect(mod.isPaletteOpen()).toBe(false);
        mod.togglePalette();
        expect(mod.isPaletteOpen()).toBe(true);
        mod.togglePalette();
        expect(mod.isPaletteOpen()).toBe(false);
    });

    it('resets query on each open', async () => {
        const mod = await init();
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        mod.openPalette('main');
        expect(input.value).toBe('main');
        mod.closePalette();
        mod.openPalette();
        expect(input.value).toBe('');
    });
});
