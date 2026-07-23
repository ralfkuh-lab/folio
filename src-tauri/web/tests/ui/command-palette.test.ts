import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const activateTab = vi.fn().mockResolvedValue(true);
const getTabsSnapshot = vi.fn();
const openDocument = vi.fn().mockResolvedValue(true);
const restoreLastTab = vi.fn();
const getIsDirty = vi.fn().mockReturnValue(false);

vi.mock('../../app/state/tabs', () => ({
    activateTab,
    getTabsSnapshot,
    restoreLastTab,
}));

vi.mock('../../app/state/document', () => ({
    openDocument,
    getIsDirty,
}));

let tauri: TauriMockHandles;

function mountDom(opts?: { toc?: string }): void {
    document.body.className = 'kind-markdown view-mode';
    document.body.innerHTML = `
      <button id="prev-focus" type="button">focus</button>
      <div id="unsaved-dialog" hidden>
        <div class="unsaved-dialog__panel" role="dialog" aria-modal="true"></div>
      </div>
      <div id="settings-dialog" hidden>
        <div class="settings-dialog__panel" role="region"></div>
        <div id="theme-create-dialog" class="settings-ai-overlay" hidden>
          <form id="theme-create-form" class="settings-ai-dialog" role="dialog" aria-modal="true"></form>
        </div>
      </div>
      <aside id="toc-region">
        <ul class="toc">${opts?.toc || ''}</ul>
      </aside>
      <div id="cmd-palette" hidden>
        <div class="cmd-palette-backdrop"></div>
        <div class="cmd-palette-panel" role="dialog" aria-modal="true">
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

function defaultInvoke(cmd: string) {
    if (cmd === 'palette_files') {
        return Promise.resolve({ files: [], truncated: false });
    }
    if (cmd === 'workspace_get') {
        return Promise.resolve({ recent: [], pinned: [] });
    }
    return Promise.resolve(undefined);
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
    getIsDirty.mockReturnValue(false);
    getTabsSnapshot.mockReturnValue(snapTabs());
    tauri.invoke.mockImplementation(defaultInvoke);
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

    it('does not open when top-level modal is visible (FXP2)', async () => {
        await init();
        document.getElementById('unsaved-dialog')!.hidden = false;
        (window as any).__folioOpenPalette();
        expect(document.getElementById('cmd-palette')!.hidden).toBe(true);
    });

    it('does not open when nested settings dialog is visible (FXP2)', async () => {
        await init();
        // Settings region selbst ist kein Modal; nested theme-create ist es
        document.getElementById('settings-dialog')!.hidden = false;
        document.getElementById('theme-create-dialog')!.hidden = false;
        (window as any).__folioOpenPalette();
        expect(document.getElementById('cmd-palette')!.hidden).toBe(true);
    });

    it('opens when no modal is visible', async () => {
        await init();
        (window as any).__folioOpenPalette();
        expect(document.getElementById('cmd-palette')!.hidden).toBe(false);
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

    it('__folioClosePalette closes an open palette', async () => {
        await init();
        (window as any).__folioOpenPalette();
        expect(document.getElementById('cmd-palette')!.hidden).toBe(false);
        (window as any).__folioClosePalette();
        expect(document.getElementById('cmd-palette')!.hidden).toBe(true);
        expect(document.body.classList.contains('palette-open')).toBe(false);
    });
});

describe('command palette FXP1 — merge relative enrich', () => {
    it('mergeFileCandidates enriches tab/recent with walk relative', async () => {
        const { mergeFileCandidates } = await import('../../app/ui/command-palette');
        const merged = mergeFileCandidates(
            [{ path: '/vault/docs/guide.md', tabId: 3 }],
            [
                { path: '/vault/docs/other.md', name: 'other.md', relative: 'other.md' },
            ],
            [
                { path: '/vault/docs/guide.md', name: 'guide.md', relative: 'docs/guide.md' },
                { path: '/vault/docs/other.md', name: 'other.md', relative: 'docs/other.md' },
                { path: '/vault/walk/extra.md', name: 'extra.md', relative: 'extra.md' },
            ],
        );
        const guide = merged.find((m) => m.path === '/vault/docs/guide.md')!;
        expect(guide.source).toBe('tab');
        expect(guide.tabId).toBe(3);
        expect(guide.relative).toBe('docs/guide.md');

        const other = merged.find((m) => m.path === '/vault/docs/other.md')!;
        expect(other.source).toBe('recent');
        expect(other.relative).toBe('docs/other.md');

        const walk = merged.find((m) => m.path === '/vault/walk/extra.md')!;
        expect(walk.source).toBe('file');
    });

    it('tab stays findable via path segment before walk; after walk via relative', async () => {
        const mod = await init();
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [{ id: 3, path: '/vault/docs/guide.md', dirty: false, active: true }],
        });
        mod.openPalette();
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;

        // Vor Walk: Query "docs" matcht Vollpfad
        input.value = 'docs';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        let items = document.querySelectorAll('#cmd-palette-list .cmd-palette-item');
        expect(items.length).toBe(1);
        expect(items[0].getAttribute('data-source')).toBe('tab');

        // Walk enrich — bleibt Tab-Badge, relative docs/guide.md
        mod.applyWalkResultForTests(
            [{ path: '/vault/docs/guide.md', name: 'guide.md', relative: 'docs/guide.md' }],
            false,
        );
        items = document.querySelectorAll('#cmd-palette-list .cmd-palette-item');
        expect(items.length).toBe(1);
        expect(items[0].getAttribute('data-source')).toBe('tab');
        expect(items[0].querySelector('.cmd-palette-detail')!.textContent)
            .toContain('docs/guide.md');
    });
});

describe('command palette FXP3 — workspace_get recents', () => {
    it('loads recents via workspace_get not DOM', async () => {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'palette_files') {
                return Promise.resolve({ files: [], truncated: false });
            }
            if (cmd === 'workspace_get') {
                return Promise.resolve({
                    recent: [{ path: '/vault/recent/foo.md', last_opened: 1 }],
                    pinned: [],
                });
            }
            return Promise.resolve(undefined);
        });
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [{ id: 1, path: '/other.md', dirty: false, active: true }],
        });
        const mod = await init();
        mod.openPalette();
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('workspace_get');
            expect(tauri.invoke).toHaveBeenCalledWith('palette_files');
        });
        await vi.waitFor(() => {
            const state = mod.getWalkStateForTests();
            expect(state.recents.some((r) => r.path.endsWith('foo.md'))).toBe(true);
        });
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = 'foo';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const item = document.querySelector('.cmd-palette-item') as HTMLElement;
        expect(item).toBeTruthy();
        expect(item.getAttribute('data-source')).toBe('recent');
    });
});

describe('command palette FXP7 — stale promise + empty truncated', () => {
    it('stale palette_files response after close/reopen is ignored', async () => {
        let resolveWalk: ((v: unknown) => void) | null = null;
        const slowWalk = new Promise((resolve) => {
            resolveWalk = resolve;
        });
        let call = 0;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'workspace_get') {
                return Promise.resolve({ recent: [], pinned: [] });
            }
            if (cmd === 'palette_files') {
                call += 1;
                if (call === 1) return slowWalk;
                return Promise.resolve({
                    files: [{ path: '/new.md', name: 'new.md', relative: 'new.md' }],
                    truncated: false,
                });
            }
            return Promise.resolve(undefined);
        });
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [{ id: 1, path: '/a.md', dirty: false, active: true }],
        });
        const mod = await init();
        mod.openPalette();
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = 'zzz';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        mod.closePalette();
        mod.openPalette();
        // Zweiter Open lädt fresh
        await vi.waitFor(() => {
            const st = mod.getWalkStateForTests();
            return st.files.some((f) => f.path === '/new.md');
        });
        const genAfter = mod.getWalkStateForTests().sourcesGen;

        // Alte langsame Antwort löst auf — darf nichts ändern
        resolveWalk!({
            files: [{ path: '/stale.md', name: 'stale.md', relative: 'stale.md' }],
            truncated: false,
        });
        await Promise.resolve();
        await Promise.resolve();
        const st = mod.getWalkStateForTests();
        expect(st.sourcesGen).toBe(genAfter);
        expect(st.files.some((f) => f.path === '/stale.md')).toBe(false);
        expect(st.files.some((f) => f.path === '/new.md')).toBe(true);
    });

    it('empty results + truncated shows noResults AND truncated hint', async () => {
        const mod = await init();
        getTabsSnapshot.mockReturnValue({
            activeIndex: 0,
            recentlyClosedCount: 0,
            tabs: [],
        });
        mod.openPalette();
        mod.applyWalkResultForTests([], true);
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.value = 'no-match-xyz';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const list = document.getElementById('cmd-palette-list')!;
        expect(list.querySelector('.cmd-palette-empty')).not.toBeNull();
        expect(list.querySelector('.cmd-palette-empty')!.textContent)
            .toMatch(/Keine Treffer|No matches/i);
        expect(list.querySelector('.cmd-palette-hint')).not.toBeNull();
        expect(list.textContent).toMatch(/gekürzt|truncated|verfeinern/i);
    });
});

describe('command palette P2 leftovers', () => {
    it('walk results remix after open and preserve selection by path', async () => {
        const mod = await init();
        mod.openPalette();
        const input = document.getElementById('cmd-palette-input') as HTMLInputElement;
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown', bubbles: true, cancelable: true,
        }));
        const list = document.getElementById('cmd-palette-list')!;
        let active = list.querySelector('.cmd-palette-item.active') as HTMLElement;
        const selectedPath = active.getAttribute('data-path');
        expect(selectedPath).toBeTruthy();

        mod.applyWalkResultForTests(
            [
                { path: '/vault/walk/extra.md', name: 'extra.md', relative: 'extra.md' },
                { path: '/vault/notes/readme.md', name: 'readme.md', relative: 'notes/readme.md' },
            ],
            false,
        );

        active = list.querySelector('.cmd-palette-item.active') as HTMLElement;
        expect(active.getAttribute('data-path')).toBe(selectedPath);
        const labels = Array.from(list.querySelectorAll('.cmd-palette-label'))
            .map((el) => el.textContent);
        expect(labels).toContain('extra.md');
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

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(openDocument).toHaveBeenCalledWith('/vault/walk/extra.md');

        openDocument.mockClear();
        tauri.invoke.mockClear();
        tauri.invoke.mockImplementation(defaultInvoke);
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
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(tauri.invoke).toHaveBeenCalledWith(
            'toc_click',
            expect.objectContaining({ anchor: 'details' }),
        );
    });

    it('# mode keeps document order instead of sorting alphabetically', async () => {
        mountDom({
            toc: `
              <li class="entry h1" data-level="1" data-slug="zebra"><span class="text">Zebra</span></li>
              <li class="entry h2" data-level="2" data-slug="mitte"><span class="text">Mitte</span></li>
              <li class="entry h2" data-level="2" data-slug="anfang"><span class="text">Anfang</span></li>
            `,
        });
        await seedDeCatalog();
        const mod = await init();
        mod.openPalette('#');
        const list = document.getElementById('cmd-palette-list')!;
        const labels = Array.from(list.querySelectorAll('.cmd-palette-label'))
            .map((el) => el.textContent);
        expect(labels).toEqual(['Zebra', 'Mitte', 'Anfang']);
    });

    it('# mode shows not-markdown hint for non-md docs', async () => {
        document.body.className = 'kind-text view-mode';
        await init();
        (window as any).__folioOpenPalette('#');
        const list = document.getElementById('cmd-palette-list')!;
        expect(list.querySelector('.cmd-palette-item')).toBeNull();
        expect(list.textContent).toMatch(/Markdown/i);
    });
});
