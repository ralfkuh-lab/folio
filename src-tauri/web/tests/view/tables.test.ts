// Tests fuer view/tables.ts (Spec docs/spec-tables.md).
// T2: Wrapper/Leiste idempotent, Overlay oeffnen/schliessen (✕, Escape,
// Hintergrund), Schliessen vor einem Re-Render, und dass nur die App-Hooks
// die Tabellen anfassen (Export/Theme-Editor sehen das Backend-HTML).
// T3/T4: vorgegebene Referenzfaelle fuer Zahlen, Sortierung und Filter,
// Sortier-Zyklus, Filterfeld ab 6 Zeilen, Zustand ueber Re-Renders.
//
// jsdom kennt kein showModal(): der Dialog bekommt hier eine minimale
// Nachbildung (open-Attribut + asynchrones close-Event wie im Browser).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDeCatalog } from '../helpers-i18n';
import { setFormatLocale } from '../../app/i18n/format';

type Tables = typeof import('../../app/view/tables');

const TABLE_HTML =
    '<p>vorher</p>'
    + '<table data-line="3"><thead><tr><th>Name</th><th>Wert</th></tr></thead>'
    + '<tbody><tr><td>Alpha</td><td>1</td></tr><tr><td>Beta</td><td>2</td></tr></tbody></table>'
    + '<p>nachher</p>';

function installDom(): { body: HTMLElement; dialog: HTMLDialogElement } {
    document.body.innerHTML =
        '<div id="view-region"><div id="view-content"><main class="markdown-body"></main></div></div>'
        + '<dialog id="table-overlay"><button id="table-overlay-close"></button>'
        + '<div id="table-overlay-body" class="markdown-body"></div></dialog>';
    const dialog = document.getElementById('table-overlay') as HTMLDialogElement;
    (dialog as any).showModal = function () { dialog.setAttribute('open', ''); };
    (dialog as any).close = function () {
        if (!dialog.hasAttribute('open')) return;
        dialog.removeAttribute('open');
        setTimeout(() => dialog.dispatchEvent(new Event('close')), 0);
    };
    Object.defineProperty(dialog, 'open', {
        configurable: true,
        get: () => dialog.hasAttribute('open'),
    });
    return {
        body: document.querySelector('#view-region main.markdown-body') as HTMLElement,
        dialog,
    };
}

describe('view/tables — T2 Wrapper und Overlay', () => {
    let mod: Tables;
    let body: HTMLElement;
    let dialog: HTMLDialogElement;

    // Einmal importieren: initTables haengt Listener an document, die ein
    // pro Test neu geladenes Modul sonst vervielfachen wuerde.
    beforeAll(async () => {
        await seedDeCatalog();
        installDom();
        mod = await import('../../app/view/tables');
        mod.initTables();
    });

    beforeEach(() => {
        mod.closeTableOverlay();
        ({ body, dialog } = installDom());
        body.innerHTML = TABLE_HTML;
    });

    it('umschliesst jede Tabelle genau einmal mit Leiste und Scroll-Rahmen', () => {
        mod.prepareTables(body);
        mod.prepareTables(body);
        const wraps = body.querySelectorAll('.folio-table');
        expect(wraps).toHaveLength(1);
        const wrap = wraps[0];
        expect(wrap.children[0].className).toBe('folio-table-bar');
        expect(wrap.children[1].className).toBe('folio-table-scroll');
        expect(wrap.children[1].firstElementChild!.tagName).toBe('TABLE');
        const btn = wrap.querySelector('.folio-table-expand') as HTMLButtonElement;
        expect(btn.type).toBe('button');
        expect(btn.title).toBe('Tabelle vergrößern');
        expect(btn.getAttribute('aria-label')).toBe('Tabelle vergrößert anzeigen');
        // Reihenfolge im Dokument bleibt erhalten.
        expect(Array.from(body.children).map((el) => el.tagName)).toEqual(['P', 'DIV', 'P']);
    });

    it('Vergroessern verschiebt den Rahmen ins Overlay, ✕ setzt ihn zurueck', () => {
        mod.prepareTables(body);
        const wrap = body.querySelector('.folio-table') as HTMLElement;
        const btn = wrap.querySelector('.folio-table-expand') as HTMLButtonElement;
        btn.click();
        expect(dialog.open).toBe(true);
        expect(document.getElementById('table-overlay-body')!.firstElementChild).toBe(wrap);
        expect(body.querySelector('.folio-table-placeholder')).not.toBeNull();
        expect(body.querySelector('table')).toBeNull();

        (document.getElementById('table-overlay-close') as HTMLButtonElement).click();
        expect(dialog.open).toBe(false);
        expect(body.children[1]).toBe(wrap);
        expect(body.querySelector('.folio-table-placeholder')).toBeNull();
        expect(document.activeElement).toBe(btn);
    });

    it('natives close (Escape) und Klick auf den Hintergrund schliessen ebenfalls', async () => {
        mod.prepareTables(body);
        const wrap = body.querySelector('.folio-table') as HTMLElement;
        const btn = wrap.querySelector('.folio-table-expand') as HTMLButtonElement;

        btn.click();
        // Escape: der Browser schliesst den Dialog selbst und feuert close.
        dialog.removeAttribute('open');
        dialog.dispatchEvent(new Event('close'));
        expect(body.children[1]).toBe(wrap);
        expect(document.activeElement).toBe(btn);

        btn.click();
        dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(dialog.open).toBe(false);
        expect(body.children[1]).toBe(wrap);
        // Das nachlaufende close-Event des Browsers aendert nichts mehr.
        await new Promise((r) => setTimeout(r, 0));
        expect(body.children[1]).toBe(wrap);
    });

    it('closeTableOverlay vor einem Re-Render: Overlay zu, neue Tabelle normal vorbereitet', async () => {
        mod.prepareTables(body);
        (body.querySelector('.folio-table-expand') as HTMLButtonElement).click();
        expect(dialog.open).toBe(true);

        mod.closeTableOverlay();
        body.innerHTML = TABLE_HTML;
        mod.prepareTables(body);
        await new Promise((r) => setTimeout(r, 0));

        expect(dialog.open).toBe(false);
        expect(document.getElementById('table-overlay-body')!.children).toHaveLength(0);
        expect(body.querySelectorAll('.folio-table')).toHaveLength(1);
    });

    it('verwirft die Overlay-Tabelle, wenn ihr Platzhalter schon ersetzt ist', () => {
        mod.prepareTables(body);
        (body.querySelector('.folio-table-expand') as HTMLButtonElement).click();
        body.innerHTML = TABLE_HTML;
        mod.closeTableOverlay();
        expect(document.getElementById('table-overlay-body')!.children).toHaveLength(0);
        expect(body.querySelectorAll('.folio-table')).toHaveLength(0);
    });
});

describe('view/tables — nur die App-View', () => {
    // Export, Export-Vorschau und Theme-Editor rendern im Backend bzw. im
    // iframe; sie duerfen die Hooks nie aufrufen. Aufgerufen wird
    // prepareTables ausschliesslich an den drei Post-Render-Stellen.
    it('prepareTables wird nur aus state/document.ts und view/preview.ts gerufen', () => {
        const appDir = join(__dirname, '../../app');
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                if (statSync(full).isDirectory()) walk(full);
                else if (name.endsWith('.ts')) files.push(full);
            }
        };
        walk(appDir);
        const calls: Record<string, number> = {};
        for (const file of files) {
            const rel = relative(appDir, file);
            if (rel === 'view/tables.ts') continue;
            const n = (readFileSync(file, 'utf8').match(/\bprepareTables\(/g) || []).length;
            if (n > 0) calls[rel] = n;
        }
        expect(calls).toEqual({ 'state/document.ts': 2, 'view/preview.ts': 1 });
    });
});

describe('view/tables — Zahlen (Referenzfaelle)', () => {
    let mod: Tables;
    beforeAll(async () => { mod = await import('../../app/view/tables'); });

    it('de-DE: Komma dezimal, Punkt Tausender bei Dreiergruppen, sonst dezimal', () => {
        const dec = mod.decimalSeparator('de-DE');
        expect(dec).toBe(',');
        expect(mod.parseCellNumber('1.234,5', dec)).toBe(1234.5);
        expect(mod.parseCellNumber('-3,5', dec)).toBe(-3.5);
        expect(mod.parseCellNumber('12 %', dec)).toBe(12);
        expect(mod.parseCellNumber('€ 10', dec)).toBe(10);
        expect(mod.parseCellNumber('3.14', dec)).toBe(3.14);
        expect(mod.parseCellNumber('1.000', dec)).toBe(1000);
        expect(mod.parseCellNumber('8.169,25 €', dec)).toBe(8169.25);
        expect(mod.parseCellNumber('17 h', dec)).toBe(17);
    });

    it('en-US: Punkt dezimal, Komma Tausender', () => {
        const dec = mod.decimalSeparator('en-US');
        expect(dec).toBe('.');
        expect(mod.parseCellNumber('1,234.5', dec)).toBe(1234.5);
        expect(mod.parseCellNumber('1.000', dec)).toBe(1);
    });

    it('Text, Daten und Bezeichner sind keine Zahlen', () => {
        for (const text of ['abc', 'Datei 10', '2026-02-04', 'VH-1061', '1.2.3', '3 Äpfel', '']) {
            expect(mod.parseCellNumber(text, ',')).toBeNull();
        }
    });
});

describe('view/tables — Sortieren (Referenzfaelle)', () => {
    let mod: Tables;
    beforeAll(async () => { mod = await import('../../app/view/tables'); });
    const pick = (values: string[], order: number[]) => order.map((i) => values[i]);

    it('de: numerisch, leere Zellen in beiden Richtungen am Ende', () => {
        const v = ['10', '2', '', '1.000'];
        expect(pick(v, mod.sortOrder(v, 'asc', 'de-DE'))).toEqual(['2', '10', '1.000', '']);
        expect(pick(v, mod.sortOrder(v, 'desc', 'de-DE'))).toEqual(['1.000', '10', '2', '']);
    });

    it('Collator numeric: Datei 2 vor Datei 10', () => {
        const v = ['Datei 10', 'Datei 2'];
        expect(pick(v, mod.sortOrder(v, 'asc', 'de-DE'))).toEqual(['Datei 2', 'Datei 10']);
    });

    it('nicht alle numerisch → Collator', () => {
        const v = ['abc', '3'];
        expect(pick(v, mod.sortOrder(v, 'asc', 'de-DE'))).toEqual(['3', 'abc']);
    });

    it('Text absteigend: leere Zelle am Ende', () => {
        const v = ['b', '', 'a'];
        expect(pick(v, mod.sortOrder(v, 'desc', 'de-DE'))).toEqual(['b', 'a', '']);
    });

    it('stabil: gleiche Werte behalten ihre Originalreihenfolge (beide Richtungen)', () => {
        const v = ['x', 'a', 'x', 'a', ''];
        expect(mod.sortOrder(v, 'asc', 'de-DE')).toEqual([1, 3, 0, 2, 4]);
        expect(mod.sortOrder(v, 'desc', 'de-DE')).toEqual([0, 2, 1, 3, 4]);
    });
});

describe('view/tables — Filtern (Referenzfaelle)', () => {
    let mod: Tables;
    beforeAll(async () => { mod = await import('../../app/view/tables'); });

    it('case-insensitiver Teilstring, leerer Begriff zeigt alles', () => {
        expect(mod.rowMatches('Alpha 3', 'ALP')).toBe(true);
        expect(mod.rowMatches('Beta 1', 'ALP')).toBe(false);
        expect(mod.rowMatches('Beta 1', '')).toBe(true);
        expect(mod.rowMatches('Beta 1', '   ')).toBe(true);
    });
});

function tableHtml(rows: string[][], header = ['Name', 'Wert']): string {
    return '<table data-line="1"><thead><tr>' + header.map((h) => '<th>' + h + '</th>').join('')
        + '</tr></thead><tbody>'
        + rows.map((r, i) => '<tr data-line="' + (i + 3) + '">'
            + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';
}

const FIVE = [['Alpha', '3'], ['Beta', '1'], ['Gamma', '2'], ['Delta', '5'], ['Epsilon', '4']];
const SIX = FIVE.concat([['', '0']]);

describe('view/tables — T3/T4 im DOM', () => {
    let mod: Tables;
    let body: HTMLElement;

    beforeAll(async () => {
        await seedDeCatalog();
        installDom();
        mod = await import('../../app/view/tables');
        mod.initTables();
    });

    beforeEach(() => {
        mod.closeTableOverlay();
        ({ body } = installDom());
        setFormatLocale('de-DE');
        mod.forgetTableState('/doc.md');
    });

    const names = () => Array.from(body.querySelectorAll('tbody tr'))
        .filter((tr) => !(tr as HTMLElement).hidden)
        .map((tr) => (tr as HTMLTableRowElement).cells[0].textContent);
    const sortBtn = (col: number) =>
        body.querySelectorAll('th > .folio-th-sort')[col] as HTMLButtonElement;

    it('th-Inhalt steckt in einem Button mit aria-label; Zyklus auf → ab → Original', () => {
        body.innerHTML = tableHtml(FIVE);
        mod.prepareTables(body, '/doc.md');
        const th = body.querySelectorAll('th')[1];
        const btn = sortBtn(1);
        expect(btn.type).toBe('button');
        expect(btn.textContent).toBe('Wert');
        expect(btn.getAttribute('aria-label')).toBe('Nach „Wert“ sortieren');

        btn.click();
        expect(names()).toEqual(['Beta', 'Gamma', 'Alpha', 'Epsilon', 'Delta']);
        expect(th.getAttribute('aria-sort')).toBe('ascending');
        expect(body.querySelector('table')!.hasAttribute('data-folio-arranged')).toBe(true);
        btn.click();
        expect(names()).toEqual(['Delta', 'Epsilon', 'Alpha', 'Gamma', 'Beta']);
        expect(th.getAttribute('aria-sort')).toBe('descending');
        btn.click();
        expect(names()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
        expect(th.hasAttribute('aria-sort')).toBe(false);
        expect(body.querySelector('table')!.hasAttribute('data-folio-arranged')).toBe(false);
    });

    it('andere Spalte beginnt aufsteigend, nur eine Spalte traegt aria-sort', () => {
        body.innerHTML = tableHtml(FIVE);
        mod.prepareTables(body, '/doc.md');
        sortBtn(1).click();
        sortBtn(0).click();
        expect(names()).toEqual(['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
        const sorts = Array.from(body.querySelectorAll('th')).map((th) => th.getAttribute('aria-sort'));
        expect(sorts).toEqual(['ascending', null]);
    });

    it('kein Filterfeld bei 5 Datenzeilen, eines bei 6', () => {
        body.innerHTML = tableHtml(FIVE) + tableHtml(SIX);
        mod.prepareTables(body, '/doc.md');
        const bars = body.querySelectorAll('.folio-table-bar');
        expect(bars[0].querySelector('.folio-table-filter')).toBeNull();
        expect(bars[0].querySelector('.folio-table-expand')).not.toBeNull();
        const input = bars[1].querySelector('.folio-table-filter') as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(input.placeholder).toBe('Filtern …');
        expect(input.getAttribute('aria-label')).toBe('Tabellenzeilen filtern');
    });

    it('Filter versteckt Zeilen ohne Treffer, zaehlt, Escape leert', () => {
        body.innerHTML = tableHtml(SIX);
        mod.prepareTables(body, '/doc.md');
        const wrap = body.querySelector('.folio-table') as HTMLElement;
        const input = wrap.querySelector('.folio-table-filter') as HTMLInputElement;
        const count = wrap.querySelector('.folio-table-count') as HTMLElement;
        expect(count.hidden).toBe(true);

        input.value = 'ALP';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(names()).toEqual(['Alpha']);
        expect(count.hidden).toBe(false);
        expect(count.textContent).toBe('1 von 6');
        expect(wrap.classList.contains('folio-table--filtered')).toBe(true);

        const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        input.dispatchEvent(esc);
        expect(esc.defaultPrevented).toBe(true);
        expect(input.value).toBe('');
        expect(names()).toHaveLength(6);
        expect(count.hidden).toBe(true);
        expect(wrap.classList.contains('folio-table--filtered')).toBe(false);
        // Leeres Feld: Escape bleibt frei (Overlay schliessen usw.).
        const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        input.dispatchEvent(esc2);
        expect(esc2.defaultPrevented).toBe(false);
    });

    it('Sortierung und Filter ueberleben einen Re-Render desselben Dokuments', () => {
        body.innerHTML = tableHtml(SIX);
        mod.prepareTables(body, '/doc.md');
        sortBtn(1).click();
        let input = body.querySelector('.folio-table-filter') as HTMLInputElement;
        input.value = 'a';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const before = names();

        body.innerHTML = tableHtml(SIX);
        mod.prepareTables(body, '/doc.md');
        input = body.querySelector('.folio-table-filter') as HTMLInputElement;
        expect(input.value).toBe('a');
        expect(names()).toEqual(before);
        expect(body.querySelectorAll('th')[1].getAttribute('aria-sort')).toBe('ascending');
    });

    it('geaenderte Kopfzeile oder anderes Dokument: Zustand verfaellt still', () => {
        body.innerHTML = tableHtml(FIVE);
        mod.prepareTables(body, '/doc.md');
        sortBtn(1).click();

        body.innerHTML = tableHtml(FIVE);
        mod.prepareTables(body, '/anderes.md');
        expect(names()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);

        body.innerHTML = tableHtml(FIVE, ['Name', 'Betrag']);
        mod.prepareTables(body, '/doc.md');
        expect(names()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
        // Auch die alte Kopfzeile bekommt den Zustand nicht zurueck.
        body.innerHTML = tableHtml(FIVE);
        mod.prepareTables(body, '/doc.md');
        expect(names()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
    });

    it('lange Zellen werden markiert, kurze nicht', () => {
        const long = 'Ein langer Fliesstext in einer Zelle, der umbrechen darf, sobald er breit ist';
        body.innerHTML = tableHtml([['8.169,25 €', long]]);
        mod.prepareTables(body, '/doc.md');
        const cells = body.querySelectorAll('td');
        expect(cells[0].classList.contains('folio-cell-long')).toBe(false);
        expect(cells[1].classList.contains('folio-cell-long')).toBe(true);
    });
});
