// Tests für vault/filter.ts (R3/R3.1). Spec: docs/spec-vault-filter.md
// Client-Filter, Highlight, Re-Apply, Observer-Reentranz, Escape/Close,
// Badge nur bei md-only, expand-roots disabled-sync.

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

function buildDom(opts?: { pinRootOpen?: boolean }): void {
    const pinOpen = opts?.pinRootOpen !== false;
    const caretClass = pinOpen ? 'caret open' : 'caret';
    document.body.className = '';
    document.body.innerHTML = `
        <aside id="vault-region" class="vault-region">
            <header class="vault-header">
                <button type="button" class="vault-cmd" id="vault-expand-roots"></button>
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
                    <button type="button" id="vault-filter-git" aria-pressed="false">git</button>
                    <button type="button" id="vault-filter-close"></button>
                </div>
            </div>
            <div id="vault-tree-notice" hidden></div>
            <ul id="vault-tree" class="tree">
                <li class="section" data-section="pinned">
                    <div class="row"><span class="label">Pinned</span></div>
                    <ul class="children">
                        <li class="node" data-kind="dir" data-path="/vault">
                            <div class="row">
                                <span class="${caretClass}"></span>
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

function expandBtn(): HTMLButtonElement {
    return $('vault-expand-roots') as HTMLButtonElement;
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
    gitChangedOnly?: boolean;
}): void {
    tauri.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'vault_filter_options_get') {
            return Promise.resolve({
                markdownOnly: !!opts?.markdownOnly,
                barVisible: !!opts?.barVisible,
                gitChangedOnly: !!opts?.gitChangedOnly,
            });
        }
        if (cmd === 'vault_filter_options_set') {
            return Promise.resolve(undefined);
        }
        if (cmd === 'vault_build_tree') {
            return Promise.resolve($('vault-tree').innerHTML);
        }
        if (cmd === 'vault_expand_roots') {
            return Promise.resolve({ html: $('vault-tree').innerHTML });
        }
        if (cmd === 'vault_expand_paths') {
            return Promise.resolve({
                html: $('vault-tree').innerHTML,
                capped: false,
                expanded: 0,
            });
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
            gitChangedOnly: boolean;
        };
        expect(last.markdownOnly).toBe(true);
        expect(last.gitChangedOnly).toBe(false);
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

describe('vault/filter — expand roots / collapse all / disabled', () => {
    it('expand roots invokes vault_expand_roots and renders html', async () => {
        buildDom({ pinRootOpen: false });
        configureInvoke();
        await initModules();
        const html =
            '<li class="section" data-section="pinned"><ul class="children">' +
            '<li class="node" data-kind="dir" data-path="/vault">' +
            '<div class="row"><span class="caret open"></span><span class="label">vault</span></div>' +
            '</li></ul></li>';
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({ markdownOnly: false, barVisible: false });
            }
            if (cmd === 'vault_expand_roots') {
                return Promise.resolve({ html });
            }
            return Promise.resolve(undefined);
        });
        expandBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(
            tauri.invoke.mock.calls.some((c) => c[0] === 'vault_expand_roots'),
        ).toBe(true);
        expect($('vault-tree').innerHTML).toContain('/vault');
        // After expand with open caret → disabled
        expect(expandBtn().disabled).toBe(true);
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

    it('disabled when all pin roots open; enabled after collapse via observer', async () => {
        // Default DOM: pin root has caret open → disabled
        configureInvoke();
        await initModules();
        expect(expandBtn().disabled).toBe(true);

        // Simulate collapse_all rebuild: root caret closed
        const collapsedHtml =
            '<li class="section" data-section="pinned">' +
            '<div class="row"><span class="label">Pinned</span></div>' +
            '<ul class="children">' +
            '<li class="node" data-kind="dir" data-path="/vault">' +
            '<div class="row"><span class="caret"></span><span class="label">vault</span></div>' +
            '<ul class="children collapsed"></ul></li></ul></li>';
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({ markdownOnly: false, barVisible: false });
            }
            if (cmd === 'vault_collapse_all') {
                return Promise.resolve({ html: collapsedHtml });
            }
            return Promise.resolve(undefined);
        });
        $('vault-collapse-all').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(expandBtn().disabled).toBe(false);
    });

    it('observer-driven: closing pin caret enables button without query', async () => {
        configureInvoke();
        await initModules();
        expect(expandBtn().disabled).toBe(true);

        // Close pin root caret via DOM mutation (Observer, no query)
        const caret = document.querySelector(
            'li.section[data-section="pinned"] > ul.children > li.node[data-kind="dir"] > .row > .caret',
        ) as HTMLElement;
        expect(caret).not.toBeNull();
        caret.classList.remove('open');
        // class mutation alone may not fire childList observer — replace node
        const root = document.querySelector(
            'li.section[data-section="pinned"] > ul.children > li.node[data-kind="dir"]',
        )!;
        const parent = root.parentElement!;
        const clone = root.cloneNode(true) as HTMLElement;
        clone.querySelector('.caret')?.classList.remove('open');
        parent.replaceChild(clone, root);
        await flushMicro();
        expect(expandBtn().disabled).toBe(false);
    });

    it('init with collapsed pin root enables expand-roots', async () => {
        buildDom({ pinRootOpen: false });
        configureInvoke();
        await initModules();
        expect(expandBtn().disabled).toBe(false);
    });
});

describe('vault/filter — git changed only', () => {
    async function seedGit(
        entries: Array<{ path: string; status: 'modified' | 'untracked' }>,
    ): Promise<void> {
        const git = await import('../../app/vault/git-status');
        git.__setGitStatusSnapshotForTests(entries);
    }

    it('hides unchanged files and dirs; expands dirs that contain changes', async () => {
        configureInvoke();
        await initModules();
        await seedGit([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Alpha.md', status: 'modified' },
            { path: '/vault/Notes', status: 'untracked' },
            { path: '/vault/Notes/deep.md', status: 'untracked' },
        ]);

        const expandedHtml =
            $('vault-tree').innerHTML.replace(
                'data-path="/vault/Notes"',
                'data-path="/vault/Notes" data-opened="1"',
            );
        tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({
                    markdownOnly: false,
                    barVisible: false,
                    gitChangedOnly: false,
                });
            }
            if (cmd === 'vault_filter_options_set') return Promise.resolve(undefined);
            if (cmd === 'vault_expand_paths') {
                expect(args && (args as { paths: string[] }).paths).toEqual(
                    expect.arrayContaining(['/vault', '/vault/Notes']),
                );
                return Promise.resolve({
                    html: expandedHtml,
                    capped: false,
                    expanded: 2,
                });
            }
            return Promise.resolve(undefined);
        });

        $('vault-filter-git').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();

        expect(isVisible('/vault/Alpha.md')).toBe(true);
        expect(isHidden('/vault/Beta.md')).toBe(true);
        expect(isHidden('/vault/notes.txt')).toBe(true);
        expect(isVisible('/vault')).toBe(true);
        expect(isVisible('/vault/Notes')).toBe(true);
        expect($('vault-filter-toggle').classList.contains('filter-active')).toBe(true);
        expect(
            tauri.invoke.mock.calls.some((c) => c[0] === 'vault_expand_paths'),
        ).toBe(true);
        expect($('vault-tree').innerHTML).toContain('data-opened="1"');
    });

    it('combines with the name filter; markdown-only persist stays independent', async () => {
        configureInvoke();
        await initModules();
        await seedGit([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Alpha.md', status: 'modified' },
            { path: '/vault/Beta.md', status: 'modified' },
        ]);
        $('vault-filter-git').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        expect(isVisible('/vault/Alpha.md')).toBe(true);
        expect(isHidden('/vault/Beta.md')).toBe(true);
        expect(isVisible('/vault')).toBe(true);

        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        const setCalls = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_filter_options_set',
        );
        const last = setCalls[setCalls.length - 1][1] as {
            markdownOnly: boolean;
            gitChangedOnly: boolean;
        };
        expect(last.markdownOnly).toBe(true);
        expect(last.gitChangedOnly).toBe(true);
    });

    it('untracked dir snapshot keeps children visible; segment boundary holds', async () => {
        configureInvoke();
        await initModules();
        const notes = document.querySelector(
            'li.node[data-path="/vault/Notes"] > ul.children',
        )!;
        notes.classList.remove('collapsed');
        notes.innerHTML = `
            <li class="node" data-kind="file" data-path="/vault/Notes/deep.md">
                <div class="row"><span class="label">deep.md</span></div>
            </li>`;
        const vaultChildren = document.querySelector(
            'li.node[data-path="/vault"] > ul.children',
        )!;
        const neues = document.createElement('li');
        neues.className = 'node';
        neues.setAttribute('data-kind', 'file');
        neues.setAttribute('data-path', '/vault/neues.md');
        neues.innerHTML = '<div class="row"><span class="label">neues.md</span></div>';
        vaultChildren.appendChild(neues);

        // Realer porcelain-Fall: nur der Ordner, keine Kinddatei.
        await seedGit([
            { path: '/vault', status: 'untracked' },
            { path: '/vault/Notes', status: 'untracked' },
        ]);
        $('vault-filter-git').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(isVisible('/vault/Notes')).toBe(true);
        expect(isVisible('/vault/Notes/deep.md')).toBe(true);
        expect(isHidden('/vault/Beta.md')).toBe(true);
        expect(isHidden('/vault/neues.md')).toBe(true);
    });

    it('expands only dirs under visible pins (cap runs on that set)', async () => {
        configureInvoke();
        await initModules();
        await seedGit([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Alpha.md', status: 'modified' },
            { path: '/other', status: 'modified' },
            { path: '/other/x.md', status: 'modified' },
            { path: '/other/a', status: 'modified' },
            { path: '/other/b', status: 'modified' },
        ]);
        const sent: string[][] = [];
        tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({
                    markdownOnly: false,
                    barVisible: false,
                    gitChangedOnly: false,
                });
            }
            if (cmd === 'vault_filter_options_set') return Promise.resolve(undefined);
            if (cmd === 'vault_expand_paths') {
                sent.push(((args && args.paths) as string[]) || []);
                return Promise.resolve({
                    html: $('vault-tree').innerHTML,
                    capped: false,
                    expanded: 1,
                });
            }
            return Promise.resolve(undefined);
        });
        $('vault-filter-git').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(sent.length).toBe(1);
        expect(sent[0].every((p) => p === '/vault' || p.startsWith('/vault/'))).toBe(
            true,
        );
        expect(sent[0].some((p) => p === '/other' || p.startsWith('/other/'))).toBe(
            false,
        );
    });

    it('retries expand when a snapshot arrives during an in-flight run', async () => {
        configureInvoke();
        await initModules();
        await seedGit([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Alpha.md', status: 'modified' },
        ]);
        const resolvers: Array<(value: unknown) => void> = [];
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({
                    markdownOnly: false,
                    barVisible: false,
                    gitChangedOnly: false,
                });
            }
            if (cmd === 'vault_filter_options_set') return Promise.resolve(undefined);
            if (cmd === 'vault_expand_paths') {
                return new Promise((resolve) => {
                    resolvers.push(resolve);
                });
            }
            return Promise.resolve(undefined);
        });
        $('vault-filter-git').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(resolvers.length).toBe(1);

        await seedGit([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Alpha.md', status: 'modified' },
            { path: '/vault/Notes', status: 'untracked' },
        ]);
        await flushMicro();
        expect(resolvers.length).toBe(1);

        resolvers[0]({
            html: $('vault-tree').innerHTML,
            capped: false,
            expanded: 1,
        });
        await flushMicro();
        expect(resolvers.length).toBe(2);
        resolvers[1]({
            html: $('vault-tree').innerHTML,
            capped: false,
            expanded: 1,
        });
        await flushMicro();
    });

    it('turning the git filter off does not collapse the tree', async () => {
        configureInvoke();
        await initModules();
        await seedGit([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Alpha.md', status: 'modified' },
        ]);
        $('vault-filter-git').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect($('vault-filter-git').getAttribute('aria-pressed')).toBe('true');

        $('vault-filter-git').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect($('vault-filter-git').getAttribute('aria-pressed')).toBe('false');
        expect(
            tauri.invoke.mock.calls.some((c) => c[0] === 'vault_collapse_all'),
        ).toBe(false);
        const pinCaret = document.querySelector(
            'li.section[data-section="pinned"] > ul.children > li.node[data-kind="dir"] > .row > .caret',
        ) as HTMLElement;
        expect(pinCaret.classList.contains('open')).toBe(true);
        expect(isVisible('/vault/Beta.md')).toBe(true);
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
        expect($('vault-filter-git').getAttribute('aria-pressed')).toBe('false');
        expect($('vault-filter-toggle').classList.contains('filter-active')).toBe(false);
        expect(isVisible('/vault/Beta.md')).toBe(true);
    });
});
