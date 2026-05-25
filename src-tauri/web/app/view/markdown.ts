/* View-Mode-Markdown-Rendering: TOC-Setter, Anker-Scroll, Asset-Rewrite,
   sichtbare-Heading-Tracking + ViewFinder (DOM-Sucher via CSS Custom
   Highlight API). Der ViewFinder ist die View-Mode-Variante des
   Find-Backends; sein API spiegelt window.FolioEditor (openFind/
   closeFind/setFindTerm/setFindOptions/findNext/findPrev), damit die
   gemeinsame Find-Bar in ui/find-bar.ts denselben Adapter nutzen kann. */

let contentEl: HTMLElement = null;
let tocEl: HTMLElement = null;
let requestSaveIfDirtyDep: () => Promise<boolean> = null;

function post(msg: any): void {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('shell:event', msg);
    }
}

// ----- TOC-API (vom document:loaded und navigation:changed gerufen) -----

export function setTocActive(slug: string): void {
    if (!tocEl) return;
    const prev = tocEl.querySelectorAll('li.entry.active');
    for (let i = 0; i < prev.length; i++) prev[i].classList.remove('active');
    if (!slug) return;
    const target = tocEl.querySelector('li.entry[data-slug="' + slug + '"]') as HTMLElement;
    if (target) {
        target.classList.add('active');
        target.scrollIntoView({ block: 'nearest' });
    }
}

export function setTocList(html: string): void {
    if (!tocEl) return;
    const ul = tocEl.querySelector('ul.toc');
    if (ul) ul.innerHTML = html || '';
}

// ----- Anker-Scroll innerhalb der View-Region -----
// location.hash auf einem persistierten Shell-Dokument scrollt sonst die
// Shell selbst (die nicht scrollt) — wir uebersetzen explizit auf
// contentEl.scrollIntoView, damit Anker funktionieren.
export function scrollViewToAnchor(slug: string): void {
    if (!slug || !contentEl) return;
    const target = contentEl.querySelector('#' + CSS.escape(slug));
    if (target) target.scrollIntoView({ block: 'start' });
}

export function scrollViewTo(y: number): void {
    if (!contentEl) return;
    contentEl.scrollTo(0, y || 0);
}

// ----- Relative Asset-Pfade (in img-src) auf asset://-URLs umschreiben.
//       Wird nach jedem MD-Render aufgerufen (document:loaded). -----
export function rewriteRelativeAssets(rootEl: HTMLElement, documentPath: string): void {
    if (!rootEl || !documentPath) return;
    const convert = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.convertFileSrc;
    if (typeof convert !== 'function') return;
    const dir = documentPath.replace(/[\\/][^\\/]*$/, '');
    const imgs = rootEl.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
        const src = imgs[i].getAttribute('src');
        if (!src) continue;
        // Skip absolute URLs (http, https, data:, asset:, blob:, etc.)
        if (/^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
        if (src.indexOf('//') === 0) continue;
        let abs: string;
        if (/^[a-zA-Z]:[\\/]/.test(src) || src.charAt(0) === '/') {
            abs = src;
        } else {
            abs = dir + '/' + src;
        }
        // Normalisiere Backslashes (Windows)
        abs = abs.replace(/\\/g, '/');
        try { (imgs[i] as HTMLImageElement).src = convert(abs); } catch (_) { /* ignore */ }
    }
}

// ----- ViewFinder: DOM-Sucher fuer den View-Modus -----
// Co-operative chunking: pro Tick max so viele Treffer/Wraps verarbeiten,
// dann mit setTimeout(0) zurueck an den Browser. Haelt Tasten- und
// Scroll-Events responsive auch waehrend ein Suchlauf laeuft.
const CHUNK_SIZE = 500;
// CSS Custom Highlight API: keine DOM-Wraps, kein Reflow pro Treffer,
// Clear ist O(1).
const hasHighlightAPI = (typeof CSS !== 'undefined') && (CSS as any).highlights
    && (typeof (window as any).Highlight !== 'undefined');
let matchHL: any = null;
let activeHL: any = null;
let rangesArr: Range[] = [];
let activeIdx = -1;
let currentTerm = '';
let findOpts = { caseSensitive: false, wholeWord: false };
// Bei jeder neuen research() inkrementiert. Async-Chunks brechen ab,
// sobald myToken !== searchToken — die alte Suche wird so verworfen,
// statt die neue zu blockieren.
let searchToken = 0;

function ensureHighlights(): void {
    if (!hasHighlightAPI) return;
    if (!matchHL) { matchHL = new (window as any).Highlight(); (CSS as any).highlights.set('folio-find', matchHL); }
    if (!activeHL) { activeHL = new (window as any).Highlight(); (CSS as any).highlights.set('folio-find-active', activeHL); }
}

function getRoot(): Element | null { return document.querySelector('#view-region main.markdown-body'); }
function getContent(): HTMLElement | null { return document.getElementById('view-content'); }
function getLane(): HTMLElement | null { return document.getElementById('view-marker-lane'); }

function clearLane(): void {
    const lane = getLane();
    if (!lane) return;
    while (lane.firstChild) lane.removeChild(lane.firstChild);
}

function updateMarkers(): void {
    const lane = getLane();
    const content = getContent();
    if (!lane) return;
    clearLane();
    if (!content || rangesArr.length === 0) return;
    const totalH = content.scrollHeight;
    if (totalH <= 0) return;
    // Read-Phase: alle Range-Top-Positionen lesen, ohne DOM-Mutation
    // dazwischen. Trennt Reads von Writes (1 Layout-Reflow statt N).
    const contentTop = content.getBoundingClientRect().top;
    const scrollTop = content.scrollTop;
    // Bucketing: maximal 1 Marker pro Pixelreihe der Lane.
    const laneH = Math.max(1, lane.clientHeight);
    const seen = new Uint8Array(laneH);
    let activePixel = -1;
    const pixels: number[] = [];
    for (let i = 0; i < rangesArr.length; i++) {
        const rect = rangesArr[i].getBoundingClientRect();
        const pos = scrollTop + (rect.top - contentTop);
        const px = Math.max(0, Math.min(laneH - 1, Math.round((pos / totalH) * laneH)));
        if (i === activeIdx) activePixel = px;
        if (!seen[px]) { seen[px] = 1; pixels.push(px); }
    }
    const frag = document.createDocumentFragment();
    for (let j = 0; j < pixels.length; j++) {
        const p = pixels[j];
        const dot = document.createElement('div');
        dot.className = 'folio-marker' + (p === activePixel ? ' active' : '');
        dot.style.top = ((p / laneH) * 100) + '%';
        frag.appendChild(dot);
    }
    lane.appendChild(frag);
}

function clearMarks(): void {
    // Highlight-API: O(1)-Clear. Kein DOM-Walk, kein normalize, kein Reflow.
    if (matchHL) matchHL.clear();
    if (activeHL) activeHL.clear();
    rangesArr = [];
    activeIdx = -1;
    clearLane();
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildRegex(term: string): RegExp | null {
    if (!term) return null;
    let pattern = escapeRegExp(term);
    if (findOpts.wholeWord) pattern = '\\b' + pattern + '\\b';
    const flags = findOpts.caseSensitive ? 'g' : 'gi';
    try { return new RegExp(pattern, flags); } catch (_) { return null; }
}

function buildWalker(root: Element): TreeWalker {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
            let p = node.parentNode;
            while (p && p !== root) {
                const tn = p.nodeName ? p.nodeName.toLowerCase() : '';
                if (tn === 'script' || tn === 'style') return NodeFilter.FILTER_REJECT;
                p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    } as NodeFilter);
}

function collectRangesAsync(root: Element, regex: RegExp, myToken: number, done: () => void): void {
    const walker = buildWalker(root);
    function step(): void {
        if (myToken !== searchToken) return;
        const batchStart = rangesArr.length;
        let node: Node;
        while ((node = walker.nextNode())) {
            const text = node.nodeValue || '';
            if (!text) continue;
            regex.lastIndex = 0;
            let m: RegExpExecArray;
            while ((m = regex.exec(text))) {
                if (m[0].length === 0) { regex.lastIndex++; continue; }
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

function dispatchState(): void {
    const detail = { term: currentTerm, total: rangesArr.length, active: activeIdx };
    try {
        window.dispatchEvent(new CustomEvent('folio-find-state', { detail }));
    } catch (_) { /* ignore */ }
    // Tauri-Backend hoert auf editorFindState und persistiert den Term ueber
    // Datei-Wechsel; analog zur Monaco-Pipeline in editor.ts.
    try {
        post({ type: 'editorFindState', term: detail.term, total: detail.total, active: detail.active });
    } catch (_) { /* ignore */ }
}

function dispatchProgress(partialTotal: number): void {
    try {
        window.dispatchEvent(new CustomEvent('folio-find-state', {
            detail: { term: currentTerm, total: partialTotal, active: -1, scanning: true }
        }));
    } catch (_) { /* ignore */ }
}

function setActive(idx: number): void {
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
    const r = rangesArr[activeIdx];
    const anchor: any = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    if (anchor) {
        try { anchor.scrollIntoView({ block: 'center', inline: 'nearest' }); }
        catch (_) { try { anchor.scrollIntoView(true); } catch (__) { /* ignore */ } }
    }
    updateMarkers();
    dispatchState();
}

function research(): void {
    clearMarks();
    const myToken = ++searchToken;
    if (!currentTerm) { dispatchState(); return; }
    const root = getRoot(); if (!root) { dispatchState(); return; }
    const regex = buildRegex(currentTerm); if (!regex) { dispatchState(); return; }
    ensureHighlights();
    collectRangesAsync(root, regex, myToken, function () {
        if (myToken !== searchToken) return;
        if (rangesArr.length > 0) setActive(0);
        else { updateMarkers(); dispatchState(); }
    });
}

export const ViewFinder = {
    openFind: function (initial?: string): void {
        if (typeof initial === 'string' && initial.length > 0) currentTerm = initial;
        research();
    },
    closeFind: function (): void {
        // Token-Bump cancelt eventuell noch laufende async Chunks aus einer
        // vorherigen Suche, bevor clearMarks die Treffer abraeumt.
        searchToken++;
        clearMarks();
        currentTerm = '';
        dispatchState();
    },
    setFindTerm: function (term: string): void { currentTerm = term || ''; research(); },
    setFindOptions: function (newOpts: { caseSensitive?: boolean; wholeWord?: boolean }): void {
        newOpts = newOpts || {};
        findOpts.caseSensitive = !!newOpts.caseSensitive;
        findOpts.wholeWord = !!newOpts.wholeWord;
        research();
    },
    findNext: function (): void { if (rangesArr.length > 0) setActive((activeIdx + 1) % rangesArr.length); },
    findPrev: function (): void { if (rangesArr.length > 0) setActive((activeIdx - 1 + rangesArr.length) % rangesArr.length); },
};

// ----- Sichtbare Ueberschrift + Scroll-Position-Watcher -----
function initVisibleHeadingTracker(): void {
    let currentHeading: string | null = null;
    let lastScrollY = -1;
    function collectHeadings(): HTMLElement[] {
        return Array.prototype.slice.call(
            contentEl.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
        );
    }
    function sendHeading(id: string | null): void {
        if (id === currentHeading) return;
        currentHeading = id;
        post({ type: 'visibleHeading', id: id || '' });
    }
    function sendScroll(y: number): void {
        if (y === lastScrollY) return;
        lastScrollY = y;
        post({ type: 'scrollPosition', y });
    }
    function update(): void {
        const hs = collectHeadings();
        if (hs.length === 0) { sendHeading(null); }
        else {
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
    function schedule(): void {
        if (rafQueued) return;
        rafQueued = true;
        requestAnimationFrame(function () { rafQueued = false; update(); });
    }
    contentEl.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('load', update);
}

export function initMarkdownView(deps?: { requestSaveIfDirty?: () => Promise<boolean> }): void {
    contentEl = (document.getElementById('view-content')
        || document.getElementById('view-region')) as HTMLElement | null;
    tocEl = document.getElementById('toc-region');
    if (!contentEl || !tocEl) return;
    requestSaveIfDirtyDep = (deps && deps.requestSaveIfDirty) || null;

    // Link-Klicks (im Content) — Tauri-Backend behandelt das Routing.
    // Dirty-Prompt vor dem Post: im Split/Edit-Mode mit ungespeicherten
    // Edits wuerde der Backend-Load-Pfad in events::navigation::link_click
    // sonst die offenen Aenderungen ueberschreiben (analog openDocument).
    contentEl.addEventListener('click', function (e: MouseEvent) {
        let el = e.target as HTMLElement;
        while (el && el.tagName !== 'A') el = el.parentElement;
        if (!el) return;
        const href = el.getAttribute('href');
        if (href === null) return;
        e.preventDefault();
        const send = function () { post({ type: 'linkClick', href }); };
        if (requestSaveIfDirtyDep) {
            requestSaveIfDirtyDep().then(function (ok) { if (ok) send(); });
        } else {
            send();
        }
    }, true);

    // TOC-Click → Backend-Event (navigation:toc_click → setTocActive).
    tocEl.addEventListener('click', function (e: MouseEvent) {
        let el = e.target as HTMLElement;
        while (el && !(el.classList && el.classList.contains('entry'))) el = el.parentElement;
        if (!el) return;
        const slug = el.getAttribute('data-slug');
        if (slug) post({ type: 'tocClick', slug });
    });

    initVisibleHeadingTracker();
}
