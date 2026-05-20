/* HTML-View fuer .html/.htm-Dateien.
   Rendert in einem Sandbox-iframe, blockiert Scripts und rewritet lokale
   relative Ressourcen auf Tauri-Asset-URLs. */

let currentIframe: HTMLIFrameElement | null = null;
let currentPath = '';
let beforeLinkClick: (() => Promise<boolean>) | null = null;
let messageListener: ((event: MessageEvent) => void) | null = null;
const CHUNK_SIZE = 500;
const BRIDGE_MARKER = 'folio-html-bridge';
let matchHL: any = null;
let activeHL: any = null;
let highlightWindow: any = null;
let rangesArr: Range[] = [];
let activeIdx = -1;
let currentTerm = '';
let findOpts = { caseSensitive: false, wholeWord: false };
let searchToken = 0;

function post(msg: any): void {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('shell:event', msg);
    }
}

function isAbsoluteUrl(value: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.indexOf('//') === 0;
}

function isDangerousUrl(value: string): boolean {
    return /^(javascript|vbscript):/i.test(value.trim());
}

function isRoutableUrl(value: string): boolean {
    const trimmed = value.trim();
    return !!trimmed
        && !trimmed.startsWith('mailto:')
        && !trimmed.startsWith('tel:');
}

function resolveResourceUrl(value: string, documentPath: string): string {
    if (!value || !documentPath) return value;
    const trimmed = value.trim();
    if (!trimmed || trimmed.charAt(0) === '#' || isAbsoluteUrl(trimmed)) return value;

    const convert = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.convertFileSrc;
    if (typeof convert !== 'function') return value;

    const dir = documentPath.replace(/[\\/][^\\/]*$/, '');
    let abs: string;
    if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.charAt(0) === '/') {
        abs = trimmed;
    } else {
        abs = dir + '/' + trimmed;
    }
    abs = abs.replace(/\\/g, '/');
    try { return convert(abs); } catch (_) { return value; }
}

function rewriteSrcset(value: string, documentPath: string): string {
    return value.split(',').map(function (part) {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const pieces = trimmed.split(/\s+/);
        pieces[0] = resolveResourceUrl(pieces[0], documentPath);
        return pieces.join(' ');
    }).join(', ');
}

function sanitizeDocument(doc: Document): void {
    doc.querySelectorAll('script').forEach(function (el) { el.remove(); });
    doc.querySelectorAll('meta[http-equiv]').forEach(function (el) {
        const equiv = (el.getAttribute('http-equiv') || '').toLowerCase();
        if (equiv === 'refresh') el.remove();
    });

    const urlAttrs = ['href', 'src', 'xlink:href', 'action', 'formaction', 'poster'];
    const all = doc.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const attrs = Array.prototype.slice.call(el.attributes) as Attr[];
        for (let j = 0; j < attrs.length; j++) {
            const attr = attrs[j];
            const name = attr.name.toLowerCase();
            if (name.indexOf('on') === 0 || name === 'srcdoc') {
                el.removeAttribute(attr.name);
                continue;
            }
            if (urlAttrs.indexOf(name) >= 0 && isDangerousUrl(attr.value)) {
                el.removeAttribute(attr.name);
            }
        }
    }
}

function protectLinks(doc: Document): void {
    doc.querySelectorAll('a[href]').forEach(function (el) {
        const href = el.getAttribute('href');
        if (!href || !isRoutableUrl(href)) return;
        el.setAttribute('data-folio-href', href);
        el.removeAttribute('href');
        el.removeAttribute('target');
        el.setAttribute('role', 'link');
        el.setAttribute('tabindex', '0');
    });
}

function rewriteResources(doc: Document, documentPath: string): void {
    const resourceSelectors = [
        'img[src]',
        'audio[src]',
        'video[src]',
        'source[src]',
        'track[src]',
        'iframe[src]',
        'link[href]',
    ];
    const nodes = doc.querySelectorAll(resourceSelectors.join(','));
    for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const src = el.getAttribute('src');
        if (src) el.setAttribute('src', resolveResourceUrl(src, documentPath));
        const href = el.getAttribute('href');
        if (href) el.setAttribute('href', resolveResourceUrl(href, documentPath));
    }

    doc.querySelectorAll('[srcset]').forEach(function (el) {
        const srcset = el.getAttribute('srcset');
        if (srcset) el.setAttribute('srcset', rewriteSrcset(srcset, documentPath));
    });
}

function installPreviewDefaults(doc: Document): void {
    const style = doc.createElement('style');
    style.setAttribute('data-folio-html-preview-defaults', '');
    style.textContent = [
        ':root{color-scheme:light;background:#fff;}',
        'body{background:#fff;}',
        '::highlight(folio-find){background:#ffe066;color:inherit;}',
        '::highlight(folio-find-active){background:#ff9f1c;color:inherit;}',
    ].join('');
    const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body || null);
    head.insertBefore(style, head.firstChild);
}

// Injizierter Click-/Shortcut-Bridge-Script. Laeuft im Sandbox-iframe
// ("allow-same-origin allow-scripts"), postMessaget Link-Clicks und
// Find-Shortcuts an den Parent. Grund: externes Attach von
// click/keydown-Handlern auf iframe.contentDocument ist in WebKitGTK
// bei srcdoc-Wechseln unzuverlaessig (Document wird beim Laden
// ersetzt, Listener-Timing race-condition-anfaellig). Eine vom Parent
// kontrollierte, im Dokument selbst lebende Bridge ist robuster und
// genau die in CLAUDE.md/codex-Notizen erwaehnte "kleine injected Bridge".
const BRIDGE_SOURCE = '(' + function () {
    function findLink(target) {
        var el = target;
        while (el && !(el.tagName === 'A' && el.hasAttribute && el.hasAttribute('data-folio-href'))) {
            el = el.parentElement || el.parentNode;
        }
        return el;
    }
    function send(msg) {
        try { window.parent.postMessage(msg, '*'); } catch (_) { /* ignore */ }
    }
    document.addEventListener('click', function (event) {
        var el = findLink(event.target);
        if (!el) return;
        event.preventDefault();
        event.stopPropagation();
        send({ folio: 'linkClick', href: el.getAttribute('data-folio-href') });
    }, true);
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            var el = findLink(event.target);
            if (el) {
                event.preventDefault();
                event.stopPropagation();
                send({ folio: 'linkClick', href: el.getAttribute('data-folio-href') });
                return;
            }
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
            event.preventDefault();
            event.stopPropagation();
            send({ folio: 'findShortcut', command: 'open' });
        } else if (event.key === 'F3') {
            event.preventDefault();
            event.stopPropagation();
            send({ folio: 'findShortcut', command: event.shiftKey ? 'prev' : 'next' });
        }
    }, true);
} + ')();';

function installBridge(doc: Document): void {
    const script = doc.createElement('script');
    script.setAttribute('data-' + BRIDGE_MARKER, '');
    script.textContent = BRIDGE_SOURCE;
    (doc.body || doc.documentElement).appendChild(script);
}

export function prepareHtmlForPreview(html: string, documentPath: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html || '', 'text/html');
    sanitizeDocument(doc);
    protectLinks(doc);
    rewriteResources(doc, documentPath || '');
    installPreviewDefaults(doc);
    installBridge(doc);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

function handleBridgeMessage(event: MessageEvent): void {
    const iframe = currentIframe;
    if (!iframe || event.source !== iframe.contentWindow) return;
    const data: any = event.data;
    if (!data || data.folio == null) return;
    if (data.folio === 'linkClick') {
        const href = typeof data.href === 'string' ? data.href : '';
        if (!href) return;
        const send = function () { post({ type: 'linkClick', href }); };
        if (beforeLinkClick) {
            beforeLinkClick().then(function (ok) { if (ok) send(); });
        } else {
            send();
        }
    } else if (data.folio === 'findShortcut') {
        const command = data.command;
        if (command !== 'open' && command !== 'next' && command !== 'prev') return;
        try {
            window.dispatchEvent(new CustomEvent('folio-find-shortcut', { detail: { command } }));
        } catch (_) { /* ignore */ }
    }
}

function ensureMessageListener(): void {
    if (messageListener) return;
    messageListener = handleBridgeMessage;
    window.addEventListener('message', messageListener);
}

function removeMessageListener(): void {
    if (!messageListener) return;
    window.removeEventListener('message', messageListener);
    messageListener = null;
}

export function mountHtmlView(
    iframeId: string,
    html: string,
    documentPath: string,
    beforeLink?: () => Promise<boolean>,
): void {
    const iframe = document.getElementById(iframeId) as HTMLIFrameElement | null;
    if (!iframe) return;
    currentIframe = iframe;
    currentPath = documentPath || '';
    beforeLinkClick = beforeLink || null;
    ensureMessageListener();
    // allow-scripts noetig fuer die injizierte Bridge. Foreign-Scripts
    // sind in sanitizeDocument bereits entfernt; nur das von uns
    // installierte Bridge-<script> laeuft.
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    iframe.onload = function () { HtmlFinder.refresh(); };
    iframe.srcdoc = prepareHtmlForPreview(html || '', currentPath);
}

export function clearHtmlView(): void {
    if (!currentIframe) {
        currentIframe = document.getElementById('html-view-frame') as HTMLIFrameElement | null;
    }
    if (currentIframe) {
        currentIframe.onload = null;
        currentIframe.srcdoc = '';
    }
    removeMessageListener();
    HtmlFinder.closeFind();
    beforeLinkClick = null;
    currentPath = '';
    currentIframe = null;
}

export function scrollHtmlViewToAnchor(slug: string): void {
    if (!slug) return;
    const doc = iframeDoc();
    if (!doc) return;
    let target: Element | null = null;
    try { target = doc.querySelector('#' + CSS.escape(slug)); } catch (_) { target = null; }
    if (!target) {
        target = doc.getElementsByName(slug)[0] || null;
    }
    if (target) {
        try { target.scrollIntoView({ block: 'start' }); }
        catch (_) { try { (target as HTMLElement).scrollIntoView(true); } catch (__) { /* ignore */ } }
    }
}

export function isHtmlDocument(kind: string, language: string, path?: string): boolean {
    if (kind !== 'text') return false;
    if ((language || '').toLowerCase() === 'html') return true;
    return /\.(html|htm)$/i.test(path || '');
}

function iframeDoc(): Document | null {
    const iframe = currentIframe || document.getElementById('html-view-frame') as HTMLIFrameElement | null;
    if (!iframe) return null;
    try { return iframe.contentDocument; } catch (_) { return null; }
}

function ensureHighlights(doc: Document): void {
    const win: any = doc.defaultView;
    if (!win || !win.CSS || !win.CSS.highlights || typeof win.Highlight !== 'function') return;
    if (highlightWindow !== win) {
        matchHL = null;
        activeHL = null;
        highlightWindow = win;
    }
    if (!matchHL) {
        matchHL = new win.Highlight();
        win.CSS.highlights.set('folio-find', matchHL);
    }
    if (!activeHL) {
        activeHL = new win.Highlight();
        win.CSS.highlights.set('folio-find-active', activeHL);
    }
}

function clearMarks(): void {
    if (matchHL) matchHL.clear();
    if (activeHL) activeHL.clear();
    rangesArr = [];
    activeIdx = -1;
}

function dispatchState(): void {
    const detail = { term: currentTerm, total: rangesArr.length, active: activeIdx };
    try {
        window.dispatchEvent(new CustomEvent('folio-find-state', { detail }));
    } catch (_) { /* ignore */ }
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

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildRegex(term: string): RegExp | null {
    if (!term) return null;
    let pattern = escapeRegExp(term);
    if (findOpts.wholeWord) pattern = '\\b' + pattern + '\\b';
    const flags = findOpts.caseSensitive ? 'g' : 'gi';
    try { return new RegExp(pattern, flags); } catch (_) { return null; }
}

function buildWalker(doc: Document, root: Element): TreeWalker {
    return doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
            let p = node.parentNode;
            while (p && p !== root) {
                const tn = p.nodeName ? p.nodeName.toLowerCase() : '';
                if (tn === 'script' || tn === 'style' || tn === 'noscript') {
                    return NodeFilter.FILTER_REJECT;
                }
                p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    } as NodeFilter);
}

function collectRangesAsync(doc: Document, root: Element, regex: RegExp, myToken: number, done: () => void): void {
    const walker = buildWalker(doc, root);
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
                const r = doc.createRange();
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

function setActive(idx: number): void {
    if (rangesArr.length === 0) {
        activeIdx = -1;
        if (activeHL) activeHL.clear();
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
    dispatchState();
}

function research(): void {
    clearMarks();
    const myToken = ++searchToken;
    if (!currentTerm) { dispatchState(); return; }
    const doc = iframeDoc();
    const root = doc && doc.body;
    if (!doc || !root) { dispatchState(); return; }
    const regex = buildRegex(currentTerm);
    if (!regex) { dispatchState(); return; }
    ensureHighlights(doc);
    collectRangesAsync(doc, root, regex, myToken, function () {
        if (myToken !== searchToken) return;
        if (rangesArr.length > 0) setActive(0);
        else dispatchState();
    });
}

export const HtmlFinder = {
    openFind: function (initial?: string): void {
        if (typeof initial === 'string' && initial.length > 0) currentTerm = initial;
        research();
    },
    closeFind: function (): void {
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
    refresh: function (): void { if (currentTerm) research(); },
};
