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

   ----- Vorab-Filterung -----
   Pro Aufruf wuerde ein gescheiterter Log-Event sonst auch dann eine
   Tauri-Invoke-Roundtrip ausloesen, wenn das Backend ihn anschliessend
   verwirft (z. B. Trace bei `logLevel=info`). `cachedLogLevel` cached
   das aktuelle Setting; `settings:changed`-Events halten den Cache
   aktuell, ohne dass log.ts eine Abhaengigkeit zu settings-dialog.ts
   braucht.

   Limit: `cachedLogLevel` kennt nur das **Setting**, nicht
   `RUST_LOG`-Overrides. Devs, die per `RUST_LOG=folio=trace` Traces
   aktivieren, muessen zusaetzlich in DevTools
   `window.__folioSetLogLevel('trace')` ausfuehren, sonst werden die
   Trace-Aufrufe schon frontend-seitig verworfen. Dokumentiert in
   CLAUDE.md → "Frontend-Logging".
*/

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_RANK: Record<LogLevel, number> = {
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
};
// `off` ist kein Frontend-Level; das Backend-Setting "off" mappt
// frontend-seitig auf `cachedLogLevel = 'error'` mit zusaetzlichem
// `cachedSilent = true`, damit auch errors stumm bleiben.
let cachedLogLevel: LogLevel = 'info';
let cachedSilent = false;

function invokeCommand(): ((cmd: string, args?: any) => Promise<any>) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

function isEnabled(level: LogLevel): boolean {
    if (cachedSilent) return false;
    return LEVEL_RANK[level] <= LEVEL_RANK[cachedLogLevel];
}

/**
 * Setter fuer das Frontend-Filter-Level. Wird vom `settings:changed`-
 * Listener intern verwendet und ist als `window.__folioSetLogLevel`
 * auch fuer DevTools verfuegbar — damit kann man Trace-Diagnose
 * aktivieren, ohne den UI-Setting-Wechsel zu triggern.
 *
 * Werte: `'off'` (alles stumm) oder eines der `LogLevel`-Strings.
 */
export function setFrontendLogLevel(level: LogLevel | 'off'): void {
    if (level === 'off') {
        cachedSilent = true;
        return;
    }
    if (LEVEL_RANK[level] === undefined) return;
    cachedSilent = false;
    cachedLogLevel = level;
}

function send(level: LogLevel, source: string, message: string, fields?: Record<string, any>): void {
    if (!isEnabled(level)) return;
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

// ----- Initialisierung -----
// Lazy-init laeuft beim ersten Modul-Import (esbuild bundle-Init).
// Schritt 1: settings:changed abonnieren, damit Cache live nachfolgt.
// Schritt 2: `window.__folioSetLogLevel` als DevTools-Override
// exposen.
// Wir ziehen den initialen Wert NICHT proaktiv via settings_get —
// das macht settings-dialog.ts beim Boot ohnehin, und der
// settings:changed-Pfad wuerde uns sonst doppelt anrufen.
(function initFrontendLogger(): void {
    if (typeof window === 'undefined') return;
    (window as any).__folioSetLogLevel = setFrontendLogLevel;
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;
    try {
        ev.listen('settings:changed', function (event: any) {
            const payload = (event && event.payload) || {};
            const settings = payload.settings;
            if (!settings || typeof settings !== 'object') return;
            const next = settings.logLevel;
            if (typeof next === 'string') {
                setFrontendLogLevel(next as LogLevel | 'off');
            }
        });
    } catch (_) { /* ignore — tests installieren u.U. keinen echten listen */ }
})();

/**
 * Setzt den gecachten Log-Level **aus einem bereits geladenen
 * Settings-Snapshot**. settings-dialog.ts ruft das nach erfolgreichem
 * `settings_get`/`settings_update`, damit der Cache auch dann stimmt,
 * wenn `settings:changed` zwischendurch nicht feuert (z. B. erster
 * Boot vor dem ersten Patch).
 */
export function applyLogLevelFromSettings(value: unknown): void {
    if (typeof value !== 'string') return;
    setFrontendLogLevel(value as LogLevel | 'off');
}

// Test-Hook: nur fuer Vitest, damit jeder Test mit einem definierten
// Filter-State startet. NICHT fuer Production gedacht.
export function __resetFrontendLogStateForTests(): void {
    cachedLogLevel = 'info';
    cachedSilent = false;
}
