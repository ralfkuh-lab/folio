/* Read-only Git-Diff: HEAD links, aktueller Stand rechts.
   Teilt FolioDiffView + #ai-diff-region mit der KI-Review. */

import {
    findTabIdByPath,
    getActiveTabId,
    isVirtualTabActive,
    registerVirtualTab,
    unregisterVirtualTab,
    VIRTUAL_TAB_CHANGED_EVENT,
} from '../state/tabs';
import { getCurrentPath, showStatus } from '../state/document';
import { GIT_STATUS_CHANGED_EVENT, isPathGitModified } from '../vault/git-status';
import { isAiReviewOpen } from './ai-diff-review';
import { folioLog, safeInvoke } from '../util/log';
import { t } from '../i18n/translate';

let gitDiffOpen = false;
let gitDiffGeneration = 0;
/** Pfad, den der letzte (auch noch laufende) Open anfordert. */
let gitDiffPath: string | null = null;

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
    // Generation und Pfad immer invalidieren — auch wenn der Diff
    // noch nicht offen ist. Sonst kehrt ein laufendes Erst-Öffnen
    // nach einem virtuellen Tab-Wechsel zurück und legt sich über
    // die inzwischen gewählte Ansicht.
    gitDiffGeneration += 1;
    gitDiffPath = null;
    if (!gitDiffOpen) return;
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

/** Titel/Hinweis auf den neuen Pfad, Models leer — kein sichtbarer
 *  Alt-Inhalt, während git_show_head noch unterwegs ist. */
function showPendingGitDiff(path: string): void {
    const title = $('ai-diff-title');
    if (title) title.textContent = t('git.diff.title', { name: fileName(path) });
    const hint = $('ai-diff-hint');
    if (hint) hint.textContent = path.replace(/\\/g, '/');
    if (isAiReviewOpen()) return;
    const diffView = window.FolioDiffView;
    if (diffView) {
        diffView.onModifiedChange(null);
        diffView.clear();
    }
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

    // Generation VOR dem Await: schnelles A→B→C darf nur C anzeigen.
    const generation = ++gitDiffGeneration;
    gitDiffPath = path.replace(/\\/g, '/');
    showPendingGitDiff(path);

    let payload: { text: string; diskText: string; language: string };
    try {
        payload = await invoke('git_show_head', { path });
    } catch (err) {
        if (generation !== gitDiffGeneration) return;
        const msg = typeof err === 'string' ? err : t('errors.git.showFailed');
        showStatus(msg);
        gitDiffPath = null;
        if (gitDiffOpen) closeGitDiff();
        return;
    }

    if (generation !== gitDiffGeneration) return;
    if (isAiReviewOpen()) {
        showStatus(t('errors.ai.reviewOpen'));
        return;
    }

    const modified = resolveGitDiffModified(path, payload.diskText);
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
        // Nicht clearen, wenn ein neuerer Open noch laeuft oder die
        // KI-Review die Surface inzwischen uebernommen hat.
        if (!gitDiffOpen && !isAiReviewOpen()) {
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

function isTextDocKind(kind: string): boolean {
    return kind === 'markdown' || kind === 'text';
}

function kindFromEventOrBody(event: Event): string {
    const detail = (event as CustomEvent<{ kind?: string }>).detail;
    if (detail && typeof detail.kind === 'string' && detail.kind) {
        return detail.kind;
    }
    const cl = document.body.classList;
    if (cl.contains('kind-markdown')) return 'markdown';
    if (cl.contains('kind-text')) return 'text';
    if (cl.contains('kind-image')) return 'image';
    if (cl.contains('kind-binary')) return 'binary';
    return 'unknown';
}

/** Nur wenn der Diff-Tab aktiv ist: neue geaenderte Textdatei nachziehen,
 *  sonst schliessen. Im Zweifel schliessen — ein stehengebliebener Diff
 *  der alten Datei ist der Fehler. */
function followOrCloseGitDiff(event: Event): void {
    if (!isVirtualTabActive('git-diff')) return;
    const detail = (event as CustomEvent<{ kind?: string; path?: string | null }>).detail;
    const current = getCurrentPath();
    // Event-Pfad und aktueller Stand muessen zusammenpassen. openDocument
    // feuert kind+Pfad der neuen Datei, bevor currentPath steht — ohne
    // diesen Guard fiele das Kind von B auf den Pfad von C.
    if (detail && Object.prototype.hasOwnProperty.call(detail, 'path')) {
        const eventPath = typeof detail.path === 'string' ? detail.path.replace(/\\/g, '/') : '';
        const currentNorm = current ? current.replace(/\\/g, '/') : '';
        if (eventPath !== currentNorm) return;
    }
    const path = current;
    const kind = kindFromEventOrBody(event);
    if (!path || !isTextDocKind(kind) || !isPathGitModified(path)) {
        closeGitDiff();
        return;
    }
    if (gitDiffPath === path.replace(/\\/g, '/')) return;
    void openGitDiff(path, showStatus);
}

function onVirtualTabChanged(event: Event): void {
    const detail = (event as CustomEvent<{ slug?: string | null }>).detail;
    const slug = detail && typeof detail.slug === 'string' ? detail.slug : '';
    if (slug && slug !== 'git-diff') closeGitDiff();
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
    window.addEventListener('folio-doc-kind-changed', (event: Event) => {
        syncGitDiffActionEnabled();
        followOrCloseGitDiff(event);
    });
    window.addEventListener(VIRTUAL_TAB_CHANGED_EVENT, onVirtualTabChanged);
    syncGitDiffActionEnabled();
}
