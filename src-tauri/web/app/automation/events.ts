/* Automation-API-Bridge fuer das Frontend. Listener:
   - `automation:click` (DOM-Lookup nach id / data-name / CSS-Selektor, dann `.click()`),
   - `automation:set_editor_text` (Editor-Text setzen + Dirty/Wordcount nachziehen),
   - `automation:set_editor_selection` (Selection im Monaco-Model setzen),
   - `automation:open_document` (Document-Open mit Frontend-Prompt-Pfad),
   - `automation:key` (synthetischer KeyboardEvent aufs Ziel, fuer
     preventDefault-Listener wie Strg+S/F3/Alt+Pfeil).

   Selektor-Fallback-Reihenfolge in `automation:click` ist Teil des
   Automation-Vertrags — siehe `docs/frontend-globals.md` Abschnitt 4.

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
            // happy-dom/jsdom in Vitest haben evtl. kein rAF — Microtask
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

export function initAutomationEvents(): void {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!ev || typeof ev.listen !== 'function' || !core) return;
    const invoke = core.invoke;

    ev.listen('automation:click', function (event: any) {
        var payload = (event && event.payload) || {};
        ackHandler(invoke, payload, function () {
            var name = payload.name;
            if (!name) return;
            var el: HTMLElement | null = document.getElementById(name);
            if (!el) {
                try { el = document.querySelector('[data-name="' + CSS.escape(name) + '"]'); } catch (_) {}
            }
            if (!el) {
                try { el = document.querySelector(name); } catch (_) {}
            }
            if (el && typeof (el as HTMLElement).click === 'function') (el as HTMLElement).click();
        });
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
        var start = typeof data.start === 'number' ? data.start : 0;
        var length = typeof data.length === 'number' ? data.length : 0;
        var editor = (window as any).FolioEditor;
        if (editor && typeof editor.setSelection === 'function') {
            editor.setSelection(start, length);
        }
    });
    ev.listen('automation:open_document', function (event: any) {
        var data = event && event.payload || {};
        if (data.path) openDocument(data.path);
    });
    ev.listen('automation:key', function (event: any) {
        var data = (event && event.payload) || {};
        ackHandler(invoke, data, function () { dispatchAutomationKey(data); });
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
