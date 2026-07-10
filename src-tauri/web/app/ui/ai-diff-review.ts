// KI-Review (Spec docs/spec-ki-actions.md, Etappe A3): Diff-Ansicht für
// das Replace-Ziel der KI-Aktionen. Läuft als virtueller Tab 'ai-diff'
// (Muster theme-editor) über der Monaco-DiffEditor-Surface
// `window.FolioDiffView`. Übernehmen läuft durch einen dreistufigen
// Guard (Quelltab existiert → aktiv → Snapshot unverändert) und landet
// als EIN Undo-Schritt via FolioEditor.applyReplace.

import {
    getActiveTabId,
    hasDocumentTab,
    isVirtualTabActive,
    refreshVirtualTabs,
    registerVirtualTab,
    unregisterVirtualTab,
} from '../state/tabs';
import { getEditorText } from '../state/document';
import { showConfirmDialog } from './dialogs';
import { folioLog, safeInvoke } from '../util/log';

export type AiReviewContext = {
    runId: number;
    sourceTabId: number;
    sourcePath: string;
    originalFull: string;
    selection: { start: number; length: number } | null;
    resultText: string;
    actionName: string;
};

type ReviewState = AiReviewContext & { edited: boolean };

let review: ReviewState | null = null;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

/**
 * Bettet das Selektions-Ergebnis in den Volltext-Snapshot ein
 * (UTF-16-Offsets, wie JS-String-slice sie interpretiert). Ohne
 * Selektion ist das Ergebnis der neue Volltext.
 */
export function embedSelectionResult(
    original: string,
    selection: { start: number; length: number } | null,
    result: string,
): string {
    if (!selection) return result;
    const before = original.slice(0, selection.start);
    const after = original.slice(selection.start + selection.length);
    return before + result + after;
}

/**
 * Deterministische Cursor-Policy: UTF-16-Index des ersten
 * abweichenden Code-Units zwischen altem und neuem Text (identische
 * Texte → 0). Deckt auch Diff-Edits vor der ursprünglichen Selektion ab.
 */
export function firstDiffOffset(before: string, after: string): number {
    const max = Math.min(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
        if (before.charCodeAt(index) !== after.charCodeAt(index)) return index;
    }
    return before.length === after.length ? 0 : max;
}

export function isAiReviewOpen(): boolean {
    return review !== null;
}

function setHint(text: string): void {
    const hint = $('ai-diff-hint');
    if (hint) hint.textContent = text;
}

function fileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
}

function reportReviewState(open: boolean, dirty: boolean): void {
    safeInvoke('ai_review_state_set', { open, dirty }, 'ai_review_state_set', 'debug');
}

function onModifiedEdit(): void {
    if (!review || review.edited) return;
    review.edited = true;
    refreshVirtualTabs();
    reportReviewState(true, true);
}

export async function openAiDiffReview(context: AiReviewContext): Promise<void> {
    const region = $('ai-diff-region');
    const diffView = window.FolioDiffView;
    if (!region || !diffView) {
        folioLog.warn('ai-review', 'Diff-Review-Surface nicht verfügbar');
        return;
    }
    review = { ...context, edited: false };
    region.hidden = false;
    const title = $('ai-diff-title');
    if (title) title.textContent = `✨ KI-Review — ${context.actionName}`;
    setHint(fileName(context.sourcePath));
    const apply = $('ai-diff-apply') as HTMLButtonElement | null;
    if (apply) apply.disabled = false;

    registerVirtualTab({
        slug: 'ai-diff',
        label: () => '✨ KI-Review',
        dirty: () => !!review?.edited,
        onActivate: () => {
            const diff = window.FolioDiffView;
            if (diff) {
                diff.layout();
                diff.focus();
            }
        },
        onClose: () => guardedClose(),
    });

    await diffView.mount('ai-diff-mount');
    const modified = embedSelectionResult(
        context.originalFull,
        context.selection,
        context.resultText,
    );
    diffView.setContents(context.originalFull, modified, 'markdown');
    diffView.onModifiedChange(onModifiedEdit);
    diffView.focus();
    reportReviewState(true, false);
}

function closeReview(): void {
    const region = $('ai-diff-region');
    if (region) region.hidden = true;
    const diffView = window.FolioDiffView;
    if (diffView) {
        diffView.onModifiedChange(null);
        diffView.dispose();
    }
    review = null;
    unregisterVirtualTab('ai-diff');
    reportReviewState(false, false);
}

/** Verwerfen mit Bestätigung, wenn der User im Review editiert hat. */
async function guardedClose(): Promise<boolean> {
    if (!review) return true;
    if (review.edited) {
        const ok = await showConfirmDialog(
            'Die bearbeitete KI-Review verwerfen?',
            { title: 'KI-Review', okLabel: 'Verwerfen' },
        );
        if (!ok) return false;
    }
    closeReview();
    return true;
}

/**
 * Quit-Integration: eine editierte offene Review muss vor dem Beenden
 * explizit verworfen werden (analog dirty Tab). Liefert false, wenn der
 * User abbricht.
 */
export async function confirmAiReviewForQuit(): Promise<boolean> {
    if (!review) return true;
    if (review.edited) {
        const ok = await showConfirmDialog(
            'Die bearbeitete KI-Review wird beim Beenden verworfen. Fortfahren?',
            { title: 'KI-Review', okLabel: 'Verwerfen und beenden' },
        );
        if (!ok) return false;
    }
    closeReview();
    return true;
}

async function applyReview(): Promise<void> {
    if (!review) return;
    // Dreistufiger Guard (Spec): existiert → aktiv → Snapshot.
    if (!hasDocumentTab(review.sourceTabId)) {
        setHint('Der Quell-Tab wurde geschlossen — Übernehmen ist nicht mehr möglich.');
        const apply = $('ai-diff-apply') as HTMLButtonElement | null;
        if (apply) apply.disabled = true;
        return;
    }
    if (getActiveTabId() !== review.sourceTabId) {
        setHint('Bitte zuerst den Quell-Tab aktivieren.');
        return;
    }
    if (getEditorText() !== review.originalFull) {
        const ok = await showConfirmDialog(
            'Das Dokument wurde zwischenzeitlich geändert — Ersetzen überschreibt diese Änderungen.',
            { title: 'KI-Review', okLabel: 'Trotzdem ersetzen' },
        );
        if (!ok) return;
    }
    const diffView = window.FolioDiffView;
    const editorSurface = window.FolioEditor;
    if (!diffView || !editorSurface) return;
    const modified = diffView.getModified();
    const cursor = firstDiffOffset(review.originalFull, modified);
    editorSurface.applyReplace({
        fullText: modified,
        selectionStart: cursor,
        selectionLength: 0,
    });
    folioLog.info('ai-review', 'KI-Ergebnis übernommen', {
        runId: review.runId,
        chars: [...modified].length,
    });
    closeReview();
}

export function initAiDiffReview(): void {
    if (!$('ai-diff-region')) return;
    review = null;
    $('ai-diff-apply')?.addEventListener('click', () => void applyReview());
    $('ai-diff-discard')?.addEventListener('click', () => void guardedClose());
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !isVirtualTabActive('ai-diff')) return;
        // Offene Overlays (z. B. der Bestätigungsdialog) haben Vorrang.
        const confirmDialog = $('confirm-dialog');
        if (confirmDialog && !confirmDialog.hidden) return;
        event.preventDefault();
        void guardedClose();
    });
}
