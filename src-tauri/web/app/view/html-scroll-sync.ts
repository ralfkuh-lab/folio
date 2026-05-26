import { setHtmlViewCallbacks, iframeDoc } from './html';

const LOCK_MS = 300;

let lockUntil = 0;
let lastSource: 'editor' | 'iframe' | null = null;
let iframeScrollHandler: (() => void) | null = null;
let iframeScrollDoc: Document | null = null;

function now(): number { return Date.now(); }

function isLocked(): boolean { return now() < lockUntil; }

function lock(source: 'editor' | 'iframe'): void {
    lastSource = source;
    lockUntil = now() + LOCK_MS;
}

function htmlSyncEnabled(): boolean {
    const b = document.body;
    return b.classList.contains('split-mode')
        && b.classList.contains('html-preview-mode');
}

function iframeScrollable(doc: Document): HTMLElement | null {
    return doc.scrollingElement as HTMLElement || doc.documentElement;
}

function syncEditorToIframe(scrollTop: number, scrollHeight: number): void {
    if (!htmlSyncEnabled()) return;
    if (isLocked() && lastSource === 'iframe') return;
    const doc = iframeDoc();
    if (!doc) return;
    const el = iframeScrollable(doc);
    if (!el) return;
    const maxEditor = scrollHeight - (window.FolioEditor
        && typeof window.FolioEditor.getVisibleHeight === 'function'
        ? window.FolioEditor.getVisibleHeight() : 0);
    const ratio = maxEditor > 0 ? scrollTop / maxEditor : 0;
    const maxIframe = el.scrollHeight - el.clientHeight;
    if (maxIframe <= 0) return;
    lock('editor');
    el.scrollTop = Math.max(0, Math.min(maxIframe, ratio * maxIframe));
}

function syncIframeToEditor(): void {
    if (!htmlSyncEnabled()) return;
    if (isLocked() && lastSource === 'editor') return;
    const doc = iframeDoc();
    if (!doc) return;
    const el = iframeScrollable(doc);
    if (!el) return;
    const editor = window.FolioEditor;
    if (!editor || typeof editor.setScroll !== 'function') return;
    const maxIframe = el.scrollHeight - el.clientHeight;
    if (maxIframe <= 0) return;
    const ratio = el.scrollTop / maxIframe;
    const editorScrollHeight = typeof editor.getScrollHeight === 'function'
        ? editor.getScrollHeight() : 0;
    const editorVisibleHeight = typeof editor.getVisibleHeight === 'function'
        ? editor.getVisibleHeight() : 0;
    const maxEditor = editorScrollHeight - editorVisibleHeight;
    if (maxEditor <= 0) return;
    lock('iframe');
    editor.setScroll(Math.max(0, Math.min(maxEditor, ratio * maxEditor)));
}

function attachIframeListener(doc: Document): void {
    detachIframeListener();
    iframeScrollDoc = doc;
    let rafQueued = false;
    iframeScrollHandler = function () {
        if (rafQueued) return;
        rafQueued = true;
        requestAnimationFrame(function () {
            rafQueued = false;
            syncIframeToEditor();
        });
    };
    const target = doc.defaultView || doc;
    (target as EventTarget).addEventListener('scroll', iframeScrollHandler, { passive: true });
}

function detachIframeListener(): void {
    if (iframeScrollHandler && iframeScrollDoc) {
        try {
            const target = iframeScrollDoc.defaultView || iframeScrollDoc;
            (target as EventTarget).removeEventListener('scroll', iframeScrollHandler);
        } catch { /* iframe may already be detached */ }
    }
    iframeScrollHandler = null;
    iframeScrollDoc = null;
    lockUntil = 0;
    lastSource = null;
}

export function initHtmlScrollSync(): void {
    setHtmlViewCallbacks(
        function onLoaded(doc: Document) { attachIframeListener(doc); },
        function onClear() { detachIframeListener(); },
    );

    window.addEventListener('folio-editor-scroll', function (e: Event) {
        const detail = (e as CustomEvent).detail || {};
        if (typeof detail.y === 'number' && typeof detail.scrollHeight === 'number') {
            syncEditorToIframe(detail.y, detail.scrollHeight);
        }
    });
}
