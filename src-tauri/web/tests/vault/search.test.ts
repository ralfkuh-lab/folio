// Tests fuer vault/search.ts (Such-Panel, S4-Dialog-Modell). Schwerpunkte:
// Rendering inkl. <mark>-Ranges (UTF-16-Offsets), stale-runId-Verwurf,
// Event-Puffer vor Start-Antwort, Keyboard-Navigation auf der Ergebnisliste,
// View-Mode-Sprung (async Finder), Truncation/Status, Dialog-Submit +
// Validierungsfehler, Spinner (vs-running), Auto-Collapse (>10 Gruppen) +
// Collapse/Expand-All, Folder-Draft via Kontextmenue, OpenTabs-Sprung ueber
// activateTab, Strg+Shift+F, Summary-Reopen.
//
// Das Backend wird ueber den Tauri-Mock simuliert; state/document, state/tabs
// und ui/find-bar werden gemockt, damit der Sprung-Pfad testbar ist.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const mocks = vi.hoisted(() => ({
    getCurrentPath: vi.fn(() => '/vault/note.md' as string | null),
    syncEditorTextToStoreRequired: vi.fn(() => Promise.resolve()),
    setEditorFindTerm: vi.fn(),
    findNext: vi.fn(),
    activateTab: vi.fn(() => Promise.resolve(true)),
    findTabIdByPath: vi.fn((_p: string) => null as number | null),
    getActiveTabId: vi.fn(() => 7 as number | null),
}));

vi.mock('../../app/state/document', () => ({
    getCurrentPath: mocks.getCurrentPath,
    syncEditorTextToStoreRequired: mocks.syncEditorTextToStoreRequired,
}));
vi.mock('../../app/state/tabs', () => ({
    activateTab: mocks.activateTab,
    findTabIdByPath: mocks.findTabIdByPath,
    getActiveTabId: mocks.getActiveTabId,
}));
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
            <div class="vault-search">
                <div class="vault-search-bar">
                    <button id="vault-search-summary">
                        <span id="vault-search-summary-text"></span>
                        <span id="vault-search-summary-opts"></span>
                    </button>
                    <button id="vault-search-exit"></button>
                </div>
                <div id="vault-search-scope" hidden></div>
            </div>
            <ul id="vault-tree" class="tree">
                <li class="section" data-section="pinned">
                    <ul class="children">
                        <li class="node" data-path="/vault"></li>
                    </ul>
                </li>
            </ul>
            <div id="vault-search-results" hidden>
                <div id="vault-search-results-head">
                    <button id="vault-search-sort"><span id="vault-search-sort-label"></span></button>
                    <button id="vault-search-paths" aria-pressed="false"></button>
                    <button id="vault-search-collapse-all"></button>
                    <button id="vault-search-expand-all"></button>
                </div>
                <div id="vault-search-status"></div>
                <div id="vault-search-list" tabindex="0"></div>
            </div>
        </div>
        <div id="vault-search-dialog" hidden>
            <div class="vault-search-dialog__panel">
                <div id="vsd-title"></div>
                <input id="vsd-query" type="search" />
                <label><input type="checkbox" id="vsd-case" /></label>
                <label><input type="checkbox" id="vsd-word" /></label>
                <label><input type="checkbox" id="vsd-regex" /></label>
                <input type="radio" name="vsd-filter" value="markdown" />
                <input type="radio" name="vsd-filter" value="allText" checked />
                <input type="radio" name="vsd-filter" value="custom" />
                <input type="text" id="vsd-custom-ext" />
                <input type="radio" name="vsd-scope" value="vault" checked />
                <input type="radio" name="vsd-scope" value="openTabs" />
                <label id="vsd-scope-folder-row" hidden>
                    <input type="radio" name="vsd-scope" value="folder" />
                    <span id="vsd-scope-folder-label"></span>
                </label>
                <div id="vsd-error" hidden></div>
                <button id="vsd-cancel"></button>
                <button id="vsd-submit"></button>
            </div>
        </div>
    `;
}

function configureInvoke(): void {
    tauri.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
        if (cmd === 'vault_search_validate') return Promise.resolve(undefined);
        if (cmd === 'search_options_get') {
            return Promise.resolve({
                caseSensitive: false,
                wholeWord: false,
                regex: false,
                fileFilter: 'allText',
                customExtensions: '',
            });
        }
        return Promise.resolve(undefined);
    });
}

async function flushMicro(): Promise<void> {
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

function $(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
}

function setRadio(name: string, value: string): void {
    const el = document.querySelector(
        `input[name="${name}"][value="${value}"]`,
    ) as HTMLInputElement;
    el.checked = true;
}

function key(target: HTMLElement, k: string, opts: Partial<KeyboardEventInit> = {}): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
}

interface SearchOpts {
    case?: boolean;
    word?: boolean;
    regex?: boolean;
    filter?: string;
    ext?: string;
    scope?: string;
    folder?: string;
}

/** Öffnet den Dialog, füllt ihn und submittet. */
async function runSearch(query: string, opts: SearchOpts = {}): Promise<void> {
    const search = await import('../../app/vault/search');
    search.openVaultSearchDialog(opts.folder ? { folder: opts.folder } : undefined);
    ($('vsd-query') as HTMLInputElement).value = query;
    ($('vsd-case') as HTMLInputElement).checked = !!opts.case;
    ($('vsd-regex') as HTMLInputElement).checked = !!opts.regex;
    ($('vsd-word') as HTMLInputElement).checked = !!opts.word;
    if (opts.filter) setRadio('vsd-filter', opts.filter);
    if (opts.ext !== undefined) ($('vsd-custom-ext') as HTMLInputElement).value = opts.ext;
    if (opts.scope) setRadio('vsd-scope', opts.scope);
    $('vsd-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicro();
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

function manyFiles(n: number): any[] {
    return Array.from({ length: n }, (_, i) =>
        fileFixture({ path: `/vault/f${i}.md`, fileName: `f${i}.md` }),
    );
}

async function importAndInit(overrides: any = {}) {
    const search = await import('../../app/vault/search');
    const deps = { openDocument: vi.fn(), openLeftRail: vi.fn(), ...overrides };
    dispose = search.initVaultSearch(deps);
    return { search, deps };
}

beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await seedDeCatalog();
    nextRunId = 1;
    mocks.getCurrentPath.mockReturnValue('/vault/note.md');
    mocks.findTabIdByPath.mockReturnValue(null);
    mocks.getActiveTabId.mockReturnValue(7);
    mocks.syncEditorTextToStoreRequired.mockResolvedValue(undefined);
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
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();

        const list = $('vault-search-list');
        const mark = list.querySelector('mark');
        expect(mark).not.toBeNull();
        expect(mark!.textContent).toBe('needle');
        expect(list.querySelector('.vs-snippet')!.textContent).toBe('äß😀 needle');
    });

    it('zeigt Truncation pro Datei (Zaehler + Hinweis) und global im Status', async () => {
        await importAndInit();
        await runSearch('needle');
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

        const list = $('vault-search-list');
        expect(list.querySelector('.vs-count')!.textContent).toBe('50+');
        expect(list.querySelector('.vs-more')).not.toBeNull();
        expect($('vault-search-status').textContent).toContain('gekürzt');
    });
});

describe('vault/search — Stale-Guard + Puffer', () => {
    it('verwirft Events einer ueberholten Suche und rendert nur den aktuellen Run', async () => {
        await importAndInit();
        await runSearch('aaa');
        await runSearch('bbb');

        expect(tauri.invoke).toHaveBeenCalledWith('vault_search_cancel', { runId: 1 });

        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture({ fileName: 'stale.md' })] });
        await flushMicro();
        const list = $('vault-search-list');
        expect(list.querySelector('.vs-fname')).toBeNull();

        tauri.emitEvent('search:hits', { runId: 2, files: [fileFixture({ fileName: 'fresh.md' })] });
        await flushMicro();
        expect(list.querySelector('.vs-fname')!.textContent).toBe('fresh.md');
    });

    it('puffert hits, die VOR der Start-Antwort eintreffen, und flusht beim Adoptieren', async () => {
        let resolveStart!: (v: number) => void;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return new Promise<number>((r) => { resolveStart = r; });
            if (cmd === 'vault_search_validate') return Promise.resolve(undefined);
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('needle');

        tauri.emitEvent('search:hits', { runId: 7, files: [fileFixture({ fileName: 'buffered.md' })] });
        await flushMicro();
        const list = $('vault-search-list');
        expect(list.querySelector('.vs-fname')).toBeNull();

        resolveStart(7);
        await flushMicro();
        expect(list.querySelector('.vs-fname')!.textContent).toBe('buffered.md');
    });
});

describe('vault/search — Dialog', () => {
    it('Validierungsfehler hält den Dialog offen und startet keine Suche', async () => {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_validate') return Promise.reject('Ungültiger Ausdruck');
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('[bad');

        expect(($('vault-search-dialog') as HTMLElement).hidden).toBe(false);
        expect($('vsd-error').hidden).toBe(false);
        expect($('vsd-error').textContent).toContain('Ungültiger Ausdruck');
        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts.length).toBe(0);
    });

    it('Submit committed Optionen + startet Suche + rendert Summary', async () => {
        await importAndInit();
        await runSearch('needle', { case: true, regex: true });

        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts.length).toBe(1);
        // Regex an → wholeWord false (Checkbox war disabled).
        expect(starts[0][1]).toMatchObject({
            query: 'needle', caseSensitive: true, regex: true, wholeWord: false, fileFilter: 'allText', openTabs: false,
        });
        expect(tauri.invoke).toHaveBeenCalledWith(
            'set_search_options',
            expect.objectContaining({ caseSensitive: true, regex: true }),
        );
        expect(($('vault-search-dialog') as HTMLElement).hidden).toBe(true);
        expect($('vault-search-summary-text').textContent).toBe('needle');
    });

    it('Strg+Shift+F oeffnet den Dialog', async () => {
        await importAndInit();
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'F', ctrlKey: true, shiftKey: true, bubbles: true,
        }));
        expect(($('vault-search-dialog') as HTMLElement).hidden).toBe(false);
    });

    it('Summary-Reopen fuellt das Query-Feld mit dem committed Begriff', async () => {
        const { search } = await importAndInit();
        await runSearch('needle');
        // Dialog ist zu; erneut oeffnen (Summary-Klick).
        search.openVaultSearchDialog();
        expect(($('vsd-query') as HTMLInputElement).value).toBe('needle');
    });

    it('searchInFolder oeffnet den Dialog mit Folder-Draft (ohne committed Scope-Wechsel)', async () => {
        const { search } = await importAndInit();
        search.searchInFolder('/vault/sub');
        expect(($('vault-search-dialog') as HTMLElement).hidden).toBe(false);
        expect($('vsd-scope-folder-row').hidden).toBe(false);
        expect($('vsd-scope-folder-label').textContent).toContain('sub');
        // Noch kein Lauf gestartet (nur Draft).
        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts.length).toBe(0);

        // Submit mit Folder-Scope → scope wird durchgereicht.
        ($('vsd-query') as HTMLInputElement).value = 'needle';
        setRadio('vsd-scope', 'folder');
        $('vsd-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        const scoped = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(scoped[0][1]).toMatchObject({ query: 'needle', scope: '/vault/sub', openTabs: false });
    });
});

describe('vault/search — Spinner', () => {
    it('setzt vs-running beim Start und raeumt bei done auf', async () => {
        await importAndInit();
        await runSearch('needle');
        expect($('vault-search-status').classList.contains('vs-running')).toBe(true);
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 3, filesMatched: 0, hits: 0, skippedLarge: 0, truncated: false, elapsedMs: 2 },
        });
        await flushMicro();
        expect($('vault-search-status').classList.contains('vs-running')).toBe(false);
    });

    it('stale done aendert den Spinner-Zustand nicht', async () => {
        await importAndInit();
        await runSearch('aaa');
        await runSearch('bbb'); // runId 2 laeuft, Spinner an
        // done fuer den alten Lauf 1 → ignoriert.
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 1, filesMatched: 0, hits: 0, skippedLarge: 0, truncated: false, elapsedMs: 1 },
        });
        await flushMicro();
        expect($('vault-search-status').classList.contains('vs-running')).toBe(true);
    });

    it('Start-Rejection raeumt vs-running auf', async () => {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return Promise.reject('boom');
            if (cmd === 'vault_search_validate') return Promise.resolve(undefined);
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('needle');
        expect($('vault-search-status').classList.contains('vs-running')).toBe(false);
    });

    it('Cancel vor Adoption raeumt vs-running auf und adoptiert die spaete Antwort nicht', async () => {
        let resolveStart!: (v: number) => void;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return new Promise<number>((r) => { resolveStart = r; });
            if (cmd === 'vault_search_validate') return Promise.resolve(undefined);
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('needle');
        expect($('vault-search-status').classList.contains('vs-running')).toBe(true);
        // Escape verlaesst die Suche, bevor der Start adoptiert ist → Spinner weg.
        key($('vault-search-list'), 'Escape');
        expect($('vault-search-status').classList.contains('vs-running')).toBe(false);
        // Spaete Start-Antwort darf den Spinner nicht re-armen; der verwaiste
        // Lauf wird gecancelt.
        resolveStart(5);
        await flushMicro();
        expect($('vault-search-status').classList.contains('vs-running')).toBe(false);
        expect(tauri.invoke).toHaveBeenCalledWith('vault_search_cancel', { runId: 5 });
    });

    it('Escape/Exit raeumt vs-running eines laufenden Suchlaufs auf', async () => {
        await importAndInit();
        await runSearch('needle');
        expect($('vault-search-status').classList.contains('vs-running')).toBe(true);
        key($('vault-search-list'), 'Escape');
        expect($('vault-search-status').classList.contains('vs-running')).toBe(false);
    });

    it('Scope-Fallback: toter Ordner-Scope startet vault-weit neu, Spinner laeuft am Neustart weiter und raeumt bei done auf', async () => {
        // Erster Start (Folder-Scope) rejectet mit `scope:`-Praefix → Fallback:
        // Chip weg, vault-weiter Neustart. Der Neustart setzt vs-running neu; es
        // darf kein haengender Spinner bleiben, und der Neustart-`done` raeumt auf.
        let startCalls = 0;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') {
                startCalls++;
                if (startCalls === 1) return Promise.reject('scope:RootNotFound');
                return Promise.resolve(nextRunId++);
            }
            if (cmd === 'vault_search_validate') return Promise.resolve(undefined);
            if (cmd === 'search_options_get') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('needle', { folder: '/vault/sub', scope: 'folder' });

        // Genau ein Fallback-Neustart, jetzt vault-weit (scope: null).
        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts.length).toBe(2);
        expect(starts[0][1]).toMatchObject({ scope: '/vault/sub' });
        expect(starts[1][1]).toMatchObject({ scope: null, openTabs: false });

        // Scope-Chip ist entfernt und der Fallback-Hinweis steht im Status …
        expect(($('vault-search-scope') as HTMLElement).hidden).toBe(true);
        expect($('vault-search-status').textContent).toContain('gesamten Vault');
        // … waehrend der Neustart den Spinner weiter fuehrt (kein Haenger).
        expect($('vault-search-status').classList.contains('vs-running')).toBe(true);

        // Der Fallback-Lauf (runId 1) raeumt vs-running bei done auf.
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 3, filesMatched: 0, hits: 0, skippedLarge: 0, truncated: false, elapsedMs: 2 },
        });
        await flushMicro();
        expect($('vault-search-status').classList.contains('vs-running')).toBe(false);
    });
});

describe('vault/search — Auto-Collapse + Collapse/Expand-All', () => {
    it('klappt ab >10 Treffergruppen automatisch ein; spaetere Gruppen folgen', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: manyFiles(11) });
        await flushMicro();
        // Alle 11 Gruppen eingeklappt.
        expect(document.querySelectorAll('.vs-hits[hidden]').length).toBe(11);

        // Nachstroemende Gruppe kommt ebenfalls eingeklappt.
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture({ path: '/vault/late.md', fileName: 'late.md' })] });
        await flushMicro();
        expect(document.querySelectorAll('.vs-hits[hidden]').length).toBe(12);
    });

    it('Expand-All klappt alles auf; danach kommen neue Gruppen offen', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: manyFiles(11) });
        await flushMicro();
        $('vault-search-expand-all').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.querySelectorAll('.vs-hits[hidden]').length).toBe(0);

        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture({ path: '/vault/x.md', fileName: 'x.md' })] });
        await flushMicro();
        expect(document.querySelectorAll('.vs-hits[hidden]').length).toBe(0);
    });

    it('Collapse-All klappt alles ein', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/a.md', fileName: 'a.md' }), fileFixture({ path: '/vault/b.md', fileName: 'b.md' })],
        });
        await flushMicro();
        expect(document.querySelectorAll('.vs-hits[hidden]').length).toBe(0);
        $('vault-search-collapse-all').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.querySelectorAll('.vs-hits[hidden]').length).toBe(2);
    });
});

describe('vault/search — Keyboard + Klick + Sprung', () => {
    it('ArrowDown/Up bewegt die aktive Auswahl auf der Liste, Enter oeffnet', async () => {
        const { deps } = await importAndInit();
        await runSearch('needle');
        const twoHits = fileFixture({
            hits: [
                { line: 3, colUtf16: 1, lenUtf16: 6, snippet: 'needle a', snippetOffsetUtf16: 0, ranges: [[0, 6]] },
                { line: 9, colUtf16: 1, lenUtf16: 6, snippet: 'needle b', snippetOffsetUtf16: 0, ranges: [[0, 6]] },
            ],
        });
        tauri.emitEvent('search:hits', { runId: 1, files: [twoHits] });
        await flushMicro();

        const list = $('vault-search-list');
        key(list, 'ArrowDown');
        expect(list.querySelectorAll('.vs-hit')[0].classList.contains('active')).toBe(true);
        key(list, 'ArrowDown');
        expect(list.querySelectorAll('.vs-hit')[1].classList.contains('active')).toBe(true);
        key(list, 'ArrowUp');
        expect(list.querySelectorAll('.vs-hit')[0].classList.contains('active')).toBe(true);
        key(list, 'Enter');
        expect(deps.openDocument).toHaveBeenCalledWith('/vault/note.md');
    });

    it('Escape auf der Liste verlaesst die Suche', async () => {
        await importAndInit();
        await runSearch('needle');
        const region = $('vault-region');
        expect(region.classList.contains('vault-searching')).toBe(true);
        key($('vault-search-list'), 'Escape');
        expect(region.classList.contains('vault-searching')).toBe(false);
        expect(($('vault-search-results') as HTMLElement).hidden).toBe(true);
    });

    it('normaler Klick ruft openDocument (Vault-Scope)', async () => {
        const { deps } = await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        ($('vault-search-list').querySelector('.vs-hit') as HTMLElement)
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(deps.openDocument).toHaveBeenCalledWith('/vault/note.md');
    });

    it('Ctrl+Klick oeffnet in neuem Tab (tab_open)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        ($('vault-search-list').querySelector('.vs-hit') as HTMLElement)
            .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        expect(tauri.invoke).toHaveBeenCalledWith('tab_open', { path: '/vault/note.md' });
    });

    it('OpenTabs-Sprung aktiviert den Tab statt openDocument', async () => {
        mocks.findTabIdByPath.mockReturnValue(42);
        mocks.getActiveTabId.mockReturnValue(7); // anderer Tab aktiv
        const { deps } = await importAndInit();
        await runSearch('needle', { scope: 'openTabs' });
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        ($('vault-search-list').querySelector('.vs-hit') as HTMLElement)
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(mocks.activateTab).toHaveBeenCalledWith(42);
        expect(deps.openDocument).not.toHaveBeenCalled();
    });

    it('OpenTabs-Sprung: geschlossener Tab (findTabIdByPath→null) oeffnet NICHT nach', async () => {
        // [Sol#2] Tab seit dem Snapshot geschlossen: der OpenTabs-Zweig darf
        // NIEMALS in tab_open/openDocument durchfallen — sonst würde ein
        // verworfener dirty Puffer über den Disk-Inhalt geöffnet.
        mocks.findTabIdByPath.mockReturnValue(null);
        const { deps } = await importAndInit();
        await runSearch('needle', { scope: 'openTabs' });
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        ($('vault-search-list').querySelector('.vs-hit') as HTMLElement)
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(deps.openDocument).not.toHaveBeenCalled();
        const tabOpens = tauri.invoke.mock.calls.filter((c) => c[0] === 'tab_open');
        expect(tabOpens.length).toBe(0);
        expect(mocks.activateTab).not.toHaveBeenCalled();
        // Stattdessen: lokalisierter "veraltet"-Status.
        expect($('vault-search-status').textContent).toContain('nicht mehr aktuell');
    });

    it('OpenTabs-Submit synchronisiert den Editor-Puffer vor dem Snapshot', async () => {
        await importAndInit();
        await runSearch('needle', { scope: 'openTabs' });
        expect(mocks.syncEditorTextToStoreRequired).toHaveBeenCalled();
        const starts = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
        expect(starts[0][1]).toMatchObject({ openTabs: true, scope: null });
    });

    it('View-Mode-Sprung wartet auf den asynchronen Finder und aktiviert das Ziel-Ordinal', async () => {
        const { deps } = await importAndInit({ openDocument: vi.fn() });
        await runSearch('needle');
        const twoHits = fileFixture({
            hits: [
                { line: 3, colUtf16: 1, lenUtf16: 6, snippet: 'x needle', snippetOffsetUtf16: 0, ranges: [[2, 6]] },
                { line: 9, colUtf16: 1, lenUtf16: 6, snippet: 'y needle', snippetOffsetUtf16: 0, ranges: [[2, 6]] },
            ],
        });
        tauri.emitEvent('search:hits', { runId: 1, files: [twoHits] });
        await flushMicro();

        vi.useFakeTimers();
        const hits = $('vault-search-list').querySelectorAll('.vs-hit');
        (hits[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(deps.openDocument).toHaveBeenCalledWith('/vault/note.md');

        mocks.getCurrentPath.mockReturnValue('/vault/note.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', { detail: { kind: 'markdown' } }));
        await vi.advanceTimersByTimeAsync(20); // rAF
        await flushMicro();

        expect(mocks.setEditorFindTerm).toHaveBeenCalled();
        expect(mocks.findNext).not.toHaveBeenCalled();

        window.dispatchEvent(new CustomEvent('folio-find-state', {
            detail: { source: 'view', term: 'needle', total: 2, active: 0 },
        }));
        await vi.advanceTimersByTimeAsync(120); // Settle-Debounce
        await flushMicro();
        expect(mocks.findNext).toHaveBeenCalledTimes(1);
    });
});

describe('vault/search — S5 Suche beenden (× / Escape)', () => {
    it('× beendet die Suche (Ergebnisse weg, Suchmodus aus)', async () => {
        await importAndInit();
        await runSearch('needle');
        const region = $('vault-region');
        expect(region.classList.contains('vault-searching')).toBe(true);
        $('vault-search-exit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(region.classList.contains('vault-searching')).toBe(false);
        expect(($('vault-search-results') as HTMLElement).hidden).toBe(true);
    });

    it('Escape auf dem Summary-Button beendet die Suche (bubbelt zur Region)', async () => {
        await importAndInit();
        await runSearch('needle');
        const region = $('vault-region');
        expect(region.classList.contains('vault-searching')).toBe(true);
        key($('vault-search-summary'), 'Escape');
        expect(region.classList.contains('vault-searching')).toBe(false);
    });

    it('× verschiebt den Fokus vom ausgeblendeten Exit-Button auf den Summary-Button', async () => {
        await importAndInit();
        await runSearch('needle');
        const exit = $('vault-search-exit');
        exit.focus();
        expect(document.activeElement).toBe(exit);
        exit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // Exit-Button ist jetzt display:none → Fokus liegt auf dem Summary.
        expect(document.activeElement).toBe($('vault-search-summary'));
    });

    it('Escape aus der Ergebnisliste verschiebt den Fokus auf den Summary-Button', async () => {
        await importAndInit();
        await runSearch('needle');
        const list = $('vault-search-list');
        list.focus();
        expect(document.activeElement).toBe(list);
        key(list, 'Escape');
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
        expect(document.activeElement).toBe($('vault-search-summary'));
    });

    it('Exit ohne Fokus im Suchbereich laesst den Fokus unangetastet', async () => {
        await importAndInit();
        await runSearch('needle');
        // Fokus liegt außerhalb (z. B. Body) → kein Fokus-Diebstahl.
        (document.activeElement as HTMLElement | null)?.blur?.();
        key($('vault-region'), 'Escape');
        expect(document.activeElement).not.toBe($('vault-search-summary'));
    });

    it('Escape feuert nicht, wenn kein Suchmodus aktiv ist', async () => {
        await importAndInit();
        const region = $('vault-region');
        expect(region.classList.contains('vault-searching')).toBe(false);
        // Darf nicht crashen und nichts umschalten.
        key(region, 'Escape');
        expect(region.classList.contains('vault-searching')).toBe(false);
    });
});

describe('vault/search — S5 Sortierung', () => {
    function names(): string[] {
        return Array.from($('vault-search-list').querySelectorAll('.vs-fname')).map(
            (e) => e.textContent || '',
        );
    }

    it('none → name → path zyklisch; Reihenfolge folgt dem Modus', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/vault/z/a.md', fileName: 'a.md' }),
                fileFixture({ path: '/vault/a/c.md', fileName: 'c.md' }),
                fileFixture({ path: '/vault/m/b.md', fileName: 'b.md' }),
            ],
        });
        await flushMicro();
        // none = Fundreihenfolge.
        expect(names()).toEqual(['a.md', 'c.md', 'b.md']);

        // Klick → name.
        $('vault-search-sort').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(names()).toEqual(['a.md', 'b.md', 'c.md']);
        expect(tauri.invoke).toHaveBeenCalledWith(
            'set_search_options',
            expect.objectContaining({ sort: 'name' }),
        );

        // Klick → path (Namen ergeben sich aus der Pfadordnung a/ < m/ < z/).
        $('vault-search-sort').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(names()).toEqual(['c.md', 'b.md', 'a.md']);
    });

    it('Streaming-Nachzügler wird gemäß Modus stabil einsortiert', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/vault/a.md', fileName: 'a.md' }),
                fileFixture({ path: '/vault/b.md', fileName: 'b.md' }),
                fileFixture({ path: '/vault/c.md', fileName: 'c.md' }),
            ],
        });
        await flushMicro();
        $('vault-search-sort').dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        expect(names()).toEqual(['a.md', 'b.md', 'c.md']);

        // Nachzügler bb.md landet zwischen b.md und c.md.
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/bb.md', fileName: 'bb.md' })],
        });
        await flushMicro();
        expect(names()).toEqual(['a.md', 'b.md', 'bb.md', 'c.md']);
    });

    it('Rueckkehr zu none stellt die Fundreihenfolge wieder her (path → none)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/vault/z/a.md', fileName: 'a.md' }),
                fileFixture({ path: '/vault/a/c.md', fileName: 'c.md' }),
                fileFixture({ path: '/vault/m/b.md', fileName: 'b.md' }),
            ],
        });
        await flushMicro();
        const sort = $('vault-search-sort');
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // path
        expect(names()).toEqual(['c.md', 'b.md', 'a.md']);
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // none
        // Fundreihenfolge wiederhergestellt (nicht die letzte Pfadsortierung).
        expect(names()).toEqual(['a.md', 'c.md', 'b.md']);
        expect(tauri.invoke).toHaveBeenCalledWith(
            'set_search_options',
            expect.objectContaining({ sort: 'none' }),
        );
    });

    it('Streaming-Nachzügler landet nach Sortierwechseln in none an der Ankunftsposition', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/vault/a.md', fileName: 'a.md' }),
                fileFixture({ path: '/vault/c.md', fileName: 'c.md' }),
            ],
        });
        await flushMicro();
        const sort = $('vault-search-sort');
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        // Nachzügler trifft WÄHREND der Namenssortierung ein.
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/b.md', fileName: 'b.md' })],
        });
        await flushMicro();
        expect(names()).toEqual(['a.md', 'b.md', 'c.md']);
        // Zurück auf none (über path): Ankunftsreihenfolge a, c, b.
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // path
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // none
        expect(names()).toEqual(['a.md', 'c.md', 'b.md']);
    });

    it('aktiver Treffer + Arrow-Navigation ueberleben alle Sortierwechsel', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/vault/z/a.md', fileName: 'a.md' }),
                fileFixture({ path: '/vault/a/c.md', fileName: 'c.md' }),
                fileFixture({ path: '/vault/m/b.md', fileName: 'b.md' }),
            ],
        });
        await flushMicro();
        const list = $('vault-search-list');
        const sort = $('vault-search-sort');
        const activePath = (): string | null => {
            const hit = list.querySelector('.vs-hit.active');
            if (!hit) return null;
            const group = hit.closest('.vs-group');
            const head = group && group.querySelector('.vs-group-head');
            return head ? (head as HTMLElement).title : null;
        };

        key(list, 'ArrowDown'); // erster Treffer (Fundreihenfolge) = z/a.md
        expect(activePath()).toBe('/vault/z/a.md');

        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        expect(activePath()).toBe('/vault/z/a.md'); // Anker bleibt

        key(list, 'ArrowDown'); // in Namensordnung folgt b.md
        expect(activePath()).toBe('/vault/m/b.md');

        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // path
        expect(activePath()).toBe('/vault/m/b.md');

        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // none
        expect(activePath()).toBe('/vault/m/b.md');

        key(list, 'ArrowUp'); // in Fundreihenfolge steht davor c.md
        expect(activePath()).toBe('/vault/a/c.md');
    });

    it('gleichnamige Dateien (README.md) sind deterministisch nach Pfad geordnet', async () => {
        await importAndInit();
        await runSearch('needle');
        // In „falscher" Pfadreihenfolge emittieren.
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/vault/z/README.md', fileName: 'README.md' }),
                fileFixture({ path: '/vault/a/README.md', fileName: 'README.md' }),
            ],
        });
        await flushMicro();
        $('vault-search-sort').dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        // Namen identisch → sekundär nach Pfad: a/ vor z/.
        const paths = Array.from($('vault-search-list').querySelectorAll('.vs-group-head')).map(
            (e) => (e as HTMLElement).title,
        );
        expect(paths).toEqual(['/vault/a/README.md', '/vault/z/README.md']);
    });
});

describe('vault/search — S5 Pfadanzeige-Toggle', () => {
    it('blendet Verzeichnispfade ein/aus und persistiert die Wahl', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/sub/deep.md', fileName: 'deep.md' })],
        });
        await flushMicro();
        // Aus: kein Pfad-Span.
        expect($('vault-search-list').querySelector('.vs-fpath')).toBeNull();

        $('vault-search-paths').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const fpath = $('vault-search-list').querySelector('.vs-fpath');
        expect(fpath).not.toBeNull();
        // Relativ zur Pin-Wurzel /vault → „sub".
        expect(fpath!.textContent).toBe('sub');
        expect($('vault-search-paths').getAttribute('aria-pressed')).toBe('true');
        expect(tauri.invoke).toHaveBeenCalledWith(
            'set_search_options',
            expect.objectContaining({ showPaths: true }),
        );

        // Aus schalten.
        $('vault-search-paths').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect($('vault-search-list').querySelector('.vs-fpath')).toBeNull();
        expect($('vault-search-paths').getAttribute('aria-pressed')).toBe('false');
    });
});

describe('vault/search — S5 Dauer-Format', () => {
    it('unter 1 s in ms, ab 1 s in Sekunden mit Nachkommastelle (de-Locale)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 1, filesMatched: 1, hits: 1, skippedLarge: 0, truncated: false, elapsedMs: 999 },
        });
        await flushMicro();
        expect($('vault-search-status').textContent).toContain('999 ms');

        await runSearch('needle2');
        tauri.emitEvent('search:hits', { runId: 2, files: [fileFixture()] });
        tauri.emitEvent('search:done', {
            runId: 2,
            stats: { filesScanned: 1, filesMatched: 1, hits: 1, skippedLarge: 0, truncated: false, elapsedMs: 30052 },
        });
        await flushMicro();
        expect($('vault-search-status').textContent).toContain('30,1 s');
    });
});

describe('vault/search — Status-Sonderfaelle', () => {
    it('Leere-Vault-Hinweis bei filesScanned==0 ohne Scope', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 0, filesMatched: 0, hits: 0, skippedLarge: 0, truncated: false, elapsedMs: 1 },
        });
        await flushMicro();
        expect($('vault-search-status').textContent).toContain('Keine durchsuchbaren Dateien im Vault');
    });

    it('OpenTabs-Leerfall zeigt den eigenen Status', async () => {
        await importAndInit();
        await runSearch('needle', { scope: 'openTabs' });
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 0, filesMatched: 0, hits: 0, skippedLarge: 0, truncated: false, elapsedMs: 1 },
        });
        await flushMicro();
        expect($('vault-search-status').textContent).toContain('offenen Dateien');
    });
});
