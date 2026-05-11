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

  // app/ui/language-picker.ts
  var btn = null;
  var picker = null;
  var input = null;
  var list = null;
  var allLanguages = [];
  var currentId = "plaintext";
  var visibleItems = [];
  var activeIdx = -1;
  function ensureLoaded() {
    if (allLanguages.length > 0) return true;
    const f = window.FolioEditor;
    if (!f || typeof f.listLanguages !== "function") return false;
    allLanguages = f.listLanguages();
    allLanguages.sort(function(a, b) {
      return a.label.localeCompare(b.label);
    });
    return allLanguages.length > 0;
  }
  function labelFor(id) {
    for (let i = 0; i < allLanguages.length; i++) {
      if (allLanguages[i].id === id) return allLanguages[i].label;
    }
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : "Plain Text";
  }
  function highlightActive() {
    for (let i = 0; i < visibleItems.length; i++) {
      visibleItems[i].classList.toggle("active", i === activeIdx);
    }
    if (activeIdx >= 0 && visibleItems[activeIdx]) {
      visibleItems[activeIdx].scrollIntoView({ block: "nearest" });
    }
  }
  function renderList(filter) {
    list.innerHTML = "";
    visibleItems = [];
    const f = (filter || "").trim().toLowerCase();
    for (let i = 0; i < allLanguages.length; i++) {
      const l = allLanguages[i];
      if (f) {
        const hay = (l.label + " " + l.id + " " + l.aliases.join(" ")).toLowerCase();
        if (hay.indexOf(f) === -1) continue;
      }
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.langId = l.id;
      if (l.id === currentId) li.classList.add("current");
      const labelEl = document.createElement("span");
      labelEl.textContent = l.label;
      const idEl = document.createElement("span");
      idEl.className = "lang-id";
      idEl.textContent = l.id;
      li.appendChild(labelEl);
      li.appendChild(idEl);
      list.appendChild(li);
      visibleItems.push(li);
    }
    activeIdx = -1;
    for (let j = 0; j < visibleItems.length; j++) {
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
    const f = window.FolioEditor;
    if (f && typeof f.setLanguage === "function") f.setLanguage(langId);
    setEditorLanguageDisplay(langId);
    close();
  }
  function setEditorLanguageDisplay(id) {
    if (!btn) return;
    currentId = id || "plaintext";
    ensureLoaded();
    btn.textContent = labelFor(currentId);
    btn.hidden = false;
  }
  function initLanguagePicker() {
    btn = document.getElementById("status-language");
    picker = document.getElementById("lang-picker");
    input = document.getElementById("lang-picker-input");
    list = document.getElementById("lang-picker-list");
    if (!btn || !picker || !input || !list) return;
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
      const li = e.target.closest("li");
      if (li && li.dataset.langId) select(li.dataset.langId);
    });
    document.addEventListener("mousedown", function(e) {
      if (picker.hidden) return;
      if (e.target === btn || picker.contains(e.target)) return;
      close();
    });
  }

  // app/view/markdown.ts
  var contentEl = null;
  var tocEl = null;
  function post2(msg) {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.emit("shell:event", msg);
    }
  }
  function setTocActive(slug) {
    if (!tocEl) return;
    const prev = tocEl.querySelectorAll("li.entry.active");
    for (let i = 0; i < prev.length; i++) prev[i].classList.remove("active");
    if (!slug) return;
    const target = tocEl.querySelector('li.entry[data-slug="' + slug + '"]');
    if (target) {
      target.classList.add("active");
      target.scrollIntoView({ block: "nearest" });
    }
  }
  function setTocList(html) {
    if (!tocEl) return;
    const ul = tocEl.querySelector("ul.toc");
    if (ul) ul.innerHTML = html || "";
  }
  function scrollViewToAnchor(slug) {
    if (!slug || !contentEl) return;
    const target = contentEl.querySelector("#" + CSS.escape(slug));
    if (target) target.scrollIntoView({ block: "start" });
  }
  function scrollViewTo(y) {
    if (!contentEl) return;
    contentEl.scrollTo(0, y || 0);
  }
  function rewriteRelativeAssets(rootEl, documentPath) {
    if (!rootEl || !documentPath) return;
    const convert = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.convertFileSrc;
    if (typeof convert !== "function") return;
    const dir = documentPath.replace(/[\\/][^\\/]*$/, "");
    const imgs = rootEl.querySelectorAll("img");
    for (let i = 0; i < imgs.length; i++) {
      const src = imgs[i].getAttribute("src");
      if (!src) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
      if (src.indexOf("//") === 0) continue;
      let abs;
      if (/^[a-zA-Z]:[\\/]/.test(src) || src.charAt(0) === "/") {
        abs = src;
      } else {
        abs = dir + "/" + src;
      }
      abs = abs.replace(/\\/g, "/");
      try {
        imgs[i].src = convert(abs);
      } catch (_) {
      }
    }
  }
  var CHUNK_SIZE = 500;
  var hasHighlightAPI = typeof CSS !== "undefined" && CSS.highlights && typeof window.Highlight !== "undefined";
  var matchHL = null;
  var activeHL = null;
  var rangesArr = [];
  var activeIdx2 = -1;
  var currentTerm = "";
  var findOpts = { caseSensitive: false, wholeWord: false };
  var searchToken = 0;
  function ensureHighlights() {
    if (!hasHighlightAPI) return;
    if (!matchHL) {
      matchHL = new window.Highlight();
      CSS.highlights.set("folio-find", matchHL);
    }
    if (!activeHL) {
      activeHL = new window.Highlight();
      CSS.highlights.set("folio-find-active", activeHL);
    }
  }
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
    const lane = getLane();
    if (!lane) return;
    while (lane.firstChild) lane.removeChild(lane.firstChild);
  }
  function updateMarkers() {
    const lane = getLane();
    const content = getContent();
    if (!lane) return;
    clearLane();
    if (!content || rangesArr.length === 0) return;
    const totalH = content.scrollHeight;
    if (totalH <= 0) return;
    const contentTop = content.getBoundingClientRect().top;
    const scrollTop = content.scrollTop;
    const laneH = Math.max(1, lane.clientHeight);
    const seen = new Uint8Array(laneH);
    let activePixel = -1;
    const pixels = [];
    for (let i = 0; i < rangesArr.length; i++) {
      const rect = rangesArr[i].getBoundingClientRect();
      const pos = scrollTop + (rect.top - contentTop);
      const px = Math.max(0, Math.min(laneH - 1, Math.round(pos / totalH * laneH)));
      if (i === activeIdx2) activePixel = px;
      if (!seen[px]) {
        seen[px] = 1;
        pixels.push(px);
      }
    }
    const frag = document.createDocumentFragment();
    for (let j = 0; j < pixels.length; j++) {
      const p = pixels[j];
      const dot = document.createElement("div");
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
    activeIdx2 = -1;
    clearLane();
  }
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function buildRegex(term) {
    if (!term) return null;
    let pattern = escapeRegExp(term);
    if (findOpts.wholeWord) pattern = "\\b" + pattern + "\\b";
    const flags = findOpts.caseSensitive ? "g" : "gi";
    try {
      return new RegExp(pattern, flags);
    } catch (_) {
      return null;
    }
  }
  function buildWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        let p = node.parentNode;
        while (p && p !== root) {
          const tn = p.nodeName ? p.nodeName.toLowerCase() : "";
          if (tn === "script" || tn === "style") return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
  }
  function collectRangesAsync(root, regex, myToken, done) {
    const walker = buildWalker(root);
    function step() {
      if (myToken !== searchToken) return;
      const batchStart = rangesArr.length;
      let node;
      while (node = walker.nextNode()) {
        const text = node.nodeValue || "";
        if (!text) continue;
        regex.lastIndex = 0;
        let m;
        while (m = regex.exec(text)) {
          if (m[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          const r = document.createRange();
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
    const detail = { term: currentTerm, total: rangesArr.length, active: activeIdx2 };
    try {
      window.dispatchEvent(new CustomEvent("folio-find-state", { detail }));
    } catch (_) {
    }
    try {
      post2({ type: "editorFindState", term: detail.term, total: detail.total, active: detail.active });
    } catch (_) {
    }
  }
  function dispatchProgress(partialTotal) {
    try {
      window.dispatchEvent(new CustomEvent("folio-find-state", {
        detail: { term: currentTerm, total: partialTotal, active: -1, scanning: true }
      }));
    } catch (_) {
    }
  }
  function setActive(idx) {
    if (rangesArr.length === 0) {
      activeIdx2 = -1;
      if (activeHL) activeHL.clear();
      updateMarkers();
      dispatchState();
      return;
    }
    if (idx < 0) idx = (idx % rangesArr.length + rangesArr.length) % rangesArr.length;
    if (idx >= rangesArr.length) idx = idx % rangesArr.length;
    activeIdx2 = idx;
    if (activeHL) {
      activeHL.clear();
      activeHL.add(rangesArr[activeIdx2]);
    }
    const r = rangesArr[activeIdx2];
    const anchor = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    if (anchor) {
      try {
        anchor.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_) {
        try {
          anchor.scrollIntoView(true);
        } catch (__) {
        }
      }
    }
    updateMarkers();
    dispatchState();
  }
  function research() {
    clearMarks();
    const myToken = ++searchToken;
    if (!currentTerm) {
      dispatchState();
      return;
    }
    const root = getRoot();
    if (!root) {
      dispatchState();
      return;
    }
    const regex = buildRegex(currentTerm);
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
  var ViewFinder = {
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
      findOpts.caseSensitive = !!newOpts.caseSensitive;
      findOpts.wholeWord = !!newOpts.wholeWord;
      research();
    },
    findNext: function() {
      if (rangesArr.length > 0) setActive((activeIdx2 + 1) % rangesArr.length);
    },
    findPrev: function() {
      if (rangesArr.length > 0) setActive((activeIdx2 - 1 + rangesArr.length) % rangesArr.length);
    }
  };
  function initVisibleHeadingTracker() {
    let currentHeading = null;
    let lastScrollY = -1;
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
      const hs = collectHeadings();
      if (hs.length === 0) {
        sendHeading(null);
      } else {
        const threshold = 120;
        let active = hs[0];
        const contentTop = contentEl.getBoundingClientRect().top;
        for (let i = 0; i < hs.length; i++) {
          const top = hs[i].getBoundingClientRect().top - contentTop;
          if (top <= threshold) active = hs[i];
          else break;
        }
        sendHeading(active.id);
      }
      sendScroll(Math.round(contentEl.scrollTop));
    }
    let rafQueued = false;
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
  }
  function initMarkdownView() {
    contentEl = document.getElementById("view-region");
    tocEl = document.getElementById("toc-region");
    if (!contentEl || !tocEl) return;
    contentEl.addEventListener("click", function(e) {
      let el = e.target;
      while (el && el.tagName !== "A") el = el.parentElement;
      if (!el) return;
      const href = el.getAttribute("href");
      if (href === null) return;
      e.preventDefault();
      post2({ type: "linkClick", href });
    }, true);
    tocEl.addEventListener("click", function(e) {
      let el = e.target;
      while (el && !(el.classList && el.classList.contains("entry"))) el = el.parentElement;
      if (!el) return;
      const slug = el.getAttribute("data-slug");
      if (slug) post2({ type: "tocClick", slug });
    });
    initVisibleHeadingTracker();
  }

  // app/ui/find-bar.ts
  var bar = null;
  var input2 = null;
  var counter = null;
  var prevBtn = null;
  var nextBtn = null;
  var optsBtn = null;
  var closeBtn = null;
  var optsPanel = null;
  var caseChk = null;
  var wordChk = null;
  var ensureEditorMountedDep = null;
  var lastTermMemo = "";
  var inputDebounce = null;
  var INPUT_DEBOUNCE_MS = 150;
  function isEditMode() {
    return document.body.classList.contains("edit-mode");
  }
  function getFinder() {
    return isEditMode() ? window.FolioEditor : ViewFinder;
  }
  function isOpen() {
    return bar.classList.contains("open");
  }
  function doOpen(initial) {
    bar.classList.add("open");
    if (typeof initial === "string" && initial.length > 0) {
      input2.value = initial;
    }
    const f = getFinder();
    if (f) {
      f.setFindOptions({
        caseSensitive: caseChk.checked,
        wholeWord: wordChk.checked
      });
      f.openFind(input2.value);
    }
    input2.focus();
    input2.select();
  }
  function open2(initial) {
    if (isEditMode()) {
      ensureEditorMountedDep("").then(function(ok) {
        if (!ok) return;
        doOpen(initial);
      });
    } else {
      doOpen(initial);
    }
  }
  function close2() {
    bar.classList.remove("open");
    optsPanel.classList.remove("open");
    optsBtn.classList.remove("active");
    if (window.FolioEditor) window.FolioEditor.closeFind();
    if (ViewFinder) ViewFinder.closeFind();
    if (isEditMode() && window.focusEditor) window.focusEditor();
  }
  function openEditorFind(initialTerm) {
    open2(initialTerm);
  }
  function setEditorFindTerm(term) {
    input2.value = term || "";
    if (!isOpen()) open2(term || "");
    else {
      const f = getFinder();
      if (f) f.setFindTerm(term || "");
    }
  }
  function pickSeed(arg) {
    if (typeof arg === "string" && arg) return arg;
    if (input2.value) return input2.value;
    return lastTermMemo;
  }
  function findNext(lastTerm) {
    const seed = pickSeed(lastTerm);
    if (!bar.classList.contains("open")) {
      open2(seed);
      return;
    }
    if (!input2.value) {
      if (seed) {
        input2.value = seed;
        const f0 = getFinder();
        if (f0) f0.openFind(seed);
      } else {
        input2.focus();
        input2.select();
        return;
      }
    }
    const f = getFinder();
    if (f) f.findNext();
  }
  function findPrev(lastTerm) {
    const seed = pickSeed(lastTerm);
    if (!bar.classList.contains("open")) {
      open2(seed);
      return;
    }
    if (!input2.value) {
      if (seed) {
        input2.value = seed;
        const f0 = getFinder();
        if (f0) f0.openFind(seed);
      } else {
        input2.focus();
        input2.select();
        return;
      }
    }
    const f = getFinder();
    if (f) f.findPrev();
  }
  function afterModeSwitch() {
    setTimeout(function() {
      if (bar.classList.contains("open")) {
        if (window.FolioEditor) window.FolioEditor.closeFind();
        if (ViewFinder) ViewFinder.closeFind();
        const f = getFinder();
        if (f) {
          f.setFindOptions({
            caseSensitive: caseChk.checked,
            wholeWord: wordChk.checked
          });
          f.openFind(input2.value);
        }
        input2.focus();
        input2.select();
      } else if (isEditMode() && window.focusEditor) {
        window.focusEditor();
      }
    }, 0);
  }
  function initFindBar(deps6) {
    ensureEditorMountedDep = deps6.ensureEditorMounted;
    bar = document.getElementById("find-bar");
    input2 = document.getElementById("find-input");
    counter = document.getElementById("find-counter");
    prevBtn = document.getElementById("find-prev");
    nextBtn = document.getElementById("find-next");
    optsBtn = document.getElementById("find-opts");
    closeBtn = document.getElementById("find-close");
    optsPanel = document.getElementById("find-opts-panel");
    caseChk = document.getElementById("find-case");
    wordChk = document.getElementById("find-word");
    input2.addEventListener("input", function() {
      if (input2.value) lastTermMemo = input2.value;
      if (inputDebounce) clearTimeout(inputDebounce);
      inputDebounce = setTimeout(function() {
        inputDebounce = null;
        const f = getFinder();
        if (f) f.setFindTerm(input2.value);
      }, INPUT_DEBOUNCE_MS);
    });
    input2.addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        const f = getFinder();
        if (!f) return;
        if (e.shiftKey) f.findPrev();
        else f.findNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close2();
      }
    });
    prevBtn.addEventListener("click", function() {
      const f = getFinder();
      if (f) f.findPrev();
    });
    nextBtn.addEventListener("click", function() {
      const f = getFinder();
      if (f) f.findNext();
    });
    closeBtn.addEventListener("click", close2);
    optsBtn.addEventListener("click", function() {
      const on = !optsPanel.classList.contains("open");
      optsPanel.classList.toggle("open", on);
      optsBtn.classList.toggle("active", on);
    });
    function syncOptions() {
      const f = getFinder();
      if (f) {
        f.setFindOptions({
          caseSensitive: caseChk.checked,
          wholeWord: wordChk.checked
        });
      }
    }
    caseChk.addEventListener("change", syncOptions);
    wordChk.addEventListener("change", syncOptions);
    document.addEventListener("keydown", function(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        openEditorFind("");
      } else if (e.key === "F3") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) findPrev();
        else findNext();
      }
    }, { capture: true });
    window.addEventListener("folio-find-state", function(e) {
      const s = e.detail || {};
      if (!s.term && !input2.value) {
        counter.textContent = "";
        return;
      }
      if (typeof s.total !== "number" || s.total === 0) {
        counter.textContent = input2.value || s.term ? "0/0" : "";
      } else if (s.scanning || s.active < 0) {
        counter.textContent = "\u2026/" + s.total;
      } else {
        counter.textContent = s.active + 1 + "/" + s.total;
      }
    });
  }

  // app/ui/export-dialog.ts
  var deps = null;
  var selectedLayoutId = null;
  var selectedExportFormat = "html";
  var exportKeydownHandler = null;
  function $(id) {
    return document.getElementById(id);
  }
  function invoke(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  function fileBaseName(p) {
    if (!p) return "Dokument";
    const s = p.replace(/\\/g, "/").split("/").pop() || p;
    return s.replace(/\.(md|markdown|mdown|mkd)$/i, "") || "Dokument";
  }
  function setExportFormat(fmt) {
    selectedExportFormat = fmt === "pdf" ? "pdf" : "html";
    const buttons = document.querySelectorAll("#export-formats button");
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle(
        "active",
        buttons[i].getAttribute("data-format") === selectedExportFormat
      );
    }
  }
  function selectLayoutCard(id) {
    selectedLayoutId = id;
    const cards = document.querySelectorAll("#export-cards .export-card");
    for (let i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("selected", cards[i].dataset.layoutId === id);
    }
    const saveBtn = $("export-save");
    if (saveBtn) saveBtn.disabled = !id;
  }
  function openExportDialog() {
    if (!document.body.classList.contains("kind-markdown")) return;
    setExportFormat("html");
    const sync = document.body.classList.contains("edit-mode") && deps.getCurrentPath() ? deps.syncEditorTextToStore() : Promise.resolve();
    sync.then(function() {
      return invoke("export_layouts");
    }).then(function(layouts) {
      const cards = $("export-cards");
      cards.innerHTML = "";
      (layouts || []).forEach(function(layout) {
        const card = document.createElement("div");
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
          const iframe = card.querySelector("iframe");
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
      deps.showStatus(typeof err === "string" ? err : "Export fehlgeschlagen");
    });
  }
  function closeExportDialog() {
    $("export-dialog").hidden = true;
    if (exportKeydownHandler) {
      document.removeEventListener("keydown", exportKeydownHandler);
      exportKeydownHandler = null;
    }
    const cards = $("export-cards");
    if (cards) cards.innerHTML = "";
  }
  function doExportSave() {
    if (!selectedLayoutId) return;
    const fmt = selectedExportFormat;
    const defaultName = fileBaseName(deps.getCurrentPath()) + "." + fmt;
    const cmd = fmt === "pdf" ? "export_pdf" : "export_html";
    invoke("pick_export_target", { defaultName, format: fmt }).then(function(targetPath) {
      if (!targetPath) return;
      deps.showStatus("Export l\xE4uft\u2026");
      return invoke(cmd, { layoutId: selectedLayoutId, targetPath }).then(function() {
        closeExportDialog();
        deps.showStatus("Exportiert: " + targetPath);
      });
    }).catch(function(err) {
      deps.showStatus(typeof err === "string" ? err : "Export fehlgeschlagen");
    });
  }
  function initExportDialog(d) {
    deps = d;
    const tbExport = $("tb-export");
    if (tbExport) tbExport.addEventListener("click", openExportDialog);
    const cancel = $("export-cancel");
    if (cancel) cancel.addEventListener("click", closeExportDialog);
    const save = $("export-save");
    if (save) save.addEventListener("click", doExportSave);
    const exportFormats = $("export-formats");
    if (exportFormats) {
      exportFormats.addEventListener("click", function(e) {
        const btn2 = e.target.closest("button[data-format]");
        if (!btn2 || btn2.disabled) return;
        setExportFormat(btn2.getAttribute("data-format"));
      });
    }
  }

  // app/ui/rails.ts
  function post3(msg) {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.emit("shell:event", msg);
    }
  }
  function setRailVisibility(side, visible) {
    if (side === "right") {
      document.body.classList.toggle("toc-hidden", !visible);
    } else if (side === "left") {
      document.body.classList.toggle("vault-hidden", !visible);
    }
  }
  function setTocWidth(w) {
    if (typeof w !== "number" || isNaN(w) || w <= 0) return;
    document.documentElement.style.setProperty("--toc-w", w + "px");
  }
  function setVaultWidth(w) {
    if (typeof w !== "number" || isNaN(w) || w <= 0) return;
    document.documentElement.style.setProperty("--vault-w", w + "px");
  }
  function initRightSplitter() {
    const splitter = document.getElementById("splitter-right");
    if (!splitter) return;
    let dragState2 = null;
    function currentTocWidth() {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--toc-w").trim();
      const n = parseFloat(v);
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
      const dx = e.clientX - dragState2.startX;
      const maxW = Math.max(150, window.innerWidth - 320 - 8);
      const newW = Math.max(150, Math.min(maxW, dragState2.startW - dx));
      document.documentElement.style.setProperty("--toc-w", newW + "px");
    });
    function endDrag(e) {
      if (!dragState2) return;
      try {
        splitter.releasePointerCapture(e.pointerId);
      } catch (_) {
      }
      dragState2 = null;
      post3({ type: "railResize", side: "right", width: currentTocWidth() });
    }
    splitter.addEventListener("pointerup", endDrag);
    splitter.addEventListener("pointercancel", endDrag);
  }
  function initLeftSplitter() {
    const splitter = document.getElementById("splitter-left");
    if (!splitter) return;
    let dragState2 = null;
    function currentVaultWidth() {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--vault-w").trim();
      const n = parseFloat(v);
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
      const dx = e.clientX - dragState2.startX;
      const maxW = Math.max(150, window.innerWidth - 320 - 8);
      const newW = Math.max(150, Math.min(maxW, dragState2.startW + dx));
      document.documentElement.style.setProperty("--vault-w", newW + "px");
    });
    function endDrag(e) {
      if (!dragState2) return;
      try {
        splitter.releasePointerCapture(e.pointerId);
      } catch (_) {
      }
      dragState2 = null;
      post3({ type: "railResize", side: "left", width: currentVaultWidth() });
    }
    splitter.addEventListener("pointerup", endDrag);
    splitter.addEventListener("pointercancel", endDrag);
  }
  function initRails() {
    initRightSplitter();
    initLeftSplitter();
  }

  // app/vault/context-menu.ts
  var deps2 = null;
  var ctxMenu = null;
  var ctxTarget = null;
  function invoke2(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  function openContextMenu(x, y, path, isDir, inPinned, inRecent) {
    if (!ctxMenu) return;
    ctxTarget = { path, isDirectory: isDir };
    const parts = [];
    if (!isDir) parts.push('<div class="ctx-item" data-act="open">\xD6ffnen</div>');
    const actionsBefore = parts.length;
    const actions = [];
    if (!isDir) actions.push('<div class="ctx-item" data-act="rename">Umbenennen</div>');
    if (!inPinned) actions.push('<div class="ctx-item" data-act="pin">Anpinnen</div>');
    if (inPinned) actions.push('<div class="ctx-item" data-act="unpin">Vom Pin l\xF6sen</div>');
    if (inRecent) actions.push('<div class="ctx-item" data-act="remove-recent">Aus \u201EZuletzt" entfernen</div>');
    if (actions.length && actionsBefore) parts.push('<div class="ctx-sep"></div>');
    parts.push(...actions);
    const tail = [
      '<div class="ctx-item" data-act="show">Im Explorer zeigen</div>',
      '<div class="ctx-item" data-act="terminal">Terminal hier \xF6ffnen</div>',
      '<div class="ctx-item" data-act="copy">Pfad kopieren</div>'
    ];
    if (parts.length) parts.push('<div class="ctx-sep"></div>');
    parts.push(...tail);
    ctxMenu.innerHTML = parts.join("");
    ctxMenu.style.left = x + "px";
    ctxMenu.style.top = y + "px";
    ctxMenu.classList.add("open");
  }
  function closeContextMenu() {
    if (ctxMenu) ctxMenu.classList.remove("open");
    ctxTarget = null;
  }
  function startInlineRename(path) {
    if (!path) return;
    const nodes = document.querySelectorAll("#vault-tree li.node[data-path]");
    let nodeEl = null;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.getAttribute("data-path") === path && n.getAttribute("data-kind") !== "dir") {
        nodeEl = n;
        break;
      }
    }
    if (!nodeEl) return;
    const labelEl = nodeEl.querySelector(":scope > .row > .label");
    if (!labelEl || labelEl.dataset.editing === "1") return;
    const originalText = labelEl.textContent || "";
    const basename = originalText;
    labelEl.dataset.editing = "1";
    labelEl.classList.add("editing");
    labelEl.textContent = "";
    const input3 = document.createElement("input");
    input3.type = "text";
    input3.className = "vault-rename-input";
    input3.value = basename;
    input3.spellcheck = false;
    input3.autocomplete = "off";
    input3.setAttribute("data-rename-input", "1");
    labelEl.appendChild(input3);
    function stop(e) {
      e.stopPropagation();
    }
    input3.addEventListener("click", stop);
    input3.addEventListener("mousedown", stop);
    input3.addEventListener("dblclick", stop);
    input3.addEventListener("contextmenu", stop);
    let finished = false;
    function cleanup() {
      input3.removeEventListener("keydown", onKey);
      input3.removeEventListener("blur", onBlur);
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
      const newName = (input3.value || "").trim();
      if (!newName || newName === originalText) {
        restore();
        return;
      }
      cleanup();
      labelEl.textContent = newName;
      const normalized = path.replace(/\\/g, "/");
      const lastSlash = normalized.lastIndexOf("/");
      const parent = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
      const newPath = parent + newName;
      invoke2("rename_file", { oldPath: path, newPath }).catch(function(err) {
        deps2.showStatus(typeof err === "string" ? err : "Umbenennen fehlgeschlagen");
        deps2.refreshVault();
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
    input3.addEventListener("keydown", onKey);
    input3.addEventListener("blur", onBlur);
    input3.focus();
    const dot = basename.lastIndexOf(".");
    if (dot > 0) input3.setSelectionRange(0, dot);
    else input3.select();
  }
  function initContextMenu(d) {
    deps2 = d;
    ctxMenu = document.getElementById("context-menu");
    if (!ctxMenu) return;
    ctxMenu.addEventListener("click", function(e) {
      const item = e.target.closest(".ctx-item");
      if (!item || item.classList.contains("disabled") || !ctxTarget) return;
      const act = item.getAttribute("data-act");
      const path = ctxTarget.path;
      const isDir = ctxTarget.isDirectory;
      closeContextMenu();
      if (act === "open" && !isDir) {
        deps2.openDocument(path);
      } else if (act === "pin") {
        invoke2("workspace_pin", { path, isDirectory: isDir }).catch(function() {
        });
      } else if (act === "unpin") {
        invoke2("workspace_unpin", { path }).catch(function() {
        });
      } else if (act === "remove-recent") {
        invoke2("workspace_remove_recent", { path }).catch(function() {
        });
      } else if (act === "rename") {
        startInlineRename(path);
      } else if (act === "show") {
        invoke2("show_in_file_manager", { path }).catch(function() {
        });
      } else if (act === "terminal") {
        invoke2("open_terminal_at", { path }).catch(function() {
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

  // app/vault/tree.ts
  var deps3 = null;
  var ROOT = null;
  var REGION = null;
  var currentActivePath = "";
  var fileIconCache = {};
  var fileIconPending = {};
  function post4(msg) {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.emit("shell:event", msg);
    }
  }
  function invoke3(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  function findAllNodesByPath(path) {
    if (!path) return [];
    const matches = [];
    const nodes = ROOT.querySelectorAll(".node");
    for (let i = 0; i < nodes.length; i++) {
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
  function reapplyActiveMarker() {
    const prev = ROOT.querySelectorAll(".node.active");
    for (let i = 0; i < prev.length; i++) prev[i].classList.remove("active");
    if (!currentActivePath) return;
    const nodes = findAllNodesByPath(currentActivePath);
    for (let n = 0; n < nodes.length; n++) nodes[n].classList.add("active");
  }
  function setVaultPinned(html) {
    const section = ROOT.querySelector('li.section[data-section="pinned"]');
    if (!section) return;
    const ul = section.querySelector(":scope > ul.children");
    if (ul) ul.innerHTML = html || "";
    reapplyActiveMarker();
  }
  function setVaultRecent(html) {
    const section = ROOT.querySelector('li.section[data-section="recent"]');
    if (!section) return;
    const ul = section.querySelector(":scope > ul.children");
    if (ul) ul.innerHTML = html || "";
    reapplyActiveMarker();
  }
  function insertVaultChildren(path, html) {
    const lis = findAllNodesByPath(path);
    for (let n = 0; n < lis.length; n++) {
      const li = lis[n];
      const ul = li.querySelector(":scope > ul.children");
      if (!ul) continue;
      ul.innerHTML = html || "";
      ul.classList.remove("collapsed");
      li.setAttribute("data-loaded", "1");
      const caret = li.querySelector(":scope > .row > .caret");
      if (caret) caret.classList.add("open");
      const iconEl = li.querySelector(":scope > .row > .icon");
      if (iconEl) iconEl.textContent = "\u{1F4C2}";
    }
    reapplyActiveMarker();
  }
  function setVaultActive(path) {
    currentActivePath = path || "";
    reapplyActiveMarker();
  }
  function toggleSection(section) {
    const key = section.getAttribute("data-section");
    const caret = section.querySelector(":scope > .row > .caret");
    const ul = section.querySelector(":scope > ul.children");
    const nowExpanded = !(caret && caret.classList.contains("open"));
    if (caret) caret.classList.toggle("open", nowExpanded);
    if (ul) ul.classList.toggle("collapsed", !nowExpanded);
    post4({ type: "toggle-section", section: key, expanded: nowExpanded });
  }
  function toggleDir(node) {
    const caret = node.querySelector(":scope > .row > .caret");
    const ul = node.querySelector(":scope > ul.children");
    const iconEl = node.querySelector(":scope > .row > .icon");
    const path = node.getAttribute("data-path");
    const loaded = node.getAttribute("data-loaded") === "1";
    const open3 = caret && caret.classList.contains("open");
    if (open3) {
      if (caret) caret.classList.remove("open");
      if (ul) ul.classList.add("collapsed");
      if (iconEl) iconEl.textContent = "\u{1F4C1}";
      post4({ type: "collapse-dir", path });
    } else {
      if (caret) caret.classList.add("open");
      if (ul) ul.classList.remove("collapsed");
      if (iconEl) iconEl.textContent = "\u{1F4C2}";
      if (!loaded) post4({ type: "expand-dir", path });
    }
  }
  function resolveFileIcon(ext) {
    if (fileIconCache[ext] !== void 0) {
      return Promise.resolve(fileIconCache[ext]);
    }
    if (fileIconPending[ext]) return fileIconPending[ext];
    const p = invoke3("file_icon_data_uri", { ext }).then(function(uri) {
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
    let imgs;
    if (rootNode.matches && rootNode.matches("img.ftype-icon")) {
      imgs = [rootNode];
    } else if (rootNode.querySelectorAll) {
      imgs = rootNode.querySelectorAll("img.ftype-icon");
    } else {
      return;
    }
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (img.src) continue;
      const ext = img.getAttribute("data-ext") || "";
      (function(target, e) {
        resolveFileIcon(e).then(function(uri) {
          if (uri) target.src = uri;
        });
      })(img, ext);
    }
  }
  function renderVault(html) {
    if (!ROOT) return;
    if (!html || html.length === 0) {
      ROOT.innerHTML = '<li class="empty">Keine Eintr\xE4ge. Datei \xF6ffnen oder per Drag&amp;Drop ablegen.</li>';
      return;
    }
    ROOT.innerHTML = html;
    applyIconsToNode(ROOT);
    reapplyActiveMarker();
  }
  function refreshVault() {
    invoke3("vault_build_tree").then(renderVault).catch(function(err) {
      console.warn("vault_build_tree failed:", err);
    });
  }
  function isDirectChildOfSection(node, sectionKey) {
    let n = node.parentElement;
    while (n) {
      if (n.classList && n.classList.contains("section") && n.getAttribute("data-section") === sectionKey) return true;
      if (n.classList && n.classList.contains("node")) return false;
      n = n.parentElement;
    }
    return false;
  }
  function initVaultTree(d) {
    deps3 = d;
    ROOT = document.getElementById("vault-tree");
    REGION = document.getElementById("vault-region");
    if (!ROOT || !REGION) return;
    REGION.addEventListener("click", function(e) {
      if (e.button !== 0) return;
      let cmdBtn = e.target;
      while (cmdBtn && cmdBtn !== REGION && !(cmdBtn.classList && cmdBtn.classList.contains("vault-cmd"))) {
        cmdBtn = cmdBtn.parentElement;
      }
      if (cmdBtn && cmdBtn !== REGION && cmdBtn.classList.contains("vault-cmd")) {
        e.preventDefault();
        e.stopPropagation();
        const cmd = cmdBtn.getAttribute("data-cmd");
        if (cmd === "addFile") {
          invoke3("pick_file").then(function(path) {
            if (path) deps3.openDocument(path);
          }).catch(function() {
          });
        } else if (cmd === "addFolder") {
          invoke3("pick_folder").then(function(path) {
            if (path) invoke3("workspace_pin", { path, isDirectory: true }).catch(function() {
            });
          }).catch(function() {
          });
        }
        return;
      }
      let row = e.target;
      while (row && row !== ROOT && !(row.classList && row.classList.contains("row"))) {
        row = row.parentElement;
      }
      if (!row || row === ROOT) return;
      const node = findAncestor(row.parentElement, "node");
      if (node) {
        const kind = node.getAttribute("data-kind");
        if (kind === "dir") {
          toggleDir(node);
          return;
        }
        if (kind === "file") {
          const p = node.getAttribute("data-path");
          if (p) deps3.openDocument(p);
          return;
        }
      }
      const section = findAncestor(row.parentElement, "section");
      if (section) toggleSection(section);
    });
    REGION.addEventListener("contextmenu", function(e) {
      e.preventDefault();
      const node = findAncestor(e.target, "node");
      if (!node) {
        post4({ type: "context", path: null, x: e.clientX, y: e.clientY });
        return;
      }
      post4({
        type: "context",
        path: node.getAttribute("data-path"),
        kind: node.getAttribute("data-kind"),
        isPinned: node.getAttribute("data-pinned") === "1",
        isInRecent: node.getAttribute("data-recent") === "1",
        x: e.clientX,
        y: e.clientY
      });
    });
    ROOT.addEventListener("click", function(e) {
      const item = e.target.closest(".vault-item");
      if (!item) return;
      const path = item.getAttribute("data-path");
      const isDir = item.getAttribute("data-directory") === "true";
      if (!path) return;
      if (isDir) {
        invoke3("vault_expand_dir", { path }).catch(function() {
        });
      } else {
        deps3.openDocument(path);
      }
    });
    ROOT.addEventListener("contextmenu", function(e) {
      const item = e.target.closest("li.node");
      if (!item) return;
      e.preventDefault();
      const path = item.getAttribute("data-path");
      const isDir = item.getAttribute("data-kind") === "dir";
      const inPinned = isDirectChildOfSection(item, "pinned");
      const inRecent = isDirectChildOfSection(item, "recent");
      openContextMenu(e.clientX, e.clientY, path, isDir, inPinned, inRecent);
    });
    if (typeof MutationObserver === "function") {
      const iconObserver = new MutationObserver(function(mutations) {
        for (let m = 0; m < mutations.length; m++) {
          const added = mutations[m].addedNodes;
          for (let n = 0; n < added.length; n++) {
            if (added[n].nodeType === 1) applyIconsToNode(added[n]);
          }
        }
      });
      iconObserver.observe(ROOT, { childList: true, subtree: true });
    }
    window.__TAURI__.event.listen("vault:refresh", function(event) {
      const data = event && event.payload || {};
      if (data.pinned) setVaultPinned(data.pinned);
      if (data.recent) setVaultRecent(data.recent);
      refreshVault();
    });
    refreshVault();
  }

  // app/ui/dialogs.ts
  function $2(id) {
    return document.getElementById(id);
  }
  function showUnsavedDialog() {
    const dialog = $2("unsaved-dialog");
    if (!dialog) return Promise.resolve("cancel");
    dialog.hidden = false;
    return new Promise(function(resolve) {
      function done(decision) {
        dialog.hidden = true;
        $2("unsaved-save").removeEventListener("click", save);
        $2("unsaved-discard").removeEventListener("click", discard);
        $2("unsaved-cancel").removeEventListener("click", cancel);
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
      $2("unsaved-save").addEventListener("click", save);
      $2("unsaved-discard").addEventListener("click", discard);
      $2("unsaved-cancel").addEventListener("click", cancel);
      document.addEventListener("keydown", onKey);
      setTimeout(function() {
        const btn2 = $2("unsaved-save");
        if (btn2) btn2.focus();
      }, 0);
    });
  }

  // app/state/document.ts
  var deps4 = null;
  var currentPath2 = null;
  var cleanText2 = "";
  var isDirty = false;
  function invoke4(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  function $3(id) {
    return document.getElementById(id);
  }
  function getCurrentPath() {
    return currentPath2;
  }
  function getCleanText() {
    return cleanText2;
  }
  function getIsDirty() {
    return isDirty;
  }
  function fileFullName(p) {
    if (!p) return null;
    return p.replace(/\\/g, "/").split("/").pop() || p;
  }
  function applyWindowTitle() {
    const name = fileFullName(currentPath2);
    const title = name ? (isDirty ? "* " + name : name) + " \u2014 Folio" : "Folio";
    document.title = title;
    invoke4("set_window_title", { title }).catch(function() {
    });
  }
  function markDirty(dirty) {
    isDirty = !!dirty;
    const el = $3("status-path");
    if (el) el.classList.toggle("dirty", isDirty);
    const btn2 = $3("tb-save");
    if (btn2) btn2.disabled = !isDirty;
    invoke4("menu_set_enabled", { id: "file.save", enabled: isDirty }).catch(function() {
    });
    applyWindowTitle();
  }
  function setStatusPath(path, dirty) {
    const el = $3("status-path");
    if (!el) return;
    el.textContent = path || "Bereit";
    el.classList.toggle("dirty", !!dirty);
  }
  function updateWordCount(text) {
    const el = $3("status-wordcount");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const chars = text.length;
    const words = (text.match(/\S+/g) || []).length;
    const lines = text.split(/\r\n|\r|\n/).length;
    el.hidden = false;
    el.textContent = words + " W\xF6rter \xB7 " + chars + " Zeichen \xB7 " + lines + " Zeilen";
  }
  function showStatus(msg) {
    const el = $3("status-path");
    if (el) el.textContent = msg;
  }
  function editorText() {
    if (window.FolioEditor && typeof window.FolioEditor.getText === "function") {
      return window.FolioEditor.getText();
    }
    return cleanText2;
  }
  function refreshDirtyFromEditor() {
    const dirty = !!currentPath2 && editorText() !== cleanText2;
    markDirty(dirty);
    return dirty;
  }
  function syncEditorTextToStore() {
    if (!currentPath2) return Promise.resolve();
    return invoke4("editor_text_changed", { text: editorText() }).catch(function() {
    });
  }
  function saveCurrent() {
    return syncEditorTextToStore().then(function() {
      return invoke4("editor_save_requested");
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
    const dirty = refreshDirtyFromEditor();
    if (!dirty && !isDirty) return Promise.resolve(true);
    return syncEditorTextToStore().then(showUnsavedDialog).then(function(decision) {
      if (decision === "cancel") return false;
      if (decision === "discard") {
        return invoke4("discard_editor_changes").then(function() {
          cleanText2 = editorText();
          markDirty(false);
          return true;
        }).catch(function() {
          return false;
        });
      }
      return invoke4("editor_save_requested").then(function(saved) {
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
  function syncViewModeMenuChecks() {
    const body2 = document.body;
    const hasDoc = !body2.classList.contains("kind-unknown") && !body2.classList.contains("kind-binary");
    const mode = !hasDoc ? null : body2.classList.contains("edit-mode") ? "edit" : body2.classList.contains("split-mode") ? "split" : "view";
    invoke4("menu_set_checked", { id: "view.mode.view", checked: mode === "view" }).catch(function() {
    });
    invoke4("menu_set_checked", { id: "view.mode.edit", checked: mode === "edit" }).catch(function() {
    });
    invoke4("menu_set_checked", { id: "view.mode.split", checked: mode === "split" }).catch(function() {
    });
  }
  function applyDocKind(kind) {
    const resolved = kind || "unknown";
    const body2 = document.body;
    DOC_KIND_CLASSES.forEach(function(c) {
      body2.classList.remove(c);
    });
    body2.classList.add("kind-" + resolved);
    const md = resolved === "markdown";
    const hasDoc = resolved !== "unknown" && resolved !== "binary";
    const btnView = $3("tb-mode-view");
    if (btnView) {
      btnView.disabled = !md;
      btnView.title = md ? "View (Ctrl+1)" : "View nur f\xFCr Markdown verf\xFCgbar";
    }
    const btnEdit = $3("tb-mode-edit");
    if (btnEdit) {
      btnEdit.disabled = !hasDoc;
      btnEdit.title = hasDoc ? "Edit (Ctrl+2)" : "Kein Dokument geladen";
    }
    const btnExport = $3("tb-export");
    if (btnExport) {
      btnExport.disabled = !md;
      btnExport.title = md ? "Exportieren\u2026" : "Export nur f\xFCr Markdown verf\xFCgbar";
    }
    invoke4("menu_set_enabled", { id: "view.mode.view", enabled: md }).catch(function() {
    });
    invoke4("menu_set_enabled", { id: "view.mode.edit", enabled: hasDoc }).catch(function() {
    });
    invoke4("menu_set_enabled", { id: "file.save_as", enabled: hasDoc }).catch(function() {
    });
    invoke4("menu_set_enabled", { id: "file.rename", enabled: hasDoc }).catch(function() {
    });
    invoke4("menu_set_enabled", { id: "file.close", enabled: hasDoc }).catch(function() {
    });
    syncCheatsheetMenu();
    syncViewModeMenuChecks();
  }
  function openDocument(path) {
    return requestSaveIfDirty().then(function(ok) {
      if (!ok) return false;
      return invoke4("read_file", { path }).then(function(data) {
        invoke4("workspace_add_recent", { path }).catch(function() {
        });
        const kind = data && data.kind;
        if (kind && kind !== "markdown" && !document.body.classList.contains("edit-mode")) {
          invoke4("set_view_mode", { mode: "edit" }).then(function() {
            deps4.setActiveMode("edit");
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
  function renderDocumentPayload(data) {
    if (!data || typeof data !== "object") return;
    setTocList(data.tocHtml || data.toc_html || "");
    const view = document.getElementById("view-region");
    const body2 = view && view.querySelector(".markdown-body");
    if (body2) {
      body2.innerHTML = data.content || data.html || "";
      rewriteRelativeAssets(body2, data.path || currentPath2);
    }
  }
  function initDocumentState(d) {
    deps4 = d;
    const listen = window.__TAURI__.event.listen;
    listen("document:loaded", function(event) {
      const data = event && event.payload || {};
      currentPath2 = data.path || null;
      cleanText2 = data.text || "";
      markDirty(false);
      setStatusPath(data.path || "Bereit", false);
      updateWordCount(data.text || "");
      applyDocKind(data.kind || "unknown");
      invoke4("workspace_add_recent", { path: data.path }).catch(function() {
      });
      if (window.FolioEditor && typeof window.FolioEditor.setText === "function" && typeof window.loadEditorText === "function") {
        window.loadEditorText(data.text || "", data.language || "");
      }
      setEditorLanguageDisplay(data.language || "plaintext");
      setTocList(data.tocHtml || data.toc_html || "");
      const contentEl2 = document.getElementById("view-region");
      const body2 = contentEl2 && contentEl2.querySelector(".markdown-body");
      if (body2) {
        const isMd = data.kind === "markdown";
        body2.innerHTML = isMd ? data.content || data.html || "" : "";
        if (isMd) rewriteRelativeAssets(body2, data.path || "");
      }
      setVaultActive(data.path || "");
      const bar2 = document.getElementById("find-bar");
      if (bar2 && bar2.classList.contains("open") && !document.body.classList.contains("edit-mode")) {
        const input3 = document.getElementById("find-input");
        if (input3 && input3.value) {
          setTimeout(function() {
            ViewFinder.setFindTerm(input3.value);
          }, 0);
        }
      }
    });
    listen("document:dirty_changed", function(event) {
      const dirty = event && event.payload && (event.payload.is_dirty || event.payload.isDirty);
      markDirty(!!dirty);
    });
    listen("document:closed", function() {
      currentPath2 = null;
      cleanText2 = "";
      markDirty(false);
      if (window.FolioEditor && typeof window.FolioEditor.setText === "function") {
        window.FolioEditor.setText("", "plaintext");
      }
      const view = document.getElementById("view-region");
      const body2 = view && view.querySelector(".markdown-body");
      if (body2) body2.innerHTML = "";
      setTocList("");
      applyDocKind("unknown");
      setStatusPath("Bereit", false);
      updateWordCount("");
      applyWindowTitle();
    });
    listen("document:saved", function(event) {
      const data = event && event.payload || {};
      cleanText2 = data.text || editorText();
      markDirty(false);
      renderDocumentPayload(data);
      updateWordCount(data.text || "");
    });
    applyDocKind("unknown");
  }

  // app/editor/shell.ts
  var deps5 = null;
  var editorMounted = false;
  function invoke5(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  function $4(id) {
    return document.getElementById(id);
  }
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
  function loadEditorText(text, language) {
    ensureEditorMounted(text || "").then(function(ok) {
      if (!ok) return;
      window.FolioEditor.setText(text || "", language || "plaintext");
      if (document.body.classList.contains("edit-mode")) {
        layoutEditor();
      }
    });
  }
  function focusEditor() {
    const initial = deps5 && deps5.getCleanText ? deps5.getCleanText() : "";
    ensureEditorMounted(initial).then(function(ok) {
      if (!ok) return;
      layoutEditor();
      window.FolioEditor.focus();
    });
  }
  function layoutEditor() {
    if (!window.FolioEditor || !editorMounted || typeof window.FolioEditor.layout !== "function") return;
    requestAnimationFrame(function() {
      window.FolioEditor.layout();
      requestAnimationFrame(function() {
        window.FolioEditor.layout();
      });
    });
  }
  function setEditorTheme(mode) {
    if (window.FolioEditor) window.FolioEditor.setTheme(mode);
  }
  function applyEditorReplace(fullText, selectionStart, selectionLength) {
    if (!window.FolioEditor) return;
    window.FolioEditor.applyReplace({
      fullText: fullText || "",
      selectionStart: selectionStart || 0,
      selectionLength: selectionLength || 0
    });
  }
  function setActiveMode(mode) {
    $4("tb-mode-view").classList.toggle("active", mode === "view");
    $4("tb-mode-edit").classList.toggle("active", mode === "edit");
    const sm = $4("status-mode");
    if (sm) sm.textContent = mode === "edit" ? "Edit" : "View";
    cheatsheetSyncMode(mode === "edit");
    invoke5("menu_set_checked", { id: "view.mode.view", checked: mode === "view" }).catch(function() {
    });
    invoke5("menu_set_checked", { id: "view.mode.edit", checked: mode === "edit" }).catch(function() {
    });
    invoke5("menu_set_checked", { id: "view.mode.split", checked: mode === "split" }).catch(function() {
    });
  }
  function setMode(mode) {
    return deps5.requestSaveIfDirty().then(function(ok) {
      if (!ok) return false;
      return invoke5("set_view_mode", { mode }).then(function() {
        setActiveMode(mode);
        return true;
      });
    });
  }
  function initEditorShell(d) {
    deps5 = d;
    const listen = window.__TAURI__.event.listen;
    listen("shell:command", function(event) {
      const data = event && event.payload;
      if (!data || typeof data !== "object") return;
      switch (data.type) {
        case "loadEditorText":
          loadEditorText(data.text || "");
          break;
        case "applyEditorReplace":
          applyEditorReplace(
            data.fullText || "",
            data.selectionStart || 0,
            data.selectionLength || 0
          );
          break;
        default:
          break;
      }
    });
    listen("editor:load_text", function(event) {
      const data = event && event.payload || {};
      loadEditorText(data.text || "", data.language || "");
    });
    listen("editor:apply_replace", function(event) {
      const data = event && event.payload || {};
      applyEditorReplace(data.fullText || "", data.start || 0, data.length || 0);
    });
    listen("editor:open_find", function() {
      openEditorFind("");
    });
    listen("editor:set_find_term", function(event) {
      const data = event && event.payload || {};
      setEditorFindTerm(data.term || "");
    });
    listen("app:set_mode", function(event) {
      const data = event && event.payload;
      const mode = data && data.mode || "view";
      document.body.classList.toggle("edit-mode", mode === "edit");
      document.body.classList.toggle("split-mode", mode === "split");
      setActiveMode(mode);
      if (mode === "edit") focusEditor();
      syncCheatsheetMenu();
      invoke5("menu_set_enabled", { id: "edit.undo", enabled: mode === "edit" }).catch(function() {
      });
      invoke5("menu_set_enabled", { id: "edit.redo", enabled: mode === "edit" }).catch(function() {
      });
      afterModeSwitch();
    });
    listen("app:set_theme", function(event) {
      const data = event && event.payload;
      let mode = data && data.mode || "light";
      const html = document.documentElement;
      if (mode === "toggle") {
        mode = html.classList.contains("theme-dark") ? "light" : "dark";
      }
      html.classList.toggle("theme-dark", mode === "dark");
      html.classList.toggle("theme-light", mode === "light");
      setEditorTheme(mode);
      invoke5("menu_set_checked", { id: "view.theme.light", checked: mode === "light" }).catch(function() {
      });
      invoke5("menu_set_checked", { id: "view.theme.dark", checked: mode === "dark" }).catch(function() {
      });
    });
  }

  // app/main.ts
  (function() {
    var post5 = function(msg) {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit("shell:event", msg);
      }
    };
    initMarkdownView();
    var contentEl2 = document.getElementById("view-region");
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === "function") {
      window.__TAURI__.event.listen("shell:command", function(event) {
        var data = event && event.payload;
        if (!data || typeof data !== "object") return;
        if (data.type === "insertVaultChildren") {
          insertVaultChildren(data.path || "", data.html || "");
        }
      });
      window.__TAURI__.event.listen("navigation:changed", function(event) {
        var data = event && event.payload;
        if (!data || typeof data !== "object") return;
        var anchor = data.anchor || data.slug || "";
        setTocActive(anchor);
        if (data.view_mode) {
          window.__TAURI__.core.invoke("set_view_mode", { mode: data.view_mode }).catch(function() {
          });
        }
        var viewScroll = typeof data.scroll_y === "number" ? data.scroll_y : 0;
        var editorCursor = typeof data.editor_cursor === "number" ? data.editor_cursor : 0;
        var editorScroll = typeof data.editor_scroll_y === "number" ? data.editor_scroll_y : 0;
        requestAnimationFrame(function() {
          if (anchor) scrollViewToAnchor(anchor);
          else scrollViewTo(viewScroll);
          if (!window.FolioEditor) return;
          if (typeof window.FolioEditor.setSelection === "function") {
            window.FolioEditor.setSelection(editorCursor, 0);
          }
          if (typeof window.FolioEditor.setScroll === "function") {
            window.FolioEditor.setScroll(editorScroll);
          }
        });
      });
      window.__TAURI__.event.listen("panel:rail_changed", function(event) {
        var data = event && event.payload;
        if (!data) return;
        if (typeof data.leftRailVisible === "boolean") {
          setRailVisibility("left", data.leftRailVisible);
        }
        if (typeof data.rightRailVisible === "boolean") {
          setRailVisibility("right", data.rightRailVisible);
        }
      });
      window.__TAURI__.event.listen("navigation:toc_click", function(event) {
        var data = event && event.payload;
        var anchor = data && (data.anchor || data.slug);
        if (anchor) scrollViewToAnchor(anchor);
        setTocActive(anchor || "");
      });
    }
    initEditorShell({ getCleanText, requestSaveIfDirty });
    initFindBar({ ensureEditorMounted });
    initRails();
    initVaultTree({
      openDocument: function(path) {
        if (typeof window.openDocument === "function") {
          window.openDocument(path);
        } else {
          if (window.__TAURI__ && window.__TAURI__.event) {
            window.__TAURI__.event.emit("shell:event", { type: "open", path });
          }
        }
      }
    });
    initCheatsheet();
  })();
  (function() {
    if (!window.__TAURI__) return;
    var invoke6 = window.__TAURI__.core && window.__TAURI__.core.invoke;
    window.__folioInvoke = invoke6;
    var emit = window.__TAURI__.event && window.__TAURI__.event.emit;
    var listen = window.__TAURI__.event && window.__TAURI__.event.listen;
    if (!invoke6 || !emit || !listen) return;
    function $5(id) {
      return document.getElementById(id);
    }
    function bind(id, fn) {
      var el = $5(id);
      if (el) el.addEventListener("click", fn);
    }
    window.openDocument = openDocument;
    function setRailButton(side, visible) {
      var btn2 = $5(side === "left" ? "tb-rail-left" : "tb-rail-right");
      if (btn2) btn2.classList.toggle("active", !!visible);
    }
    function applyRailVisibility(side, visible) {
      setRailVisibility(side, !!visible);
      setRailButton(side, visible);
    }
    function applyShellState(state) {
      if (!state || typeof state !== "object") return;
      var mode = state.viewMode || state.view_mode || "view";
      document.body.classList.toggle("edit-mode", mode === "edit");
      document.body.classList.toggle("split-mode", mode === "split");
      setActiveMode(mode);
      if (mode === "edit") layoutEditor();
      var theme = state.theme || "light";
      document.documentElement.classList.toggle("theme-dark", theme === "dark");
      document.documentElement.classList.toggle("theme-light", theme === "light");
      setEditorTheme(theme);
      if (typeof state.leftRailVisible === "boolean") applyRailVisibility("left", state.leftRailVisible);
      if (typeof state.rightRailVisible === "boolean") applyRailVisibility("right", state.rightRailVisible);
      var editor = state.editor || {};
      if (typeof editor.leftRailWidth === "number") setVaultWidth(editor.leftRailWidth);
      if (typeof editor.rightRailWidth === "number") setTocWidth(editor.rightRailWidth);
    }
    bind("tb-mode-view", function() {
      setMode("view");
    });
    bind("tb-mode-edit", function() {
      setMode("edit");
    });
    bind("tb-save", function() {
      if (getIsDirty()) saveCurrent();
    });
    initExportDialog({
      getCurrentPath,
      syncEditorTextToStore,
      showStatus
    });
    bind("tb-rail-left", function() {
      var btn2 = $5("tb-rail-left");
      var on = !btn2.classList.contains("active");
      btn2.classList.toggle("active", on);
      invoke6("set_rail_visible", { side: "left", visible: on }).catch(function() {
      });
    });
    bind("tb-rail-right", function() {
      var btn2 = $5("tb-rail-right");
      var on = !btn2.classList.contains("active");
      btn2.classList.toggle("active", on);
      invoke6("set_rail_visible", { side: "right", visible: on }).catch(function() {
      });
    });
    bind("tb-find", function() {
      invoke6("open_find").catch(function() {
      });
    });
    bind("tb-back", function() {
      requestSaveIfDirty().then(function(ok) {
        if (ok) invoke6("go_back_and_emit").catch(function() {
        });
      });
    });
    bind("tb-forward", function() {
      requestSaveIfDirty().then(function(ok) {
        if (ok) invoke6("go_forward_and_emit").catch(function() {
        });
      });
    });
    function applyCmd(name) {
      if (!window.FolioEditor || typeof window.FolioEditor.getText !== "function") return;
      var text = window.FolioEditor.getText();
      var sel = window.FolioEditor.getSelection() || { start: 0, length: 0 };
      invoke6("apply_editor_command", {
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
      var ov = $5("cheatsheet-overlay");
      if (!ov) return;
      if (ov.hidden) {
        showCheatSheet(JSON.stringify(cheatSheetRows.map(function(r) {
          return { label: r[0], code: r[1] };
        })));
      } else {
        hideCheatSheet();
      }
    });
    bind("status-theme-toggle", function() {
      invoke6("theme_set", { mode: "toggle" }).catch(function() {
      });
    });
    initZoom();
    document.addEventListener("keydown", function(e) {
      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "1") {
        e.preventDefault();
        $5("tb-mode-view").click();
      } else if (ctrl && e.key === "2") {
        e.preventDefault();
        $5("tb-mode-edit").click();
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        requestSaveIfDirty().then(function(ok) {
          if (ok) invoke6("go_back_and_emit").catch(function() {
          });
        });
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        requestSaveIfDirty().then(function(ok) {
          if (ok) invoke6("go_forward_and_emit").catch(function() {
          });
        });
      } else if (ctrl && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        saveCurrent();
      }
    });
    invoke6("theme_get").then(function(mode) {
      var html = document.documentElement;
      html.classList.toggle("theme-dark", mode === "dark");
      html.classList.toggle("theme-light", mode === "light");
      if (typeof window.setEditorTheme === "function") window.setEditorTheme(mode);
      invoke6("menu_set_checked", { id: "view.theme.light", checked: mode === "light" }).catch(function() {
      });
      invoke6("menu_set_checked", { id: "view.theme.dark", checked: mode === "dark" }).catch(function() {
      });
    }).catch(function() {
    });
    invoke6("cli_pending_open").then(function(path) {
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
    initContextMenu({
      openDocument,
      refreshVault,
      showStatus
    });
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
    initDocumentState({ setActiveMode });
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
      if (currentPath) markDirty(text !== cleanText);
    });
    listen("automation:open_document", function(event) {
      var data = event && event.payload || {};
      if (data.path) openDocument(data.path);
    });
    window.addEventListener("folio-editor-text-updated", function(e) {
      var text = e.detail || "";
      updateWordCount(text);
      if (getCurrentPath()) markDirty(text !== getCleanText());
      invoke6("editor_text_changed", { text }).catch(function() {
      });
    });
    initLanguagePicker();
    (function() {
      var ev = window.__TAURI__ && window.__TAURI__.event;
      if (!ev || typeof ev.listen !== "function") return;
      ev.listen("menu:file_open", function() {
        invoke6("pick_file").then(function(path) {
          if (path && typeof window.openDocument === "function") {
            window.openDocument(path);
          }
        }).catch(function() {
        });
      });
      ev.listen("menu:file_save", function() {
        if (getIsDirty()) saveCurrent();
      });
      ev.listen("menu:file_recent", function(event) {
        var p = event && event.payload && event.payload.path;
        if (p && typeof window.openDocument === "function") {
          window.openDocument(p);
        }
      });
      ev.listen("menu:file_close", function() {
        if (!getCurrentPath()) return;
        requestSaveIfDirty().then(function(ok) {
          if (!ok) return;
          invoke6("close_document").catch(function() {
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
        openEditorFind("");
      });
      ev.listen("menu:help_cheatsheet", function() {
        var b = $5("tb-cheatsheet");
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
        invoke6("theme_set", { mode: "light" }).catch(function() {
        });
      });
      ev.listen("menu:view_theme_dark", function() {
        invoke6("theme_set", { mode: "dark" }).catch(function() {
        });
      });
      ev.listen("menu:view_rail_left", function() {
        var visible = !document.body.classList.contains("vault-hidden");
        applyRailVisibility("left", !visible);
        invoke6("set_rail_visible", { side: "left", visible: !visible }).catch(function() {
        });
      });
      ev.listen("menu:view_rail_right", function() {
        var visible = !document.body.classList.contains("toc-hidden");
        applyRailVisibility("right", !visible);
        invoke6("set_rail_visible", { side: "right", visible: !visible }).catch(function() {
        });
      });
      ev.listen("menu:about", function(event) {
        var v = event && event.payload && event.payload.version || "?";
        alert("folio v" + v);
      });
    })();
  })();
})();
