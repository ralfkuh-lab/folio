// view/tables.ts im Zusammenspiel: die View-Suche ueberspringt vom
// Tabellenfilter versteckte Zeilen und die Leiste, der Scroll-Sync nimmt
// aus sortierten/gefilterten Tabellen nur die Tabelle selbst.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';

async function finalFindState(action: () => void): Promise<any> {
    let last: any = null;
    const handler = ((event: CustomEvent) => { last = event.detail; }) as EventListener;
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

function rect(top: number): DOMRect {
    return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
    vi.resetModules();
    installTauriMock();
    if (typeof (window as any).ResizeObserver === 'undefined') {
        (window as any).ResizeObserver = class {
            constructor(_cb: any) {}
            observe() {}
            disconnect() {}
        };
    }
});

describe('Tabellenfilter und View-Suche', () => {
    it('zaehlt keine Treffer in versteckten Zeilen und nicht in der Leiste', async () => {
        const { ViewFinder } = await import('../../app/view/markdown');
        document.body.innerHTML = `
            <div id="view-content"><div id="view-region"><main class="markdown-body">
                <p>Alpha davor</p>
                <div class="folio-table">
                    <div class="folio-table-bar"><span class="folio-table-count">Alpha 1 von 2</span></div>
                    <div class="folio-table-scroll"><table><tbody>
                        <tr><td>Alpha sichtbar</td></tr>
                        <tr hidden><td>Alpha versteckt</td></tr>
                    </tbody></table></div>
                </div>
            </main></div></div>
            <div id="view-marker-lane"></div>`;
        const state = await finalFindState(() => { ViewFinder.openFind('Alpha'); });
        expect(state).toMatchObject({ term: 'Alpha', total: 2 });
        ViewFinder.closeFind();
    });
});

describe('Scroll-Sync mit sortierter Tabelle', () => {
    it('ignoriert Zeilen einer Tabelle mit Zustand, nimmt die Tabelle selbst', async () => {
        document.body.className = 'split-mode kind-markdown';
        document.body.innerHTML = `
            <div id="view-region"><div id="view-content"><main class="markdown-body">
                <table data-line="5" data-folio-arranged=""><tbody>
                    <tr data-line="6"><td>sortiert nach unten gerutscht</td></tr>
                </tbody></table>
                <p data-line="20">danach</p>
            </main></div></div>`;
        const sync = await import('../../app/view/scroll-sync');
        const content = document.getElementById('view-content') as HTMLElement;
        Object.defineProperty(content, 'scrollTop', { value: 0, writable: true });
        Object.defineProperty(content, 'getBoundingClientRect', { value: () => rect(0) });
        const table = document.querySelector('table') as HTMLElement;
        const tr = document.querySelector('tr') as HTMLElement;
        const p = document.querySelector('p') as HTMLElement;
        Object.defineProperty(table, 'getBoundingClientRect', { value: () => rect(100) });
        Object.defineProperty(tr, 'getBoundingClientRect', { value: () => rect(900) });
        Object.defineProperty(p, 'getBoundingClientRect', { value: () => rect(400) });
        const scrollTo = vi.fn((_: number, y: number) => { content.scrollTop = y; });
        content.scrollTo = scrollTo;

        sync.setMarkdownHeadingMap([]);
        sync.syncEditorLineToView(6);
        // Interpoliert zwischen Tabelle (Zeile 5, y=100) und Absatz (Zeile 20,
        // y=400): 100 + 300/15 = 120, minus 80 px Kopfabstand. Mit der Zeile
        // (y=900) waeren es 820.
        expect(scrollTo).toHaveBeenCalledWith(0, 40);
    });
});
