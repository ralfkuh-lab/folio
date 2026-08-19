/* Hex-Dump-Ansicht fuer FileKind::Binary (read-only).
   Fenster- und Chunk-Mathematik kommt aus hex-format.ts; dieses Modul
   virtualisiert nur das aktuelle Fenster, holt 64-KiB-Bloecke und haelt
   die Position je Tab. */

import { t } from '../i18n/translate';
import {
    BYTES_PER_ROW,
    MAX_WINDOW_BYTES,
    chunkStartFor,
    formatLine,
    offsetWidthFor,
    parseOffsetInput,
    rowOffset,
    windowBytesFor,
    windowEndExclusive,
    windowStartFor,
    type FormattedHexLine,
} from './hex-format';

export const CHUNK_BYTES = 64 * 1024;
export const HEX_MAX_INFLIGHT = 4;
const LRU_CAP = 32;
const ROW_BUFFER = 20;
const FALLBACK_LINE_HEIGHT = 18;
const STALE_PREFIX = 'stale:';

export type HexStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'empty'
    | 'unavailable'
    | 'error'
    | 'tooLarge';

export type HexViewState = {
    path: string;
    fileSize: number;
    windowStart: number;
    windowLen: number;
    loadedChunks: number[];
    error: string | null;
    status: HexStatus;
    revision: number;
    tabId: number | null;
    firstLine: FormattedHexLine | null;
    lineHeightPx: number;
};

export type HexMountOptions = {
    path: string;
    fileSize: number;
    revision: number;
    tabId: number;
    tooLarge?: boolean;
    available?: boolean;
};

export type HexReloadOptions = {
    tabId?: number;
    fileSize?: number;
    revision?: number;
    tooLarge?: boolean;
    available?: boolean;
};

type CacheEntry = {
    revision: number;
    start: number;
    bytes: Uint8Array;
};

type InflightEntry = {
    token: number;
    tabId: number;
    revision: number;
    start: number;
    waiters: Set<number>;
};

const tabOffsets = new Map<string, number>();
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, InflightEntry>();
const queuedStarts = new Set<number>();
const queue: number[] = [];

let generation = 0;
let nextRequestToken = 1;
let path = '';
let fileSize = 0;
let revision = 0;
let tabId: number | null = null;
let tooLarge = false;
let available = true;
let status: HexStatus = 'idle';
let lastError: string | null = null;
let windowStart = 0;
let windowBytes = MIN_WINDOW_FALLBACK();
let lineHeightPx = FALLBACK_LINE_HEIGHT;
let listenersAttached = false;
let resizeObserver: ResizeObserver | null = null;
let scrollRaf = 0;
let activeFetches = 0;
let fetchPaused = false;
let maxInflight = HEX_MAX_INFLIGHT;
let chunkBytes = CHUNK_BYTES;

function MIN_WINDOW_FALLBACK(): number {
    return BYTES_PER_ROW;
}

export function isBinaryDocument(kind: string): boolean {
    return kind === 'binary';
}

function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') {
        return Promise.reject(new Error('invoke unavailable'));
    }
    return core.invoke(cmd, args);
}

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function getRegion(): HTMLElement | null {
    return $('hex-view-region');
}

function getMount(): HTMLElement | null {
    return $('hex-view-mount');
}

function getToolbar(): HTMLElement | null {
    return $('hex-view-toolbar');
}

function getStatus(): HTMLElement | null {
    return $('hex-view-status');
}

function getGoto(): HTMLInputElement | null {
    return $('hex-view-goto') as HTMLInputElement | null;
}

function getGotoError(): HTMLElement | null {
    return $('hex-view-goto-error');
}

function isGotoFocused(): boolean {
    const input = getGoto();
    return !!input && document.activeElement === input;
}

function cacheKey(id: number, rev: number, start: number): string {
    return id + ':' + rev + ':' + start;
}

function offsetKey(id: number, docPath: string): string {
    return id + '\0' + docPath;
}

export function forgetHexOffsetsForTab(id: number): void {
    const prefix = id + '\0';
    const stale: string[] = [];
    tabOffsets.forEach(function (_value, key) {
        if (key.indexOf(prefix) === 0) stale.push(key);
    });
    stale.forEach(function (key) { tabOffsets.delete(key); });
}

export function forgetClosedHexTabs(liveTabIds: number[]): void {
    const live = new Set(liveTabIds);
    const stale: string[] = [];
    tabOffsets.forEach(function (_value, key) {
        const sep = key.indexOf('\0');
        const id = Number(sep >= 0 ? key.slice(0, sep) : key);
        if (!live.has(id)) stale.push(key);
    });
    stale.forEach(function (key) { tabOffsets.delete(key); });
}

function cancelScrollRaf(): void {
    if (!scrollRaf) return;
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
}

function bumpGeneration(): number {
    generation += 1;
    fetchPaused = false;
    queuedStarts.clear();
    queue.length = 0;
    cancelScrollRaf();
    return generation;
}

function clearCache(): void {
    cache.clear();
}

function lruGet(id: number, rev: number, start: number): Uint8Array | null {
    const key = cacheKey(id, rev, start);
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry);
    return entry.bytes;
}

function lruSet(id: number, rev: number, start: number, bytes: Uint8Array): void {
    const key = cacheKey(id, rev, start);
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { revision: rev, start, bytes });
    while (cache.size > LRU_CAP) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function toUint8Array(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array(0);
}

function currentWindowEnd(): number {
    return windowEndExclusive(windowStart, windowBytes, fileSize);
}

function currentWindowLen(): number {
    return currentWindowEnd() - windowStart;
}

function currentTopOffsetAt(heightPx: number): number {
    const scroller = getScroller();
    if (!scroller || heightPx <= 0) return windowStart;
    const row = Math.max(0, Math.floor(scroller.scrollTop / heightPx));
    const offset = rowOffset(windowStart, row);
    const last = fileSize > 0 ? fileSize - 1 : 0;
    return Math.min(offset, last);
}

function currentTopOffset(): number {
    return currentTopOffsetAt(lineHeightPx);
}

function rememberTabOffset(): void {
    if (tabId === null || !path) return;
    tabOffsets.set(offsetKey(tabId, path), currentTopOffset());
}

function windowRowCount(): number {
    const len = currentWindowLen();
    if (len <= 0) return 0;
    return Math.ceil(len / BYTES_PER_ROW);
}

function measureLineHeight(): number {
    const mount = getMount();
    if (!mount) return FALLBACK_LINE_HEIGHT;
    const probe = document.createElement('div');
    probe.className = 'hex-row';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    const formatted = formatLine(new Uint8Array(BYTES_PER_ROW), 0, 8);
    probe.appendChild(span('hex-offset', formatted.offset));
    probe.appendChild(span('hex-bytes', formatted.bytes));
    probe.appendChild(span('hex-ascii', formatted.ascii));
    mount.appendChild(probe);
    const laidOut = Math.round(probe.getBoundingClientRect().height);
    let measured = laidOut;
    if (measured <= 0 && typeof getComputedStyle === 'function') {
        const computed = getComputedStyle(probe);
        const fromHeight = Number.parseFloat(computed.height);
        const fromLine = Number.parseFloat(computed.lineHeight);
        if (Number.isFinite(fromHeight) && fromHeight > 0) measured = Math.round(fromHeight);
        else if (Number.isFinite(fromLine) && fromLine > 0) measured = Math.round(fromLine);
    }
    probe.remove();
    return measured > 0 ? measured : FALLBACK_LINE_HEIGHT;
}

function span(className: string, text: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
}

function ensureScroller(): HTMLElement | null {
    const mount = getMount();
    if (!mount) return null;
    let scroller = mount.querySelector('.hex-scroller') as HTMLElement | null;
    if (!scroller) {
        mount.innerHTML = '';
        scroller = document.createElement('div');
        scroller.className = 'hex-scroller';
        const virtual = document.createElement('div');
        virtual.className = 'hex-virtual';
        const top = document.createElement('div');
        top.className = 'hex-spacer-top';
        const rows = document.createElement('div');
        rows.className = 'hex-rows';
        const bottom = document.createElement('div');
        bottom.className = 'hex-spacer-bottom';
        virtual.appendChild(top);
        virtual.appendChild(rows);
        virtual.appendChild(bottom);
        scroller.appendChild(virtual);
        mount.appendChild(scroller);
    }
    return scroller;
}

function getScroller(): HTMLElement | null {
    const mount = getMount();
    return mount ? (mount.querySelector('.hex-scroller') as HTMLElement | null) : null;
}

function setStatus(
    next: HexStatus,
    message: string,
    opts?: { retry?: boolean },
): void {
    status = next;
    const el = getStatus();
    const mount = getMount();
    if (!el) return;
    const text = $('hex-view-status-text');
    const retry = $('hex-view-retry') as HTMLButtonElement | null;
    if (next === 'ready' || next === 'idle' || next === 'loading') {
        el.hidden = true;
        if (text) text.textContent = '';
        if (retry) retry.hidden = true;
        if (mount) mount.hidden = false;
        return;
    }
    el.hidden = false;
    if (text) text.textContent = message;
    else el.textContent = message;
    if (retry) retry.hidden = !opts?.retry;
    const hideDump = next === 'empty' || next === 'unavailable' || next === 'tooLarge';
    if (mount) mount.hidden = hideDump;
}

function setGotoError(message: string | null): void {
    const input = getGoto();
    const err = getGotoError();
    if (input) {
        if (message) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    }
    if (err) err.textContent = message || '';
}

function updateToolbar(): void {
    const toolbar = getToolbar();
    const range = $('hex-view-range');
    const prev = $('hex-view-prev') as HTMLButtonElement | null;
    const next = $('hex-view-next') as HTMLButtonElement | null;
    const showNav = fileSize > windowBytes && available && !tooLarge && status !== 'empty';
    if (toolbar) toolbar.hidden = !showNav;
    if (!showNav) return;
    const end = currentWindowEnd();
    const startIncl = fileSize === 0 ? 0 : windowStart + 1;
    const endIncl = end;
    if (range) {
        range.textContent = t('hexView.windowRange', {
            start: String(startIncl),
            end: String(endIncl),
            total: String(fileSize),
        });
    }
    if (prev) prev.disabled = windowStart <= 0;
    if (next) next.disabled = end >= fileSize;
}

function bytesForRow(row: number): { input: Array<number | null>; raw: number[] } {
    const start = rowOffset(windowStart, row);
    const input: Array<number | null> = [];
    const raw: number[] = [];
    for (let i = 0; i < BYTES_PER_ROW; i += 1) {
        const global = start + i;
        if (global >= fileSize) break;
        const block = chunkStartFor(global, chunkBytes);
        const chunk = tabId === null ? null : lruGet(tabId, revision, block);
        if (!chunk) {
            input.push(null);
            continue;
        }
        const local = global - block;
        if (local < 0 || local >= chunk.length) {
            input.push(null);
            continue;
        }
        const value = chunk[local] as number;
        input.push(value);
        raw.push(value);
    }
    return { input, raw };
}

function firstLineState(): FormattedHexLine | null {
    if (fileSize <= 0 || status === 'empty') return null;
    const { input } = bytesForRow(0);
    if (input.length === 0) return null;
    return formatLine(input, windowStart, offsetWidthFor(fileSize));
}

function renderVisible(): void {
    if (
        status === 'empty'
        || status === 'unavailable'
        || status === 'tooLarge'
        || status === 'error'
        || status === 'idle'
    ) {
        return;
    }
    const mount = getMount();
    if (!mount || mount.hidden) return;
    const scroller = ensureScroller();
    if (!scroller) return;
    const virtual = scroller.querySelector('.hex-virtual') as HTMLElement | null;
    const top = scroller.querySelector('.hex-spacer-top') as HTMLElement | null;
    const rowsEl = scroller.querySelector('.hex-rows') as HTMLElement | null;
    const bottom = scroller.querySelector('.hex-spacer-bottom') as HTMLElement | null;
    if (!virtual || !top || !rowsEl || !bottom) return;

    const rowCount = windowRowCount();
    const totalHeight = rowCount * lineHeightPx;
    const viewport = Math.max(0, scroller.clientHeight);
    const scrollTop = Math.max(0, scroller.scrollTop);
    const viewportRows = Math.max(1, Math.ceil((viewport || lineHeightPx) / lineHeightPx));
    let first = Math.max(0, Math.floor(scrollTop / lineHeightPx) - ROW_BUFFER);
    let last = Math.min(rowCount, first + viewportRows + ROW_BUFFER * 2);
    if (first > last) first = last;

    top.style.height = first * lineHeightPx + 'px';
    bottom.style.height = Math.max(0, rowCount - last) * lineHeightPx + 'px';
    virtual.style.height = totalHeight + 'px';

    const width = offsetWidthFor(fileSize);
    const needed = last - first;
    while (rowsEl.childElementCount > needed) {
        rowsEl.removeChild(rowsEl.lastChild as Node);
    }
    while (rowsEl.childElementCount < needed) {
        const row = document.createElement('div');
        row.className = 'hex-row';
        row.appendChild(span('hex-offset', ''));
        row.appendChild(span('hex-bytes', ''));
        row.appendChild(span('hex-ascii', ''));
        rowsEl.appendChild(row);
    }

    const children = rowsEl.children;
    for (let i = 0; i < needed; i += 1) {
        const rowIndex = first + i;
        const rowEl = children[i] as HTMLElement;
        const off = rowOffset(windowStart, rowIndex);
        const { input } = bytesForRow(rowIndex);
        const formatted = formatLine(input, off, width);
        rowEl.dataset.offset = String(off);
        (rowEl.children[0] as HTMLElement).textContent = formatted.offset;
        (rowEl.children[1] as HTMLElement).textContent = formatted.bytes;
        (rowEl.children[2] as HTMLElement).textContent = formatted.ascii;
    }

    if (!fetchPaused) requestChunksForRange(first, last);
    deriveReadyFromCache();
}

function deriveReadyFromCache(): void {
    if (
        status === 'idle'
        || status === 'empty'
        || status === 'unavailable'
        || status === 'tooLarge'
        || status === 'error'
    ) {
        return;
    }
    if (tabId === null || fileSize <= 0) return;
    const start = chunkStartFor(windowStart, chunkBytes);
    if (lruGet(tabId, revision, start)) {
        lastError = null;
        if (status !== 'ready') setStatus('ready', '');
    } else if (status !== 'loading') {
        setStatus('loading', '');
    }
}

function requestChunksForRange(firstRow: number, lastRow: number): void {
    if (fetchPaused || fileSize <= 0 || !available || tooLarge) return;
    if (lastRow <= firstRow) {
        requestChunk(chunkStartFor(windowStart, chunkBytes));
        return;
    }
    const firstOff = rowOffset(windowStart, firstRow);
    const lastOff = Math.min(
        fileSize - 1,
        rowOffset(windowStart, Math.max(firstRow, lastRow - 1)) + (BYTES_PER_ROW - 1),
    );
    let start = chunkStartFor(firstOff, chunkBytes);
    const lastStart = chunkStartFor(lastOff, chunkBytes);
    while (start <= lastStart) {
        requestChunk(start);
        const next = start + chunkBytes;
        if (next <= start) break;
        start = next;
    }
}

function requestChunk(start: number): void {
    if (fetchPaused || start >= fileSize) return;
    if (tabId === null) return;
    const key = cacheKey(tabId, revision, start);
    const existing = inflight.get(key);
    if (existing) {
        existing.waiters.add(generation);
        return;
    }
    if (cache.has(key) || queuedStarts.has(start)) return;
    queuedStarts.add(start);
    queue.push(start);
    pumpQueue();
}

function pumpQueue(): void {
    if (fetchPaused) return;
    while (activeFetches < maxInflight && queue.length > 0) {
        const start = queue.shift();
        if (start === undefined) break;
        queuedStarts.delete(start);
        startFetch(start);
    }
}

function startFetch(start: number): void {
    const gen = generation;
    const rev = revision;
    const id = tabId;
    if (id === null) return;
    const key = cacheKey(id, rev, start);
    if (cache.has(key) || inflight.has(key)) return;

    const remaining = fileSize - start;
    const len = Math.max(0, Math.min(chunkBytes, remaining));
    const token = nextRequestToken;
    nextRequestToken += 1;
    inflight.set(key, {
        token,
        tabId: id,
        revision: rev,
        start,
        waiters: new Set([gen]),
    });
    activeFetches += 1;
    invoke('read_file_chunk', {
        tabId: id,
        revision: rev,
        offset: start,
        len,
    }).then(function (raw) {
        const entry = inflight.get(key);
        if (!entry || !entry.waiters.has(generation)) return;
        lruSet(id, rev, start, toUint8Array(raw));
    }).catch(function (err) {
        const entry = inflight.get(key);
        if (!entry || !entry.waiters.has(generation)) return;
        fetchPaused = true;
        queuedStarts.clear();
        queue.length = 0;
        const message = typeof err === 'string' ? err : String(err);
        if (message.indexOf(STALE_PREFIX) === 0) return;
        lastError = t('errors.view.hexLoadFailed');
        setStatus('error', lastError, { retry: true });
    }).finally(function () {
        const current = inflight.get(key);
        const waiters = current && current.token === token ? current.waiters : new Set<number>();
        if (current && current.token === token) inflight.delete(key);
        activeFetches = Math.max(0, activeFetches - 1);
        pumpQueue();
        if (!waiters.has(generation) || fetchPaused) return;
        if (status === 'unavailable' || status === 'tooLarge' || status === 'error') return;
        deriveReadyFromCache();
        renderVisible();
        updateToolbar();
    });
}

function applyWindow(target: number, opts?: { bump?: boolean; resetScroll?: boolean }): void {
    if (opts && opts.bump) bumpGeneration();
    const safeTarget = fileSize > 0 ? Math.min(Math.max(0, target), fileSize - 1) : 0;
    windowStart = windowStartFor(safeTarget, windowBytes);
    if (windowStart >= fileSize && fileSize > 0) {
        windowStart = windowStartFor(fileSize - 1, windowBytes);
    }
    const scroller = getScroller();
    if (scroller && opts && opts.resetScroll) {
        const row = Math.floor((safeTarget - windowStart) / BYTES_PER_ROW);
        scroller.scrollTop = Math.max(0, row * lineHeightPx);
    }
    updateToolbar();
    renderVisible();
}

function jumpToOffset(target: number): void {
    applyWindow(target, { bump: true, resetScroll: true });
    rememberTabOffset();
}

function syncMetrics(): void {
    lineHeightPx = measureLineHeight();
    windowBytes = windowBytesFor(lineHeightPx);
    if (windowBytes > MAX_WINDOW_BYTES) windowBytes = MAX_WINDOW_BYTES;
}

function showDocumentBody(): void {
    if (tooLarge) {
        lastError = t('errors.file.tooLargeToAddress', { detail: String(fileSize) });
        setStatus('tooLarge', lastError);
        updateToolbar();
        return;
    }
    if (!available) {
        lastError = t('hexView.unavailable');
        setStatus('unavailable', lastError, { retry: true });
        updateToolbar();
        return;
    }
    if (fileSize <= 0) {
        lastError = null;
        setStatus('empty', t('hexView.emptyFile'));
        updateToolbar();
        return;
    }
    lastError = null;
    setStatus('loading', '');
    const mount = getMount();
    if (mount) mount.hidden = false;
    if (!ensureScroller()) return;
    const saved = tabId !== null && path
        ? (tabOffsets.get(offsetKey(tabId, path)) ?? 0)
        : 0;
    applyWindow(saved, { resetScroll: true });
}

function onScroll(): void {
    if (scrollRaf) return;
    const gen = generation;
    scrollRaf = requestAnimationFrame(function () {
        scrollRaf = 0;
        if (gen !== generation || status === 'idle' || fetchPaused) return;
        rememberTabOffset();
        renderVisible();
    });
}

function onResize(): void {
    if (status === 'idle') return;
    const previous = lineHeightPx;
    const target = currentTopOffsetAt(previous);
    syncMetrics();
    if (previous !== lineHeightPx) {
        applyWindow(target, { bump: true, resetScroll: true });
    } else {
        renderVisible();
        updateToolbar();
    }
}

function onKeyDown(event: KeyboardEvent): void {
    if (isGotoFocused()) return;
    const scroller = getScroller();
    if (!scroller || status === 'empty' || status === 'unavailable' || status === 'tooLarge') {
        return;
    }
    switch (event.key) {
        case 'ArrowDown':
            event.preventDefault();
            scroller.scrollTop += lineHeightPx;
            break;
        case 'ArrowUp':
            event.preventDefault();
            scroller.scrollTop -= lineHeightPx;
            break;
        case 'PageDown':
            event.preventDefault();
            scroller.scrollTop += scroller.clientHeight || lineHeightPx;
            break;
        case 'PageUp':
            event.preventDefault();
            scroller.scrollTop -= scroller.clientHeight || lineHeightPx;
            break;
        case 'Home':
            event.preventDefault();
            jumpToOffset(0);
            break;
        case 'End':
            event.preventDefault();
            jumpToOffset(fileSize > 0 ? fileSize - 1 : 0);
            break;
        default:
            break;
    }
}

function applyGoto(): void {
    const input = getGoto();
    if (!input) return;
    const parsed = parseOffsetInput(input.value, fileSize);
    if (!parsed.ok) {
        setGotoError(t('hexView.invalidOffset'));
        return;
    }
    setGotoError(null);
    jumpToOffset(parsed.offset);
}

function onPrev(): void {
    const prev = $('hex-view-prev') as HTMLButtonElement | null;
    if (prev && prev.disabled) return;
    if (windowStart <= 0) return;
    jumpToOffset(Math.max(0, windowStart - 1));
}

function onNext(): void {
    const next = $('hex-view-next') as HTMLButtonElement | null;
    if (next && next.disabled) return;
    const end = currentWindowEnd();
    if (end >= fileSize) return;
    jumpToOffset(end);
}

function onRetry(): void {
    available = true;
    lastError = null;
    bumpGeneration();
    clearCache();
    showDocumentBody();
}

function ensureListeners(): void {
    if (listenersAttached) return;
    const region = getRegion();
    const mount = getMount();
    const prev = $('hex-view-prev');
    const next = $('hex-view-next');
    const goto = getGoto();
    const retry = $('hex-view-retry');
    if (!region || !mount) return;
    listenersAttached = true;
    region.addEventListener('keydown', onKeyDown);
    mount.addEventListener('scroll', onScroll, true);
    if (prev) prev.addEventListener('click', onPrev);
    if (next) next.addEventListener('click', onNext);
    if (retry) retry.addEventListener('click', onRetry);
    if (goto) {
        goto.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            applyGoto();
        });
        goto.addEventListener('input', function () {
            if (goto.getAttribute('aria-invalid') === 'true') setGotoError(null);
        });
    }
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(function () {
            onResize();
        });
        resizeObserver.observe(mount);
        resizeObserver.observe(region);
    }
}

function resetSession(): void {
    path = '';
    fileSize = 0;
    revision = 0;
    tabId = null;
    tooLarge = false;
    available = true;
    status = 'idle';
    lastError = null;
    windowStart = 0;
    setGotoError(null);
    const mount = getMount();
    if (mount) {
        mount.innerHTML = '';
        mount.hidden = false;
    }
    const toolbar = getToolbar();
    if (toolbar) toolbar.hidden = true;
    setStatus('idle', '');
}

export function mountHexView(options: HexMountOptions): void {
    ensureListeners();
    const nextTab = options.tabId;
    const nextPath = options.path || '';
    if (tabId !== null && path) {
        rememberTabOffset();
    }
    bumpGeneration();
    if (revision !== options.revision || path !== nextPath) {
        clearCache();
    }
    path = nextPath;
    fileSize = Number.isFinite(options.fileSize) ? Math.max(0, options.fileSize) : 0;
    revision = options.revision || 0;
    tabId = nextTab;
    tooLarge = !!options.tooLarge;
    available = options.available !== false;
    lastError = null;
    syncMetrics();
    showDocumentBody();
}

export function reloadHexView(options?: HexReloadOptions): void {
    if (!path) return;
    if (options && typeof options.tabId === 'number' && tabId !== null
        && options.tabId !== tabId) {
        return;
    }
    const nextRevision = options && typeof options.revision === 'number'
        ? options.revision
        : revision;
    if (typeof nextRevision === 'number' && nextRevision < revision) {
        return;
    }
    if (typeof nextRevision === 'number' && nextRevision === revision
        && options && options.revision !== undefined) {
        return;
    }
    const revisionChanged = nextRevision !== revision;
    if (options && typeof options.fileSize === 'number') {
        fileSize = Math.max(0, options.fileSize);
    }
    if (options && options.tooLarge !== undefined) tooLarge = !!options.tooLarge;
    if (options && options.available !== undefined) available = !!options.available;
    revision = nextRevision;
    bumpGeneration();
    if (revisionChanged) clearCache();
    const target = currentTopOffset();
    if (fileSize > 0 && target >= fileSize && tabId !== null && path) {
        tabOffsets.set(offsetKey(tabId, path), fileSize - 1);
    }
    syncMetrics();
    showDocumentBody();
}

export function clearHexView(): void {
    rememberTabOffset();
    bumpGeneration();
    clearCache();
    resetSession();
}

export function getHexViewState(): HexViewState {
    const loaded: number[] = [];
    const prefix = tabId === null ? '' : tabId + ':' + revision + ':';
    cache.forEach(function (entry, key) {
        if (prefix && key.indexOf(prefix) === 0) loaded.push(entry.start);
    });
    loaded.sort(function (a, b) { return a - b; });
    return {
        path,
        fileSize,
        windowStart,
        windowLen: currentWindowLen(),
        loadedChunks: loaded,
        error: lastError,
        status,
        revision,
        tabId,
        firstLine: firstLineState(),
        lineHeightPx,
    };
}

export function getHexFetchStats(): {
    active: number;
    queued: number;
    paused: boolean;
} {
    return { active: activeFetches, queued: queue.length, paused: fetchPaused };
}

/** Nur Tests: Chunk-Groesse, Inflight-Limit und Listener zuruecksetzen. */
export function configureHexViewForTests(opts?: {
    chunkBytes?: number;
    maxInflight?: number;
}): void {
    chunkBytes = opts && opts.chunkBytes ? opts.chunkBytes : CHUNK_BYTES;
    maxInflight = opts && opts.maxInflight ? opts.maxInflight : HEX_MAX_INFLIGHT;
    listenersAttached = false;
    fetchPaused = false;
    activeFetches = 0;
    nextRequestToken = 1;
    inflight.clear();
    queuedStarts.clear();
    queue.length = 0;
    tabOffsets.clear();
    cancelScrollRaf();
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }
}

try {
    (window as unknown as { __folioHexViewState?: () => HexViewState }).__folioHexViewState =
        getHexViewState;
} catch {
    /* ignore */
}
