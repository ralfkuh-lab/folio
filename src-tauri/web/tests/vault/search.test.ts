// Tests fuer vault/search.ts (Inhaltsfeld im Such-/Filterbereich, S9).
// Schwerpunkte: Rendering inkl. <mark>-Ranges (UTF-16-Offsets), stale-runId-
// Verwurf, Event-Puffer vor Start-Antwort, Keyboard-Navigation, View-Mode-
// Sprung (async Finder), Truncation/Status, Spinner, Auto-Collapse, Sortierung/
// Pfadanzeige und der Suchraum aus dem Vault-Filter (Referenzfaelle F1–F11):
// Walk vs. Dateiliste, automatisches Neu-Suchen nach Filteraenderung mit
// Stale-Guard, Validierung am Feld, Popover-Tastatur.
//
// Das Backend wird ueber den Tauri-Mock simuliert; state/document, ui/find-bar
// und (wo nicht ausdruecklich das echte Modul laeuft) vault/filter werden
// gemockt.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

type Space = {
    kind: 'walk' | 'files';
    query?: string;
    scope: string | null;
    markdown: boolean;
    includeHidden?: boolean;
    hidden?: boolean;
    gitChangedOnly: boolean;
    filtered: boolean;
};

function walkSpace(over: Partial<Space> = {}): Space {
    return {
        kind: 'walk',
        scope: null,
        markdown: false,
        includeHidden: false,
        gitChangedOnly: false,
        filtered: false,
        ...over,
    };
}

function filesSpace(over: Partial<Space> = {}): Space {
    return {
        kind: 'files',
        query: 'spec',
        scope: null,
        hidden: false,
        markdown: false,
        gitChangedOnly: false,
        filtered: true,
        ...over,
    };
}

const mocks = vi.hoisted(() => ({
    getCurrentPath: vi.fn(() => '/vault/note.md' as string | null),
    setEditorFindTerm: vi.fn(),
    findNext: vi.fn(),
    getSearchSpace: vi.fn((): any => null),
    isVaultFilterBarVisible: vi.fn(() => true),
    openVaultFilterBar: vi.fn((_focusName: boolean) => {}),
    closeVaultFilterBar: vi.fn(() => {}),
    filterInFolder: vi.fn((_p: string) => {}),
    isPathGitChanged: vi.fn((_p: string) => false),
    whenFilterOptionsPersisted: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../app/state/document', () => ({
    getCurrentPath: mocks.getCurrentPath,
}));
vi.mock('../../app/vault/filter', () => ({
    VAULT_FILTER_CHANGED_EVENT: 'folio-vault-filter-changed',
    getSearchSpace: mocks.getSearchSpace,
    isVaultFilterBarVisible: mocks.isVaultFilterBarVisible,
    openVaultFilterBar: mocks.openVaultFilterBar,
    closeVaultFilterBar: mocks.closeVaultFilterBar,
    filterInFolder: mocks.filterInFolder,
    whenFilterOptionsPersisted: mocks.whenFilterOptionsPersisted,
}));
vi.mock('../../app/vault/git-status', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../app/vault/git-status')>()),
    isPathGitChanged: mocks.isPathGitChanged,
}));
// Nur fuer Tests mit echtem filter.ts (vi.importActual): der Baum ist hier
// kein Pruefgegenstand.
vi.mock('../../app/vault/tree', () => ({
    refreshVault: vi.fn(() => Promise.resolve()),
    reapplyVaultActive: vi.fn(),
    renderVaultFromHtml: vi.fn(),
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
            <button id="vault-filter-toggle"></button>
            <div id="vault-filter">
                <input id="vault-filter-input" type="search" />
                <button id="vault-filter-clear" hidden></button>
                <input id="vault-search-input" type="search" />
                <button id="vault-search-clear" hidden></button>
                <button id="vault-search-case" aria-pressed="false"></button>
                <button id="vault-search-word" aria-pressed="false"></button>
                <button id="vault-search-regex" aria-pressed="false"></button>
                <div id="vault-search-error" hidden></div>
                <button id="vault-filter-md"></button>
                <button id="vault-filter-git"></button>
                <button id="vault-filter-deep"></button>
                <button id="vault-filter-hidden"></button>
                <button id="vault-search-options-toggle" aria-expanded="false"></button>
                <div id="vault-filter-scope" hidden>
                    <span id="vault-filter-scope-name"></span>
                    <button id="vault-filter-scope-remove"></button>
                </div>
            </div>
            <div id="vault-search-options">
                <input type="checkbox" id="vault-search-include-ignored" />
                <input type="radio" name="vault-search-filetype" value="allText" checked />
                <input type="radio" name="vault-search-filetype" value="custom" />
                <input type="text" id="vault-search-custom-ext" />
                <div id="vault-search-filetype-hint" hidden></div>
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

function key(target: HTMLElement, k: string, opts: Partial<KeyboardEventInit> = {}): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
}

function click(id: string): void {
    $(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Umschalter am Feld nur klicken, wenn der Zustand abweicht (ein Klick bei
 *  aktiver Suche sucht sofort neu). */
function setToggle(id: string, on: boolean): void {
    if (($(id).getAttribute('aria-pressed') === 'true') !== on) click(id);
}

interface SearchOpts {
    case?: boolean;
    word?: boolean;
    regex?: boolean;
    space?: Space;
}

/** Fuellt das Inhaltsfeld und drueckt Enter (der Suchraum kommt aus dem
 *  gemockten Filter). */
async function runSearch(query: string, opts: SearchOpts = {}): Promise<void> {
    if (opts.space) mocks.getSearchSpace.mockReturnValue(opts.space);
    setToggle('vault-search-case', !!opts.case);
    setToggle('vault-search-regex', !!opts.regex);
    if (!opts.regex) setToggle('vault-search-word', !!opts.word);
    await flushMicro();
    const input = $('vault-search-input') as HTMLInputElement;
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await flushMicro();
}

/** jsdom kennt kein natives `popover`: Offen-Zustand (`:popover-open`) und
 *  `hidePopover` nachbilden; das Schliessen feuert wie im Browser `toggle`. */
function fakePopover(): { open: () => void; hide: ReturnType<typeof vi.fn> } {
    const pop = $('vault-search-options') as HTMLElement & { hidePopover?: () => void };
    let isOpen = false;
    const nativeMatches = pop.matches.bind(pop);
    pop.matches = (sel: string) => (sel === ':popover-open' ? isOpen : nativeMatches(sel));
    const fire = (state: string): void => {
        const ev = new Event('toggle') as Event & { newState?: string };
        ev.newState = state;
        pop.dispatchEvent(ev);
    };
    const hide = vi.fn(() => {
        isOpen = false;
        fire('closed');
    });
    pop.hidePopover = hide;
    return {
        open: () => {
            isOpen = true;
            fire('open');
        },
        hide,
    };
}

function startCalls(): any[] {
    return tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_start');
}

function findCalls(): any[] {
    return tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter_find');
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
    mocks.getSearchSpace.mockReturnValue(walkSpace());
    mocks.isVaultFilterBarVisible.mockReturnValue(true);
    mocks.isPathGitChanged.mockReturnValue(false);
    mocks.whenFilterOptionsPersisted.mockImplementation(() => Promise.resolve());
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
        expect(mocks.setEditorFindTerm).toHaveBeenCalledWith('needle', expect.objectContaining({
            regex: false,
        }));

        window.dispatchEvent(new CustomEvent('folio-find-state', {
            detail: { source: 'view', term: 'needle', total: 2, active: 0 },
        }));
        await vi.advanceTimersByTimeAsync(120); // Settle-Debounce
        await flushMicro();
        expect(mocks.findNext).toHaveBeenCalledTimes(1);
    });

    it('Regex-Sprung sucht den gematchten Text literal, auch wenn Regex in der Find-Bar an war', async () => {
        const { deps } = await importAndInit({ openDocument: vi.fn() });
        await runSearch('a\\+b', { regex: true });
        const metaHit = fileFixture({
            hits: [{
                line: 1, colUtf16: 1, lenUtf16: 3,
                snippet: 'see a+b here', snippetOffsetUtf16: 0, ranges: [[4, 3]],
            }],
        });
        tauri.emitEvent('search:hits', { runId: 1, files: [metaHit] });
        await flushMicro();

        vi.useFakeTimers();
        const hit = $('vault-search-list').querySelector('.vs-hit') as HTMLElement;
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(deps.openDocument).toHaveBeenCalledWith('/vault/note.md');

        mocks.getCurrentPath.mockReturnValue('/vault/note.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', { detail: { kind: 'markdown' } }));
        await vi.advanceTimersByTimeAsync(20);
        await flushMicro();

        expect(mocks.setEditorFindTerm).toHaveBeenCalledWith('a+b', {
            caseSensitive: false,
            wholeWord: false,
            regex: false,
        });
    });
});

describe('vault/search — S5 Suche beenden (× / Escape)', () => {
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
        // [S7] Pin-Name + Rest: Pin-Wurzel /vault → „vault/sub".
        expect(fpath!.textContent).toBe('vault/sub');
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

    it('[S7] Wechsel auf Pfad-Sortierung blendet die Pfadzeile einmalig ein (Einbahn-Kopplung)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/sub/deep.md', fileName: 'deep.md' })],
        });
        await flushMicro();
        const list = $('vault-search-list');
        const sort = $('vault-search-sort');
        const paths = $('vault-search-paths');
        // Ausgangslage: Pfade aus.
        expect(list.querySelector('.vs-fpath')).toBeNull();

        // none → name: noch keine Pfade.
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(list.querySelector('.vs-fpath')).toBeNull();
        expect(paths.getAttribute('aria-pressed')).toBe('false');

        // name → path: Pfadzeile automatisch eingeblendet, Toggle-State + Persist mit.
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(list.querySelector('.vs-fpath')).not.toBeNull();
        expect(paths.getAttribute('aria-pressed')).toBe('true');
        expect(tauri.invoke).toHaveBeenCalledWith(
            'set_search_options',
            expect.objectContaining({ sort: 'path', showPaths: true }),
        );

        // Keine Rück-Kopplung: path → none lässt die Pfade sichtbar.
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(list.querySelector('.vs-fpath')).not.toBeNull();
        expect(paths.getAttribute('aria-pressed')).toBe('true');
    });

    it('[S7] respektiert manuelles Ausblenden bei aktiver Pfad-Sortierung (kein Re-Trigger)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/sub/deep.md', fileName: 'deep.md' })],
        });
        await flushMicro();
        const list = $('vault-search-list');
        const sort = $('vault-search-sort');
        const paths = $('vault-search-paths');

        // Auf path wechseln → Pfade auto-ein.
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // path
        expect(list.querySelector('.vs-fpath')).not.toBeNull();

        // Manuell ausblenden — bleibt aus, obwohl path weiter aktiv ist.
        paths.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(list.querySelector('.vs-fpath')).toBeNull();
        expect(paths.getAttribute('aria-pressed')).toBe('false');
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

});

describe('vault/search — S7 Pfad-Darstellung (zweizeilig)', () => {
    /** Ersetzt die angepinnten Top-Level-Wurzeln im Vault-Baum. */
    function setPins(paths: string[]): void {
        const ul = document.querySelector(
            'li.section[data-section="pinned"] > ul.children',
        ) as HTMLElement;
        ul.innerHTML = paths
            .map((p) => `<li class="node" data-path="${p}"></li>`)
            .join('');
    }
    function fpaths(): string[] {
        return Array.from($('vault-search-list').querySelectorAll('.vs-fpath')).map(
            (e) => e.textContent || '',
        );
    }
    function names(): string[] {
        return Array.from($('vault-search-list').querySelectorAll('.vs-fname')).map(
            (e) => e.textContent || '',
        );
    }
    function enablePaths(): void {
        $('vault-search-paths').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    it('Pfadzeile = Pin-Name + Rest-Pfad (eigene .vs-fpath-Zeile)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/a/b/deep.md', fileName: 'deep.md' })],
        });
        await flushMicro();
        enablePaths();
        // .vs-fpath liegt im zweizeiligen Kopf (.vs-main), nicht mehr inline.
        const head = $('vault-search-list').querySelector('.vs-group-head')!;
        expect(head.querySelector('.vs-main .vs-fname')!.textContent).toBe('deep.md');
        expect(head.querySelector('.vs-main .vs-fpath')!.textContent).toBe('vault/a/b');
        // Absoluter Pfad bleibt im Tooltip.
        expect((head as HTMLElement).title).toBe('/vault/a/b/deep.md');
    });

    it('Datei direkt in der Pin-Wurzel → nur Pin-Name (nie leer)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/deep.md', fileName: 'deep.md' })],
        });
        await flushMicro();
        enablePaths();
        expect(fpaths()).toEqual(['vault']);
    });

    it('sort=path folgt der ANGEZEIGTEN Zeichenkette (divergiert vom absoluten Pfad)', async () => {
        // Zwei Pins mit Basisnamen, die die Ordnung gegenüber dem absoluten
        // Pfad umdrehen: absolute Sortierung /aaa/omega < /zzz/alpha ⇒ [y,x];
        // die angezeigten relativen Strings „alpha" < „omega" ⇒ [x,y].
        await importAndInit();
        setPins(['/zzz/alpha', '/aaa/omega']);
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/zzz/alpha/x.md', fileName: 'x.md' }),
                fileFixture({ path: '/aaa/omega/y.md', fileName: 'y.md' }),
            ],
        });
        await flushMicro();
        enablePaths();
        const sort = $('vault-search-sort');
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // path
        // Anzeige-String-Ordnung, NICHT die absolute (die wäre [y.md, x.md]).
        expect(names()).toEqual(['x.md', 'y.md']);
        expect(fpaths()).toEqual(['alpha', 'omega']);
    });

    it('Emphasis-Modifier-Klasse nur bei sort=path (mit sichtbarer Pfadzeile)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        enablePaths();
        const list = $('vault-search-list');
        const sort = $('vault-search-sort');
        expect(list.classList.contains('vs-sort-path')).toBe(false); // none
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        expect(list.classList.contains('vs-sort-path')).toBe(false);
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // path
        expect(list.classList.contains('vs-sort-path')).toBe(true);
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // none
        expect(list.classList.contains('vs-sort-path')).toBe(false);
    });

    it('sort=path setzt die Emphasis-Klasse NICHT, wenn die Pfadzeile aus ist [Sol-Rev S7#4]', async () => {
        // Der Zustand sort=path + showPaths=false ist über die frische UI nicht
        // mehr herstellbar (Einbahn-Kopplung blendet die Pfade beim Wechsel auf
        // path ein), bleibt aber via Boot-Restore erreichbar: persistierte Wahl
        // bzw. manuell ausgeblendet + Neustart. Genau den Restore simulieren wir.
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            if (cmd === 'vault_search_validate') return Promise.resolve(undefined);
            if (cmd === 'search_options_get') {
                return Promise.resolve({ sort: 'path', showPaths: false, fileFilter: 'allText' });
            }
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await flushMicro(); // Boot-Restore anwenden (sort=path, showPaths=false)
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        const list = $('vault-search-list');
        // Ohne sichtbare Pfadzeile darf der einzige sichtbare Dateiname nicht in
        // die gedimmte Zweitzeile getauscht werden → Modifier-Klasse bleibt aus.
        expect(list.classList.contains('vs-sort-path')).toBe(false);
        expect(list.querySelector('.vs-fpath')).toBeNull();
        expect(list.querySelector('.vs-fname')!.textContent).toBe('note.md');
        // Pfadzeile einschalten → jetzt greift der Swap (Sortierung war schon path).
        enablePaths();
        expect(list.classList.contains('vs-sort-path')).toBe(true);
    });

    it('Pfadzeile nie leer bei Datei direkt unter der Unix-Wurzel `/` (Root-Pin) [Sol-Rev S7#6]', async () => {
        await importAndInit();
        setPins(['/']);
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/deep.md', fileName: 'deep.md' }),
                fileFixture({ path: '/sub/inner.md', fileName: 'inner.md' }),
            ],
        });
        await flushMicro();
        enablePaths();
        // Datei direkt unter `/` → Wurzel-Anzeigename `/` (nie leer); tiefere
        // Datei → `/sub` (kein Doppel-Slash).
        expect(fpaths()).toEqual(['/', '/sub']);
    });
    it('Pfad-Toggle blendet die Pfadzeile aus', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/sub/deep.md', fileName: 'deep.md' })],
        });
        await flushMicro();
        enablePaths();
        expect($('vault-search-list').querySelector('.vs-fpath')).not.toBeNull();
        // Wieder aus → keine Pfadzeile mehr.
        $('vault-search-paths').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect($('vault-search-list').querySelector('.vs-fpath')).toBeNull();
    });

    it('searchPathDisplay=absolute (Boot) ändert Anzeige UND Sortierung', async () => {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            if (cmd === 'vault_search_validate') return Promise.resolve(undefined);
            if (cmd === 'search_options_get') return Promise.resolve({});
            if (cmd === 'settings_get') return Promise.resolve({ searchPathDisplay: 'absolute' });
            return Promise.resolve(undefined);
        });
        await importAndInit();
        setPins(['/zzz/alpha', '/aaa/omega']);
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: '/zzz/alpha/x.md', fileName: 'x.md' }),
                fileFixture({ path: '/aaa/omega/y.md', fileName: 'y.md' }),
            ],
        });
        await flushMicro();
        enablePaths();
        const sort = $('vault-search-sort');
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // name
        sort.dispatchEvent(new MouseEvent('click', { bubbles: true })); // path
        // Absolut: /aaa/omega < /zzz/alpha ⇒ [y.md, x.md]; Pfadzeile = voller Dir.
        expect(names()).toEqual(['y.md', 'x.md']);
        expect(fpaths()).toEqual(['/aaa/omega', '/zzz/alpha']);
    });

    it('settings:changed schaltet die Pfad-Darstellung live um', async () => {
        await importAndInit();
        setPins(['/zzz/alpha']);
        await runSearch('needle');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/zzz/alpha/sub/deep.md', fileName: 'deep.md' })],
        });
        await flushMicro();
        enablePaths();
        // Relativ (Default): Pin-Name + Rest.
        expect(fpaths()).toEqual(['alpha/sub']);
        // Live-Wechsel auf absolute.
        tauri.emitEvent('settings:changed', {
            settings: { searchPathDisplay: 'absolute' },
            changed: ['searchPathDisplay'],
        });
        await flushMicro();
        expect(fpaths()).toEqual(['/zzz/alpha/sub']);
        // Und wieder zurück.
        tauri.emitEvent('settings:changed', {
            settings: { searchPathDisplay: 'relative' },
            changed: ['searchPathDisplay'],
        });
        await flushMicro();
        expect(fpaths()).toEqual(['alpha/sub']);
    });
});

// ----- Scope „Gefilterte Dateien" (volle Treffermenge des Vault-Filters) -----


describe('vault/search — S9 Suchraum aus dem Filter (F1–F7)', () => {
    const R = '/vault/R';
    const SPEC_A = `${R}/notes/spec-a.md`;
    const SPEC_C = `${R}/deep/x/spec-c.txt`;

    function mockFind(res: { files: string[]; truncated?: boolean; reason?: string | null }): void {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            if (cmd === 'vault_filter_find') {
                return Promise.resolve({
                    files: res.files,
                    dirs: [],
                    truncated: !!res.truncated,
                    reason: res.reason ?? null,
                });
            }
            return Promise.resolve(undefined);
        });
    }

    async function done(stats: Record<string, unknown> = {}): Promise<void> {
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: {
                filesScanned: 2,
                filesMatched: 1,
                hits: 1,
                skippedLarge: 0,
                truncated: false,
                elapsedMs: 1,
                ...stats,
            },
        });
        await flushMicro();
    }

    it('F1: kein Filter → Walk ueber den Vault, `.*` aus, Status „· Vault"', async () => {
        await importAndInit();
        await runSearch('TODO', { space: walkSpace() });
        const args = startCalls()[0][1];
        expect(args).toMatchObject({
            query: 'TODO',
            scope: null,
            includeHidden: false,
            fileFilter: 'allText',
        });
        expect(args).not.toHaveProperty('files');
        expect(args).not.toHaveProperty('openTabs');
        expect(findCalls()).toHaveLength(0);
        await done();
        expect($('vault-search-status').textContent).toContain('· Vault');
    });

    it('F2: `.*` an (mit vaultShowHidden) → includeHidden', async () => {
        await importAndInit();
        await runSearch('TODO', { space: walkSpace({ includeHidden: true }) });
        expect(startCalls()[0][1]).toMatchObject({ scope: null, includeHidden: true });
    });

    it('F3: `.md` an → Walk mit fileFilter markdown (auch wenn das Popover „eigene" waehlt)', async () => {
        await importAndInit();
        const custom = document.querySelector(
            'input[name="vault-search-filetype"][value="custom"]',
        ) as HTMLInputElement;
        ($('vault-search-custom-ext') as HTMLInputElement).value = 'txt';
        $('vault-search-custom-ext').dispatchEvent(new Event('change', { bubbles: true }));
        custom.checked = true;
        custom.dispatchEvent(new Event('change', { bubbles: true }));
        await runSearch('TODO', { space: walkSpace({ markdown: true, filtered: true }) });
        expect(startCalls()[0][1]).toMatchObject({ scope: null, fileFilter: 'markdown' });
        expect(findCalls()).toHaveLength(0);
    });

    it('F4: Bereich ohne Namen → Walk ueber den Ordner, Status „· gefiltert"', async () => {
        await importAndInit();
        await runSearch('TODO', { space: walkSpace({ scope: `${R}/deep`, filtered: true }) });
        expect(startCalls()[0][1]).toMatchObject({ scope: `${R}/deep` });
        expect(startCalls()[0][1]).not.toHaveProperty('files');
        await done();
        expect($('vault-search-status').textContent).toContain('· gefiltert');
    });

    it('F5: Name `spec` → Dateiliste aus vault_filter_find', async () => {
        await importAndInit();
        mockFind({ files: [SPEC_A, SPEC_C] });
        await runSearch('TODO', { space: filesSpace() });
        expect(findCalls()[0][1]).toEqual({ query: 'spec', scope: null, hidden: false });
        const args = startCalls()[0][1];
        expect(args.files).toEqual([SPEC_A, SPEC_C]);
        expect(args).not.toHaveProperty('scope');
        expect(args.fileFilter).toBe('allText');
    });

    it('F6: Name `spec` + `.md` → wartet auf den Options-Write, markdown', async () => {
        await importAndInit();
        let release!: () => void;
        mocks.whenFilterOptionsPersisted.mockImplementation(
            () => new Promise<void>((resolve) => (release = resolve)),
        );
        mockFind({ files: [SPEC_A] });
        await runSearch('TODO', { space: filesSpace({ markdown: true }) });
        expect(findCalls()).toHaveLength(0);
        release();
        await flushMicro();
        expect(startCalls()[0][1]).toMatchObject({ files: [SPEC_A], fileFilter: 'markdown' });
    });

    it('F7: Name `spec` + git → Schnitt mit den git-geaenderten Dateien', async () => {
        await importAndInit();
        mocks.isPathGitChanged.mockImplementation((p: string) => p === SPEC_C);
        mockFind({ files: [SPEC_A, SPEC_C] });
        await runSearch('TODO', { space: filesSpace({ gitChangedOnly: true }) });
        expect(startCalls()[0][1].files).toEqual([SPEC_C]);
    });

    it('git ohne Namen → Walk, Treffer ausserhalb git-geaenderter Dateien verworfen', async () => {
        await importAndInit();
        mocks.isPathGitChanged.mockImplementation((p: string) => p === SPEC_C);
        await runSearch('TODO', { space: walkSpace({ gitChangedOnly: true, filtered: true }) });
        expect(startCalls()[0][1]).not.toHaveProperty('files');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [
                fileFixture({ path: SPEC_A, fileName: 'spec-a.md' }),
                fileFixture({ path: SPEC_C, fileName: 'spec-c.txt' }),
            ],
        });
        await done({ hits: 2, filesMatched: 2 });
        const names = Array.from(document.querySelectorAll('.vs-fname')).map((e) => e.textContent);
        expect(names).toEqual(['spec-c.txt']);
        expect($('vault-search-status').textContent).toContain('1 Treffer in 1 Datei');
    });

    it('Deckel cap/time und leere Filtermenge werden benannt', async () => {
        await importAndInit();
        mockFind({ files: [SPEC_A], truncated: true, reason: 'cap' });
        await runSearch('TODO', { space: filesSpace() });
        await done();
        expect($('vault-search-status').textContent).toContain('nur die ersten 1 gefilterten Dateien');

        mockFind({ files: [] });
        await runSearch('TODO2', { space: filesSpace() });
        tauri.emitEvent('search:done', {
            runId: 2,
            stats: { filesScanned: 0, filesMatched: 0, hits: 0, skippedLarge: 0, truncated: false, elapsedMs: 1 },
        });
        await flushMicro();
        expect($('vault-search-status').textContent).toContain('Keine gefilterten Dateien');
    });

    it('fehlgeschlagener Options-Write → Fehler im Status, kein Find/Start', async () => {
        await importAndInit();
        mocks.whenFilterOptionsPersisted.mockImplementation(() =>
            Promise.reject(new Error('disk full')),
        );
        await runSearch('TODO', { space: filesSpace() });
        expect(findCalls()).toHaveLength(0);
        expect(startCalls()).toHaveLength(0);
        expect($('vault-search-status').textContent).toContain('disk full');
        expect($('vault-search-status').classList.contains('vs-running')).toBe(false);
    });
});

describe('vault/search — S9 Feld, Validierung, Optionen', () => {
    it('F9: Inhalt `T` + Enter → Fehler am Feld, kein vault_search_start', async () => {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_validate') {
                return Promise.reject('Suchbegriff muss mindestens 2 Zeichen lang sein');
            }
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('T');
        expect(startCalls()).toHaveLength(0);
        expect($('vault-search-error').hidden).toBe(false);
        expect($('vault-search-error').textContent).toContain('mindestens 2 Zeichen');
        expect($('vault-search-input').getAttribute('aria-invalid')).toBe('true');
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
        // Tippen raeumt den Fehler weg.
        $('vault-search-input').dispatchEvent(new Event('input', { bubbles: true }));
        expect($('vault-search-error').hidden).toBe(true);
    });

    it('spaeteres Enter gewinnt gegen aelteren ausstehenden Validate', async () => {
        await importAndInit();
        await flushMicro();
        const resolvers: Array<() => void> = [];
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_validate') return new Promise<void>((r) => resolvers.push(r));
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
        await runSearch('aaa');
        await runSearch('bbb');
        resolvers[1]();
        await flushMicro();
        resolvers[0]();
        await flushMicro();
        expect(startCalls()).toHaveLength(1);
        expect(startCalls()[0][1].query).toBe('bbb');
    });

    it('Aa/ab/Rx: Regex deaktiviert „ab"; Wechsel bei aktiver Suche sucht neu + persistiert', async () => {
        await importAndInit();
        await runSearch('needle');
        expect(startCalls()).toHaveLength(1);
        click('vault-search-case');
        await flushMicro();
        expect(startCalls()).toHaveLength(2);
        expect(startCalls()[1][1]).toMatchObject({ caseSensitive: true });
        expect(tauri.invoke).toHaveBeenCalledWith(
            'set_search_options',
            expect.objectContaining({ caseSensitive: true }),
        );
        click('vault-search-word');
        await flushMicro();
        expect(startCalls()[2][1]).toMatchObject({ wholeWord: true, regex: false });
        click('vault-search-regex');
        await flushMicro();
        expect(($('vault-search-word') as HTMLButtonElement).disabled).toBe(true);
        expect($('vault-search-word').getAttribute('aria-pressed')).toBe('false');
        expect(startCalls()[3][1]).toMatchObject({ regex: true, wholeWord: false });
        const persisted = tauri.invoke.mock.calls.filter((c) => c[0] === 'set_search_options');
        expect(persisted.at(-1)?.[1]).not.toHaveProperty('includeHidden');
    });

    it('Popover: gitignorierte + eigene Endungen wirken im Lauf und werden persistiert', async () => {
        await importAndInit();
        const ignored = $('vault-search-include-ignored') as HTMLInputElement;
        ignored.checked = true;
        ignored.dispatchEvent(new Event('change', { bubbles: true }));
        const ext = $('vault-search-custom-ext') as HTMLInputElement;
        ext.value = 'log';
        ext.dispatchEvent(new Event('change', { bubbles: true }));
        const custom = document.querySelector(
            'input[name="vault-search-filetype"][value="custom"]',
        ) as HTMLInputElement;
        custom.checked = true;
        custom.dispatchEvent(new Event('change', { bubbles: true }));
        await runSearch('needle');
        expect(startCalls()[0][1]).toMatchObject({
            includeIgnored: true,
            fileFilter: 'custom',
            customExtensions: 'log',
        });
        expect(tauri.invoke).toHaveBeenCalledWith(
            'set_search_options',
            expect.objectContaining({ includeIgnored: true, fileFilter: 'custom', customExtensions: 'log' }),
        );
    });

    it('Popover: `.md` an → Dateityp deaktiviert mit Hinweis', async () => {
        await importAndInit();
        mocks.getSearchSpace.mockReturnValue(walkSpace({ markdown: true, filtered: true }));
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        const radios = Array.from(
            document.querySelectorAll('input[name="vault-search-filetype"]'),
        ) as HTMLInputElement[];
        expect(radios.every((r) => r.disabled)).toBe(true);
        expect($('vault-search-filetype-hint').hidden).toBe(false);
        mocks.getSearchSpace.mockReturnValue(walkSpace());
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        expect(radios.every((r) => !r.disabled)).toBe(true);
        expect($('vault-search-filetype-hint').hidden).toBe(true);
    });

    it('Altwert fileFilter `markdown` wird als `allText` geladen (Quelle ist der `.md`-Chip)', async () => {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'search_options_get') return Promise.resolve({ fileFilter: 'markdown' });
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await flushMicro();
        await runSearch('needle');
        expect(startCalls()[0][1]).toMatchObject({ fileFilter: 'allText' });
        const checked = document.querySelector(
            'input[name="vault-search-filetype"]:checked',
        ) as HTMLInputElement;
        expect(checked.value).toBe('allText');
    });

    it('Popover-Tastatur: Escape schliesst und gibt den Fokus ans Zahnrad', async () => {
        await importAndInit();
        const pop = fakePopover();
        const gear = $('vault-search-options-toggle');
        await runSearch('needle');
        pop.open();
        expect(gear.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe($('vault-search-include-ignored'));
        // Escape darf nicht zur Region durchreichen (keine beendete Suche).
        key($('vault-search-include-ignored'), 'Escape');
        expect(pop.hide).toHaveBeenCalled();
        expect(document.activeElement).toBe(gear);
        expect($('vault-region').classList.contains('vault-searching')).toBe(true);
        expect(gear.getAttribute('aria-expanded')).toBe('false');
    });

    it('Korrektur 3: Escape bei offenem Popover hat Vorrang, egal wo der Fokus liegt', async () => {
        await importAndInit();
        const pop = fakePopover();
        const gear = $('vault-search-options-toggle');
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        const input = $('vault-search-input') as HTMLInputElement;
        for (const target of [$('vault-search-sort'), $('vault-search-list'), input]) {
            pop.open();
            target.focus();
            key(target, 'Escape');
            expect(pop.hide).toHaveBeenCalled();
            expect(document.activeElement).toBe(gear);
            expect($('vault-region').classList.contains('vault-searching')).toBe(true);
            expect(input.value).toBe('needle');
            pop.hide.mockClear();
        }
        expect(mocks.closeVaultFilterBar).not.toHaveBeenCalled();
        // Ohne offenes Popover gilt wieder die normale Kaskade.
        key($('vault-search-sort'), 'Escape');
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
    });
});

describe('vault/search — S9 Tastatur + Einstiege', () => {
    it('Escape im Inhaltsfeld: Text → leeren + Suche beenden; leer → Bereich schliessen', async () => {
        await importAndInit();
        await runSearch('needle');
        const input = $('vault-search-input') as HTMLInputElement;
        key(input, 'Escape');
        expect(input.value).toBe('');
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
        expect(mocks.closeVaultFilterBar).not.toHaveBeenCalled();
        key(input, 'Escape');
        expect(mocks.closeVaultFilterBar).toHaveBeenCalledTimes(1);
    });

    it('✕ im Feld leert und beendet die Suche', async () => {
        await importAndInit();
        await runSearch('needle');
        expect($('vault-search-clear').hidden).toBe(false);
        click('vault-search-clear');
        expect(($('vault-search-input') as HTMLInputElement).value).toBe('');
        expect($('vault-search-clear').hidden).toBe(true);
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
    });

    it('Enter im leeren Feld beendet eine laufende Suche', async () => {
        await importAndInit();
        await runSearch('needle');
        await runSearch('');
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
        expect(startCalls()).toHaveLength(1);
    });

    it('↓ im Inhaltsfeld springt in die Trefferliste (erster Treffer aktiv)', async () => {
        await importAndInit();
        await runSearch('needle');
        tauri.emitEvent('search:hits', { runId: 1, files: [fileFixture()] });
        await flushMicro();
        key($('vault-search-input'), 'ArrowDown');
        expect(document.activeElement).toBe($('vault-search-list'));
        expect($('vault-search-list').querySelector('.vs-hit')!.classList.contains('active')).toBe(true);
    });

    it('Escape aus der Ergebnisliste verschiebt den Fokus ins Inhaltsfeld', async () => {
        await importAndInit();
        await runSearch('needle');
        const list = $('vault-search-list');
        list.focus();
        key(list, 'Escape');
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
        expect(document.activeElement).toBe($('vault-search-input'));
        expect(($('vault-search-input') as HTMLInputElement).value).toBe('needle');
    });

    it('Escape auf dem Ergebnis-Kopf beendet die Suche (bubbelt zur Region)', async () => {
        await importAndInit();
        await runSearch('needle');
        key($('vault-search-sort'), 'Escape');
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
    });

    it('Strg+Umschalt+F oeffnet den Bereich und fokussiert das Inhaltsfeld (Text selektiert)', async () => {
        await importAndInit();
        const input = $('vault-search-input') as HTMLInputElement;
        input.value = 'alt';
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'F', ctrlKey: true, shiftKey: true, bubbles: true,
        }));
        expect(mocks.openVaultFilterBar).toHaveBeenCalledWith(false);
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(3);
        expect(startCalls()).toHaveLength(0);
    });

    it('Tag-Browser: openVaultSearch({query, run}) sucht sofort', async () => {
        const { search } = await importAndInit();
        search.openVaultSearch({ query: '#work', run: true });
        await flushMicro();
        expect(($('vault-search-input') as HTMLInputElement).value).toBe('#work');
        expect(startCalls()[0][1]).toMatchObject({ query: '#work' });
    });

    it('Bereich geschlossen (Event) beendet die Suche, der Begriff bleibt im Feld', async () => {
        await importAndInit();
        await runSearch('needle');
        mocks.isVaultFilterBarVisible.mockReturnValue(false);
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
        expect(($('vault-search-input') as HTMLInputElement).value).toBe('needle');
    });
});

describe('vault/search — S9 Neu-Suchen bei Filteraenderung (Stale-Guard)', () => {
    it('Filteraenderung bei aktiver Suche sucht entprellt neu; ohne Suche nicht', async () => {
        vi.useFakeTimers();
        await importAndInit();
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        await vi.advanceTimersByTimeAsync(500);
        expect(startCalls()).toHaveLength(0);

        await runSearch('needle');
        expect(startCalls()).toHaveLength(1);
        mocks.getSearchSpace.mockReturnValue(walkSpace({ scope: '/vault/a', filtered: true }));
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        await vi.advanceTimersByTimeAsync(200);
        expect(startCalls()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(200);
        expect(startCalls()).toHaveLength(2);
        expect(startCalls()[1][1]).toMatchObject({ query: 'needle', scope: '/vault/a' });
        expect(tauri.invoke).toHaveBeenCalledWith('vault_search_cancel', { runId: 1 });
    });

    it('verzoegerte Filterantwort eines aelteren Laufs startet nichts und ueberschreibt nichts', async () => {
        vi.useFakeTimers();
        const finds: Array<(v: unknown) => void> = [];
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_filter_find') return new Promise((resolve) => finds.push(resolve));
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('TODO', { space: filesSpace({ query: 'spec' }) });
        expect(finds).toHaveLength(1);
        // Filter aendert sich, waehrend die erste Filterantwort aussteht.
        mocks.getSearchSpace.mockReturnValue(filesSpace({ query: 'spec-c' }));
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        await vi.advanceTimersByTimeAsync(400);
        expect(finds).toHaveLength(2);
        finds[1]({ files: ['/vault/new.md'] });
        await vi.advanceTimersByTimeAsync(0);
        finds[0]({ files: ['/vault/old.md'] });
        await vi.advanceTimersByTimeAsync(0);
        expect(startCalls()).toHaveLength(1);
        expect(startCalls()[0][1].files).toEqual(['/vault/new.md']);
        // runId 1 ist der aktuelle (einzig gestartete) Lauf: seine Treffer
        // werden angewandt — die alte Filterantwort hat keinen eigenen Lauf.
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/new.md', fileName: 'new.md' })],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(document.querySelectorAll('.vs-fname')).toHaveLength(1);
    });
});

describe('vault/search — S9 mit echtem Vault-Filter (F8, F10, F11)', () => {
    async function realFilter() {
        const filter = await vi.importActual<typeof import('../../app/vault/filter')>(
            '../../app/vault/filter',
        );
        mocks.getSearchSpace.mockImplementation(filter.getSearchSpace);
        mocks.isVaultFilterBarVisible.mockImplementation(filter.isVaultFilterBarVisible);
        mocks.openVaultFilterBar.mockImplementation(filter.openVaultFilterBar);
        mocks.closeVaultFilterBar.mockImplementation(filter.closeVaultFilterBar);
        mocks.filterInFolder.mockImplementation(filter.filterInFolder);
        mocks.whenFilterOptionsPersisted.mockImplementation(filter.whenFilterOptionsPersisted);
        const disposeFilter = filter.initVaultFilter();
        await flushMicro();
        return { filter, disposeFilter };
    }

    function backend(): void {
        tauri.invoke.mockImplementation((cmd: string, args: any) => {
            if (cmd === 'vault_filter_options_get') return Promise.resolve({ barVisible: true });
            if (cmd === 'vault_filter_find') {
                return Promise.resolve({
                    files: args.query === 'spec' ? ['/vault/R/notes/spec-a.md', '/vault/R/deep/x/spec-c.txt'] : [],
                    dirs: [],
                    truncated: false,
                });
            }
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
    }

    it('F8: aktive Suche (F1), dann Name `spec` tippen → automatisch Ergebnis wie F5', async () => {
        backend();
        await importAndInit();
        const { disposeFilter } = await realFilter();
        await runSearch('TODO');
        expect(startCalls()[0][1]).toMatchObject({ scope: null });
        const name = $('vault-filter-input') as HTMLInputElement;
        name.value = 'spec';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        // Entprellung 150 ms (Filter) + 300 ms (Neu-Suche); unter Last pollen
        // statt fest zu warten.
        const deadline = Date.now() + 3000;
        while (startCalls().length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await flushMicro();
        disposeFilter();
        expect(startCalls()).toHaveLength(2);
        expect(startCalls()[1][1]).toMatchObject({
            query: 'TODO',
            files: ['/vault/R/notes/spec-a.md', '/vault/R/deep/x/spec-c.txt'],
        });
    });

    it('F10: Funnel zu beendet die Suche; Wiederoeffnen zeigt TODO, Enter wiederholt', async () => {
        backend();
        await importAndInit();
        const { disposeFilter } = await realFilter();
        await runSearch('TODO');
        click('vault-filter-toggle'); // schliessen
        await flushMicro();
        expect($('vault-filter').hidden).toBe(true);
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
        click('vault-filter-toggle'); // oeffnen
        await flushMicro();
        const input = $('vault-search-input') as HTMLInputElement;
        expect(input.value).toBe('TODO');
        key(input, 'Enter');
        await flushMicro();
        disposeFilter();
        expect(startCalls()).toHaveLength(2);
        expect(startCalls()[1][1]).toEqual(startCalls()[0][1]);
    });

    it('F11: „In diesem Ordner suchen" → Bereich, Fokus Inhaltsfeld, Enter → Folder-Walk', async () => {
        backend();
        const { search } = await importAndInit();
        const { disposeFilter } = await realFilter();
        search.searchInFolder('/vault/R/notes');
        await flushMicro();
        expect($('vault-filter-scope').hidden).toBe(false);
        expect($('vault-filter-scope-name').textContent).toBe('notes');
        const input = $('vault-search-input') as HTMLInputElement;
        expect(document.activeElement).toBe(input);
        input.value = 'TODO';
        key(input, 'Enter');
        await flushMicro();
        disposeFilter();
        expect(startCalls()[0][1]).toMatchObject({ scope: '/vault/R/notes', includeHidden: false });
        expect(startCalls()[0][1]).not.toHaveProperty('files');
    });

    it('Reset-Hook beendet auch die Suche', async () => {
        backend();
        await importAndInit();
        const { disposeFilter } = await realFilter();
        await runSearch('TODO');
        (window as any).__folioVaultFilterReset();
        await flushMicro();
        disposeFilter();
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
    });
});

describe('vault/search — Korrekturrunde 1: ausstehende Validierung (Befund 1)', () => {
    function holdValidate(result: 'ok' | 'error' = 'ok'): { release: () => void } {
        let release!: () => void;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_validate') {
                return new Promise((resolve, reject) => {
                    release = () => (result === 'ok' ? resolve(undefined) : reject('kaputt'));
                });
            }
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
        return { release: () => release() };
    }

    it('Funnel zu waehrend der Validierung → kein Start, kein Suchmodus', async () => {
        const v = holdValidate();
        await importAndInit();
        await runSearch('TODO');
        mocks.isVaultFilterBarVisible.mockReturnValue(false);
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        v.release();
        await flushMicro();
        expect(startCalls()).toHaveLength(0);
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
    });

    it('Escape (Leeren) waehrend der Validierung → kein Start; spaeter Fehler erscheint nicht', async () => {
        const v = holdValidate('error');
        await importAndInit();
        await runSearch('TODO');
        key($('vault-search-input'), 'Escape');
        v.release();
        await flushMicro();
        expect(startCalls()).toHaveLength(0);
        expect($('vault-search-error').hidden).toBe(true);
        expect($('vault-search-input').getAttribute('aria-invalid')).toBeNull();

        const v2 = holdValidate();
        await runSearch('TODO');
        key($('vault-search-input'), 'Escape');
        v2.release();
        await flushMicro();
        expect(startCalls()).toHaveLength(0);
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
    });

    it('Options-Submit bei aktiver Suche, dann Funnel zu → kein Neustart', async () => {
        await importAndInit();
        await runSearch('TODO');
        expect(startCalls()).toHaveLength(1);
        const v = holdValidate();
        click('vault-search-case'); // Options-Submit, Validierung haengt
        await flushMicro();
        mocks.isVaultFilterBarVisible.mockReturnValue(false);
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        v.release();
        await flushMicro();
        expect(startCalls()).toHaveLength(1);
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
    });

    it('Reset-Hook (echter Filter) waehrend der Validierung → kein Start', async () => {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_filter_options_get') return Promise.resolve({ barVisible: true });
            return Promise.resolve(undefined);
        });
        await importAndInit();
        const filter = await vi.importActual<typeof import('../../app/vault/filter')>(
            '../../app/vault/filter',
        );
        mocks.getSearchSpace.mockImplementation(filter.getSearchSpace);
        mocks.isVaultFilterBarVisible.mockImplementation(filter.isVaultFilterBarVisible);
        const disposeFilter = filter.initVaultFilter();
        await flushMicro();
        const v = holdValidate();
        await runSearch('TODO');
        (window as any).__folioVaultFilterReset();
        v.release();
        await flushMicro();
        disposeFilter();
        expect(startCalls()).toHaveLength(0);
        expect($('vault-region').classList.contains('vault-searching')).toBe(false);
    });
});

describe('vault/search — Korrekturrunde 1: Filterwechsel im Entprell-Fenster (Befund 2)', () => {
    it('alte Find-Antwort im Fenster startet nichts', async () => {
        vi.useFakeTimers();
        let find!: (v: unknown) => void;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_filter_find') return new Promise((resolve) => (find = resolve));
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('TODO', { space: filesSpace({ query: 'old' }) });
        mocks.getSearchSpace.mockReturnValue(filesSpace({ query: 'new' }));
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        find({ files: ['/vault/old.md'] });
        await vi.advanceTimersByTimeAsync(0);
        expect(startCalls()).toHaveLength(0);
    });

    it('alte Options-Write-Antwort im Fenster ruft kein vault_filter_find', async () => {
        vi.useFakeTimers();
        let persisted!: () => void;
        mocks.whenFilterOptionsPersisted.mockImplementation(
            () => new Promise<void>((resolve) => (persisted = resolve)),
        );
        await importAndInit();
        await runSearch('TODO', { space: filesSpace({ query: 'old', markdown: true }) });
        mocks.getSearchSpace.mockReturnValue(filesSpace({ query: 'new' }));
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        persisted();
        await vi.advanceTimersByTimeAsync(0);
        expect(findCalls()).toHaveLength(0);
        expect(startCalls()).toHaveLength(0);
    });

    it('alte Start-Antwort im Fenster wird gecancelt, nicht adoptiert', async () => {
        vi.useFakeTimers();
        let start!: (v: number) => void;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_start') return new Promise<number>((resolve) => (start = resolve));
            return Promise.resolve(undefined);
        });
        await importAndInit();
        await runSearch('TODO');
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        start(5);
        await vi.advanceTimersByTimeAsync(0);
        expect(tauri.invoke).toHaveBeenCalledWith('vault_search_cancel', { runId: 5 });
        tauri.emitEvent('search:hits', { runId: 5, files: [fileFixture()] });
        await vi.advanceTimersByTimeAsync(0);
        expect(document.querySelectorAll('.vs-fname')).toHaveLength(0);
    });

    it('Streaming-Events des alten Laufs im Fenster werden verworfen, alter Lauf gecancelt', async () => {
        vi.useFakeTimers();
        await importAndInit();
        await runSearch('TODO');
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/a.md', fileName: 'a.md' })],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(document.querySelectorAll('.vs-fname')).toHaveLength(1);
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        expect(tauri.invoke).toHaveBeenCalledWith('vault_search_cancel', { runId: 1 });
        tauri.emitEvent('search:hits', {
            runId: 1,
            files: [fileFixture({ path: '/vault/b.md', fileName: 'b.md' })],
        });
        tauri.emitEvent('search:done', {
            runId: 1,
            stats: { filesScanned: 2, filesMatched: 2, hits: 2, skippedLarge: 0, truncated: false, elapsedMs: 1 },
        });
        await vi.advanceTimersByTimeAsync(100);
        const names = Array.from(document.querySelectorAll('.vs-fname')).map((e) => e.textContent);
        expect(names).not.toContain('b.md');
        expect($('vault-search-status').classList.contains('vs-running')).toBe(true);
        // Nach der Entprellung startet genau ein neuer Lauf.
        await vi.advanceTimersByTimeAsync(300);
        expect(startCalls()).toHaveLength(2);
    });
});

describe('vault/search — Korrekturrunde 2: Validierung zum aktuellen Optionssatz (Befund 5)', () => {
    it('alte Custom-Ablehnung nach .md-Wechsel setzt keinen Fehler; Markdown-Lauf mit NEW', async () => {
        vi.useFakeTimers();
        let rejectCustom!: (e: unknown) => void;
        tauri.invoke.mockImplementation((cmd: string, args: any) => {
            if (cmd === 'search_options_get') {
                return Promise.resolve({ fileFilter: 'custom', customExtensions: '' });
            }
            if (cmd === 'vault_search_validate' && args.fileFilter === 'custom') {
                return new Promise((_resolve, reject) => {
                    rejectCustom = reject;
                });
            }
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
        mocks.getSearchSpace.mockReturnValue(walkSpace({ markdown: true, filtered: true }));
        await importAndInit();
        await flushMicro();
        await runSearch('OLD');
        expect(startCalls()).toHaveLength(1);
        // .md aus → Enter NEW validiert mit custom (leere Endungen), Antwort haengt.
        mocks.getSearchSpace.mockReturnValue(walkSpace());
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        await runSearch('NEW');
        // .md wieder an, dann kommt die alte Ablehnung.
        mocks.getSearchSpace.mockReturnValue(walkSpace({ markdown: true, filtered: true }));
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        await vi.advanceTimersByTimeAsync(400);
        rejectCustom('Bitte mindestens eine Dateiendung eingeben');
        await vi.advanceTimersByTimeAsync(0);
        await flushMicro();
        expect($('vault-search-error').hidden).toBe(true);
        expect($('vault-search-input').getAttribute('aria-invalid')).toBeNull();
        expect(startCalls().at(-1)?.[1]).toMatchObject({ query: 'NEW', fileFilter: 'markdown' });
    });

    it('Namens-/Bereichswechsel bricht ein ausstehendes Enter nicht ab', async () => {
        vi.useFakeTimers();
        await importAndInit();
        await runSearch('OLD');
        let release!: (v: unknown) => void;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_search_validate') return new Promise((resolve) => (release = resolve));
            if (cmd === 'vault_search_start') return Promise.resolve(nextRunId++);
            return Promise.resolve(undefined);
        });
        const validatesBefore = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_search_validate',
        ).length;
        await runSearch('NEW');
        mocks.getSearchSpace.mockReturnValue(walkSpace({ scope: '/vault/new', filtered: true }));
        window.dispatchEvent(new CustomEvent('folio-vault-filter-changed'));
        await vi.advanceTimersByTimeAsync(100);
        release(undefined);
        await flushMicro();
        expect(startCalls().at(-1)?.[1]).toMatchObject({ query: 'NEW', scope: '/vault/new' });
        // Bereich ändert den Validierungssatz nicht → keine Neuvalidierung.
        const validates = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_search_validate');
        expect(validates.length - validatesBefore).toBe(1);
    });
});
