/* Automation-API-Bridge fuer das Frontend. Listener:
   - `automation:click` (DOM-Lookup nach id / data-name / CSS-Selektor, dann `.click()`),
   - `automation:set_editor_text` (Editor-Text setzen + Dirty/Wordcount nachziehen),
   - `automation:set_editor_selection` (Selection im Monaco-Model setzen),
   - `automation:open_document` (Document-Open mit Frontend-Prompt-Pfad),
   - `automation:key` (synthetischer KeyboardEvent aufs Ziel, fuer
     preventDefault-Listener wie Strg+S/F3/Alt+Pfeil),
   - `automation:dom_query` (querySelector + Snapshot via
     `automation_dom_response`).

   Selektor-Fallback-Reihenfolge in `automation:click` ist Teil des
   Automation-Vertrags — siehe `docs/automation-contract.md`.

   `automation:key` dispatcht keydown+keyup an `document` (Default) oder
   ans Editor-Wrapper-Element. Monaco-eigene Shortcuts (Strg+Z, Tab-Indent)
   sind ueber synthetische Events fragil und sollen spaeter ueber einen
   separaten `POST /editor/command` mit `editor.trigger('keyboard', ...)`
   laufen — dieser Listener bedient nur DOM-Listener, die auf `keydown`
   reagieren (Find-Bar, Toolbar-Actions, Zoom, Dialogs).

   Ack-Semantik (Design in TODO.md / Codex-Synthese): Events mit
   `requestId` triggern nach Handler-Ende einen `invoke('automation_ack',
   {id})`-Call ueber den `ackHandler`-Wrapper. Wichtig: vor dem ACK ein
   Microtask-Flush + ein requestAnimationFrame abwarten, weil DOM-
   Mutationen + Listener-Kaskaden + Render sonst nicht durch sind. Das
   Backend wartet via tokio::oneshot bis zum Timeout (Default 1000 ms,
   per Query `?ackTimeoutMs` ueberschreibbar) und liefert
   `{ ok, acked, requestId }`. */

import {
    getCleanText,
    getCurrentPath,
    markDirty,
    openDocument,
    updateWordCount,
} from '../state/document';
import { loadEditorText } from '../editor/shell';

function keyToCode(key: string): string {
    if (key.length === 1) {
        var upper = key.toUpperCase();
        if (upper >= 'A' && upper <= 'Z') return 'Key' + upper;
        if (upper >= '0' && upper <= '9') return 'Digit' + upper;
        if (upper === ' ') return 'Space';
    }
    return key;
}

function keyToKeyCode(key: string): number {
    if (key.length === 1) {
        var upper = key.toUpperCase();
        if (upper >= 'A' && upper <= 'Z') return upper.charCodeAt(0);
        if (upper >= '0' && upper <= '9') return upper.charCodeAt(0);
        if (upper === ' ') return 32;
    }
    var named: Record<string, number> = {
        Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
        ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
        Home: 36, End: 35, PageUp: 33, PageDown: 34,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
        F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
    };
    return named[key] || 0;
}

function dispatchAutomationKey(data: any): void {
    var key = data && data.key;
    if (typeof key !== 'string' || key.length === 0) return;
    var mods = (data && data.modifiers) || {};
    var target = data && data.target;
    var init: KeyboardEventInit = {
        key: key,
        code: keyToCode(key),
        keyCode: keyToKeyCode(key),
        which: keyToKeyCode(key),
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
        metaKey: !!mods.meta,
        bubbles: true,
        cancelable: true,
        composed: true,
    } as KeyboardEventInit;
    var element: Element | Document = document;
    if (target === 'editor') {
        var host = document.getElementById('editor-mount')
            || document.querySelector('.monaco-editor')
            || document.body;
        element = host;
    }
    try {
        element.dispatchEvent(new KeyboardEvent('keydown', init));
        element.dispatchEvent(new KeyboardEvent('keyup', init));
    } catch (_) {}
}

function nextFrame(): Promise<void> {
    return new Promise(function (resolve) {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () { resolve(); });
        } else {
            // jsdom in Vitest hat evtl. kein rAF — Microtask
            // ist dann das Beste, was geht.
            Promise.resolve().then(resolve);
        }
    });
}

// Wrapper fuer ack-faehige Listener: fuehrt `work` aus, wartet einen
// Microtask + ein Frame ab und meldet danach ueber `automation_ack`
// zurueck. requestId fehlt → kein ACK (Backward-Compat). Fehler in `work`
// werden geschluckt — der Backend-Handler laeuft sonst nur ins Timeout.
export async function ackHandler(
    invoke: (cmd: string, args?: any) => Promise<any>,
    payload: any,
    work: () => unknown | Promise<unknown>,
): Promise<void> {
    try {
        await work();
    } catch (_) {}
    await Promise.resolve();
    await nextFrame();
    var id = payload && payload.requestId;
    if (typeof id === 'number') {
        try { await invoke('automation_ack', { id: id }); } catch (_) {}
    }
}

// Selektor-Aufloesung fuer `automation:click` UND `automation:dom_query`:
// (1) getElementById, (2) data-name, (3) CSS-Selektor. Bewusst gleicher
// Vertrag wie /click.
function resolveAutomationTarget(name: string): Element | null {
    if (!name) return null;
    var el: Element | null = document.getElementById(name);
    if (!el) {
        try { el = document.querySelector('[data-name="' + CSS.escape(name) + '"]'); } catch (_) {}
    }
    if (!el) {
        try { el = document.querySelector(name); } catch (_) {}
    }
    return el;
}

// Wie viele Treffer hat der Selektor? Liefert 1 fuer id/data-name-Lookups
// (eindeutig), sonst querySelectorAll.length. Hilft Hermes, broad vs.
// narrow Selektoren zu erkennen.
function countAutomationMatches(name: string): number {
    if (!name) return 0;
    if (document.getElementById(name)) return 1;
    try {
        var byName = document.querySelectorAll('[data-name="' + CSS.escape(name) + '"]');
        if (byName.length > 0) return byName.length;
    } catch (_) {}
    try {
        return document.querySelectorAll(name).length;
    } catch (_) {
        return 0;
    }
}

// Console-Error-Capture: hookt console.error + window.onerror +
// unhandledrejection und streamt an Backend ueber automation_console_error.
// Idempotent (Property-Marker), damit Hot-Reload / Doppel-Init nicht
// staffelt. Original-console.error wird weiter aufgerufen, damit der
// WebView-Inspector unveraendert sieht.
function installConsoleHook(
    invoke: (cmd: string, args?: any) => Promise<any>,
): void {
    var marker = '__folioConsoleHookInstalled';
    if ((window as any)[marker]) return;
    (window as any)[marker] = true;
    var origError = console.error.bind(console);
    function send(kind: string, message: string, stack?: string, source?: string) {
        invoke('automation_console_error', {
            payload: {
                kind: kind,
                message: message,
                stack: stack,
                source: source,
                timestampMs: Date.now(),
            },
        }).catch(function(){});
    }
    console.error = function (...args: any[]) {
        try {
            var message = args.map(function (a) {
                if (a instanceof Error) return a.message;
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch (_) { return String(a); }
            }).join(' ');
            var stack: string | undefined;
            for (var i = 0; i < args.length; i++) {
                if (args[i] instanceof Error && (args[i] as Error).stack) {
                    stack = (args[i] as Error).stack;
                    break;
                }
            }
            send('error', message, stack);
        } catch (_) {}
        origError.apply(console, args);
    };
    window.addEventListener('error', function (e: ErrorEvent) {
        var src = e.filename ? e.filename + ':' + e.lineno + ':' + e.colno : undefined;
        send('unhandled', e.message || 'window error', e.error && e.error.stack, src);
    });
    window.addEventListener('unhandledrejection', function (e: PromiseRejectionEvent) {
        var reason = e.reason;
        var message: string;
        var stack: string | undefined;
        if (reason instanceof Error) {
            message = reason.message;
            stack = reason.stack;
        } else if (typeof reason === 'string') {
            message = reason;
        } else {
            try { message = JSON.stringify(reason); } catch (_) { message = String(reason); }
        }
        send('rejection', message, stack);
    });
}

function elementAttributes(el: Element): Record<string, string> {
    var out: Record<string, string> = {};
    for (var i = 0; i < el.attributes.length; i++) {
        var attr = el.attributes.item(i);
        if (attr) out[attr.name] = attr.value;
    }
    return out;
}

export function initAutomationEvents(): void {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!ev || typeof ev.listen !== 'function' || !core) return;
    const invoke = core.invoke;

    installConsoleHook(invoke);

    ev.listen('automation:click', function (event: any) {
        var payload = (event && event.payload) || {};
        ackHandler(invoke, payload, function () {
            var el = resolveAutomationTarget(payload.name);
            if (el && typeof (el as HTMLElement).click === 'function') (el as HTMLElement).click();
        });
    });
    ev.listen('automation:rightclick', function (event: any) {
        var payload = (event && event.payload) || {};
        ackHandler(invoke, payload, function () {
            var el = resolveAutomationTarget(payload.name);
            if (!el) return;
            var x: number;
            var y: number;
            if (payload.coords && typeof payload.coords.x === 'number') {
                x = payload.coords.x;
                y = payload.coords.y;
            } else {
                var rect = (el as HTMLElement).getBoundingClientRect();
                x = rect.left + rect.width / 2;
                y = rect.top + rect.height / 2;
            }
            try {
                el.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    buttons: 2,
                    clientX: x,
                    clientY: y,
                }));
            } catch (_) {}
        });
    });
    ev.listen('automation:dom_query', function (event: any) {
        var payload = (event && event.payload) || {};
        var id = payload.requestId;
        if (typeof id !== 'number') return;
        var el = resolveAutomationTarget(payload.selector);
        var snap = el
            ? {
                exists: true,
                textContent: el.textContent || '',
                innerHtml: el.innerHTML || '',
                tagName: el.tagName.toLowerCase(),
                attributes: elementAttributes(el),
                matchCount: countAutomationMatches(payload.selector),
            }
            : {
                exists: false,
                textContent: null,
                innerHtml: null,
                tagName: null,
                attributes: {},
                matchCount: 0,
            };
        invoke('automation_dom_response', { id: id, payload: snap }).catch(function(){});
    });
    ev.listen('automation:set_editor_text', function (event: any) {
        var data = event && event.payload || {};
        var text = data.text || '';
        loadEditorText(text);
        updateWordCount(text);
        // currentPath/cleanText leben seit Phase-4-Extract in state/document.ts;
        // hier nicht mehr im Scope. Ueber die Getter holen, sonst
        // ReferenceError beim ersten automation:set_editor_text.
        if (getCurrentPath()) markDirty(text !== getCleanText());
    });
    ev.listen('automation:set_editor_selection', function (event: any) {
        var data = (event && event.payload) || {};
        ackHandler(invoke, data, function () {
            var start = typeof data.start === 'number' ? data.start : 0;
            var length = typeof data.length === 'number' ? data.length : 0;
            var editor = (window as any).FolioEditor;
            if (editor && typeof editor.setSelection === 'function') {
                editor.setSelection(start, length);
            }
        });
    });
    ev.listen('automation:open_document', function (event: any) {
        var data = (event && event.payload) || {};
        // openDocument ist async (Dirty-Prompt + Tauri-IPC). ackHandler
        // awaitet das Promise vor dem ACK, sodass Hermes weiß: Datei
        // ist tatsaechlich geladen.
        ackHandler(invoke, data, function () {
            if (data.path) return openDocument(data.path);
        });
    });
    ev.listen('automation:key', function (event: any) {
        var data = (event && event.payload) || {};
        ackHandler(invoke, data, function () { dispatchAutomationKey(data); });
    });
    // POST /editor/command: ruft eine Methode am FolioEditor-Surface auf.
    // Pragmatik wie in editor/index.ts dokumentiert: alles, was als
    // Funktion am `window.FolioEditor` haengt (undo, redo, focus,
    // setSelection, applyReplace, ...), ist via diesem Endpoint
    // triggerbar. Args werden als einzelnes Argument durchgereicht
    // (null wenn nicht gesetzt). Monaco-action-trigger (z. B.
    // editor.action.formatDocument) wird in einem Folge-Schritt
    // ergaenzt; fuer Phase 0 reichen die direkten FolioEditor-Methoden,
    // weil sie die wichtigen E2E-Mutationen (Undo/Redo, Selection,
    // Replace) abdecken.
    ev.listen('automation:editor_command', function (event: any) {
        var data = (event && event.payload) || {};
        ackHandler(invoke, data, function () {
            var editor = (window as any).FolioEditor;
            var cmd = data && data.command;
            if (!editor || typeof cmd !== 'string') return;
            var fn = (editor as any)[cmd];
            if (typeof fn !== 'function') return;
            try {
                if (data.args === null || data.args === undefined) {
                    fn.call(editor);
                } else {
                    fn.call(editor, data.args);
                }
            } catch (_) {}
        });
    });

    // Editor-Text-Tracking fuer Wordcount im Edit-Modus. CustomEvent wird
    // von editor.ts bei jeder Text-Aenderung dispatched (nicht nur durch
    // Automation, aber gleicher Code-Pfad: Wordcount + Dirty + IPC-Sync).
    window.addEventListener('folio-editor-text-updated', function (e: Event) {
        var text = (e as CustomEvent).detail || '';
        updateWordCount(text);
        if (getCurrentPath()) markDirty(text !== getCleanText());
        invoke('editor_text_changed', { text: text }).catch(function(){});
    });
}
