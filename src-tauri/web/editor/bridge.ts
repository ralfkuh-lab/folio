// Outbound message bridge. All editor → shell communication goes
// through `post()`; the shell listens via the Tauri event channel
// "editor:event". Additionally an `editorTextChanged` payload is
// mirrored as a synthetic `folio-editor-text-updated` CustomEvent so
// that in-window listeners (automation/events.ts mirrors the live text
// into window state) get the same notification without round-tripping
// through Tauri IPC.

export function post(msg: unknown): void {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('editor:event', msg);
    }
    if (
        msg &&
        typeof msg === 'object' &&
        (msg as { type?: unknown }).type === 'editorTextChanged'
    ) {
        try {
            window.dispatchEvent(
                new CustomEvent('folio-editor-text-updated', {
                    detail: (msg as { text?: unknown }).text || '',
                }),
            );
        } catch {
            /* ignored */
        }
    }
}
