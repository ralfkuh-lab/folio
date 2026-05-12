/* Tauri-Drag&Drop-Listener. Aktiviert `body.dnd-active` waehrend des
   Hover-States, oeffnet beim Drop den ersten gedroppten Pfad. */

import { openDocument } from '../state/document';

export function initDragDrop(): void {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;

    ev.listen('tauri://drag-enter', function () {
        document.body.classList.add('dnd-active');
    });
    ev.listen('tauri://drag-over', function () {
        document.body.classList.add('dnd-active');
    });
    ev.listen('tauri://drag-leave', function () {
        document.body.classList.remove('dnd-active');
    });
    ev.listen('tauri://drag-drop', function (event: any) {
        document.body.classList.remove('dnd-active');
        var paths = (event && event.payload && event.payload.paths) || [];
        if (paths.length === 0) return;
        openDocument(paths[0]);
    });
}
