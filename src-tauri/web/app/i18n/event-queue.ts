/* Boot event queue + listen-patch for the i18n bootstrap state machine.
   Spec: booting → i18nReady → uiReady; events before uiReady are queued
   and drained in arrival order over the real handlers.

   Side-effect on import: patches window.__TAURI__.event.listen so that
   handlers registered by later imports are suppressed until uiReady.
   Keep this module free of other app imports that call listen(). */

import type { BootstrapPhase } from './types';

export type QueuedEvent = { event: string; payload: unknown };

/** Full list of Backend→FE events that may arrive before UI ready.
 * Generated from real listen() call sites under web/app (I1b). */
export const BOOT_EVENT_NAMES: readonly string[] = [
    // CLI / shell
    'cli:open',
    'shell:command',
    // Navigation / panel
    'navigation:changed',
    'navigation:toc_click',
    'navigation:heading_changed',
    'panel:rail_changed',
    'panel:minimap_changed',
    'panel:split_mid_changed',
    // Document / tabs
    'document:loaded',
    'document:dirty_changed',
    'document:closed',
    'document:saved',
    'document:external_changed',
    'tabs:changed',
    // Vault / search
    'vault:refresh',
    'vault:dir_changed',
    'search:hits',
    'search:done',
    // Settings / themes
    'settings:changed',
    'themes:changed',
    // Editor / app mode
    'app:set_mode',
    'app:set_theme',
    'editor:load_text',
    'editor:apply_replace',
    'editor:open_find',
    'editor:set_find_term',
    'editor:selection',
    // Menu
    'menu:file_open',
    'menu:file_save',
    'menu:file_recent',
    'menu:file_close',
    'menu:file_quit',
    'menu:file_export',
    'menu:edit_undo',
    'menu:edit_redo',
    'menu:edit_find',
    'menu:edit_search_vault',
    'menu:edit_settings',
    'menu:edit_ai_translate',
    'menu:edit_ai_actions',
    'menu:view_minimap',
    'menu:view_mode_view',
    'menu:view_mode_edit',
    'menu:view_mode_split',
    'menu:view_theme_light',
    'menu:view_theme_dark',
    'menu:view_rail_left',
    'menu:view_rail_right',
    'menu:help_cheatsheet',
    'menu:about',
    // AI
    'ai:translate_stream',
    'ai:translate_done',
    'ai:action_started',
    'ai:action_stream',
    'ai:action_done',
    'ai:theme_stream',
    'ai:theme_done',
    // Automation
    'automation:click',
    'automation:sync_render',
    'automation:rightclick',
    'automation:dom_query',
    'automation:eval',
    'automation:set_editor_text',
    'automation:set_editor_selection',
    'automation:open_document',
    'automation:key',
    'automation:editor_command',
    // OS drag-drop (Tauri)
    'tauri://drag-enter',
    'tauri://drag-over',
    'tauri://drag-leave',
    'tauri://drag-drop',
];

export const MAX_QUEUE_SIZE = 256;

let phase: BootstrapPhase = 'booting';
const queue: QueuedEvent[] = [];
type Handler = (event: { payload: unknown }) => void | Promise<void>;
type HandlerRecord = { event: string; handler: Handler };
const registeredHandlers: HandlerRecord[] = [];
/** listen()-Promises returned by the patch (real handlers); awaited before drain. */
const pendingListenPromises: Promise<unknown>[] = [];
let preAdaptersInstalled = false;
let overflowLogged = false;
/** Dedup for rejected pre-adapter listen promises (per event name). */
const preAdapterFailWarned = new Set<string>();

export function getBootstrapPhase(): BootstrapPhase {
    return phase;
}

export function setBootstrapPhase(next: BootstrapPhase): void {
    phase = next;
}

export function getQueueSnapshot(): QueuedEvent[] {
    return queue.slice();
}

export function enqueue(event: string, payload: unknown): void {
    if (queue.length >= MAX_QUEUE_SIZE) {
        if (!overflowLogged) {
            overflowLogged = true;
            // eslint-disable-next-line no-console
            console.warn(
                '[folio:boot] event queue overflow (max ' + MAX_QUEUE_SIZE + '); dropping oldest',
            );
        }
        queue.shift();
    }
    queue.push({ event, payload });
}

function originalListen(): ((name: string, handler: Handler) => unknown) | null {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev) return null;
    if (typeof (ev as any).__folioOriginalListen === 'function') {
        return (ev as any).__folioOriginalListen;
    }
    if (typeof ev.listen === 'function') return ev.listen.bind(ev);
    return null;
}

/**
 * Patch __TAURI__.event.listen so handlers are suppressed until uiReady.
 * Safe to call multiple times (e.g. after installTauriMock in tests).
 * Pre-adapters must use originalListen(), not the patched listen.
 *
 * Also: (F1) tracks returned listen promises; (F4) wraps unlisten so the
 * handler is removed from registeredHandlers.
 */
export function installListenPatch(): void {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;
    if ((ev as any).__folioListenPatched) return;

    const original = ev.listen.bind(ev);
    (ev as any).__folioOriginalListen = original;
    ev.listen = function (eventName: string, handler: Handler) {
        const record: HandlerRecord = { event: eventName, handler };
        registeredHandlers.push(record);
        const p = original(eventName, function (event: any) {
            if (phase !== 'uiReady') {
                // Suppressed — pre-adapters own the queue during boot.
                return;
            }
            return handler(event);
        });
        if (p && typeof (p as Promise<unknown>).then === 'function') {
            const tracked = (p as Promise<unknown>).then(function (unlistenFn: any) {
                return function unlistenWrapped() {
                    const idx = registeredHandlers.indexOf(record);
                    if (idx >= 0) registeredHandlers.splice(idx, 1);
                    if (typeof unlistenFn === 'function') unlistenFn();
                };
            });
            pendingListenPromises.push(tracked);
            return tracked;
        }
        return p;
    };
    (ev as any).__folioListenPatched = true;
}

/** Await all listen()-promises registered via the patch (F1). */
export async function awaitPendingListens(): Promise<void> {
    const pending = pendingListenPromises.splice(0, pendingListenPromises.length);
    if (!pending.length) return;
    await Promise.all(
        pending.map(function (p) {
            return p.catch(function () {
                /* individual failures already surface via Tauri; continue */
            });
        }),
    );
}

/**
 * Register pre-adapters for all BOOT_EVENT_NAMES via the *unpatched*
 * listen so they actually fire during boot and enqueue events.
 */
export async function installPreAdapters(): Promise<void> {
    if (preAdaptersInstalled) return;
    const listen = originalListen();
    if (!listen) {
        preAdaptersInstalled = true;
        return;
    }
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < BOOT_EVENT_NAMES.length; i++) {
        const name = BOOT_EVENT_NAMES[i];
        try {
            const p = listen(name, function (event: any) {
                if (phase === 'uiReady') return;
                enqueue(name, event && event.payload);
            });
            if (p && typeof (p as Promise<unknown>).then === 'function') {
                pending.push(
                    (p as Promise<unknown>).catch(function (err) {
                        // F6: warn once per event name on rejected pre-adapter promises
                        if (!preAdapterFailWarned.has(name)) {
                            preAdapterFailWarned.add(name);
                            // eslint-disable-next-line no-console
                            console.warn(
                                '[folio:boot] pre-adapter listen rejected',
                                name,
                                err,
                            );
                        }
                    }),
                );
            }
        } catch (err) {
            if (!preAdapterFailWarned.has(name)) {
                preAdapterFailWarned.add(name);
                // eslint-disable-next-line no-console
                console.warn('[folio:boot] pre-adapter failed for', name, err);
            }
        }
    }
    if (pending.length) {
        await Promise.all(pending);
    }
    preAdaptersInstalled = true;
}

/** Drain current queue snapshot once (arrival order, all matching handlers). */
async function drainOnce(): Promise<void> {
    const items = queue.splice(0, queue.length);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        // Snapshot handlers so unlisten mid-drain does not skip siblings.
        const handlers = registeredHandlers.slice();
        for (let j = 0; j < handlers.length; j++) {
            const reg = handlers[j];
            if (reg.event !== item.event) continue;
            // Skip if unregistered mid-drain
            if (registeredHandlers.indexOf(reg) < 0) continue;
            try {
                await Promise.resolve(reg.handler({ payload: item.payload }));
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[folio:boot] drain handler error', item.event, err);
            }
        }
    }
}

/**
 * F1 race-free handover:
 * 1) await all real listen() promises
 * 2) drain until empty
 * 3) set phase uiReady
 * 4) if queue refilled in the switch race, drain again until dry
 */
export async function drainUntilDryAndGoLive(): Promise<void> {
    await awaitPendingListens();
    for (;;) {
        while (queue.length > 0) {
            await drainOnce();
        }
        phase = 'uiReady';
        // Race window: an event may have been enqueued between the empty
        // check and the phase switch (pre-adapter still saw !uiReady).
        if (queue.length === 0) break;
        // phase is uiReady; further live events go to real handlers only.
        // Drain the race-window leftovers, then re-check.
    }
}

/** Test helpers */
export function __resetEventQueueForTests(): void {
    phase = 'booting';
    queue.length = 0;
    registeredHandlers.length = 0;
    pendingListenPromises.length = 0;
    preAdaptersInstalled = false;
    overflowLogged = false;
    preAdapterFailWarned.clear();
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev) {
        delete (ev as any).__folioListenPatched;
        delete (ev as any).__folioOriginalListen;
    }
}

export function __getRegisteredHandlerCount(): number {
    return registeredHandlers.length;
}

// Side-effect: patch as early as this module is first imported (main.ts
// must import this first so later modules' listen() calls are patched).
installListenPatch();
