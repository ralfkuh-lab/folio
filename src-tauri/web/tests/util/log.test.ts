import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import {
    __resetFrontendLogStateForTests,
    applyLogLevelFromSettings,
    folioLog,
    safeInvoke,
    setFrontendLogLevel,
} from '../../app/util/log';

describe('util/log', () => {
    beforeEach(() => {
        installTauriMock();
        // Default-Level fuer jeden Test neu setzen — sonst zieht ein
        // vorher gesetzter `off`-Filter durch und der naechste Test
        // sieht keine IPC-Aufrufe mehr.
        __resetFrontendLogStateForTests();
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

    it('safeInvoke reicht das gewuenschte Log-Level durch (Level >= cached)', async () => {
        // Damit das debug-Level den Frontend-Filter passiert, muss
        // `cachedLogLevel` mindestens 'debug' sein.
        setFrontendLogLevel('debug');
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

    it('filtert Events unterhalb des aktuellen Levels vorm IPC', () => {
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        setFrontendLogLevel('warn');
        folioLog.info('x', 'verworfen');
        folioLog.debug('x', 'verworfen');
        folioLog.trace('x', 'verworfen');
        expect(invoke).not.toHaveBeenCalled();

        folioLog.warn('x', 'durch');
        folioLog.error('x', 'durch');
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(invoke.mock.calls.map((c) => c[1].level)).toEqual(['warn', 'error']);
    });

    it('off-Setting macht ALLES stumm — auch error', () => {
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        setFrontendLogLevel('off');
        folioLog.error('x', 'kommt nicht durch');
        folioLog.warn('x', 'kommt nicht durch');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('applyLogLevelFromSettings ueberzaehlt unbekannte Werte', () => {
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        applyLogLevelFromSettings('garbage');
        // Default-Level ('info') bleibt — info-Event geht raus.
        folioLog.info('x', 'hi');
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('applyLogLevelFromSettings akzeptiert "off"', () => {
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        applyLogLevelFromSettings('off');
        folioLog.error('x', 'silenced');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('safeInvoke filtert sein eigenes Fehler-Log gegen cachedLevel', async () => {
        // Bei logLevel=info darf ein safeInvoke-Fehler mit
        // level='debug' nicht im IPC landen — der debug-Eintrag liegt
        // unter dem aktuellen Schwellwert.
        setFrontendLogLevel('info');
        const invoke = vi.fn()
            .mockImplementationOnce(() => Promise.reject(new Error('cosmetic')));
        (window as any).__TAURI__.core.invoke = invoke;

        await safeInvoke('menu_set_checked', { id: 'x' }, 'menu sync', 'debug');
        // Nur der eigentliche Command — kein zweites frontend_log.
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke.mock.calls[0]![0]).toBe('menu_set_checked');
    });

    it('window.__folioSetLogLevel ist als DevTools-Override exposed', () => {
        const setter = (window as any).__folioSetLogLevel;
        expect(typeof setter).toBe('function');
        setter('off');
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        folioLog.error('x', 'silenced');
        expect(invoke).not.toHaveBeenCalled();
    });
});
