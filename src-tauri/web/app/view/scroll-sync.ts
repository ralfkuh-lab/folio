type HeadingMapEntry = {
    slug: string;
    line: number;
};

type LineElement = {
    element: HTMLElement;
    line: number;
};

const LOCK_MS = 300;
const VIEW_TOP_OFFSET = 80;
const RERENDER_RESYNC_MS = 1000;

let headingMap: HeadingMapEntry[] = [];
let lineElementCache: LineElement[] | null = null;
let viewScrollElement: HTMLElement | null = null;
let lockUntil = 0;
let lastEditorLine = 0;
let lastEditorSyncAt = 0;
let lastSource: 'editor' | 'view' | null = null;

function now(): number { return Date.now(); }

function isLocked(): boolean {
    return now() < lockUntil;
}

function lock(source: 'editor' | 'view'): void {
    lastSource = source;
    lockUntil = now() + LOCK_MS;
}

function syncEnabled(): boolean {
    const b = document.body;
    return b.classList.contains('split-mode')
        && b.classList.contains('kind-markdown')
        && !b.classList.contains('html-preview-mode');
}

function viewContent(): HTMLElement | null {
    return (document.getElementById('view-content')
        || document.getElementById('view-region')) as HTMLElement | null;
}

function targetForSlug(slug: string): HTMLElement | null {
    const root = document.querySelector('#view-region main.markdown-body');
    if (!root || !slug) return null;
    try {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
            return root.querySelector('#' + CSS.escape(slug)) as HTMLElement | null;
        }
        const byId = document.getElementById(slug);
        return byId && root.contains(byId) ? byId as HTMLElement : null;
    } catch (_) {
        return null;
    }
}

function markdownRoot(): HTMLElement | null {
    return document.querySelector('#view-region main.markdown-body') as HTMLElement | null;
}

function headingForLine(line: number): HeadingMapEntry | null {
    if (headingMap.length === 0) return null;
    let active: HeadingMapEntry | null = null;
    for (let i = 0; i < headingMap.length; i++) {
        if (headingMap[i].line <= line) active = headingMap[i];
        else break;
    }
    return active;
}

function lineForSlug(slug: string): number {
    for (let i = 0; i < headingMap.length; i++) {
        if (headingMap[i].slug === slug) return headingMap[i].line;
    }
    return 0;
}

function parseElementLine(element: HTMLElement): number {
    const dataLine = element.getAttribute('data-line');
    if (dataLine) {
        const line = parseInt(dataLine, 10);
        if (isFinite(line) && line > 0) return line;
    }

    const sourcepos = element.getAttribute('data-sourcepos') || '';
    const match = /^(\d+):/.exec(sourcepos);
    if (!match) return 0;
    const line = parseInt(match[1], 10);
    return isFinite(line) && line > 0 ? line : 0;
}

function invalidateLineElements(): void {
    lineElementCache = null;
}

function lineElements(): LineElement[] {
    if (lineElementCache && lineElementCache.length > 0 && lineElementCache[0].element.isConnected) {
        return lineElementCache;
    }

    const root = markdownRoot();
    if (!root) {
        lineElementCache = [];
        return lineElementCache;
    }

    const nodes = Array.prototype.slice.call(
        root.querySelectorAll('[data-line], [data-sourcepos]'),
    ) as HTMLElement[];
    lineElementCache = nodes
        .map((element) => ({ element, line: parseElementLine(element) }))
        .filter((entry) => entry.line > 0)
        .sort((a, b) => a.line - b.line);
    return lineElementCache;
}

function elementTop(content: HTMLElement, entry: LineElement): number {
    const contentRect = content.getBoundingClientRect();
    const elementRect = entry.element.getBoundingClientRect();
    return content.scrollTop + (elementRect.top - contentRect.top);
}

function clampRatio(value: number): number {
    if (!isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function scrollViewToLine(line: number): boolean {
    const content = viewContent();
    if (!content) return false;
    const elements = lineElements();
    if (elements.length === 0) return false;

    let nextIdx = elements.length;
    let low = 0;
    let high = elements.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (elements[mid].line > line) {
            nextIdx = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    const previous = nextIdx > 0 ? elements[nextIdx - 1] : null;
    const next = nextIdx < elements.length ? elements[nextIdx] : null;
    let targetY = 0;

    if (!previous && next) {
        targetY = elementTop(content, next);
    } else if (previous && !next) {
        targetY = elementTop(content, previous);
    } else if (previous && next && next.line !== previous.line) {
        const previousTop = elementTop(content, previous);
        const nextTop = elementTop(content, next);
        const ratio = clampRatio((line - previous.line) / (next.line - previous.line));
        targetY = previousTop + (nextTop - previousTop) * ratio;
    } else if (previous) {
        targetY = elementTop(content, previous);
    } else {
        return false;
    }

    lock('editor');
    content.scrollTo(0, Math.max(0, targetY - VIEW_TOP_OFFSET));
    return true;
}

function scrollViewToSlug(slug: string): void {
    const content = viewContent();
    if (!content) return;
    if (!slug) {
        lock('editor');
        content.scrollTo(0, 0);
        return;
    }
    const target = targetForSlug(slug);
    if (!target) return;
    const contentRect = content.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const y = content.scrollTop + (targetRect.top - contentRect.top) - VIEW_TOP_OFFSET;
    lock('editor');
    content.scrollTo(0, Math.max(0, y));
}

function lineAtViewOffset(content: HTMLElement, y: number): number {
    const elements = lineElements();
    if (elements.length === 0) return 0;

    let nextIdx = elements.length;
    let low = 0;
    let high = elements.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (elementTop(content, elements[mid]) > y) {
            nextIdx = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    const previous = nextIdx > 0 ? elements[nextIdx - 1] : null;
    const next = nextIdx < elements.length ? elements[nextIdx] : null;
    if (!previous && next) return next.line;
    if (previous && !next) return previous.line;
    if (!previous || !next) return 0;

    const previousTop = elementTop(content, previous);
    const nextTop = elementTop(content, next);
    if (nextTop === previousTop || next.line === previous.line) return previous.line;

    const ratio = clampRatio((y - previousTop) / (nextTop - previousTop));
    return previous.line + (next.line - previous.line) * ratio;
}

function revealEditorLine(line: number): void {
    if (!line || line < 1) return;
    const editor = window.FolioEditor;
    if (!editor) return;
    lock('view');
    if (typeof editor.revealLineFractionNearTop === 'function') {
        editor.revealLineFractionNearTop(line);
    } else if (typeof editor.revealLineNearTop === 'function') {
        editor.revealLineNearTop(Math.max(1, Math.round(line)));
    }
}

function syncViewScrollToEditor(): void {
    if (!syncEnabled()) return;
    if (isLocked() && lastSource === 'editor') return;
    const content = viewContent();
    if (!content) return;
    const line = lineAtViewOffset(content, content.scrollTop + VIEW_TOP_OFFSET);
    revealEditorLine(line);
}

function ensureViewScrollListener(): void {
    const content = viewContent();
    if (!content || content === viewScrollElement) return;
    viewScrollElement = content;

    let rafQueued = false;
    function schedule(): void {
        if (rafQueued) return;
        rafQueued = true;
        requestAnimationFrame(function () {
            rafQueued = false;
            syncViewScrollToEditor();
        });
    }

    content.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', function () {
        invalidateLineElements();
    });
}

export function setMarkdownHeadingMap(entries: HeadingMapEntry[] | null | undefined): void {
    invalidateLineElements();
    ensureViewScrollListener();
    headingMap = (entries || [])
        .filter((entry) => entry && typeof entry.slug === 'string' && typeof entry.line === 'number')
        .map((entry) => ({ slug: entry.slug, line: Math.max(1, Math.floor(entry.line)) }))
        .sort((a, b) => a.line - b.line);
}

export function clearMarkdownHeadingMap(): void {
    headingMap = [];
    invalidateLineElements();
    lastEditorLine = 0;
    lastEditorSyncAt = 0;
    lastSource = null;
    lockUntil = 0;
}

export function syncEditorLineToView(line: number): void {
    if (!syncEnabled() || isLocked()) return;
    const normalized = Math.max(1, Math.floor(line || 1));
    lastEditorLine = normalized;
    lastEditorSyncAt = now();
    if (scrollViewToLine(normalized)) return;
    const heading = headingForLine(normalized);
    scrollViewToSlug(heading ? heading.slug : '');
}

export function syncViewSlugToEditor(slug: string): void {
    if (!syncEnabled()) return;
    if (lineElements().length > 0) return;
    if (isLocked()) return;
    const line = lineForSlug(slug || '');
    if (!line) return;
    revealEditorLine(line);
}

export function afterMarkdownPreviewRender(userScrolledDuringRender: boolean): void {
    invalidateLineElements();
    ensureViewScrollListener();
    if (userScrolledDuringRender) return;
    if (lastEditorLine <= 0) return;
    if (now() - lastEditorSyncAt > RERENDER_RESYNC_MS) return;
    lockUntil = 0;
    syncEditorLineToView(lastEditorLine);
}

export function initMarkdownScrollSync(): void {
    ensureViewScrollListener();
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;

    ev.listen('editor:selection', function (event: any) {
        const data = (event && event.payload) || {};
        if (typeof data.line === 'number' && data.line > 0) {
            syncEditorLineToView(data.line);
        }
    });

    ev.listen('editor:scroll', function (event: any) {
        const data = (event && event.payload) || {};
        if (typeof data.line === 'number' && data.line > 0) {
            syncEditorLineToView(data.line);
        }
    });
}
