// Tests fuer vault/search.ts (Such-Panel). Schwerpunkte: Rendering inkl.
// <mark>-Ranges mit Emoji/Umlaut (UTF-16-Offsets), Debounce + stale-runId-
// Verwurf, Event-Puffer vor Start-Antwort, Keyboard-Navigation, Escape,
// Truncation, Options-Retrigger, View-Mode-Sprung (async Finder),
// Strg+Shift+F, Escape-waehrend-ausstehender-Start-Promise.
//
// Das Backend wird ueber den Tauri-Mock simuliert; state/document und
// ui/find-bar werden gemockt, damit der Sprung-Pfad testbar ist.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';

const mocks = vi.hoisted(() => ({
    getCurrentPath: vi.fn(() => '/vault/note.md' as string | null),
    setEditorFindTerm: vi.fn(),
    findNext: vi.fn(),
}));

vi.mock('../../app/state/document', () => ({ getCurrentPath: mocks.getCurrentPath }));
vi.mock('../../app/ui/find-bar', () => ({
    setEditorFindTerm: mocks.setEditorFindTerm,
    findNext: mocks.findNext,
}));

let tauri: TauriMockHandles;
let nextRunId = 1;
let dispose: () => void = () => {};

function buildDom(): void {
    document.body.className = '';
    document.body.innerHTML = `
        <div id="vault-region">
            <ul id="vault-tree"><li>tree</li></ul>
            <div class="vault-search">
                <input id="vault-search-input" type="search" />
                <button id="vault-search-case" aria-pressed="false">Aa</button>
                <button id="vault-search-word" aria-pressed="false">W</button>
                <div id="vault-search-scope" hidden></div>
            </div>
            <div id="vault-search-results" hidden>
                <div id="vault-search-status"></div>
                <div id="vault-search-list"></div>
            </div>
        </div>
    `;
}

function configureInvoke(): void {
    tauri.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
        if (cmd === 'search_options_get') {
            return Promise.resolve({ caseSensitive: false, wholeWord: false });
        }
        return Promise.resolve(undefined);
    });
}

async function flushMicro(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function type(value: string): void {
    const el = document.getElementById('vault-search-input') as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new Event('input'));
}

function key(target: HTMLElement, k: string, opts: Partial<KeyboardEventInit> = {}): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
}

function fileFixture(overrides: any = {}): any {
    return {
        path: '/vault/note.md',
        fileName: 'note.md',
        truncated: false,
        hits: [
            {
                line: 1,
                colUtf16: 6,
                lenUtf16: 6,
                snippet: 'äß😀 needle',
                snippetOffsetUtf16: 0,
                ranges: [[5, 6]],
            },
        ],
        ...overrides,
    };
}

async function importAndInit(overrides: any = {}) {
    const search = await import('../../app/vault/search');
    const deps = { openDocument: vi.fn(), openLeftRail: vi.fn(), ...overrides };
    dispose = search.initVaultSearch(deps);
    return { search, deps };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    nextRunId = 1;
    mocks.getCurrentPath.mockReturnValue('/vault/note.md');
    tauri = installTauriMock();
    configureInvoke();
    buildDom();
});

afterEach(() => {
    dispose();
    dispose = () => {};
    vi.useRealTimers();
});

describe('vault/search — rendering + marks', () => {
    it('rendert <mark> exakt ueber die UTF-16-Ranges (Umlaut + Emoji davor)', async () => {
        vi.useFakeTimers();
        await importAndInit();

        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();

        const list = document.getElementById('vault-search-list')!;
        const mark = list.querySelector('mark');
        expect(mark).not.toBeNull();
        expect(mark!.textContent).toBe('needle');
        expect(list.querySelector('.vs-snippet')!.textContent).toBe('äß😀 needle');
    });

    it('markedSnippet toleriert fehlendes Snippet', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        const f = fileFixture({
            hits: [{ line: 1, colUtf16: 1, lenUtf16: 6, snippet: '', snippetOffsetUtf16: 0, ranges: [] }],
        });
        tauri.emitEvent('search:hits', { runId: 1, files: [f] });
        await flushMicro();
        // Kein Crash, Zeile gerendert.
        expect(document.querySelectorAll('.vs-hit').length).toBe(1);
    });

    it('zeigt Truncation pro Datei (Zaehler + Hinweis) und global im Status', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        const big = fileFixture({
            truncated: true,
            hits: Array.from({ length: 50 }, (_, i) => ({
                line: i + 1, colUtf16: 1, lenUtf16: 6, snippet: 'needle', snippetOffsetUtf16: 0, ranges: [[0, 6]],
            })),
        });
        tauri.emitEvent('search:hits', { runId: 1, files: [big] });
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 12, filesMatched: 1, hits: 500, skippedLarge: 0, truncated: true, elapsedMs: 7 },
        });
        await flushMicro();

        const list = document.getElementById('vault-search-list')!;
        expect(list.querySelector('.vs-count')!.textContent).toBe('50+');
        expect(list.querySelector('.vs-more')).not.toBeNull();
        expect(document.getElementById('vault-search-status')!.textContent).toContain('gekürzt');
    });
});

describe('vault/search — Debounce + Generation', () => {
    it('verwirft Events einer ueberholten Suche und rendert nur den aktuellen Run', async () => {
        vi.useFakeTimers();
        await importAndInit();

        type('aaa');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        type('bbb');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        expect(tauri.invoke).toHaveBeenCalledWith('vault_search_cancel', { runId: 1 });

        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture({ fileName: 'stale.md' })] });
        await flushMicro();
        const list = document.getElementById('vault-search-list')!;
        expect(list.querySelector('.vs-fname')).toBeNull();

        tauri.emitEvent('search:hits', { runId: 2, files: [fileFixture({ fileName: 'fresh.md' })] });
        await flushMicro();
        expect(list.querySelector('.vs-fname')!.textContent).toBe('fresh.md');
    });

    it('puffert hits, die VOR der Start-Antwort eintreffen, und flusht beim Adoptieren', async () => {
        vi.useFakeTimers();
        let resolveStart!: (v: number) => void;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return new Promise<number>((r) => { resolveStart = r; });
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        await importAndInit();

        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        // hits treffen ein, bevor runId adoptiert ist → puffern, noch nichts rendern.
        tauri.emitEvent('search:hits', { runId: 7, files: [fileFixture({ fileName: 'buffered.md' })] });
        await flushMicro();
        const list = document.getElementById('vault-search-list')!;
        expect(list.querySelector('.vs-fname')).toBeNull();

        resolveStart(7);
        await flushMicro();
        expect(list.querySelector('.vs-fname')!.textContent).toBe('buffered.md');
    });

    it('Escape waehrend ausstehender Start-Promise cancelt runId, keine Adoption/Render', async () => {
        vi.useFakeTimers();
        let resolveStart!: (v: number) => void;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return new Promise<number>((r) => { resolveStart = r; });
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        await importAndInit();

        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        const input = document.getElementById('vault-search-input') as HTMLInputElement;
        key(input, 'Escape'); // exitSearch → gen++

        resolveStart(5);
        await flushMicro();

        expect(tauri.invoke).toHaveBeenCalledWith('vault_search_cancel', { runId: 5 });
        // Späte Events für 5 dürfen nichts rendern.
        tauri.emitEvent('search:hits', { runId: 5, files: [fileFixture()] });
        await flushMicro();
        expect(document.getElementById('vault-search-list')!.querySelector('.vs-fname')).toBeNull();
    });

    it('kurze Query (<2 Zeichen) zeigt Hinweis statt Backend-Suche', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('n');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts.length).toBe(0);
        expect(document.getElementById('vault-search-status')!.textContent).toContain('2 Zeichen');
    });
});

describe('vault/search — Optionen', () => {
    it('Toggle re-triggert die Suche genau einmal (kein Doppel-Lauf) mit neuer Option', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        const caseBtn = document.getElementById('vault-search-case')!;
        caseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();

        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts.length).toBe(2); // 1x tippen + 1x toggle
        expect(starts[1][1]).toMatchObject({ query: 'needle', caseSensitive: true });
        expect(caseBtn.getAttribute('aria-pressed')).toBe('true');
    });
});

describe('vault/search — Keyboard + Escape', () => {
    it('ArrowDown/Up bewegt die aktive Auswahl, Enter oeffnet', async () => {
        vi.useFakeTimers();
        const { deps } = await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        const twoHits = fileFixture({
            hits: [
                { line: 3, colUtf16: 1, lenUtf16: 6, snippet: 'needle a', snippetOffsetUtf16: 0, ranges: [[0, 6]] },
                { line: 9, colUtf16: 1, lenUtf16: 6, snippet: 'needle b', snippetOffsetUtf16: 0, ranges: [[0, 6]] },
            ],
        });
        tauri.emitEvent('search:hits', { runId: 1, files: [twoHits] });
        await flushMicro();

        const input = document.getElementById('vault-search-input') as HTMLInputElement;
        const list = document.getElementById('vault-search-list')!;
        key(input, 'ArrowDown');
        expect(list.querySelectorAll('.vs-hit')[0].classList.contains('active')).toBe(true);
        key(input, 'ArrowDown');
        expect(list.querySelectorAll('.vs-hit')[1].classList.contains('active')).toBe(true);
        key(input, 'ArrowUp');
        expect(list.querySelectorAll('.vs-hit')[0].classList.contains('active')).toBe(true);
        key(input, 'Enter');
        expect(deps.openDocument).toHaveBeenCalledWith('/vault/note.md');
    });

    it('eingeklappte Gruppe wird von der Navigation uebersprungen', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        const twoFiles = [
            fileFixture({ path: '/vault/a.md', fileName: 'a.md' }),
            fileFixture({ path: '/vault/b.md', fileName: 'b.md' }),
        ];
        tauri.emitEvent('search:hits', { runId: 1, files: twoFiles });
        await flushMicro();

        // Erste Gruppe einklappen.
        const heads = document.querySelectorAll('.vs-group-head');
        (heads[0] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();

        const input = document.getElementById('vault-search-input') as HTMLInputElement;
        key(input, 'ArrowDown'); // erster sichtbarer Treffer = b.md
        const active = document.querySelector('.vs-hit.active') as HTMLElement;
        expect(active.getAttribute('data-file-idx')).toBe('1'); // b.md, nicht die eingeklappte a.md
    });

    it('Escape leert die Suche und stellt den Baum wieder her', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('needle');
        const region = document.getElementById('vault-region')!;
        expect(region.classList.contains('vault-searching')).toBe(true);
        const input = document.getElementById('vault-search-input') as HTMLInputElement;
        key(input, 'Escape');
        expect(input.value).toBe('');
        expect(region.classList.contains('vault-searching')).toBe(false);
        expect((document.getElementById('vault-search-results') as HTMLElement).hidden).toBe(true);
    });
});

describe('vault/search — Klick + Sprung', () => {
    it('normaler Klick auf einen Treffer ruft openDocument', async () => {
        vi.useFakeTimers();
        const { deps } = await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        (document.querySelector('.vs-hit') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(deps.openDocument).toHaveBeenCalledWith('/vault/note.md');
    });

    it('Ctrl+Klick oeffnet in neuem Tab (tab_open)', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        (document.querySelector('.vs-hit') as HTMLElement)
            .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        expect(tauri.invoke).toHaveBeenCalledWith('tab_open', { path: '/vault/note.md' });
    });

    it('View-Mode-Sprung wartet auf den asynchronen Finder und aktiviert das Ziel-Ordinal', async () => {
        vi.useFakeTimers();
        const { deps } = await importAndInit({ openDocument: vi.fn() });
        document.body.className = ''; // View-Mode (kein edit/split)
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        const twoHits = fileFixture({
            hits: [
                { line: 3, colUtf16: 1, lenUtf16: 6, snippet: 'x needle', snippetOffsetUtf16: 0, ranges: [[2, 6]] },
                { line: 9, colUtf16: 1, lenUtf16: 6, snippet: 'y needle', snippetOffsetUtf16: 0, ranges: [[2, 6]] },
            ],
        });
        tauri.emitEvent('search:hits', { runId: 1, files: [twoHits] });
        await flushMicro();

        // Auf den ZWEITEN Treffer klicken (matchOrdinal = 1).
        const hits = document.querySelectorAll('.vs-hit');
        (hits[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(deps.openDocument).toHaveBeenCalledWith('/vault/note.md');

        // Dokument geladen (state-synchron) → onDocKindChanged → rAF → performViewJump.
        mocks.getCurrentPath.mockReturnValue('/vault/note.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', { detail: { kind: 'markdown' } }));
        await vi.advanceTimersByTimeAsync(20); // rAF
        await flushMicro();

        expect(mocks.setEditorFindTerm).toHaveBeenCalled();
        // Vor dem Finder-Settle darf NICHT iteriert worden sein.
        expect(mocks.findNext).not.toHaveBeenCalled();

        // Finder feuert (u. U. mehrfach) folio-find-state; nach dem letzten
        // Settle (Debounce) wird das Ziel-Ordinal 1 → genau 1x findNext.
        window.dispatchEvent(new CustomEvent('folio-find-state', {
            detail: { source: 'view', term: 'needle', total: 2, active: 0 },
        }));
        window.dispatchEvent(new CustomEvent('folio-find-state', {
            detail: { source: 'view', term: 'needle', total: 2, active: 0 },
        }));
        await vi.advanceTimersByTimeAsync(120); // Settle-Debounce
        await flushMicro();
        expect(mocks.findNext).toHaveBeenCalledTimes(1);
    });
});

describe('vault/search — Strg+Shift+F', () => {
    it('fokussiert das Suchfeld', async () => {
        await importAndInit();
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'F', ctrlKey: true, shiftKey: true, bubbles: true,
        }));
        expect(document.activeElement).toBe(document.getElementById('vault-search-input'));
    });
});

describe('vault/search — Ordner-Scope (S3)', () => {
    it('searchInFolder setzt Chip + re-triggert Suche mit scope', async () => {
        vi.useFakeTimers();
        const { search } = await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        search.searchInFolder('/vault/sub');
        await flushMicro();

        const chip = document.querySelector('#vault-search-scope .vs-scope-chip');
        expect(chip).not.toBeNull();
        expect(chip!.querySelector('.vs-scope-name')!.textContent).toBe('sub');
        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts[starts.length - 1][1]).toMatchObject({ query: 'needle', scope: '/vault/sub' });
    });

    it('Chip-× entfernt den Scope und re-triggert vault-weit', async () => {
        vi.useFakeTimers();
        const { search } = await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        search.searchInFolder('/vault/sub');
        await flushMicro();

        (document.querySelector('.vs-scope-x') as HTMLElement)
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();

        expect(document.getElementById('vault-search-scope')!.hidden).toBe(true);
        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts[starts.length - 1][1]).toMatchObject({ query: 'needle', scope: null });
    });

    it('Scope-Fehler (scope:-Präfix) → Chip weg + Fallback vault-weit', async () => {
        vi.useFakeTimers();
        tauri.invoke.mockImplementation((cmd: string, args: any) => {
            if (cmd === 'vault_search_start') {
                // Backend präfixt Scope-Fehler mit `scope:`.
                if (args && args.scope) return Promise.reject('scope:Suchpfad existiert nicht: /vault/gone');
                return Promise.resolve(nextRunId++);
            }
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        const { search } = await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        search.searchInFolder('/vault/gone'); // → scoped start rejectet mit scope:
        await flushMicro();

        expect(document.getElementById('vault-search-scope')!.hidden).toBe(true);
        const scopedStarts = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_search_start' && c[1] && c[1].scope,
        );
        const vaultStarts = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_search_start' && c[1] && !c[1].scope,
        );
        expect(scopedStarts.length).toBe(1); // ein Scope-Versuch
        expect(vaultStarts.length).toBeGreaterThanOrEqual(2); // initial + Fallback
    });

    it('generischer Startfehler (ohne scope:-Präfix) → Scope BLEIBT, kein Fallback', async () => {
        vi.useFakeTimers();
        tauri.invoke.mockImplementation((cmd: string, args: any) => {
            if (cmd === 'vault_search_start') {
                if (args && args.scope) return Promise.reject('irgendein IPC-Fehler');
                return Promise.resolve(nextRunId++);
            }
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        const { search } = await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();

        search.searchInFolder('/vault/x'); // scoped start rejectet generisch
        await flushMicro();

        // Chip bleibt, kein Vault-weiter Fallback.
        expect(document.getElementById('vault-search-scope')!.hidden).toBe(false);
        const scopedStarts = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_search_start' && c[1] && c[1].scope,
        );
        const vaultStarts = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_search_start' && c[1] && !c[1].scope,
        );
        expect(scopedStarts.length).toBe(1);
        expect(vaultStarts.length).toBe(1); // nur der initiale Lauf, kein Fallback
        expect(document.getElementById('vault-search-status')!.textContent).toContain('Fehler');
    });

    it('Status: hits=0 + skippedLarge zeigt beides (Basissatz + Zusatz)', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 2, filesMatched: 0, hits: 0, skippedLarge: 1, truncated: false, elapsedMs: 3 },
        });
        await flushMicro();
        const status = document.getElementById('vault-search-status')!.textContent || '';
        expect(status).toContain('Keine Treffer');
        expect(status).toContain('übersprungen');
    });

    it('Leere-Vault-Hinweis bei filesScanned==0 ohne Scope', async () => {
        vi.useFakeTimers();
        await importAndInit();
        type('needle');
        await vi.advanceTimersByTimeAsync(300);
        await flushMicro();
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 0, filesMatched: 0, hits: 0, skippedLarge: 0, truncated: false, elapsedMs: 1 },
        });
        await flushMicro();
        expect(document.getElementById('vault-search-status')!.textContent).toContain('Keine durchsuchbaren Dateien im Vault');
    });
});
