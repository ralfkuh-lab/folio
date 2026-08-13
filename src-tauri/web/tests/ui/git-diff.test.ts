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
}));

vi.mock('../../app/ui/ai-diff-review', () => ({
    isAiReviewOpen: () => isAiReviewOpen(),
}));

function buildDom(): void {
    document.body.innerHTML = `
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
        isAiReviewOpen.mockReturnValue(false);
        registerVirtualTab.mockReset();
        unregisterVirtualTab.mockReset();
        tauri = installTauriMock();
        await seedDeCatalog();
        buildDom();
        showStatus = vi.fn();
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
});
