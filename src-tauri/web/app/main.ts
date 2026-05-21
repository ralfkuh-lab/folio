/* folio app bundle — Init-Router. Die frueheren grossen Initialisierungsbloecke
   in main.ts sind in fachliche Module aufgeteilt
   (ui/{menu-router,drag-drop,toolbar-actions}, automation/events,
   plus die bereits in 4.x extrahierten state/view/vault/editor/ui-Module).
   main.ts ist jetzt ausschliesslich Init-Reihenfolge + cross-modulare
   Wiring-Listener (navigation:changed-Restore, panel:rail_changed-Sync,
   shell:command-Dispatch, Theme-Boot, cli:open). */

import { initCheatsheet } from './ui/cheatsheet';
import { initZoom } from './ui/zoom';
import { initLanguagePicker } from './ui/language-picker';
import { initFindBar } from './ui/find-bar';
import { initExportDialog } from './ui/export-dialog';
import { initImageDialog, openImageDialog } from './ui/image-dialog';
import { initAboutDialog } from './ui/about-dialog';
import { initSettingsDialog } from './ui/settings-dialog';
import { attachPasteHandler } from './ui/paste-handler';
import { initRails, setRailVisibility } from './ui/rails';
import { initContextMenu } from './vault/context-menu';
import { initVaultTree, insertVaultChildren, refreshVault } from './vault/tree';
import {
    initMarkdownView,
    setTocActive,
    scrollViewToAnchor,
    scrollViewTo,
} from './view/markdown';
import { scrollHtmlViewToAnchor } from './view/html';
import {
    initDocumentState,
    getCleanText,
    openDocument,
    requestSaveIfDirty,
    showStatus,
    syncEditorTextToStore,
    getCurrentPath,
} from './state/document';
import {
    initEditorShell,
    ensureEditorMounted,
    setActiveMode,
    focusEditor,
    setEditorTheme,
} from './editor/shell';
import { initMenuRouter } from './ui/menu-router';
import { initDragDrop } from './ui/drag-drop';
import { initToolbarActions } from './ui/toolbar-actions';
import { ackHandler, initAutomationEvents } from './automation/events';
import { folioLog, safeInvoke } from './util/log';

const core = window.__TAURI__ && window.__TAURI__.core;
const ev = window.__TAURI__ && window.__TAURI__.event;
const invoke = core ? core.invoke : null;

// Defensive DevTools-Surface. Kein Production-Pfad liest diese
// Properties; sie existieren nur, damit man im WebView-Inspector
// schnell `await window.__folioInvoke('cli_pending_open')` oder
// `window.openDocument('/abs/path')` tippen kann, ohne durch das
// minifizierte Bundle nach dem richtigen Symbol zu suchen.
// Bei Modul-Splits in zukuenftigen Phasen nicht versehentlich
// entfernen — siehe `docs/automation-contract.md`.
if (invoke) window.__folioInvoke = invoke;
window.openDocument = openDocument;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function setRailButton(side: 'left' | 'right', visible: boolean): void {
    var btn = $(side === 'left' ? 'tb-rail-left' : 'tb-rail-right');
    if (btn) btn.classList.toggle('active', !!visible);
}
function applyRailVisibility(side: 'left' | 'right', visible: boolean): void {
    setRailVisibility(side, !!visible);
    setRailButton(side, visible);
}

// ----- Modul-Init in fester Reihenfolge -----
initMarkdownView({ requestSaveIfDirty });
initEditorShell({ getCleanText, requestSaveIfDirty });
initFindBar({ ensureEditorMounted, focusEditor });
initRails();
initVaultTree({ openDocument });
initCheatsheet();
initZoom();
initLanguagePicker();
initToolbarActions();
initExportDialog({
    getCurrentPath,
    syncEditorTextToStore,
    showStatus,
});
initImageDialog({ getCurrentPath, showStatus });
initAboutDialog();
initSettingsDialog();
attachPasteHandler(function (blob) {
    openImageDialog({ preloadedBlob: blob }).catch(function (err) {
        folioLog.warn('paste', 'openImageDialog failed', { error: String(err) });
    });
});
initContextMenu({ openDocument, refreshVault, showStatus });
initMenuRouter({ applyRailVisibility });
initDragDrop();
initAutomationEvents();
initDocumentState({ setActiveMode });

// ----- Cross-modulare Backend-Event-Listener -----
if (ev && typeof ev.listen === 'function' && invoke) {
    // insertVaultChildren-Event-Routing aus shell:command bleibt hier,
    // weil insertVaultChildren ein Vault-Setter ist und kein eigenes
    // Lifecycle-Modul rechtfertigt.
    ev.listen('shell:command', function (event: any) {
        var data = event && event.payload;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'insertVaultChildren') {
            insertVaultChildren(data.path || '', data.html || '');
        }
    });

    // navigation:changed: TOC-Highlight + View-Mode-Sync + Restore
    // (anchor / view-scroll / editor-cursor + editor-scroll). Muss in
    // requestAnimationFrame laufen, weil document:loaded das DOM gerade
    // erst neu aufgebaut hat — scrollTo klemmt sonst auf scrollHeight 0.
    // Payload-Felder sind camelCase (Tauri-Konvention) — sowohl aus
    // commands::nav::move_history als auch aus automation::history_move.
    ev.listen('navigation:changed', function (event: any) {
        var data = event && event.payload;
        if (!data || typeof data !== 'object') return;
        var anchor = data.anchor || data.slug || '';
        setTocActive(anchor);
        if (data.viewMode) {
            safeInvoke('set_view_mode', { mode: data.viewMode }, 'set_view_mode', 'warn');
        }
        var viewScroll = (typeof data.scrollY === 'number') ? data.scrollY : 0;
        var editorCursor = (typeof data.editorCursor === 'number') ? data.editorCursor : 0;
        var editorScroll = (typeof data.editorScrollY === 'number') ? data.editorScrollY : 0;
        requestAnimationFrame(function () {
            if (anchor) {
                if (document.body.classList.contains('html-preview-mode')) {
                    scrollHtmlViewToAnchor(anchor);
                } else {
                    scrollViewToAnchor(anchor);
                }
            } else {
                scrollViewTo(viewScroll);
            }
            if (!window.FolioEditor) return;
            if (typeof window.FolioEditor.setSelection === 'function') {
                window.FolioEditor.setSelection(editorCursor, 0);
            }
            if (typeof window.FolioEditor.setScroll === 'function') {
                window.FolioEditor.setScroll(editorScroll);
            }
        });
    });

    ev.listen('navigation:toc_click', function (event: any) {
        var data = (event && event.payload) || {};
        // Automation-Pfad liefert requestId; interner Frontend-Emit aus
        // markdown.ts laesst das Feld weg → ackHandler wird zum No-Op.
        ackHandler(invoke!, data, function () {
            var anchor = data.anchor || data.slug;
            if (anchor) {
                if (document.body.classList.contains('html-preview-mode')) {
                    scrollHtmlViewToAnchor(anchor);
                } else {
                    scrollViewToAnchor(anchor);
                }
            }
            setTocActive(anchor || '');
        });
    });

    // panel:rail_changed feuert sowohl bei Backend-Push (z. B. nach
    // Boot-Restore) als auch nach Toolbar-Click → CSS-Klassen + Toolbar-
    // Button werden synchron gehalten.
    ev.listen('panel:rail_changed', function (event: any) {
        var data = event && event.payload;
        if (!data) return;
        if (typeof data.leftRailVisible === 'boolean') {
            setRailVisibility('left', data.leftRailVisible);
            setRailButton('left', data.leftRailVisible);
        }
        if (typeof data.rightRailVisible === 'boolean') {
            setRailVisibility('right', data.rightRailVisible);
            setRailButton('right', data.rightRailVisible);
        }
    });

    // panel:minimap_changed analog: Automation oder Multi-Window-Sync
    // schreibt den State im Backend; das Frontend zieht hier nach.
    ev.listen('panel:minimap_changed', function (event: any) {
        var data = event && event.payload;
        if (!data || typeof data.visible !== 'boolean') return;
        var btn = $('tb-minimap');
        if (btn) btn.classList.toggle('active', data.visible);
        if (window.FolioEditor) window.FolioEditor.setMinimap(data.visible);
    });

    // CLI/External-Open: argv-Pfad beim Boot + cli:open bei
    // Single-Instance-Reinvoke.
    invoke('cli_pending_open').then(function (path: any) {
        if (typeof path === 'string' && path.length > 0) {
            openDocument(path);
        }
    }).catch(function (err) {
        folioLog.warn('boot', 'cli_pending_open failed', { error: String(err) });
    });
    ev.listen('cli:open', function (event: any) {
        var data = event && event.payload;
        var path = (data && typeof data === 'object') ? data.path : null;
        if (typeof path === 'string' && path.length > 0) {
            openDocument(path);
        }
    });
}

// ----- Theme beim Boot laden + an html anwenden -----
if (invoke) {
    invoke('theme_get').then(function (mode: any) {
        var html = document.documentElement;
        html.classList.toggle('theme-dark', mode === 'dark');
        html.classList.toggle('theme-light', mode === 'light');
        setEditorTheme(mode);
        safeInvoke('menu_set_checked', { id: 'view.theme.light', checked: mode === 'light' }, 'menu_set_checked view.theme.light', 'debug');
        safeInvoke('menu_set_checked', { id: 'view.theme.dark', checked: mode === 'dark' }, 'menu_set_checked view.theme.dark', 'debug');
    }).catch(function (err) {
        folioLog.warn('boot', 'theme_get failed', { error: String(err) });
    });

    // Minimap-Toggle aus dem persistierten Panel-State beim Boot
    // wiederherstellen. setMinimap deferred selbstaendig auf mountReady,
    // falls Monaco noch nicht mounted ist.
    invoke('editor_minimap_get').then(function (enabled: any) {
        var on = !!enabled;
        var btn = $('tb-minimap');
        if (btn) btn.classList.toggle('active', on);
        if (window.FolioEditor) window.FolioEditor.setMinimap(on);
    }).catch(function (err) {
        folioLog.warn('boot', 'editor_minimap_get failed', { error: String(err) });
    });

    // Rail-Visibility ebenfalls beim Boot syncen. `panel:rail_changed`
    // feuert sonst nur bei User-Klick — bei reinem Restore-Pfad bleiben
    // die Buttons sonst hartcodiert "active", waehrend der Body schon
    // `vault-hidden`/`toc-hidden` haette.
    invoke('panel_rails_get').then(function (state: any) {
        if (!state || typeof state !== 'object') return;
        if (typeof state.leftRailVisible === 'boolean') {
            applyRailVisibility('left', state.leftRailVisible);
        }
        if (typeof state.rightRailVisible === 'boolean') {
            applyRailVisibility('right', state.rightRailVisible);
        }
    }).catch(function (err) {
        folioLog.warn('boot', 'panel_rails_get failed', { error: String(err) });
    });
}
