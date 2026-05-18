/* Anwendungs-Menue → Frontend-Aktionen. Die Backend-Side emittiert
   `menu:*`-Events (Unterstrich-Schreibweise, weil Tauri-Event-Namen
   keine Punkte erlauben); dieses Modul mappt sie auf dieselben
   Funktionen, die der Toolbar-Pfad nutzt — eine Implementierung pro
   Aktion. Backend-Aktionen wie Save-As/Beenden laufen direkt in Rust
   und tauchen hier nicht auf. */

import {
    getCurrentPath,
    getIsDirty,
    openDocument,
    requestSaveIfDirty,
    saveCurrent,
} from '../state/document';
import { setMode } from '../editor/shell';
import { openEditorFind } from './find-bar';

type Deps = {
    applyRailVisibility: (side: 'left' | 'right', visible: boolean) => void;
};

export function initMenuRouter(deps: Deps): void {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!ev || typeof ev.listen !== 'function' || !core) return;
    const invoke = core.invoke;
    const $ = (id: string) => document.getElementById(id);

    ev.listen('menu:file_open', function () {
        invoke('pick_file').then(function (path: any) {
            if (path) openDocument(path);
        }).catch(function () {});
    });
    ev.listen('menu:file_save', function () {
        if (getIsDirty()) saveCurrent();
    });
    ev.listen('menu:file_recent', function (event: any) {
        var p = event && event.payload && event.payload.path;
        if (p) openDocument(p);
    });
    ev.listen('menu:file_close', function () {
        if (!getCurrentPath()) return;
        requestSaveIfDirty().then(function (ok) {
            if (!ok) return;
            invoke('close_document').catch(function(){});
        });
    });
    ev.listen('menu:edit_undo', function () {
        if (window.FolioEditor && typeof window.FolioEditor.undo === 'function') {
            window.FolioEditor.undo();
        }
    });
    ev.listen('menu:edit_redo', function () {
        if (window.FolioEditor && typeof window.FolioEditor.redo === 'function') {
            window.FolioEditor.redo();
        }
    });
    ev.listen('menu:edit_find', function () {
        openEditorFind('');
    });
    ev.listen('menu:help_cheatsheet', function () {
        var b = $('tb-cheatsheet'); if (b) b.click();
    });
    ev.listen('menu:view_minimap', function () {
        var b = $('tb-minimap'); if (b) b.click();
    });
    ev.listen('menu:view_mode_view', function () { setMode('view'); });
    ev.listen('menu:view_mode_edit', function () { setMode('edit'); });
    ev.listen('menu:view_mode_split', function () { setMode('split'); });
    ev.listen('menu:view_theme_light', function () {
        invoke('theme_set', { mode: 'light' }).catch(function(){});
    });
    ev.listen('menu:view_theme_dark', function () {
        invoke('theme_set', { mode: 'dark' }).catch(function(){});
    });
    ev.listen('menu:view_rail_left', function () {
        var visible = !document.body.classList.contains('vault-hidden');
        deps.applyRailVisibility('left', !visible);
        invoke('set_rail_visible', { side: 'left', visible: !visible }).catch(function () {});
    });
    ev.listen('menu:view_rail_right', function () {
        var visible = !document.body.classList.contains('toc-hidden');
        deps.applyRailVisibility('right', !visible);
        invoke('set_rail_visible', { side: 'right', visible: !visible }).catch(function () {});
    });
    ev.listen('menu:about', function (event: any) {
        var v = (event && event.payload && event.payload.version) || '?';
        alert('folio v' + v);
    });
}
