import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';

beforeEach(() => {
    vi.resetModules();
    document.body.className = 'split-mode kind-markdown';
    document.body.innerHTML = `
        <div id="view-region">
            <div id="view-content">
                <main class="markdown-body">
                    <h1 id="a">A</h1>
                    <p>Alpha</p>
                    <h2 id="b">B</h2>
                </main>
            </div>
        </div>
    `;
});

function rect(top: number): DOMRect {
    return {
        top,
        left: 0,
        right: 0,
        bottom: top,
        width: 0,
        height: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

describe('view/scroll-sync', () => {
    it('scrollt die Markdown-View zur Heading unter der Editor-Zeile', async () => {
        const sync = await import('../../app/view/scroll-sync');
        const content = document.getElementById('view-content') as HTMLElement;
        const heading = document.getElementById('b') as HTMLElement;
        Object.defineProperty(content, 'scrollTop', { value: 20, writable: true });
        Object.defineProperty(content, 'getBoundingClientRect', { value: () => rect(0) });
        Object.defineProperty(heading, 'getBoundingClientRect', { value: () => rect(300) });
        const scrollTo = vi.fn((_: number, y: number) => { content.scrollTop = y; });
        content.scrollTo = scrollTo;

        sync.setMarkdownHeadingMap([
            { slug: 'a', line: 1 },
            { slug: 'b', line: 8 },
        ]);
        sync.syncEditorLineToView(10);

        expect(scrollTo).toHaveBeenCalledWith(0, 240);
    });

    it('revealt die Editor-Zeile fuer einen sichtbaren View-Slug', async () => {
        const sync = await import('../../app/view/scroll-sync');
        const revealLineNearTop = vi.fn();
        (window as any).FolioEditor = { revealLineNearTop };

        sync.setMarkdownHeadingMap([{ slug: 'b', line: 8 }]);
        sync.syncViewSlugToEditor('b');

        expect(revealLineNearTop).toHaveBeenCalledWith(8);
    });

    it('registriert Editor-Events fuer Selection und Scroll', async () => {
        const tauri = installTauriMock();
        const sync = await import('../../app/view/scroll-sync');
        const content = document.getElementById('view-content') as HTMLElement;
        const heading = document.getElementById('b') as HTMLElement;
        Object.defineProperty(content, 'scrollTop', { value: 0, writable: true });
        Object.defineProperty(content, 'getBoundingClientRect', { value: () => rect(0) });
        Object.defineProperty(heading, 'getBoundingClientRect', { value: () => rect(200) });
        content.scrollTo = vi.fn();

        sync.setMarkdownHeadingMap([{ slug: 'b', line: 8 }]);
        sync.initMarkdownScrollSync();
        tauri.emitEvent('editor:selection', { line: 8 });

        expect(content.scrollTo).toHaveBeenCalledWith(0, 120);
    });
});
