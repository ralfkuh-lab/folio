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
import { setMode } from '../editor/shell';
import { showConfirmDialog } from './dialogs';
import { folioLog, safeInvoke } from '../util/log';
import { t } from '../i18n/translate';
import { closeGitDiff } from './git-diff';

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
// Generation gegen Late-Mount/-Apply nach Close (Review-Befund):
// jede open/close-Transition invalidiert laufende Fortsetzungen.
let reviewGeneration = 0;

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
        if (before.charCodeAt(index) !== after.charCodeAt(index)) {
            return backOffLowSurrogate(after, index);
        }
    }
    return before.length === after.length ? 0 : backOffLowSurrogate(after, max);
}

/** Fällt der Offset auf ein Low-Surrogate, einen Schritt zurück — der
 *  Cursor darf kein Surrogatpaar zerschneiden. */
function backOffLowSurrogate(text: string, index: number): number {
    if (index > 0 && index < text.length) {
        const code = text.charCodeAt(index);
        const previous = text.charCodeAt(index - 1);
        if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
            return index - 1;
        }
    }
    return index;
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
    // Dieselbe Surface: einen offenen Git-Diff (read-only) raeumen,
    // bevor die Review den Inhalt uebernimmt. Kein Datenverlust.
    closeGitDiff();
    review = { ...context, edited: false };
    const generation = ++reviewGeneration;
    region.hidden = false;
    const title = $('ai-diff-title');
    if (title) title.textContent = t('ai.diffReview.title', { actionName: context.actionName });
    setHint(fileName(context.sourcePath));
    const apply = $('ai-diff-apply') as HTMLButtonElement | null;
    if (apply) apply.disabled = false;

    registerVirtualTab({
        slug: 'ai-diff',
        label: () => t('ai.diffReview.titlePlain'),
        dirty: () => !!review?.edited,
        // Klick auf einen Dokument-Tab deaktiviert die Review nur —
        // sonst wäre der „Quelle aktivieren"-Guard-Schritt nicht ohne
        // Verwerfen erreichbar (Review-Befund).
        keepOnDocTabClick: true,
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
    if (generation !== reviewGeneration || !review) {
        // Review wurde während des (ersten) Monaco-Loads geschlossen —
        // Inhalt freigeben, Widget aber persistent lassen (clear statt
        // dispose, siehe Bug 2026-07-11 in diff-view.ts::clear).
        diffView.clear();
        return;
    }
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
    reviewGeneration += 1;
    const region = $('ai-diff-region');
    const diffView = window.FolioDiffView;
    // NICHT dispose() (Bug 2026-07-11 „Tasten zählen doppelt"): Monacos
    // createDiffEditor(...).dispose() entfernt das Widget nicht aus
    // getDiffEditors() und lässt seinen document-level Keybinding-Handler
    // aktiv — pro Review-Zyklus akkumulierte das zu N-facher Tasteneingabe.
    // Die DiffEditor-Instanz bleibt persistent; clear() gibt nur die Models
    // frei. dispose() ist dem echten Teardown vorbehalten.
    if (diffView) {
        diffView.onModifiedChange(null);
        diffView.clear();
    }
    if (region) region.hidden = true;
    review = null;
    unregisterVirtualTab('ai-diff');
    reportReviewState(false, false);
    // Fokus zurück in den Dokumenteditor (Fokus-Policy der Spec).
    if (window.FolioEditor && typeof window.FolioEditor.focus === 'function') {
        window.FolioEditor.focus();
    }
}

/** Verwerfen mit Bestätigung, wenn der User im Review editiert hat. */
async function guardedClose(): Promise<boolean> {
    if (!review) return true;
    if (review.edited) {
        const ok = await showConfirmDialog(
            t('ai.diffReview.discard.confirm'),
            { title: t('ai.diffReview.discard.title'), okLabel: t('dialogs.common.discard') },
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
            t('ai.diffReview.discardAndExit.confirm'),
            { title: t('ai.diffReview.discard.title'), okLabel: t('ai.diffReview.discardAndExit.action') },
        );
        if (!ok) return false;
    }
    closeReview();
    return true;
}

/** Dreistufiger Guard (Spec): existiert → aktiv → Snapshot. Liefert
 *  false, wenn Apply (noch) nicht erlaubt ist. */
function applyGuardsPass(context: ReviewState): boolean {
    if (!hasDocumentTab(context.sourceTabId)) {
        setHint(t('errors.ai.sourceTabClosed'));
        const apply = $('ai-diff-apply') as HTMLButtonElement | null;
        if (apply) apply.disabled = true;
        return false;
    }
    if (getActiveTabId() !== context.sourceTabId) {
        setHint(t('ai.diffReview.activateSource.hint'));
        return false;
    }
    return true;
}

async function applyReview(): Promise<void> {
    const context = review;
    if (!context) return;
    const generation = reviewGeneration;
    if (!applyGuardsPass(context)) return;
    if (getEditorText() !== context.originalFull) {
        const apply = $('ai-diff-apply') as HTMLButtonElement | null;
        const discard = $('ai-diff-discard') as HTMLButtonElement | null;
        if (apply) apply.disabled = true;
        if (discard) discard.disabled = true;
        const ok = await showConfirmDialog(
            t('ai.diffReview.apply.overwriteConfirm'),
            { title: t('ai.diffReview.discard.title'), okLabel: t('ai.diffReview.apply.overwrite.action') },
        );
        if (apply) apply.disabled = false;
        if (discard) discard.disabled = false;
        if (!ok) return;
        // Nach dem await ALLE Guards wiederholen — während des Dialogs
        // kann der User Tab gewechselt/geschlossen oder die Review
        // anderweitig beendet haben (Review-Befund).
        if (generation !== reviewGeneration || review !== context) return;
        if (!applyGuardsPass(context)) return;
    }
    const diffView = window.FolioDiffView;
    const editorSurface = window.FolioEditor;
    if (!diffView || !editorSurface) return;
    const modified = diffView.getModified();
    const cursor = firstDiffOffset(context.originalFull, modified);
    editorSurface.applyReplace({
        fullText: modified,
        selectionStart: cursor,
        selectionLength: 0,
    });
    folioLog.info('ai-review', 'KI-Ergebnis übernommen', {
        runId: context.runId,
        chars: [...modified].length,
    });
    closeReview();
    // Übernehmen ist eine Editor-Operation (ein Undo-Schritt, Cursor auf firstDiff);
    // im View-Mode wäre das Ergebnis unsichtbar und der Dirty-Zustand überraschend.
    // Split bleibt Split (Editor dort schon sichtbar). Der Active-Tab-Re-Check
    // verhindert, dass ein Tab-Wechsel im IPC-Fenster den Edit-Mode auf dem
    // falschen Tab setzt (set_view_mode wirkt auf den dann aktiven Tab).
    if (!document.body.classList.contains('edit-mode') &&
        !document.body.classList.contains('split-mode') &&
        getActiveTabId() === context.sourceTabId) {
        setMode('edit').catch((err) => {
            folioLog.warn('ai-review', 'setMode(edit) nach Übernehmen fehlgeschlagen', {
                error: String(err),
            });
        });
    }
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
