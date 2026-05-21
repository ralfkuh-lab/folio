import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { folioLog, safeInvoke } from '../../app/util/log';

describe('util/log', () => {
    beforeEach(() => {
        installTauriMock();
    });

    it('folioLog.warn ruft frontend_log mit Level, Source und Message', () => {
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        folioLog.warn('view', 'code colorize failed', { lang: 'json', error: 'boom' });
        expect(invoke).toHaveBeenCalledTimes(1);
        const args = invoke.mock.calls[0]!;
        expect(args[0]).toBe('frontend_log');
        expect(args[1]).toEqual({
            level: 'warn',
            source: 'view',
            message: 'code colorize failed',
            fields: { lang: 'json', error: 'boom' },
        });
    });

    it('folioLog ohne fields setzt fields=null', () => {
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        folioLog.info('boot', 'init complete');
        expect(invoke.mock.calls[0]![1].fields).toBeNull();
    });

    it('safeInvoke resolved mit undefined bei Reject und loggt den Fehler', async () => {
        const invoke = vi.fn()
            .mockImplementationOnce(() => Promise.reject(new Error('rpc down')))  // erster Aufruf: target command
            .mockResolvedValue(undefined);                                          // zweiter Aufruf: frontend_log
        (window as any).__TAURI__.core.invoke = invoke;

        const result = await safeInvoke('set_view_mode', { mode: 'edit' }, 'set view mode');
        expect(result).toBeUndefined();
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(invoke.mock.calls[0]![0]).toBe('set_view_mode');
        expect(invoke.mock.calls[1]![0]).toBe('frontend_log');
        const logArgs = invoke.mock.calls[1]![1];
        expect(logArgs.level).toBe('warn');
        expect(logArgs.source).toBe('ipc');
        expect(logArgs.fields.cmd).toBe('set_view_mode');
        expect(String(logArgs.fields.error)).toContain('rpc down');
    });

    it('safeInvoke reicht erfolgreiche Return-Werte durch', async () => {
        const invoke = vi.fn().mockResolvedValue({ ok: true });
        (window as any).__TAURI__.core.invoke = invoke;

        const result = await safeInvoke('read_file', { path: '/tmp/x.md' });
        expect(result).toEqual({ ok: true });
        // Bei Erfolg: kein frontend_log.
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('safeInvoke respektiert das gewuenschte Log-Level', async () => {
        const invoke = vi.fn()
            .mockImplementationOnce(() => Promise.reject(new Error('cosmetic')))
            .mockResolvedValue(undefined);
        (window as any).__TAURI__.core.invoke = invoke;

        await safeInvoke('menu_set_checked', { id: 'x' }, 'menu_set_checked x', 'debug');
        expect(invoke.mock.calls[1]![1].level).toBe('debug');
    });

    it('No-op ohne __TAURI__ — kein Throw', () => {
        delete (window as any).__TAURI__;
        expect(() => folioLog.error('x', 'y')).not.toThrow();
        return safeInvoke('cmd', {}, 'op').then((r) => expect(r).toBeUndefined());
    });
});
