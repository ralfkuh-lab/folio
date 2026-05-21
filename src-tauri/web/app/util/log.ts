/* Frontend → Backend Log-Bruecke.
   Schreibt strukturierte Eintraege ins `tracing`-Logfile (target
   `folio::frontend`), gefiltert ueber das `logLevel`-Setting im
   Backend. Im Browser-Test-Setup (ohne `window.__TAURI__`) ist das
   ein No-op — die Tests sollen nicht versuchen, den Backend-Pfad zu
   triggern.

   Aufrufkonvention:
       folioLog.warn('view', 'code colorize failed', { lang, error: String(err) });

   - `source`: kurzer Sub-Namespace (view, vault, editor, ipc, …),
     landet im `source`-Feld der Trace-Zeile.
   - `message`: kurzer, lesbarer Text.
   - `fields` (optional): JSON-serialisierbares Objekt; Errors als
     `String(err)` uebergeben, damit `Error.toString()` greift und
     die Message im Logfile lesbar ist.

   Errors aus `invoke('frontend_log', …)` werden bewusst geschluckt —
   ein gescheiteter Log-Roundtrip darf den aufrufenden Pfad nicht
   killen, und sich selbst zu loggen waere ein Schleifenrisiko. Die
   einzige Diagnose-Sichtbarkeit fuer einen gebrochenen Bridge-Pfad
   ist dann ein direktes `console.warn` im Catch.
*/

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

function invokeCommand(): ((cmd: string, args?: any) => Promise<any>) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

function send(level: LogLevel, source: string, message: string, fields?: Record<string, any>): void {
    const invoke = invokeCommand();
    if (!invoke) return;
    try {
        invoke('frontend_log', { level, source, message, fields: fields || null }).catch((err) => {
            // Bridge selbst ist kaputt — nur einmal in DevTools mecker'n,
            // nicht erneut ueber die Bridge schicken.
            try { console.warn('folioLog bridge failed:', err); } catch (_) { /* ignore */ }
        });
    } catch (err) {
        try { console.warn('folioLog bridge threw:', err); } catch (_) { /* ignore */ }
    }
}

export const folioLog = {
    error: (source: string, message: string, fields?: Record<string, any>) =>
        send('error', source, message, fields),
    warn: (source: string, message: string, fields?: Record<string, any>) =>
        send('warn', source, message, fields),
    info: (source: string, message: string, fields?: Record<string, any>) =>
        send('info', source, message, fields),
    debug: (source: string, message: string, fields?: Record<string, any>) =>
        send('debug', source, message, fields),
    trace: (source: string, message: string, fields?: Record<string, any>) =>
        send('trace', source, message, fields),
};

/**
 * Wrapper um `invoke()` mit standardisiertem Fail-Logging.
 *
 * Ersatz fuer das verbreitete Anti-Pattern
 * `invoke('cmd', args).catch(() => {})`, das jeden Fehler stumm
 * schluckt. Mit `safeInvoke` landet ein gescheitertes IPC im
 * `tracing`-Logfile (Source `ipc`), und der Aufrufer entscheidet ueber
 * das Level — `warn` (Default) fuer User-sichtbare Operationen,
 * `debug` fuer hochfrequente State-Sync-Calls (menu_set_*,
 * set_window_title …) und `trace` fuer reine Best-Effort-Calls.
 *
 * Das zurueckgegebene Promise resolved auch im Fehlerfall (mit
 * `undefined`), damit Aufrufer das `.catch` nicht erneut schreiben
 * muessen. Wer den Return-Value braucht, casted im Aufruf-Pfad.
 */
export function safeInvoke<T = unknown>(
    cmd: string,
    args?: any,
    op?: string,
    level: LogLevel = 'warn',
): Promise<T | undefined> {
    const invoke = invokeCommand();
    if (!invoke) return Promise.resolve(undefined);
    return invoke(cmd, args).then(
        (value: any) => value as T,
        (err: unknown) => {
            send(level, 'ipc', op || cmd, { cmd, error: String(err) });
            return undefined;
        },
    );
}
