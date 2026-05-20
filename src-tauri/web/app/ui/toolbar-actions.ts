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
import { openImageDialog } from './image-dialog';
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
    function isEditorFocused(): boolean {
        const mount = document.getElementById('editor-mount');
        return !!mount && mount.contains(document.activeElement);
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
    bind('tb-minimap', function () {
        var btn = $('tb-minimap'); if (!btn) return;
        var on = !btn.classList.contains('active');
        btn.classList.toggle('active', on);
        // Monaco-Option direkt setzen, damit der Toggle visuell sofort
        // greift. Backend persistiert + emittiert panel:minimap_changed
        // (fuer Automation- und Multi-Window-Sync).
        if (window.FolioEditor) window.FolioEditor.setMinimap(on);
        invoke('set_editor_minimap_visible', { visible: on }).catch(function(){});
    });
    bind('tb-find', function () { invoke('open_find').catch(function(){}); });
    // tb-reload: erscheint nur bei documentAutoReload=false + pending
    // external change. Click → reload_document; das emittierte
    // document:loaded/document:saved versteckt den Button anschliessend.
    bind('tb-reload', function () {
        invoke('reload_document').catch(function(){});
    });
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
    // tb-image faehrt einen eigenen Pfad: Dialog mit Clipboard-/Datei-
    // Auswahl, dann Schreiben + relativer Tag-Insert. Anders als die
    // anderen Inline-Commands laeuft das nicht ueber apply_editor_command.
    bind('tb-image',     function () { openImageDialog().catch(function(){}); });
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
       Alle anderen Menue-Accelerators (Strg+1/2, Strg+S, Strg+Shift+S,
       Strg+W, Strg+Q, Strg+O sowie die Edit-Toolbar-Shortcuts
       Strg+B/I/K) sind in build.rs zwar registriert, aber WebView2
       verschluckt die Tasten haeufig bevor sie das Tauri-Menue oder den
       OS-Accelerator-Dispatch erreichen — daher hier alle redundant per
       DOM-Capture-Listener. capture:true ist Pflicht, sonst frisst
       Monaco z.B. Strg+K (eingebauter Chord-Prefix). */
    document.addEventListener('keydown', function (e) {
        var ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl && !e.altKey) return;
        var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        var shift = e.shiftKey;
        var mdEdit = document.body.classList.contains('edit-mode')
            && document.body.classList.contains('kind-markdown');

        // Alt+Links/Rechts: History
        if (e.altKey && !ctrl && !shift && k === 'ArrowLeft') {
            e.preventDefault();
            requestSaveIfDirty().then(function (ok) {
                if (ok) invoke('go_back_and_emit').catch(function(){});
            });
            return;
        }
        if (e.altKey && !ctrl && !shift && k === 'ArrowRight') {
            e.preventDefault();
            requestSaveIfDirty().then(function (ok) {
                if (ok) invoke('go_forward_and_emit').catch(function(){});
            });
            return;
        }
        if (!ctrl) return;

        if (!shift && k === '1') { e.preventDefault(); $('tb-mode-view')?.click(); return; }
        if (!shift && k === '2') { e.preventDefault(); $('tb-mode-edit')?.click(); return; }
        if (!shift && k === 's') { e.preventDefault(); saveCurrent(); return; }
        if (shift && k === 's') {
            e.preventDefault();
            invoke('menu_dispatch', { id: 'file.save_as' }).catch(function(){});
            return;
        }
        if (!shift && k === 'o') {
            e.preventDefault();
            invoke('pick_file').then(function (path: any) {
                if (path) openDocument(path);
            }).catch(function () {});
            return;
        }
        if (!shift && k === 'w') {
            e.preventDefault();
            // Gleicher Pfad wie menu:file_close — Dirty-Prompt + close_document.
            invoke('menu_dispatch', { id: 'file.close' }).catch(function(){});
            return;
        }
        if (!shift && k === 'q') {
            e.preventDefault();
            invoke('menu_dispatch', { id: 'file.quit' }).catch(function(){});
            return;
        }
        // Strg+, → Einstellungen. WebView2 schluckt den Accelerator
        // genau wie die anderen, deshalb hier ueber menu_dispatch.
        if (!shift && k === ',') {
            e.preventDefault();
            invoke('menu_dispatch', { id: 'edit.settings' }).catch(function(){});
            return;
        }
        // Strg+Z / Strg+Shift+Z: Editor-Undo/Redo. Wenn Monaco selbst
        // den Fokus hat, machen wir nichts — Monacos eingebauter
        // Keybinding-Pfad greift dort wie gewohnt. Nur ausserhalb des
        // Editor-Mounts springt der DOM-Fallback ein (z. B. wenn Fokus
        // im Vault-Tree liegt und der User trotzdem ein Editor-Undo
        // ausloesen will). Gate auf mdEdit nicht noetig: undo()/redo()
        // sind im View-Mode No-Ops, weil getEditor() dort null ist.
        if (!shift && k === 'z') {
            if (isEditorFocused()) return;
            e.preventDefault();
            if (window.FolioEditor && typeof window.FolioEditor.undo === 'function') {
                window.FolioEditor.undo();
            }
            return;
        }
        if (shift && k === 'z') {
            if (isEditorFocused()) return;
            e.preventDefault();
            if (window.FolioEditor && typeof window.FolioEditor.redo === 'function') {
                window.FolioEditor.redo();
            }
            return;
        }
        // Edit-Toolbar-Markdown-Shortcuts: nur greifen wenn Markdown +
        // Edit-Mode aktiv. Sonst Browser-Default lassen (sodass z.B.
        // Strg+B in <input>-Feldern keine Wirkung hat, anstatt eine
        // verwirrende Markdown-Bold-Aktion zu triggern).
        if (mdEdit && !shift && k === 'b') {
            e.preventDefault();
            e.stopPropagation();
            applyCmd('bold');
            return;
        }
        if (mdEdit && !shift && k === 'i') {
            e.preventDefault();
            e.stopPropagation();
            applyCmd('italic');
            return;
        }
        if (mdEdit && !shift && k === 'k') {
            e.preventDefault();
            e.stopPropagation();
            applyCmd('link');
            return;
        }
    }, { capture: true });

}
