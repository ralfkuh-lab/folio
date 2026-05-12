/* Toolbar-Buttons (`tb-*`) + Edit-Toolbar-`applyCmd` + Tastatur-
   Shortcuts (Strg+1/2, Strg+S, Alt+←/→). Status-Theme-Toggle nimmt
   pragmatisch teil, weil er semantisch zum Toolbar-Set gehoert. */

import {
    getCleanText,
    getCurrentPath,
    getIsDirty,
    openDocument,
    requestSaveIfDirty,
    saveCurrent,
    syncEditorTextToStore,
    showStatus,
} from '../state/document';
import { setMode } from '../editor/shell';
import { initExportDialog } from './export-dialog';
import { showCheatSheet, hideCheatSheet, cheatSheetRows } from './cheatsheet';

export function initToolbarActions(): void {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core) return;
    const invoke = core.invoke;

    const $ = (id: string) => document.getElementById(id);
    function bind(id: string, fn: (e: MouseEvent) => void): void {
        var el = $(id);
        if (el) el.addEventListener('click', fn as any);
    }

    bind('tb-mode-view', function () { setMode('view'); });
    bind('tb-mode-edit', function () { setMode('edit'); });
    bind('tb-save', function () { if (getIsDirty()) saveCurrent(); });

    /* ----- Export-Dialog (Modul) ----- */
    initExportDialog({
        getCurrentPath,
        syncEditorTextToStore: syncEditorTextToStore,
        showStatus: showStatus,
    });

    bind('tb-rail-left', function () {
        var btn = $('tb-rail-left'); if (!btn) return;
        var on = !btn.classList.contains('active');
        btn.classList.toggle('active', on);
        invoke('set_rail_visible', { side: 'left', visible: on }).catch(function(){});
    });
    bind('tb-rail-right', function () {
        var btn = $('tb-rail-right'); if (!btn) return;
        var on = !btn.classList.contains('active');
        btn.classList.toggle('active', on);
        invoke('set_rail_visible', { side: 'right', visible: on }).catch(function(){});
    });
    bind('tb-find', function () { invoke('open_find').catch(function(){}); });
    bind('tb-back', function () {
        requestSaveIfDirty().then(function (ok) {
            if (ok) invoke('go_back_and_emit').catch(function () {});
        });
    });
    bind('tb-forward', function () {
        requestSaveIfDirty().then(function (ok) {
            if (ok) invoke('go_forward_and_emit').catch(function () {});
        });
    });

    /* ----- Edit-Toolbar: aktuellen Editor-Text+Selection holen, Command
            ans Backend schicken, Ergebnis via applyEditorReplace zurueckspielen ----- */
    function applyCmd(name: string): void {
        if (!window.FolioEditor || typeof window.FolioEditor.getText !== 'function') return;
        var text = window.FolioEditor.getText();
        var sel = window.FolioEditor.getSelection() || { start: 0, length: 0 };
        invoke('apply_editor_command', {
            command: name,
            text: text,
            start: sel.start || 0,
            length: sel.length || 0,
        }).then(function (res: any) {
            if (!res) return;
            window.FolioEditor!.applyReplace({
                fullText: res.new_text,
                selectionStart: res.new_selection_start,
                selectionLength: res.new_selection_length,
            });
        }).catch(function (err: any) { console.warn('apply_editor_command failed:', err); });
    }
    bind('tb-bold',      function () { applyCmd('bold'); });
    bind('tb-italic',    function () { applyCmd('italic'); });
    bind('tb-heading',   function () { applyCmd('heading'); });
    bind('tb-bullet',    function () { applyCmd('bullet'); });
    bind('tb-numbered',  function () { applyCmd('numbered'); });
    bind('tb-link',      function () { applyCmd('link'); });
    bind('tb-image',     function () { applyCmd('image'); });
    bind('tb-table',     function () { applyCmd('table'); });
    bind('tb-code',      function () { applyCmd('code'); });
    bind('tb-codeblock', function () { applyCmd('codeblock'); });
    bind('tb-strike',    function () { applyCmd('strike'); });
    bind('tb-cheatsheet', function () {
        if (!document.body.classList.contains('edit-mode')) return;
        var ov = $('cheatsheet-overlay');
        if (!ov) return;
        if (ov.hidden) {
            showCheatSheet(JSON.stringify(cheatSheetRows.map(function(r){return{label:r[0],code:r[1]};})));
        } else {
            hideCheatSheet();
        }
    });

    bind('status-theme-toggle', function () {
        invoke('theme_set', { mode: 'toggle' }).catch(function(){});
    });

    /* ----- Tastatur-Shortcuts -----
       Strg+F/F3 laufen im Capture-Handler von ui/find-bar.ts, damit sie
       auch im Editor-Fokus greifen. F1 ist Monaco's Command-Palette.
       Strg+O ist als Menue-Accelerator registriert (menu/build.rs), aber
       WebView2/Monaco verschluckt den Tasten-Event bevor er das Tauri-
       Menue erreicht — daher zusaetzlich hier im DOM-Listener. */
    document.addEventListener('keydown', function (e) {
        var ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key === '1') { e.preventDefault(); $('tb-mode-view')?.click(); }
        else if (ctrl && e.key === '2') { e.preventDefault(); $('tb-mode-edit')?.click(); }
        else if (e.altKey && e.key === 'ArrowLeft') {
            e.preventDefault();
            requestSaveIfDirty().then(function (ok) {
                if (ok) invoke('go_back_and_emit').catch(function(){});
            });
        }
        else if (e.altKey && e.key === 'ArrowRight') {
            e.preventDefault();
            requestSaveIfDirty().then(function (ok) {
                if (ok) invoke('go_forward_and_emit').catch(function(){});
            });
        }
        else if (ctrl && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            saveCurrent();
        }
        else if (ctrl && (e.key === 'o' || e.key === 'O')) {
            e.preventDefault();
            invoke('pick_file').then(function (path: any) {
                if (path) openDocument(path);
            }).catch(function () {});
        }
    });

}
