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
    findNext as findNextBar,
    findPrev as findPrevBar,
    afterModeSwitch as findBarAfterModeSwitch,
} from './ui/find-bar';
import { showUnsavedDialog } from './ui/dialogs';
import { initExportDialog } from './ui/export-dialog';
import { initRails, setRailVisibility, setTocWidth, setVaultWidth } from './ui/rails';

// === IIFE #1 (TOC/View bridge, Editor bridge, ViewFinder, Cheatsheet, Vault setters) ===

(function () {
    var post = function (msg) {
        if (window.__TAURI__ && window.__TAURI__.event) {
            window.__TAURI__.event.emit("shell:event", msg);
        }
    };

    // ----- Link-Klicks (im Content) -----
    var contentEl = document.getElementById('view-region');
    contentEl.addEventListener('click', function (e) {
        var el = e.target;
        while (el && el.tagName !== 'A') el = el.parentElement;
        if (!el) return;
        var href = el.getAttribute('href');
        if (href === null) return;
        e.preventDefault();
        post({ type: 'linkClick', href: href });
    }, true);

    // ----- Sichtbare Überschrift + Scroll-Position -----
    (function () {
        var currentHeading = null;
        var lastScrollY = -1;
        function collectHeadings() {
            return Array.prototype.slice.call(
                contentEl.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
            );
        }
        function sendHeading(id) {
            if (id === currentHeading) return;
            currentHeading = id;
            post({ type: 'visibleHeading', id: id || '' });
        }
        function sendScroll(y) {
            if (y === lastScrollY) return;
            lastScrollY = y;
            post({ type: 'scrollPosition', y: y });
        }
        function update() {
            var hs = collectHeadings();
            if (hs.length === 0) { sendHeading(null); }
            else {
                var threshold = 120;
                var active = hs[0];
                var contentTop = contentEl.getBoundingClientRect().top;
                for (var i = 0; i < hs.length; i++) {
                    var top = hs[i].getBoundingClientRect().top - contentTop;
                    if (top <= threshold) active = hs[i];
                    else break;
                }
                sendHeading(active.id);
            }
            sendScroll(Math.round(contentEl.scrollTop));
        }
        var rafQueued = false;
        function schedule() {
            if (rafQueued) return;
            rafQueued = true;
            requestAnimationFrame(function () { rafQueued = false; update(); });
        }
        contentEl.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        window.addEventListener('load', update);
    })();

    // ----- TOC-Click (im rechten Rail) -----
    var tocEl = document.getElementById('toc-region');
    tocEl.addEventListener('click', function (e) {
        var el = e.target;
        while (el && !(el.classList && el.classList.contains('entry'))) el = el.parentElement;
        if (!el) return;
        var slug = el.getAttribute('data-slug');
        if (slug) post({ type: 'tocClick', slug: slug });
    });

    // ----- TOC-API (vom Host gerufen) -----
    window.setTocActive = function (slug) {
        var prev = tocEl.querySelectorAll('li.entry.active');
        for (var i = 0; i < prev.length; i++) prev[i].classList.remove('active');
        if (!slug) return;
        var target = tocEl.querySelector('li.entry[data-slug="' + slug + '"]');
        if (target) {
            target.classList.add('active');
            target.scrollIntoView({ block: 'nearest' });
        }
    };
    window.setTocList = function (html) {
        var ul = tocEl.querySelector('ul.toc');
        if (ul) ul.innerHTML = html;
    };

    // ----- Anker-Scroll innerhalb der View-Region -----
    // location.hash auf einem persistierten Shell-Dokument scrollt sonst die
    // Shell selbst (die nicht scrollt) — wir uebersetzen explizit auf
    // contentEl.scrollIntoView, damit Anker funktionieren.
    window.scrollViewToAnchor = function (slug) {
        if (!slug) return;
        var target = contentEl.querySelector('#' + CSS.escape(slug));
        if (target) target.scrollIntoView({ block: 'start' });
    };
    window.scrollViewTo = function (y) {
        contentEl.scrollTo(0, y || 0);
    };

    // Rail-Visibility / Width: setRailVisibility, setTocWidth, setVaultWidth
    // leben jetzt in ui/rails.ts (importiert oben).

    // ----- Edit-Modus: tauscht View-Region gegen Editor-Region in derselben
    //       Grid-Spalte. Monaco Editor lebt im DOM, kein zweites HWnd, kein
    //       Airspace-Konflikt mit dem Cheat-Sheet-Overlay.
    window.setEditMode = function (on) {
        document.body.classList.toggle('edit-mode', !!on);
        if (on && typeof window.layoutEditor === 'function') window.layoutEditor();
    };

    // ----- Inbound-Channel: chrome.webview.message-Events fuer C#→JS-
    //       Payloads, die zu gross fuer ExecuteScriptAsync waeren (Editor-
    //       Volltext, applyReplace mit komplettem Doc). C# postet via
    //       CoreWebView2.PostWebMessageAsJson, JS routet hier auf die
    //       bestehenden window-Funktionen.
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
        window.__TAURI__.event.listen("shell:command", function (event) {
            var data = event && event.payload;
            if (!data || typeof data !== 'object') return;
            switch (data.type) {
                case 'loadEditorText':
                    if (typeof window.loadEditorText === 'function') {
                        window.loadEditorText(data.text || '');
                    }
                    break;
                case 'applyEditorReplace':
                    if (typeof window.applyEditorReplace === 'function') {
                        window.applyEditorReplace(
                            data.fullText || '',
                            data.selectionStart || 0,
                            data.selectionLength || 0
                        );
                    }
                    break;
                case 'insertVaultChildren':
                    if (typeof window.insertVaultChildren === 'function') {
                        window.insertVaultChildren(data.path || '', data.html || '');
                    }
                    break;
                default:
                    /* ignored */
                    break;
            }
        });
        window.__TAURI__.event.listen("document:loaded", function (event) {
            var data = event && event.payload;
            if (!data || typeof data !== 'object') return;
            if (typeof window.loadEditorText === 'function') {
                window.loadEditorText(data.text || '', data.language || '');
            }
            setEditorLanguageDisplay(data.language || 'plaintext');
            if (typeof window.setTocList === 'function') {
                window.setTocList(data.tocHtml || data.toc_html || '');
            }
            var body = contentEl.querySelector('.markdown-body');
            if (body) {
                // Nur Markdown wird in der View-Region gerendert. Für
                // Text/Code-Dateien würde sonst der Roh-Inhalt durch den
                // MD-Renderer kurz aufflackern, bevor applyDocKind in
                // den Edit-Mode wechselt.
                var isMd = data.kind === 'markdown';
                body.innerHTML = isMd ? (data.content || data.html || '') : '';
                if (isMd && typeof window.rewriteRelativeAssets === 'function') {
                    window.rewriteRelativeAssets(body, data.path || '');
                }
            }
            if (typeof window.setVaultActive === 'function') {
                window.setVaultActive(data.path || '');
            }
        });
        window.__TAURI__.event.listen("navigation:changed", function (event) {
            var data = event && event.payload;
            if (!data || typeof data !== 'object') return;
            var anchor = data.anchor || data.slug || '';
            if (typeof window.setTocActive === 'function') {
                window.setTocActive(anchor);
            }
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
                if (anchor && typeof window.scrollViewToAnchor === 'function') {
                    window.scrollViewToAnchor(anchor);
                } else if (typeof window.scrollViewTo === 'function') {
                    window.scrollViewTo(viewScroll);
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
        window.__TAURI__.event.listen("editor:load_text", function (event) {
            var data = event && event.payload;
            var text = (data && typeof data === 'object') ? (data.text || '') : '';
            if (typeof window.loadEditorText === 'function') window.loadEditorText(text);
        });
        window.__TAURI__.event.listen("editor:apply_replace", function (event) {
            var data = event && event.payload;
            if (!data || typeof data !== 'object') return;
            if (typeof window.applyEditorReplace === 'function') {
                window.applyEditorReplace(data.fullText || '', data.start || 0, data.length || 0);
            }
        });
        window.__TAURI__.event.listen("vault:refresh", function (event) {
            var data = event && event.payload;
            if (!data || typeof data !== 'object') return;
            if (data.pinned && typeof window.setVaultPinned === 'function') window.setVaultPinned(data.pinned);
            if (data.recent && typeof window.setVaultRecent === 'function') window.setVaultRecent(data.recent);
        });
        window.__TAURI__.event.listen("app:set_mode", function (event) {
            var data = event && event.payload;
            var mode = (data && data.mode) || 'view';
            document.body.classList.toggle('edit-mode', mode === 'edit');
            document.body.classList.toggle('split-mode', mode === 'split');
            if (mode === 'edit' && typeof window.focusEditor === 'function') {
                window.focusEditor();
            }
            syncCheatsheetMenu();
            // Rückgängig/Wiederholen leben in Monaco — nur im Edit-Mode
            // sinnvoll. Im View-Mode (statisches HTML) gibt es nichts
            // rückgängig zu machen.
            var core = window.__TAURI__.core;
            core.invoke('menu_set_enabled', { id: 'edit.undo', enabled: mode === 'edit' }).catch(function(){});
            core.invoke('menu_set_enabled', { id: 'edit.redo', enabled: mode === 'edit' }).catch(function(){});
        });
        window.__TAURI__.event.listen("app:set_theme", function (event) {
            var data = event && event.payload;
            var mode = (data && data.mode) || 'light';
            var html = document.documentElement;
            if (mode === 'toggle') {
                mode = html.classList.contains('theme-dark') ? 'light' : 'dark';
            }
            html.classList.toggle('theme-dark', mode === 'dark');
            html.classList.toggle('theme-light', mode === 'light');
            if (typeof window.setEditorTheme === 'function') {
                window.setEditorTheme(mode);
            }
            // Theme-Submenü-Häkchen synchron halten — egal über welchen
            // Pfad der Wechsel kam (Menü, Statusbar-Button, Init).
            var core = window.__TAURI__.core;
            core.invoke('menu_set_checked', { id: 'view.theme.light', checked: mode === 'light' }).catch(function(){});
            core.invoke('menu_set_checked', { id: 'view.theme.dark', checked: mode === 'dark' }).catch(function(){});
        });
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
        window.__TAURI__.event.listen("editor:open_find", function () {
            var bar = document.getElementById('find-bar');
            if (bar) bar.classList.add('open');
            var input = document.getElementById('find-input');
            if (input) { input.focus(); input.select(); }
        });
        window.__TAURI__.event.listen("editor:set_find_term", function (event) {
            var data = event && event.payload;
            var term = (data && data.term) || '';
            var input = document.getElementById('find-input');
            if (input) {
                input.value = term;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        window.__TAURI__.event.listen("navigation:toc_click", function (event) {
            var data = event && event.payload;
            var anchor = data && (data.anchor || data.slug);
            if (anchor && typeof window.scrollViewToAnchor === 'function') {
                window.scrollViewToAnchor(anchor);
            }
            if (typeof window.setTocActive === 'function') window.setTocActive(anchor || '');
        });
    }

    // ----- Editor-API (Monaco Editor via FolioEditor-Bundle) -----
    var editorMounted = false;
    function ensureEditorMounted(initial) {
        if (editorMounted) return Promise.resolve(true);
        if (!window.FolioEditor || typeof window.FolioEditor.mount !== 'function') {
            console.error('[folio] FolioEditor bundle not available');
            return Promise.resolve(false);
        }
        return window.FolioEditor.mount('editor-mount', initial || '').then(function () {
            editorMounted = true;
            return true;
        }).catch(function (err) {
            console.error('[folio] Editor mount failed:', err);
            return false;
        });
    }
    window.loadEditorText = function (text, language) {
        ensureEditorMounted(text || '').then(function (ok) {
            if (!ok) return;
            window.FolioEditor.setText(text || '', language || 'plaintext');
            if (document.body.classList.contains('edit-mode')) {
                window.layoutEditor();
            }
        });
    };
    window.focusEditor = function () {
        var initial = typeof cleanText === 'string' ? cleanText : '';
        ensureEditorMounted(initial).then(function (ok) {
            if (!ok) return;
            window.layoutEditor();
            window.FolioEditor.focus();
        });
    };
    window.layoutEditor = function () {
        if (!window.FolioEditor || !editorMounted || typeof window.FolioEditor.layout !== 'function') return;
        requestAnimationFrame(function () {
            window.FolioEditor.layout();
            requestAnimationFrame(function () {
                window.FolioEditor.layout();
            });
        });
    };
    window.setEditorTheme = function (mode) {
        if (window.FolioEditor) window.FolioEditor.setTheme(mode);
    };
    window.requestEditorSelection = function () {
        if (!window.FolioEditor) return null;
        return window.FolioEditor.getSelection();
    };
    window.applyEditorReplace = function (fullText, selectionStart, selectionLength) {
        if (!window.FolioEditor) return;
        window.FolioEditor.applyReplace({
            fullText: fullText || '',
            selectionStart: selectionStart || 0,
            selectionLength: selectionLength || 0,
        });
    };

    // ----- ViewFinder: DOM-Sucher fuer den View-Modus -----
    // API spiegelt window.FolioEditor (openFind/closeFind/setFindTerm/setFindOptions/findNext/findPrev),
    // damit der gemeinsame Find-Bar-IIFE drueber denselben Adapter nutzen kann. Sucht ausschliesslich
    // in #view-region main.markdown-body; Vault, TOC und Editor bleiben aussen vor.
    (function () {
        // Co-operative chunking: pro Tick max so viele Treffer/Wraps verarbeiten,
        // dann mit setTimeout(0) zurueck an den Browser. Haelt Tasten- und
        // Scroll-Events responsive auch waehrend ein Suchlauf laeuft.
        var CHUNK_SIZE = 500;

        // CSS Custom Highlight API: keine DOM-Wraps, kein Reflow pro Treffer,
        // Clear ist O(1). matchHL haelt alle Treffer, activeHL nur den
        // gerade aktiven (overlay-Farbe).
        var hasHighlightAPI = (typeof CSS !== 'undefined') && CSS.highlights
            && (typeof Highlight !== 'undefined');
        var matchHL = null;
        var activeHL = null;
        function ensureHighlights() {
            if (!hasHighlightAPI) return;
            if (!matchHL) { matchHL = new Highlight(); CSS.highlights.set('folio-find', matchHL); }
            if (!activeHL) { activeHL = new Highlight(); CSS.highlights.set('folio-find-active', activeHL); }
        }

        var rangesArr = [];   // alle Match-Ranges (auch die Lane-Marker leiten daraus ab)
        var activeIdx = -1;
        var currentTerm = '';
        var opts = { caseSensitive: false, wholeWord: false };
        // Bei jeder neuen research() inkrementiert. Async-Chunks brechen ab,
        // sobald myToken !== searchToken — die alte Suche wird so verworfen,
        // statt die neue zu blockieren.
        var searchToken = 0;

        function getRoot() { return document.querySelector('#view-region main.markdown-body'); }
        function getContent() { return document.getElementById('view-content'); }
        function getLane() { return document.getElementById('view-marker-lane'); }

        function clearLane() {
            var lane = getLane();
            if (!lane) return;
            while (lane.firstChild) lane.removeChild(lane.firstChild);
        }

        function updateMarkers() {
            var lane = getLane();
            var content = getContent();
            if (!lane) return;
            clearLane();
            if (!content || rangesArr.length === 0) return;
            var totalH = content.scrollHeight;
            if (totalH <= 0) return;
            // Read-Phase: alle Range-Top-Positionen lesen, ohne DOM-Mutation
            // dazwischen. Trennt Reads von Writes (1 Layout-Reflow statt N).
            var contentTop = content.getBoundingClientRect().top;
            var scrollTop = content.scrollTop;
            // Bucketing: maximal 1 Marker pro Pixelreihe der Lane. Dieselbe
            // Doc-Position 10x malen ist visuell identisch und unnoetig.
            // laneH = sichtbare Lane-Hoehe ~ Anzahl Pixel-Buckets.
            var laneH = Math.max(1, lane.clientHeight);
            var seen = new Uint8Array(laneH);
            var activePixel = -1;
            var pixels = [];
            for (var i = 0; i < rangesArr.length; i++) {
                var rect = rangesArr[i].getBoundingClientRect();
                var pos = scrollTop + (rect.top - contentTop);
                var px = Math.max(0, Math.min(laneH - 1, Math.round((pos / totalH) * laneH)));
                if (i === activeIdx) activePixel = px;
                if (!seen[px]) { seen[px] = 1; pixels.push(px); }
            }
            var frag = document.createDocumentFragment();
            for (var j = 0; j < pixels.length; j++) {
                var p = pixels[j];
                var dot = document.createElement('div');
                dot.className = 'folio-marker' + (p === activePixel ? ' active' : '');
                dot.style.top = ((p / laneH) * 100) + '%';
                frag.appendChild(dot);
            }
            lane.appendChild(frag);
        }

        function clearMarks() {
            // Highlight-API: O(1)-Clear. Kein DOM-Walk, kein normalize, kein Reflow.
            if (matchHL) matchHL.clear();
            if (activeHL) activeHL.clear();
            rangesArr = [];
            activeIdx = -1;
            clearLane();
        }

        function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

        function buildRegex(term) {
            if (!term) return null;
            var pattern = escapeRegExp(term);
            if (opts.wholeWord) pattern = '\\b' + pattern + '\\b';
            var flags = opts.caseSensitive ? 'g' : 'gi';
            try { return new RegExp(pattern, flags); } catch (e) { return null; }
        }

        function buildWalker(root) {
            return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    var p = node.parentNode;
                    while (p && p !== root) {
                        var tn = p.nodeName ? p.nodeName.toLowerCase() : '';
                        if (tn === 'script' || tn === 'style') return NodeFilter.FILTER_REJECT;
                        p = p.parentNode;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
        }

        // Sammelt Match-Ranges in Chunks und schiebt sie progressive in das
        // CSS Highlight (matchHL) — die Treffer werden also bereits sichtbar
        // gefaerbt, waehrend der Lauf noch weiterlaeuft. Counter aktualisiert
        // ueber dispatchProgress; Cancel ueber Token-Mismatch.
        function collectRangesAsync(root, regex, myToken, done) {
            var walker = buildWalker(root);
            function step() {
                if (myToken !== searchToken) return;
                var batchStart = rangesArr.length;
                var node;
                while ((node = walker.nextNode())) {
                    var text = node.nodeValue || '';
                    if (!text) continue;
                    regex.lastIndex = 0;
                    var m;
                    while ((m = regex.exec(text))) {
                        if (m[0].length === 0) { regex.lastIndex++; continue; }
                        var r = document.createRange();
                        r.setStart(node, m.index);
                        r.setEnd(node, m.index + m[0].length);
                        rangesArr.push(r);
                        if (matchHL) matchHL.add(r);
                        if (rangesArr.length - batchStart >= CHUNK_SIZE) {
                            dispatchProgress(rangesArr.length);
                            setTimeout(step, 0);
                            return;
                        }
                    }
                }
                done();
            }
            step();
        }

        function dispatchState() {
            var detail = { term: currentTerm, total: rangesArr.length, active: activeIdx };
            try {
                window.dispatchEvent(new CustomEvent('folio-find-state', { detail: detail }));
            } catch (e) {}
            // C# hoert auf den editorFindState-Channel und persistiert den Term
            // ueber Datei-Wechsel; analog zur Monaco-Pipeline in editor.ts.
            try {
                post({ type: 'editorFindState', term: detail.term, total: detail.total, active: detail.active });
            } catch (e) {}
        }

        // Zwischenstand waehrend collect/wrap: nur DOM-Event (fuer den Counter),
        // keine Bridge-Nachricht — sonst spammt jedes Chunk den C#-Channel.
        function dispatchProgress(partialTotal) {
            try {
                window.dispatchEvent(new CustomEvent('folio-find-state', {
                    detail: { term: currentTerm, total: partialTotal, active: -1, scanning: true }
                }));
            } catch (e) {}
        }

        function setActive(idx) {
            if (rangesArr.length === 0) {
                activeIdx = -1;
                if (activeHL) activeHL.clear();
                updateMarkers();
                dispatchState();
                return;
            }
            if (idx < 0) idx = (idx % rangesArr.length + rangesArr.length) % rangesArr.length;
            if (idx >= rangesArr.length) idx = idx % rangesArr.length;
            activeIdx = idx;
            if (activeHL) {
                activeHL.clear();
                activeHL.add(rangesArr[activeIdx]);
            }
            // Highlights haben kein scrollIntoView — wir scrollen das Element
            // an, in dessen Text der Treffer beginnt.
            var r = rangesArr[activeIdx];
            var anchor = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
            if (anchor) {
                try { anchor.scrollIntoView({ block: 'center', inline: 'nearest' }); }
                catch (e) { try { anchor.scrollIntoView(true); } catch (_) {} }
            }
            updateMarkers();
            dispatchState();
        }

        function research() {
            clearMarks();
            var myToken = ++searchToken;
            if (!currentTerm) { dispatchState(); return; }
            var root = getRoot(); if (!root) { dispatchState(); return; }
            var regex = buildRegex(currentTerm); if (!regex) { dispatchState(); return; }
            ensureHighlights();
            collectRangesAsync(root, regex, myToken, function () {
                if (myToken !== searchToken) return;
                if (rangesArr.length > 0) setActive(0);
                else { updateMarkers(); dispatchState(); }
            });
        }

        window.ViewFinder = {
            openFind: function (initial) {
                if (typeof initial === 'string' && initial.length > 0) currentTerm = initial;
                research();
            },
            closeFind: function () {
                // Token-Bump cancelt eventuell noch laufende async Chunks aus
                // einer vorherigen Suche, bevor clearMarks die Treffer abraeumt.
                searchToken++;
                clearMarks();
                currentTerm = '';
                dispatchState();
            },
            setFindTerm: function (term) { currentTerm = term || ''; research(); },
            setFindOptions: function (newOpts) {
                newOpts = newOpts || {};
                opts.caseSensitive = !!newOpts.caseSensitive;
                opts.wholeWord = !!newOpts.wholeWord;
                research();
            },
            findNext: function () { if (rangesArr.length > 0) setActive((activeIdx + 1) % rangesArr.length); },
            findPrev: function () { if (rangesArr.length > 0) setActive((activeIdx - 1 + rangesArr.length) % rangesArr.length); },
        };
    })();

    // ----- Find-Bar (Modul) — siehe ui/find-bar.ts -----
    initFindBar({ ensureEditorMounted });

    // ----- Splitter-Drag (Vault- und TOC-Rail, Modul) -----
    initRails();

    // ----- Vault-Region (Tree, Klick, ContextMenu) -----
    (function () {
        var ROOT = document.getElementById('vault-tree');
        var REGION = document.getElementById('vault-region');

        function findNodeByPath(path) {
            if (!path) return null;
            var nodes = ROOT.querySelectorAll('.node');
            for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].getAttribute('data-path') === path) return nodes[i];
            }
            return null;
        }
        function findAllNodesByPath(path) {
            if (!path) return [];
            var matches = [];
            var nodes = ROOT.querySelectorAll('.node');
            for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].getAttribute('data-path') === path) matches.push(nodes[i]);
            }
            return matches;
        }
        function findAncestor(el, cls) {
            while (el && el !== ROOT && el.nodeType === 1) {
                if (el.classList && el.classList.contains(cls)) return el;
                el = el.parentElement;
            }
            return null;
        }

        var currentActivePath = '';
        function reapplyActiveMarker() {
            var prev = ROOT.querySelectorAll('.node.active');
            for (var i = 0; i < prev.length; i++) prev[i].classList.remove('active');
            if (!currentActivePath) return;
            var nodes = findAllNodesByPath(currentActivePath);
            for (var n = 0; n < nodes.length; n++) nodes[n].classList.add('active');
        }
        window.setVaultPinned = function (html) {
            var section = ROOT.querySelector('li.section[data-section="pinned"]');
            if (!section) return;
            var ul = section.querySelector(':scope > ul.children');
            if (ul) ul.innerHTML = html || '';
            reapplyActiveMarker();
        };
        window.setVaultRecent = function (html) {
            var section = ROOT.querySelector('li.section[data-section="recent"]');
            if (!section) return;
            var ul = section.querySelector(':scope > ul.children');
            if (ul) ul.innerHTML = html || '';
            reapplyActiveMarker();
        };
        window.insertVaultChildren = function (path, html) {
            // Pfad kann mehrfach im Baum vorkommen (z. B. neu angepinntes
            // Unterverzeichnis eines bereits angepinnten Ordners). Alle Vorkommen
            // aktualisieren, sonst landen die Children im falschen (ersten) Node.
            var lis = findAllNodesByPath(path);
            for (var n = 0; n < lis.length; n++) {
                var li = lis[n];
                var ul = li.querySelector(':scope > ul.children');
                if (!ul) continue;
                ul.innerHTML = html || '';
                ul.classList.remove('collapsed');
                li.setAttribute('data-loaded', '1');
                var caret = li.querySelector(':scope > .row > .caret');
                if (caret) caret.classList.add('open');
                var iconEl = li.querySelector(':scope > .row > .icon');
                if (iconEl) iconEl.textContent = '📂';
            }
            reapplyActiveMarker();
        };
        window.setVaultActive = function (path) {
            currentActivePath = path || '';
            reapplyActiveMarker();
        };
        window.reapplyVaultActive = reapplyActiveMarker;

        function toggleSection(section) {
            var key = section.getAttribute('data-section');
            var caret = section.querySelector(':scope > .row > .caret');
            var ul = section.querySelector(':scope > ul.children');
            var nowExpanded = !(caret && caret.classList.contains('open'));
            if (caret) caret.classList.toggle('open', nowExpanded);
            if (ul) ul.classList.toggle('collapsed', !nowExpanded);
            post({ type: 'toggle-section', section: key, expanded: nowExpanded });
        }
        function toggleDir(node) {
            var caret = node.querySelector(':scope > .row > .caret');
            var ul = node.querySelector(':scope > ul.children');
            var iconEl = node.querySelector(':scope > .row > .icon');
            var path = node.getAttribute('data-path');
            var loaded = node.getAttribute('data-loaded') === '1';
            var open = caret && caret.classList.contains('open');
            if (open) {
                if (caret) caret.classList.remove('open');
                if (ul) ul.classList.add('collapsed');
                if (iconEl) iconEl.textContent = '📁';
                post({ type: 'collapse-dir', path: path });
            } else {
                if (caret) caret.classList.add('open');
                if (ul) ul.classList.remove('collapsed');
                if (iconEl) iconEl.textContent = '📂';
                if (!loaded) post({ type: 'expand-dir', path: path });
            }
        }

        // Klicks innerhalb der Vault-Region (Tree-Reihen + Header-Buttons)
        REGION.addEventListener('click', function (e) {
            if (e.button !== 0) return;
            // Header-Buttons (addFile/addFolder)
            var cmdBtn = e.target;
            while (cmdBtn && cmdBtn !== REGION && !(cmdBtn.classList && cmdBtn.classList.contains('vault-cmd'))) {
                cmdBtn = cmdBtn.parentElement;
            }
            if (cmdBtn && cmdBtn !== REGION && cmdBtn.classList.contains('vault-cmd')) {
                e.preventDefault();
                e.stopPropagation();
                var cmd = cmdBtn.getAttribute('data-cmd');
                var inv = window.__folioInvoke || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
                if (cmd === 'addFile') {
                    if (inv) {
                        inv('pick_file').then(function (path) {
                            if (!path) return;
                            if (typeof window.openDocument === 'function') {
                                window.openDocument(path);
                            } else {
                                post({ type: 'open', path: path });
                            }
                        }).catch(function () {});
                    } else {
                        post({ type: 'addFile' });
                    }
                } else if (cmd === 'addFolder') {
                    if (inv) {
                        inv('pick_folder').then(function (path) {
                            if (path) inv('workspace_pin', { path: path, isDirectory: true }).catch(function () {});
                        }).catch(function () {});
                    } else {
                        post({ type: 'addFolder' });
                    }
                }
                return;
            }
            // Tree-Rows
            var row = e.target;
            while (row && row !== ROOT && !(row.classList && row.classList.contains('row'))) {
                row = row.parentElement;
            }
            if (!row || row === ROOT) return;
            var node = findAncestor(row.parentElement, 'node');
            if (node) {
                var kind = node.getAttribute('data-kind');
                if (kind === 'dir') { toggleDir(node); return; }
                if (kind === 'file') {
                    var p = node.getAttribute('data-path');
                    if (p) {
                        if (typeof window.openDocument === 'function') {
                            window.openDocument(p);
                        } else {
                            post({ type: 'open', path: p });
                        }
                    }
                    return;
                }
            }
            var section = findAncestor(row.parentElement, 'section');
            if (section) toggleSection(section);
        });

        // Rechtsklick → Context-Menu-Anfrage (Position relativ zum Viewport).
        REGION.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            var node = findAncestor(e.target, 'node');
            if (!node) {
                post({ type: 'context', path: null, x: e.clientX, y: e.clientY });
                return;
            }
            post({
                type: 'context',
                path: node.getAttribute('data-path'),
                kind: node.getAttribute('data-kind'),
                isPinned: node.getAttribute('data-pinned') === '1',
                isInRecent: node.getAttribute('data-recent') === '1',
                x: e.clientX,
                y: e.clientY
            });
        });
    })();

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
    var currentPath = null;
    var isDirty = false;
    var cleanText = '';
    function markDirty(dirty) {
        isDirty = !!dirty;
        var el = $('status-path');
        if (el) el.classList.toggle('dirty', isDirty);
        var btn = $('tb-save');
        if (btn) btn.disabled = !isDirty;
        invoke('menu_set_enabled', { id: 'file.save', enabled: isDirty }).catch(function(){});
        applyWindowTitle();
    }
    function fileFullName(p) {
        if (!p) return null;
        return p.replace(/\\/g, '/').split('/').pop() || p;
    }
    function applyWindowTitle() {
        var name = fileFullName(currentPath);
        var title = name
            ? (isDirty ? '* ' + name : name) + ' — Folio'
            : 'Folio';
        document.title = title;
        invoke('set_window_title', { title: title }).catch(function () { /* ignore */ });
    }
    function editorText() {
        if (window.FolioEditor && typeof window.FolioEditor.getText === 'function') {
            return window.FolioEditor.getText();
        }
        return cleanText;
    }
    function refreshDirtyFromEditor() {
        var dirty = !!currentPath && editorText() !== cleanText;
        markDirty(dirty);
        return dirty;
    }
    function syncEditorTextToStore() {
        if (!currentPath) return Promise.resolve();
        return invoke('editor_text_changed', { text: editorText() }).catch(function(){});
    }
    /* Rename-Modal (showRenameDialog) lebt jetzt in ui/dialogs.ts. Kein
       Reader im Bundle: das Datei-Menue geht ueber den nativen Save-Dialog
       im Backend (commands::file::run_rename_dialog), das Vault-Kontext-
       menue startet Inline-Rename direkt. */

    /* Inline-Rename im Vault-Baum (Explorer-Feeling): ersetzt das .label-
       Span temporär durch ein <input>, vorselektiert den Stamm ohne
       Endung. Enter/Blur committen, Escape bricht ab. Nach erfolgreichem
       rename_file emittiert das Backend vault:refresh, das den Baum neu
       baut — das Input verschwindet damit automatisch. */
    function startInlineRename(path) {
        if (!path) return;
        var nodes = document.querySelectorAll('#vault-tree li.node[data-path]');
        var nodeEl = null;
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].getAttribute('data-path') === path
                && nodes[i].getAttribute('data-kind') !== 'dir') {
                nodeEl = nodes[i];
                break;
            }
        }
        if (!nodeEl) return;
        var labelEl = nodeEl.querySelector(':scope > .row > .label');
        if (!labelEl || labelEl.dataset.editing === '1') return;
        var originalText = labelEl.textContent || '';
        var basename = originalText;
        labelEl.dataset.editing = '1';
        labelEl.classList.add('editing');
        labelEl.textContent = '';

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'vault-rename-input';
        input.value = basename;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('data-rename-input', '1');
        labelEl.appendChild(input);

        function stop(e) { e.stopPropagation(); }
        input.addEventListener('click', stop);
        input.addEventListener('mousedown', stop);
        input.addEventListener('dblclick', stop);
        input.addEventListener('contextmenu', stop);

        var finished = false;
        function cleanup() {
            input.removeEventListener('keydown', onKey);
            input.removeEventListener('blur', onBlur);
            labelEl.classList.remove('editing');
            delete labelEl.dataset.editing;
        }
        function restore() {
            cleanup();
            labelEl.textContent = originalText;
        }
        function commit() {
            if (finished) return;
            finished = true;
            var newName = (input.value || '').trim();
            if (!newName || newName === originalText) {
                restore();
                return;
            }
            cleanup();
            labelEl.textContent = newName; // optimistisch bis vault:refresh kommt
            var normalized = path.replace(/\\/g, '/');
            var lastSlash = normalized.lastIndexOf('/');
            var parent = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
            var newPath = parent + newName;
            invoke('rename_file', { oldPath: path, newPath: newPath }).catch(function (err) {
                showStatus(typeof err === 'string' ? err : 'Umbenennen fehlgeschlagen');
                refreshVault();
            });
        }
        function cancel() {
            if (finished) return;
            finished = true;
            restore();
        }
        function onKey(e) {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
            else { e.stopPropagation(); }
        }
        function onBlur() { commit(); }
        input.addEventListener('keydown', onKey);
        input.addEventListener('blur', onBlur);

        input.focus();
        var dot = basename.lastIndexOf('.');
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    }
    window.startInlineRename = startInlineRename;

    // showUnsavedDialog lebt jetzt in ui/dialogs.ts (importiert oben).
    function renderDocumentPayload(data) {
        if (!data || typeof data !== 'object') return;
        if (typeof window.setTocList === 'function') {
            window.setTocList(data.tocHtml || data.toc_html || '');
        }
        var view = document.getElementById('view-region');
        var body = view && view.querySelector('.markdown-body');
        if (body) {
            body.innerHTML = data.content || data.html || '';
            rewriteRelativeAssets(body, data.path || currentPath);
        }
    }
    function rewriteRelativeAssets(rootEl, documentPath) {
        if (!rootEl || !documentPath) return;
        var convert = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.convertFileSrc;
        if (typeof convert !== 'function') return;
        var dir = documentPath.replace(/[\\/][^\\/]*$/, '');
        var imgs = rootEl.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var src = imgs[i].getAttribute('src');
            if (!src) continue;
            // Skip absolute URLs (http, https, data:, asset:, blob:, etc.)
            if (/^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
            if (src.indexOf('//') === 0) continue;
            var abs;
            if (/^[a-zA-Z]:[\\/]/.test(src) || src.charAt(0) === '/') {
                abs = src;
            } else {
                abs = dir + '/' + src;
            }
            // Normalisiere Backslashes (Windows)
            abs = abs.replace(/\\/g, '/');
            try { imgs[i].src = convert(abs); } catch (e) { /* ignore */ }
        }
    }
    window.rewriteRelativeAssets = rewriteRelativeAssets;
    function saveCurrent() {
        return syncEditorTextToStore().then(function () {
            return invoke('editor_save_requested');
        }).then(function (saved) {
            if (saved) {
                cleanText = editorText();
                markDirty(false);
            }
            return !!saved;
        }).catch(function () { return false; });
    }
    function requestSaveIfDirty() {
        var dirty = refreshDirtyFromEditor();
        if (!dirty && !isDirty) return Promise.resolve(true);
        return syncEditorTextToStore().then(showUnsavedDialog).then(function (decision) {
            if (decision === 'cancel') return false;
            if (decision === 'discard') {
                return invoke('discard_editor_changes').then(function () {
                    cleanText = editorText();
                    markDirty(false);
                    return true;
                }).catch(function () { return false; });
            }
            return invoke('editor_save_requested').then(function (saved) {
                if (saved) {
                    cleanText = editorText();
                    markDirty(false);
                }
                return !!saved;
            }).catch(function () { return false; });
        });
    }
    var DOC_KIND_CLASSES = ['kind-markdown', 'kind-text', 'kind-binary', 'kind-unknown'];
    function applyDocKind(kind) {
        var resolved = kind || 'unknown';
        var body = document.body;
        DOC_KIND_CLASSES.forEach(function (c) { body.classList.remove(c); });
        body.classList.add('kind-' + resolved);

        var md = resolved === 'markdown';
        var hasDoc = resolved !== 'unknown' && resolved !== 'binary';
        var btnView = $('tb-mode-view');
        if (btnView) {
            btnView.disabled = !md;
            btnView.title = md ? 'View (Ctrl+1)' : 'View nur für Markdown verfügbar';
        }
        var btnEdit = $('tb-mode-edit');
        if (btnEdit) {
            btnEdit.disabled = !hasDoc;
            btnEdit.title = hasDoc ? 'Edit (Ctrl+2)' : 'Kein Dokument geladen';
        }
        var btnExport = $('tb-export');
        if (btnExport) {
            btnExport.disabled = !md;
            btnExport.title = md ? 'Exportieren…' : 'Export nur für Markdown verfügbar';
        }
        // Menü-Items synchron halten: View-Mode nur bei MD, Save-As bei
        // jedem geladenen, lesbaren Dokument (also nicht 'unknown').
        invoke('menu_set_enabled', { id: 'view.mode.view', enabled: md }).catch(function(){});
        invoke('menu_set_enabled', { id: 'view.mode.edit', enabled: hasDoc }).catch(function(){});
        invoke('menu_set_enabled', { id: 'file.save_as', enabled: hasDoc }).catch(function(){});
        invoke('menu_set_enabled', { id: 'file.rename', enabled: hasDoc }).catch(function(){});
        invoke('menu_set_enabled', { id: 'file.close', enabled: hasDoc }).catch(function(){});
        syncCheatsheetMenu();
        // Häkchen nach dem Enable-Wechsel erneut anwenden — Tauri scheint
        // set_checked auf disabled Items zu verwerfen, sodass beim ersten
        // Doc-Laden der View/Edit-Mode-Haken sonst leer bleibt, bis der
        // User selbst umschaltet.
        syncViewModeMenuChecks();
    }
    // Liest den aktuellen Mode aus body.classList und setzt die Häkchen
    // im Ansicht-Menü. Kein State neben dem DOM — gleiche Strategie wie
    // syncCheatsheetMenu.
    function syncViewModeMenuChecks() {
        var body = document.body;
        // Ohne geladenes Dokument soll kein Mode angehakt sein, auch
        // wenn edit-mode/split-mode-Klassen noch im DOM stehen.
        var hasDoc = !body.classList.contains('kind-unknown')
                  && !body.classList.contains('kind-binary');
        var mode = !hasDoc ? null
                 : body.classList.contains('edit-mode') ? 'edit'
                 : body.classList.contains('split-mode') ? 'split'
                 : 'view';
        invoke('menu_set_checked', { id: 'view.mode.view', checked: mode === 'view' }).catch(function(){});
        invoke('menu_set_checked', { id: 'view.mode.edit', checked: mode === 'edit' }).catch(function(){});
        invoke('menu_set_checked', { id: 'view.mode.split', checked: mode === 'split' }).catch(function(){});
    }
    // Cheat-Sheet ist nur im Edit-Mode bei Markdown sinnvoll. Wird
    // sowohl von applyDocKind als auch vom app:set_mode-Listener
    // gerufen, damit jede Zustandsänderung das Menü mitnimmt.
    // syncCheatsheetMenu kommt aus ui/cheatsheet (importiert oben).
    applyDocKind('unknown');
    function showStatus(msg) {
        var el = $('status-path');
        if (el) el.textContent = msg;
    }
    function openDocument(path) {
        return requestSaveIfDirty().then(function (ok) {
            if (!ok) return false;
            return invoke('read_file', { path: path }).then(function (data) {
                invoke('workspace_add_recent', { path: path }).catch(function(){});
                var kind = data && data.kind;
                if (kind && kind !== 'markdown' &&
                    !document.body.classList.contains('edit-mode')) {
                    invoke('set_view_mode', { mode: 'edit' }).then(function () {
                        setActiveMode('edit');
                    }).catch(function(){});
                }
                applyDocKind(kind);
                return true;
            }).catch(function (err) {
                showStatus(typeof err === 'string' ? err : 'Datei konnte nicht geöffnet werden');
                return false;
            });
        });
    }
    window.openDocument = openDocument;
    function setMode(mode) {
        return requestSaveIfDirty().then(function (ok) {
            if (!ok) return false;
            return invoke('set_view_mode', { mode: mode }).then(function () {
                setActiveMode(mode);
                return true;
            });
        });
    }

    /* ----- Toolbar: Mode / Rails / Find / Navigation ----- */
    function setActiveMode(mode) {
        $('tb-mode-view').classList.toggle('active', mode === 'view');
        $('tb-mode-edit').classList.toggle('active', mode === 'edit');
        var sm = $('status-mode'); if (sm) sm.textContent = mode === 'edit' ? 'Edit' : 'View';
        cheatsheetSyncMode(mode === 'edit');
        // View-Mode-Häkchen im Menü synchron halten (alle Pfade laufen
        // hier durch: setMode(), applyShellState, navigation:changed).
        invoke('menu_set_checked', { id: 'view.mode.view', checked: mode === 'view' }).catch(function(){});
        invoke('menu_set_checked', { id: 'view.mode.edit', checked: mode === 'edit' }).catch(function(){});
        invoke('menu_set_checked', { id: 'view.mode.split', checked: mode === 'split' }).catch(function(){});
    }
    function setRailButton(side, visible) {
        var btn = side === 'left' ? $('tb-rail-left') : $('tb-rail-right');
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
        if (mode === 'edit' && typeof window.layoutEditor === 'function') window.layoutEditor();
        var theme = state.theme || 'light';
        document.documentElement.classList.toggle('theme-dark', theme === 'dark');
        document.documentElement.classList.toggle('theme-light', theme === 'light');
        if (typeof window.setEditorTheme === 'function') window.setEditorTheme(theme);
        if (typeof state.leftRailVisible === 'boolean') applyRailVisibility('left', state.leftRailVisible);
        if (typeof state.rightRailVisible === 'boolean') applyRailVisibility('right', state.rightRailVisible);
        var editor = state.editor || {};
        if (typeof editor.leftRailWidth === 'number') {
            setVaultWidth(editor.leftRailWidth);
        }
        if (typeof editor.rightRailWidth === 'number') {
            setTocWidth(editor.rightRailWidth);
        }
    }
    bind('tb-mode-view', function () { setMode('view'); });
    bind('tb-mode-edit', function () { setMode('edit'); });
    bind('tb-save', function () { if (isDirty) saveCurrent(); });

    /* ----- Export-Dialog (Modul) ----- */
    initExportDialog({
        getCurrentPath: function () { return currentPath; },
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

    /* ----- Statusbar ----- */
    function setStatusPath(path, dirty) {
        var el = $('status-path');
        if (!el) return;
        el.textContent = path || 'Bereit';
        el.classList.toggle('dirty', !!dirty);
    }
    function updateWordCount(text) {
        var el = $('status-wordcount');
        if (!el) return;
        if (!text) { el.hidden = true; el.textContent = ''; return; }
        var chars = text.length;
        var words = (text.match(/\S+/g) || []).length;
        var lines = text.split(/\r\n|\r|\n/).length;
        el.hidden = false;
        el.textContent = words + ' Wörter · ' + chars + ' Zeichen · ' + lines + ' Zeilen';
    }
    bind('status-theme-toggle', function () { invoke('theme_set', { mode: 'toggle' }).catch(function(){}); });

    /* ----- Tastatur-Shortcuts ----- */
    /* ----- WebView-Zoom (Modul) ----- */
    initZoom();

    document.addEventListener('keydown', function (e) {
        var ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key === '1') { e.preventDefault(); $('tb-mode-view').click(); }
        else if (ctrl && e.key === '2') { e.preventDefault(); $('tb-mode-edit').click(); }
        else if (ctrl && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); invoke('open_find').catch(function(){}); }
        else if (e.key === 'F3') {
            e.preventDefault();
            if (e.shiftKey) findPrevBar(); else findNextBar();
        }
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

    /* ----- Vault: Workspace laden + rendern + Klicks ----- */
    var vaultTree = $('vault-tree');
    var fileIconCache = {};       // ext → data-URI
    var fileIconPending = {};     // ext → Promise (Anti-Stampede)
    function resolveFileIcon(ext) {
        if (fileIconCache[ext] !== undefined) {
            return Promise.resolve(fileIconCache[ext]);
        }
        if (fileIconPending[ext]) return fileIconPending[ext];
        var p = invoke('file_icon_data_uri', { ext: ext }).then(function (uri) {
            fileIconCache[ext] = uri || '';
            delete fileIconPending[ext];
            return fileIconCache[ext];
        }).catch(function () {
            fileIconCache[ext] = '';
            delete fileIconPending[ext];
            return '';
        });
        fileIconPending[ext] = p;
        return p;
    }
    function applyIconsToNode(rootNode) {
        if (!rootNode) return;
        var imgs;
        if (rootNode.matches && rootNode.matches('img.ftype-icon')) {
            imgs = [rootNode];
        } else if (rootNode.querySelectorAll) {
            imgs = rootNode.querySelectorAll('img.ftype-icon');
        } else {
            return;
        }
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            if (img.src) continue;
            var ext = img.getAttribute('data-ext') || '';
            (function (target, e) {
                resolveFileIcon(e).then(function (uri) {
                    if (uri) target.src = uri;
                });
            })(img, ext);
        }
    }
    if (vaultTree && typeof MutationObserver === 'function') {
        var iconObserver = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var added = mutations[m].addedNodes;
                for (var n = 0; n < added.length; n++) {
                    if (added[n].nodeType === 1) applyIconsToNode(added[n]);
                }
            }
        });
        iconObserver.observe(vaultTree, { childList: true, subtree: true });
    }
    function renderVault(html) {
        if (!vaultTree) return;
        if (!html || html.length === 0) {
            vaultTree.innerHTML = '<li class="empty">Keine Einträge. Datei öffnen oder per Drag&amp;Drop ablegen.</li>';
            return;
        }
        vaultTree.innerHTML = html;
        applyIconsToNode(vaultTree);
        if (typeof window.reapplyVaultActive === 'function') window.reapplyVaultActive();
    }
    function refreshVault() {
        invoke('vault_build_tree').then(renderVault).catch(function (err) {
            console.warn('vault_build_tree failed:', err);
        });
    }
    refreshVault();

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

    if (vaultTree) {
        vaultTree.addEventListener('click', function (e) {
            var item = e.target.closest('.vault-item');
            if (!item) return;
            var path = item.getAttribute('data-path');
            var isDir = item.getAttribute('data-directory') === 'true';
            if (!path) return;
            if (isDir) {
                invoke('vault_expand_dir', { path: path }).catch(function () {});
            } else {
                openDocument(path);
            }
        });
        vaultTree.addEventListener('contextmenu', function (e) {
            var item = e.target.closest('li.node');
            if (!item) return;
            e.preventDefault();
            var path = item.getAttribute('data-path');
            var isDir = item.getAttribute('data-kind') === 'dir';
            var inPinned = isDirectChildOfSection(item, 'pinned');
            var inRecent = isDirectChildOfSection(item, 'recent');
            openContextMenu(e.clientX, e.clientY, path, isDir, inPinned, inRecent);
        });
    }
    function isDirectChildOfSection(node, sectionKey) {
        var parentUl = node.parentElement;
        if (!parentUl) return false;
        var sectionLi = parentUl.parentElement;
        return !!(sectionLi
            && sectionLi.classList
            && sectionLi.classList.contains('section')
            && sectionLi.getAttribute('data-section') === sectionKey);
    }

    /* Vault-Header-Buttons (Datei/Ordner öffnen) werden vom REGION-Click-Handler
       in der Vault-IIFE behandelt — dort mit Dirty-Check via window.openDocument. */

    /* ----- Kontextmenü ----- */
    var ctxMenu = $('context-menu');
    var ctxTarget = null;
    function openContextMenu(x, y, path, isDir, inPinned, inRecent) {
        if (!ctxMenu) return;
        ctxTarget = { path: path, isDirectory: isDir };
        var parts = [];
        if (!isDir) parts.push('<div class="ctx-item" data-act="open">Öffnen</div>');
        var actionsBefore = parts.length;
        var actions = [];
        if (!isDir) actions.push('<div class="ctx-item" data-act="rename">Umbenennen</div>');
        if (!inPinned) actions.push('<div class="ctx-item" data-act="pin">Anpinnen</div>');
        if (inPinned) actions.push('<div class="ctx-item" data-act="unpin">Vom Pin lösen</div>');
        if (inRecent) actions.push('<div class="ctx-item" data-act="remove-recent">Aus „Zuletzt" entfernen</div>');
        if (actions.length && actionsBefore) parts.push('<div class="ctx-sep"></div>');
        parts = parts.concat(actions);
        var tail = [
            '<div class="ctx-item" data-act="show">Im Explorer zeigen</div>',
            '<div class="ctx-item" data-act="terminal">Terminal hier öffnen</div>',
            '<div class="ctx-item" data-act="copy">Pfad kopieren</div>',
        ];
        if (parts.length) parts.push('<div class="ctx-sep"></div>');
        parts = parts.concat(tail);
        ctxMenu.innerHTML = parts.join('');
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
        ctxMenu.classList.add('open');
    }
    function closeContextMenu() {
        if (ctxMenu) ctxMenu.classList.remove('open');
        ctxTarget = null;
    }
    if (ctxMenu) {
        ctxMenu.addEventListener('click', function (e) {
            var item = e.target.closest('.ctx-item');
            if (!item || item.classList.contains('disabled') || !ctxTarget) return;
            var act = item.getAttribute('data-act');
            var path = ctxTarget.path;
            var isDir = ctxTarget.isDirectory;
            closeContextMenu();
            if (act === 'open' && !isDir) {
                openDocument(path);
            } else if (act === 'pin') {
                invoke('workspace_pin', { path: path, isDirectory: isDir }).catch(function(){});
            } else if (act === 'unpin') {
                invoke('workspace_unpin', { path: path }).catch(function(){});
            } else if (act === 'remove-recent') {
                invoke('workspace_remove_recent', { path: path }).catch(function(){});
            } else if (act === 'rename') {
                startInlineRename(path);
            } else if (act === 'show') {
                invoke('show_in_file_manager', { path: path }).catch(function(){});
            } else if (act === 'terminal') {
                invoke('open_terminal_at', { path: path }).catch(function(){});
            } else if (act === 'copy') {
                if (navigator.clipboard) navigator.clipboard.writeText(path).catch(function(){});
            }
        });
        document.addEventListener('click', function (e) {
            if (!ctxMenu.contains(e.target)) closeContextMenu();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeContextMenu();
        });
    }

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

    /* ----- Backend-Events ----- */
    listen('document:loaded', function (event) {
        var data = event && event.payload || {};
        currentPath = data.path || null;
        cleanText = data.text || '';
        markDirty(false);
        setStatusPath(data.path || 'Bereit', false);
        updateWordCount(data.text || '');
        applyDocKind(data.kind || 'unknown');
        invoke('workspace_add_recent', { path: data.path }).catch(function(){});
        // Such-Highlights gehen im View-Mode beim innerHTML-Replace verloren — neu setzen.
        var bar = document.getElementById('find-bar');
        if (bar && bar.classList.contains('open') && !document.body.classList.contains('edit-mode')) {
            var input = document.getElementById('find-input');
            if (input && input.value && window.ViewFinder) {
                setTimeout(function () { window.ViewFinder.setFindTerm(input.value); }, 0);
            }
        }
    });
    listen('document:dirty_changed', function (event) {
        var dirty = event && event.payload && (event.payload.is_dirty || event.payload.isDirty);
        markDirty(!!dirty);
    });
    // document:closed wird vom close_document-Command emittiert. Wir
    // setzen die Frontend-Sicht analog zum Boot-Zustand zurück: kein
    // Pfad, leerer Editor, „Bereit"-Statusbar, kein Word-Count.
    listen('document:closed', function () {
        currentPath = null;
        cleanText = '';
        markDirty(false);
        if (window.FolioEditor && typeof window.FolioEditor.setText === 'function') {
            window.FolioEditor.setText('', 'plaintext');
        }
        // View-Region und TOC zurücksetzen, sonst bleibt das zuletzt
        // gerenderte HTML stehen.
        var view = document.getElementById('view-region');
        var body = view && view.querySelector('.markdown-body');
        if (body) body.innerHTML = '';
        if (typeof window.setTocList === 'function') window.setTocList('');
        applyDocKind('unknown');
        setStatusPath('Bereit', false);
        updateWordCount('');
        applyWindowTitle();
    });
    listen('document:saved', function (event) {
        var data = event && event.payload || {};
        cleanText = data.text || editorText();
        markDirty(false);
        renderDocumentPayload(data);
        updateWordCount(data.text || '');
    });
    listen('vault:refresh', function () {
        refreshVault();
    });
    listen('app:set_mode', function (event) {
        var mode = (event && event.payload && event.payload.mode) || 'view';
        setActiveMode(mode);
        findBarAfterModeSwitch();
    });
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
        if (currentPath) markDirty(text !== cleanText);
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
            if (isDirty) saveCurrent();
        });
        ev.listen('menu:file_recent', function (event) {
            var p = event && event.payload && event.payload.path;
            if (p && typeof window.openDocument === 'function') {
                window.openDocument(p);
            }
        });
        ev.listen('menu:file_close', function () {
            if (!currentPath) return;
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
