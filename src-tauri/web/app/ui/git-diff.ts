/* Read-only Git-Diff: HEAD links, aktueller Stand rechts.
   Teilt FolioDiffView + #ai-diff-region mit der KI-Review. */

import {
    findTabIdByPath,
    getActiveTabId,
    isVirtualTabActive,
    registerVirtualTab,
    unregisterVirtualTab,
} from '../state/tabs';
import { getCurrentPath, showStatus } from '../state/document';
import { GIT_STATUS_CHANGED_EVENT, isPathGitModified } from '../vault/git-status';
import { isAiReviewOpen } from './ai-diff-review';
import { folioLog, safeInvoke } from '../util/log';
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

/** Toolbar/Menue: enabled genau dann, wenn das aktive Dokument git-modified ist. */
let gitDiffEnabledGen = 0;
let gitDiffEnabledChain: Promise<void> = Promise.resolve();

export function syncGitDiffActionEnabled(): void {
    const path = getCurrentPath();
    const enabled = !!path && isPathGitModified(path);
    const btn = document.getElementById('tb-git-diff') as HTMLButtonElement | null;
    if (btn) {
        btn.disabled = !enabled;
        // Kein .active — das ist eine Aktion, kein Mode-Toggle.
        btn.classList.remove('active');
    }
    // Generation + Kette: bei Tab-Wechsel + Statusevent darf ein
    // verspaetetes menu_set_enabled den juengeren Zustand nicht
    // ueberschreiben.
    const gen = ++gitDiffEnabledGen;
    gitDiffEnabledChain = gitDiffEnabledChain
        .then(() => {
            if (gen !== gitDiffEnabledGen) return;
            return safeInvoke(
                'menu_set_enabled',
                { id: 'view.git_diff', enabled },
                'menu_set_enabled view.git_diff',
                'debug',
            ).then(() => undefined);
        })
        .catch(() => undefined);
}

/** Gemeinsamer Einstieg fuer Toolbar, Menue, Palette und Tab-Klick. */
export function openGitDiffForActiveDoc(): void {
    const path = getCurrentPath();
    if (!path || !isPathGitModified(path)) return;
    void openGitDiff(path, showStatus);
}

export function initGitDiff(): void {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !isVirtualTabActive('git-diff')) return;
        const confirmDialog = $('confirm-dialog');
        if (confirmDialog && !confirmDialog.hidden) return;
        event.preventDefault();
        closeGitDiff();
    });
    window.addEventListener('folio-open-git-diff', (event: Event) => {
        const detail = (event as CustomEvent<{ path?: string }>).detail;
        const path = detail && typeof detail.path === 'string' ? detail.path : '';
        if (!path) return;
        void openGitDiff(path, showStatus);
    });
    window.addEventListener(GIT_STATUS_CHANGED_EVENT, () => {
        syncGitDiffActionEnabled();
    });
    window.addEventListener('folio-doc-kind-changed', () => {
        syncGitDiffActionEnabled();
    });
    syncGitDiffActionEnabled();
}
