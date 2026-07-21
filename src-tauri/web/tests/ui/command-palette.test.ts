import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const activateTab = vi.fn().mockResolvedValue(true);
const getTabsSnapshot = vi.fn();
const openDocument = vi.fn().mockResolvedValue(true);

vi.mock('../../app/state/tabs', () => ({
    activateTab,
    getTabsSnapshot,
}));

vi.mock('../../app/state/document', () => ({
    openDocument,
}));

let tauri: TauriMockHandles;

function mountDom(opts?: { toc?: string; recent?: string }): void {
    document.body.className = 'kind-markdown view-mode';
    document.body.innerHTML = `
      <button id="prev-focus" type="button">focus</button>
      <div id="unsaved-dialog" hidden></div>
      <div id="vault-tree">
        <ul>
          <li class="section" data-section="recent">
            <ul class="children">${opts?.recent || ''}</ul>
          </li>
        </ul>
      </div>
      <aside id="toc-region">
        <ul class="toc">${opts?.toc || ''}</ul>
      </aside>
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
    openDocument.mockResolvedValue(true);
    getTabsSnapshot.mockReturnValue(snapTabs());
    // Default: empty walk, resolves after microtask
    tauri.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'palette_files') {
            return Promise.resolve({ files: [], truncated: false });
        }
        return Promise.resolve(undefined);
    });
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

        await new Promise((r) => requestAnimationFrame(r));
        expect(document.activeElement).toBe(input);

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        expect(root.hidden).toBe(true);
        expect(document.body.classList.contains('palette-open')).toBe(false);
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
        document.body.className = 'kind-image view-mode';
        await init();
        (window as any).__folioOpenPalette('>');
        const list = document.getElementById('cmd-palette-list')!;
        const labels = Array.from(list.querySelectorAll('.cmd-palette-label'))
            .map((el) => el.textContent || '');
        expect(labels.some((l) => /Edit/i.test(l) || /Bearbeiten/i.test(l))).toBe(false);
        expect(labels.some((l) => /Einstell/i.test(l) || /Settings/i.test(l))).toBe(true);

        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = '>Einstell';
        input.dispatchEvent(new Event('input', { bubbles: true }));
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
        input.value = '>Edit';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const list = document.getElementById('cmd-palette-list')!;
        const items = Array.from(list.querySelectorAll('.cmd-palette-item'));
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

describe('command palette P2 — files walk + headings', () => {
    it('mergeFileCandidates prioritizes tab > recent > walk', async () => {
        const { mergeFileCandidates } = await import('../../app/ui/command-palette');
        const merged = mergeFileCandidates(
            [{ path: '/a/shared.md', tabId: 1 }],
            [
                { path: '/a/shared.md', name: 'shared.md', relative: 'shared.md' },
                { path: '/a/recent-only.md', name: 'recent-only.md', relative: 'recent-only.md' },
            ],
            [
                { path: '/a/shared.md', name: 'shared.md', relative: 'shared.md' },
                { path: '/a/recent-only.md', name: 'recent-only.md', relative: 'recent-only.md' },
                { path: '/a/walk-only.md', name: 'walk-only.md', relative: 'walk-only.md' },
            ],
        );
        const byPath = Object.fromEntries(merged.map((m) => [m.path, m.source]));
        expect(byPath['/a/shared.md']).toBe('tab');
        expect(byPath['/a/recent-only.md']).toBe('recent');
        expect(byPath['/a/walk-only.md']).toBe('file');
        expect(merged).toHaveLength(3);
    });

    it('walk results remix after open and preserve selection by path', async () => {
        const mod = await init();
        mod.openPalette();
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        // Select second tab (by ArrowDown)
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown', bubbles: true, cancelable: true,
        }));
        const list = document.getElementById('cmd-palette-list')!;
        let active = list.querySelector('.cmd-palette-item.active') as HTMLElement;
        const selectedPath = active.getAttribute('data-path');
        expect(selectedPath).toBeTruthy();

        // Inject walk files including new path
        mod.applyWalkResultForTests(
            [
                { path: '/vault/walk/extra.md', name: 'extra.md', relative: 'extra.md' },
                { path: '/vault/notes/readme.md', name: 'readme.md', relative: 'notes/readme.md' },
            ],
            false,
        );

        // Selection still on same path
        active = list.querySelector('.cmd-palette-item.active') as HTMLElement;
        expect(active.getAttribute('data-path')).toBe(selectedPath);
        // Walk file appears
        const labels = Array.from(list.querySelectorAll('.cmd-palette-label'))
            .map((el) => el.textContent);
        expect(labels).toContain('extra.md');
        // Walk file badge
        const walkItem = Array.from(list.querySelectorAll('.cmd-palette-item'))
            .find((el) => el.getAttribute('data-path') === '/vault/walk/extra.md')!;
        expect(walkItem.getAttribute('data-source')).toBe('file');
    });

    it('Enter on walk file calls openDocument; Ctrl+Enter calls tab_open', async () => {
        const mod = await init();
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [{ id: 1, path: '/other.md', dirty: false, active: true }],
        });
        mod.openPalette();
        mod.applyWalkResultForTests(
            [{ path: '/vault/walk/extra.md', name: 'extra.md', relative: 'extra.md' }],
            false,
        );
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = 'extra';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        const list = document.getElementById('cmd-palette-list')!;
        expect(list.querySelectorAll('.cmd-palette-item').length).toBe(1);

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(openDocument).toHaveBeenCalledWith('/vault/walk/extra.md');
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'tab_open',
            expect.anything(),
        );

        // reopen for Ctrl+Enter
        openDocument.mockClear();
        tauri.invoke.mockClear();
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'palette_files') {
                return Promise.resolve({ files: [], truncated: false });
            }
            return Promise.resolve(undefined);
        });
        mod.openPalette();
        mod.applyWalkResultForTests(
            [{ path: '/vault/walk/extra.md', name: 'extra.md', relative: 'extra.md' }],
            false,
        );
        input.value = 'extra';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true, ctrlKey: true,
        }));
        expect(tauri.invoke).toHaveBeenCalledWith(
            'tab_open',
            expect.objectContaining({ path: '/vault/walk/extra.md' }),
        );
        expect(openDocument).not.toHaveBeenCalled();
    });

    it('Ctrl+Click on file row calls tab_open', async () => {
        const mod = await init();
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [{ id: 1, path: '/other.md', dirty: false, active: true }],
        });
        mod.openPalette();
        mod.applyWalkResultForTests(
            [{ path: '/vault/walk/extra.md', name: 'extra.md', relative: 'extra.md' }],
            false,
        );
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = 'extra';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const item = document.querySelector('.cmd-palette-item') as HTMLElement;
        item.dispatchEvent(new MouseEvent('click', {
            bubbles: true, ctrlKey: true,
        }));
        expect(tauri.invoke).toHaveBeenCalledWith(
            'tab_open',
            expect.objectContaining({ path: '/vault/walk/extra.md' }),
        );
    });

    it('# mode lists TOC headings and Enter invokes toc_click', async () => {
        mountDom({
            toc: `
              <li class="entry h1" data-level="1" data-slug="intro"><span class="text">Intro</span></li>
              <li class="entry h2" data-level="2" data-slug="details"><span class="text">Details</span></li>
            `,
        });
        await seedDeCatalog();
        const mod = await init();
        mod.openPalette('#');
        const list = document.getElementById('cmd-palette-list')!;
        const labels = Array.from(list.querySelectorAll('.cmd-palette-label'))
            .map((el) => el.textContent);
        expect(labels).toEqual(expect.arrayContaining(['Intro', 'Details']));

        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = '#Det';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(list.querySelectorAll('.cmd-palette-item').length).toBe(1);
        expect(list.querySelector('.cmd-palette-label')!.textContent).toBe('Details');
        expect(list.querySelector('.cp-hit')).not.toBeNull();

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(tauri.invoke).toHaveBeenCalledWith(
            'toc_click',
            expect.objectContaining({ anchor: 'details' }),
        );
    });

    it('# mode shows not-markdown hint for non-md docs', async () => {
        document.body.className = 'kind-text view-mode';
        await init();
        (window as any).__folioOpenPalette('#');
        const list = document.getElementById('cmd-palette-list')!;
        expect(list.querySelector('.cmd-palette-item')).toBeNull();
        expect(list.textContent).toMatch(/Markdown/i);
    });

    it('shows truncated walk hint', async () => {
        const mod = await init();
        mod.openPalette();
        mod.applyWalkResultForTests(
            [{ path: '/a.md', name: 'a.md', relative: 'a.md' }],
            true,
        );
        const list = document.getElementById('cmd-palette-list')!;
        expect(list.textContent).toMatch(/gekürzt|truncated|Kürzung|verfeinern/i);
    });

    it('includes recent rows from vault DOM with recent badge', async () => {
        mountDom({
            recent: `<li class="node" data-kind="file" data-path="/vault/recent/foo.md">
              <div class="row"><span class="label">foo.md</span></div>
            </li>`,
        });
        await seedDeCatalog();
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [{ id: 1, path: '/other.md', dirty: false, active: true }],
        });
        const mod = await init();
        mod.openPalette();
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = 'foo';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const item = document.querySelector('.cmd-palette-item') as HTMLElement;
        expect(item).toBeTruthy();
        expect(item.getAttribute('data-source')).toBe('recent');
        expect(item.querySelector('.cmd-palette-badge')!.textContent)
            .toMatch(/Zuletzt|Recent/i);
    });
});
