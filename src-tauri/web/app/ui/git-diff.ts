/* Read-only Git-Diff: HEAD links, aktueller Stand rechts.
   Teilt FolioDiffView + #ai-diff-region mit der KI-Review. */

import {
    findTabIdByPath,
    getActiveTabId,
    isVirtualTabActive,
    registerVirtualTab,
    unregisterVirtualTab,
} from '../state/tabs';
import { isAiReviewOpen } from './ai-diff-review';
import { folioLog } from '../util/log';
import { t } from '../i18n/translate';

let gitDiffOpen = false;
let gitDiffGeneration = 0;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function fileName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return window.__TAURI__.core.invoke(cmd, args);
}

/** Rechte Seite: offener Tab-Puffer (auch dirty), sonst Disk. */
export function resolveGitDiffModified(path: string, diskText: string): string {
    const tabId = findTabIdByPath(path);
    if (tabId == null) return diskText;
    const editor = window.FolioEditor;
    if (editor && typeof editor.getTextForTab === 'function') {
        const fromTab = editor.getTextForTab(tabId);
        // null = pending/ungeladenes Model → Disk, niemals ein fremder Puffer.
        if (typeof fromTab === 'string') return fromTab;
    }
    if (
        editor
        && typeof editor.getText === 'function'
        && getActiveTabId() === tabId
    ) {
        return editor.getText();
    }
    return diskText;
}

export function isGitDiffOpen(): boolean {
    return gitDiffOpen;
}

export function closeGitDiff(): void {
    if (!gitDiffOpen) return;
    gitDiffGeneration += 1;
    gitDiffOpen = false;
    const diffView = window.FolioDiffView;
    if (diffView) {
        diffView.onModifiedChange(null);
        diffView.clear();
    }
    const region = $('ai-diff-region');
    if (region && !isAiReviewOpen()) {
        region.hidden = true;
    }
    unregisterVirtualTab('git-diff');
}

export async function openGitDiff(
    path: string,
    showStatus: (msg: string) => void,
): Promise<void> {
    if (isAiReviewOpen()) {
        showStatus(t('errors.ai.reviewOpen'));
        return;
    }
    const region = $('ai-diff-region');
    const diffView = window.FolioDiffView;
    if (!region || !diffView) {
        folioLog.warn('git-diff', 'Diff-Surface nicht verfügbar');
        showStatus(t('errors.git.showFailed'));
        return;
    }

    let payload: { text: string; diskText: string; language: string };
    try {
        payload = await invoke('git_show_head', { path });
    } catch (err) {
        const msg = typeof err === 'string' ? err : t('errors.git.showFailed');
        showStatus(msg);
        return;
    }

    if (isAiReviewOpen()) {
        showStatus(t('errors.ai.reviewOpen'));
        return;
    }

    const modified = resolveGitDiffModified(path, payload.diskText);
    const generation = ++gitDiffGeneration;
    gitDiffOpen = true;
    region.hidden = false;
    const title = $('ai-diff-title');
    if (title) title.textContent = t('git.diff.title', { name: fileName(path) });
    const hint = $('ai-diff-hint');
    if (hint) hint.textContent = path.replace(/\\/g, '/');

    registerVirtualTab({
        slug: 'git-diff',
        label: () => t('git.diff.tabLabel'),
        dirty: () => false,
        onActivate: () => {
            const diff = window.FolioDiffView;
            if (diff) {
                diff.layout();
                diff.focus();
            }
        },
        onClose: () => {
            closeGitDiff();
        },
    });

    await diffView.mount('ai-diff-mount');
    if (generation !== gitDiffGeneration || !gitDiffOpen) {
        // Nicht clearen, wenn die KI-Review die Surface inzwischen
        // übernommen hat — sonst leert ein verspäteter Mount die Review.
        if (!isAiReviewOpen()) {
            diffView.clear();
        }
        return;
    }
    diffView.onModifiedChange(null);
    diffView.setContents(payload.text, modified, payload.language || 'plaintext', {
        readOnly: true,
    });
    diffView.focus();
}

export function initGitDiff(): void {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !isVirtualTabActive('git-diff')) return;
        const confirmDialog = $('confirm-dialog');
        if (confirmDialog && !confirmDialog.hidden) return;
        event.preventDefault();
        closeGitDiff();
    });
}
