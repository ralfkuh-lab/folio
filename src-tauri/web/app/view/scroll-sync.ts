type HeadingMapEntry = {
    slug: string;
    line: number;
};

const LOCK_MS = 300;
const VIEW_TOP_OFFSET = 80;
const RERENDER_RESYNC_MS = 1000;

let headingMap: HeadingMapEntry[] = [];
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

export function setMarkdownHeadingMap(entries: HeadingMapEntry[] | null | undefined): void {
    headingMap = (entries || [])
        .filter((entry) => entry && typeof entry.slug === 'string' && typeof entry.line === 'number')
        .map((entry) => ({ slug: entry.slug, line: Math.max(1, Math.floor(entry.line)) }))
        .sort((a, b) => a.line - b.line);
}

export function clearMarkdownHeadingMap(): void {
    headingMap = [];
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
    const heading = headingForLine(normalized);
    scrollViewToSlug(heading ? heading.slug : '');
}

export function syncViewSlugToEditor(slug: string): void {
    if (!syncEnabled()) return;
    if (isLocked() && lastSource === 'editor') return;
    const line = lineForSlug(slug || '');
    if (!line) return;
    const editor = window.FolioEditor;
    if (!editor || typeof editor.revealLineNearTop !== 'function') return;
    lock('view');
    editor.revealLineNearTop(line);
}

export function afterMarkdownPreviewRender(userScrolledDuringRender: boolean): void {
    if (userScrolledDuringRender) return;
    if (lastEditorLine <= 0) return;
    if (now() - lastEditorSyncAt > RERENDER_RESYNC_MS) return;
    lockUntil = 0;
    syncEditorLineToView(lastEditorLine);
}

export function initMarkdownScrollSync(): void {
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
