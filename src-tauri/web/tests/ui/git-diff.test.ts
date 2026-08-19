import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const findTabIdByPath = vi.fn((): number | null => null);
const getActiveTabId = vi.fn((): number | null => 1);
const isVirtualTabActive = vi.fn(() => false);
const registerVirtualTab = vi.fn();
const unregisterVirtualTab = vi.fn();
const isAiReviewOpen = vi.fn(() => false);

vi.mock('../../app/state/tabs', () => ({
    findTabIdByPath: (...args: unknown[]) => findTabIdByPath(...args),
    getActiveTabId: (...args: unknown[]) => getActiveTabId(...args),
    isVirtualTabActive: (...args: unknown[]) => isVirtualTabActive(...args),
    registerVirtualTab: (...args: unknown[]) => registerVirtualTab(...args),
    unregisterVirtualTab: (...args: unknown[]) => unregisterVirtualTab(...args),
    VIRTUAL_TAB_CHANGED_EVENT: 'folio-virtual-tab-changed',
}));

vi.mock('../../app/ui/ai-diff-review', () => ({
    isAiReviewOpen: () => isAiReviewOpen(),
}));

const getCurrentPath = vi.fn((): string | null => '/repo/a.md');
const importedShowStatus = vi.fn();
vi.mock('../../app/state/document', () => ({
    getCurrentPath: () => getCurrentPath(),
    showStatus: (...args: unknown[]) => importedShowStatus(...args),
}));

function buildDom(): void {
    document.body.innerHTML = `
        <button id="tb-git-diff" disabled></button>
        <div id="ai-diff-region" hidden>
            <span id="ai-diff-title"></span>
            <span id="ai-diff-hint"></span>
            <button id="ai-diff-discard"></button>
            <button id="ai-diff-apply"></button>
            <div id="ai-diff-mount"></div>
        </div>
    `;
}

function installDiffViewMock() {
    const mock = {
        mount: vi.fn(() => Promise.resolve()),
        setContents: vi.fn(),
        onModifiedChange: vi.fn(),
        getModified: vi.fn(() => ''),
        setTheme: vi.fn(),
        layout: vi.fn(),
        focus: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
        isMounted: vi.fn(() => true),
    };
    (window as any).FolioDiffView = mock;
    return mock;
}

describe('git-diff', () => {
    let tauri: TauriMockHandles;
    let showStatus: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        findTabIdByPath.mockReturnValue(null);
        getActiveTabId.mockReturnValue(1);
        isVirtualTabActive.mockReturnValue(false);
        isAiReviewOpen.mockReturnValue(false);
        getCurrentPath.mockReturnValue('/repo/a.md');
        importedShowStatus.mockReset();
        registerVirtualTab.mockReset();
        unregisterVirtualTab.mockReset();
        tauri = installTauriMock();
        await seedDeCatalog();
        buildDom();
        showStatus = vi.fn();
        document.body.className = '';
        (window as any).FolioEditor = {
            getText: vi.fn(() => 'editor-active'),
            getTextForTab: vi.fn(() => 'editor-tab'),
        };
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'git_show_head') {
                return Promise.resolve({
                    text: 'HEAD text',
                    diskText: 'disk text',
                    language: 'markdown',
                });
            }
            return Promise.resolve(undefined);
        });
    });

    it('uses the open-tab buffer when a tab exists', async () => {
        const { resolveGitDiffModified } = await import('../../app/ui/git-diff');
        findTabIdByPath.mockReturnValue(4);
        (window as any).FolioEditor.getTextForTab = vi.fn((id: number) =>
            id === 4 ? 'dirty buffer' : null,
        );
        expect(resolveGitDiffModified('/repo/a.md', 'disk text')).toBe('dirty buffer');
    });

    it('falls back to disk when no tab is open', async () => {
        const { resolveGitDiffModified } = await import('../../app/ui/git-diff');
        findTabIdByPath.mockReturnValue(null);
        expect(resolveGitDiffModified('/repo/a.md', 'disk text')).toBe('disk text');
    });

    it('uses disk for a pending tab instead of the active editor buffer', async () => {
        const { resolveGitDiffModified } = await import('../../app/ui/git-diff');
        findTabIdByPath.mockReturnValue(4);
        getActiveTabId.mockReturnValue(1);
        (window as any).FolioEditor.getTextForTab = vi.fn(() => null);
        (window as any).FolioEditor.getText = vi.fn(() => 'foreign active tab');
        expect(resolveGitDiffModified('/repo/b.md', 'disk text')).toBe('disk text');
    });

    it('externally changed, not-yet-loaded document uses disk (no special case)', async () => {
        // Tab existiert, Model fehlt (pending / nicht neu geladen) → Disk.
        // Kein eigener external_changed-Zweig: getTextForTab === null.
        const { resolveGitDiffModified } = await import('../../app/ui/git-diff');
        findTabIdByPath.mockReturnValue(9);
        getActiveTabId.mockReturnValue(1);
        (window as any).FolioEditor.getTextForTab = vi.fn(() => null);
        expect(resolveGitDiffModified('/repo/ext.md', 'disk after agent')).toBe(
            'disk after agent',
        );
    });

    it('uses getText only when the found tab is active', async () => {
        const { resolveGitDiffModified } = await import('../../app/ui/git-diff');
        findTabIdByPath.mockReturnValue(1);
        getActiveTabId.mockReturnValue(1);
        delete (window as any).FolioEditor.getTextForTab;
        (window as any).FolioEditor.getText = vi.fn(() => 'active buffer');
        expect(resolveGitDiffModified('/repo/a.md', 'disk text')).toBe('active buffer');
    });

    it('rejects opening when an AI review is open', async () => {
        const diff = installDiffViewMock();
        isAiReviewOpen.mockReturnValue(true);
        const { openGitDiff } = await import('../../app/ui/git-diff');
        await openGitDiff('/repo/a.md', showStatus);
        expect(showStatus).toHaveBeenCalled();
        expect(String(showStatus.mock.calls[0][0])).toMatch(/KI-Review/);
        expect(diff.setContents).not.toHaveBeenCalled();
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'git_show_head',
            expect.anything(),
        );
    });

    it('does not clear the surface if an AI review took over during mount', async () => {
        let finishMount: () => void = () => {};
        const diff = installDiffViewMock();
        diff.mount.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finishMount = resolve;
                }),
        );
        const { openGitDiff, closeGitDiff } = await import('../../app/ui/git-diff');
        const pending = openGitDiff('/repo/a.md', showStatus);
        await Promise.resolve();
        await Promise.resolve();
        expect(diff.mount).toHaveBeenCalled();
        isAiReviewOpen.mockReturnValue(true);
        closeGitDiff();
        diff.clear.mockClear();
        finishMount();
        await pending;
        expect(diff.clear).not.toHaveBeenCalled();
        expect(diff.setContents).not.toHaveBeenCalled();
    });

    it('opens read-only when no review is active', async () => {
        const diff = installDiffViewMock();
        const { openGitDiff } = await import('../../app/ui/git-diff');
        await openGitDiff('/repo/a.md', showStatus);
        expect(diff.mount).toHaveBeenCalledWith('ai-diff-mount');
        expect(diff.onModifiedChange).toHaveBeenCalledWith(null);
        expect(diff.setContents).toHaveBeenCalledWith(
            'HEAD text',
            'disk text',
            'markdown',
            { readOnly: true },
        );
        expect(showStatus).not.toHaveBeenCalled();
    });

    it('enables the toolbar/menu action only when the active path is git-modified', async () => {
        const git = await import('../../app/vault/git-status');
        const { initGitDiff, syncGitDiffActionEnabled } = await import(
            '../../app/ui/git-diff'
        );
        initGitDiff();
        const btn = document.getElementById('tb-git-diff') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);

        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
        ]);
        expect(btn.disabled).toBe(false);
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('menu_set_enabled', {
                id: 'view.git_diff',
                enabled: true,
            });
        });

        getCurrentPath.mockReturnValue('/repo/other.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown' },
        }));
        expect(btn.disabled).toBe(true);

        getCurrentPath.mockReturnValue('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'untracked' },
        ]);
        syncGitDiffActionEnabled();
        expect(btn.disabled).toBe(true);
    });

    it('does not enable git-diff for a modified binary document', async () => {
        const git = await import('../../app/vault/git-status');
        const { initGitDiff, openGitDiffForActiveDoc } = await import(
            '../../app/ui/git-diff'
        );
        initGitDiff();
        const btn = document.getElementById('tb-git-diff') as HTMLButtonElement;
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.bin', status: 'modified' },
        ]);
        getCurrentPath.mockReturnValue('/repo/a.bin');
        document.body.classList.add('kind-binary');
        const { syncGitDiffActionEnabled } = await import('../../app/ui/git-diff');
        syncGitDiffActionEnabled();
        expect(btn.disabled).toBe(true);
        openGitDiffForActiveDoc();
        expect(tauri.invoke.mock.calls.some((c) => c[0] === 'git_show_head')).toBe(false);
        document.body.classList.remove('kind-binary');
    });

    it('does not start a git-diff for an inactive binary path', async () => {
        const { initGitDiff, openGitDiff } = await import('../../app/ui/git-diff');
        initGitDiff();
        getCurrentPath.mockReturnValue('/repo/a.md');
        document.body.className = 'kind-markdown';
        tauri.invoke.mockClear();
        await openGitDiff('/repo/blob.bin', showStatus);
        expect(tauri.invoke.mock.calls.some((c) => c[0] === 'git_show_head')).toBe(false);
        window.dispatchEvent(new CustomEvent('folio-open-git-diff', {
            detail: { path: '/repo/blob.bin' },
        }));
        expect(tauri.invoke.mock.calls.some((c) => c[0] === 'git_show_head')).toBe(false);
    });

    async function openActiveDiff(path = '/repo/a.md'): Promise<{
        diff: ReturnType<typeof installDiffViewMock>;
        git: typeof import('../../app/vault/git-status');
        openGitDiff: typeof import('../../app/ui/git-diff').openGitDiff;
    }> {
        const diff = installDiffViewMock();
        isVirtualTabActive.mockImplementation((slug: string) => slug === 'git-diff');
        const git = await import('../../app/vault/git-status');
        const { openGitDiff, initGitDiff } = await import('../../app/ui/git-diff');
        initGitDiff();
        await openGitDiff(path, showStatus);
        return { diff, git, openGitDiff };
    }

    it('follows the newly opened modified file while the diff tab stays active', async () => {
        const { diff, git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo/b.md', status: 'modified' },
        ]);
        tauri.invoke.mockClear();
        diff.setContents.mockClear();
        registerVirtualTab.mockClear();
        unregisterVirtualTab.mockClear();
        getCurrentPath.mockReturnValue('/repo/b.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown', path: '/repo/b.md' },
        }));
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('git_show_head', { path: '/repo/b.md' });
        });
        await vi.waitFor(() => {
            expect(diff.setContents).toHaveBeenCalledWith(
                'HEAD text',
                'disk text',
                'markdown',
                { readOnly: true },
            );
        });
        expect(unregisterVirtualTab).not.toHaveBeenCalled();
        expect(registerVirtualTab).toHaveBeenCalled();
        expect(isVirtualTabActive('git-diff')).toBe(true);
    });

    it('closes the diff when the new file has no git change', async () => {
        const { git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
        ]);
        unregisterVirtualTab.mockClear();
        getCurrentPath.mockReturnValue('/repo/clean.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown' },
        }));
        expect(unregisterVirtualTab).toHaveBeenCalledWith('git-diff');
        expect(document.getElementById('ai-diff-region')!.hidden).toBe(true);
    });

    it('closes the diff when status is unknown or there is no repo', async () => {
        const { git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([]);
        unregisterVirtualTab.mockClear();
        getCurrentPath.mockReturnValue('/repo/mystery.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown' },
        }));
        expect(unregisterVirtualTab).toHaveBeenCalledWith('git-diff');
    });

    it('closes the diff when the new file is not text', async () => {
        const { git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo/pic.png', status: 'modified' },
        ]);
        unregisterVirtualTab.mockClear();
        getCurrentPath.mockReturnValue('/repo/pic.png');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'image' },
        }));
        expect(unregisterVirtualTab).toHaveBeenCalledWith('git-diff');
    });

    it('leaves the diff unchanged when it is not the active tab', async () => {
        const { diff, git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo/b.md', status: 'modified' },
        ]);
        isVirtualTabActive.mockReturnValue(false);
        tauri.invoke.mockClear();
        diff.setContents.mockClear();
        unregisterVirtualTab.mockClear();
        getCurrentPath.mockReturnValue('/repo/b.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown' },
        }));
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'git_show_head',
            expect.anything(),
        );
        expect(diff.setContents).not.toHaveBeenCalled();
        expect(unregisterVirtualTab).not.toHaveBeenCalled();
        expect(document.getElementById('ai-diff-region')!.hidden).toBe(false);
    });

    it('closes the diff when switching to another virtual tab', async () => {
        await openActiveDiff('/repo/a.md');
        unregisterVirtualTab.mockClear();
        window.dispatchEvent(new CustomEvent('folio-virtual-tab-changed', {
            detail: { slug: 'settings' },
        }));
        expect(unregisterVirtualTab).toHaveBeenCalledWith('git-diff');
        expect(document.getElementById('ai-diff-region')!.hidden).toBe(true);
    });

    it('shows only C when A → B → C race; late A/B replies are discarded', async () => {
        const { diff, git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo/b.md', status: 'modified' },
            { path: '/repo/c.md', status: 'modified' },
        ]);

        const pending = new Map<string, (value: unknown) => void>();
        tauri.invoke.mockImplementation((cmd: string, args?: { path?: string }) => {
            if (cmd === 'git_show_head' && args && typeof args.path === 'string') {
                return new Promise((resolve) => {
                    pending.set(args.path, resolve);
                });
            }
            return Promise.resolve(undefined);
        });

        diff.setContents.mockClear();
        getCurrentPath.mockReturnValue('/repo/b.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown' },
        }));
        getCurrentPath.mockReturnValue('/repo/c.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown' },
        }));

        await vi.waitFor(() => {
            expect(pending.has('/repo/b.md')).toBe(true);
            expect(pending.has('/repo/c.md')).toBe(true);
        });

        pending.get('/repo/c.md')!({
            text: 'HEAD C',
            diskText: 'disk C',
            language: 'markdown',
        });
        await vi.waitFor(() => {
            expect(diff.setContents).toHaveBeenCalledWith(
                'HEAD C',
                'disk C',
                'markdown',
                { readOnly: true },
            );
        });
        expect(diff.setContents).toHaveBeenCalledTimes(1);

        pending.get('/repo/b.md')!({
            text: 'HEAD B',
            diskText: 'disk B',
            language: 'markdown',
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(diff.setContents).toHaveBeenCalledTimes(1);
        expect(diff.setContents.mock.calls[0][0]).toBe('HEAD C');
    });

    it('clears the old diff and retitles before git_show_head returns', async () => {
        const { diff, git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo/b.md', status: 'modified' },
        ]);
        let resolveShow: (value: unknown) => void = () => {};
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'git_show_head') {
                return new Promise((resolve) => {
                    resolveShow = resolve;
                });
            }
            return Promise.resolve(undefined);
        });
        diff.setContents.mockClear();
        diff.clear.mockClear();
        getCurrentPath.mockReturnValue('/repo/b.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown', path: '/repo/b.md' },
        }));
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('git_show_head', { path: '/repo/b.md' });
        });
        expect(document.getElementById('ai-diff-title')!.textContent).toMatch(/b\.md/);
        expect(document.getElementById('ai-diff-hint')!.textContent).toBe('/repo/b.md');
        expect(diff.clear).toHaveBeenCalled();
        expect(diff.setContents).not.toHaveBeenCalled();

        resolveShow({
            text: 'HEAD B',
            diskText: 'disk B',
            language: 'markdown',
        });
        await vi.waitFor(() => {
            expect(diff.setContents).toHaveBeenCalledWith(
                'HEAD B',
                'disk B',
                'markdown',
                { readOnly: true },
            );
        });
    });

    it('discards a first-open in flight when switching to a virtual tab', async () => {
        const diff = installDiffViewMock();
        const { openGitDiff, initGitDiff } = await import('../../app/ui/git-diff');
        initGitDiff();
        let resolveShow: (value: unknown) => void = () => {};
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'git_show_head') {
                return new Promise((resolve) => {
                    resolveShow = resolve;
                });
            }
            return Promise.resolve(undefined);
        });
        const pending = openGitDiff('/repo/a.md', showStatus);
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('git_show_head', { path: '/repo/a.md' });
        });
        window.dispatchEvent(new CustomEvent('folio-virtual-tab-changed', {
            detail: { slug: 'settings' },
        }));
        resolveShow({
            text: 'HEAD A',
            diskText: 'disk A',
            language: 'markdown',
        });
        await pending;
        expect(diff.setContents).not.toHaveBeenCalled();
        expect(registerVirtualTab).not.toHaveBeenCalled();
        expect(document.getElementById('ai-diff-region')!.hidden).toBe(true);
    });

    it('does not overwrite an edited AI review when a git-diff fetch returns late', async () => {
        const diff = installDiffViewMock();
        const { openGitDiff, closeGitDiff } = await import('../../app/ui/git-diff');
        let resolveShow: (value: unknown) => void = () => {};
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'git_show_head') {
                return new Promise((resolve) => {
                    resolveShow = resolve;
                });
            }
            return Promise.resolve(undefined);
        });
        const pending = openGitDiff('/repo/a.md', showStatus);
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('git_show_head', { path: '/repo/a.md' });
        });
        // Wie openAiDiffReview: erst Git-Diff invalidieren, dann Review-Inhalt.
        isAiReviewOpen.mockReturnValue(true);
        closeGitDiff();
        diff.setContents('original', 'edited review', 'markdown');
        diff.setContents.mockClear();
        diff.clear.mockClear();
        resolveShow({
            text: 'HEAD A',
            diskText: 'disk A',
            language: 'markdown',
        });
        await pending;
        expect(diff.setContents).not.toHaveBeenCalled();
        expect(diff.clear).not.toHaveBeenCalled();
    });

    it('does not overwrite an edited AI review when a follow fetch returns late', async () => {
        const { diff, git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo/b.md', status: 'modified' },
        ]);
        const { closeGitDiff } = await import('../../app/ui/git-diff');
        let resolveShow: (value: unknown) => void = () => {};
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'git_show_head') {
                return new Promise((resolve) => {
                    resolveShow = resolve;
                });
            }
            return Promise.resolve(undefined);
        });
        getCurrentPath.mockReturnValue('/repo/b.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'markdown', path: '/repo/b.md' },
        }));
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('git_show_head', { path: '/repo/b.md' });
        });
        isAiReviewOpen.mockReturnValue(true);
        closeGitDiff();
        diff.setContents('original', 'edited review', 'markdown');
        diff.setContents.mockClear();
        diff.clear.mockClear();
        resolveShow({
            text: 'HEAD B',
            diskText: 'disk B',
            language: 'markdown',
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(diff.setContents).not.toHaveBeenCalled();
        expect(diff.clear).not.toHaveBeenCalled();
    });

    it('does not clear an edited AI review when git-diff tries to take the surface', async () => {
        const diff = installDiffViewMock();
        isAiReviewOpen.mockReturnValue(true);
        diff.setContents('original', 'edited review', 'markdown');
        diff.setContents.mockClear();
        diff.clear.mockClear();
        const { openGitDiff } = await import('../../app/ui/git-diff');
        await openGitDiff('/repo/a.md', showStatus);
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'git_show_head',
            expect.anything(),
        );
        expect(diff.clear).not.toHaveBeenCalled();
        expect(diff.setContents).not.toHaveBeenCalled();
    });

    it('ignores a kind-changed event whose path does not match the current document', async () => {
        const { diff, git } = await openActiveDiff('/repo/a.md');
        git.__setGitStatusSnapshotForTests([
            { path: '/repo/a.md', status: 'modified' },
            { path: '/repo/c.md', status: 'modified' },
        ]);
        tauri.invoke.mockClear();
        diff.setContents.mockClear();
        unregisterVirtualTab.mockClear();
        getCurrentPath.mockReturnValue('/repo/c.md');
        window.dispatchEvent(new CustomEvent('folio-doc-kind-changed', {
            detail: { kind: 'image', path: '/repo/b.png' },
        }));
        expect(unregisterVirtualTab).not.toHaveBeenCalled();
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'git_show_head',
            expect.anything(),
        );
        expect(diff.setContents).not.toHaveBeenCalled();
        expect(document.getElementById('ai-diff-region')!.hidden).toBe(false);
    });
});
