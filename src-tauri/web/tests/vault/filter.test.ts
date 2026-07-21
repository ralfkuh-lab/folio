// Tests für vault/filter.ts (R3). Spec: docs/spec-vault-filter.md
// Client-Filter, Highlight, Re-Apply, Observer-Reentranz, Escape/Close,
// Badge nur bei md-only, eingebettetes Text-✕.

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
                <button type="button" class="vault-cmd" id="vault-expand-level"></button>
                <button type="button" class="vault-cmd" id="vault-collapse-all"></button>
                <button type="button" class="vault-cmd" id="vault-filter-toggle"
                    aria-pressed="false"></button>
            </header>
            <div class="vault-filter" id="vault-filter" hidden>
                <div class="vault-filter-bar">
                    <div class="vault-filter-input-wrap">
                        <input type="search" id="vault-filter-input" />
                        <button type="button" id="vault-filter-clear" hidden></button>
                    </div>
                    <button type="button" id="vault-filter-md" aria-pressed="false">.md</button>
                    <button type="button" id="vault-filter-close"></button>
                </div>
            </div>
            <div class="vault-tree-notice" id="vault-tree-notice" hidden></div>
            <ul id="vault-tree" class="tree">
                <li class="section" data-section="pinned">
                    <div class="row"><span class="label">Pinned</span></div>
                    <ul class="children">
                        <li class="node" data-kind="dir" data-path="/vault">
                            <div class="row">
                                <span class="caret open"></span>
                                <span class="label">vault</span>
                            </div>
                            <ul class="children">
                                <li class="node" data-kind="file" data-path="/vault/Alpha.md">
                                    <div class="row"><span class="label">Alpha.md</span></div>
                                </li>
                                <li class="node" data-kind="file" data-path="/vault/Beta.md">
                                    <div class="row"><span class="label">Beta.md</span></div>
                                </li>
                                <li class="node" data-kind="file" data-path="/vault/notes.txt">
                                    <div class="row"><span class="label">notes.txt</span></div>
                                </li>
                                <li class="node" data-kind="dir" data-path="/vault/Notes">
                                    <div class="row">
                                        <span class="caret"></span>
                                        <span class="label">Notes</span>
                                    </div>
                                    <ul class="children collapsed"></ul>
                                </li>
                            </ul>
                        </li>
                    </ul>
                </li>
                <li class="section" data-section="recent">
                    <div class="row"><span class="label">Recent</span></div>
                    <ul class="children">
                        <li class="node" data-kind="file" data-path="/vault/old.md">
                            <div class="row"><span class="label">old.md</span></div>
                        </li>
                        <li class="node" data-kind="file" data-path="/vault/Alpha.md">
                            <div class="row"><span class="label">Alpha.md</span></div>
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

function isHidden(path: string): boolean {
    const el = document.querySelector(
        `#vault-tree li.node[data-path="${path}"]`,
    ) as HTMLElement | null;
    return !!el && el.classList.contains('vf-hidden');
}

function isVisible(path: string): boolean {
    const el = document.querySelector(
        `#vault-tree li.node[data-path="${path}"]`,
    ) as HTMLElement | null;
    return !!el && !el.classList.contains('vf-hidden');
}

async function flushMicro(): Promise<void> {
    for (let i = 0; i < 16; i++) await Promise.resolve();
}

function configureInvoke(opts?: {
    barVisible?: boolean;
    markdownOnly?: boolean;
}): void {
    tauri.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'vault_filter_options_get') {
            return Promise.resolve({
                markdownOnly: !!opts?.markdownOnly,
                barVisible: !!opts?.barVisible,
            });
        }
        if (cmd === 'vault_filter_options_set') {
            return Promise.resolve(undefined);
        }
        if (cmd === 'vault_build_tree') {
            return Promise.resolve($('vault-tree').innerHTML);
        }
        if (cmd === 'vault_expand_level') {
            return Promise.resolve({ html: $('vault-tree').innerHTML, capped: false });
        }
        if (cmd === 'vault_collapse_all') {
            return Promise.resolve({ html: $('vault-tree').innerHTML });
        }
        return Promise.resolve(undefined);
    });
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

describe('vault/filter — client filter (R3)', () => {
    it('debounces 150ms then hides non-matching files; folders stay', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('alp');
        vi.advanceTimersByTime(149);
        expect(isVisible('/vault/Beta.md')).toBe(true);
        vi.advanceTimersByTime(1);
        await flushMicro();
        expect(isVisible('/vault/Alpha.md')).toBe(true);
        expect(isHidden('/vault/Beta.md')).toBe(true);
        expect(isHidden('/vault/notes.txt')).toBe(true);
        // Ordner immer sichtbar
        expect(isVisible('/vault')).toBe(true);
        expect(isVisible('/vault/Notes')).toBe(true);
        // Recent auch gefiltert
        expect(isHidden('/vault/old.md')).toBe(true);
        const recentAlpha = document.querySelectorAll(
            '#vault-tree li.section[data-section="recent"] li.node[data-path="/vault/Alpha.md"]',
        );
        expect(recentAlpha.length).toBe(1);
        expect((recentAlpha[0] as HTMLElement).classList.contains('vf-hidden')).toBe(false);
    });

    it('highlights matching file and folder labels with vf-hit', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('notes');
        vi.advanceTimersByTime(150);
        await flushMicro();
        // notes.txt match + Notes folder
        expect(isVisible('/vault/notes.txt')).toBe(true);
        expect(isHidden('/vault/Alpha.md')).toBe(true);
        const hits = document.querySelectorAll('#vault-tree span.vf-hit');
        expect(hits.length).toBeGreaterThanOrEqual(2);
        const labels = Array.from(hits).map((h) => h.textContent);
        expect(labels.some((t) => t && t.toLowerCase() === 'notes' || t === 'N' || (t && t.length > 0))).toBe(true);
        // folder Notes has hit
        const notesDir = document.querySelector(
            'li.node[data-path="/vault/Notes"] .vf-hit',
        );
        expect(notesDir).not.toBeNull();
        const notesFile = document.querySelector(
            'li.node[data-path="/vault/notes.txt"] .vf-hit',
        );
        expect(notesFile).not.toBeNull();
    });

    it('re-applies filter after DOM mutation (insert children)', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        expect(isHidden('/vault/Beta.md')).toBe(true);

        // Simuliere Expand: neues Kind einfügen
        const children = document.querySelector(
            'li.node[data-path="/vault"] > ul.children',
        )!;
        const li = document.createElement('li');
        li.className = 'node';
        li.setAttribute('data-kind', 'file');
        li.setAttribute('data-path', '/vault/Alphabet.md');
        li.innerHTML = '<div class="row"><span class="label">Alphabet.md</span></div>';
        children.appendChild(li);

        // MutationObserver is sync in jsdom when microtasks flush
        await flushMicro();
        // Alphabet matcht 'alp'
        expect(li.classList.contains('vf-hidden')).toBe(false);
        expect(li.querySelector('.vf-hit')).not.toBeNull();

        const li2 = document.createElement('li');
        li2.className = 'node';
        li2.setAttribute('data-kind', 'file');
        li2.setAttribute('data-path', '/vault/Gamma.md');
        li2.innerHTML = '<div class="row"><span class="label">Gamma.md</span></div>';
        children.appendChild(li2);
        await flushMicro();
        expect(li2.classList.contains('vf-hidden')).toBe(true);
    });

    it('observer reentrancy: applying filter does not loop', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();

        // Trigger several mutations — should settle without stack overflow
        const children = document.querySelector(
            'li.node[data-path="/vault"] > ul.children',
        )!;
        for (let i = 0; i < 5; i++) {
            const li = document.createElement('li');
            li.className = 'node';
            li.setAttribute('data-kind', 'file');
            li.setAttribute('data-path', `/vault/x${i}.md`);
            li.innerHTML = `<div class="row"><span class="label">x${i}.md</span></div>`;
            children.appendChild(li);
        }
        await flushMicro();
        // Still consistent: Alpha visible, Beta hidden
        expect(isVisible('/vault/Alpha.md')).toBe(true);
        expect(isHidden('/vault/Beta.md')).toBe(true);
    });

    it('observer settles: no self-sustaining mutation churn', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();

        // Externer Probe-Observer zählt Mutationen am Baum. Nach einer
        // externen Mutation muss der Churn zur Ruhe kommen — ohne
        // takeRecords()-Drain hält der Filter sich über seine eigenen
        // Highlight-Umbauten endlos am Laufen (Mikrotask-Loop).
        const tree = document.getElementById('vault-tree')!;
        let churn = 0;
        const probe = new MutationObserver((records) => {
            churn += records.length;
        });
        probe.observe(tree, { childList: true, subtree: true });

        const children = document.querySelector(
            'li.node[data-path="/vault"] > ul.children',
        )!;
        const li = document.createElement('li');
        li.className = 'node';
        li.setAttribute('data-kind', 'file');
        li.setAttribute('data-path', '/vault/alpine.md');
        li.innerHTML = '<div class="row"><span class="label">alpine.md</span></div>';
        children.appendChild(li);

        for (let i = 0; i < 10; i++) await flushMicro();
        const settled = churn;
        for (let i = 0; i < 10; i++) await flushMicro();
        expect(churn).toBe(settled);
        probe.disconnect();

        // Und der neue Knoten ist korrekt gefiltert + gehighlightet.
        expect(isVisible('/vault/alpine.md')).toBe(true);
        expect(
            document.querySelector(
                'li.node[data-path="/vault/alpine.md"] .vf-hit',
            ),
        ).not.toBeNull();
    });

    it('clears highlights and unhides when query emptied', async () => {
        configureInvoke();
        await initModules();
        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        expect(document.querySelector('.vf-hit')).not.toBeNull();
        expect(isHidden('/vault/Beta.md')).toBe(true);

        $('vault-filter-clear').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(document.querySelector('.vf-hit')).toBeNull();
        expect(isVisible('/vault/Beta.md')).toBe(true);
        expect(input().value).toBe('');
        expect($('vault-filter-clear').hidden).toBe(true);
    });
});

describe('vault/filter — Escape / Close / Badge / embedded clear', () => {
    it('Escape with text clears query; Escape empty closes bar', async () => {
        configureInvoke({ barVisible: true });
        await initModules();
        // bar should open from opts
        await flushMicro();
        expect($('vault-filter').hidden).toBe(false);

        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        expect(isHidden('/vault/Beta.md')).toBe(true);

        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flushMicro();
        expect(input().value).toBe('');
        expect(isVisible('/vault/Beta.md')).toBe(true);
        expect($('vault-filter').hidden).toBe(false);

        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flushMicro();
        expect($('vault-filter').hidden).toBe(true);
    });

    it('close button clears query and closes bar', async () => {
        configureInvoke({ barVisible: true });
        await initModules();
        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        $('vault-filter-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect($('vault-filter').hidden).toBe(true);
        expect(input().value).toBe('');
        expect(isVisible('/vault/Beta.md')).toBe(true);
    });

    it('badge filter-active only for markdownOnly, not query', async () => {
        configureInvoke();
        await initModules();
        const funnel = $('vault-filter-toggle');
        expect(funnel.classList.contains('filter-active')).toBe(false);

        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        // Query zählt nicht für Badge
        expect(funnel.classList.contains('filter-active')).toBe(false);

        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(funnel.classList.contains('filter-active')).toBe(true);
        expect($('vault-filter-md').getAttribute('aria-pressed')).toBe('true');

        const setCalls = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_filter_options_set',
        );
        expect(setCalls.length).toBeGreaterThan(0);
        const last = setCalls[setCalls.length - 1][1] as {
            markdownOnly: boolean;
            barVisible: boolean;
        };
        expect(last.markdownOnly).toBe(true);
        expect(last).not.toHaveProperty('matchFiles');
    });

    it('embedded clear button only visible with text', async () => {
        configureInvoke({ barVisible: true });
        await initModules();
        expect($('vault-filter-clear').hidden).toBe(true);
        input().value = 'x';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        expect($('vault-filter-clear').hidden).toBe(false);
        // Clear is inside wrap
        const wrap = document.querySelector('.vault-filter-input-wrap');
        expect(wrap?.contains($('vault-filter-clear'))).toBe(true);
    });

    it('funnel toggle closes bar and clears query', async () => {
        configureInvoke({ barVisible: true });
        await initModules();
        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        $('vault-filter-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect($('vault-filter').hidden).toBe(true);
        expect(input().value).toBe('');
        expect(isVisible('/vault/Beta.md')).toBe(true);
    });
});

describe('vault/filter — expand level / collapse all', () => {
    it('expand level invokes vault_expand_level and renders html', async () => {
        configureInvoke();
        await initModules();
        const html =
            '<li class="section" data-section="pinned"><ul class="children">' +
            '<li class="node" data-kind="dir" data-path="/vault"><div class="row"><span class="label">vault</span></div></li>' +
            '</ul></li>';
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({ markdownOnly: false, barVisible: false });
            }
            if (cmd === 'vault_expand_level') {
                return Promise.resolve({ html, capped: true });
            }
            return Promise.resolve(undefined);
        });
        $('vault-expand-level').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(
            tauri.invoke.mock.calls.some((c) => c[0] === 'vault_expand_level'),
        ).toBe(true);
        expect($('vault-tree').innerHTML).toContain('/vault');
        // capped notice
        expect($('vault-tree-notice').hidden).toBe(false);
        expect($('vault-tree-notice').textContent).toBeTruthy();
    });

    it('collapse all invokes vault_collapse_all', async () => {
        configureInvoke();
        await initModules();
        $('vault-collapse-all').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(
            tauri.invoke.mock.calls.some((c) => c[0] === 'vault_collapse_all'),
        ).toBe(true);
    });
});

describe('vault/filter — automation reset', () => {
    it('__folioVaultFilterReset clears query, closes bar, md-only off', async () => {
        configureInvoke({ barVisible: true, markdownOnly: true });
        const { filter } = await initModules();
        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        filter.resetVaultFilterForAutomation();
        await flushMicro();
        expect(input().value).toBe('');
        expect($('vault-filter').hidden).toBe(true);
        expect($('vault-filter-md').getAttribute('aria-pressed')).toBe('false');
        expect($('vault-filter-toggle').classList.contains('filter-active')).toBe(false);
        expect(isVisible('/vault/Beta.md')).toBe(true);
    });
});
