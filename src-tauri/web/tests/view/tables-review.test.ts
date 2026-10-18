// Korrekturrunde 1 nach den Reviews (Argon, Sol) — Orakel aus deren Repros:
// V1 Links/Checkboxen im Overlay laufen ueber das App-Routing (Sol R5,
//    Argon B2), inkl. Dirty-Gate, neuer Tab, Mittelklick;
// V2 Sortieren/Filtern zaehlt eine laufende Suche neu (Sol R2, Argon W3),
//    Filtern haengt keine Zeilen um (Sol R4);
// V4 Zustand verfaellt auch bei einem Render ohne Tabellen (Sol R3, Argon W4);
// V5 Link in einer Kopfzelle sortiert nicht (Argon H1);
// V6 numerisch nur bei einheitlicher Einheit (Argon H3).

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';
import { setFormatLocale } from '../../app/i18n/format';
import { closeTableOverlay, forgetTableState, initTables, isNumericColumn, prepareTables, sortOrder } from '../../app/view/tables';
import { initMarkdownView, ViewFinder } from '../../app/view/markdown';

let tauri: TauriMockHandles;
let body: HTMLElement;
let dialog: HTMLDialogElement;
let latest: any = null;
const saveIfDirty = vi.fn(() => Promise.resolve(true));

const rowsHtml = (names: string[]) => names.map((x) => `<tr><td>${x}</td></tr>`).join('');
const html = (names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']) =>
    `<table><thead><tr><th>Name</th></tr></thead><tbody>${rowsHtml(names)}</tbody></table>`;

function filter(term: string): void {
    const input = document.querySelector('.folio-table-filter') as HTMLInputElement;
    input.value = term;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function linkClicks(): Array<{ href: string; newTab: boolean }> {
    return tauri.emit.mock.calls
        .filter((c: any[]) => c[0] === 'shell:event' && c[1] && c[1].type === 'linkClick')
        .map((c: any[]) => ({ href: c[1].href, newTab: c[1].newTab }));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
    await seedDeCatalog();
    (window as any).ResizeObserver = class { observe() {} disconnect() {} };
    // Dauerhafte Hosts: initMarkdownView/initTables binden einmal.
    document.body.innerHTML =
        '<div id="view-region"><div id="view-content"><main class="markdown-body"></main></div></div>'
        + '<div id="view-marker-lane"></div><div id="toc-region"><ul class="toc"></ul></div>'
        + '<dialog id="table-overlay"><button id="table-overlay-close"></button>'
        + '<div id="table-overlay-body" class="markdown-body"></div></dialog>';
    dialog = document.getElementById('table-overlay') as HTMLDialogElement;
    (dialog as any).showModal = () => dialog.setAttribute('open', '');
    (dialog as any).close = () => dialog.removeAttribute('open');
    Object.defineProperty(dialog, 'open', { configurable: true, get: () => dialog.hasAttribute('open') });
    initMarkdownView({ requestSaveIfDirty: saveIfDirty });
    initTables();
    window.addEventListener('folio-find-state', ((e: CustomEvent) => {
        if (!e.detail.scanning) latest = e.detail;
    }) as EventListener);
});

beforeEach(() => {
    closeTableOverlay();
    ViewFinder.closeFind();
    latest = null;
    // tests/setup.ts ersetzt __TAURI__ vor jedem Test: Mock hier neu setzen.
    tauri = installTauriMock();
    saveIfDirty.mockClear();
    setFormatLocale('de-DE');
    body = document.querySelector('#view-region main.markdown-body') as HTMLElement;
    body.innerHTML = html();
});

describe('V1 — Routing im Overlay', () => {
    function openWithLink(href: string): HTMLAnchorElement {
        body.innerHTML = html().replace('Alpha', `<a href="${href}">Alpha</a>`);
        prepareTables(body, '/link.md');
        (body.querySelector('.folio-table-expand') as HTMLElement).click();
        expect(dialog.open).toBe(true);
        return document.querySelector('#table-overlay-body a') as HTMLAnchorElement;
    }

    it('Klick: abgefangen, Overlay zu, Dirty-Gate, dann Backend-Routing', async () => {
        const link = openWithLink('andere.md');
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(dialog.open).toBe(false);
        expect(body.querySelector('a')).toBe(link);
        expect(saveIfDirty).toHaveBeenCalledTimes(1);
        await flush();
        expect(linkClicks()).toEqual([{ href: 'andere.md', newTab: false }]);
    });

    it('Strg+Klick und Mittelklick: neuer Tab, ohne Dirty-Gate', () => {
        let link = openWithLink('andere.md');
        const ctrl = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
        link.dispatchEvent(ctrl);
        expect(ctrl.defaultPrevented).toBe(true);
        link = openWithLink('dritte.md');
        const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
        link.dispatchEvent(middle);
        expect(middle.defaultPrevented).toBe(true);
        expect(dialog.open).toBe(false);
        expect(saveIfDirty).not.toHaveBeenCalled();
        expect(linkClicks()).toEqual([
            { href: 'andere.md', newTab: true },
            { href: 'dritte.md', newTab: true },
        ]);
    });

    it('Task-Checkbox im Overlay laeuft ueber den Checkbox-Handler (Revert ohne Editor)', () => {
        body.innerHTML = '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>'
            + '<ul><li class="task-list-item" data-line="3"><input type="checkbox"> x</li></ul>'
            + '</td></tr></tbody></table>';
        prepareTables(body, '/task.md');
        (body.querySelector('.folio-table-expand') as HTMLElement).click();
        const box = document.querySelector('#table-overlay-body input[type="checkbox"]') as HTMLInputElement;
        box.click();
        // Ohne Monaco/Render-Version ist das DOM „stale": der App-Handler
        // nimmt den optimistischen Toggle zurueck. Ohne Handler bliebe er.
        expect(box.checked).toBe(false);
    });
});

describe('V2 — laufende Suche', () => {
    it('Filtern zaehlt neu (Sol R2), ohne an einen Treffer zu springen', async () => {
        prepareTables(body, '/find.md');
        ViewFinder.openFind('Alpha');
        await flush();
        expect(latest.total).toBe(1);
        filter('Beta');
        await flush();
        expect(latest.total).toBe(0);
        filter('');
        await flush();
        expect(latest).toMatchObject({ total: 1, active: -1 });
    });

    it('Sortieren zaehlt neu (Argon W3)', async () => {
        prepareTables(body, '/find.md');
        filter('Beta');
        ViewFinder.openFind('Alpha');
        await flush();
        expect(latest.total).toBe(0);
        filter('');
        (body.querySelector('.folio-th-sort') as HTMLElement).click();
        await flush();
        expect(latest.total).toBe(1);
    });

    it('Filtereingabe haengt keine Zeilen um: Ranges bleiben gueltig (Sol R4)', () => {
        prepareTables(body, '/range.md');
        const cell = body.querySelector('td') as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(cell.firstChild as Node);
        filter('Alpha');
        expect(range.toString()).toBe('Alpha');
    });
});

describe('V4 — Zustand verfaellt bei einem Render ohne Tabellen', () => {
    it('Filter (Sol R3)', () => {
        prepareTables(body, '/remove.md');
        filter('Beta');
        body.innerHTML = '<p>no tables</p>';
        prepareTables(body, '/remove.md');
        body.innerHTML = html();
        prepareTables(body, '/remove.md');
        expect((body.querySelector('.folio-table-filter') as HTMLInputElement).value).toBe('');
    });

    it('Sortierung (Argon 6) — und idempotenter Aufruf haelt den Zustand', () => {
        forgetTableState('/repro.md');
        prepareTables(body, '/repro.md');
        (body.querySelector('.folio-th-sort') as HTMLElement).click();
        prepareTables(body, '/repro.md');
        body.innerHTML = html();
        prepareTables(body, '/repro.md');
        expect(body.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
        body.innerHTML = '<p>Keine Tabelle mehr</p>';
        prepareTables(body, '/repro.md');
        body.innerHTML = html();
        prepareTables(body, '/repro.md');
        expect(body.querySelector('th')!.hasAttribute('aria-sort')).toBe(false);
    });
});

describe('V5 — Link in der Kopfzelle', () => {
    it('kein <a> im Button; Linkklick routet und sortiert nicht; eigener Button sortiert', async () => {
        body.innerHTML = html().replace('<th>Name</th>', '<th><a href="ziel.md">Name</a></th>');
        prepareTables(body, '/head.md');
        const th = body.querySelector('th') as HTMLElement;
        expect(th.querySelector('.folio-th-sort a')).toBeNull();
        const btn = th.querySelector(':scope > .folio-th-sort') as HTMLButtonElement;
        expect(btn.classList.contains('folio-th-sort--icon')).toBe(true);
        expect(btn.getAttribute('aria-label')).toBe('Nach „Name“ sortieren');

        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        th.querySelector('a')!.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(th.hasAttribute('aria-sort')).toBe(false);
        await flush();
        expect(linkClicks()).toEqual([{ href: 'ziel.md', newTab: false }]);

        btn.click();
        expect(th.getAttribute('aria-sort')).toBe('ascending');
    });
});

describe('V6 — numerisch nur bei einer Einheit', () => {
    const pick = (values: string[]) => sortOrder(values, 'asc', 'de-DE').map((i) => values[i]);

    it('Referenzfaelle', () => {
        expect(isNumericColumn(['3 Mio.', '500'], 'de-DE')).toBe(false);
        expect(isNumericColumn(['5 h', '17 h', '2 h'], 'de-DE')).toBe(true);
        expect(pick(['5 h', '17 h', '2 h'])).toEqual(['2 h', '5 h', '17 h']);
        expect(isNumericColumn(['10 %', '5 %'], 'de-DE')).toBe(true);
        expect(pick(['10 %', '5 %'])).toEqual(['5 %', '10 %']);
        expect(isNumericColumn(['€ 10', '€ 2'], 'de-DE')).toBe(true);
        expect(pick(['€ 10', '€ 2'])).toEqual(['€ 2', '€ 10']);
        // leere Zellen zaehlen nicht als „andere Einheit"
        expect(isNumericColumn(['8.169,25 €', '', '250,25 €'], 'de-DE')).toBe(true);
    });

    it('gemischte Einheiten: je Einheit numerisch gruppiert, Zahlen ohne Einheit zuerst', () => {
        // Werte mit verschiedenen Einheiten sind nicht vergleichbar (3 Mio.
        // vs. 500); innerhalb einer Einheit aber schon — „1.250“ ist (de)
        // 1250, nicht 1 wie im Collator mit `numeric`.
        expect(pick(['3 Mio.', '1.500'])).toEqual(['1.500', '3 Mio.']);
        const mixed = ['3 Mio.', '500', '2 Mrd.', '12', '7', '1.250'];
        expect(pick(mixed)).toEqual(['7', '12', '500', '1.250', '3 Mio.', '2 Mrd.']);
        expect(sortOrder(mixed, 'desc', 'de-DE').map((i) => mixed[i]))
            .toEqual(['2 Mrd.', '3 Mio.', '1.250', '500', '12', '7']);
        // Zahlen vor Text, Text per Collator; leere Zellen bleiben am Ende.
        const withText = ['offen', '1.250', '', '20 h', '7', '5 h'];
        expect(pick(withText)).toEqual(['7', '1.250', '5 h', '20 h', 'offen', '']);
        // gleiche (leere) Einheit bleibt numerisch: 20 < 1000.
        expect(pick(['1.000', '20'])).toEqual(['20', '1.000']);
    });
});
