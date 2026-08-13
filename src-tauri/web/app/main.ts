/* folio app bundle — Init-Router + i18n bootstrap state machine (I1b).
   Phases: booting → i18nReady → uiReady. See docs/spec-i18n.md.

   FIRST import must be the event-queue so listen() is patched before any
   other module registers Backend→FE handlers. */

import {
    installPreAdapters,
    drainUntilDryAndGoLive,
    setBootstrapPhase,
    getBootstrapPhase,
} from './i18n/event-queue';
import { initI18n, t, tPlural } from './i18n/translate';
import { applyStaticTranslations } from './i18n/apply';

import { initCheatsheet } from './ui/cheatsheet';
import { initZoom } from './ui/zoom';
import { initLanguagePicker } from './ui/language-picker';
import { initFindBar } from './ui/find-bar';
import { initExportDialog } from './ui/export-dialog';
import { initImageDialog, openImageDialog } from './ui/image-dialog';
import { initAboutDialog } from './ui/about-dialog';
import { initTranslateDialog } from './ui/translate-dialog';
import { initAiActionsDialog } from './ui/ai-actions-dialog';
import { initAiDiffReview } from './ui/ai-diff-review';
import { initGitDiff } from './ui/git-diff';
import { initSettingsDialog } from './ui/settings-dialog';
import { initThemeEditor, openThemeEditor } from './ui/theme-editor';
import { initThemeAiDialog } from './ui/theme-ai-dialog';
import { attachPasteHandler } from './ui/paste-handler';
import { applySplitMidFromBackend, initRails, setRailVisibility } from './ui/rails';
import { initContextMenu } from './vault/context-menu';
import { initTabContextMenu } from './ui/tab-context-menu';
import { initCommandPalette } from './ui/command-palette';
import { initVaultTree, insertVaultChildren, refreshVault } from './vault/tree';
import { initVaultFilter } from './vault/filter';
import { initVaultGitStatus } from './vault/git-status';
import { initVaultSearch, consumeNavRestoreSkip } from './vault/search';
import { initVaultTags } from './vault/tags';
import {
    initMarkdownView,
    setTocActive,
    scrollViewToAnchor,
    scrollViewTo,
} from './view/markdown';
import { initPreview } from './view/preview';
import { initHtmlLiveUpdate } from './view/html';
import { initCodeLiveUpdate } from './view/code-live';
import { initViewTheme, reapplyCurrentViewTheme } from './view/theme';
import { initCodeCopy } from './view/code-copy';
import { initMarkdownScrollSync, syncViewSlugToEditor, tocClickToEditor } from './view/scroll-sync';
import { scrollHtmlViewToAnchor } from './view/html';
import { initHtmlScrollSync } from './view/html-scroll-sync';
import { initBacklinks } from './view/backlinks';
import {
    initDocumentState,
    getCleanText,
    openDocument,
    requestSaveIfDirty,
    showStatus,
    syncEditorTextToStore,
    getCurrentPath,
} from './state/document';
import { initTabs } from './state/tabs';
import {
    initEditorShell,
    ensureEditorMounted,
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
(window as any).openThemeEditor = openThemeEditor;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function setRailButton(side: 'left' | 'right', visible: boolean): void {
    var btn = $(side === 'left' ? 'tb-rail-left' : 'tb-rail-right');
    if (btn) btn.classList.toggle('active', !!visible);
}
function applyRailVisibility(side: 'left' | 'right', visible: boolean): void {
    setRailVisibility(side, !!visible);
    setRailButton(side, visible);
}
// Öffnet das linke Rail (falls zu) + persistiert — für Strg+Shift+F / Vault-Suche.
function openLeftRail(): void {
    if (!document.body.classList.contains('vault-hidden')) return;
    applyRailVisibility('left', true);
    safeInvoke('set_rail_visible', { side: 'left', visible: true }, 'set_rail_visible left');
}

function runModuleInits(): void {
    initMarkdownView({ requestSaveIfDirty });
    initBacklinks();
    initEditorShell({ getCleanText, requestSaveIfDirty });
    initFindBar({ ensureEditorMounted, focusEditor });
    initRails();
    initVaultTree({ openDocument });
    initVaultFilter();
    initVaultGitStatus();
    initVaultSearch({ openDocument, showStatus, openLeftRail });
    initVaultTags();
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
    initTranslateDialog();
    initAiActionsDialog();
    initAiDiffReview();
    initGitDiff();
    initViewTheme();
    initThemeEditor();
    initThemeAiDialog();
    initSettingsDialog();
    attachPasteHandler(function (blob) {
        openImageDialog({ preloadedBlob: blob }).catch(function (err) {
            folioLog.warn('paste', 'openImageDialog failed', { error: String(err) });
        });
    });
    initContextMenu({ openDocument, refreshVault, showStatus });
    initTabContextMenu();
    initCommandPalette();
    initMenuRouter({ applyRailVisibility });
    initDragDrop();
    initAutomationEvents();
    initTabs();
    initDocumentState();
    initPreview({ getCurrentPath });
    initHtmlLiveUpdate();
    initCodeLiveUpdate({ getCurrentPath });
    initCodeCopy();
    initMarkdownScrollSync();
    initHtmlScrollSync();
}

function installCrossModuleListeners(): void {
    if (!ev || typeof ev.listen !== 'function' || !invoke) return;

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
        var data = (event && event.payload) || {};
        if (!data || typeof data !== 'object') return;
        ackHandler(invoke!, data, function () {
            return (async function () {
                var anchor = data.anchor || data.slug || '';
                setTocActive(anchor);
                if (data.viewMode) {
                    await safeInvoke('set_view_mode', { mode: data.viewMode }, 'set_view_mode', 'warn');
                }
                var viewScroll = (typeof data.scrollY === 'number') ? data.scrollY : 0;
                var editorCursor = (typeof data.editorCursor === 'number') ? data.editorCursor : 0;
                var editorScroll = (typeof data.editorScrollY === 'number') ? data.editorScrollY : 0;
                // Vault-Suchsprung (tab_open): der Entry-Restore würde Cursor/
                // Scroll aus dem Entry setzen und den Sprung überschreiben — für
                // genau diesen Load einmal überspringen (Back/Forward unberührt).
                var skipRestore = consumeNavRestoreSkip(data.path || '');
                await new Promise(function (resolve) {
                    requestAnimationFrame(function () {
                        if (skipRestore) { resolve(undefined); return; }
                        if (anchor) {
                            if (document.body.classList.contains('html-preview-mode')) {
                                scrollHtmlViewToAnchor(anchor);
                            } else {
                                scrollViewToAnchor(anchor);
                            }
                        } else {
                            scrollViewTo(viewScroll);
                        }
                        if (window.FolioEditor) {
                            if (typeof window.FolioEditor.setSelection === 'function') {
                                window.FolioEditor.setSelection(editorCursor, 0);
                            }
                            if (typeof window.FolioEditor.setScroll === 'function') {
                                window.FolioEditor.setScroll(editorScroll);
                            }
                        }
                        resolve(undefined);
                    });
                });
            })();
        });
    });

    ev.listen('navigation:toc_click', function (event: any) {
        var data = (event && event.payload) || {};
        ackHandler(invoke!, data, function () {
            var anchor = data.anchor || data.slug;
            if (anchor) {
                if (document.body.classList.contains('html-preview-mode')) {
                    scrollHtmlViewToAnchor(anchor);
                } else {
                    scrollViewToAnchor(anchor);
                }
                if (document.body.classList.contains('edit-mode')) {
                    tocClickToEditor(anchor);
                }
            }
            setTocActive(anchor || '');
        });
    });

    ev.listen('navigation:heading_changed', function (event: any) {
        var data = (event && event.payload) || {};
        var anchor = data.anchor || data.slug || '';
        setTocActive(anchor || '');
        syncViewSlugToEditor(anchor || '');
    });

    // panel:rail_changed feuert sowohl bei Backend-Push (z. B. nach
    // Boot-Restore) als auch nach Toolbar-Click → CSS-Klassen + Toolbar-
    // Button werden synchron gehalten.
    ev.listen('panel:rail_changed', function (event: any) {
        var data = (event && event.payload) || {};
        if (!data) return;
        ackHandler(invoke!, data, function () {
            if (typeof data.leftRailVisible === 'boolean') {
                setRailVisibility('left', data.leftRailVisible);
                setRailButton('left', data.leftRailVisible);
            }
            if (typeof data.rightRailVisible === 'boolean') {
                setRailVisibility('right', data.rightRailVisible);
                setRailButton('right', data.rightRailVisible);
            }
        });
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

    // panel:split_mid_changed: der geclampte Wert kommt vom Backend
    // zurueck (Drag-Ende via set_split_mid_percent) — Frontend zieht die
    // CSS-Variable nach. Automation/Multi-Window-Sync analog zu Minimap.
    // applySplitMidFromBackend droppt Events waehrend eines aktiven Drags
    // (verspaetetes Event aus frueherem Drag darf den Live-Wert nicht
    // ueberschreiben).
    ev.listen('panel:split_mid_changed', function (event: any) {
        var data = (event && event.payload) || {};
        if (!data || typeof data.percent !== 'number') return;
        ackHandler(invoke!, data, function () {
            applySplitMidFromBackend(data.percent);
        });
    });

    // cli:open bei Single-Instance-Reinvoke (cli_pending_open is a
    // command, invoked after handlers are live — see bootstrap).
    ev.listen('cli:open', function (event: any) {
        var data = event && event.payload;
        var path = (data && typeof data === 'object') ? data.path : null;
        if (typeof path === 'string' && path.length > 0) {
            openDocument(path);
        }
    });
}

function restorePanelStateFromBackend(): void {
    if (!invoke) return;

    // ----- Theme beim Boot laden + an html anwenden -----
    invoke('theme_get').then(function (mode: any) {
        var html = document.documentElement;
        html.classList.toggle('theme-dark', mode === 'dark');
        html.classList.toggle('theme-light', mode === 'light');
        setEditorTheme(mode);
        reapplyCurrentViewTheme();
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

    // Split-Mode-Teiler aus dem persistierten Panel-State beim Boot
    // wiederherstellen (analog Minimap). Setzt nur --split-mid; sichtbar
    // wird es erst, wenn der Split-Mode aktiv ist.
    invoke('split_mid_get').then(function (percent: any) {
        if (typeof percent === 'number') applySplitMidFromBackend(percent);
    }).catch(function (err) {
        folioLog.warn('boot', 'split_mid_get failed', { error: String(err) });
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

/**
 * Dreiphasiger Boot (Spec i18n Frontend-Bootstrap):
 * 1. booting  — Pre-Adapter queuen alle Backend→FE-Events
 * 2. i18nReady — Katalog laden + statische DOM-Übersetzungen (Queue noch zu)
 * 3. uiReady  — init* + Listener, Queue drainen, cli_pending_open, frontend_ready
 */
async function bootstrap(): Promise<void> {
    setBootstrapPhase('booting');
    await installPreAdapters();

    // i18nReady: Katalog ODER Degradation; applyStatic nur bei Erfolg.
    const i18nOk = await initI18n();
    setBootstrapPhase('i18nReady');
    if (i18nOk) {
        applyStaticTranslations();
        // Cross-bundle surface for editor.bundle (isolated from app/ imports).
        // Reserved for future editor-bundle strings (I3b/I4). Pre-init =
        // undefined; consumers must keep a German/fallback string until ready.
        // Assign functions directly (no t(key) wrapper) so the i18n ref-gate
        // does not see a non-literal key argument.
        (window as any).FolioI18n = { t, tPlural, ready: true };
    }

    // uiReady: alle heutigen init*() + Cross-Module-Listener
    runModuleInits();
    installCrossModuleListeners();
    restorePanelStateFromBackend();

    // F1: await listen-promises, drain-until-dry, then phase=uiReady
    // (handles events that arrive mid-drain or in the switch race).
    await drainUntilDryAndGoLive();

    // cli_pending_open is a COMMAND (not an event): only after handlers are
    // installed. Result path is openDocument (same as cli:open); backend
    // currently returns null after session activate (document:loaded path).
    if (invoke) {
        try {
            const path = await invoke('cli_pending_open');
            if (typeof path === 'string' && path.length > 0) {
                openDocument(path);
            }
        } catch (err) {
            folioLog.warn('boot', 'cli_pending_open failed', { error: String(err) });
        }
    }

    // Idempotent frontend_ready — also on degradation path.
    if (invoke) {
        try {
            await invoke('frontend_ready');
        } catch (err) {
            folioLog.warn('boot', 'frontend_ready failed', { error: String(err) });
        }
    }

    folioLog.info('boot', 'bootstrap complete', {
        phase: getBootstrapPhase(),
        i18n: i18nOk,
    });
}

// Kick off async bootstrap (bundle is script-end; DOM is ready).
bootstrap().catch(function (err) {
    // eslint-disable-next-line no-console
    console.error('[folio] bootstrap failed', err);
    folioLog.error('boot', 'bootstrap failed', { error: String(err) });
});
