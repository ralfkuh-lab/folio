// Tests fuer view/preview.ts — die in CLAUDE.md als regressionstraechtig
// dokumentierten Invarianten:
// - Debounce 150 ms; beim Timer-Fire wird der AKTUELLE Editor-Stand live
//   aus Monaco geholt (nicht der closure-captured Schedule-Text).
// - renderGen-Generation: verspaetete Antworten alter Renders werden
//   verworfen (auch nach invalidatePreview).
// - invalidatePreview cancelt pending Timer.
// - BEWUSST kein isDirty-Gate: auch ein Revert auf cleanText rendert
//   (das Wieder-Einbauen des Gates war das dokumentierte Revert-Bug-
//   Muster).

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';

vi.mock('../../app/view/markdown', () => ({
    setTocList: vi.fn(),
    rewriteRelativeAssets: vi.fn(),
    ViewFinder: { setFindTerm: vi.fn() },
}));
vi.mock('../../app/view/code-highlight', () => ({
    highlightCodeBlocks: vi.fn(),
}));
vi.mock('../../app/view/code-copy', () => ({
    addCodeCopyButtons: vi.fn(),
}));
vi.mock('../../app/view/scroll-sync', () => ({
    afterMarkdownPreviewRender: vi.fn(),
    setMarkdownHeadingMap: vi.fn(),
}));

type Preview = typeof import('../../app/view/preview');

function buildDom(): void {
    document.body.innerHTML = `
        <div id="view-region">
            <div id="view-content"><main class="markdown-body"></main></div>
        </div>
    `;
    document.body.className = 'kind-markdown';
}

function markdownBody(): HTMLElement {
    return document.querySelector('#view-region main.markdown-body') as HTMLElement;
}

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('view/preview', () => {
    let handles: TauriMockHandles;
    let preview: Preview;
    let renderResolvers: Array<(content: string) => void>;
    let editorText: string;

    function renderCalls(): any[] {
        return handles.invoke.mock.calls.filter((c) => c[0] === 'render_markdown_preview');
    }

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        handles = installTauriMock();
        renderResolvers = [];
        editorText = '';
        handles.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'render_markdown_preview') {
                return new Promise((resolve) => {
                    renderResolvers.push((content: string) =>
                        resolve({ content, tocHtml: '', headingMap: [] }));
                });
            }
            return Promise.resolve();
        });
        buildDom();
        (window as any).FolioEditor = { getText: () => editorText };
        preview = await import('../../app/view/preview');
        preview.initPreview({ getCurrentPath: () => '/doc/sample.md' });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rendert debounced und holt den Live-Editor-Stand statt des Schedule-Texts', async () => {
        editorText = 'LIVE';
        window.dispatchEvent(new CustomEvent('folio-editor-text-updated', { detail: 'STALE' }));
        expect(renderCalls().length).toBe(0); // noch im Debounce

        await vi.advanceTimersByTimeAsync(150);
        expect(renderCalls().length).toBe(1);
        expect(renderCalls()[0][1]).toEqual({ text: 'LIVE' });

        renderResolvers[0]('<p>live</p>');
        await flushMicrotasks();
        expect(markdownBody().innerHTML).toBe('<p>live</p>');
    });

    it('verwirft verspaetete Antworten alter Render-Generationen', async () => {
        preview.schedulePreviewRender('a');
        await vi.advanceTimersByTimeAsync(150);
        preview.schedulePreviewRender('b');
        await vi.advanceTimersByTimeAsync(150);
        expect(renderCalls().length).toBe(2);

        // Neuere Generation zuerst beantworten, dann die alte: die alte
        // darf den frischen Render nicht ueberschreiben.
        renderResolvers[1]('<p>neu</p>');
        await flushMicrotasks();
        expect(markdownBody().innerHTML).toBe('<p>neu</p>');

        renderResolvers[0]('<p>alt</p>');
        await flushMicrotasks();
        expect(markdownBody().innerHTML).toBe('<p>neu</p>');
    });

    it('invalidatePreview verwirft laufende Renders (document:loaded-Schutz)', async () => {
        preview.schedulePreviewRender('x');
        await vi.advanceTimersByTimeAsync(150);
        expect(renderCalls().length).toBe(1);

        preview.invalidatePreview();
        renderResolvers[0]('<p>verspaetet</p>');
        await flushMicrotasks();
        expect(markdownBody().innerHTML).toBe('');
    });

    it('invalidatePreview cancelt den pending Debounce-Timer', async () => {
        preview.schedulePreviewRender('x');
        preview.invalidatePreview();
        await vi.advanceTimersByTimeAsync(300);
        expect(renderCalls().length).toBe(0);
    });

    it('rendert auch ohne Dirty-State (bewusst kein isDirty-Gate)', async () => {
        // Revert-Szenario: User tippt und revertiert auf cleanText —
        // markDirty(false) darf den Re-Render nicht sperren. Das Modul
        // kennt absichtlich keinen Dirty-Begriff; dieser Test schlaegt
        // an, falls jemand das Gate "zur Optimierung" wieder einbaut.
        editorText = 'clean';
        preview.schedulePreviewRender('clean');
        await vi.advanceTimersByTimeAsync(150);
        expect(renderCalls().length).toBe(1);

        renderResolvers[0]('<p>clean</p>');
        await flushMicrotasks();
        expect(markdownBody().innerHTML).toBe('<p>clean</p>');
    });

    it('rendert nicht ohne offenes Markdown-Dokument', async () => {
        document.body.className = 'kind-text';
        preview.schedulePreviewRender('x');
        await vi.advanceTimersByTimeAsync(300);
        expect(renderCalls().length).toBe(0);
    });

    it('flushPreviewRender rendert sofort ohne Debounce', async () => {
        document.body.className = 'kind-markdown split-mode';
        editorText = 'sofort';
        const done = preview.flushPreviewRender();
        await flushMicrotasks();
        expect(renderCalls().length).toBe(1);
        expect(renderCalls()[0][1]).toEqual({ text: 'sofort' });
        renderResolvers[0]('<p>sofort</p>');
        await done;
        expect(markdownBody().innerHTML).toBe('<p>sofort</p>');
    });
});
