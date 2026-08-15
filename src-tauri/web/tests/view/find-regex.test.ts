import { beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock } from '../helpers';

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

function setupMarkdown(html: string): void {
    document.body.innerHTML = `
        <div id="view-content">
            <div id="view-region"><main class="markdown-body">${html}</main></div>
        </div>
        <div id="view-marker-lane"></div>
    `;
}

function setupHtml(bodyHtml: string): HTMLIFrameElement {
    document.body.innerHTML = `
        <iframe id="html-view-frame"></iframe>
        <div id="html-marker-lane"></div>
    `;
    const iframe = document.getElementById('html-view-frame') as HTMLIFrameElement;
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(`<!doctype html><html><body>${bodyHtml}</body></html>`);
    doc.close();
    return iframe;
}

beforeEach(() => {
    installTauriMock();
    document.body.innerHTML = '';
    if (typeof (window as any).ResizeObserver === 'undefined') {
        (window as any).ResizeObserver = class {
            constructor(_cb: any) {}
            observe() {}
            disconnect() {}
        };
    }
});

describe('ViewFinder regex search', () => {
    it('matches a regex alternation that a literal search would miss', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        setupMarkdown('cat dog bird');
        ViewFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const state = await waitForFinalFindState(() => ViewFinder.openFind('cat|bird'));
        expect(state).toMatchObject({ term: 'cat|bird', total: 2, active: 0 });
        expect(state.invalidRegex).toBeUndefined();
        ViewFinder.closeFind();
    });

    it('does not treat a literal pipe as alternation', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        setupMarkdown('cat|bird cat bird');
        ViewFinder.setFindOptions({ regex: false, caseSensitive: false, wholeWord: false });
        const state = await waitForFinalFindState(() => ViewFinder.openFind('cat|bird'));
        expect(state).toMatchObject({ term: 'cat|bird', total: 1 });
        ViewFinder.closeFind();
    });

    it('skips zero-width matches instead of looping', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        setupMarkdown('no such thing');
        ViewFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const state = await waitForFinalFindState(() => ViewFinder.openFind('a*'));
        expect(state).toMatchObject({ term: 'a*', total: 0 });
        expect(state.invalidRegex).toBeUndefined();
        ViewFinder.closeFind();
    });

    it('reports invalid regex instead of a silent zero-hit result', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        setupMarkdown('hello hello');
        ViewFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const bad = await waitForFinalFindState(() => ViewFinder.openFind('('));
        expect(bad).toMatchObject({ term: '(', total: 0, active: -1, invalidRegex: true });

        const good = await waitForFinalFindState(() => ViewFinder.setFindTerm('hello'));
        expect(good).toMatchObject({ term: 'hello', total: 2, active: 0 });
        expect(good.invalidRegex).toBeUndefined();
        ViewFinder.closeFind();
    });

    it('respects caseSensitive in regex mode', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        setupMarkdown('Foo foo FOO');
        ViewFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const ci = await waitForFinalFindState(() => ViewFinder.openFind('foo'));
        expect(ci).toMatchObject({ total: 3 });

        ViewFinder.setFindOptions({ regex: true, caseSensitive: true, wholeWord: false });
        const cs = await waitForFinalFindState(() => ViewFinder.setFindTerm('foo'));
        expect(cs).toMatchObject({ total: 1 });
        ViewFinder.closeFind();
    });

    it('skips zero-width matches on surrogate pairs without looping', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        setupMarkdown('😀😀');
        ViewFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const state = await waitForFinalFindState(() => ViewFinder.openFind('a*'));
        expect(state).toMatchObject({ term: 'a*', total: 0 });
        ViewFinder.closeFind();
    });

    it('does not match a regex across text-node boundaries', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        setupMarkdown('<span>a</span><span>a</span>');
        ViewFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const across = await waitForFinalFindState(() => ViewFinder.openFind('aa'));
        expect(across).toMatchObject({ total: 0 });
        const single = await waitForFinalFindState(() => ViewFinder.setFindTerm('a'));
        expect(single).toMatchObject({ total: 2 });
        ViewFinder.closeFind();
    });
});

describe('HtmlFinder regex search', () => {
    it('matches a regex alternation that a literal search would miss', async () => {
        const { HtmlFinder } = await import('../../app/view/html');
        setupHtml('cat dog bird');
        HtmlFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const state = await waitForFinalFindState(() => HtmlFinder.openFind('cat|bird'));
        expect(state).toMatchObject({ term: 'cat|bird', total: 2, active: 0 });
        HtmlFinder.closeFind();
    });

    it('skips zero-width matches instead of looping', async () => {
        const { HtmlFinder } = await import('../../app/view/html');
        setupHtml('no such thing');
        HtmlFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const state = await waitForFinalFindState(() => HtmlFinder.openFind('a*'));
        expect(state).toMatchObject({ term: 'a*', total: 0 });
        expect(state.invalidRegex).toBeUndefined();
        HtmlFinder.closeFind();
    });

    it('reports invalid regex instead of a silent zero-hit result', async () => {
        const { HtmlFinder } = await import('../../app/view/html');
        setupHtml('hello hello');
        HtmlFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const bad = await waitForFinalFindState(() => HtmlFinder.openFind('('));
        expect(bad).toMatchObject({ term: '(', total: 0, active: -1, invalidRegex: true });

        const good = await waitForFinalFindState(() => HtmlFinder.setFindTerm('hello'));
        expect(good).toMatchObject({ term: 'hello', total: 2, active: 0 });
        expect(good.invalidRegex).toBeUndefined();
        HtmlFinder.closeFind();
    });

    it('respects caseSensitive in regex mode', async () => {
        const { HtmlFinder } = await import('../../app/view/html');
        setupHtml('Foo foo FOO');
        HtmlFinder.setFindOptions({ regex: true, caseSensitive: false, wholeWord: false });
        const ci = await waitForFinalFindState(() => HtmlFinder.openFind('foo'));
        expect(ci).toMatchObject({ total: 3 });

        HtmlFinder.setFindOptions({ regex: true, caseSensitive: true, wholeWord: false });
        const cs = await waitForFinalFindState(() => HtmlFinder.setFindTerm('foo'));
        expect(cs).toMatchObject({ total: 1 });
        HtmlFinder.closeFind();
    });
});
