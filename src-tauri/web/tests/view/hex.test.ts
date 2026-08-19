import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';
import {
    clearHexView,
    configureHexViewForTests,
    forgetClosedHexTabs,
    forgetHexOffsetsForTab,
    getHexFetchStats,
    getHexViewState,
    isBinaryDocument,
    mountHexView,
    reloadHexView,
    revealHexOffset,
    setHexContextListener,
    type HexSearchContext,
} from '../../app/view/hex';

let tauri: TauriMockHandles;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function chunkKey(tabId: number, revision: number, offset: number): string {
    return `${tabId}:${revision}:${offset}`;
}

function mountDom(): void {
    document.body.innerHTML = `
        <div class="hex-view-region" id="hex-view-region">
            <div class="hex-view-toolbar" id="hex-view-toolbar" hidden>
                <span id="hex-view-range"></span>
                <button type="button" id="hex-view-prev" disabled>prev</button>
                <button type="button" id="hex-view-next" disabled>next</button>
                <label for="hex-view-goto">goto</label>
                <input type="text" id="hex-view-goto" />
                <span id="hex-view-goto-error"></span>
            </div>
            <div id="hex-view-status" hidden>
                <span id="hex-view-status-text"></span>
                <button type="button" id="hex-view-retry" hidden>retry</button>
            </div>
            <div id="hex-view-mount" tabindex="0"></div>
        </div>
    `;
    const mount = document.getElementById('hex-view-mount')!;
    Object.defineProperty(mount, 'clientHeight', { configurable: true, value: 400 });
}

function bytes(data: number[] | Uint8Array): ArrayBuffer {
    return Uint8Array.from(data).buffer;
}

function flush(): Promise<void> {
    return Promise.resolve().then(() => undefined);
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await flush();
}

/** Loest alle offenen Chunk-Reads auf — auch die, die erst nachruecken,
    wenn ein Inflight-Slot frei wird. */
async function resolveAllPending(fill: number): Promise<void> {
    for (let round = 0; round < 8 && pending.size > 0; round += 1) {
        const open = Array.from(pending.entries());
        pending.clear();
        open.forEach(([, handle]) => {
            handle.resolve(Uint8Array.from(new Array(16).fill(fill)).buffer);
        });
        await settle();
    }
}

function hitCells(): number {
    return document.querySelectorAll('.hex-hit-active').length;
}

function pressKey(key: string): void {
    document.getElementById('hex-view-region')!.dispatchEvent(new KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true,
    }));
}

beforeEach(async () => {
    tauri = installTauriMock();
    await seedDeCatalog();
    pending.clear();
    configureHexViewForTests();
    mountDom();
    vi.stubGlobal('ResizeObserver', class {
        observe(): void { /* noop */ }
        unobserve(): void { /* noop */ }
        disconnect(): void { /* noop */ }
    });
    tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
        if (cmd !== 'read_file_chunk') return Promise.resolve(undefined);
        const key = chunkKey(
            Number(args?.tabId),
            Number(args?.revision),
            Number(args?.offset),
        );
        return new Promise((resolve, reject) => {
            pending.set(key, { resolve, reject });
        });
    });
});

afterEach(() => {
    clearHexView();
    configureHexViewForTests();
    vi.unstubAllGlobals();
});

describe('view/hex', () => {
    it('isBinaryDocument matcht nur binary', () => {
        expect(isBinaryDocument('binary')).toBe(true);
        expect(isBinaryDocument('image')).toBe(false);
        expect(isBinaryDocument('text')).toBe(false);
    });

    it('mountet die erste Zeile byteweise nach dem Chunk', async () => {
        const sample = [
            0x46, 0x6f, 0x6c, 0x69, 0x6f, 0x00, 0x48, 0x45,
            0x58, 0x20, 0x76, 0x69, 0x65, 0x77, 0x21, 0x0a,
        ];
        mountHexView({ path: '/tmp/a.bin', fileSize: sample.length, revision: 1, tabId: 7 });
        expect(getHexViewState().status).toBe('loading');
        const key = chunkKey(7, 1, 0);
        expect(pending.has(key)).toBe(true);
        pending.get(key)!.resolve(bytes(sample));
        await settle();
        const state = getHexViewState();
        expect(state.status).toBe('ready');
        expect(state.path).toBe('/tmp/a.bin');
        expect(state.windowStart).toBe(0);
        expect(state.loadedChunks).toEqual([0]);
        expect(state.firstLine?.offset).toBe('00000000');
        expect(state.firstLine?.ascii).toBe('Folio.HEX view!.');
        expect(document.querySelector('.hex-row .hex-ascii')?.textContent).toBe('Folio.HEX view!.');
    });

    it('verwirft veralteten Erfolg nach Remount', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        const first = pending.get(chunkKey(1, 1, 0))!;
        mountHexView({ path: '/tmp/b.bin', fileSize: 16, revision: 2, tabId: 1 });
        const second = pending.get(chunkKey(1, 2, 0))!;
        first.resolve(bytes([0x41, 0x41, 0x41, 0x41]));
        await settle();
        expect(getHexViewState().revision).toBe(2);
        expect(document.querySelector('.hex-ascii')?.textContent || '').not.toContain('AAAA');
        second.resolve(bytes([0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42]));
        await settle();
        expect(getHexViewState().firstLine?.ascii.startsWith('BBBB')).toBe(true);
    });

    it('verwirft veralteten Fehler nach Remount', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        const first = pending.get(chunkKey(1, 1, 0))!;
        mountHexView({ path: '/tmp/b.bin', fileSize: 16, revision: 2, tabId: 1 });
        first.reject('disk exploded');
        await settle();
        expect(getHexViewState().status).not.toBe('error');
        expect(getHexViewState().error).toBeNull();
    });

    it('verwirft stale:-Fehler still', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.reject('stale:revision 1 != 2');
        await settle();
        expect(getHexViewState().status).not.toBe('error');
        expect(getHexViewState().error).toBeNull();
    });

    it('zeigt einen Lesefehler sichtbar', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.reject('EACCES');
        await settle();
        expect(getHexViewState().status).toBe('error');
        expect(getHexViewState().error).toBeTruthy();
        const status = document.getElementById('hex-view-status')!;
        expect(status.hidden).toBe(false);
        expect(document.getElementById('hex-view-retry')!.hidden).toBe(false);
    });

    it('dedupliziert identische Blockanfragen', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 32, revision: 1, tabId: 1 });
        const calls = tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk');
        expect(calls.length).toBe(1);
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(new Array(32).fill(1)));
        await settle();
        document.getElementById('hex-view-mount')!.dispatchEvent(new Event('scroll', { bubbles: true }));
        await settle();
        const after = tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk');
        expect(after.length).toBe(1);
    });

    it('begrenzt gleichzeitige Reads auf 4', async () => {
        configureHexViewForTests({ chunkBytes: 16, maxInflight: 4 });
        mountHexView({ path: '/tmp/big.bin', fileSize: 16 * 8, revision: 1, tabId: 1 });
        await settle();
        expect(pending.size).toBe(4);
        const firstKey = [...pending.keys()][0]!;
        pending.get(firstKey)!.resolve(bytes(new Array(16).fill(0)));
        await settle();
        expect(pending.size).toBeGreaterThanOrEqual(4);
    });

    it('zeigt den Leerzustand nach Truncate auf 0', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(new Array(16).fill(7)));
        await settle();
        reloadHexView({ fileSize: 0, revision: 2, available: true });
        expect(getHexViewState().status).toBe('empty');
        expect(document.getElementById('hex-view-status-text')!.textContent).toContain('leer');
    });

    it('zeigt Unavailable mit Wiederholen', () => {
        mountHexView({
            path: '/tmp/a.bin',
            fileSize: 16,
            revision: 1,
            tabId: 1,
            available: false,
        });
        expect(getHexViewState().status).toBe('unavailable');
        expect(document.getElementById('hex-view-retry')!.hidden).toBe(false);
        expect(tauri.invoke.mock.calls.some((c) => c[0] === 'read_file_chunk')).toBe(false);
    });

    it('meldet ungueltigen Offset sichtbar', () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        const input = document.getElementById('hex-view-goto') as HTMLInputElement;
        input.value = 'nope';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(document.getElementById('hex-view-goto-error')!.textContent).toBeTruthy();
    });

    it('haelt die Position je Tab und setzt bei Dokumentwechsel zurueck', async () => {
        configureHexViewForTests({ chunkBytes: 16 });
        const page = 4 * 1024 * 1024;
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(new Array(16).fill(1)));
        await settle();
        const next = document.getElementById('hex-view-next') as HTMLButtonElement;
        expect(next.disabled).toBe(false);
        next.click();
        expect(getHexViewState().windowStart).toBe(page);
        mountHexView({ path: '/tmp/b.bin', fileSize: page + 32, revision: 1, tabId: 2 });
        expect(getHexViewState().windowStart).toBe(0);
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        expect(getHexViewState().windowStart).toBe(page);
        mountHexView({ path: '/tmp/c.bin', fileSize: 16, revision: 3, tabId: 1 });
        expect(getHexViewState().windowStart).toBe(0);
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        expect(getHexViewState().windowStart).toBe(page);
    });

    it('haelt nach Fehler und stale weitere invoke-Aufrufe an', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(1);
        pending.get(chunkKey(1, 1, 0))!.reject('EACCES');
        await settle();
        expect(getHexViewState().status).toBe('error');
        expect(getHexFetchStats().paused).toBe(true);
        const afterError = tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk').length;
        document.getElementById('hex-view-mount')!.dispatchEvent(new Event('scroll', { bubbles: true }));
        await settle();
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(afterError);

        clearHexView();
        configureHexViewForTests();
        mountDom();
        mountHexView({ path: '/tmp/b.bin', fileSize: 16, revision: 2, tabId: 1 });
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(afterError + 1);
        pending.get(chunkKey(1, 2, 0))!.reject('stale:revision 2 != 3');
        await settle();
        expect(getHexViewState().status).not.toBe('error');
        expect(getHexFetchStats().paused).toBe(true);
        const afterStale = tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk').length;
        document.getElementById('hex-view-mount')!.dispatchEvent(new Event('scroll', { bubbles: true }));
        await settle();
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(afterStale);
    });

    it('zaehlt alte Reads nach Generationswechsel weiter und haelt das Limit', async () => {
        configureHexViewForTests({ chunkBytes: 16, maxInflight: 4 });
        mountHexView({ path: '/tmp/a.bin', fileSize: 16 * 8, revision: 1, tabId: 1 });
        await settle();
        expect(getHexFetchStats().active).toBe(4);
        const oldKeys = [...pending.keys()];
        expect(oldKeys).toHaveLength(4);
        mountHexView({ path: '/tmp/b.bin', fileSize: 16 * 8, revision: 1, tabId: 2 });
        await settle();
        expect(getHexFetchStats().active).toBe(4);
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(4);
        for (const key of oldKeys) {
            pending.get(key)!.resolve(bytes(new Array(16).fill(9)));
        }
        await settle();
        expect(getHexFetchStats().active).toBeLessThanOrEqual(4);
        expect(getHexFetchStats().active).toBeGreaterThan(0);
        const started = tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk');
        expect(started.length).toBeGreaterThan(4);
        expect(started.length).toBeLessThanOrEqual(8);
    });

    it('setzt den Offset bei Dokumentwechsel im selben Tab zurueck und raeumt beim Close', async () => {
        configureHexViewForTests({ chunkBytes: 16 });
        const page = 4 * 1024 * 1024;
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(new Array(16).fill(1)));
        await settle();
        (document.getElementById('hex-view-next') as HTMLButtonElement).click();
        expect(getHexViewState().windowStart).toBe(page);
        mountHexView({ path: '/tmp/other.bin', fileSize: page + 32, revision: 2, tabId: 1 });
        expect(getHexViewState().windowStart).toBe(0);
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        expect(getHexViewState().windowStart).toBe(page);
        clearHexView();
        forgetHexOffsetsForTab(1);
        forgetClosedHexTabs([]);
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        expect(getHexViewState().windowStart).toBe(0);
    });

    it('verwirft aeltere und fremde Reload-Events', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 5, tabId: 3 });
        pending.get(chunkKey(3, 5, 0))!.resolve(bytes(new Array(16).fill(1)));
        await settle();
        reloadHexView({ tabId: 9, revision: 8, fileSize: 4 });
        expect(getHexViewState().revision).toBe(5);
        expect(getHexViewState().fileSize).toBe(16);
        reloadHexView({ tabId: 3, revision: 4, fileSize: 4 });
        expect(getHexViewState().revision).toBe(5);
        reloadHexView({ tabId: 3, revision: 6, fileSize: 8, available: true });
        expect(getHexViewState().revision).toBe(6);
        expect(getHexViewState().fileSize).toBe(8);
    });

    it('Remount mit gecachtem Start-Chunk wird ready ohne neuen invoke', async () => {
        const sample = new Array(16).fill(0x41);
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(sample));
        await settle();
        expect(getHexViewState().status).toBe('ready');
        const before = tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk').length;
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        await settle();
        expect(getHexViewState().status).toBe('ready');
        expect(getHexViewState().firstLine?.ascii.startsWith('A')).toBe(true);
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(before);
    });

    it('wendet einen Same-Key-Read nach Generationswechsel noch an', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        const first = pending.get(chunkKey(1, 1, 0))!;
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(1);
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(1);
        expect(getHexViewState().status).toBe('loading');
        first.resolve(bytes(new Array(16).fill(0x42)));
        await settle();
        expect(getHexViewState().status).toBe('ready');
        expect(getHexViewState().firstLine?.ascii.startsWith('B')).toBe(true);
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'read_file_chunk')).toHaveLength(1);
    });

    it('stellt die Position nach Binary → anderes Dokument → History wieder her', async () => {
        configureHexViewForTests({ chunkBytes: 16 });
        const page = 4 * 1024 * 1024;
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(new Array(16).fill(1)));
        await settle();
        (document.getElementById('hex-view-next') as HTMLButtonElement).click();
        expect(getHexViewState().windowStart).toBe(page);
        clearHexView();
        expect(getHexViewState().status).toBe('idle');
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        expect(getHexViewState().windowStart).toBe(page);
    });

    it('liest eine geaenderte Zeilenhoehe aus dem Layout', async () => {
        const proto = HTMLElement.prototype.getBoundingClientRect;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            return {
                x: 0, y: 0, width: 100, height: 24, top: 0, left: 0, bottom: 24, right: 100,
                toJSON() { return {}; },
            } as DOMRect;
        });
        try {
            mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
            expect(getHexViewState().lineHeightPx).toBe(24);
            (HTMLElement.prototype.getBoundingClientRect as ReturnType<typeof vi.fn>).mockImplementation(function () {
                return {
                    x: 0, y: 0, width: 100, height: 36, top: 0, left: 0, bottom: 36, right: 100,
                    toJSON() { return {}; },
                } as DOMRect;
            });
            mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
            expect(getHexViewState().lineHeightPx).toBe(36);
        } finally {
            HTMLElement.prototype.getBoundingClientRect = proto;
        }
    });

    it('markiert einen Treffer ueber die Zeilengrenze in Bytes und ASCII', async () => {
        const data = Array.from({ length: 32 }, (_, i) => i);
        mountHexView({ path: '/tmp/a.bin', fileSize: 32, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(data));
        await settle();
        revealHexOffset(14, 4);
        const rows = document.querySelectorAll('.hex-row');
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(rows[0].querySelectorAll('.hex-hit-active').length).toBe(4);
        expect(rows[1].querySelectorAll('.hex-hit-active').length).toBe(4);
        expect(document.querySelectorAll('.hex-bytes .hex-hit-active').length).toBe(4);
        expect(document.querySelectorAll('.hex-ascii .hex-hit-active').length).toBe(4);
    });

    it('raeumt die Markierung bei Home/End-Spruengen auf', async () => {
        const data = Array.from({ length: 32 }, (_, i) => i);
        mountHexView({ path: '/tmp/a.bin', fileSize: 32, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(data));
        await settle();
        revealHexOffset(14, 4);
        expect(hitCells()).toBe(8);

        pressKey('End');
        expect(hitCells()).toBe(0);
    });

    it('raeumt die Markierung beim Gehe-zu-Offset auf', async () => {
        const data = Array.from({ length: 32 }, (_, i) => i);
        mountHexView({ path: '/tmp/a.bin', fileSize: 32, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(data));
        await settle();
        revealHexOffset(2, 2);
        expect(hitCells()).toBe(4);

        const goto = document.getElementById('hex-view-goto') as HTMLInputElement;
        goto.value = '0x10';
        goto.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));

        expect(hitCells()).toBe(0);
        expect(document.getElementById('hex-view-goto-error')!.textContent).toBe('');
    });

    it('laesst die Markierung nach Vor/Zurueck nicht wieder auftauchen', async () => {
        configureHexViewForTests({ chunkBytes: 16 });
        const page = 4 * 1024 * 1024;
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(new Array(16).fill(0x41)));
        await settle();
        revealHexOffset(0, 4);
        expect(hitCells()).toBe(8);

        (document.getElementById('hex-view-next') as HTMLButtonElement).click();
        expect(getHexViewState().windowStart).toBe(page);
        (document.getElementById('hex-view-prev') as HTMLButtonElement).click();
        await settle();

        expect(getHexViewState().windowStart).toBe(0);
        expect(hitCells()).toBe(0);
    });

    it('haelt die Markierung, wenn die Suche selbst das Fenster wechselt', async () => {
        configureHexViewForTests({ chunkBytes: 16 });
        const page = 4 * 1024 * 1024;
        mountHexView({ path: '/tmp/a.bin', fileSize: page + 32, revision: 1, tabId: 1 });
        await resolveAllPending(0x41);

        revealHexOffset(page + 1, 2);
        expect(getHexViewState().windowStart).toBe(page);
        await resolveAllPending(0x42);

        expect(hitCells()).toBe(4);
    });

    it('meldet Kontextwechsel synchron an den Suchbeobachter', async () => {
        const seen: Array<HexSearchContext | null> = [];
        setHexContextListener((ctx) => { seen.push(ctx); });

        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({ tabId: 1, revision: 1, fileSize: 16, path: '/tmp/a.bin' });

        reloadHexView({ tabId: 1, revision: 2, fileSize: 8 });
        expect(seen).toHaveLength(2);
        expect(seen[1]).toMatchObject({ revision: 2, fileSize: 8 });

        reloadHexView({ tabId: 9, revision: 3, fileSize: 8 });
        expect(seen).toHaveLength(2);

        clearHexView();
        expect(seen[seen.length - 1]).toBeNull();
    });

    it('clearHexView leert State und DOM', async () => {
        mountHexView({ path: '/tmp/a.bin', fileSize: 16, revision: 1, tabId: 1 });
        pending.get(chunkKey(1, 1, 0))!.resolve(bytes(new Array(16).fill(1)));
        await settle();
        clearHexView();
        expect(getHexViewState()).toMatchObject({
            path: '',
            fileSize: 0,
            windowStart: 0,
            error: null,
            status: 'idle',
            tabId: null,
        });
        expect(document.querySelector('.hex-row')).toBeNull();
    });
});
