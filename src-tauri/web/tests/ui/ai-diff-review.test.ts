import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

vi.mock('../../app/state/tabs', () => ({
    getActiveTabId: vi.fn(() => 7),
    hasDocumentTab: vi.fn(() => true),
    isVirtualTabActive: vi.fn(() => true),
    refreshVirtualTabs: vi.fn(),
    registerVirtualTab: vi.fn(),
    unregisterVirtualTab: vi.fn(),
}));
vi.mock('../../app/state/document', () => ({
    getEditorText: vi.fn(() => '# Original'),
}));
vi.mock('../../app/editor/shell', () => ({
    setMode: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../app/ui/git-diff', () => ({
    closeGitDiff: vi.fn(),
    isGitDiffOpen: vi.fn(() => false),
}));

import {
    confirmAiReviewForQuit,
    embedSelectionResult,
    firstDiffOffset,
    initAiDiffReview,
    isAiReviewOpen,
    openAiDiffReview,
} from '../../app/ui/ai-diff-review';
import { getActiveTabId, hasDocumentTab, registerVirtualTab } from '../../app/state/tabs';
import { getEditorText } from '../../app/state/document';
import { setMode } from '../../app/editor/shell';

function buildDom(): void {
    document.body.innerHTML = `
        <div id="ai-diff-region" hidden>
            <span id="ai-diff-title"></span>
            <span id="ai-diff-hint"></span>
            <button id="ai-diff-discard"></button>
            <button id="ai-diff-apply"></button>
            <div id="ai-diff-mount"></div>
        </div>
        <div id="confirm-dialog" hidden>
            <div id="confirm-title"></div>
            <div id="confirm-text"></div>
            <button id="confirm-cancel"></button>
            <button id="confirm-ok"></button>
        </div>
    `;
}

function installDiffViewMock(modified = '# Modified') {
    const mock = {
        mount: vi.fn(() => Promise.resolve()),
        setContents: vi.fn(),
        onModifiedChange: vi.fn(),
        getModified: vi.fn(() => modified),
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

function installEditorMock() {
    const mock = { applyReplace: vi.fn() };
    (window as any).FolioEditor = mock;
    return mock;
}

const baseContext = {
    runId: 3,
    sourceTabId: 7,
    sourcePath: '/tmp/doc.md',
    originalFull: '# Original',
    selection: null,
    resultText: '# Modified',
    actionName: 'Neu formatieren',
};

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ai-diff-review Einbettung + Cursor (reine Funktionen)', () => {
    it('bettet das Selektions-Ergebnis per UTF-16-Offsets in den Volltext ein', () => {
        // "Ä" = 1 Unit, "😀" = 2 Units — slice arbeitet auf UTF-16.
        const original = 'Ä😀xyz Ende';
        const selection = { start: 3, length: 3 }; // "xyz"
        expect(embedSelectionResult(original, selection, 'NEU'))
            .toBe('Ä😀NEU Ende');
        expect(embedSelectionResult(original, null, 'ALLES')).toBe('ALLES');
    });

    it('liefert den ersten UTF-16-Unterschied als Cursor-Offset', () => {
        expect(firstDiffOffset('abc', 'abX')).toBe(2);
        expect(firstDiffOffset('abc', 'abcdef')).toBe(3);
        expect(firstDiffOffset('gleich', 'gleich')).toBe(0);
        expect(firstDiffOffset('😀a', '😀b')).toBe(2);
        expect(firstDiffOffset('', 'neu')).toBe(0);
        // Unterschied im Low-Surrogate (😀 vs 😁 teilen das High-
        // Surrogate) → Cursor darf das Paar nicht zerschneiden.
        expect(firstDiffOffset('😀', '😁')).toBe(0);
        expect(firstDiffOffset('a😀', 'a😁')).toBe(1);
    });
});

describe('ai-diff-review Guards + Übernahme', () => {
    let handles: TauriMockHandles;
    let diffView: ReturnType<typeof installDiffViewMock>;
    let editor: ReturnType<typeof installEditorMock>;

    beforeEach(async () => {
        await seedDeCatalog();
        buildDom();
        handles = installTauriMock();
        handles.invoke.mockResolvedValue(undefined);
        diffView = installDiffViewMock();
        editor = installEditorMock();
        vi.mocked(getActiveTabId).mockReturnValue(7);
        vi.mocked(hasDocumentTab).mockReturnValue(true);
        vi.mocked(getEditorText).mockReturnValue('# Original');
        vi.mocked(registerVirtualTab).mockClear();
        initAiDiffReview();
    });

    it('öffnet die Review mit eingebettetem Diff und meldet den Zustand ans Backend', async () => {
        await openAiDiffReview({ ...baseContext, selection: null });

        expect(isAiReviewOpen()).toBe(true);
        expect(document.getElementById('ai-diff-region')!.hidden).toBe(false);
        expect(document.getElementById('ai-diff-title')!.textContent)
            .toContain('Neu formatieren');
        expect(diffView.setContents).toHaveBeenCalledWith('# Original', '# Modified', 'markdown');
        expect(registerVirtualTab).toHaveBeenCalled();
        expect(handles.invoke).toHaveBeenCalledWith(
            'ai_review_state_set',
            { open: true, dirty: false },
        );
    });

    it('übernimmt via applyReplace mit firstDiff-Cursor und schließt die Review', async () => {
        await openAiDiffReview(baseContext);
        document.getElementById('ai-diff-apply')!.click();
        await flush();

        expect(editor.applyReplace).toHaveBeenCalledWith({
            fullText: '# Modified',
            selectionStart: 2, // '# O…' vs '# M…' → erster Unterschied bei Index 2
            selectionLength: 0,
        });
        expect(isAiReviewOpen()).toBe(false);
        // Persistente DiffEditor-Instanz: closeReview ruft clear(), NICHT
        // dispose() (Bug 2026-07-11 „Tasten zählen doppelt").
        expect(diffView.clear).toHaveBeenCalled();
        expect(diffView.dispose).not.toHaveBeenCalled();
        expect(handles.invoke).toHaveBeenCalledWith(
            'ai_review_state_set',
            { open: false, dirty: false },
        );
        // Fix 2: Übernehmen aus View-Mode (body ohne edit/split) ruft setMode('edit')
        expect(setMode).toHaveBeenCalledWith('edit');
    });

    it('wechselt NICHT in den Edit-Mode, wenn Edit oder Split bereits aktiv ist', async () => {
        // Codex-Review-Befund 2026-07-11: „Split bleibt Split" und der
        // Edit-Fall waren nicht regressionsgesichert.
        for (const modeClass of ['edit-mode', 'split-mode']) {
            vi.mocked(setMode).mockClear();
            document.body.classList.add(modeClass);
            try {
                await openAiDiffReview(baseContext);
                document.getElementById('ai-diff-apply')!.click();
                await flush();
                expect(setMode).not.toHaveBeenCalled();
            } finally {
                document.body.classList.remove(modeClass);
            }
        }
    });

    it('sperrt Übernehmen, wenn der Quell-Tab geschlossen wurde', async () => {
        await openAiDiffReview(baseContext);
        vi.mocked(hasDocumentTab).mockReturnValue(false);
        document.getElementById('ai-diff-apply')!.click();
        await flush();

        expect(editor.applyReplace).not.toHaveBeenCalled();
        expect((document.getElementById('ai-diff-apply') as HTMLButtonElement).disabled)
            .toBe(true);
        expect(document.getElementById('ai-diff-hint')!.textContent)
            .toContain('geschlossen');
        expect(isAiReviewOpen()).toBe(true); // Verwerfen bleibt möglich
    });

    it('verlangt bei fremdem aktiven Tab erst die Aktivierung der Quelle', async () => {
        await openAiDiffReview(baseContext);
        vi.mocked(getActiveTabId).mockReturnValue(99);
        document.getElementById('ai-diff-apply')!.click();
        await flush();

        expect(editor.applyReplace).not.toHaveBeenCalled();
        expect(document.getElementById('ai-diff-hint')!.textContent)
            .toContain('aktivieren');
    });

    it('fragt bei verändertem Snapshot nach und übernimmt nur nach Bestätigung', async () => {
        await openAiDiffReview(baseContext);
        vi.mocked(getEditorText).mockReturnValue('# Original — inzwischen geändert');
        document.getElementById('ai-diff-apply')!.click();
        await flush();

        // Bestätigungsdialog offen, noch nichts übernommen.
        expect(document.getElementById('confirm-dialog')!.hidden).toBe(false);
        expect(editor.applyReplace).not.toHaveBeenCalled();

        document.getElementById('confirm-ok')!.click();
        await flush();
        expect(editor.applyReplace).toHaveBeenCalled();
        expect(isAiReviewOpen()).toBe(false);
    });

    it('wiederholt die Guards nach dem Bestätigungs-await (Tab-Wechsel während des Dialogs)', async () => {
        await openAiDiffReview(baseContext);
        vi.mocked(getEditorText).mockReturnValue('# Original — geändert');
        document.getElementById('ai-diff-apply')!.click();
        await flush();
        expect(document.getElementById('confirm-dialog')!.hidden).toBe(false);

        // Während der Bestätigung wechselt der aktive Tab → nach OK darf
        // NICHT übernommen werden (Guard-Wiederholung, Review-Befund).
        vi.mocked(getActiveTabId).mockReturnValue(99);
        document.getElementById('confirm-ok')!.click();
        await flush();

        expect(editor.applyReplace).not.toHaveBeenCalled();
        expect(document.getElementById('ai-diff-hint')!.textContent)
            .toContain('aktivieren');
        expect(isAiReviewOpen()).toBe(true);
    });

    it('Quit-Guard: editierte Review verlangt Bestätigung, unbearbeitete schließt still', async () => {
        await openAiDiffReview(baseContext);
        // Unbearbeitet → still schließen, true.
        await expect(confirmAiReviewForQuit()).resolves.toBe(true);
        expect(isAiReviewOpen()).toBe(false);

        // Edit-Callback simulieren → dirty; Abbruch im Dialog → false.
        await openAiDiffReview(baseContext);
        const editCallback = diffView.onModifiedChange.mock.calls
            .map((call) => call[0])
            .filter(Boolean)
            .pop();
        editCallback!();
        expect(handles.invoke).toHaveBeenCalledWith(
            'ai_review_state_set',
            { open: true, dirty: true },
        );
        const quitPromise = confirmAiReviewForQuit();
        await flush();
        document.getElementById('confirm-cancel')!.click();
        await expect(quitPromise).resolves.toBe(false);
        expect(isAiReviewOpen()).toBe(true);
    });
});
