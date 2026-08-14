// Tests für vault/git-status.ts — Klassen nachtragen, Lazy-Reapply,
// Observer-Reentranz (takeRecords-Drain analog filter.test.ts),
// Generation-Guard, Multi-Repo-Isolation, verwaiste Roots.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

let tauri: TauriMockHandles;
let dispose: () => void = () => {};

function buildDom(): void {
    document.body.innerHTML = `
        <aside id="vault-region" class="vault-region">
            <ul id="vault-tree" class="tree">
                <li class="section" data-section="pinned">
                    <ul class="children">
                        <li class="node" data-kind="dir" data-path="/repo" title="/repo">
                            <div class="row"><span class="label">repo</span></div>
                            <ul class="children">
                                <li class="node" data-kind="file" data-path="/repo/a.md" title="/repo/a.md">
                                    <div class="row"><span class="label">a.md</span></div>
                                </li>
                                <li class="node" data-kind="file" data-path="/repo/b.md" title="/repo/b.md">
                                    <div class="row"><span class="label">b.md</span></div>
                                </li>
                            </ul>
                        </li>
                        <li class="node" data-kind="dir" data-path="/other" title="/other">
                            <div class="row"><span class="label">other</span></div>
                            <ul class="children">
                                <li class="node" data-kind="file" data-path="/other/x.md" title="/other/x.md">
                                    <div class="row"><span class="label">x.md</span></div>
                                </li>
                            </ul>
                        </li>
                    </ul>
                </li>
            </ul>
        </aside>
    `;
}

function node(path: string): HTMLElement {
    return document.querySelector(
        `#vault-tree li.node[data-path="${path}"]`,
    ) as HTMLElement;
}

async function flushMicro(): Promise<void> {
    for (let i = 0; i < 16; i++) await Promise.resolve();
}

async function initModule(): Promise<typeof import('../../app/vault/git-status')> {
    const mod = await import('../../app/vault/git-status');
    dispose = mod.initVaultGitStatus();
    await flushMicro();
    return mod;
}

function emitStatus(
    repoRoot: string,
    entries: Array<{ path: string; status: 'modified' | 'untracked' }>,
    generation = 1,
    extra?: { activeRoots?: string[] },
): void {
    tauri.emitEvent('vault:git_status', {
        repoRoot,
        entries,
        generation,
        ...extra,
    });
}

beforeEach(async () => {
    vi.clearAllMocks();
    tauri = installTauriMock();
    buildDom();
    vi.resetModules();
    await seedDeCatalog();
    tauri = installTauriMock();
    buildDom();
});

afterEach(() => {
    dispose();
    dispose = () => {};
});

describe('vault/git-status', () => {
    it('sets and clears classes from events; second event is idempotent', async () => {
        await initModule();
        emitStatus('/repo', [
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo', status: 'modified' },
            { path: '/repo/b.md', status: 'untracked' },
        ]);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
        expect(node('/repo/a.md').classList.contains('git-untracked')).toBe(false);
        expect(node('/repo/b.md').classList.contains('git-untracked')).toBe(true);
        expect(node('/repo').classList.contains('git-modified')).toBe(true);

        emitStatus('/repo', [
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo', status: 'modified' },
            { path: '/repo/b.md', status: 'untracked' },
        ]);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
        expect(node('/repo/b.md').classList.contains('git-untracked')).toBe(true);

        emitStatus(
            '/repo',
            [{ path: '/repo/a.md', status: 'untracked' }],
            2,
        );
        expect(node('/repo/a.md').classList.contains('git-untracked')).toBe(true);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(false);
        expect(node('/repo/b.md').classList.contains('git-untracked')).toBe(false);
        expect(node('/repo').classList.contains('git-modified')).toBe(false);
    });

    it('applies last snapshot to lazily inserted nodes', async () => {
        await initModule();
        emitStatus('/repo', [
            { path: '/repo/c.md', status: 'modified' },
            { path: '/repo/neu', status: 'untracked' },
        ]);
        expect(document.querySelector('li.node[data-path="/repo/c.md"]')).toBeNull();

        const children = document.querySelector(
            'li.node[data-path="/repo"] > ul.children',
        )!;
        const file = document.createElement('li');
        file.className = 'node';
        file.setAttribute('data-kind', 'file');
        file.setAttribute('data-path', '/repo/c.md');
        file.innerHTML = '<div class="row"><span class="label">c.md</span></div>';
        children.appendChild(file);

        const dir = document.createElement('li');
        dir.className = 'node';
        dir.setAttribute('data-kind', 'dir');
        dir.setAttribute('data-path', '/repo/neu');
        dir.innerHTML = '<div class="row"><span class="label">neu</span></div>';
        children.appendChild(dir);

        await flushMicro();
        expect(file.classList.contains('git-modified')).toBe(true);
        expect(dir.classList.contains('git-untracked')).toBe(true);
    });

    it('observer settles: no self-sustaining mutation churn', async () => {
        await initModule();
        emitStatus('/repo', [
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo/alpine.md', status: 'untracked' },
        ]);

        const tree = document.getElementById('vault-tree')!;
        let churn = 0;
        const probe = new MutationObserver((records) => {
            churn += records.length;
        });
        probe.observe(tree, { childList: true, subtree: true, attributes: true });

        const children = document.querySelector(
            'li.node[data-path="/repo"] > ul.children',
        )!;
        const li = document.createElement('li');
        li.className = 'node';
        li.setAttribute('data-kind', 'file');
        li.setAttribute('data-path', '/repo/alpine.md');
        li.innerHTML = '<div class="row"><span class="label">alpine.md</span></div>';
        children.appendChild(li);

        for (let i = 0; i < 10; i++) await flushMicro();
        const settled = churn;
        for (let i = 0; i < 10; i++) await flushMicro();
        expect(churn).toBe(settled);
        probe.disconnect();

        expect(li.classList.contains('git-untracked')).toBe(true);
    });

    it('empty event for a repo removes previous dots', async () => {
        await initModule();
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'modified' }]);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
        emitStatus('/repo', [], 2);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(false);
    });

    it('discards older generation snapshots', async () => {
        await initModule();
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'modified' }], 5);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'untracked' }], 4);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
        expect(node('/repo/a.md').classList.contains('git-untracked')).toBe(false);
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'untracked' }], 5);
        expect(node('/repo/a.md').classList.contains('git-untracked')).toBe(true);
    });

    it('empty event for repo 1 does not clear repo 2', async () => {
        await initModule();
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'modified' }], 1);
        emitStatus('/other', [{ path: '/other/x.md', status: 'untracked' }], 1);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
        expect(node('/other/x.md').classList.contains('git-untracked')).toBe(true);
        emitStatus('/repo', [], 2);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(false);
        expect(node('/other/x.md').classList.contains('git-untracked')).toBe(true);
    });

    it('malformed payloads do not throw and leave state stable', async () => {
        await initModule();
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'modified' }], 1);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);

        expect(() => {
            tauri.emitEvent('vault:git_status', null);
            tauri.emitEvent('vault:git_status', {});
            tauri.emitEvent('vault:git_status', {
                repoRoot: '/repo',
                entries: null,
                generation: 2,
            });
            tauri.emitEvent('vault:git_status', {
                entries: [{ path: '/repo/a.md', status: 'modified' }],
                generation: 2,
            });
            tauri.emitEvent('vault:git_status', {
                repoRoot: '/repo',
                entries: [{ path: '/repo/a.md', status: 'conflict' }],
                generation: 2,
            });
        }).not.toThrow();

        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
    });

    it('orphaned roots lose their classes via activeRoots', async () => {
        await initModule();
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'modified' }], 1);
        emitStatus('/other', [{ path: '/other/x.md', status: 'untracked' }], 1);
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
        expect(node('/other/x.md').classList.contains('git-untracked')).toBe(true);

        emitStatus(
            '/repo',
            [{ path: '/repo/a.md', status: 'modified' }],
            2,
            { activeRoots: ['/repo'] },
        );
        expect(node('/repo/a.md').classList.contains('git-modified')).toBe(true);
        expect(node('/other/x.md').classList.contains('git-untracked')).toBe(false);
        expect(node('/other').classList.contains('git-modified')).toBe(false);
    });

    it('appends a translated git-status line to the title; second event is idempotent', async () => {
        await initModule();
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'modified' }]);
        expect(node('/repo/a.md').getAttribute('title')).toBe('/repo/a.md\ngeändert');
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'modified' }]);
        expect(node('/repo/a.md').getAttribute('title')).toBe('/repo/a.md\ngeändert');
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'untracked' }], 2);
        expect(node('/repo/a.md').getAttribute('title')).toBe('/repo/a.md\nunversioniert');
        emitStatus('/repo', [], 3);
        expect(node('/repo/a.md').getAttribute('title')).toBe('/repo/a.md');
    });

    it('treats files under an untracked dir as changed; segment boundary holds', async () => {
        const children = document.querySelector(
            'li.node[data-path="/repo"] > ul.children',
        )!;
        const neu = document.createElement('li');
        neu.className = 'node';
        neu.setAttribute('data-kind', 'dir');
        neu.setAttribute('data-path', '/repo/neu');
        neu.innerHTML = '<div class="row"><span class="label">neu</span></div>'
            + '<ul class="children">'
            + '<li class="node" data-kind="file" data-path="/repo/neu/a.md">'
            + '<div class="row"><span class="label">a.md</span></div></li></ul>';
        children.appendChild(neu);
        const neues = document.createElement('li');
        neues.className = 'node';
        neues.setAttribute('data-kind', 'file');
        neues.setAttribute('data-path', '/repo/neues.md');
        neues.innerHTML = '<div class="row"><span class="label">neues.md</span></div>';
        children.appendChild(neues);

        const git = await initModule();
        emitStatus('/repo', [{ path: '/repo/neu', status: 'untracked' }]);
        expect(git.isPathGitChanged('/repo/neu')).toBe(true);
        expect(git.isPathGitChanged('/repo/neu/a.md')).toBe(true);
        expect(git.isPathGitChanged('/repo/neues.md')).toBe(false);
        expect(git.pathIsUnder('/repo/neu/a.md', '/repo/neu')).toBe(true);
        expect(git.pathIsUnder('/repo/neues.md', '/repo/neu')).toBe(false);
    });

    it('keeps backend extras such as gitignored and clears only the git line', async () => {
        node('/repo/a.md').setAttribute('title', '/repo/a.md\ngitignored');
        await initModule();
        emitStatus('/repo', [{ path: '/repo/a.md', status: 'modified' }]);
        expect(node('/repo/a.md').getAttribute('title')).toBe(
            '/repo/a.md\ngitignored\ngeändert',
        );
        emitStatus('/repo', [], 2);
        expect(node('/repo/a.md').getAttribute('title')).toBe('/repo/a.md\ngitignored');
    });
});
