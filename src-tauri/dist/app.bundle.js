(() => {
  // app/ui/cheatsheet.ts
  var STORAGE_KEY = "folio.cheatsheet";
  var cheatSheetRows = [
    ["\xDCberschrift", "# H1   ## H2   ### H3"],
    ["Fett / Kursiv", "**fett**   *kursiv*"],
    ["Durchgestrichen", "~~text~~"],
    ["Inline-Code", "`code`"],
    ["Codeblock", "```codeblock```"],
    ["Link", "[Text](https://\u2026)"],
    ["Bild", "![alt](pfad.png)"],
    ["Aufz\xE4hlung", "- Item   * Item"],
    ["Nummeriert", "1. Item"],
    ["Zitat", "> Text"],
    ["Trennlinie", "---"],
    ["Tabelle", "| col | col |\n|---|---|"],
    ["Aufgabe", "- [ ] offen   - [x] erledigt"]
  ];
  var overlay = null;
  var dragHeader = null;
  var body = null;
  var dragState = null;
  var rightOffset = 16;
  var topOffset = 80;
  var wantsVisible = false;
  var lastRows = null;
  function post(msg) {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.emit("shell:event", msg);
    }
  }
  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.right === "number" && s.right >= 0) rightOffset = s.right;
      if (typeof s.top === "number" && s.top >= 0) topOffset = s.top;
      if (typeof s.visible === "boolean") wantsVisible = s.visible;
    } catch (_) {
    }
  }
  function saveStored() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        right: rightOffset,
        top: topOffset,
        visible: wantsVisible
      }));
    } catch (_) {
    }
  }
  function applyPosition() {
    overlay.style.right = rightOffset + "px";
    overlay.style.top = topOffset + "px";
    overlay.style.left = "auto";
    overlay.style.bottom = "auto";
  }
  function verticalBounds() {
    const tb = document.getElementById("toolbar");
    const sb = document.getElementById("statusbar");
    const top = tb ? tb.getBoundingClientRect().bottom : 0;
    const bottom = sb ? sb.getBoundingClientRect().top : window.innerHeight;
    return { top: Math.max(0, top), bottom: Math.max(top, bottom) };
  }
  function clampInsideViewport() {
    const rect = overlay.getBoundingClientRect();
    const winW = window.innerWidth;
    const bounds = verticalBounds();
    if (rect.right > winW - 1) rightOffset = 0;
    if (rect.left < 0) rightOffset = Math.max(0, winW - rect.width);
    if (rect.bottom > bounds.bottom) topOffset = Math.max(bounds.top, bounds.bottom - rect.height);
    if (rect.top < bounds.top) topOffset = bounds.top;
    applyPosition();
  }
  function renderRows(rowsJson) {
    body.innerHTML = "";
    try {
      const rows = typeof rowsJson === "string" ? JSON.parse(rowsJson) : rowsJson;
      if (Array.isArray(rows)) {
        lastRows = rows;
        rows.forEach(function(r) {
          const l = document.createElement("div");
          l.className = "label";
          l.textContent = r.label || "";
          const c = document.createElement("div");
          c.className = "code";
          c.textContent = r.code || "";
          body.appendChild(l);
          body.appendChild(c);
        });
      }
    } catch (_) {
    }
  }
  function showCheatSheet(rowsJson) {
    wantsVisible = true;
    saveStored();
    renderRows(rowsJson);
    overlay.hidden = false;
    applyPosition();
    requestAnimationFrame(clampInsideViewport);
  }
  function hideCheatSheet() {
    wantsVisible = false;
    saveStored();
    if (overlay.hidden) return;
    overlay.hidden = true;
    post({ type: "cheatsheetClosed", rightOffset, topOffset });
  }
  function cheatsheetSyncMode(isEdit) {
    if (isEdit) {
      if (wantsVisible) {
        const rows = lastRows || cheatSheetRows.map((r) => ({ label: r[0], code: r[1] }));
        renderRows(rows);
        overlay.hidden = false;
        applyPosition();
        requestAnimationFrame(clampInsideViewport);
      }
    } else {
      if (!overlay.hidden) {
        overlay.hidden = true;
      }
    }
  }
  function syncCheatsheetMenu() {
    if (!window.__TAURI__ || !window.__TAURI__.core) return;
    const enabled = document.body.classList.contains("edit-mode") && document.body.classList.contains("kind-markdown");
    window.__TAURI__.core.invoke("menu_set_enabled", { id: "help.cheatsheet", enabled }).catch(function() {
    });
  }
  function initCheatsheet() {
    overlay = document.getElementById("cheatsheet-overlay");
    dragHeader = overlay.querySelector(".overlay__drag");
    body = document.getElementById("cheatsheet-body");
    loadStored();
    dragHeader.addEventListener("pointerdown", function(e) {
      try {
        dragHeader.setPointerCapture(e.pointerId);
      } catch (_) {
      }
      dragState = { x: e.clientX, y: e.clientY, r: rightOffset, t: topOffset };
      e.preventDefault();
    });
    dragHeader.addEventListener("pointermove", function(e) {
      if (!dragState) return;
      const dx = e.clientX - dragState.x;
      const dy = e.clientY - dragState.y;
      const rect = overlay.getBoundingClientRect();
      const winW = window.innerWidth;
      const bounds = verticalBounds();
      const maxR = Math.max(0, winW - rect.width);
      const maxT = Math.max(bounds.top, bounds.bottom - rect.height);
      rightOffset = Math.min(maxR, Math.max(0, dragState.r - dx));
      topOffset = Math.min(maxT, Math.max(bounds.top, dragState.t + dy));
      applyPosition();
    });
    function endDrag(e) {
      if (!dragState) return;
      try {
        dragHeader.releasePointerCapture(e.pointerId);
      } catch (_) {
      }
      dragState = null;
      saveStored();
    }
    dragHeader.addEventListener("pointerup", endDrag);
    dragHeader.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", function() {
      if (overlay.hidden) return;
      clampInsideViewport();
    });
  }

  // app/ui/zoom.ts
  var ZOOM_KEY = "folio.zoom";
  var ZOOM_STEP = 0.1;
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 3;
  var current = 1;
  var indicator = null;
  var hideTimer = null;
  var fadeTimer = null;
  function showIndicator(z) {
    if (!indicator) return;
    indicator.textContent = Math.round(z * 100) + " %";
    indicator.hidden = false;
    requestAnimationFrame(function() {
      indicator.classList.add("visible");
    });
    if (hideTimer) clearTimeout(hideTimer);
    if (fadeTimer) clearTimeout(fadeTimer);
    hideTimer = setTimeout(function() {
      indicator.classList.remove("visible");
      fadeTimer = setTimeout(function() {
        indicator.hidden = true;
      }, 250);
    }, 1500);
  }
  function loadStoredZoom() {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY));
    return isFinite(z) && z > 0 ? z : 1;
  }
  function applyZoom(z, opts) {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
    current = z;
    if (window.__TAURI__ && window.__TAURI__.core) {
      window.__TAURI__.core.invoke("set_webview_zoom", { zoom: z }).catch(function() {
      });
    }
    try {
      localStorage.setItem(ZOOM_KEY, String(z));
    } catch (_) {
    }
    if (!opts || opts.indicator !== false) showIndicator(z);
    return z;
  }
  function adjustZoom(delta) {
    return applyZoom(current + delta);
  }
  function resetZoom() {
    return applyZoom(1);
  }
  function initZoom() {
    indicator = document.getElementById("zoom-indicator");
    applyZoom(loadStoredZoom(), { indicator: false });
    window.addEventListener("wheel", function(e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    }, { capture: true, passive: false });
    document.addEventListener("keydown", function(e) {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        adjustZoom(ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        adjustZoom(-ZOOM_STEP);
      }
    });
  }

  // app/main.ts
  (function() {
    var post2 = function(msg) {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit("shell:event", msg);
      }
    };
    var contentEl = document.getElementById("view-region");
    contentEl.addEventListener("click", function(e) {
      var el = e.target;
      while (el && el.tagName !== "A") el = el.parentElement;
      if (!el) return;
      var href = el.getAttribute("href");
      if (href === null) return;
      e.preventDefault();
      post2({ type: "linkClick", href });
    }, true);
    (function() {
      var currentHeading = null;
      var lastScrollY = -1;
      function collectHeadings() {
        return Array.prototype.slice.call(
          contentEl.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")
        );
      }
      function sendHeading(id) {
        if (id === currentHeading) return;
        currentHeading = id;
        post2({ type: "visibleHeading", id: id || "" });
      }
      function sendScroll(y) {
        if (y === lastScrollY) return;
        lastScrollY = y;
        post2({ type: "scrollPosition", y });
      }
      function update() {
        var hs = collectHeadings();
        if (hs.length === 0) {
          sendHeading(null);
        } else {
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
        requestAnimationFrame(function() {
          rafQueued = false;
          update();
        });
      }
      contentEl.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule);
      window.addEventListener("load", update);
    })();
    var tocEl = document.getElementById("toc-region");
    tocEl.addEventListener("click", function(e) {
      var el = e.target;
      while (el && !(el.classList && el.classList.contains("entry"))) el = el.parentElement;
      if (!el) return;
      var slug = el.getAttribute("data-slug");
      if (slug) post2({ type: "tocClick", slug });
    });
    window.setTocActive = function(slug) {
      var prev = tocEl.querySelectorAll("li.entry.active");
      for (var i = 0; i < prev.length; i++) prev[i].classList.remove("active");
      if (!slug) return;
      var target = tocEl.querySelector('li.entry[data-slug="' + slug + '"]');
      if (target) {
        target.classList.add("active");
        target.scrollIntoView({ block: "nearest" });
      }
    };
    window.setTocList = function(html) {
      var ul = tocEl.querySelector("ul.toc");
      if (ul) ul.innerHTML = html;
    };
    window.scrollViewToAnchor = function(slug) {
      if (!slug) return;
      var target = contentEl.querySelector("#" + CSS.escape(slug));
      if (target) target.scrollIntoView({ block: "start" });
    };
    window.scrollViewTo = function(y) {
      contentEl.scrollTo(0, y || 0);
    };
    window.setRailVisibility = function(side, visible) {
      if (side === "right") {
        document.body.classList.toggle("toc-hidden", !visible);
      } else if (side === "left") {
        document.body.classList.toggle("vault-hidden", !visible);
      }
    };
    window.setTocWidth = function(w) {
      if (typeof w !== "number" || isNaN(w) || w <= 0) return;
      document.documentElement.style.setProperty("--toc-w", w + "px");
    };
    window.setVaultWidth = function(w) {
      if (typeof w !== "number" || isNaN(w) || w <= 0) return;
      document.documentElement.style.setProperty("--vault-w", w + "px");
    };
    window.setEditMode = function(on) {
      document.body.classList.toggle("edit-mode", !!on);
      if (on && typeof window.layoutEditor === "function") window.layoutEditor();
    };
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === "function") {
      window.__TAURI__.event.listen("shell:command", function(event) {
        var data = event && event.payload;
        if (!data || typeof data !== "object") return;
        switch (data.type) {
          case "loadEditorText":
            if (typeof window.loadEditorText === "function") {
              window.loadEditorText(data.text || "");
            }
            break;
          case "applyEditorReplace":
            if (typeof window.applyEditorReplace === "function") {
              window.applyEditorReplace(
                data.fullText || "",
                data.selectionStart || 0,
                data.selectionLength || 0
              );
            }
            break;
          case "insertVaultChildren":
            if (typeof window.insertVaultChildren === "function") {
              window.insertVaultChildren(data.path || "", data.html || "");
            }
            break;
          default:
            break;
        }
      });
      window.__TAURI__.event.listen("document:loaded", function(event) {
        var data = event && event.payload;
        if (!data || typeof data !== "object") return;
        if (typeof window.loadEditorText === "function") {
          window.loadEditorText(data.text || "", data.language || "");
        }
        if (typeof window.setEditorLanguageDisplay === "function") {
          window.setEditorLanguageDisplay(data.language || "plaintext");
        }
        if (typeof window.setTocList === "function") {
          window.setTocList(data.tocHtml || data.toc_html || "");
        }
        var body2 = contentEl.querySelector(".markdown-body");
        if (body2) {
          var isMd = data.kind === "markdown";
          body2.innerHTML = isMd ? data.content || data.html || "" : "";
          if (isMd && typeof window.rewriteRelativeAssets === "function") {
            window.rewriteRelativeAssets(body2, data.path || "");
          }
        }
        if (typeof window.setVaultActive === "function") {
          window.setVaultActive(data.path || "");
        }
      });
      window.__TAURI__.event.listen("navigation:changed", function(event) {
        var data = event && event.payload;
        if (!data || typeof data !== "object") return;
        var anchor = data.anchor || data.slug || "";
        if (typeof window.setTocActive === "function") {
          window.setTocActive(anchor);
        }
        if (data.view_mode) {
          window.__TAURI__.core.invoke("set_view_mode", { mode: data.view_mode }).catch(function() {
          });
        }
        var viewScroll = typeof data.scroll_y === "number" ? data.scroll_y : 0;
        var editorCursor = typeof data.editor_cursor === "number" ? data.editor_cursor : 0;
        var editorScroll = typeof data.editor_scroll_y === "number" ? data.editor_scroll_y : 0;
        requestAnimationFrame(function() {
          if (anchor && typeof window.scrollViewToAnchor === "function") {
            window.scrollViewToAnchor(anchor);
          } else if (typeof window.scrollViewTo === "function") {
            window.scrollViewTo(viewScroll);
          }
          if (!window.FolioEditor) return;
          if (typeof window.FolioEditor.setSelection === "function") {
            window.FolioEditor.setSelection(editorCursor, 0);
          }
          if (typeof window.FolioEditor.setScroll === "function") {
            window.FolioEditor.setScroll(editorScroll);
          }
        });
      });
      window.__TAURI__.event.listen("editor:load_text", function(event) {
        var data = event && event.payload;
        var text = data && typeof data === "object" ? data.text || "" : "";
        if (typeof window.loadEditorText === "function") window.loadEditorText(text);
      });
      window.__TAURI__.event.listen("editor:apply_replace", function(event) {
        var data = event && event.payload;
        if (!data || typeof data !== "object") return;
        if (typeof window.applyEditorReplace === "function") {
          window.applyEditorReplace(data.fullText || "", data.start || 0, data.length || 0);
        }
      });
      window.__TAURI__.event.listen("vault:refresh", function(event) {
        var data = event && event.payload;
        if (!data || typeof data !== "object") return;
        if (data.pinned && typeof window.setVaultPinned === "function") window.setVaultPinned(data.pinned);
        if (data.recent && typeof window.setVaultRecent === "function") window.setVaultRecent(data.recent);
      });
      window.__TAURI__.event.listen("app:set_mode", function(event) {
        var data = event && event.payload;
        var mode = data && data.mode || "view";
        document.body.classList.toggle("edit-mode", mode === "edit");
        document.body.classList.toggle("split-mode", mode === "split");
        if (mode === "edit" && typeof window.focusEditor === "function") {
          window.focusEditor();
        }
        syncCheatsheetMenu();
        var core = window.__TAURI__.core;
        core.invoke("menu_set_enabled", { id: "edit.undo", enabled: mode === "edit" }).catch(function() {
        });
        core.invoke("menu_set_enabled", { id: "edit.redo", enabled: mode === "edit" }).catch(function() {
        });
      });
      window.__TAURI__.event.listen("app:set_theme", function(event) {
        var data = event && event.payload;
        var mode = data && data.mode || "light";
        var html = document.documentElement;
        if (mode === "toggle") {
          mode = html.classList.contains("theme-dark") ? "light" : "dark";
        }
        html.classList.toggle("theme-dark", mode === "dark");
        html.classList.toggle("theme-light", mode === "light");
        if (typeof window.setEditorTheme === "function") {
          window.setEditorTheme(mode);
        }
        var core = window.__TAURI__.core;
        core.invoke("menu_set_checked", { id: "view.theme.light", checked: mode === "light" }).catch(function() {
        });
        core.invoke("menu_set_checked", { id: "view.theme.dark", checked: mode === "dark" }).catch(function() {
        });
      });
      window.__TAURI__.event.listen("panel:rail_changed", function(event) {
        var data = event && event.payload;
        if (!data || typeof window.setRailVisibility !== "function") return;
        if (typeof data.leftRailVisible === "boolean") {
          window.setRailVisibility("left", data.leftRailVisible);
        }
        if (typeof data.rightRailVisible === "boolean") {
          window.setRailVisibility("right", data.rightRailVisible);
        }
      });
      window.__TAURI__.event.listen("editor:open_find", function() {
        var bar = document.getElementById("find-bar");
        if (bar) bar.classList.add("open");
        var input = document.getElementById("find-input");
        if (input) {
          input.focus();
          input.select();
        }
      });
      window.__TAURI__.event.listen("editor:set_find_term", function(event) {
        var data = event && event.payload;
        var term = data && data.term || "";
        var input = document.getElementById("find-input");
        if (input) {
          input.value = term;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      window.__TAURI__.event.listen("navigation:toc_click", function(event) {
        var data = event && event.payload;
        var anchor = data && (data.anchor || data.slug);
        if (anchor && typeof window.scrollViewToAnchor === "function") {
          window.scrollViewToAnchor(anchor);
        }
        if (typeof window.setTocActive === "function") window.setTocActive(anchor || "");
      });
    }
    var editorMounted = false;
    function ensureEditorMounted(initial) {
      if (editorMounted) return Promise.resolve(true);
      if (!window.FolioEditor || typeof window.FolioEditor.mount !== "function") {
        console.error("[folio] FolioEditor bundle not available");
        return Promise.resolve(false);
      }
      return window.FolioEditor.mount("editor-mount", initial || "").then(function() {
        editorMounted = true;
        return true;
      }).catch(function(err) {
        console.error("[folio] Editor mount failed:", err);
        return false;
      });
    }
    window.loadEditorText = function(text, language) {
      ensureEditorMounted(text || "").then(function(ok) {
        if (!ok) return;
        window.FolioEditor.setText(text || "", language || "plaintext");
        if (document.body.classList.contains("edit-mode")) {
          window.layoutEditor();
        }
      });
    };
    window.focusEditor = function() {
      var initial = typeof cleanText === "string" ? cleanText : "";
      ensureEditorMounted(initial).then(function(ok) {
        if (!ok) return;
        window.layoutEditor();
        window.FolioEditor.focus();
      });
    };
    window.layoutEditor = function() {
      if (!window.FolioEditor || !editorMounted || typeof window.FolioEditor.layout !== "function") return;
      requestAnimationFrame(function() {
        window.FolioEditor.layout();
        requestAnimationFrame(function() {
          window.FolioEditor.layout();
        });
      });
    };
    window.setEditorTheme = function(mode) {
      if (window.FolioEditor) window.FolioEditor.setTheme(mode);
    };
    window.requestEditorSelection = function() {
      if (!window.FolioEditor) return null;
      return window.FolioEditor.getSelection();
    };
    window.applyEditorReplace = function(fullText, selectionStart, selectionLength) {
      if (!window.FolioEditor) return;
      window.FolioEditor.applyReplace({
        fullText: fullText || "",
        selectionStart: selectionStart || 0,
        selectionLength: selectionLength || 0
      });
    };
    (function() {
      var CHUNK_SIZE = 500;
      var hasHighlightAPI = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
      var matchHL = null;
      var activeHL = null;
      function ensureHighlights() {
        if (!hasHighlightAPI) return;
        if (!matchHL) {
          matchHL = new Highlight();
          CSS.highlights.set("folio-find", matchHL);
        }
        if (!activeHL) {
          activeHL = new Highlight();
          CSS.highlights.set("folio-find-active", activeHL);
        }
      }
      var rangesArr = [];
      var activeIdx = -1;
      var currentTerm = "";
      var opts = { caseSensitive: false, wholeWord: false };
      var searchToken = 0;
      function getRoot() {
        return document.querySelector("#view-region main.markdown-body");
      }
      function getContent() {
        return document.getElementById("view-content");
      }
      function getLane() {
        return document.getElementById("view-marker-lane");
      }
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
        var contentTop = content.getBoundingClientRect().top;
        var scrollTop = content.scrollTop;
        var laneH = Math.max(1, lane.clientHeight);
        var seen = new Uint8Array(laneH);
        var activePixel = -1;
        var pixels = [];
        for (var i = 0; i < rangesArr.length; i++) {
          var rect = rangesArr[i].getBoundingClientRect();
          var pos = scrollTop + (rect.top - contentTop);
          var px = Math.max(0, Math.min(laneH - 1, Math.round(pos / totalH * laneH)));
          if (i === activeIdx) activePixel = px;
          if (!seen[px]) {
            seen[px] = 1;
            pixels.push(px);
          }
        }
        var frag = document.createDocumentFragment();
        for (var j = 0; j < pixels.length; j++) {
          var p = pixels[j];
          var dot = document.createElement("div");
          dot.className = "folio-marker" + (p === activePixel ? " active" : "");
          dot.style.top = p / laneH * 100 + "%";
          frag.appendChild(dot);
        }
        lane.appendChild(frag);
      }
      function clearMarks() {
        if (matchHL) matchHL.clear();
        if (activeHL) activeHL.clear();
        rangesArr = [];
        activeIdx = -1;
        clearLane();
      }
      function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      function buildRegex(term) {
        if (!term) return null;
        var pattern = escapeRegExp(term);
        if (opts.wholeWord) pattern = "\\b" + pattern + "\\b";
        var flags = opts.caseSensitive ? "g" : "gi";
        try {
          return new RegExp(pattern, flags);
        } catch (e) {
          return null;
        }
      }
      function buildWalker(root) {
        return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: function(node) {
            var p = node.parentNode;
            while (p && p !== root) {
              var tn = p.nodeName ? p.nodeName.toLowerCase() : "";
              if (tn === "script" || tn === "style") return NodeFilter.FILTER_REJECT;
              p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        });
      }
      function collectRangesAsync(root, regex, myToken, done) {
        var walker = buildWalker(root);
        function step() {
          if (myToken !== searchToken) return;
          var batchStart = rangesArr.length;
          var node;
          while (node = walker.nextNode()) {
            var text = node.nodeValue || "";
            if (!text) continue;
            regex.lastIndex = 0;
            var m;
            while (m = regex.exec(text)) {
              if (m[0].length === 0) {
                regex.lastIndex++;
                continue;
              }
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
          window.dispatchEvent(new CustomEvent("folio-find-state", { detail }));
        } catch (e) {
        }
        try {
          post2({ type: "editorFindState", term: detail.term, total: detail.total, active: detail.active });
        } catch (e) {
        }
      }
      function dispatchProgress(partialTotal) {
        try {
          window.dispatchEvent(new CustomEvent("folio-find-state", {
            detail: { term: currentTerm, total: partialTotal, active: -1, scanning: true }
          }));
        } catch (e) {
        }
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
        var r = rangesArr[activeIdx];
        var anchor = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
        if (anchor) {
          try {
            anchor.scrollIntoView({ block: "center", inline: "nearest" });
          } catch (e) {
            try {
              anchor.scrollIntoView(true);
            } catch (_) {
            }
          }
        }
        updateMarkers();
        dispatchState();
      }
      function research() {
        clearMarks();
        var myToken = ++searchToken;
        if (!currentTerm) {
          dispatchState();
          return;
        }
        var root = getRoot();
        if (!root) {
          dispatchState();
          return;
        }
        var regex = buildRegex(currentTerm);
        if (!regex) {
          dispatchState();
          return;
        }
        ensureHighlights();
        collectRangesAsync(root, regex, myToken, function() {
          if (myToken !== searchToken) return;
          if (rangesArr.length > 0) setActive(0);
          else {
            updateMarkers();
            dispatchState();
          }
        });
      }
      window.ViewFinder = {
        openFind: function(initial) {
          if (typeof initial === "string" && initial.length > 0) currentTerm = initial;
          research();
        },
        closeFind: function() {
          searchToken++;
          clearMarks();
          currentTerm = "";
          dispatchState();
        },
        setFindTerm: function(term) {
          currentTerm = term || "";
          research();
        },
        setFindOptions: function(newOpts) {
          newOpts = newOpts || {};
          opts.caseSensitive = !!newOpts.caseSensitive;
          opts.wholeWord = !!newOpts.wholeWord;
          research();
        },
        findNext: function() {
          if (rangesArr.length > 0) setActive((activeIdx + 1) % rangesArr.length);
        },
        findPrev: function() {
          if (rangesArr.length > 0) setActive((activeIdx - 1 + rangesArr.length) % rangesArr.length);
        }
      };
    })();
    (function() {
      var bar = document.getElementById("find-bar");
      var input = document.getElementById("find-input");
      var counter = document.getElementById("find-counter");
      var prevBtn = document.getElementById("find-prev");
      var nextBtn = document.getElementById("find-next");
      var optsBtn = document.getElementById("find-opts");
      var closeBtn = document.getElementById("find-close");
      var optsPanel = document.getElementById("find-opts-panel");
      var caseChk = document.getElementById("find-case");
      var wordChk = document.getElementById("find-word");
      function isEditMode() {
        return document.body.classList.contains("edit-mode");
      }
      function getFinder() {
        return isEditMode() ? window.FolioEditor : window.ViewFinder;
      }
      function isOpen() {
        return bar.classList.contains("open");
      }
      function doOpen(initial) {
        bar.classList.add("open");
        if (typeof initial === "string" && initial.length > 0) {
          input.value = initial;
        }
        var f = getFinder();
        if (f) {
          f.setFindOptions({
            caseSensitive: caseChk.checked,
            wholeWord: wordChk.checked
          });
          f.openFind(input.value);
        }
        input.focus();
        input.select();
      }
      function open(initial) {
        if (isEditMode()) {
          ensureEditorMounted("").then(function(ok) {
            if (!ok) return;
            doOpen(initial);
          });
        } else {
          doOpen(initial);
        }
      }
      function close() {
        bar.classList.remove("open");
        optsPanel.classList.remove("open");
        optsBtn.classList.remove("active");
        if (window.FolioEditor) window.FolioEditor.closeFind();
        if (window.ViewFinder) window.ViewFinder.closeFind();
        if (isEditMode() && window.focusEditor) window.focusEditor();
      }
      window.openEditorFind = function(initialTerm) {
        open(initialTerm);
      };
      window.closeEditorFind = function() {
        close();
      };
      window.setEditorFindTerm = function(term) {
        input.value = term || "";
        if (!isOpen()) open(term || "");
        else {
          var f = getFinder();
          if (f) f.setFindTerm(term || "");
        }
      };
      var inputDebounce = null;
      var INPUT_DEBOUNCE_MS = 150;
      input.addEventListener("input", function() {
        if (input.value) lastTermMemo = input.value;
        if (inputDebounce) clearTimeout(inputDebounce);
        inputDebounce = setTimeout(function() {
          inputDebounce = null;
          var f = getFinder();
          if (f) f.setFindTerm(input.value);
        }, INPUT_DEBOUNCE_MS);
      });
      input.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var f = getFinder();
          if (!f) return;
          if (e.shiftKey) f.findPrev();
          else f.findNext();
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      });
      prevBtn.addEventListener("click", function() {
        var f = getFinder();
        if (f) f.findPrev();
      });
      nextBtn.addEventListener("click", function() {
        var f = getFinder();
        if (f) f.findNext();
      });
      closeBtn.addEventListener("click", close);
      optsBtn.addEventListener("click", function() {
        var on = !optsPanel.classList.contains("open");
        optsPanel.classList.toggle("open", on);
        optsBtn.classList.toggle("active", on);
      });
      function syncOptions() {
        var f = getFinder();
        if (f) {
          f.setFindOptions({
            caseSensitive: caseChk.checked,
            wholeWord: wordChk.checked
          });
        }
      }
      caseChk.addEventListener("change", syncOptions);
      wordChk.addEventListener("change", syncOptions);
      var lastTermMemo = "";
      function pickSeed(arg) {
        if (typeof arg === "string" && arg) return arg;
        if (input.value) return input.value;
        return lastTermMemo;
      }
      window.findNext = function(lastTerm) {
        var seed = pickSeed(lastTerm);
        if (!bar.classList.contains("open")) {
          open(seed);
          return;
        }
        if (!input.value) {
          if (seed) {
            input.value = seed;
            var f0 = getFinder();
            if (f0) f0.openFind(seed);
          } else {
            input.focus();
            input.select();
            return;
          }
        }
        var f = getFinder();
        if (f) f.findNext();
      };
      window.findPrev = function(lastTerm) {
        var seed = pickSeed(lastTerm);
        if (!bar.classList.contains("open")) {
          open(seed);
          return;
        }
        if (!input.value) {
          if (seed) {
            input.value = seed;
            var f0 = getFinder();
            if (f0) f0.openFind(seed);
          } else {
            input.focus();
            input.select();
            return;
          }
        }
        var f = getFinder();
        if (f) f.findPrev();
      };
      window.afterModeSwitch = function() {
        setTimeout(function() {
          if (bar.classList.contains("open")) {
            if (window.FolioEditor) window.FolioEditor.closeFind();
            if (window.ViewFinder) window.ViewFinder.closeFind();
            var f = getFinder();
            if (f) {
              f.setFindOptions({
                caseSensitive: caseChk.checked,
                wholeWord: wordChk.checked
              });
              f.openFind(input.value);
            }
            input.focus();
            input.select();
          } else if (isEditMode() && window.focusEditor) {
            window.focusEditor();
          }
        }, 0);
      };
      window.addEventListener("folio-find-state", function(e) {
        var s = e.detail || {};
        if (!s.term && !input.value) {
          counter.textContent = "";
          return;
        }
        if (typeof s.total !== "number" || s.total === 0) {
          counter.textContent = input.value || s.term ? "0/0" : "";
        } else if (s.scanning || s.active < 0) {
          counter.textContent = "\u2026/" + s.total;
        } else {
          counter.textContent = s.active + 1 + "/" + s.total;
        }
      });
    })();
    (function() {
      var splitter = document.getElementById("splitter-right");
      var dragState2 = null;
      function currentTocWidth() {
        var v = getComputedStyle(document.documentElement).getPropertyValue("--toc-w").trim();
        var n = parseFloat(v);
        return isNaN(n) ? 260 : n;
      }
      splitter.addEventListener("pointerdown", function(e) {
        try {
          splitter.setPointerCapture(e.pointerId);
        } catch (_) {
        }
        dragState2 = { startX: e.clientX, startW: currentTocWidth() };
        e.preventDefault();
      });
      splitter.addEventListener("pointermove", function(e) {
        if (!dragState2) return;
        var dx = e.clientX - dragState2.startX;
        var maxW = Math.max(150, window.innerWidth - 320 - 8);
        var newW = Math.max(150, Math.min(maxW, dragState2.startW - dx));
        document.documentElement.style.setProperty("--toc-w", newW + "px");
      });
      function endDrag(e) {
        if (!dragState2) return;
        try {
          splitter.releasePointerCapture(e.pointerId);
        } catch (_) {
        }
        dragState2 = null;
        post2({ type: "railResize", side: "right", width: currentTocWidth() });
      }
      splitter.addEventListener("pointerup", endDrag);
      splitter.addEventListener("pointercancel", endDrag);
    })();
    (function() {
      var splitter = document.getElementById("splitter-left");
      var dragState2 = null;
      function currentVaultWidth() {
        var v = getComputedStyle(document.documentElement).getPropertyValue("--vault-w").trim();
        var n = parseFloat(v);
        return isNaN(n) ? 240 : n;
      }
      splitter.addEventListener("pointerdown", function(e) {
        try {
          splitter.setPointerCapture(e.pointerId);
        } catch (_) {
        }
        dragState2 = { startX: e.clientX, startW: currentVaultWidth() };
        e.preventDefault();
      });
      splitter.addEventListener("pointermove", function(e) {
        if (!dragState2) return;
        var dx = e.clientX - dragState2.startX;
        var maxW = Math.max(150, window.innerWidth - 320 - 8);
        var newW = Math.max(150, Math.min(maxW, dragState2.startW + dx));
        document.documentElement.style.setProperty("--vault-w", newW + "px");
      });
      function endDrag(e) {
        if (!dragState2) return;
        try {
          splitter.releasePointerCapture(e.pointerId);
        } catch (_) {
        }
        dragState2 = null;
        post2({ type: "railResize", side: "left", width: currentVaultWidth() });
      }
      splitter.addEventListener("pointerup", endDrag);
      splitter.addEventListener("pointercancel", endDrag);
    })();
    (function() {
      var ROOT = document.getElementById("vault-tree");
      var REGION = document.getElementById("vault-region");
      function findNodeByPath(path) {
        if (!path) return null;
        var nodes = ROOT.querySelectorAll(".node");
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].getAttribute("data-path") === path) return nodes[i];
        }
        return null;
      }
      function findAllNodesByPath(path) {
        if (!path) return [];
        var matches = [];
        var nodes = ROOT.querySelectorAll(".node");
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].getAttribute("data-path") === path) matches.push(nodes[i]);
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
      var currentActivePath = "";
      function reapplyActiveMarker() {
        var prev = ROOT.querySelectorAll(".node.active");
        for (var i = 0; i < prev.length; i++) prev[i].classList.remove("active");
        if (!currentActivePath) return;
        var nodes = findAllNodesByPath(currentActivePath);
        for (var n = 0; n < nodes.length; n++) nodes[n].classList.add("active");
      }
      window.setVaultPinned = function(html) {
        var section = ROOT.querySelector('li.section[data-section="pinned"]');
        if (!section) return;
        var ul = section.querySelector(":scope > ul.children");
        if (ul) ul.innerHTML = html || "";
        reapplyActiveMarker();
      };
      window.setVaultRecent = function(html) {
        var section = ROOT.querySelector('li.section[data-section="recent"]');
        if (!section) return;
        var ul = section.querySelector(":scope > ul.children");
        if (ul) ul.innerHTML = html || "";
        reapplyActiveMarker();
      };
      window.insertVaultChildren = function(path, html) {
        var lis = findAllNodesByPath(path);
        for (var n = 0; n < lis.length; n++) {
          var li = lis[n];
          var ul = li.querySelector(":scope > ul.children");
          if (!ul) continue;
          ul.innerHTML = html || "";
          ul.classList.remove("collapsed");
          li.setAttribute("data-loaded", "1");
          var caret = li.querySelector(":scope > .row > .caret");
          if (caret) caret.classList.add("open");
          var iconEl = li.querySelector(":scope > .row > .icon");
          if (iconEl) iconEl.textContent = "\u{1F4C2}";
        }
        reapplyActiveMarker();
      };
      window.setVaultActive = function(path) {
        currentActivePath = path || "";
        reapplyActiveMarker();
      };
      window.reapplyVaultActive = reapplyActiveMarker;
      function toggleSection(section) {
        var key = section.getAttribute("data-section");
        var caret = section.querySelector(":scope > .row > .caret");
        var ul = section.querySelector(":scope > ul.children");
        var nowExpanded = !(caret && caret.classList.contains("open"));
        if (caret) caret.classList.toggle("open", nowExpanded);
        if (ul) ul.classList.toggle("collapsed", !nowExpanded);
        post2({ type: "toggle-section", section: key, expanded: nowExpanded });
      }
      function toggleDir(node) {
        var caret = node.querySelector(":scope > .row > .caret");
        var ul = node.querySelector(":scope > ul.children");
        var iconEl = node.querySelector(":scope > .row > .icon");
        var path = node.getAttribute("data-path");
        var loaded = node.getAttribute("data-loaded") === "1";
        var open = caret && caret.classList.contains("open");
        if (open) {
          if (caret) caret.classList.remove("open");
          if (ul) ul.classList.add("collapsed");
          if (iconEl) iconEl.textContent = "\u{1F4C1}";
          post2({ type: "collapse-dir", path });
        } else {
          if (caret) caret.classList.add("open");
          if (ul) ul.classList.remove("collapsed");
          if (iconEl) iconEl.textContent = "\u{1F4C2}";
          if (!loaded) post2({ type: "expand-dir", path });
        }
      }
      REGION.addEventListener("click", function(e) {
        if (e.button !== 0) return;
        var cmdBtn = e.target;
        while (cmdBtn && cmdBtn !== REGION && !(cmdBtn.classList && cmdBtn.classList.contains("vault-cmd"))) {
          cmdBtn = cmdBtn.parentElement;
        }
        if (cmdBtn && cmdBtn !== REGION && cmdBtn.classList.contains("vault-cmd")) {
          e.preventDefault();
          e.stopPropagation();
          var cmd = cmdBtn.getAttribute("data-cmd");
          var inv = window.__folioInvoke || window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
          if (cmd === "addFile") {
            if (inv) {
              inv("pick_file").then(function(path) {
                if (!path) return;
                if (typeof window.openDocument === "function") {
                  window.openDocument(path);
                } else {
                  post2({ type: "open", path });
                }
              }).catch(function() {
              });
            } else {
              post2({ type: "addFile" });
            }
          } else if (cmd === "addFolder") {
            if (inv) {
              inv("pick_folder").then(function(path) {
                if (path) inv("workspace_pin", { path, isDirectory: true }).catch(function() {
                });
              }).catch(function() {
              });
            } else {
              post2({ type: "addFolder" });
            }
          }
          return;
        }
        var row = e.target;
        while (row && row !== ROOT && !(row.classList && row.classList.contains("row"))) {
          row = row.parentElement;
        }
        if (!row || row === ROOT) return;
        var node = findAncestor(row.parentElement, "node");
        if (node) {
          var kind = node.getAttribute("data-kind");
          if (kind === "dir") {
            toggleDir(node);
            return;
          }
          if (kind === "file") {
            var p = node.getAttribute("data-path");
            if (p) {
              if (typeof window.openDocument === "function") {
                window.openDocument(p);
              } else {
                post2({ type: "open", path: p });
              }
            }
            return;
          }
        }
        var section = findAncestor(row.parentElement, "section");
        if (section) toggleSection(section);
      });
      REGION.addEventListener("contextmenu", function(e) {
        e.preventDefault();
        var node = findAncestor(e.target, "node");
        if (!node) {
          post2({ type: "context", path: null, x: e.clientX, y: e.clientY });
          return;
        }
        post2({
          type: "context",
          path: node.getAttribute("data-path"),
          kind: node.getAttribute("data-kind"),
          isPinned: node.getAttribute("data-pinned") === "1",
          isInRecent: node.getAttribute("data-recent") === "1",
          x: e.clientX,
          y: e.clientY
        });
      });
    })();
    initCheatsheet();
  })();
  (function() {
    if (!window.__TAURI__) return;
    var invoke = window.__TAURI__.core && window.__TAURI__.core.invoke;
    window.__folioInvoke = invoke;
    var emit = window.__TAURI__.event && window.__TAURI__.event.emit;
    var listen = window.__TAURI__.event && window.__TAURI__.event.listen;
    if (!invoke || !emit || !listen) return;
    function $(id) {
      return document.getElementById(id);
    }
    function bind(id, fn) {
      var el = $(id);
      if (el) el.addEventListener("click", fn);
    }
    var currentPath = null;
    var isDirty = false;
    var cleanText2 = "";
    function markDirty(dirty) {
      isDirty = !!dirty;
      var el = $("status-path");
      if (el) el.classList.toggle("dirty", isDirty);
      var btn = $("tb-save");
      if (btn) btn.disabled = !isDirty;
      invoke("menu_set_enabled", { id: "file.save", enabled: isDirty }).catch(function() {
      });
      applyWindowTitle();
    }
    function fileFullName(p) {
      if (!p) return null;
      return p.replace(/\\/g, "/").split("/").pop() || p;
    }
    function applyWindowTitle() {
      var name = fileFullName(currentPath);
      var title = name ? (isDirty ? "* " + name : name) + " \u2014 Folio" : "Folio";
      document.title = title;
      invoke("set_window_title", { title }).catch(function() {
      });
    }
    function editorText() {
      if (window.FolioEditor && typeof window.FolioEditor.getText === "function") {
        return window.FolioEditor.getText();
      }
      return cleanText2;
    }
    function refreshDirtyFromEditor() {
      var dirty = !!currentPath && editorText() !== cleanText2;
      markDirty(dirty);
      return dirty;
    }
    function syncEditorTextToStore() {
      if (!currentPath) return Promise.resolve();
      return invoke("editor_text_changed", { text: editorText() }).catch(function() {
      });
    }
    function showRenameDialog(initialName, subtitle) {
      return new Promise(function(resolve) {
        var dialog = $("rename-dialog");
        var input = $("rename-input");
        var ok = $("rename-ok");
        var cancel = $("rename-cancel");
        var sub = $("rename-subtitle");
        if (!dialog || !input || !ok || !cancel) {
          resolve(null);
          return;
        }
        if (sub) sub.textContent = subtitle || "Neuen Dateinamen eingeben:";
        input.value = initialName || "";
        dialog.hidden = false;
        var dot = input.value.lastIndexOf(".");
        input.focus();
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
        function done(result) {
          dialog.hidden = true;
          ok.removeEventListener("click", onOk);
          cancel.removeEventListener("click", onCancel);
          input.removeEventListener("keydown", onKey);
          document.removeEventListener("keydown", onEsc);
          resolve(result);
        }
        function onOk() {
          var v = (input.value || "").trim();
          done(v.length ? v : null);
        }
        function onCancel() {
          done(null);
        }
        function onKey(e) {
          if (e.key === "Enter") {
            e.preventDefault();
            onOk();
          }
        }
        function onEsc(e) {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }
        ok.addEventListener("click", onOk);
        cancel.addEventListener("click", onCancel);
        input.addEventListener("keydown", onKey);
        document.addEventListener("keydown", onEsc);
      });
    }
    window.showRenameDialog = showRenameDialog;
    function startInlineRename(path) {
      if (!path) return;
      var nodes = document.querySelectorAll("#vault-tree li.node[data-path]");
      var nodeEl = null;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute("data-path") === path && nodes[i].getAttribute("data-kind") !== "dir") {
          nodeEl = nodes[i];
          break;
        }
      }
      if (!nodeEl) return;
      var labelEl = nodeEl.querySelector(":scope > .row > .label");
      if (!labelEl || labelEl.dataset.editing === "1") return;
      var originalText = labelEl.textContent || "";
      var basename = originalText;
      labelEl.dataset.editing = "1";
      labelEl.classList.add("editing");
      labelEl.textContent = "";
      var input = document.createElement("input");
      input.type = "text";
      input.className = "vault-rename-input";
      input.value = basename;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.setAttribute("data-rename-input", "1");
      labelEl.appendChild(input);
      function stop(e) {
        e.stopPropagation();
      }
      input.addEventListener("click", stop);
      input.addEventListener("mousedown", stop);
      input.addEventListener("dblclick", stop);
      input.addEventListener("contextmenu", stop);
      var finished = false;
      function cleanup() {
        input.removeEventListener("keydown", onKey);
        input.removeEventListener("blur", onBlur);
        labelEl.classList.remove("editing");
        delete labelEl.dataset.editing;
      }
      function restore() {
        cleanup();
        labelEl.textContent = originalText;
      }
      function commit() {
        if (finished) return;
        finished = true;
        var newName = (input.value || "").trim();
        if (!newName || newName === originalText) {
          restore();
          return;
        }
        cleanup();
        labelEl.textContent = newName;
        var normalized = path.replace(/\\/g, "/");
        var lastSlash = normalized.lastIndexOf("/");
        var parent = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
        var newPath = parent + newName;
        invoke("rename_file", { oldPath: path, newPath }).catch(function(err) {
          showStatus(typeof err === "string" ? err : "Umbenennen fehlgeschlagen");
          refreshVault();
        });
      }
      function cancel() {
        if (finished) return;
        finished = true;
        restore();
      }
      function onKey(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        } else {
          e.stopPropagation();
        }
      }
      function onBlur() {
        commit();
      }
      input.addEventListener("keydown", onKey);
      input.addEventListener("blur", onBlur);
      input.focus();
      var dot = basename.lastIndexOf(".");
      if (dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    }
    window.startInlineRename = startInlineRename;
    function showUnsavedDialog() {
      var dialog = $("unsaved-dialog");
      if (!dialog) return Promise.resolve("cancel");
      dialog.hidden = false;
      return new Promise(function(resolve) {
        function done(decision) {
          dialog.hidden = true;
          $("unsaved-save").removeEventListener("click", save);
          $("unsaved-discard").removeEventListener("click", discard);
          $("unsaved-cancel").removeEventListener("click", cancel);
          document.removeEventListener("keydown", onKey);
          resolve(decision);
        }
        function save() {
          done("save");
        }
        function discard() {
          done("discard");
        }
        function cancel() {
          done("cancel");
        }
        function onKey(e) {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }
        $("unsaved-save").addEventListener("click", save);
        $("unsaved-discard").addEventListener("click", discard);
        $("unsaved-cancel").addEventListener("click", cancel);
        document.addEventListener("keydown", onKey);
        setTimeout(function() {
          var btn = $("unsaved-save");
          if (btn) btn.focus();
        }, 0);
      });
    }
    function renderDocumentPayload(data) {
      if (!data || typeof data !== "object") return;
      if (typeof window.setTocList === "function") {
        window.setTocList(data.tocHtml || data.toc_html || "");
      }
      var view = document.getElementById("view-region");
      var body2 = view && view.querySelector(".markdown-body");
      if (body2) {
        body2.innerHTML = data.content || data.html || "";
        rewriteRelativeAssets(body2, data.path || currentPath);
      }
    }
    function rewriteRelativeAssets(rootEl, documentPath) {
      if (!rootEl || !documentPath) return;
      var convert = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.convertFileSrc;
      if (typeof convert !== "function") return;
      var dir = documentPath.replace(/[\\/][^\\/]*$/, "");
      var imgs = rootEl.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].getAttribute("src");
        if (!src) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
        if (src.indexOf("//") === 0) continue;
        var abs;
        if (/^[a-zA-Z]:[\\/]/.test(src) || src.charAt(0) === "/") {
          abs = src;
        } else {
          abs = dir + "/" + src;
        }
        abs = abs.replace(/\\/g, "/");
        try {
          imgs[i].src = convert(abs);
        } catch (e) {
        }
      }
    }
    window.rewriteRelativeAssets = rewriteRelativeAssets;
    function saveCurrent() {
      return syncEditorTextToStore().then(function() {
        return invoke("editor_save_requested");
      }).then(function(saved) {
        if (saved) {
          cleanText2 = editorText();
          markDirty(false);
        }
        return !!saved;
      }).catch(function() {
        return false;
      });
    }
    function requestSaveIfDirty() {
      var dirty = refreshDirtyFromEditor();
      if (!dirty && !isDirty) return Promise.resolve(true);
      return syncEditorTextToStore().then(showUnsavedDialog).then(function(decision) {
        if (decision === "cancel") return false;
        if (decision === "discard") {
          return invoke("discard_editor_changes").then(function() {
            cleanText2 = editorText();
            markDirty(false);
            return true;
          }).catch(function() {
            return false;
          });
        }
        return invoke("editor_save_requested").then(function(saved) {
          if (saved) {
            cleanText2 = editorText();
            markDirty(false);
          }
          return !!saved;
        }).catch(function() {
          return false;
        });
      });
    }
    var DOC_KIND_CLASSES = ["kind-markdown", "kind-text", "kind-binary", "kind-unknown"];
    function applyDocKind(kind) {
      var resolved = kind || "unknown";
      var body2 = document.body;
      DOC_KIND_CLASSES.forEach(function(c) {
        body2.classList.remove(c);
      });
      body2.classList.add("kind-" + resolved);
      var md = resolved === "markdown";
      var hasDoc = resolved !== "unknown" && resolved !== "binary";
      var btnView = $("tb-mode-view");
      if (btnView) {
        btnView.disabled = !md;
        btnView.title = md ? "View (Ctrl+1)" : "View nur f\xFCr Markdown verf\xFCgbar";
      }
      var btnEdit = $("tb-mode-edit");
      if (btnEdit) {
        btnEdit.disabled = !hasDoc;
        btnEdit.title = hasDoc ? "Edit (Ctrl+2)" : "Kein Dokument geladen";
      }
      var btnExport = $("tb-export");
      if (btnExport) {
        btnExport.disabled = !md;
        btnExport.title = md ? "Exportieren\u2026" : "Export nur f\xFCr Markdown verf\xFCgbar";
      }
      invoke("menu_set_enabled", { id: "view.mode.view", enabled: md }).catch(function() {
      });
      invoke("menu_set_enabled", { id: "view.mode.edit", enabled: hasDoc }).catch(function() {
      });
      invoke("menu_set_enabled", { id: "file.save_as", enabled: hasDoc }).catch(function() {
      });
      invoke("menu_set_enabled", { id: "file.rename", enabled: hasDoc }).catch(function() {
      });
      invoke("menu_set_enabled", { id: "file.close", enabled: hasDoc }).catch(function() {
      });
      syncCheatsheetMenu();
      syncViewModeMenuChecks();
    }
    function syncViewModeMenuChecks() {
      var body2 = document.body;
      var hasDoc = !body2.classList.contains("kind-unknown") && !body2.classList.contains("kind-binary");
      var mode = !hasDoc ? null : body2.classList.contains("edit-mode") ? "edit" : body2.classList.contains("split-mode") ? "split" : "view";
      invoke("menu_set_checked", { id: "view.mode.view", checked: mode === "view" }).catch(function() {
      });
      invoke("menu_set_checked", { id: "view.mode.edit", checked: mode === "edit" }).catch(function() {
      });
      invoke("menu_set_checked", { id: "view.mode.split", checked: mode === "split" }).catch(function() {
      });
    }
    applyDocKind("unknown");
    function showStatus(msg) {
      var el = $("status-path");
      if (el) el.textContent = msg;
    }
    function openDocument(path) {
      return requestSaveIfDirty().then(function(ok) {
        if (!ok) return false;
        return invoke("read_file", { path }).then(function(data) {
          invoke("workspace_add_recent", { path }).catch(function() {
          });
          var kind = data && data.kind;
          if (kind && kind !== "markdown" && !document.body.classList.contains("edit-mode")) {
            invoke("set_view_mode", { mode: "edit" }).then(function() {
              setActiveMode("edit");
            }).catch(function() {
            });
          }
          applyDocKind(kind);
          return true;
        }).catch(function(err) {
          showStatus(typeof err === "string" ? err : "Datei konnte nicht ge\xF6ffnet werden");
          return false;
        });
      });
    }
    window.openDocument = openDocument;
    function setMode(mode) {
      return requestSaveIfDirty().then(function(ok) {
        if (!ok) return false;
        return invoke("set_view_mode", { mode }).then(function() {
          setActiveMode(mode);
          return true;
        });
      });
    }
    function setActiveMode(mode) {
      $("tb-mode-view").classList.toggle("active", mode === "view");
      $("tb-mode-edit").classList.toggle("active", mode === "edit");
      var sm = $("status-mode");
      if (sm) sm.textContent = mode === "edit" ? "Edit" : "View";
      cheatsheetSyncMode(mode === "edit");
      invoke("menu_set_checked", { id: "view.mode.view", checked: mode === "view" }).catch(function() {
      });
      invoke("menu_set_checked", { id: "view.mode.edit", checked: mode === "edit" }).catch(function() {
      });
      invoke("menu_set_checked", { id: "view.mode.split", checked: mode === "split" }).catch(function() {
      });
    }
    function setRailButton(side, visible) {
      var btn = side === "left" ? $("tb-rail-left") : $("tb-rail-right");
      if (btn) btn.classList.toggle("active", !!visible);
    }
    function applyRailVisibility(side, visible) {
      if (typeof window.setRailVisibility === "function") {
        window.setRailVisibility(side, !!visible);
      } else if (side === "left") {
        document.body.classList.toggle("vault-hidden", !visible);
      } else if (side === "right") {
        document.body.classList.toggle("toc-hidden", !visible);
      }
      setRailButton(side, visible);
    }
    function applyShellState(state) {
      if (!state || typeof state !== "object") return;
      var mode = state.viewMode || state.view_mode || "view";
      document.body.classList.toggle("edit-mode", mode === "edit");
      document.body.classList.toggle("split-mode", mode === "split");
      setActiveMode(mode);
      if (mode === "edit" && typeof window.layoutEditor === "function") window.layoutEditor();
      var theme = state.theme || "light";
      document.documentElement.classList.toggle("theme-dark", theme === "dark");
      document.documentElement.classList.toggle("theme-light", theme === "light");
      if (typeof window.setEditorTheme === "function") window.setEditorTheme(theme);
      if (typeof state.leftRailVisible === "boolean") applyRailVisibility("left", state.leftRailVisible);
      if (typeof state.rightRailVisible === "boolean") applyRailVisibility("right", state.rightRailVisible);
      var editor = state.editor || {};
      if (typeof editor.leftRailWidth === "number" && typeof window.setVaultWidth === "function") {
        window.setVaultWidth(editor.leftRailWidth);
      }
      if (typeof editor.rightRailWidth === "number" && typeof window.setTocWidth === "function") {
        window.setTocWidth(editor.rightRailWidth);
      }
    }
    bind("tb-mode-view", function() {
      setMode("view");
    });
    bind("tb-mode-edit", function() {
      setMode("edit");
    });
    bind("tb-save", function() {
      if (isDirty) saveCurrent();
    });
    var selectedLayoutId = null;
    var selectedExportFormat = "html";
    var exportKeydownHandler = null;
    function fileBaseName(p) {
      if (!p) return "Dokument";
      var s = p.replace(/\\/g, "/").split("/").pop() || p;
      return s.replace(/\.(md|markdown|mdown|mkd)$/i, "") || "Dokument";
    }
    function setExportFormat(fmt) {
      selectedExportFormat = fmt === "pdf" ? "pdf" : "html";
      var buttons = document.querySelectorAll("#export-formats button");
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle(
          "active",
          buttons[i].getAttribute("data-format") === selectedExportFormat
        );
      }
    }
    function selectLayoutCard(id) {
      selectedLayoutId = id;
      var cards = document.querySelectorAll("#export-cards .export-card");
      for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle("selected", cards[i].dataset.layoutId === id);
      }
      var saveBtn = $("export-save");
      if (saveBtn) saveBtn.disabled = !id;
    }
    function openExportDialog() {
      if (!document.body.classList.contains("kind-markdown")) return;
      setExportFormat("html");
      var sync = document.body.classList.contains("edit-mode") && currentPath ? syncEditorTextToStore() : Promise.resolve();
      sync.then(function() {
        return invoke("export_layouts");
      }).then(function(layouts) {
        var cards = $("export-cards");
        cards.innerHTML = "";
        (layouts || []).forEach(function(layout) {
          var card = document.createElement("div");
          card.className = "export-card";
          card.dataset.layoutId = layout.id;
          card.tabIndex = 0;
          card.innerHTML = '<div class="export-card__name"></div><div class="export-card__desc"></div><div class="export-card__preview"><iframe sandbox></iframe></div>';
          card.querySelector(".export-card__name").textContent = layout.name;
          card.querySelector(".export-card__desc").textContent = layout.description || "";
          card.addEventListener("click", function() {
            selectLayoutCard(layout.id);
          });
          card.addEventListener("keydown", function(e) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectLayoutCard(layout.id);
            }
          });
          cards.appendChild(card);
          invoke("export_render", { layoutId: layout.id }).then(function(html) {
            var iframe = card.querySelector("iframe");
            if (iframe && typeof html === "string") iframe.srcdoc = html;
          }).catch(function() {
          });
        });
        selectLayoutCard(layouts && layouts[0] && layouts[0].id || null);
        $("export-dialog").hidden = false;
        exportKeydownHandler = function(e) {
          if (e.key === "Escape") {
            e.preventDefault();
            closeExportDialog();
          } else if (e.key === "Enter" && selectedLayoutId) {
            if (e.target && e.target.id === "export-cancel") return;
            e.preventDefault();
            doExportSave();
          }
        };
        document.addEventListener("keydown", exportKeydownHandler);
      }).catch(function(err) {
        showStatus(typeof err === "string" ? err : "Export fehlgeschlagen");
      });
    }
    function closeExportDialog() {
      $("export-dialog").hidden = true;
      if (exportKeydownHandler) {
        document.removeEventListener("keydown", exportKeydownHandler);
        exportKeydownHandler = null;
      }
      var cards = $("export-cards");
      if (cards) cards.innerHTML = "";
    }
    function doExportSave() {
      if (!selectedLayoutId) return;
      var fmt = selectedExportFormat;
      var defaultName = fileBaseName(currentPath) + "." + fmt;
      var cmd = fmt === "pdf" ? "export_pdf" : "export_html";
      invoke("pick_export_target", { defaultName, format: fmt }).then(function(targetPath) {
        if (!targetPath) return;
        showStatus("Export l\xE4uft\u2026");
        return invoke(cmd, { layoutId: selectedLayoutId, targetPath }).then(function() {
          closeExportDialog();
          showStatus("Exportiert: " + targetPath);
        });
      }).catch(function(err) {
        showStatus(typeof err === "string" ? err : "Export fehlgeschlagen");
      });
    }
    bind("tb-export", openExportDialog);
    bind("export-cancel", closeExportDialog);
    bind("export-save", doExportSave);
    var exportFormats = document.getElementById("export-formats");
    if (exportFormats) {
      exportFormats.addEventListener("click", function(e) {
        var btn = e.target.closest("button[data-format]");
        if (!btn || btn.disabled) return;
        setExportFormat(btn.getAttribute("data-format"));
      });
    }
    bind("tb-rail-left", function() {
      var btn = $("tb-rail-left");
      var on = !btn.classList.contains("active");
      btn.classList.toggle("active", on);
      invoke("set_rail_visible", { side: "left", visible: on }).catch(function() {
      });
    });
    bind("tb-rail-right", function() {
      var btn = $("tb-rail-right");
      var on = !btn.classList.contains("active");
      btn.classList.toggle("active", on);
      invoke("set_rail_visible", { side: "right", visible: on }).catch(function() {
      });
    });
    bind("tb-find", function() {
      invoke("open_find").catch(function() {
      });
    });
    bind("tb-back", function() {
      requestSaveIfDirty().then(function(ok) {
        if (ok) invoke("go_back_and_emit").catch(function() {
        });
      });
    });
    bind("tb-forward", function() {
      requestSaveIfDirty().then(function(ok) {
        if (ok) invoke("go_forward_and_emit").catch(function() {
        });
      });
    });
    function applyCmd(name) {
      if (!window.FolioEditor || typeof window.FolioEditor.getText !== "function") return;
      var text = window.FolioEditor.getText();
      var sel = window.FolioEditor.getSelection() || { start: 0, length: 0 };
      invoke("apply_editor_command", {
        command: name,
        text,
        start: sel.start || 0,
        length: sel.length || 0
      }).then(function(res) {
        if (!res) return;
        window.FolioEditor.applyReplace({
          fullText: res.new_text,
          selectionStart: res.new_selection_start,
          selectionLength: res.new_selection_length
        });
      }).catch(function(err) {
        console.warn("apply_editor_command failed:", err);
      });
    }
    bind("tb-bold", function() {
      applyCmd("bold");
    });
    bind("tb-italic", function() {
      applyCmd("italic");
    });
    bind("tb-heading", function() {
      applyCmd("heading");
    });
    bind("tb-bullet", function() {
      applyCmd("bullet");
    });
    bind("tb-numbered", function() {
      applyCmd("numbered");
    });
    bind("tb-link", function() {
      applyCmd("link");
    });
    bind("tb-image", function() {
      applyCmd("image");
    });
    bind("tb-table", function() {
      applyCmd("table");
    });
    bind("tb-code", function() {
      applyCmd("code");
    });
    bind("tb-codeblock", function() {
      applyCmd("codeblock");
    });
    bind("tb-strike", function() {
      applyCmd("strike");
    });
    bind("tb-cheatsheet", function() {
      if (!document.body.classList.contains("edit-mode")) return;
      var ov = $("cheatsheet-overlay");
      if (!ov) return;
      if (ov.hidden) {
        showCheatSheet(JSON.stringify(cheatSheetRows.map(function(r) {
          return { label: r[0], code: r[1] };
        })));
      } else {
        hideCheatSheet();
      }
    });
    function setStatusPath(path, dirty) {
      var el = $("status-path");
      if (!el) return;
      el.textContent = path || "Bereit";
      el.classList.toggle("dirty", !!dirty);
    }
    function updateWordCount(text) {
      var el = $("status-wordcount");
      if (!el) return;
      if (!text) {
        el.hidden = true;
        el.textContent = "";
        return;
      }
      var chars = text.length;
      var words = (text.match(/\S+/g) || []).length;
      var lines = text.split(/\r\n|\r|\n/).length;
      el.hidden = false;
      el.textContent = words + " W\xF6rter \xB7 " + chars + " Zeichen \xB7 " + lines + " Zeilen";
    }
    bind("status-theme-toggle", function() {
      invoke("theme_set", { mode: "toggle" }).catch(function() {
      });
    });
    initZoom();
    document.addEventListener("keydown", function(e) {
      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "1") {
        e.preventDefault();
        $("tb-mode-view").click();
      } else if (ctrl && e.key === "2") {
        e.preventDefault();
        $("tb-mode-edit").click();
      } else if (ctrl && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        invoke("open_find").catch(function() {
        });
      } else if (e.key === "F3") {
        e.preventDefault();
        var fn = e.shiftKey ? window.findPrev : window.findNext;
        if (typeof fn === "function") fn();
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        requestSaveIfDirty().then(function(ok) {
          if (ok) invoke("go_back_and_emit").catch(function() {
          });
        });
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        requestSaveIfDirty().then(function(ok) {
          if (ok) invoke("go_forward_and_emit").catch(function() {
          });
        });
      } else if (ctrl && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        saveCurrent();
      }
    });
    invoke("theme_get").then(function(mode) {
      var html = document.documentElement;
      html.classList.toggle("theme-dark", mode === "dark");
      html.classList.toggle("theme-light", mode === "light");
      if (typeof window.setEditorTheme === "function") window.setEditorTheme(mode);
      invoke("menu_set_checked", { id: "view.theme.light", checked: mode === "light" }).catch(function() {
      });
      invoke("menu_set_checked", { id: "view.theme.dark", checked: mode === "dark" }).catch(function() {
      });
    }).catch(function() {
    });
    var vaultTree = $("vault-tree");
    var fileIconCache = {};
    var fileIconPending = {};
    function resolveFileIcon(ext) {
      if (fileIconCache[ext] !== void 0) {
        return Promise.resolve(fileIconCache[ext]);
      }
      if (fileIconPending[ext]) return fileIconPending[ext];
      var p = invoke("file_icon_data_uri", { ext }).then(function(uri) {
        fileIconCache[ext] = uri || "";
        delete fileIconPending[ext];
        return fileIconCache[ext];
      }).catch(function() {
        fileIconCache[ext] = "";
        delete fileIconPending[ext];
        return "";
      });
      fileIconPending[ext] = p;
      return p;
    }
    function applyIconsToNode(rootNode) {
      if (!rootNode) return;
      var imgs;
      if (rootNode.matches && rootNode.matches("img.ftype-icon")) {
        imgs = [rootNode];
      } else if (rootNode.querySelectorAll) {
        imgs = rootNode.querySelectorAll("img.ftype-icon");
      } else {
        return;
      }
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        if (img.src) continue;
        var ext = img.getAttribute("data-ext") || "";
        (function(target, e) {
          resolveFileIcon(e).then(function(uri) {
            if (uri) target.src = uri;
          });
        })(img, ext);
      }
    }
    if (vaultTree && typeof MutationObserver === "function") {
      var iconObserver = new MutationObserver(function(mutations) {
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
        vaultTree.innerHTML = '<li class="empty">Keine Eintr\xE4ge. Datei \xF6ffnen oder per Drag&amp;Drop ablegen.</li>';
        return;
      }
      vaultTree.innerHTML = html;
      applyIconsToNode(vaultTree);
      if (typeof window.reapplyVaultActive === "function") window.reapplyVaultActive();
    }
    function refreshVault() {
      invoke("vault_build_tree").then(renderVault).catch(function(err) {
        console.warn("vault_build_tree failed:", err);
      });
    }
    refreshVault();
    invoke("cli_pending_open").then(function(path) {
      if (typeof path === "string" && path.length > 0) {
        openDocument(path);
      }
    }).catch(function() {
    });
    window.__TAURI__.event.listen("cli:open", function(event) {
      var data = event && event.payload;
      var path = data && typeof data === "object" ? data.path : null;
      if (typeof path === "string" && path.length > 0) {
        openDocument(path);
      }
    });
    if (vaultTree) {
      vaultTree.addEventListener("click", function(e) {
        var item = e.target.closest(".vault-item");
        if (!item) return;
        var path = item.getAttribute("data-path");
        var isDir = item.getAttribute("data-directory") === "true";
        if (!path) return;
        if (isDir) {
          invoke("vault_expand_dir", { path }).catch(function() {
          });
        } else {
          openDocument(path);
        }
      });
      vaultTree.addEventListener("contextmenu", function(e) {
        var item = e.target.closest("li.node");
        if (!item) return;
        e.preventDefault();
        var path = item.getAttribute("data-path");
        var isDir = item.getAttribute("data-kind") === "dir";
        var inPinned = isDirectChildOfSection(item, "pinned");
        var inRecent = isDirectChildOfSection(item, "recent");
        openContextMenu(e.clientX, e.clientY, path, isDir, inPinned, inRecent);
      });
    }
    function isDirectChildOfSection(node, sectionKey) {
      var parentUl = node.parentElement;
      if (!parentUl) return false;
      var sectionLi = parentUl.parentElement;
      return !!(sectionLi && sectionLi.classList && sectionLi.classList.contains("section") && sectionLi.getAttribute("data-section") === sectionKey);
    }
    var ctxMenu = $("context-menu");
    var ctxTarget = null;
    function openContextMenu(x, y, path, isDir, inPinned, inRecent) {
      if (!ctxMenu) return;
      ctxTarget = { path, isDirectory: isDir };
      var parts = [];
      if (!isDir) parts.push('<div class="ctx-item" data-act="open">\xD6ffnen</div>');
      var actionsBefore = parts.length;
      var actions = [];
      if (!isDir) actions.push('<div class="ctx-item" data-act="rename">Umbenennen</div>');
      if (!inPinned) actions.push('<div class="ctx-item" data-act="pin">Anpinnen</div>');
      if (inPinned) actions.push('<div class="ctx-item" data-act="unpin">Vom Pin l\xF6sen</div>');
      if (inRecent) actions.push('<div class="ctx-item" data-act="remove-recent">Aus \u201EZuletzt" entfernen</div>');
      if (actions.length && actionsBefore) parts.push('<div class="ctx-sep"></div>');
      parts = parts.concat(actions);
      var tail = [
        '<div class="ctx-item" data-act="show">Im Explorer zeigen</div>',
        '<div class="ctx-item" data-act="terminal">Terminal hier \xF6ffnen</div>',
        '<div class="ctx-item" data-act="copy">Pfad kopieren</div>'
      ];
      if (parts.length) parts.push('<div class="ctx-sep"></div>');
      parts = parts.concat(tail);
      ctxMenu.innerHTML = parts.join("");
      ctxMenu.style.left = x + "px";
      ctxMenu.style.top = y + "px";
      ctxMenu.classList.add("open");
    }
    function closeContextMenu() {
      if (ctxMenu) ctxMenu.classList.remove("open");
      ctxTarget = null;
    }
    if (ctxMenu) {
      ctxMenu.addEventListener("click", function(e) {
        var item = e.target.closest(".ctx-item");
        if (!item || item.classList.contains("disabled") || !ctxTarget) return;
        var act = item.getAttribute("data-act");
        var path = ctxTarget.path;
        var isDir = ctxTarget.isDirectory;
        closeContextMenu();
        if (act === "open" && !isDir) {
          openDocument(path);
        } else if (act === "pin") {
          invoke("workspace_pin", { path, isDirectory: isDir }).catch(function() {
          });
        } else if (act === "unpin") {
          invoke("workspace_unpin", { path }).catch(function() {
          });
        } else if (act === "remove-recent") {
          invoke("workspace_remove_recent", { path }).catch(function() {
          });
        } else if (act === "rename") {
          startInlineRename(path);
        } else if (act === "show") {
          invoke("show_in_file_manager", { path }).catch(function() {
          });
        } else if (act === "terminal") {
          invoke("open_terminal_at", { path }).catch(function() {
          });
        } else if (act === "copy") {
          if (navigator.clipboard) navigator.clipboard.writeText(path).catch(function() {
          });
        }
      });
      document.addEventListener("click", function(e) {
        if (!ctxMenu.contains(e.target)) closeContextMenu();
      });
      document.addEventListener("keydown", function(e) {
        if (e.key === "Escape") closeContextMenu();
      });
    }
    listen("tauri://drag-enter", function() {
      document.body.classList.add("dnd-active");
    });
    listen("tauri://drag-over", function() {
      document.body.classList.add("dnd-active");
    });
    listen("tauri://drag-leave", function() {
      document.body.classList.remove("dnd-active");
    });
    listen("tauri://drag-drop", function(event) {
      document.body.classList.remove("dnd-active");
      var paths = event && event.payload && event.payload.paths || [];
      if (paths.length === 0) return;
      var first = paths[0];
      openDocument(first);
    });
    listen("document:loaded", function(event) {
      var data = event && event.payload || {};
      currentPath = data.path || null;
      cleanText2 = data.text || "";
      markDirty(false);
      setStatusPath(data.path || "Bereit", false);
      updateWordCount(data.text || "");
      applyDocKind(data.kind || "unknown");
      invoke("workspace_add_recent", { path: data.path }).catch(function() {
      });
      var bar = document.getElementById("find-bar");
      if (bar && bar.classList.contains("open") && !document.body.classList.contains("edit-mode")) {
        var input = document.getElementById("find-input");
        if (input && input.value && window.ViewFinder) {
          setTimeout(function() {
            window.ViewFinder.setFindTerm(input.value);
          }, 0);
        }
      }
    });
    listen("document:dirty_changed", function(event) {
      var dirty = event && event.payload && (event.payload.is_dirty || event.payload.isDirty);
      markDirty(!!dirty);
    });
    listen("document:closed", function() {
      currentPath = null;
      cleanText2 = "";
      markDirty(false);
      if (window.FolioEditor && typeof window.FolioEditor.setText === "function") {
        window.FolioEditor.setText("", "plaintext");
      }
      var view = document.getElementById("view-region");
      var body2 = view && view.querySelector(".markdown-body");
      if (body2) body2.innerHTML = "";
      if (typeof window.setTocList === "function") window.setTocList("");
      applyDocKind("unknown");
      setStatusPath("Bereit", false);
      updateWordCount("");
      applyWindowTitle();
    });
    listen("document:saved", function(event) {
      var data = event && event.payload || {};
      cleanText2 = data.text || editorText();
      markDirty(false);
      renderDocumentPayload(data);
      updateWordCount(data.text || "");
    });
    listen("vault:refresh", function() {
      refreshVault();
    });
    listen("app:set_mode", function(event) {
      var mode = event && event.payload && event.payload.mode || "view";
      setActiveMode(mode);
      if (typeof window.afterModeSwitch === "function") window.afterModeSwitch();
    });
    listen("panel:rail_changed", function(event) {
      var data = event && event.payload || {};
      if (typeof data.leftRailVisible === "boolean") setRailButton("left", data.leftRailVisible);
      if (typeof data.rightRailVisible === "boolean") setRailButton("right", data.rightRailVisible);
    });
    listen("automation:click", function(event) {
      var name = event && event.payload && event.payload.name;
      if (!name) return;
      var el = document.getElementById(name);
      if (!el) {
        try {
          el = document.querySelector('[data-name="' + CSS.escape(name) + '"]');
        } catch (_) {
        }
      }
      if (!el) {
        try {
          el = document.querySelector(name);
        } catch (_) {
        }
      }
      if (el && typeof el.click === "function") el.click();
    });
    listen("automation:set_editor_text", function(event) {
      var data = event && event.payload || {};
      var text = data.text || "";
      if (typeof window.loadEditorText === "function") window.loadEditorText(text);
      updateWordCount(text);
      if (currentPath) markDirty(text !== cleanText2);
    });
    listen("automation:open_document", function(event) {
      var data = event && event.payload || {};
      if (data.path) openDocument(data.path);
    });
    window.addEventListener("folio-editor-text-updated", function(e) {
      var text = e.detail || "";
      updateWordCount(text);
      if (currentPath) markDirty(text !== cleanText2);
      invoke("editor_text_changed", { text }).catch(function() {
      });
    });
    (function() {
      var btn = document.getElementById("status-language");
      var picker = document.getElementById("lang-picker");
      var input = document.getElementById("lang-picker-input");
      var list = document.getElementById("lang-picker-list");
      if (!btn || !picker || !input || !list) return;
      var allLanguages = [];
      var currentId = "plaintext";
      var visibleItems = [];
      var activeIdx = -1;
      function ensureLoaded() {
        if (allLanguages.length > 0) return true;
        var f = window.FolioEditor;
        if (!f || typeof f.listLanguages !== "function") return false;
        allLanguages = f.listLanguages();
        allLanguages.sort(function(a, b) {
          return a.label.localeCompare(b.label);
        });
        return allLanguages.length > 0;
      }
      function labelFor(id) {
        for (var i = 0; i < allLanguages.length; i++) {
          if (allLanguages[i].id === id) return allLanguages[i].label;
        }
        return id ? id.charAt(0).toUpperCase() + id.slice(1) : "Plain Text";
      }
      function applyDisplay(id) {
        currentId = id || "plaintext";
        ensureLoaded();
        btn.textContent = labelFor(currentId);
        btn.hidden = false;
      }
      window.setEditorLanguageDisplay = applyDisplay;
      function highlightActive() {
        for (var i = 0; i < visibleItems.length; i++) {
          visibleItems[i].classList.toggle("active", i === activeIdx);
        }
        if (activeIdx >= 0 && visibleItems[activeIdx]) {
          visibleItems[activeIdx].scrollIntoView({ block: "nearest" });
        }
      }
      function renderList(filter) {
        list.innerHTML = "";
        visibleItems = [];
        var f = (filter || "").trim().toLowerCase();
        for (var i = 0; i < allLanguages.length; i++) {
          var l = allLanguages[i];
          if (f) {
            var hay = (l.label + " " + l.id + " " + l.aliases.join(" ")).toLowerCase();
            if (hay.indexOf(f) === -1) continue;
          }
          var li = document.createElement("li");
          li.setAttribute("role", "option");
          li.dataset.langId = l.id;
          if (l.id === currentId) li.classList.add("current");
          var labelEl = document.createElement("span");
          labelEl.textContent = l.label;
          var idEl = document.createElement("span");
          idEl.className = "lang-id";
          idEl.textContent = l.id;
          li.appendChild(labelEl);
          li.appendChild(idEl);
          list.appendChild(li);
          visibleItems.push(li);
        }
        activeIdx = -1;
        for (var j = 0; j < visibleItems.length; j++) {
          if (visibleItems[j].dataset.langId === currentId) {
            activeIdx = j;
            break;
          }
        }
        if (activeIdx === -1 && visibleItems.length > 0) activeIdx = 0;
        highlightActive();
      }
      function open() {
        if (!ensureLoaded()) return;
        picker.hidden = false;
        input.value = "";
        renderList("");
        input.focus();
      }
      function close() {
        picker.hidden = true;
      }
      function select(langId) {
        if (!langId) return;
        var f = window.FolioEditor;
        if (f && typeof f.setLanguage === "function") f.setLanguage(langId);
        applyDisplay(langId);
        close();
      }
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        if (picker.hidden) open();
        else close();
      });
      input.addEventListener("input", function() {
        renderList(input.value);
      });
      input.addEventListener("keydown", function(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (activeIdx >= 0 && visibleItems[activeIdx]) {
            select(visibleItems[activeIdx].dataset.langId);
          }
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          if (visibleItems.length === 0) return;
          activeIdx = (activeIdx + 1) % visibleItems.length;
          highlightActive();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (visibleItems.length === 0) return;
          activeIdx = (activeIdx - 1 + visibleItems.length) % visibleItems.length;
          highlightActive();
        }
      });
      list.addEventListener("click", function(e) {
        var li = e.target.closest("li");
        if (li && li.dataset.langId) select(li.dataset.langId);
      });
      document.addEventListener("mousedown", function(e) {
        if (picker.hidden) return;
        if (e.target === btn || picker.contains(e.target)) return;
        close();
      });
    })();
    (function() {
      var ev = window.__TAURI__ && window.__TAURI__.event;
      if (!ev || typeof ev.listen !== "function") return;
      ev.listen("menu:file_open", function() {
        invoke("pick_file").then(function(path) {
          if (path && typeof window.openDocument === "function") {
            window.openDocument(path);
          }
        }).catch(function() {
        });
      });
      ev.listen("menu:file_save", function() {
        if (isDirty) saveCurrent();
      });
      ev.listen("menu:file_recent", function(event) {
        var p = event && event.payload && event.payload.path;
        if (p && typeof window.openDocument === "function") {
          window.openDocument(p);
        }
      });
      ev.listen("menu:file_close", function() {
        if (!currentPath) return;
        requestSaveIfDirty().then(function(ok) {
          if (!ok) return;
          invoke("close_document").catch(function() {
          });
        });
      });
      ev.listen("menu:edit_undo", function() {
        if (window.FolioEditor && typeof window.FolioEditor.undo === "function") {
          window.FolioEditor.undo();
        }
      });
      ev.listen("menu:edit_redo", function() {
        if (window.FolioEditor && typeof window.FolioEditor.redo === "function") {
          window.FolioEditor.redo();
        }
      });
      ev.listen("menu:edit_find", function() {
        if (typeof window.openEditorFind === "function") window.openEditorFind("");
      });
      ev.listen("menu:help_cheatsheet", function() {
        var b = $("tb-cheatsheet");
        if (b) b.click();
      });
      ev.listen("menu:view_mode_view", function() {
        setMode("view");
      });
      ev.listen("menu:view_mode_edit", function() {
        setMode("edit");
      });
      ev.listen("menu:view_mode_split", function() {
        setMode("split");
      });
      ev.listen("menu:view_theme_light", function() {
        invoke("theme_set", { mode: "light" }).catch(function() {
        });
      });
      ev.listen("menu:view_theme_dark", function() {
        invoke("theme_set", { mode: "dark" }).catch(function() {
        });
      });
      ev.listen("menu:view_rail_left", function() {
        var visible = !document.body.classList.contains("vault-hidden");
        applyRailVisibility("left", !visible);
        invoke("set_rail_visible", { side: "left", visible: !visible }).catch(function() {
        });
      });
      ev.listen("menu:view_rail_right", function() {
        var visible = !document.body.classList.contains("toc-hidden");
        applyRailVisibility("right", !visible);
        invoke("set_rail_visible", { side: "right", visible: !visible }).catch(function() {
        });
      });
      ev.listen("menu:about", function(event) {
        var v = event && event.payload && event.payload.version || "?";
        alert("folio v" + v);
      });
    })();
  })();
})();
