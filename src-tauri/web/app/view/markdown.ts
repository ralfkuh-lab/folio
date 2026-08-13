/* View-Mode-Markdown-Rendering: TOC-Setter, Anker-Scroll, Asset-Rewrite,
   sichtbare-Heading-Tracking + ViewFinder (DOM-Sucher via CSS Custom
   Highlight API). Der ViewFinder ist die View-Mode-Variante des
   Find-Backends; sein API spiegelt window.FolioEditor (openFind/
   closeFind/setFindTerm/setFindOptions/findNext/findPrev), damit die
   gemeinsame Find-Bar in ui/find-bar.ts denselben Adapter nutzen kann. */

import { handleFolioNewClick, isFolioNewHref } from './wikilink-create';
import { toggleTaskInDocument } from './task-toggle';

let contentEl: HTMLElement = null;
let tocEl: HTMLElement = null;
let requestSaveIfDirtyDep: () => Promise<boolean> = null;

function post(msg: any): void {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('shell:event', msg);
    }
}

function linkFromEventTarget(target: EventTarget | null): HTMLAnchorElement | null {
    let el = target as HTMLElement | null;
    while (el && el.tagName !== 'A') el = el.parentElement;
    return el as HTMLAnchorElement | null;
}

function postLinkClick(href: string, newTab: boolean): void {
    post({ type: 'linkClick', href, newTab });
}

/** Gemeinsamer Einstieg: folio-new: bleibt im Frontend, sonst Backend. */
function routeLinkClick(href: string, newTab: boolean): void {
    if (isFolioNewHref(href)) {
        void handleFolioNewClick(href);
        return;
    }
    postLinkClick(href, newTab);
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
let suppressActive = false;

// Marker-Lane Cache (Befund 2): Positionen (als Fraction 0..1) einmal
// pro Term/Doc/Layout berechnen; Navigation (setActive) verwendet Cache
// und ruft kein getBoundingClientRect. Bei >500 Matches: rAF-Batching
// der Erstberechnung (Lane bleibt leer waehrend Aufbau).
let markerFractions: number[] = [];
let markerCacheValid = false;

// Resize handling via ResizeObserver on #view-content + inner content
// (covers split-drag, TOC toggle affecting container size, image/font load
// growing scrollHeight). No shared global flag with html.ts. Teardown on close.
let markerResizeObserver: ResizeObserver | null = null;
let markerResizeDebounceTimer: number | null = null;

function ensureHighlights(): void {
    if (!hasHighlightAPI) return;
    if (!matchHL) { matchHL = new (window as any).Highlight(); (CSS as any).highlights.set('folio-find', matchHL); }
    if (!activeHL) { activeHL = new (window as any).Highlight(); activeHL.priority = 1; (CSS as any).highlights.set('folio-find-active', activeHL); }
}

function getRoot(): Element | null { return document.querySelector('#view-region main.markdown-body'); }
function getContent(): HTMLElement | null { return document.getElementById('view-content'); }
function getLane(): HTMLElement | null { return document.getElementById('view-marker-lane'); }

function clearLane(): void {
    const lane = getLane();
    if (!lane) return;
    while (lane.firstChild) lane.removeChild(lane.firstChild);
}

function invalidateMarkerCache(): void {
    markerCacheValid = false;
    markerFractions = [];
}

function scheduleMarkerRecompute(): void {
    if (markerResizeDebounceTimer) window.clearTimeout(markerResizeDebounceTimer);
    markerResizeDebounceTimer = window.setTimeout(function () {
        markerResizeDebounceTimer = null;
        if (currentTerm && rangesArr.length > 0) {
            computeMarkerPositionsSync();
            updateMarkers();
        } else {
            invalidateMarkerCache();
        }
    }, 120);
}

function teardownMarkerResizeObserver(): void {
    if (markerResizeObserver) {
        markerResizeObserver.disconnect();
        markerResizeObserver = null;
    }
    if (markerResizeDebounceTimer) {
        window.clearTimeout(markerResizeDebounceTimer);
        markerResizeDebounceTimer = null;
    }
}

function setupMarkerResizeObserver(): void {
    teardownMarkerResizeObserver();
    const container = getContent();
    if (!container) return;

    markerResizeObserver = new ResizeObserver(() => scheduleMarkerRecompute());
    markerResizeObserver.observe(container);

    // Also observe inner content element so scrollHeight growth (images, fonts, TOC changes etc.)
    // triggers recompute even without container box size change.
    const inner = getRoot();
    if (inner) {
        try { markerResizeObserver.observe(inner); } catch (_) { /* detached or cross */ }
    }
}

function computeMarkerPositionsSync(): void {
    const lane = getLane();
    const content = getContent();
    markerFractions = [];
    if (!lane || !content || rangesArr.length === 0) {
        markerCacheValid = true;
        return;
    }
    const totalH = content.scrollHeight;
    if (totalH <= 0) {
        markerCacheValid = true;
        return;
    }
    const contentTop = content.getBoundingClientRect().top;
    const scrollTop = content.scrollTop;
    for (let i = 0; i < rangesArr.length; i++) {
        const rect = rangesArr[i].getBoundingClientRect();
        const pos = scrollTop + (rect.top - contentTop);
        const frac = totalH > 0 ? (pos / totalH) : 0;
        markerFractions.push(frac);
    }
    markerCacheValid = true;
}

function computeMarkerPositionsAsync(onDone?: () => void): void {
    const lane = getLane();
    const content = getContent();
    markerFractions = [];
    if (!lane || !content || rangesArr.length === 0) {
        markerCacheValid = true;
        if (onDone) onDone();
        return;
    }
    const totalH = content.scrollHeight;
    if (totalH <= 0) {
        markerCacheValid = true;
        if (onDone) onDone();
        return;
    }
    const contentTop = content.getBoundingClientRect().top;
    const scrollTop = content.scrollTop;
    const BATCH = 500;
    let i = 0;
    const myTokenAtStart = searchToken;
    function step(): void {
        if (myTokenAtStart !== searchToken) return; // term changed, abort
        const end = Math.min(i + BATCH, rangesArr.length);
        for (; i < end; i++) {
            const rect = rangesArr[i].getBoundingClientRect();
            const pos = scrollTop + (rect.top - contentTop);
            const frac = totalH > 0 ? (pos / totalH) : 0;
            markerFractions.push(frac);
        }
        if (i < rangesArr.length) {
            requestAnimationFrame(step);
        } else {
            markerCacheValid = true;
            if (onDone) onDone();
        }
    }
    // During async build: lane stays empty (no intermediate dots).
    requestAnimationFrame(step);
}

function updateMarkers(): void {
    const lane = getLane();
    const content = getContent();
    if (!lane) return;
    clearLane();
    if (!content || rangesArr.length === 0) return;
    if (!markerCacheValid || markerFractions.length !== rangesArr.length) {
        // Fallback (should not normally hit after research): compute sync
        computeMarkerPositionsSync();
    }
    if (!markerCacheValid || markerFractions.length === 0) return;
    const totalH = content.scrollHeight; // may have changed; frac is relative
    if (totalH <= 0) return;
    const laneH = Math.max(1, lane.clientHeight);
    const seen = new Uint8Array(laneH);
    const pixels: number[] = [];
    let activePixel = -1;
    for (let i = 0; i < rangesArr.length; i++) {
        const f = markerFractions[i] || 0;
        const p = Math.max(0, Math.min(laneH - 1, Math.round(f * laneH)));
        if (i === activeIdx) activePixel = p;
        if (!seen[p]) { seen[p] = 1; pixels.push(p); }
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
    invalidateMarkerCache();
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
    let resumeNode: Node | null = null;
    let resumeLastIndex = 0;
    function scanNode(node: Node, batchStart: number): boolean {
        const text = node.nodeValue || '';
        if (!text) {
            resumeNode = null;
            resumeLastIndex = 0;
            return false;
        }
        regex.lastIndex = resumeNode === node ? resumeLastIndex : 0;
        let m: RegExpExecArray;
        while ((m = regex.exec(text))) {
            if (m[0].length === 0) { regex.lastIndex++; continue; }
            const r = document.createRange();
            r.setStart(node, m.index);
            r.setEnd(node, m.index + m[0].length);
            rangesArr.push(r);
            if (matchHL) matchHL.add(r);
            if (rangesArr.length - batchStart >= CHUNK_SIZE) {
                resumeNode = node;
                resumeLastIndex = regex.lastIndex;
                dispatchProgress(rangesArr.length);
                setTimeout(step, 0);
                return true;
            }
        }
        resumeNode = null;
        resumeLastIndex = 0;
        return false;
    }
    function step(): void {
        if (myToken !== searchToken) return;
        const batchStart = rangesArr.length;
        if (resumeNode && scanNode(resumeNode, batchStart)) return;
        let node: Node;
        while ((node = walker.nextNode())) {
            if (scanNode(node, batchStart)) return;
        }
        done();
    }
    step();
}

function dispatchState(): void {
    const detail = { source: 'view' as const, term: currentTerm, total: rangesArr.length, active: activeIdx };
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
            detail: { source: 'view', term: currentTerm, total: partialTotal, active: -1, scanning: true }
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
    if (suppressActive) {
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
    setupMarkerResizeObserver();
    const myToken = ++searchToken;
    if (!currentTerm) { dispatchState(); return; }
    const root = getRoot(); if (!root) { dispatchState(); return; }
    const regex = buildRegex(currentTerm); if (!regex) { dispatchState(); return; }
    ensureHighlights();
    collectRangesAsync(root, regex, myToken, function () {
        if (myToken !== searchToken) return;
        if (rangesArr.length > 0) {
            if (rangesArr.length > 500) {
                computeMarkerPositionsAsync(function () { setActive(0); });
                // lane remains empty until async done + setActive
            } else {
                computeMarkerPositionsSync();
                setActive(0);
            }
        } else {
            updateMarkers();
            dispatchState();
        }
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
        teardownMarkerResizeObserver();
        clearMarks();
        currentTerm = '';
        // Nicht nur der Split-Wrapper (find-bar.ts) ruft closeFind —
        // close()/afterModeSwitch() treffen den Finder direkt. Ohne Reset
        // bliebe ein im Split-Mode gesetztes suppressActive haengen und
        // jede spaetere View-Suche haette keinen aktiven Treffer mehr.
        suppressActive = false;
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
    setSuppressActive: function (on: boolean): void { suppressActive = on; },
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

/**
 * Ermittelt den reinen Textinhalt eines Task-List-Items fuer ein zugaengliches
 * `aria-label`, ohne verschachtelte Unterlisten (`<ul>`/`<ol>`) oder das Input-Element selbst.
 */
export function getTaskItemLabel(li: HTMLElement): string {
    let text = '';
    for (let i = 0; i < li.childNodes.length; i++) {
        const node = li.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent || '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            if (el.tagName !== 'UL' && el.tagName !== 'OL' && el.tagName !== 'INPUT') {
                text += el.textContent || '';
            }
        }
    }
    return text.trim();
}

/**
 * Bereitet die gerenderte Markdown-View nach dem Einsetzen in das DOM vor:
 * 1. Speichert Monacos aktuelle VersionId am Content-Container fuer den Stale-Guard (Fix 1).
 * 2. Aktiviert Tasklist-Checkboxen (entfernt backendseitiges `disabled="disabled"` und
 *    setzt `aria-label` fuer Screenreader) (Fix 2 & Fix 5b).
 */
export function prepareMarkdownView(container: HTMLElement): void {
    if (!container) return;

    // 1. VersionId am Content-Container ablegen (betrifft document:loaded und live-preview)
    const content = (document.getElementById('view-content')
        || document.getElementById('view-region')
        || container) as HTMLElement | null;
    const versionId = window.FolioEditor && typeof window.FolioEditor.getVersionId === 'function'
        ? window.FolioEditor.getVersionId()
        : null;
    if (content) {
        if (typeof versionId === 'number') {
            content.setAttribute('data-render-version', String(versionId));
        } else {
            content.removeAttribute('data-render-version');
        }
    }

    // 2. Tasklist-Checkboxen aktivieren: disabled entfernen + aria-label setzen
    const items = container.querySelectorAll<HTMLLIElement>('li.task-list-item');
    for (let i = 0; i < items.length; i++) {
        const li = items[i];
        const input = li.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]')
            || li.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (input) {
            input.removeAttribute('disabled');
            const label = getTaskItemLabel(li);
            if (label) {
                input.setAttribute('aria-label', label);
            }
        }
    }
}

/**
 * Behandelt Klicks auf Tasklist-Checkboxen in der gerenderten Markdown-View
 * (View-Mode und Split-Mode/Live-Preview).
 *
 * Vorgaben & Fixes:
 * 1. Der Toggle laeuft IMMER ueber das Monaco-Model via `applyReplace`
 * 2. Nur die Checkbox ist Klickziel, nicht die ganze Zeile
 * 3. Fix 2: Backend rendert `disabled="disabled"`, App-View aktiviert clientseitig
 * 4. Fix 1: Stale-Guard Stufe 1 verifiziert Monaco `versionId` gegen `data-render-version`
 * 5. Fix 4: `closest` auf `li.task-list-item[data-line]` eingeengt
 * 6. Fix 5a: Zentraler Revert fuer alle Abbruchpfade
 * 7. Fix 6: `noReveal: true` verhindert Spruenge im Split-Editor
 */
function handleCheckboxClick(e: MouseEvent): boolean {
    const target = e.target as HTMLElement | null;
    if (!target || target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'checkbox') {
        return false;
    }

    const input = target as HTMLInputElement;
    // Bei nativem Click-Event hat die Checkbox ihren Zustand bereits optimistisch
    // getogglet (input.checked ist der NEUE Zustand). Der erwartete Vor-Klick-Zustand war !input.checked.
    const expectedChecked = !input.checked;

    // Fix 5a: Zentraler Revert fuer jeden Abbruchpfad
    const revert = (): boolean => {
        input.checked = expectedChecked;
        return true;
    };

    // Vorgabe 5: Nur fuer Markdown-Dokumente aktiv
    if (!document.body.classList.contains('kind-markdown')) {
        return revert();
    }

    // Fix 4: data-line strikt an `li.task-list-item[data-line]` ermitteln (nicht an ul/Parents aufsteigen)
    const lineEl = input.closest('li.task-list-item[data-line]');
    if (!lineEl) {
        return revert();
    }
    const lineAttr = lineEl.getAttribute('data-line');
    const lineNumber = lineAttr ? parseInt(lineAttr, 10) : NaN;
    if (!lineNumber || isNaN(lineNumber) || lineNumber < 1) {
        return revert();
    }

    // Editor-Bridge pruefen
    if (!window.FolioEditor
        || typeof window.FolioEditor.getText !== 'function'
        || typeof window.FolioEditor.applyReplace !== 'function'
        || typeof window.FolioEditor.getVersionId !== 'function') {
        return revert();
    }

    // Fix 1 (Stale-Guard Stufe 1): Monaco versionId gegen Render-Stand validieren.
    // Weicht die aktuelle VersionId von der beim Render gespeicherten ab (oder ist keine
    // VersionId vorhanden), ist das DOM stale.
    const content = (document.getElementById('view-content')
        || document.getElementById('view-region')) as HTMLElement | null;
    const renderVersionAttr = content ? content.getAttribute('data-render-version') : null;
    const renderVersion = renderVersionAttr !== null ? parseInt(renderVersionAttr, 10) : NaN;
    const currentVersion = window.FolioEditor.getVersionId();

    if (typeof currentVersion !== 'number' || isNaN(renderVersion) || currentVersion !== renderVersion) {
        return revert();
    }

    const fullText = window.FolioEditor.getText();
    if (typeof fullText !== 'string') {
        return revert();
    }

    // Stale-Guard Stufe 2: Zeileninhalt an lineNumber gegen erwarteten Zustand pruefen
    const result = toggleTaskInDocument(fullText, lineNumber, expectedChecked);
    if (!result) {
        return revert();
    }

    // Vorgabe 1 & Fix 6: Immer ueber applyReplace auf dem Monaco-Model schreiben.
    // Cursor/Selektion beibehalten und automatisches Scroll-Reveal im Editor unterdruecken.
    const sel = (typeof window.FolioEditor.getSelection === 'function' ? window.FolioEditor.getSelection() : null) || { start: 0, length: 0 };
    window.FolioEditor.applyReplace({
        fullText: result.fullText,
        selectionStart: sel.start || 0,
        selectionLength: sel.length || 0,
        noReveal: true,
    });

    return true;
}

export function initMarkdownView(deps?: { requestSaveIfDirty?: () => Promise<boolean> }): void {
    contentEl = (document.getElementById('view-content')
        || document.getElementById('view-region')) as HTMLElement | null;
    tocEl = document.getElementById('toc-region');
    if (!contentEl || !tocEl) return;
    requestSaveIfDirtyDep = (deps && deps.requestSaveIfDirty) || null;

    // Klicks (im Content) — gemeinsamer Handler fuer View + Split + Live-Preview:
    // 1. Tasklist-Checkbox-Toggles (auf input[type="checkbox"])
    // 2. Link-Klicks (auf a[href]) — folio-new: wird frontend-seitig abgefangen; sonst Backend-Routing.
    contentEl.addEventListener('click', function (e: MouseEvent) {
        if (handleCheckboxClick(e)) {
            return;
        }

        const el = linkFromEventTarget(e.target);
        if (!el) return;
        const href = el.getAttribute('href');
        if (href === null) return;
        e.preventDefault();
        const newTab = e.ctrlKey || e.metaKey;
        // Missing-Wikilinks: kein Dirty-Prompt, kein newTab — nur Dialog.
        if (isFolioNewHref(href)) {
            routeLinkClick(href, false);
            return;
        }
        const send = function () { routeLinkClick(href, false); };
        if (newTab) {
            routeLinkClick(href, true);
        } else if (requestSaveIfDirtyDep) {
            requestSaveIfDirtyDep().then(function (ok) { if (ok) send(); });
        } else {
            send();
        }
    }, true);

    contentEl.addEventListener('auxclick', function (e: MouseEvent) {
        if (e.button !== 1) return;
        const el = linkFromEventTarget(e.target);
        if (!el) return;
        const href = el.getAttribute('href');
        if (href === null) return;
        e.preventDefault();
        // folio-new: Mittelklick = Dialog (kein newTab); sonst newTab.
        if (isFolioNewHref(href)) {
            routeLinkClick(href, false);
            return;
        }
        routeLinkClick(href, true);
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
