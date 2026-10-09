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
                <div class="vault-filter-scope" id="vault-filter-scope" hidden>
                    <span class="vault-filter-scope-icon" aria-hidden="true">📁</span>
                    <span class="vault-filter-scope-name" id="vault-filter-scope-name"></span>
                    <button type="button" id="vault-filter-scope-remove"></button>
                </div>
                <div class="vault-filter-bar">
                    <div class="vault-filter-input-wrap">
                        <input type="search" id="vault-filter-input" />
                        <button type="button" id="vault-filter-clear" hidden></button>
                    </div>
                    <button type="button" id="vault-filter-md" aria-pressed="false">.md</button>
                    <button type="button" id="vault-filter-git" aria-pressed="false">git</button>
                    <button type="button" id="vault-filter-deep" aria-pressed="false">**</button>
                    <button type="button" id="vault-filter-hidden" aria-pressed="false">.*</button>
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
    deep?: boolean;
    hidden?: boolean;
}): void {
    tauri.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'vault_filter_options_get') {
            return Promise.resolve({
                markdownOnly: !!opts?.markdownOnly,
                barVisible: !!opts?.barVisible,
                gitChangedOnly: !!opts?.gitChangedOnly,
                deep: !!opts?.deep,
                hidden: !!opts?.hidden,
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

    it('badge filter-active for query and markdownOnly', async () => {
        configureInvoke();
        await initModules();
        const funnel = $('vault-filter-toggle');
        expect(funnel.classList.contains('filter-active')).toBe(false);

        await typeQuery('alp');
        vi.advanceTimersByTime(150);
        await flushMicro();
        // Aktiver Namensfilter zählt für Badge
        expect(funnel.classList.contains('filter-active')).toBe(true);

        await typeQuery('');
        vi.advanceTimersByTime(150);
        await flushMicro();
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

// ---------------------------------------------------------------------------
// R4 — Tiefenfilter und Ordnerbereich
// ---------------------------------------------------------------------------

describe('vault/filter — deep filter (R4)', () => {
    function deepInvoke(
        handlers: Record<string, (args?: any) => unknown>,
    ): void {
        tauri.invoke.mockImplementation((cmd: string, args?: any) => {
            const handler = handlers[cmd];
            if (handler) return Promise.resolve(handler(args));
            if (cmd === 'vault_filter_options_get') {
                return Promise.resolve({
                    markdownOnly: false,
                    barVisible: false,
                    gitChangedOnly: false,
                    deep: false,
                });
            }
            if (cmd === 'vault_filter_options_set') return Promise.resolve(undefined);
            if (cmd === 'vault_build_tree') {
                return Promise.resolve($('vault-tree').innerHTML);
            }
            if (cmd === 'vault_expand_paths') {
                return Promise.resolve({
                    html: $('vault-tree').innerHTML,
                    capped: false,
                    expanded: 0,
                    paths: [],
                });
            }
            if (cmd === 'vault_collapse_paths') {
                return Promise.resolve({ html: $('vault-tree').innerHTML });
            }
            if (cmd === 'file_icons_batch') return Promise.resolve({});
            return Promise.resolve(undefined);
        });
    }

    function clickDeep(): void {
        $('vault-filter-deep').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    async function typeAndSettle(q: string): Promise<void> {
        await typeQuery(q);
        vi.advanceTimersByTime(150);
        await flushMicro();
    }

    it('chip toggles and persists deep', async () => {
        configureInvoke();
        await initModules();
        clickDeep();
        await flushMicro();
        expect($('vault-filter-deep').getAttribute('aria-pressed')).toBe('true');
        const setCalls = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_filter_options_set',
        );
        const last = setCalls[setCalls.length - 1][1] as { deep: boolean };
        expect(last.deep).toBe(true);
        clickDeep();
        await flushMicro();
        expect($('vault-filter-deep').getAttribute('aria-pressed')).toBe('false');
        const last2 = tauri.invoke.mock.calls
            .filter((c) => c[0] === 'vault_filter_options_set')
            .pop()![1] as { deep: boolean };
        expect(last2.deep).toBe(false);
    });

    it('below two characters no vault_filter_find is issued', async () => {
        deepInvoke({ vault_filter_find: () => ({ files: [], dirs: [] }) });
        await initModules();
        clickDeep();
        await flushMicro();
        await typeAndSettle('a');
        expect(
            tauri.invoke.mock.calls.some((c) => c[0] === 'vault_filter_find'),
        ).toBe(false);
        await typeAndSettle('ab');
        expect(
            tauri.invoke.mock.calls.filter((c) => c[0] === 'vault_filter_find').length,
        ).toBe(1);
    });

    it('answer makes exactly hits + ancestors visible, everything else hidden', async () => {
        deepInvoke({
            vault_filter_find: () => ({
                files: ['/vault/Alpha.md'],
                dirs: ['/vault'],
                truncated: false,
                reason: null,
            }),
            vault_expand_paths: () => ({
                html: $('vault-tree').innerHTML,
                capped: false,
                expanded: 1,
                paths: ['/vault'],
            }),
        });
        await initModules();
        clickDeep();
        await flushMicro();
        await typeAndSettle('alp');

        expect(isVisible('/vault/Alpha.md')).toBe(true);
        expect(isHidden('/vault/Beta.md')).toBe(true);
        expect(isHidden('/vault/notes.txt')).toBe(true);
        // Vorfahre der sichtbaren Datei bleibt sichtbar, andere Ordner nicht.
        expect(isVisible('/vault')).toBe(true);
        expect(isHidden('/vault/Notes')).toBe(true);
        // Recent bleibt Namensmatch (R3-Regel).
        expect(isHidden('/vault/old.md')).toBe(true);
    });

    it('discards a stale generation answer', async () => {
        const resolvers: Array<(value: unknown) => void> = [];
        deepInvoke({
            vault_filter_find: () =>
                new Promise((resolve) => {
                    resolvers.push(resolve);
                }),
        });
        await initModules();
        clickDeep();
        await flushMicro();
        await typeAndSettle('alp');
        expect(resolvers.length).toBe(1);

        // Neue Query waehrend des Laufs: Generation steigt, Single-Flight
        // startet noch keine zweite Anfrage.
        await typeAndSettle('alph');
        expect(resolvers.length).toBe(1);

        // Alte (leere) Antwort darf den Baum NICHT leeren.
        resolvers[0]({ files: [], dirs: [], truncated: false, reason: null });
        await flushMicro();
        expect(isVisible('/vault/Alpha.md')).toBe(true);
        expect(isVisible('/vault')).toBe(true);

        // Nachhol-Lauf mit der letzten Query.
        expect(resolvers.length).toBe(2);
        resolvers[1]({ files: ['/vault/Alpha.md'], dirs: ['/vault'], truncated: false, reason: null });
        await flushMicro();
        expect(isVisible('/vault/Alpha.md')).toBe(true);
        expect(isHidden('/vault/Beta.md')).toBe(true);
        expect(isHidden('/vault/Notes')).toBe(true);
    });

    it('single-flight keeps only the last query', async () => {
        const sent: string[] = [];
        const resolvers: Array<(value: unknown) => void> = [];
        deepInvoke({
            vault_filter_find: (args?: any) => {
                sent.push(args.query);
                return new Promise((resolve) => {
                    resolvers.push(resolve);
                });
            },
        });
        await initModules();
        clickDeep();
        await flushMicro();
        await typeAndSettle('aa');
        expect(sent).toEqual(['aa']);
        await typeAndSettle('ab');
        await typeAndSettle('abc');
        expect(sent).toEqual(['aa']);
        resolvers[0]({ files: [], dirs: [], truncated: false, reason: null });
        await flushMicro();
        expect(sent).toEqual(['aa', 'abc']);
    });

    it('cleanup collapses only the folders the filter opened', async () => {
        const collapseArgs: string[][] = [];
        deepInvoke({
            vault_filter_find: () => ({
                files: ['/vault/Alpha.md'],
                dirs: ['/vault', '/vault/Notes'],
                truncated: false,
                reason: null,
            }),
            // `/vault` war vorher schon offen → Backend meldet nur Notes neu.
            vault_expand_paths: () => ({
                html: $('vault-tree').innerHTML,
                capped: false,
                expanded: 1,
                paths: ['/vault/Notes'],
            }),
            vault_collapse_paths: (args?: any) => {
                collapseArgs.push(args.paths);
                return { html: $('vault-tree').innerHTML };
            },
        });
        await initModules();
        clickDeep();
        await flushMicro();
        await typeAndSettle('alp');
        expect(collapseArgs.length).toBe(0);

        $('vault-filter-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(collapseArgs.length).toBe(1);
        expect(collapseArgs[0]).toEqual(['/vault/Notes']);
        expect(collapseArgs[0]).not.toContain('/vault');
    });

    it('scope implies deep with chip off; chip is removable and transient', async () => {
        const findArgs: any[] = [];
        deepInvoke({
            vault_filter_find: (args?: any) => {
                findArgs.push(args);
                return {
                    files: ['/vault/Alpha.md'],
                    dirs: ['/vault'],
                    truncated: false,
                    reason: null,
                };
            },
        });
        const { filter } = await initModules();
        filter.filterInFolder('/vault');
        await flushMicro();
        expect($('vault-filter-scope').hidden).toBe(false);
        expect($('vault-filter-scope-name').textContent).toBe('vault');
        expect($('vault-filter-scope').getAttribute('title')).toBe('/vault');
        expect($('vault-filter-deep').getAttribute('aria-pressed')).toBe('false');
        expect($('vault-filter-toggle').classList.contains('filter-active')).toBe(true);

        await typeAndSettle('alp');
        expect(findArgs.length).toBe(1);
        expect(findArgs[0].scope).toBe('/vault');

        $('vault-filter-scope-remove').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect($('vault-filter-scope').hidden).toBe(true);

        filter.filterInFolder('/vault');
        await flushMicro();
        expect($('vault-filter-scope').hidden).toBe(false);
        $('vault-filter-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect($('vault-filter-scope').hidden).toBe(true);
    });

    it('scope error clears the scope and shows the error transiently', async () => {
        deepInvoke({
            vault_filter_find: () =>
                Promise.reject('errors.vault.filterScopeNotFound: /x'),
        });
        const { filter } = await initModules();
        filter.filterInFolder('/vault');
        await flushMicro();
        expect($('vault-filter-scope').hidden).toBe(false);

        await typeAndSettle('alp');
        expect($('vault-filter-scope').hidden).toBe(true);
        expect($('vault-tree-notice').hidden).toBe(false);
        expect($('vault-tree-notice').textContent).toContain('filterScopeNotFound');
        // Ohne Bereich/Chip faellt die Sicht auf R3 zurueck.
        expect(isVisible('/vault/Alpha.md')).toBe(true);
    });

    it('shows empty and truncation notices', async () => {
        let response: Record<string, unknown> = {
            files: [],
            dirs: [],
            truncated: false,
            reason: null,
        };
        deepInvoke({ vault_filter_find: () => response });
        await initModules();
        clickDeep();
        await flushMicro();

        await typeAndSettle('aa');
        expect($('vault-tree-notice').hidden).toBe(false);
        expect($('vault-tree-notice').textContent).toContain('Keine Treffer');

        response = { files: [], dirs: [], truncated: true, reason: 'cap' };
        await typeAndSettle('ab');
        expect($('vault-tree-notice').textContent).toContain('Viele Treffer');

        response = { files: [], dirs: [], truncated: true, reason: 'time' };
        await typeAndSettle('abc');
        expect($('vault-tree-notice').textContent).toContain('Suche abgebrochen');
    });

    // --- Korrekturrunde 1 (aus den Review-Repros uebernommen) ----------------

    it('close during expand collapses late-opened paths and rejects late HTML', async () => {
        let finish!: (value: unknown) => void;
        const collapsed: string[][] = [];
        deepInvoke({
            vault_filter_find: () => ({ files: ['/vault/Alpha.md'], dirs: ['/vault', '/vault/Notes'] }),
            vault_expand_paths: () => new Promise(resolve => { finish = resolve; }),
            vault_collapse_paths: (args: any) => {
                collapsed.push(args.paths);
                return { html: $('vault-tree').innerHTML };
            },
        });
        await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('alp');
        const lateHtml = $('vault-tree').innerHTML.replace('class="caret"', 'class="caret open"');
        $('vault-filter-close').click(); await flushMicro();
        finish({ html: lateHtml, paths: ['/vault/Notes'] }); await flushMicro();
        expect(collapsed.flat(), 'late opened paths must be collapsed after close').toContain('/vault/Notes');
        expect(
            document.querySelector('li[data-path="/vault/Notes"] > .row > .caret')!.classList.contains('open'),
        ).toBe(false);
    });

    it('expand IPC is single-flight across query generations', async () => {
        const finishes: Array<(value: unknown) => void> = [];
        deepInvoke({
            vault_filter_find: () => ({ files: ['/vault/Alpha.md'], dirs: ['/vault'] }),
            vault_expand_paths: () => new Promise(resolve => { finishes.push(resolve); }),
        });
        await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('alp');
        expect(finishes.length).toBe(1);
        await typeAndSettle('alph');
        expect(finishes.length, 'second expand must wait for first IPC').toBe(1);
    });

    it('old collapse HTML cannot replace a new deep generation', async () => {
        let finish!: (value: unknown) => void;
        deepInvoke({
            vault_filter_find: () => ({ files: ['/vault/Alpha.md'], dirs: ['/vault', '/vault/Notes'] }),
            vault_expand_paths: () => ({ html: $('vault-tree').innerHTML, paths: ['/vault/Notes'] }),
            vault_collapse_paths: () => new Promise(resolve => { finish = resolve; }),
        });
        await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('alp');
        $('vault-filter-close').click(); await flushMicro();
        await typeAndSettle('alph');
        finish({ html: '<li data-stale-collapse="1"></li>' }); await flushMicro();
        expect($('vault-tree').querySelector('[data-stale-collapse]')).toBeNull();
    });

    it('toggling markdown-only re-runs the deep filter', async () => {
        let md = false;
        deepInvoke({
            vault_filter_options_set: (args: any) => { md = args.markdownOnly; },
            vault_filter_find: () => ({ files: md ? [] : ['/vault/notes.txt'], dirs: md ? [] : ['/vault'] }),
        });
        await initModules();
        $('vault-filter-md').click(); await flushMicro();
        clickDeep(); await flushMicro(); await typeAndSettle('notes');
        expect(isHidden('/vault/notes.txt')).toBe(true);
        $('vault-filter-md').click(); await flushMicro();
        expect(
            isVisible('/vault/notes.txt'),
            'matching .txt must return after disabling md-only',
        ).toBe(true);
    });

    it('vaultShowHidden change invalidates the deep key (K2)', async () => {
        let finds = 0;
        deepInvoke({
            vault_filter_find: () => {
                finds += 1;
                return { files: ['/vault/Alpha.md'], dirs: ['/vault'] };
            },
        });
        await initModules();
        clickDeep();
        await flushMicro();
        await typeAndSettle('alp');
        expect(finds).toBe(1);
        tauri.emitEvent('settings:changed', {
            settings: { vaultShowHidden: false },
            changed: ['vaultShowHidden'],
        });
        await flushMicro();
        expect(finds, 'hidden change must re-issue the deep find').toBe(2);
    });

    it('recent matches cannot keep a no-hit pinned root visible', async () => {
        deepInvoke({ vault_filter_find: () => ({ files: [], dirs: [], truncated: false, reason: null }) });
        await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('alp');
        expect(
            document
                .querySelector('li.section[data-section="recent"] li[data-path="/vault/Alpha.md"]')!
                .classList.contains('vf-hidden'),
        ).toBe(false);
        expect(isHidden('/vault'), 'pinned roots with no deep hit must be hidden').toBe(true);
    });

    it.each([
        ['posix-root', '/', '/Notes/Deep.md', '/Notes'],
        ['drive-root', 'C:/', 'C:/Notes/Deep.md', 'C:/Notes'],
        ['unc-root', '//server/share', '//server/share/Notes/Deep.md', '//server/share/Notes'],
        ['backslash', 'C:\\vault', 'C:\\vault\\Notes\\Deep.md', 'C:\\vault\\Notes'],
    ])('root pin %s with an unrendered hit stays visible', async (_name, root, hit, sub) => {
        const nodes = document.querySelectorAll('li.section[data-section="pinned"] li.node');
        nodes[0].setAttribute('data-path', root);
        nodes[4].setAttribute('data-path', sub);
        deepInvoke({ vault_filter_find: () => ({ files: [hit], dirs: [root, sub] }) });
        await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('deep');
        expect(document.querySelector('li.section[data-section="pinned"] li.node')!.classList.contains('vf-hidden'), 'root with unrendered hit').toBe(false);
    });

    it.each([false, true])('unrendered hit keeps its folder only if git-changed (git=%s)', async (changed) => {
        deepInvoke({ vault_filter_find: () => ({ files: ['/vault/Notes/Sub/Deep.md'], dirs: ['/vault', '/vault/Notes'] }) });
        await initModules();
        const git = await import('../../app/vault/git-status');
        git.__setGitStatusSnapshotForTests(changed ? [{path: '/vault/Notes/Sub/Deep.md', status: 'modified'}] : []);
        $('vault-filter-git').click(); clickDeep(); await flushMicro(); await typeAndSettle('deep');
        expect(isVisible('/vault/Notes')).toBe(changed);
    });

    it('scope + markdown keeps a lazily re-inserted folder visible and closed', async () => {
        deepInvoke({ vault_filter_find: () => ({ files: ['/vault/Notes/Sub/Deep.md'], dirs: ['/vault', '/vault/Notes', '/vault/Notes/Sub'] }) });
        const {filter} = await initModules();
        filter.filterInFolder('/vault'); $('vault-filter-md').click(); await flushMicro();
        expect(isVisible('/vault/Notes')).toBe(true);
        const node = document.querySelector('li[data-path="/vault/Notes"]')!;
        node.remove(); document.querySelector('li[data-path="/vault"] > ul')!.appendChild(node);
        await flushMicro(); expect(isVisible('/vault/Notes')).toBe(true);
        expect(node.querySelector('.caret')!.classList.contains('open')).toBe(false);
    });

    it.each([['/', '/Notes'], ['C:/', 'C:/Notes']])('scope + git sends a valid root chain for pin %s', async (root, scope) => {
        document.querySelector('li.section[data-section="pinned"] li.node')!.setAttribute('data-path', root);
        document.querySelector('li[data-path="/vault/Notes"]')!.setAttribute('data-path', scope);
        const sent: string[][] = [];
        deepInvoke({ vault_expand_paths: (args) => { sent.push(args.paths); return {html: $('vault-tree').innerHTML, paths: []}; } });
        const {filter} = await initModules();
        filter.filterInFolder(scope); await flushMicro(); $('vault-filter-git').click(); await flushMicro();
        expect(sent.flat(), 'scope chain must contain the valid scope path').toContain(scope);
    });

    it('plain scope re-applies to inserts and restores Recent on removal', async () => {
        deepInvoke({}); const {filter} = await initModules();
        filter.filterInFolder('/vault/Notes'); await flushMicro();
        const host = document.querySelector('li[data-path="/vault"] > ul')!;
        host.insertAdjacentHTML('beforeend', '<li class="node" data-kind="dir" data-path="/vault/Other"><div class="row"><span class="label">Other</span></div></li>');
        document.querySelector('li[data-path="/vault/Notes"] > ul')!.insertAdjacentHTML('beforeend', '<li class="node" data-kind="file" data-path="/vault/Notes/In.md"><div class="row"><span class="label">In.md</span></div></li>');
        await flushMicro(); expect(isHidden('/vault/Other')).toBe(true); expect(isVisible('/vault/Notes/In.md')).toBe(true);
        $('vault-filter-scope-remove').click(); await flushMicro();
        expect(isVisible('/vault/Other')).toBe(true);
        expect(document.querySelector('li.section[data-section="recent"] li[data-path="/vault/old.md"]')!.classList.contains('vf-hidden')).toBe(false);
    });

    it('scope clips old deep results immediately while find is pending', async () => {
        let calls = 0;
        deepInvoke({ vault_filter_find: () => ++calls === 1 ? {files: ['/vault/Alpha.md'], dirs: ['/vault']} : new Promise(() => {}) });
        const {filter} = await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('alp');
        expect(isVisible('/vault/Alpha.md')).toBe(true);
        filter.filterInFolder('/vault/Notes'); await flushMicro();
        expect(isHidden('/vault/Alpha.md'), 'outside file must hide before new find resolves').toBe(true);
    });

    it('setting a scope hides everything outside it right away', async () => {
        // Ohne Query, ohne .md, ohne git: der Bereich allein blendet sofort
        // alles neben dem Pfad Pin-Wurzel -> Bereich aus (auch in Recent),
        // ohne zu suchen oder aufzuklappen.
        const calls: string[] = [];
        deepInvoke({
            vault_filter_find: () => { calls.push('find'); return { files: [], dirs: [] }; },
            vault_expand_paths: () => { calls.push('expand'); return { html: $('vault-tree').innerHTML, paths: [] }; },
        });
        const { filter } = await initModules();
        filter.filterInFolder('/vault/Notes'); await flushMicro();
        expect(calls, 'no search, no expand').toEqual([]);
        expect(isVisible('/vault'), 'pin root on the scope chain').toBe(true);
        expect(isVisible('/vault/Notes'), 'scope itself').toBe(true);
        expect(isHidden('/vault/Alpha.md'), 'sibling file outside the scope').toBe(true);
        expect(
            document.querySelector('li.section[data-section="recent"] li[data-path="/vault/old.md"]')!
                .classList.contains('vf-hidden'),
            'recent entry outside the scope',
        ).toBe(true);
        $('vault-filter-scope-remove').click(); await flushMicro();
        expect(isHidden('/vault/Alpha.md'), 'removing the scope shows it again').toBe(false);
    });

    it('folders above unrendered hits stay visible (collapse/re-expand case)', async () => {
        // Nutzer klappt einen vom Filter geoeffneten Ordner zu und wieder auf:
        // der Lazy-Baum rendert nur eine Ebene, der Treffer selbst liegt tiefer
        // und ist NICHT im DOM. Der Ordner mit dem Treffer darunter muss
        // trotzdem sichtbar bleiben, sonst kommt man nie wieder an den Treffer.
        deepInvoke({
            vault_filter_find: () => ({
                files: ['/vault/Notes/Sub/Deep.md'],
                dirs: ['/vault', '/vault/Notes', '/vault/Notes/Sub'],
                truncated: false,
                reason: null,
            }),
            vault_expand_paths: () => ({ html: $('vault-tree').innerHTML, paths: [] }),
        });
        await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('deep');
        expect(document.querySelector('li[data-path="/vault/Notes/Sub/Deep.md"]')).toBeNull();
        expect(document.querySelector('li[data-path="/vault/Notes"]'), 'folder rendered').not.toBeNull();
        expect(isHidden('/vault/Notes'), 'ancestor of an unrendered hit').toBe(false);
        expect(isHidden('/vault'), 'pin root above the hit').toBe(false);
        expect(isHidden('/vault/Alpha.md'), 'non-hit file').toBe(true);
    });

    it('expand cap shows a notice instead of a silent partial result', async () => {
        deepInvoke({
            vault_filter_find: () => ({
                files: ['/vault/Notes/Alpha.md'],
                dirs: ['/vault', '/vault/Notes'],
                truncated: false,
                reason: null,
            }),
            vault_expand_paths: () => ({
                html: $('vault-tree').innerHTML,
                capped: true,
                expanded: 1000,
                paths: [],
            }),
        });
        await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('alp');
        expect($('vault-tree-notice').hidden, 'expand cap hides hits and needs a notice').toBe(false);
    });

    // --- Korrekturrunde 2 (aus der Nachpruefung uebernommen) -----------------

    it('refresh from stale expand cannot reopen collapsed folders', async () => {
        let finishExpand!: (value: unknown) => void;
        const refreshes: Array<(value: unknown) => void> = [];
        let holdRefresh = false;
        let collapses = 0;
        let closed = '';
        deepInvoke({
            vault_filter_find: () => ({
                files: ['/vault/Alpha.md'],
                dirs: ['/vault', '/vault/Notes'],
            }),
            vault_expand_paths: () => new Promise(resolve => { finishExpand = resolve; }),
            vault_build_tree: () =>
                holdRefresh ? new Promise(resolve => refreshes.push(resolve)) : $('vault-tree').innerHTML,
            vault_collapse_paths: () => { collapses++; return { html: closed }; },
        });
        await initModules();
        closed = $('vault-tree').innerHTML;
        const opened = closed.replace('class="caret"', 'class="caret open"');
        clickDeep(); await flushMicro(); await typeAndSettle('alp');
        $('vault-filter-close').click(); await flushMicro();
        holdRefresh = true;
        finishExpand({ html: opened, paths: ['/vault/Notes'] }); await flushMicro();
        expect(refreshes.length).toBe(1);
        refreshes[0](opened); await flushMicro();
        expect(collapses).toBe(1);
        expect(
            document.querySelector('li[data-path="/vault/Notes"] > .row > .caret')!.classList.contains('open'),
            'late refresh must not reopen the collapsed tree',
        ).toBe(false);
    });

    it('refresh from stale collapse cannot overwrite subsequent expand', async () => {
        let finishCollapse!: (value: unknown) => void;
        const refreshes: Array<(value: unknown) => void> = [];
        let holdRefresh = false;
        let expands = 0;
        let closed = '';
        let opened = '';
        deepInvoke({
            vault_filter_find: () => ({
                files: ['/vault/Alpha.md'],
                dirs: ['/vault', '/vault/Notes'],
            }),
            vault_expand_paths: () => { expands++; return { html: opened, paths: ['/vault/Notes'] }; },
            vault_build_tree: () =>
                holdRefresh ? new Promise(resolve => refreshes.push(resolve)) : $('vault-tree').innerHTML,
            vault_collapse_paths: () => new Promise(resolve => { finishCollapse = resolve; }),
        });
        await initModules();
        closed = $('vault-tree').innerHTML;
        opened = closed.replace('class="caret"', 'class="caret open"');
        clickDeep(); await flushMicro(); await typeAndSettle('alp');
        $('vault-filter-close').click(); await flushMicro();
        await typeAndSettle('alph');
        holdRefresh = true;
        finishCollapse({ html: closed }); await flushMicro();
        expect(refreshes.length).toBe(1);
        refreshes[0](closed); await flushMicro();
        expect(expands).toBe(2);
        expect(
            document.querySelector('li[data-path="/vault/Notes"] > .row > .caret')!.classList.contains('open'),
            'late refresh must preserve the new expanded tree',
        ).toBe(true);
    });

    it('stale find rejection preserves the latest scope', async () => {
        let rejectFirst!: (value: unknown) => void;
        let finds = 0;
        deepInvoke({
            vault_filter_find: () => {
                finds++;
                return new Promise((_resolve, reject) => { if (finds === 1) rejectFirst = reject; });
            },
        });
        const { filter } = await initModules();
        filter.filterInFolder('/vault/old'); await typeAndSettle('alp');
        filter.filterInFolder('/vault/new'); await flushMicro();
        rejectFirst('old scope missing'); await flushMicro();
        expect($('vault-filter-scope').getAttribute('title')).toBe('/vault/new');
    });

    it('error without scope does not retry indefinitely', async () => {
        let finds = 0;
        deepInvoke({
            vault_filter_find: () => {
                finds++;
                return finds === 1 ? Promise.reject('backend error') : new Promise(() => {});
            },
        });
        await initModules(); clickDeep(); await flushMicro(); await typeAndSettle('alp');
        expect(finds, 'without scope the same failed request must not restart').toBe(1);
    });

    it('markdown rebuild cannot overwrite the following deep expand', async () => {
        let md = false;
        let holdRefresh = false;
        let closed = '';
        let opened = '';
        const refreshes: Array<(value: unknown) => void> = [];
        deepInvoke({
            vault_filter_options_set: (args: any) => { md = args.markdownOnly; },
            vault_filter_find: () => ({
                files: md ? [] : ['/vault/Notes/notes.txt'],
                dirs: md ? [] : ['/vault', '/vault/Notes'],
            }),
            vault_expand_paths: () => ({ html: md ? closed : opened, paths: md ? [] : ['/vault/Notes'] }),
            vault_build_tree: () =>
                holdRefresh ? new Promise(resolve => refreshes.push(resolve)) : $('vault-tree').innerHTML,
        });
        await initModules();
        closed = $('vault-tree').innerHTML;
        opened = closed.replace('class="caret"', 'class="caret open"');
        $('vault-filter-md').click(); await flushMicro();
        clickDeep(); await flushMicro(); await typeAndSettle('notes');
        holdRefresh = true;
        $('vault-filter-md').click(); await flushMicro();
        expect(refreshes.length).toBe(1);
        refreshes[0](closed); await flushMicro();
        expect(
            document.querySelector('li[data-path="/vault/Notes"] > .row > .caret')!.classList.contains('open'),
            'old md rebuild must not collapse the new matching branch',
        ).toBe(true);
    });

    it('error cleanup leaves the DOM collapsed when close races its response', async () => {
        let finds = 0;
        let finishCleanup!: (value: unknown) => void;
        let closed = '';
        let opened = '';
        deepInvoke({
            vault_filter_find: () => ++finds === 1
                ? { files: ['/vault/Alpha.md'], dirs: ['/vault', '/vault/Notes'] }
                : Promise.reject('backend error'),
            vault_expand_paths: () => ({ html: opened, paths: ['/vault/Notes'] }),
            vault_collapse_paths: () => new Promise(resolve => { finishCleanup = resolve; }),
            vault_build_tree: () => closed || $('vault-tree').innerHTML,
        });
        await initModules();
        closed = $('vault-tree').innerHTML;
        opened = closed.replace('class="caret"', 'class="caret open"');
        clickDeep(); await flushMicro(); await typeAndSettle('alp');
        await typeAndSettle('alph');
        expect(typeof finishCleanup).toBe('function');
        $('vault-filter-close').click(); await flushMicro();
        finishCleanup({ html: closed }); await flushMicro();
        expect(document.querySelector('li[data-path="/vault/Notes"] > .row > .caret')!.classList.contains('open'), 'after error cleanup and close, the DOM must reflect collapsed backend folders').toBe(false);
    });

    // --- R4.1: Bereich mit .md bzw. git ohne Suchbegriff --------------------

    it('scope + markdown-only without query searches and cleans up', async () => {
        const findCalls: Array<{ query: string; scope: string | null }> = [];
        const collapseArgs: string[][] = [];
        let pristine = '';
        deepInvoke({
            vault_filter_find: (args?: any) => {
                findCalls.push(args);
                return {
                    files: [],
                    dirs: ['/vault', '/vault/Notes'],
                    truncated: false,
                    reason: null,
                };
            },
            // Der echte Backend-Expand liefert einen frischen, ungefilterten
            // Baum — die Sicht muss danach erneut angewandt werden.
            vault_expand_paths: () => ({
                html: pristine,
                capped: false,
                expanded: 1,
                paths: ['/vault/Notes'],
            }),
            vault_collapse_paths: (args?: any) => {
                collapseArgs.push(args.paths);
                return { html: $('vault-tree').innerHTML };
            },
        });
        const { filter } = await initModules();
        pristine = $('vault-tree').innerHTML;
        filter.filterInFolder('/vault/Notes');
        await flushMicro();
        expect(findCalls.length, 'ohne md-only und ohne Query kein find').toBe(0);

        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        await flushMicro();
        expect(findCalls.length).toBe(1);
        expect(findCalls[0]).toEqual({ query: '', scope: '/vault/Notes', hidden: false });
        expect(
            tauri.invoke.mock.calls.some((c) => c[0] === 'vault_expand_paths'),
        ).toBe(true);
        // Nach dem Expand-Render muss die Sicht wieder angewandt sein: Datei
        // ausserhalb der Trefferliste bleibt versteckt.
        expect(isHidden('/vault/Beta.md')).toBe(true);

        // .md aus → Deep-Sicht endet, Filter-Ordner werden wieder zugeklappt.
        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        await flushMicro();
        expect(collapseArgs.length).toBe(1);
        expect(collapseArgs[0]).toEqual(['/vault/Notes']);
    });

    it('deep chip + markdown without scope and query does not search', async () => {
        deepInvoke({ vault_filter_find: () => ({ files: [], dirs: [] }) });
        await initModules();
        clickDeep();
        await flushMicro();
        $('vault-filter-md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        await flushMicro();
        expect(
            tauri.invoke.mock.calls.some((c) => c[0] === 'vault_filter_find'),
            'ohne Bereich darf ** + .md ohne Query nicht suchen',
        ).toBe(false);
    });

    it('scope + git restricts expansion and hides nodes outside the scope', async () => {
        const sent: string[][] = [];
        deepInvoke({
            vault_expand_paths: (args?: any) => {
                sent.push(args.paths.slice());
                return {
                    html: $('vault-tree').innerHTML,
                    capped: false,
                    expanded: args.paths.length,
                    paths: [],
                };
            },
        });
        const { filter } = await initModules();
        const git = await import('../../app/vault/git-status');
        git.__setGitStatusSnapshotForTests([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Alpha.md', status: 'modified' },
            { path: '/vault/Notes', status: 'modified' },
            { path: '/vault/Notes/deep.md', status: 'modified' },
        ]);

        filter.filterInFolder('/vault/Notes');
        await flushMicro();
        $('vault-filter-git').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();

        expect(sent.length).toBeGreaterThanOrEqual(1);
        const all = sent.reduce<string[]>((acc, paths) => acc.concat(paths), []);
        for (let i = 0; i < all.length; i++) {
            expect(
                all[i] === '/vault' ||
                    all[i] === '/vault/Notes' ||
                    all[i].startsWith('/vault/Notes/'),
                `unzulaessiger Expand-Pfad ${all[i]}`,
            ).toBe(true);
        }
        // Kette sichtbar, geaenderte Datei ausserhalb des Bereichs versteckt.
        expect(isVisible('/vault')).toBe(true);
        expect(isVisible('/vault/Notes')).toBe(true);
        expect(isHidden('/vault/Alpha.md')).toBe(true);
    });

    // --- Korrekturrunde 1 (Review-Repros, umbenannt) -----------------------

    it('git already on expands the newly selected scope chain', async () => {
        const sent: string[][] = [];
        let pristine = '';
        deepInvoke({ vault_expand_paths: (args?: any) => {
            sent.push(args.paths.slice());
            const template = document.createElement('template');
            template.innerHTML = pristine;
            template.content.querySelector('li[data-path="/vault/Notes"] .caret')!.classList.add('open');
            template.content.querySelector('li[data-path="/vault/Notes"] ul')!.classList.remove('collapsed');
            return { html: template.innerHTML, paths: [], expanded: 0, capped: false };
        }});
        const { filter, tree } = await initModules();
        pristine = $('vault-tree').innerHTML;
        const git = await import('../../app/vault/git-status');
        git.__setGitStatusSnapshotForTests([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Notes', status: 'modified' },
            { path: '/vault/Notes/deep.md', status: 'modified' },
        ]);
        $('vault-filter-git').click();
        await flushMicro();
        // Nutzer klappt den weiterhin sichtbaren geaenderten Ordner zu.
        tree.renderVaultFromHtml(pristine);
        await flushMicro();
        expect(isVisible('/vault/Notes')).toBe(true);
        sent.length = 0;
        filter.filterInFolder('/vault/Notes');
        await flushMicro();
        expect(sent.flat(), 'selecting the collapsed changed scope must reopen Pin -> scope with git already on').toContain('/vault/Notes');
    });

    it('removing the scope expands remaining changed branches', async () => {
        let pristine = '';
        const open = new Set<string>();
        deepInvoke({ vault_expand_paths: (args?: any) => {
            for (const path of args.paths) open.add(path);
            const template = document.createElement('template');
            template.innerHTML = pristine;
            if (open.has('/vault/Notes')) {
                const notes = template.content.querySelector('li[data-path="/vault/Notes"]')!;
                notes.querySelector('.caret')!.classList.add('open');
                notes.querySelector('ul')!.classList.remove('collapsed');
                notes.querySelector('ul')!.innerHTML = '<li class="node" data-kind="file" data-path="/vault/Notes/deep.md"><div class="row"><span class="label">deep.md</span></div></li>';
            }
            return { html: template.innerHTML, paths: [], expanded: 0, capped: false };
        }});
        const { filter } = await initModules();
        document.querySelector('li[data-path="/vault"] > ul')!.insertAdjacentHTML('beforeend', '<li class="node" data-kind="dir" data-path="/vault/Other"><div class="row"><span class="caret"></span><span class="label">Other</span></div><ul class="children collapsed"></ul></li>');
        await flushMicro();
        pristine = $('vault-tree').innerHTML;
        const git = await import('../../app/vault/git-status');
        git.__setGitStatusSnapshotForTests([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Notes', status: 'modified' },
            { path: '/vault/Notes/deep.md', status: 'modified' },
        ]);
        filter.filterInFolder('/vault/Other');
        await flushMicro();
        $('vault-filter-git').click();
        await flushMicro();
        $('vault-filter-scope-remove').click();
        await flushMicro();
        expect(isVisible('/vault/Notes/deep.md'), 'after removing scope the unchanged Git snapshot must again show the changed file outside the former scope').toBe(true);
    });

    it('markdown off with git on reopens the cleaned-up changed scope', async () => {
        let pristine = '';
        let notesWereOpen = false;
        deepInvoke({
            vault_build_tree: () => {
                // vault_build_tree emittiert den frischen Git-Cache erneut.
                window.dispatchEvent(new CustomEvent('folio-git-status-changed'));
                return $('vault-tree').innerHTML;
            },
            vault_filter_find: () => ({ files: ['/vault/Notes/deep.md'], dirs: ['/vault', '/vault/Notes'] }),
            vault_expand_paths: () => {
                const template = document.createElement('template');
                template.innerHTML = pristine;
                const notes = template.content.querySelector('li[data-path="/vault/Notes"]')!;
                notes.querySelector('.caret')!.classList.add('open');
                notes.querySelector('ul')!.classList.remove('collapsed');
                notes.querySelector('ul')!.innerHTML = '<li class="node" data-kind="file" data-path="/vault/Notes/deep.md"><div class="row"><span class="label">deep.md</span></div></li>';
                const newlyOpened = notesWereOpen ? [] : ['/vault/Notes'];
                notesWereOpen = true;
                return { html: template.innerHTML, paths: newlyOpened, expanded: newlyOpened.length, capped: false };
            },
            vault_collapse_paths: () => { notesWereOpen = false; return { html: pristine }; },
        });
        const { filter } = await initModules();
        pristine = $('vault-tree').innerHTML;
        const git = await import('../../app/vault/git-status');
        git.__setGitStatusSnapshotForTests([
            { path: '/vault', status: 'modified' },
            { path: '/vault/Notes', status: 'modified' },
            { path: '/vault/Notes/deep.md', status: 'modified' },
        ]);
        filter.filterInFolder('/vault/Notes');
        $('vault-filter-md').click();
        await flushMicro(); await flushMicro();
        $('vault-filter-git').click();
        await flushMicro();
        expect(isVisible('/vault/Notes/deep.md')).toBe(true);
        $('vault-filter-md').click();
        await flushMicro(); await flushMicro();
        expect(isVisible('/vault/Notes/deep.md'), 'markdown off must leave the changed file reachable and open in the restored scoped Git view').toBe(true);
    });

    it('REVIEW rejects a stale find while hidden persistence is pending', async () => {
        let resolveFind!: (v: unknown) => void;
        let resolveSet!: () => void;
        let delayWrites = false;
        const expands: string[][] = [];
        const findArgs: Array<{ query: string; scope: string | null; hidden: boolean }> = [];
        deepInvoke({
            vault_filter_find: (args?: any) => {
                findArgs.push(args);
                return new Promise(resolve => { resolveFind = resolve; });
            },
            vault_filter_options_set: () => delayWrites ? new Promise<void>(resolve => { resolveSet = resolve; }) : undefined,
            vault_expand_paths: (args: any) => {
                expands.push(args.paths);
                return {html: $('vault-tree').innerHTML, paths: []};
            },
        });
        await initModules(); clickDeep(); await flushMicro();
        await typeAndSettle('alp');
        expect(findArgs.length).toBe(1);
        delayWrites = true;
        $('vault-filter-hidden').click(); await flushMicro();
        resolveFind({files: [], dirs: ['/vault/.herd'], truncated: false, reason: null});
        await flushMicro();
        expect(expands, 'the obsolete response must not expand folders').toEqual([]);
        expect(isVisible('/vault/Alpha.md'), 'obsolete empty result must not hide the current tree').toBe(true);
        // Genau ein neuer Find, und der traegt den neuen Chip-Wert explizit.
        expect(findArgs.length).toBe(2);
        expect(findArgs[1].hidden, 'the new find must carry the new hidden value').toBe(true);
        resolveSet(); await flushMicro();
    });

    it('REVIEW find carries the new hidden value across a concurrent query change', async () => {
        let resolveSet!: () => void;
        let delayWrites = false;
        let finds = 0;
        const findArgs: Array<{ query: string; hidden: boolean }> = [];
        deepInvoke({
            vault_filter_find: (args?: any) => {
                finds++;
                findArgs.push(args);
                return {files: [], dirs: []};
            },
            vault_filter_options_set: () => delayWrites ? new Promise<void>(resolve => { resolveSet = resolve; }) : undefined,
        });
        await initModules(); clickDeep(); await flushMicro();
        await typeAndSettle('spec'); expect(finds).toBe(1);
        delayWrites = true;
        $('vault-filter-hidden').click(); await flushMicro();
        await typeAndSettle('spec2'); expect(finds).toBe(2);
        // Der Find nach dem Query-Wechsel traegt den neuen Chip-Wert bereits —
        // der ausstehende Panel-Write ist keine Voraussetzung fuer korrekte
        // Treffer mehr. Deshalb braucht der Write danach KEINEN dritten Lauf:
        // der Schluessel der zweiten Antwort entspricht dem aktuellen Wunsch.
        expect(findArgs[1].hidden, 'find after the query change must use the new hidden value').toBe(true);
        resolveSet(); await flushMicro();
        expect(finds, 'the key-correct find already satisfies the new hidden key').toBe(2);
    });

    it('hidden chip change invalidates the deep key and re-searches', async () => {
        let finds = 0;
        deepInvoke({
            vault_filter_find: () => {
                finds += 1;
                return { files: ['/vault/Alpha.md'], dirs: ['/vault'] };
            },
        });
        await initModules();
        clickDeep();
        await flushMicro();
        await typeAndSettle('alp');
        expect(finds).toBe(1);
        $('vault-filter-hidden').click();
        await flushMicro();
        expect(finds, 'hidden chip must re-issue the deep find').toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Paket B — Chip „versteckte" (flacher Modus + Persistenz/Reset)
// ---------------------------------------------------------------------------

describe('vault/filter — hidden chip (Paket B)', () => {
    function addHiddenNodes(): void {
        const children = document.querySelector(
            'li.node[data-path="/vault"] > ul.children',
        )!;
        children.insertAdjacentHTML(
            'beforeend',
            '<li class="node" data-kind="dir" data-path="/vault/.herd">' +
                '<div class="row"><span class="caret open"></span>' +
                '<span class="label">.herd</span></div>' +
                '<ul class="children">' +
                '<li class="node" data-kind="file" data-path="/vault/.herd/spec.md">' +
                '<div class="row"><span class="label">spec.md</span></div></li>' +
                '</ul></li>',
        );
        const pinnedUl = document.querySelector(
            'li.section[data-section="pinned"] > ul.children',
        )!;
        pinnedUl.insertAdjacentHTML(
            'beforeend',
            '<li class="node" data-kind="dir" data-path="/vault/.pinned-hidden">' +
                '<div class="row"><span class="caret open"></span>' +
                '<span class="label">.pinned-hidden</span></div>' +
                '<ul class="children">' +
                '<li class="node" data-kind="file" data-path="/vault/.pinned-hidden/spec-y.md">' +
                '<div class="row"><span class="label">spec-y.md</span></div></li>' +
                '</ul></li>',
        );
    }

    it('chip off hides dot files below the pin; a pin on the dot folder stays exempt', async () => {
        configureInvoke();
        await initModules();
        addHiddenNodes();
        await flushMicro();
        await typeQuery('spec');
        vi.advanceTimersByTime(150);
        await flushMicro();

        expect(isHidden('/vault/.herd/spec.md'), 'hidden file below pin must hide').toBe(
            true,
        );
        expect(
            isVisible('/vault/.pinned-hidden/spec-y.md'),
            'a pin directly on the dot folder keeps its content visible',
        ).toBe(true);

        $('vault-filter-hidden').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect($('vault-filter-hidden').getAttribute('aria-pressed')).toBe('true');
        expect(isVisible('/vault/.herd/spec.md'), 'chip on shows the hidden hit').toBe(
            true,
        );
    });

    it('chip alone does not change the tree and does not set the badge', async () => {
        configureInvoke();
        await initModules();
        addHiddenNodes();
        await flushMicro();
        $('vault-filter-hidden').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        expect(isVisible('/vault/Beta.md')).toBe(true);
        expect(isVisible('/vault/.herd/spec.md')).toBe(true);
        expect($('vault-filter-toggle').classList.contains('filter-active')).toBe(false);
    });

    it('restores from options_get and resets via the automation hook', async () => {
        configureInvoke({ hidden: true });
        const { filter } = await initModules();
        await flushMicro();
        expect($('vault-filter-hidden').getAttribute('aria-pressed')).toBe('true');

        filter.resetVaultFilterForAutomation();
        await flushMicro();
        expect($('vault-filter-hidden').getAttribute('aria-pressed')).toBe('false');
        const setCalls = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_filter_options_set',
        );
        const last = setCalls[setCalls.length - 1][1] as { hidden: boolean };
        expect(last.hidden).toBe(false);
    });

    it('toggle persists hidden in vault_filter_options_set', async () => {
        configureInvoke();
        await initModules();
        $('vault-filter-hidden').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicro();
        const setCalls = tauri.invoke.mock.calls.filter(
            (c) => c[0] === 'vault_filter_options_set',
        );
        const last = setCalls[setCalls.length - 1][1] as { hidden: boolean };
        expect(last.hidden).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// K-B3.1 — Pin-Zuordnung des flachen Hidden-Filters auf Windows-Pfaden
// ---------------------------------------------------------------------------

describe('vault/filter — Pin-Zuordnung case-aware (K-B3.1)', () => {
    function setPinAndRecent(root: string, file: string): void {
        const pin = document.querySelector(
            'li.section[data-section="pinned"] > ul.children > li.node',
        ) as HTMLElement;
        pin.setAttribute('data-path', root);
        const node = document.querySelector(
            'li.section[data-section="recent"] li.node[data-kind="file"]',
        ) as HTMLElement;
        node.setAttribute('data-path', file);
        const label = node.querySelector(':scope > .row > .label');
        if (label) label.textContent = 'spec.md';
    }

    function recentFile(): HTMLElement {
        return document.querySelector(
            'li.section[data-section="recent"] li.node[data-kind="file"]',
        ) as HTMLElement;
    }

    async function search(q: string): Promise<void> {
        await typeQuery(q);
        vi.advanceTimersByTime(150);
        await flushMicro();
    }

    it.each([
        ['gleiche Schreibweise', 'C:/.vault', 'C:/.vault/spec.md'],
        ['Backslashes', 'C:\\.vault', 'C:\\.vault\\spec.md'],
        ['Laufwerks-Case', 'C:/.vault', 'c:/.vault/spec.md'],
        ['Segment-Case', 'C:/.Vault', 'C:/.vault/spec.md'],
    ])('Windows-Pin-Zuordnung: %s', async (_label, root, file) => {
        configureInvoke();
        await initModules();
        setPinAndRecent(root, file);
        await search('spec');
        expect(
            recentFile().classList.contains('vf-hidden'),
            'Datei unter dem Pin darf trotz Schreibvarianten nicht ausgeblendet werden',
        ).toBe(false);
    });

    it('Unix bleibt case-sensitiv: anderer Ordner ist kein Pin', async () => {
        configureInvoke();
        await initModules();
        setPinAndRecent('/home/u/.Vault', '/home/u/.vault/spec.md');
        await search('spec');
        expect(
            recentFile().classList.contains('vf-hidden'),
            'Dot-Segment unterhalb keines passenden Pins',
        ).toBe(true);
    });
});
