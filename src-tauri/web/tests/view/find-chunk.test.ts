import { beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock } from '../helpers';

function repeatedNeedles(count: number): string {
    return Array.from({ length: count }, () => 'needle').join(' ');
}

async function waitForFinalFindState(action: () => void): Promise<any> {
    let last: any = null;
    const handler = ((event: CustomEvent) => {
        last = event.detail;
    }) as EventListener;
    window.addEventListener('folio-find-state', handler);
    try {
        action();
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
            if (last && !last.scanning) return last;
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return last;
    } finally {
        window.removeEventListener('folio-find-state', handler);
    }
}

beforeEach(() => {
    installTauriMock();
    document.body.innerHTML = '';
});

describe('view find chunking', () => {
    it('Markdown ViewFinder continues inside a text node across chunk boundaries', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        const expected = 505;
        document.body.innerHTML = `
            <div id="view-content">
                <div id="view-region"><main class="markdown-body"></main></div>
            </div>
            <div id="view-marker-lane"></div>
        `;
        document.querySelector('#view-region main.markdown-body')!.textContent = repeatedNeedles(expected);

        const state = await waitForFinalFindState(() => {
            ViewFinder.openFind('needle');
        });

        expect(state).toMatchObject({ term: 'needle', total: expected, active: 0 });
        ViewFinder.closeFind();
    });

    it('HtmlFinder continues inside an iframe text node across chunk boundaries', async () => {
        const { HtmlFinder } = await import('../../app/view/html');
        const expected = 505;
        document.body.innerHTML = `
            <iframe id="html-view-frame"></iframe>
            <div id="html-marker-lane"></div>
        `;
        const iframe = document.getElementById('html-view-frame') as HTMLIFrameElement;
        const doc = iframe.contentDocument!;
        doc.open();
        doc.write('<!doctype html><html><body></body></html>');
        doc.close();
        doc.body.textContent = repeatedNeedles(expected);

        const state = await waitForFinalFindState(() => {
            HtmlFinder.openFind('needle');
        });

        expect(state).toMatchObject({ term: 'needle', total: expected, active: 0 });
        HtmlFinder.closeFind();
    });
});
