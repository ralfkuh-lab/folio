import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

let tauri: TauriMockHandles;
let fullscreen = false;
let backendZen = false;
let hintSeen = false;
let zenFullscreenSetting = false;
let getFullscreenDelayMs = 0;

function mountDom(): void {
    document.body.className = '';
    document.body.innerHTML = `
        <header id="toolbar"></header>
        <aside id="vault-region">
            <div id="vault-filter" hidden></div>
        </aside>
        <nav id="tab-bar"></nav>
        <footer id="statusbar"></footer>
        <div id="find-bar"></div>
        <nav id="context-menu"></nav>
        <nav id="tab-ctx-menu"></nav>
        <div id="cmd-palette" hidden></div>
        <div id="lang-picker" hidden></div>
        <nav id="ai-actions-fav-menu" hidden></nav>
        <div id="zen-hint" class="zen-hint" hidden></div>
    `;
}

function mockInvoke(): void {
    tauri.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'zen_hint_seen_get') return hintSeen;
        if (cmd === 'set_zen_hint_seen') {
            hintSeen = true;
            return undefined;
        }
        if (cmd === 'settings_get') return { zenFullscreen: zenFullscreenSetting };
        if (cmd === 'get_fullscreen') {
            if (getFullscreenDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, getFullscreenDelayMs));
            }
            return fullscreen;
        }
        if (cmd === 'set_fullscreen') {
            fullscreen = !!(args && args.enabled);
            return fullscreen;
        }
        if (cmd === 'set_zen_active') {
            backendZen = !!(args && args.active);
            return undefined;
        }
        return undefined;
    });
}

async function bootZen(): Promise<typeof import('../../app/ui/zen-mode')> {
    const mod = await import('../../app/ui/zen-mode');
    mod.__resetZenForTests();
    await mod.initZenMode();
    return mod;
}

describe('ui/zen-mode', () => {
    beforeEach(async () => {
        fullscreen = false;
        backendZen = false;
        hintSeen = false;
        zenFullscreenSetting = false;
        getFullscreenDelayMs = 0;
        tauri = installTauriMock();
        mockInvoke();
        await seedDeCatalog();
        mountDom();
        const { __resetZenForTests, initZenMode } = await import('../../app/ui/zen-mode');
        __resetZenForTests();
        await initZenMode();
    });

    afterEach(async () => {
        const { __resetZenForTests } = await import('../../app/ui/zen-mode');
        __resetZenForTests();
        document.body.className = '';
        document.body.innerHTML = '';
    });

    it('toggle sets and removes the zen-mode body class', async () => {
        const { setZenMode, isZenMode, toggleZenMode } = await import('../../app/ui/zen-mode');
        expect(isZenMode()).toBe(false);
        expect(document.body.classList.contains('zen-mode')).toBe(false);

        await setZenMode(true);
        expect(isZenMode()).toBe(true);
        expect(document.body.classList.contains('zen-mode')).toBe(true);
        expect(backendZen).toBe(true);

        await toggleZenMode();
        expect(isZenMode()).toBe(false);
        expect(document.body.classList.contains('zen-mode')).toBe(false);
        expect(backendZen).toBe(false);
    });

    it('Escape via document capture leaves zen when no overlay is open', async () => {
        const { setZenMode, isZenMode } = await import('../../app/ui/zen-mode');
        await setZenMode(true);
        const findBar = document.getElementById('find-bar')!;
        findBar.classList.add('open');

        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        await vi.waitFor(() => {
            expect(isZenMode()).toBe(true);
        });

        findBar.classList.remove('open');
        const ev = new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        });
        const stopped = document.dispatchEvent(ev);
        expect(stopped).toBe(false);
        await vi.waitFor(() => {
            expect(isZenMode()).toBe(false);
        });
        expect(document.body.classList.contains('zen-mode')).toBe(false);
    });

    it('hidden vault filter does not steal Escape in zen', async () => {
        const { setZenMode, isZenMode, hasPriorityEscapeTarget } = await import('../../app/ui/zen-mode');
        const region = document.getElementById('vault-region')!;
        const filter = document.getElementById('vault-filter')!;
        filter.hidden = false;
        region.style.display = 'none';
        await setZenMode(true);

        expect(hasPriorityEscapeTarget()).toBe(false);
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        await vi.waitFor(() => {
            expect(isZenMode()).toBe(false);
        });
    });

    it('exit hint appears only on the first activation', async () => {
        const { setZenMode } = await import('../../app/ui/zen-mode');
        const hint = document.getElementById('zen-hint')!;
        expect(hint.hidden).toBe(true);

        await setZenMode(true);
        expect(hint.hidden).toBe(false);
        expect(hint.textContent).toContain('Escape');
        expect(tauri.invoke).toHaveBeenCalledWith('set_zen_hint_seen', { seen: true });

        await setZenMode(false);
        expect(hint.hidden).toBe(true);

        await setZenMode(true);
        expect(hint.hidden).toBe(true);
    });

    it('visible lang-picker blocks Escape', async () => {
        const { setZenMode, isZenMode, hasPriorityEscapeTarget } = await import('../../app/ui/zen-mode');
        await setZenMode(true);
        const picker = document.getElementById('lang-picker')!;
        picker.hidden = false;
        expect(hasPriorityEscapeTarget()).toBe(true);
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        await Promise.resolve();
        expect(isZenMode()).toBe(true);
        picker.hidden = true;
    });

    it('exit hint stays off when zen_hint_seen_get is already true', async () => {
        hintSeen = true;
        const { setZenMode } = await bootZen();
        const hint = document.getElementById('zen-hint')!;
        await setZenMode(true);
        expect(hint.hidden).toBe(true);
        expect(tauri.invoke.mock.calls.some((c) => c[0] === 'set_zen_hint_seen')).toBe(false);
    });
});

describe('ui/zen-mode — fullscreen ownership', () => {
    beforeEach(async () => {
        fullscreen = false;
        backendZen = false;
        hintSeen = true;
        zenFullscreenSetting = true;
        getFullscreenDelayMs = 0;
        tauri = installTauriMock();
        mockInvoke();
        await seedDeCatalog();
        mountDom();
        const { __resetZenForTests, initZenMode } = await import('../../app/ui/zen-mode');
        __resetZenForTests();
        await initZenMode();
    });

    afterEach(async () => {
        const { __resetZenForTests } = await import('../../app/ui/zen-mode');
        __resetZenForTests();
        document.body.className = '';
        document.body.innerHTML = '';
    });

    it('does not take ownership when the window is already fullscreen', async () => {
        fullscreen = true;
        const { setZenMode } = await import('../../app/ui/zen-mode');
        await setZenMode(true);
        expect(fullscreen).toBe(true);
        expect(tauri.invoke.mock.calls.some((c) => c[0] === 'set_fullscreen' && c[1]?.enabled === true)).toBe(false);

        await setZenMode(false);
        expect(fullscreen).toBe(true);
        expect(tauri.invoke.mock.calls.some((c) => c[0] === 'set_fullscreen' && c[1]?.enabled === false)).toBe(false);
    });

    it('takes ownership without prior fullscreen and restores on exit', async () => {
        const { setZenMode } = await import('../../app/ui/zen-mode');
        await setZenMode(true);
        expect(fullscreen).toBe(true);
        expect(tauri.invoke).toHaveBeenCalledWith('set_fullscreen', { enabled: true });

        await setZenMode(false);
        expect(fullscreen).toBe(false);
        expect(tauri.invoke).toHaveBeenCalledWith('set_fullscreen', { enabled: false });
    });

    it('overlapping toggles leave no leftover fullscreen', async () => {
        getFullscreenDelayMs = 30;
        const { setZenMode, isZenMode } = await import('../../app/ui/zen-mode');
        const enter = setZenMode(true);
        const leave = setZenMode(false);
        await Promise.all([enter, leave]);
        expect(isZenMode()).toBe(false);
        expect(fullscreen).toBe(false);
        expect(backendZen).toBe(false);
    });
});
