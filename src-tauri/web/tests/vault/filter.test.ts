// Tests fuer vault/filter.ts (Etappe F2). Spec-Liste:
// Debounce + runId-Guard, Escape-Kaskade, Chip-Toggle (options_set + refresh),
// Filtermodus blendet Recent aus, Expand inert, truncated-Hinweis,
// Rueckkehr via refreshVault, Funnel-Badge.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

vi.mock('../../app/vault/context-menu', () => ({
    openContextMenu: vi.fn(),
    closeContextMenu: vi.fn(),
    runOrOpenFile: vi.fn(),
}));

let tauri: TauriMockHandles;
let disposeFilter: () => void = () => {};

function buildDom(): void {
    document.body.className = '';
    document.body.innerHTML = `
        <aside id="vault-region" class="vault-region">
            <header class="vault-header">
                <button type="button" class="vault-cmd" id="vault-filter-toggle"
                    aria-pressed="false"></button>
            </header>
            <div class="vault-filter" id="vault-filter" hidden>
                <div class="vault-filter-bar">
                    <input type="search" id="vault-filter-input" />
                    <button type="button" id="vault-filter-md" aria-pressed="false">.md</button>
                    <button type="button" id="vault-filter-clear" hidden></button>
                </div>
            </div>
            <div class="vault-filter-truncated" id="vault-filter-truncated" hidden>truncated</div>
            <ul id="vault-tree" class="tree">
                <li class="section" data-section="pinned">
                    <div class="row"><span class="label">Pinned</span></div>
                    <ul class="children">
                        <li class="node" data-kind="dir" data-path="/vault">
                            <div class="row">
                                <span class="caret"></span>
                                <span class="label">vault</span>
                            </div>
                            <ul class="children collapsed"></ul>
                        </li>
                        <li class="node" data-kind="file" data-path="/vault/a.md">
                            <div class="row"><span class="label">a.md</span></div>
                        </li>
                    </ul>
                </li>
                <li class="section" data-section="recent">
                    <div class="row"><span class="label">Recent</span></div>
                    <ul class="children">
                        <li class="node" data-kind="file" data-path="/vault/old.md">
                            <div class="row"><span class="label">old.md</span></div>
                        </li>
                    </ul>
                </li>
            </ul>
        </aside>
    `;
}

function $(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
}

function input(): HTMLInputElement {
    return $('vault-filter-input') as HTMLInputElement;
}

async function flushMicro(): Promise<void> {
    for (let i = 0; i < 16; i++) await Promise.resolve();
}

function filterHtml(path = '/vault/hit.md', name = 'hit.md'): string {
    return `<li class="node" data-path="${path}" data-kind="file"><div class="row"><span class="label">${name}</span></div></li>`;
}

function configureInvoke(opts?: {
    barVisible?: boolean;
    markdownOnly?: boolean;
    filterHtml?: string;
    truncated?: boolean;
    delayed?: boolean;
}): { resolveAt: (index: number) => void; queueLen: () => number } {
    const queue: Array<{ resolve: (v: unknown) => void }> = [];

    tauri.invoke.mockImplementation((cmd: string, args?: any) => {
        if (cmd === 'vault_filter_options_get') {
            return Promise.resolve({
                markdownOnly: !!opts?.markdownOnly,
                barVisible: !!opts?.barVisible,
            });
        }
        if (cmd === 'vault_filter_options_set') {
            return Promise.resolve(undefined);
        }
        if (cmd === 'vault_filter') {
            const payload = {
                html: opts?.filterHtml ?? filterHtml(),
                truncated: !!opts?.truncated,
                nodeCount: 1,
                runId: args?.runId,
            };
            if (opts?.delayed) {
                return new Promise((resolve) => {
                    queue.push({
                        resolve: () => resolve(payload),
                    });
                });
            }
            return Promise.resolve(payload);
        }
        if (cmd === 'vault_build_tree') {
            return Promise.resolve(
                `<li class="section" data-section="pinned"><ul class="children">${filterHtml('/lazy.md', 'lazy.md')}</ul></li>` +
                    `<li class="section" data-section="recent"><ul class="children"></ul></li>`,
            );
        }
        return Promise.resolve(undefined);
    });

    return {
        queueLen: () => queue.length,
        resolveAt(index: number) {
            const item = queue[index];
            if (!item) throw new Error(`no pending vault_filter at ${index}`);
            queue.splice(index, 1);
            item.resolve();
        },
    };
}

async function initModules(): Promise<{
    filter: typeof import('../../app/vault/filter');
    tree: typeof import('../../app/vault/tree');
}> {
    const filter = await import('../../app/vault/filter');
    const tree = await import('../../app/vault/tree');
    tree.initVaultTree({ openDocument: vi.fn() });
    disposeFilter = filter.initVaultFilter();
    await flushMicro();
    return { filter, tree };
}

async function typeQuery(q: string): Promise<void> {
    const el = input();
    el.value = q;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tauri = installTauriMock();
    buildDom();
    vi.resetModules();
    await seedDeCatalog();
    tauri = installTauriMock();
    buildDom();
});

afterEach(() => {
    disposeFilter();
    disposeFilter = () => {};
    vi.useRealTimers();
});

describe('vault/filter — debounce + runId-Guard', () => {
    it('debounces input 150ms then calls vault_filter', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('note');
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(149);
        expect(tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        await flushMicro();
        const calls = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toMatchObject({ query: 'note', markdownOnly: false });
        expect(typeof calls[0][1].runId).toBe('number');
    });

    it('discards stale vault_filter responses (lower runId)', async () => {
        // FX9: unterscheidbares HTML pro runId — Assertion auf NEUESTEN Inhalt.
        const queue: Array<{ resolve: (v: unknown) => void; args: any }> = [];
        tauri.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({ markdownOnly: false, barVisible: false });
            }
            if (cmd === 'vault_filter_options_set') return Promise.resolve(undefined);
            if (cmd === 'vault_build_tree') {
                return Promise.resolve('<li class="section" data-section="pinned"><ul class="children"></ul></li>');
            }
            if (cmd === 'vault_filter') {
                const q = args?.query || '';
                const payload = {
                    html: filterHtml(`/vault/${q}.md`, `${q}.md`),
                    truncated: false,
                    nodeCount: 1,
                    runId: args?.runId,
                };
                return new Promise((resolve) => {
                    queue.push({ resolve: () => resolve(payload), args });
                });
            }
            return Promise.resolve(undefined);
        });
        await initModules();

        await typeQuery('a');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();

        await typeQuery('ab');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect(queue.length).toBe(2);

        // Newer first (ab), then older (a) — older must not overwrite.
        queue[1].resolve();
        await flushMicro();
        const htmlAfterNew = document.querySelector(
            '#vault-tree li.section[data-section="pinned"] > ul.children',
        )!.innerHTML;
        expect(htmlAfterNew).toContain('ab.md');
        expect(htmlAfterNew).not.toContain('data-path="/vault/a.md"');
        expect($('vault-tree').classList.contains('filtering')).toBe(true);

        queue[0].resolve();
        await flushMicro();
        expect(
            document.querySelector(
                '#vault-tree li.section[data-section="pinned"] > ul.children',
            )!.innerHTML,
        ).toContain('ab.md');
        expect(
            document.querySelector(
                '#vault-tree li.section[data-section="pinned"] > ul.children',
            )!.innerHTML,
        ).not.toContain('>"a.md"<');
    });
});

describe('vault/filter — Escape-Kaskade', () => {
    it('first Escape clears query; second closes the bar', async () => {
        configureInvoke({ barVisible: true });
        await initModules();
        expect($('vault-filter').hidden).toBe(false);

        await typeQuery('x');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect($('vault-tree').classList.contains('filtering')).toBe(true);

        const buildCallsBefore = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_build_tree',
        ).length;

        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flushMicro();
        expect(input().value).toBe('');
        expect($('vault-tree').classList.contains('filtering')).toBe(false);
        const buildCallsAfter = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_build_tree',
        ).length;
        expect(buildCallsAfter).toBeGreaterThan(buildCallsBefore);
        expect($('vault-filter').hidden).toBe(false);

        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flushMicro();
        expect($('vault-filter').hidden).toBe(true);
        const setCalls = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter_options_set');
        expect(setCalls.some((c) => c[1]?.barVisible === false)).toBe(true);
    });
});

describe('vault/filter — markdown chip', () => {
    it('without query: options_set + vault_build_tree (lazy mode)', async () => {
        configureInvoke();
        await initModules();
        const buildBefore = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree').length;
        tauri.invoke.mockClear();
        // restore handlers after clear
        configureInvoke();

        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();

        const setCalls = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter_options_set');
        expect(setCalls.length).toBeGreaterThanOrEqual(1);
        expect(setCalls[setCalls.length - 1][1]).toMatchObject({ markdownOnly: true });
        const buildCalls = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree');
        expect(buildCalls.length).toBeGreaterThanOrEqual(1);
        expect($('vault-tree').classList.contains('filtering')).toBe(false);
        expect($('vault-filter-toggle').classList.contains('filter-active')).toBe(true);
        void buildBefore;
    });

    it('with query: re-runs vault_filter with markdownOnly', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('hit');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        tauri.invoke.mockClear();
        configureInvoke();

        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();

        const filterCalls = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter');
        expect(filterCalls.length).toBeGreaterThanOrEqual(1);
        expect(filterCalls[filterCalls.length - 1][1]).toMatchObject({
            query: 'hit',
            markdownOnly: true,
        });
    });
});

describe('vault/filter — filter mode UI', () => {
    it('adds filtering class and replaces pinned children HTML', async () => {
        configureInvoke({ filterHtml: filterHtml('/vault/hit.md', 'hit.md') });
        await initModules();
        await typeQuery('hit');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();

        expect($('vault-tree').classList.contains('filtering')).toBe(true);
        expect(
            document.querySelector(
                '#vault-tree li.section[data-section="pinned"] > ul.children',
            )!.innerHTML,
        ).toContain('hit.md');
        expect(
            document.querySelector('#vault-tree li.section[data-section="recent"]'),
        ).not.toBeNull();
    });

    it('shows truncated banner when truncated:true', async () => {
        configureInvoke({ truncated: true });
        await initModules();
        await typeQuery('f');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect($('vault-filter-truncated').hidden).toBe(false);
    });

    it('clear leaves filter mode and rebuilds lazy tree via vault_build_tree', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('hit');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect($('vault-tree').classList.contains('filtering')).toBe(true);

        const buildBefore = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree').length;
        $('vault-filter-clear').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(input().value).toBe('');
        expect($('vault-tree').classList.contains('filtering')).toBe(false);
        const buildAfter = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree').length;
        expect(buildAfter).toBeGreaterThan(buildBefore);
        expect($('vault-filter-truncated').hidden).toBe(true);
    });

    it('funnel badge filter-active when query or markdown_only active', async () => {
        configureInvoke();
        await initModules();
        const funnel = $('vault-filter-toggle');
        expect(funnel.classList.contains('filter-active')).toBe(false);

        await typeQuery('x');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect(funnel.classList.contains('filter-active')).toBe(true);

        input().value = '';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect(funnel.classList.contains('filter-active')).toBe(false);

        $('vault-filter-md').click();
        await flushMicro();
        expect(funnel.classList.contains('filter-active')).toBe(true);
    });

    it('funnel toggles bar visibility and persists options', async () => {
        configureInvoke({ barVisible: false });
        await initModules();
        expect($('vault-filter').hidden).toBe(true);
        $('vault-filter-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect($('vault-filter').hidden).toBe(false);
        const setCalls = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter_options_set');
        expect(setCalls.some((c) => c[1]?.barVisible === true)).toBe(true);
    });
});

describe('vault/filter — expand inert in filter mode', () => {
    it('dir click does not emit expand-dir while filter-render is active', async () => {
        configureInvoke({
            filterHtml: `
                <li class="node" data-kind="dir" data-path="/vault">
                    <div class="row"><span class="caret open"></span><span class="label">vault</span></div>
                    <ul class="children">
                        <li class="node" data-kind="file" data-path="/vault/hit.md">
                            <div class="row"><span class="label">hit.md</span></div>
                        </li>
                    </ul>
                </li>`,
        });
        const { filter } = await initModules();
        await typeQuery('hit');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect(filter.isVaultFilterRenderMode()).toBe(true);

        tauri.emit.mockClear();
        const dirRow = document.querySelector(
            '#vault-tree .node[data-kind="dir"] > .row',
        ) as HTMLElement;
        expect(dirRow).toBeTruthy();
        dirRow.click();

        const expandCalls = tauri.emit.mock.calls.filter(
            (c: any[]) => c[0] === 'shell:event' && c[1]?.type === 'expand-dir',
        );
        expect(expandCalls).toHaveLength(0);
        const collapseCalls = tauri.emit.mock.calls.filter(
            (c: any[]) => c[0] === 'shell:event' && c[1]?.type === 'collapse-dir',
        );
        expect(collapseCalls).toHaveLength(0);
    });
});

describe('vault/filter — pin drag disabled while filtering', () => {
    // jsdom: PointerEvent unvollständig — generisches Event + Felder (tree.test.ts).
    function pe(type: string, opts: Record<string, unknown> = {}): Event {
        const ev = new Event(type, { bubbles: true, cancelable: true }) as any;
        Object.assign(ev, { button: 0, pointerId: 1, clientX: 0, clientY: 0 }, opts);
        return ev;
    }

    it('pointerdown on pinned root does not start drag when filtering', async () => {
        configureInvoke({
            filterHtml: `
                <li class="node" data-kind="file" data-path="/a.md">
                    <div class="row"><span class="label">a.md</span></div>
                </li>
                <li class="node" data-kind="file" data-path="/b.md">
                    <div class="row"><span class="label">b.md</span></div>
                </li>`,
        });
        await initModules();
        await typeQuery('md');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect($('vault-tree').classList.contains('filtering')).toBe(true);

        const row = document.querySelector(
            '#vault-tree li.section[data-section="pinned"] > ul.children > li.node > .row',
        ) as HTMLElement;
        row.dispatchEvent(pe('pointerdown', { clientX: 10, clientY: 10 }));
        document.dispatchEvent(pe('pointermove', { clientX: 40, clientY: 40 }));
        expect(document.body.classList.contains('pin-dragging')).toBe(false);
        expect(document.querySelector('.dragging')).toBeNull();
    });
});

describe('vault/filter — vault:refresh buffered in filter mode', () => {
    it('does not rebuild tree on vault:refresh while filtering; rebuilds on leave', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('hit');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();

        const buildBefore = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree').length;
        tauri.emitEvent('vault:refresh', { pinned: '<li>x</li>', recent: '<li>y</li>' });
        await flushMicro();
        const buildMid = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree').length;
        expect(buildMid).toBe(buildBefore);
        // Filter HTML still there
        expect($('vault-tree').classList.contains('filtering')).toBe(true);

        // Leave filter → refreshVault (and pending flag)
        input().value = '';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        const buildAfter = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree').length;
        expect(buildAfter).toBeGreaterThan(buildBefore);
        expect($('vault-tree').classList.contains('filtering')).toBe(false);
    });
});

describe('vault/filter — FX2 refreshVault stale guard', () => {
    it('late vault_build_tree response does not overwrite filter tree', async () => {
        let resolveBuild: ((v: unknown) => void) | null = null;
        tauri.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({ markdownOnly: false, barVisible: true });
            }
            if (cmd === 'vault_filter_options_set') return Promise.resolve(undefined);
            if (cmd === 'vault_filter') {
                return Promise.resolve({
                    html: filterHtml('/vault/filter-hit.md', 'filter-hit.md'),
                    truncated: false,
                    nodeCount: 1,
                    runId: args?.runId,
                });
            }
            if (cmd === 'vault_build_tree') {
                return new Promise((resolve) => {
                    resolveBuild = resolve;
                });
            }
            return Promise.resolve(undefined);
        });
        await initModules();
        // Start a lazy rebuild while not filtering (boot may have pending).
        // Enter filter mode first.
        await typeQuery('hit');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect($('vault-tree').classList.contains('filtering')).toBe(true);
        expect(_pinnedHtml()).toContain('filter-hit.md');

        // Trigger refreshVault while filtering (e.g. chip path); hold the response.
        const tree = await import('../../app/vault/tree');
        const p = tree.refreshVault();
        await flushMicro();
        expect(resolveBuild).toBeTruthy();
        // Resolve late with lazy HTML — must be discarded.
        resolveBuild!(
            `<li class="section" data-section="pinned"><ul class="children">${filterHtml('/lazy-stale.md', 'lazy-stale.md')}</ul></li>`,
        );
        await p;
        await flushMicro();
        expect(_pinnedHtml()).toContain('filter-hit.md');
        expect(_pinnedHtml()).not.toContain('lazy-stale.md');
        expect($('vault-tree').classList.contains('filtering')).toBe(true);
    });
});

function _pinnedHtml(): string {
    return (
        document.querySelector(
            '#vault-tree li.section[data-section="pinned"] > ul.children',
        )?.innerHTML || ''
    );
}

describe('vault/filter — FX3 md chip uses live input', () => {
    it('chip click with undebounced input runs vault_filter on live value', async () => {
        configureInvoke();
        await initModules();
        // Type without waiting for debounce
        input().value = 'liveq';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        tauri.invoke.mockClear();
        configureInvoke();

        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();

        const filterCalls = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter');
        expect(filterCalls.length).toBeGreaterThanOrEqual(1);
        expect(filterCalls[filterCalls.length - 1][1]).toMatchObject({
            query: 'liveq',
            markdownOnly: true,
        });
    });

    it('in-flight pre-toggle response is discarded after chip click', async () => {
        const queue: Array<() => void> = [];
        tauri.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({ markdownOnly: false, barVisible: true });
            }
            if (cmd === 'vault_filter_options_set') return Promise.resolve(undefined);
            if (cmd === 'vault_build_tree') {
                return Promise.resolve(
                    '<li class="section" data-section="pinned"><ul class="children"></ul></li>',
                );
            }
            if (cmd === 'vault_filter') {
                const md = !!args?.markdownOnly;
                const payload = {
                    html: filterHtml(
                        md ? '/vault/after.md' : '/vault/before.md',
                        md ? 'after.md' : 'before.md',
                    ),
                    truncated: false,
                    nodeCount: 1,
                    runId: args?.runId,
                };
                return new Promise((resolve) => {
                    queue.push(() => resolve(payload));
                });
            }
            return Promise.resolve(undefined);
        });
        await initModules();
        await typeQuery('q');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect(queue.length).toBe(1);

        // Toggle md before first response resolves.
        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(queue.length).toBe(2);

        // Resolve pre-toggle (before) then post-toggle (after).
        queue[0]();
        await flushMicro();
        queue[1]();
        await flushMicro();
        expect(_pinnedHtml()).toContain('after.md');
        expect(_pinnedHtml()).not.toContain('before.md');
    });
});

describe('vault/filter — FX9 dir_changed buffered', () => {
    it('vault:dir_changed in filter mode does not emit expand-dir; rebuild on leave', async () => {
        configureInvoke({
            filterHtml: `
                <li class="node" data-kind="dir" data-path="/vault">
                    <div class="row"><span class="caret open"></span><span class="label">vault</span></div>
                    <ul class="children">
                        <li class="node" data-kind="file" data-path="/vault/hit.md">
                            <div class="row"><span class="label">hit.md</span></div>
                        </li>
                    </ul>
                </li>`,
        });
        await initModules();
        await typeQuery('hit');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();

        tauri.emit.mockClear();
        const buildBefore = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree').length;
        tauri.emitEvent('vault:dir_changed', { path: '/vault' });
        await flushMicro();
        const expandCalls = tauri.emit.mock.calls.filter(
            (c: any[]) => c[0] === 'shell:event' && c[1]?.type === 'expand-dir',
        );
        expect(expandCalls).toHaveLength(0);

        input().value = '';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        const buildAfter = tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_build_tree').length;
        expect(buildAfter).toBeGreaterThan(buildBefore);
    });
});

describe('vault/filter — vf-hit highlight', () => {
    it('wraps first case-insensitive match in span.vf-hit', async () => {
        configureInvoke({
            filterHtml: filterHtml('/vault/Notes.md', 'Notes.md'),
        });
        await initModules();
        await typeQuery('notes');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();

        const hit = document.querySelector(
            '#vault-tree li.section[data-section="pinned"] .vf-hit',
        ) as HTMLElement | null;
        expect(hit).not.toBeNull();
        expect(hit!.textContent).toBe('Notes');
        const label = hit!.parentElement!;
        expect(label.classList.contains('label')).toBe(true);
        expect(label.textContent).toBe('Notes.md');
    });

    it('does not highlight when query is empty (lazy mode)', async () => {
        configureInvoke({ filterHtml: filterHtml('/vault/Notes.md', 'Notes.md') });
        await initModules();
        await typeQuery('notes');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect(document.querySelector('.vf-hit')).not.toBeNull();

        input().value = '';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();
        expect(document.querySelector('.vf-hit')).toBeNull();
    });

    it('treats special characters literally (no regex)', async () => {
        configureInvoke({
            filterHtml: filterHtml('/vault/a(b).md', 'a(b).md'),
        });
        await initModules();
        await typeQuery('(b)');
        await vi.advanceTimersByTimeAsync(150);
        await flushMicro();

        const hit = document.querySelector(
            '#vault-tree li.section[data-section="pinned"] .vf-hit',
        ) as HTMLElement | null;
        expect(hit).not.toBeNull();
        expect(hit!.textContent).toBe('(b)');
        expect(
            document.querySelector(
                '#vault-tree li.section[data-section="pinned"] .label',
            )!.textContent,
        ).toBe('a(b).md');
    });
});
