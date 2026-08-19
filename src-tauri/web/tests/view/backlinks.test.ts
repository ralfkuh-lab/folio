import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

vi.mock('../../app/state/tabs', () => ({
    getActiveTabId: vi.fn(() => 1 as number | null),
}));

import {
    __backlinksFetchGenForTests,
    __lastBacklinksPathForTests,
    __resetBacklinksForTests,
    __setLastBacklinksPathForTests,
    formatBacklinksHeader,
    isBacklinksPanelEmpty,
    onDocumentSaved,
    refreshBacklinksAfterIndexReady,
    refreshBacklinksNow,
    renderBacklinks,
    scheduleBacklinksRefresh,
    shouldRefreshBacklinksOnSaved,
    totalBacklinkCount,
    type BacklinksResult,
} from '../../app/view/backlinks';
import { getActiveTabId } from '../../app/state/tabs';

function buildDom(): void {
    document.body.innerHTML = `
        <aside id="toc-region">
            <section class="backlinks-section" id="backlinks-section">
                <header class="backlinks-header" id="backlinks-header" aria-expanded="true">
                    <span class="backlinks-caret" id="backlinks-caret">▾</span>
                    <span class="backlinks-title" id="backlinks-title"></span>
                </header>
                <div class="backlinks-body" id="backlinks-body">
                    <div class="backlinks-empty" id="backlinks-empty"></div>
                    <ul class="backlinks-list" id="backlinks-list" hidden></ul>
                </div>
            </section>
        </aside>
    `;
}

const sample: BacklinksResult = {
    sources: [
        {
            path: '/vault/a.md',
            name: 'a.md',
            hits: [
                { line: 3, snippet: 'see [[Target]]' },
                { line: 10, snippet: 'again [[Target|here]]' },
            ],
        },
        {
            path: '/vault/b.md',
            name: 'b.md',
            hits: [{ line: 1, snippet: '[[Target]]' }],
        },
    ],
    truncated: false,
};

describe('view/backlinks', () => {
    beforeEach(async () => {
        vi.restoreAllMocks();
        __resetBacklinksForTests();
        buildDom();
        await seedDeCatalog();
        installTauriMock();
    });

    it('totalBacklinkCount sums hits', () => {
        expect(totalBacklinkCount(sample)).toBe(3);
        expect(totalBacklinkCount({ sources: [], truncated: false })).toBe(0);
        expect(totalBacklinkCount(null)).toBe(0);
    });

    it('formatBacklinksHeader uses i18n with count', () => {
        expect(formatBacklinksHeader(sample)).toBe('Verlinkt von (3)');
        expect(formatBacklinksHeader({ sources: [], truncated: false })).toBe(
            'Verlinkt von (0)',
        );
    });

    it('renderBacklinks fills list and header', () => {
        renderBacklinks(sample);
        expect(document.getElementById('backlinks-title')!.textContent).toBe(
            'Verlinkt von (3)',
        );
        expect(document.getElementById('backlinks-empty')!.hidden).toBe(true);
        const list = document.getElementById('backlinks-list')!;
        expect(list.hidden).toBe(false);
        expect(list.querySelectorAll('li.backlinks-source').length).toBe(2);
        expect(list.querySelectorAll('li.backlinks-hit').length).toBe(3);
        const firstRow = list.querySelector('.backlinks-source-row') as HTMLElement;
        expect(firstRow.dataset.path).toBe('/vault/a.md');
        expect(firstRow.title).toBe('/vault/a.md');
        expect(firstRow.querySelector('.backlinks-source-name')!.textContent).toBe('a.md');
    });

    it('renderBacklinks shows empty state when no sources', () => {
        renderBacklinks({ sources: [], truncated: false });
        expect(document.getElementById('backlinks-empty')!.hidden).toBe(false);
        expect(document.getElementById('backlinks-empty')!.textContent).toBe('Keine Backlinks');
        expect(document.getElementById('backlinks-list')!.hidden).toBe(true);
    });

    it('renderBacklinks shows truncated hint', () => {
        renderBacklinks({ ...sample, truncated: true });
        const hint = document.querySelector('.backlinks-truncated');
        expect(hint).toBeTruthy();
        expect(hint!.textContent).toBe('Liste gekürzt');
    });

    it('stale-guard drops outdated fetch results', async () => {
        const tauri = installTauriMock();
        let resolveFirst: (v: BacklinksResult) => void = () => {};
        const first = new Promise<BacklinksResult>((r) => {
            resolveFirst = r;
        });
        let call = 0;
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd !== 'backlinks_for') return Promise.resolve(undefined);
            call += 1;
            if (call === 1) return first;
            return Promise.resolve({
                sources: [
                    {
                        path: '/vault/new.md',
                        name: 'new.md',
                        hits: [{ line: 1, snippet: '[[X]]' }],
                    },
                ],
                truncated: false,
            });
        });

        // Start two sequential refreshes (gen 1 then gen 2).
        const p1 = refreshBacklinksNow('/old.md');
        const p2 = refreshBacklinksNow('/new.md');
        await p2;
        // Late first response must not overwrite gen-2 UI.
        resolveFirst({
            sources: [
                {
                    path: '/vault/stale.md',
                    name: 'stale.md',
                    hits: [{ line: 1, snippet: 'stale' }],
                },
            ],
            truncated: false,
        });
        await p1;

        const list = document.getElementById('backlinks-list')!;
        expect(list.textContent).toContain('new.md');
        expect(list.textContent).not.toContain('stale.md');
        expect(__backlinksFetchGenForTests()).toBe(2);
    });

    it('scheduleBacklinksRefresh debounces and fetches', async () => {
        vi.useFakeTimers();
        const tauri = installTauriMock();
        tauri.invoke.mockResolvedValue({ sources: [], truncated: false });

        scheduleBacklinksRefresh('/a.md');
        scheduleBacklinksRefresh('/b.md');
        expect(tauri.invoke).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(300);
        expect(tauri.invoke).toHaveBeenCalledTimes(1);
        expect(tauri.invoke).toHaveBeenCalledWith('backlinks_for', { path: '/b.md' });
        vi.useRealTimers();
    });

    // ----- F6: saved-Gates, Single-Flight, Save-Heuristik -----------------

    it('F6a: shouldRefreshBacklinksOnSaved rejects inactive tabId', () => {
        vi.mocked(getActiveTabId).mockReturnValue(1);
        __setLastBacklinksPathForTests('/vault/active.md');
        expect(
            shouldRefreshBacklinksOnSaved({
                path: '/vault/other.md',
                tabId: 99,
                text: 'see [[X]]',
            }),
        ).toBe(false);
        expect(
            shouldRefreshBacklinksOnSaved({
                path: '/vault/active.md',
                tabId: 1,
                text: 'see [[X]]',
            }),
        ).toBe(true);
    });

    it('F6a: shouldRefreshBacklinksOnSaved rejects path ≠ lastBacklinksPath', () => {
        vi.mocked(getActiveTabId).mockReturnValue(1);
        __setLastBacklinksPathForTests('/vault/active.md');
        expect(
            shouldRefreshBacklinksOnSaved({
                path: '/vault/other.md',
                tabId: 1,
                text: '[[X]]',
            }),
        ).toBe(false);
    });

    it('F6c: skip save refresh when no [[ and panel empty', () => {
        vi.mocked(getActiveTabId).mockReturnValue(1);
        __setLastBacklinksPathForTests('/vault/active.md');
        renderBacklinks({ sources: [], truncated: false });
        expect(isBacklinksPanelEmpty()).toBe(true);
        expect(
            shouldRefreshBacklinksOnSaved({
                path: '/vault/active.md',
                tabId: 1,
                text: 'plain text without wikilinks',
            }),
        ).toBe(false);
        // With [[ in text → refresh
        expect(
            shouldRefreshBacklinksOnSaved({
                path: '/vault/active.md',
                tabId: 1,
                text: 'see [[Note]]',
            }),
        ).toBe(true);
        // Non-empty panel → refresh even without [[
        renderBacklinks(sample);
        expect(isBacklinksPanelEmpty()).toBe(false);
        expect(
            shouldRefreshBacklinksOnSaved({
                path: '/vault/active.md',
                tabId: 1,
                text: 'plain',
            }),
        ).toBe(true);
    });

    it('F6a: onDocumentSaved does not invoke for foreign tab', async () => {
        vi.useFakeTimers();
        const tauri = installTauriMock();
        tauri.invoke.mockResolvedValue({ sources: [], truncated: false });
        vi.mocked(getActiveTabId).mockReturnValue(1);
        __setLastBacklinksPathForTests('/vault/active.md');

        onDocumentSaved({ path: '/vault/other.md', tabId: 7, text: '[[X]]' });
        await vi.advanceTimersByTimeAsync(300);
        expect(tauri.invoke).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('F6b: single-flight queues latest path only', async () => {
        const tauri = installTauriMock();
        let resolveFirst: (v: BacklinksResult) => void = () => {};
        const first = new Promise<BacklinksResult>((r) => {
            resolveFirst = r;
        });
        const calls: string[] = [];
        tauri.invoke.mockImplementation((cmd: string, args?: { path?: string }) => {
            if (cmd !== 'backlinks_for') return Promise.resolve(undefined);
            calls.push(args?.path || '');
            if (calls.length === 1) return first;
            return Promise.resolve({
                sources: [
                    {
                        path: '/vault/third.md',
                        name: 'third.md',
                        hits: [{ line: 1, snippet: '[[T]]' }],
                    },
                ],
                truncated: false,
            });
        });

        const p1 = refreshBacklinksNow('/first.md');
        // While in-flight, two more requests — only the last should follow.
        const p2 = refreshBacklinksNow('/second.md');
        const p3 = refreshBacklinksNow('/third.md');
        expect(calls).toEqual(['/first.md']);

        resolveFirst({ sources: [], truncated: false });
        await Promise.all([p1, p2, p3]);

        // Exactly one follow-up for the latest path.
        expect(calls).toEqual(['/first.md', '/third.md']);
        const list = document.getElementById('backlinks-list')!;
        expect(list.textContent).toContain('third.md');
        expect(__lastBacklinksPathForTests()).toBe('/third.md');
        expect(__backlinksFetchGenForTests()).toBe(3);
    });

    // W8: der Wikilink-Index wird im Hintergrund gebaut; das Panel muss
    // danach nachziehen, sonst zeigt es das Ergebnis des leeren Index.
    it('refreshBacklinksAfterIndexReady laedt das angezeigte Dokument neu', async () => {
        vi.useFakeTimers();
        try {
            __setLastBacklinksPathForTests('/vault/target.md');
            const genBefore = __backlinksFetchGenForTests();
            const invoke = (window as unknown as {
                __TAURI__: { core: { invoke: ReturnType<typeof vi.fn> } };
            }).__TAURI__.core.invoke;
            invoke.mockClear();
            invoke.mockResolvedValue({ sources: [], truncated: false });

            refreshBacklinksAfterIndexReady();
            expect(__backlinksFetchGenForTests()).toBe(genBefore + 1);
            expect(invoke).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(400);
            expect(invoke).toHaveBeenCalledWith('backlinks_for', {
                path: '/vault/target.md',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshBacklinksAfterIndexReady ist ohne Dokument ein No-op', () => {
        __setLastBacklinksPathForTests(null);
        const genBefore = __backlinksFetchGenForTests();
        refreshBacklinksAfterIndexReady();
        expect(__backlinksFetchGenForTests()).toBe(genBefore);
    });
});
