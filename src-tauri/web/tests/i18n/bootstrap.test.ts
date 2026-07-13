import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import {
    __resetEventQueueForTests,
    __getRegisteredHandlerCount,
    installListenPatch,
    installPreAdapters,
    drainUntilDryAndGoLive,
    setBootstrapPhase,
    getBootstrapPhase,
    getQueueSnapshot,
    enqueue,
    BOOT_EVENT_NAMES,
} from '../../app/i18n/event-queue';

describe('bootstrap event queue', () => {
    let mock: ReturnType<typeof installTauriMock>;

    beforeEach(() => {
        mock = installTauriMock();
        __resetEventQueueForTests();
        installListenPatch();
    });

    it('BOOT_EVENT_NAMES covers core surfaces', () => {
        expect(BOOT_EVENT_NAMES).toContain('cli:open');
        expect(BOOT_EVENT_NAMES).toContain('document:loaded');
        expect(BOOT_EVENT_NAMES).toContain('tabs:changed');
        expect(BOOT_EVENT_NAMES).toContain('automation:click');
        expect(BOOT_EVENT_NAMES).toContain('menu:file_open');
        expect(BOOT_EVENT_NAMES).toContain('search:hits');
    });

    it('pre-adapters queue events until uiReady drain', async () => {
        await installPreAdapters();
        setBootstrapPhase('booting');

        const real = vi.fn();
        await window.__TAURI__!.event.listen('document:loaded', real);

        mock.emitEvent('document:loaded', { path: '/a.md' });
        expect(getQueueSnapshot()).toEqual([
            { event: 'document:loaded', payload: { path: '/a.md' } },
        ]);
        expect(real).not.toHaveBeenCalled();

        await drainUntilDryAndGoLive();
        expect(getBootstrapPhase()).toBe('uiReady');
        expect(real).toHaveBeenCalledTimes(1);
        expect(real.mock.calls[0]![0]).toEqual({ payload: { path: '/a.md' } });
        expect(getQueueSnapshot()).toEqual([]);

        mock.emitEvent('document:loaded', { path: '/b.md' });
        expect(real).toHaveBeenCalledTimes(2);
    });

    it('F1: mid-drain events are delivered once and in order', async () => {
        await installPreAdapters();
        setBootstrapPhase('i18nReady');

        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(function (resolve) {
            release = resolve;
        });

        await window.__TAURI__!.event.listen('document:loaded', async function (e: any) {
            const path = e.payload && e.payload.path;
            order.push('start:' + path);
            if (path === '/a') {
                // Emit a second event while the first handler is still draining.
                mock.emitEvent('document:loaded', { path: '/b' });
                await gate;
            }
            order.push('end:' + path);
        });

        mock.emitEvent('document:loaded', { path: '/a' });
        expect(getQueueSnapshot()).toHaveLength(1);

        const drainP = drainUntilDryAndGoLive();
        // Let the first handler run until it awaits the gate.
        await vi.waitFor(function () {
            expect(order).toContain('start:/a');
        });
        // /b must have been enqueued by the pre-adapter (phase still not uiReady).
        expect(getQueueSnapshot().some(function (q) {
            return q.event === 'document:loaded' && (q.payload as any).path === '/b';
        })).toBe(true);

        release();
        await drainP;

        expect(order).toEqual(['start:/a', 'end:/a', 'start:/b', 'end:/b']);
        expect(getBootstrapPhase()).toBe('uiReady');
        expect(getQueueSnapshot()).toEqual([]);
    });

    it('F4: unlisten removes handler from registry', async () => {
        const handler = vi.fn();
        const unlisten = await window.__TAURI__!.event.listen('tabs:changed', handler);
        expect(__getRegisteredHandlerCount()).toBe(1);
        unlisten();
        expect(__getRegisteredHandlerCount()).toBe(0);
    });

    it('enqueue overflow drops oldest', () => {
        for (let i = 0; i < 300; i++) {
            enqueue('x', i);
        }
        const snap = getQueueSnapshot();
        expect(snap.length).toBeLessThanOrEqual(256);
        expect(snap[snap.length - 1]!.payload).toBe(299);
    });

    it('phase transitions', () => {
        expect(getBootstrapPhase()).toBe('booting');
        setBootstrapPhase('i18nReady');
        expect(getBootstrapPhase()).toBe('i18nReady');
        setBootstrapPhase('uiReady');
        expect(getBootstrapPhase()).toBe('uiReady');
    });
});
