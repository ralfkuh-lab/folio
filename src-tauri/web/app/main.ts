// @ts-nocheck
/* folio app bundle. Plan-Phase 4.3+: leaf modules out of main.ts. Cross-
   bundle bridge bleibt window.FolioEditor + Tauri-Runtime; alles andere
   wird inkrementell in app/{ui,vault,view,editor,state}/ modularisiert. */

import {
    initCheatsheet,
    showCheatSheet,
    hideCheatSheet,
    cheatsheetSyncMode,
    syncCheatsheetMenu,
    cheatSheetRows,
} from './ui/cheatsheet';
import { initZoom } from './ui/zoom';
import { initLanguagePicker, setEditorLanguageDisplay } from './ui/language-picker';
import {
    initFindBar,
    openEditorFind,
    afterModeSwitch as findBarAfterModeSwitch,
} from './ui/find-bar';
import { showUnsavedDialog } from './ui/dialogs';
import { initExportDialog } from './ui/export-dialog';
import { initRails, setRailVisibility, setTocWidth, setVaultWidth } from './ui/rails';
import {
    initContextMenu,
} from './vault/context-menu';
import {
    initVaultTree,
    setVaultPinned,
    setVaultRecent,
    insertVaultChildren,
    setVaultActive,
    reapplyVaultActive,
    refreshVault,
} from './vault/tree';
import {
    initMarkdownView,
    setTocActive,
    setTocList,
    scrollViewToAnchor,
    scrollViewTo,
    rewriteRelativeAssets,
    ViewFinder,
} from './view/markdown';
import {
    initDocumentState,
    getCurrentPath,
    getCleanText,
    getIsDirty,
    markDirty,
    applyDocKind,
    applyWindowTitle,
    openDocument,
    saveCurrent,
    syncEditorTextToStore,
    requestSaveIfDirty,
    setStatusPath,
    updateWordCount,
    showStatus,
} from './state/document';
import {
    initEditorShell,
    ensureEditorMounted,
    setActiveMode,
    setMode,
    setEditMode,
    loadEditorText,
    focusEditor,
    layoutEditor,
    setEditorTheme,
    applyEditorReplace,
} from './editor/shell';

// === IIFE #1 (TOC/View bridge, Editor bridge, ViewFinder, Cheatsheet, Vault setters) ===

(function () {
    var post = function (msg) {
        if (window.__TAURI__ && window.__TAURI__.event) {
            window.__TAURI__.event.emit("shell:event", msg);
        }
    };

    // ----- View-/TOC-/Markdown-Setup (Modul) — siehe view/markdown.ts -----
    initMarkdownView();
    var contentEl = document.getElementById('view-region');

    // Rail-Visibility / Width: setRailVisibility, setTocWidth, setVaultWidth
    // leben jetzt in ui/rails.ts (importiert oben).

    // Edit-Modus, app:set_mode-Listener, app:set_theme-Listener und die
    // Editor-Bridge (loadEditorText/focusEditor/layoutEditor/applyEditorReplace
    // /setEditorTheme/requestEditorSelection/setEditMode) leben jetzt in
    // editor/shell.ts. shell:command/editor:load_text/editor:apply_replace/
    // editor:open_find/editor:set_find_term ebenfalls dort registriert.

    // insertVaultChildren-Event-Routing aus shell:command bleibt in main.ts,
    // weil insertVaultChildren ein Vault-Setter ist.
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
        window.__TAURI__.event.listen("shell:command", function (event) {
            var data = event && event.payload;
            if (!data || typeof data !== 'object') return;
            if (data.type === 'insertVaultChildren') {
                insertVaultChildren(data.path || '', data.html || '');
            }
        });
        window.__TAURI__.event.listen("navigation:changed", function (event) {
            var data = event && event.payload;
            if (!data || typeof data !== 'object') return;
            var anchor = data.anchor || data.slug || '';
            setTocActive(anchor);
            if (data.view_mode) {
                window.__TAURI__.core.invoke('set_view_mode', { mode: data.view_mode }).catch(function(){});
            }
            var viewScroll = (typeof data.scroll_y === 'number') ? data.scroll_y : 0;
            var editorCursor = (typeof data.editor_cursor === 'number') ? data.editor_cursor : 0;
            var editorScroll = (typeof data.editor_scroll_y === 'number') ? data.editor_scroll_y : 0;
            // Restore nach Layout: document:loaded ersetzt body.innerHTML, scrollTo
            // klemmt sonst an einer noch nicht aufgebauten scrollHeight auf 0,
            // und der Scroll-Watcher überschreibt prompt entry.scroll_y mit 0.
            requestAnimationFrame(function () {
                if (anchor) scrollViewToAnchor(anchor);
                else scrollViewTo(viewScroll);
                if (!window.FolioEditor) return;
                if (typeof window.FolioEditor.setSelection === 'function') {
                    window.FolioEditor.setSelection(editorCursor, 0);
                }
                if (typeof window.FolioEditor.setScroll === 'function') {
                    window.FolioEditor.setScroll(editorScroll);
                }
            });
        });
        // editor:load_text, editor:apply_replace, app:set_mode (fusioniert),
        // app:set_theme und die editor:open_find/editor:set_find_term-Listener
        // leben jetzt in editor/shell.ts (Plan-Phase 4.5).
        // vault:refresh-Listener lebt in vault/tree.ts (Plan-Phase 4.4).
        window.__TAURI__.event.listen("panel:rail_changed", function (event) {
            var data = event && event.payload;
            if (!data) return;
            if (typeof data.leftRailVisible === 'boolean') {
                setRailVisibility('left', data.leftRailVisible);
            }
            if (typeof data.rightRailVisible === 'boolean') {
                setRailVisibility('right', data.rightRailVisible);
            }
        });
        // editor:open_find + editor:set_find_term leben in editor/shell.ts
        // (Plan-Phase 4.5).
        window.__TAURI__.event.listen("navigation:toc_click", function (event) {
            var data = event && event.payload;
            var anchor = data && (data.anchor || data.slug);
            if (anchor) scrollViewToAnchor(anchor);
            setTocActive(anchor || '');
        });
    }

    // ----- Editor-Shell (Modul) — siehe editor/shell.ts -----
    initEditorShell({ getCleanText, requestSaveIfDirty });

    // ----- ViewFinder lebt jetzt in view/markdown.ts (importiert oben). -----

    // ----- Find-Bar (Modul) — siehe ui/find-bar.ts -----
    initFindBar({ ensureEditorMounted });

    // ----- Splitter-Drag (Vault- und TOC-Rail, Modul) -----
    initRails();

    // ----- Vault-Tree (Modul) — siehe vault/tree.ts -----
    // openDocument lebt heute noch in IIFE #2; wir verdrahten den Tree
    // ueber einen Getter, der zur Init-Zeit noch nicht bekannte Funktion
    // erst beim Klick aufloest.
    initVaultTree({
        openDocument: function (path) {
            // openDocument wird in IIFE #2 als var definiert (Hoisting greift
            // bei function declarations dort, hier aber als window-Bridge).
            if (typeof (window as any).openDocument === 'function') {
                (window as any).openDocument(path);
            } else {
                if (window.__TAURI__ && window.__TAURI__.event) {
                    window.__TAURI__.event.emit('shell:event', { type: 'open', path });
                }
            }
        },
    });

    // ----- Cheat-Sheet-Overlay (Modul) -----
    initCheatsheet();
})();

// === IIFE #2 (Toolbar/Statusbar/Vault-Workspace/Drag&Drop/Context-Menu/__folioInvoke) ===

/* Toolbar / Statusbar / Vault-Workspace / Drag&Drop / Kontextmenü */
(function () {
    if (!window.__TAURI__) return;
    var invoke = window.__TAURI__.core && window.__TAURI__.core.invoke;
    window.__folioInvoke = invoke;
    var emit = window.__TAURI__.event && window.__TAURI__.event.emit;
    var listen = window.__TAURI__.event && window.__TAURI__.event.listen;
    if (!invoke || !emit || !listen) return;

    function $(id) { return document.getElementById(id); }
    function bind(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }
    /* Document-State (currentPath, cleanText, isDirty, markDirty, applyDocKind,
       openDocument, saveCurrent, syncEditorTextToStore, requestSaveIfDirty,
       setStatusPath, updateWordCount, showStatus, applyWindowTitle) und die
       Lifecycle-Listener (document:loaded fusioniert, document:dirty_changed,
       document:closed, document:saved) leben jetzt in state/document.ts.
       initDocumentState wird unten gerufen, sobald setActiveMode hier
       deklariert ist. */
    window.openDocument = openDocument;
    /* setMode + setActiveMode leben jetzt in editor/shell.ts (importiert oben). */
    function setRailButton(side, visible) {
        var btn = $(side === 'left' ? 'tb-rail-left' : 'tb-rail-right');
        if (btn) btn.classList.toggle('active', !!visible);
    }
    function applyRailVisibility(side, visible) {
        setRailVisibility(side, !!visible);
        setRailButton(side, visible);
    }
    function applyShellState(state) {
        if (!state || typeof state !== 'object') return;
        var mode = state.viewMode || state.view_mode || 'view';
        document.body.classList.toggle('edit-mode', mode === 'edit');
        document.body.classList.toggle('split-mode', mode === 'split');
        setActiveMode(mode);
        if (mode === 'edit') layoutEditor();
        var theme = state.theme || 'light';
        document.documentElement.classList.toggle('theme-dark', theme === 'dark');
        document.documentElement.classList.toggle('theme-light', theme === 'light');
        setEditorTheme(theme);
        if (typeof state.leftRailVisible === 'boolean') applyRailVisibility('left', state.leftRailVisible);
        if (typeof state.rightRailVisible === 'boolean') applyRailVisibility('right', state.rightRailVisible);
        var editor = state.editor || {};
        if (typeof editor.leftRailWidth === 'number') setVaultWidth(editor.leftRailWidth);
        if (typeof editor.rightRailWidth === 'number') setTocWidth(editor.rightRailWidth);
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
        var btn = $('tb-rail-left'); var on = !btn.classList.contains('active');
        btn.classList.toggle('active', on);
        invoke('set_rail_visible', { side: 'left', visible: on }).catch(function(){});
    });
    bind('tb-rail-right', function () {
        var btn = $('tb-rail-right'); var on = !btn.classList.contains('active');
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
            ans Backend schicken, Ergebnis via applyEditorReplace zurückspielen ----- */
    function applyCmd(name) {
        if (!window.FolioEditor || typeof window.FolioEditor.getText !== 'function') return;
        var text = window.FolioEditor.getText();
        var sel = window.FolioEditor.getSelection() || { start: 0, length: 0 };
        invoke('apply_editor_command', {
            command: name,
            text: text,
            start: sel.start || 0,
            length: sel.length || 0,
        }).then(function (res) {
            if (!res) return;
            window.FolioEditor.applyReplace({
                fullText: res.new_text,
                selectionStart: res.new_selection_start,
                selectionLength: res.new_selection_length,
            });
        }).catch(function (err) { console.warn('apply_editor_command failed:', err); });
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

    /* ----- Statusbar-Setter (setStatusPath, updateWordCount, showStatus)
       leben jetzt in state/document.ts (importiert oben). */
    bind('status-theme-toggle', function () { invoke('theme_set', { mode: 'toggle' }).catch(function(){}); });

    /* ----- Tastatur-Shortcuts ----- */
    /* ----- WebView-Zoom (Modul) ----- */
    initZoom();

    document.addEventListener('keydown', function (e) {
        var ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key === '1') { e.preventDefault(); $('tb-mode-view').click(); }
        else if (ctrl && e.key === '2') { e.preventDefault(); $('tb-mode-edit').click(); }
        // Strg+F und F3 laufen jetzt im Capture-Handler von ui/find-bar.ts,
        // damit sie auch im Editor-Fokus (vor Monaco) greifen.
        // F1 ist Monaco's Command-Palette im Editor-Fokus. Cheat-Sheet
        // bleibt ueber den Toolbar-Button erreichbar.
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
    });

    /* ----- Theme beim Boot laden + an html anwenden ----- */
    invoke('theme_get').then(function (mode) {
        var html = document.documentElement;
        html.classList.toggle('theme-dark', mode === 'dark');
        html.classList.toggle('theme-light', mode === 'light');
        if (typeof window.setEditorTheme === 'function') window.setEditorTheme(mode);
        // Häkchen im Theme-Submenü beim Boot setzen — danach hält der
        // app:set_theme-Listener sie synchron.
        invoke('menu_set_checked', { id: 'view.theme.light', checked: mode === 'light' }).catch(function(){});
        invoke('menu_set_checked', { id: 'view.theme.dark', checked: mode === 'dark' }).catch(function(){});
    }).catch(function(){});

    /* ----- Vault: Initial-Load + Listener leben jetzt in vault/tree.ts.
       refreshVault wird hier nur noch als Import bereitgestellt, falls
       andere Stellen es brauchen (z. B. context-menu nach Rename-Fehler). */

    invoke('cli_pending_open').then(function (path) {
        if (typeof path === 'string' && path.length > 0) {
            openDocument(path);
        }
    }).catch(function () {});

    window.__TAURI__.event.listen('cli:open', function (event) {
        var data = event && event.payload;
        var path = (data && typeof data === 'object') ? data.path : null;
        if (typeof path === 'string' && path.length > 0) {
            openDocument(path);
        }
    });

    /* Vault-Tree-Listener (click + contextmenu, isDirectChildOfSection-Logik)
       leben jetzt in vault/tree.ts (Modul-Init). Tree wird beim initVaultTree
       initial geladen und durch den dortigen vault:refresh-Listener aktualisiert. */

    /* ----- Kontextmenue (Modul) ----- */
    initContextMenu({
        openDocument: openDocument,
        refreshVault: refreshVault,
        showStatus: showStatus,
    });

    /* ----- Drag & Drop ----- */
    listen('tauri://drag-enter', function () {
        document.body.classList.add('dnd-active');
    });
    listen('tauri://drag-over', function () {
        document.body.classList.add('dnd-active');
    });
    listen('tauri://drag-leave', function () {
        document.body.classList.remove('dnd-active');
    });
    listen('tauri://drag-drop', function (event) {
        document.body.classList.remove('dnd-active');
        var paths = (event && event.payload && event.payload.paths) || [];
        if (paths.length === 0) return;
        var first = paths[0];
        openDocument(first);
    });

    /* ----- Backend-Events -----
       document:loaded (fusioniert) + document:dirty_changed +
       document:closed + document:saved leben jetzt in state/document.ts. */
    initDocumentState({ setActiveMode });
    // vault:refresh-Listener lebt jetzt in vault/tree.ts (Listener-Fusion
    // mit dem IIFE-#1-Pendant — Plan-Phase 4.4).
    // app:set_mode-Listener lebt in editor/shell.ts (Listener-Fusion mit
    // dem IIFE-#1-Pendant — Plan-Phase 4.5).
    listen('panel:rail_changed', function (event) {
        var data = event && event.payload || {};
        if (typeof data.leftRailVisible === 'boolean') setRailButton('left', data.leftRailVisible);
        if (typeof data.rightRailVisible === 'boolean') setRailButton('right', data.rightRailVisible);
    });
    listen('automation:click', function (event) {
        var name = event && event.payload && event.payload.name;
        if (!name) return;
        var el = document.getElementById(name);
        if (!el) {
            try { el = document.querySelector('[data-name="' + CSS.escape(name) + '"]'); } catch (_) {}
        }
        if (!el) {
            try { el = document.querySelector(name); } catch (_) {}
        }
        if (el && typeof el.click === 'function') el.click();
    });
    listen('automation:set_editor_text', function (event) {
        var data = event && event.payload || {};
        var text = data.text || '';
        if (typeof window.loadEditorText === 'function') window.loadEditorText(text);
        updateWordCount(text);
        if (currentPath) markDirty(text !== cleanText);
    });
    listen('automation:open_document', function (event) {
        var data = event && event.payload || {};
        if (data.path) openDocument(data.path);
    });

    /* ----- Editor-Text-Tracking für Wordcount im Edit-Modus ----- */
    window.addEventListener('folio-editor-text-updated', function (e) {
        var text = e.detail || '';
        updateWordCount(text);
        if (getCurrentPath()) markDirty(text !== getCleanText());
        invoke('editor_text_changed', { text: text }).catch(function(){});
    });

    /* ----- Editor-Sprach-Picker (Modul) ----- */
    initLanguagePicker();

    /* ----- Anwendungs-Menü: menu:*-Events auf bestehende Funktionen routen.
       Backend-Aktionen (Save-As, Beenden) laufen direkt in Rust; alles
       andere triggert hier dieselbe Funktion wie der Toolbar-Pfad — so
       gibt es nur eine Implementierung pro Aktion. */
    (function () {
        var ev = window.__TAURI__ && window.__TAURI__.event;
        if (!ev || typeof ev.listen !== 'function') return;
        // Hinweis: Tauri-Event-Namen erlauben keine Punkte; daher
        // unterscheiden sich die Listener-Namen hier (Unterstrich) von
        // den Menü-IDs in mod.rs (Punkt).
        ev.listen('menu:file_open', function () {
            invoke('pick_file').then(function (path) {
                if (path && typeof window.openDocument === 'function') {
                    window.openDocument(path);
                }
            }).catch(function () {});
        });
        ev.listen('menu:file_save', function () {
            if (getIsDirty()) saveCurrent();
        });
        ev.listen('menu:file_recent', function (event) {
            var p = event && event.payload && event.payload.path;
            if (p && typeof window.openDocument === 'function') {
                window.openDocument(p);
            }
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
            applyRailVisibility('left', !visible);
            invoke('set_rail_visible', { side: 'left', visible: !visible }).catch(function () {});
        });
        ev.listen('menu:view_rail_right', function () {
            var visible = !document.body.classList.contains('toc-hidden');
            applyRailVisibility('right', !visible);
            invoke('set_rail_visible', { side: 'right', visible: !visible }).catch(function () {});
        });
        ev.listen('menu:about', function (event) {
            var v = (event && event.payload && event.payload.version) || '?';
            alert('folio v' + v);
        });
    })();
})();
