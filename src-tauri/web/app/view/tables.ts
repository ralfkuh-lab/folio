// Tabellen in der Markdown-View (Spec docs/spec-tables.md, T2–T4):
// breite Tabellen brechen aus der Textspalte aus und scrollen in ihrem
// eigenen Rahmen, ein Button oeffnet sie in einem grossen Overlay; Klick
// auf eine Spaltenueberschrift sortiert, ein Feld ueber der Tabelle filtert.
//
// Nur App-View: Export, Export-Vorschau und Theme-Editor bekommen das
// unveraenderte Backend-HTML (gleiche Begruendung wie bei den
// Task-Checkboxen). prepareTables() laeuft an denselben drei Post-Render-
// Stellen wie addCodeCopyButtons() und ist idempotent; Klicks und Eingaben
// laufen ueber delegierte Listener (initTables, einmal beim Boot).
// Sortieren und Filtern aendern nur die Anzeige — kein Dirty, kein Undo.
//
// Markup pro Tabelle:
//   div.folio-table                 Hover-/Fokus-Flaeche, traegt die Klassen
//     div.folio-table-bar           Leiste ueber der Tabelle (Filter, Vergroessern)
//     div.folio-table-scroll        scrollt waagerecht, wenn noetig
//       table                       th-Inhalt steckt in button.folio-th-sort
// Zwei Ebenen, weil die Leiste nicht mitscrollen darf.

import { folioLog } from '../util/log';
import { t } from '../i18n/translate';
import { getFormatLocale } from '../i18n/format';
import { invalidateLineElements } from './scroll-sync';
import { ViewFinder } from './markdown';

const WRAP_CLASS = 'folio-table';
const BAR_CLASS = 'folio-table-bar';
const SCROLL_CLASS = 'folio-table-scroll';
const EXPAND_CLASS = 'folio-table-expand';
const SORT_CLASS = 'folio-th-sort';
const SORT_ICON_CLASS = 'folio-th-sort--icon';
const FILTER_CLASS = 'folio-table-filter';
const COUNT_CLASS = 'folio-table-count';
// Tabelle passt nicht in ihre Spalte: Rahmen scrollt (Klasse auch bei
// verschachtelten Tabellen, die nicht ausbrechen koennen).
const SCROLLING = 'folio-table--scroll';
// Oberste Ebene und zu breit: bricht auf die View-Breite aus.
const WIDE = 'folio-table--wide';
// Filter aktiv: Leiste bleibt sichtbar.
const FILTERED = 'folio-table--filtered';
// Tabelle mit Filterfeld: die Leiste hat einen festen Platz ueber der
// Tabelle (im Fluss), statt im Abstand davor zu schweben — sonst laege das
// aktive Feld dauerhaft ueber der letzten Zeile des Absatzes davor.
const WITH_BAR = 'folio-table--bar';
// Am <table>, sobald Sortierung oder Filter die Zeilenfolge veraendern —
// Scroll-Sync nimmt dann nur noch die Tabelle selbst als Ankerpunkt.
const ARRANGED_ATTR = 'data-folio-arranged';
const ROW_ATTR = 'data-folio-row';
// Lange Zellen duerfen im Scroll-Zustand umbrechen (Breite per CSS), alle
// anderen nicht. Grenze in Zeichen: ~0,5em pro Zeichen ergibt etwa die
// CSS-Breite von 24em — kuerzere Zellen wuerden durch sie nur breiter.
const LONG_CELL_CLASS = 'folio-cell-long';
const LONG_CELL_CHARS = 48;
// Unter 6 Datenzeilen gibt es kein Filterfeld (Sortieren reicht da).
const FILTER_MIN_ROWS = 6;

const EXPAND_SVG =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<polyline points="9.5 2.5 13.5 2.5 13.5 6.5"/><line x1="13.5" y1="2.5" x2="9" y2="7"/>'
    + '<polyline points="6.5 13.5 2.5 13.5 2.5 9.5"/><line x1="2.5" y1="13.5" x2="7" y2="9"/>'
    + '</svg>';

function viewBody(): HTMLElement | null {
    return document.querySelector('#view-region main.markdown-body') as HTMLElement | null;
}

// ----- Zahlen und Vergleich (rein, vitest-getestet) ----------------------

export type SortDir = 'asc' | 'desc';

// Rand: Vorzeichen, Waehrungszeichen davor; Prozent/Promille/Grad,
// Waehrungszeichen oder eine kurze Einheit (h, kg, MB) dahinter. Woerter
// davor zaehlen nicht — sonst waere „Datei 10" eine Zahl.
const NUMBER_RE = /^([+\-\u2212]?)\s*(\p{Sc}?)\s*([+\-\u2212]?)\s*(\d(?:[\d.,'\u2019 ]*\d)?)\s*([%\u2030\u00b0]|\p{Sc}|\p{L}{1,3}\.?)?$/u;
const SPACE_RE = /[\u00a0\u202f\u2009]/g;

/** Dezimaltrenner der Format-Locale ('.' oder ','). */
export function decimalSeparator(locale: string): string {
    try {
        const part = new Intl.NumberFormat(locale).formatToParts(1.5)
            .find((p) => p.type === 'decimal');
        return part && part.value === ',' ? ',' : '.';
    } catch {
        return '.';
    }
}

// Ganzzahlteil: nur Ziffern oder sauber in Dreiergruppen mit EINEM
// Trennzeichen aus `groups` (1.234.567, 1 234 567, 1'234).
function validInteger(text: string, groups: string): boolean {
    if (/^\d+$/.test(text)) return true;
    const sep = text.replace(/\d/g, '')[0];
    if (!sep || groups.indexOf(sep) < 0) return false;
    const parts = text.split(sep);
    return /^\d{1,3}$/.test(parts[0]) && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

/**
 * Liest eine Zellen-Zahl nach der Format-Locale (Dezimaltrenner `decimal`).
 * Bei Komma-Locales gilt der Punkt als Tausendertrenner, wenn er genau
 * Dreiergruppen bildet, sonst als Dezimaltrenner („3.14"). Kein Treffer: null.
 */
export function parseCellNumber(raw: string, decimal: string): number | null {
    const q = parseCellQuantity(raw, decimal);
    return q ? q.value : null;
}

/** Wie parseCellNumber, liefert zusaetzlich die Einheit (Waehrung davor
 *  bzw. Zeichen/Einheit dahinter) — numerisch sortiert wird nur eine Spalte
 *  mit EINER Einheit, sonst stuende „3 Mio." vor „500". */
export function parseCellQuantity(raw: string, decimal: string): { value: number; unit: string } | null {
    const m = NUMBER_RE.exec(raw.replace(SPACE_RE, ' ').trim());
    if (!m || (m[1] && m[3])) return null;
    const sign = m[1] || m[3];
    const body = m[4];
    const unit = (m[2] || '') + '|' + (m[5] || '');
    const groups = (decimal === ',' ? '.' : ',') + " '\u2019";
    let intPart = body;
    let frac = '';
    const di = body.lastIndexOf(decimal);
    if (di >= 0) {
        intPart = body.slice(0, di);
        frac = body.slice(di + 1);
        if (!/^\d+$/.test(frac)) return null;
    } else if (decimal === ',' && body.indexOf('.') >= 0 && !validInteger(body, groups)) {
        const parts = body.split('.');
        if (parts.length !== 2) return null;
        intPart = parts[0];
        frac = parts[1];
    }
    if (!validInteger(intPart, groups)) return null;
    const value = Number(intPart.replace(/\D/g, '') + (frac ? '.' + frac : ''));
    if (!isFinite(value)) return null;
    return { value: sign === '-' || sign === '\u2212' ? -value : value, unit };
}

/**
 * Reihenfolge (Indizes in `values`) fuer eine Sortierung. Numerisch, wenn
 * jede nicht leere Zelle eine Zahl mit derselben Einheit (oder keiner) ist,
 * sonst Collator mit `numeric`.
 * Leere Zellen immer ans Ende, in Originalreihenfolge; stabil.
 */
export function sortOrder(values: string[], dir: SortDir, locale: string): number[] {
    const filled: number[] = [];
    const empty: number[] = [];
    values.forEach((v, i) => { (v.trim() === '' ? empty : filled).push(i); });
    const quantities = columnQuantities(filled.map((i) => values[i]), locale);
    const numeric = quantities !== null;
    const nums = quantities || [];
    let collator: Intl.Collator;
    try {
        collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    } catch {
        collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    }
    const num = new Map<number, number>();
    filled.forEach((i, k) => num.set(i, nums[k]));
    const sign = dir === 'asc' ? 1 : -1;
    filled.sort((a, b) => {
        const c = numeric
            ? (num.get(a) as number) - (num.get(b) as number)
            : collator.compare(values[a].trim(), values[b].trim());
        return c * sign || a - b;
    });
    return filled.concat(empty);
}

// Werte einer Spalte (nur nicht leere Zellen) als Zahlen — oder null, wenn
// eine Zelle keine Zahl ist oder die Einheiten verschieden sind.
function columnQuantities(filled: string[], locale: string): number[] | null {
    const decimal = decimalSeparator(locale);
    const quantities = filled.map((v) => parseCellQuantity(v, decimal));
    const first = quantities[0];
    if (!first || !quantities.every((q) => q !== null && q.unit === first.unit)) return null;
    return quantities.map((q) => (q as { value: number }).value);
}

/** Wird diese Spalte numerisch sortiert? (leere Zellen zaehlen nicht) */
export function isNumericColumn(values: string[], locale: string): boolean {
    return columnQuantities(values.filter((v) => v.trim() !== ''), locale) !== null;
}

/** Case-insensitive Teilstring ueber den ganzen Zeilentext. */
export function rowMatches(rowText: string, term: string): boolean {
    const needle = term.trim().toLowerCase();
    return needle === '' || rowText.toLowerCase().indexOf(needle) >= 0;
}

// ----- Zustand pro Dokument ---------------------------------------------

type TableState = { sortCol: number; sortDir: SortDir | null; filter: string };

// Pfad → (Tabellen-Schluessel → Zustand). Nur im Speicher.
const docStates = new Map<string, Map<string, TableState>>();
let renderedPath = '';

function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
    const head = table.tHead && table.tHead.rows[0];
    return head ? Array.prototype.slice.call(head.cells) : [];
}

function bodyRows(table: HTMLTableElement): HTMLTableRowElement[] {
    const tbody = table.tBodies[0];
    return tbody ? Array.prototype.slice.call(tbody.rows) : [];
}

/** Laufende Nummer + Kopfzeilen-Texte: aendert sich eines, verfaellt der
 *  Zustand still (lieber original als falsch zugeordnet). */
function tableKey(index: number, table: HTMLTableElement): string {
    return index + '\u0001' + headerCells(table).map((th) => (th.textContent || '').trim()).join('\u0002');
}

function stateFor(wrap: HTMLElement): TableState | null {
    const key = wrap.getAttribute('data-folio-table-key');
    if (key === null) return null;
    let states = docStates.get(renderedPath);
    if (!states) {
        states = new Map();
        docStates.set(renderedPath, states);
    }
    let state = states.get(key);
    if (!state) {
        state = { sortCol: -1, sortDir: null, filter: '' };
        states.set(key, state);
    }
    return state;
}

/** Zustand eines Dokuments verwerfen (Tab/Dokument geschlossen). */
export function forgetTableState(path: string | null | undefined): void {
    if (path) docStates.delete(path);
}

// ----- Anwenden ----------------------------------------------------------

function wrapTable(wrap: HTMLElement): HTMLTableElement | null {
    return wrap.querySelector(':scope > .' + SCROLL_CLASS + ' > table') as HTMLTableElement | null;
}

function applySort(table: HTMLTableElement, state: TableState): void {
    const tbody = table.tBodies[0];
    if (!tbody) return;
    const rows = bodyRows(table);
    let order: number[];
    if (state.sortDir && state.sortCol >= 0) {
        const values = rows.map((row) => {
            const cell = row.cells[state.sortCol];
            return cell ? cell.textContent || '' : '';
        });
        order = sortOrder(values, state.sortDir, getFormatLocale());
    } else {
        order = rows.map((_, i) => i)
            .sort((a, b) => Number(rows[a].getAttribute(ROW_ATTR)) - Number(rows[b].getAttribute(ROW_ATTR)));
    }
    // Nur umhaengen, wenn sich die Reihenfolge aendert: jedes Verschieben
    // laesst die Ranges einer laufenden Suche kollabieren.
    if (order.some((i, k) => i !== k)) {
        const fragment = document.createDocumentFragment();
        order.forEach((i) => fragment.appendChild(rows[i]));
        tbody.appendChild(fragment);
    }
    headerCells(table).forEach((th, col) => {
        if (state.sortDir && col === state.sortCol) {
            th.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
        } else {
            th.removeAttribute('aria-sort');
        }
    });
}

function applyFilter(wrap: HTMLElement, table: HTMLTableElement, state: TableState): void {
    const rows = bodyRows(table);
    let shown = 0;
    rows.forEach((row) => {
        const match = rowMatches(row.textContent || '', state.filter);
        row.hidden = !match;
        if (match) shown++;
    });
    const active = state.filter.trim() !== '';
    wrap.classList.toggle(FILTERED, active);
    const count = wrap.querySelector(':scope > .' + BAR_CLASS + ' > .' + COUNT_CLASS) as HTMLElement | null;
    if (count) {
        count.textContent = active ? t('view.table.filter.count', { shown, total: rows.length }) : '';
        count.hidden = !active;
    }
}

function applyState(wrap: HTMLElement, state: TableState): void {
    const table = wrapTable(wrap);
    if (!table) return;
    applySort(table, state);
    applyFilter(wrap, table, state);
    const arranged = !!state.sortDir || state.filter.trim() !== '';
    if (arranged) table.setAttribute(ARRANGED_ATTR, '');
    else table.removeAttribute(ARRANGED_ATTR);
    invalidateLineElements();
}

// ----- Vorbereiten -------------------------------------------------------

// Interaktives im th (Link, Wikilink, Checkbox): nicht in den Button
// stecken — <button><a> ist ungueltig, der Klick waere Navigation UND
// Sortierung, und Screenreader saehen den Link nicht.
const INTERACTIVE = 'a[href], button, input, select, textarea, [tabindex]';

function addSortButtons(table: HTMLTableElement): void {
    headerCells(table).forEach((th) => {
        if (th.querySelector(':scope > .' + SORT_CLASS)) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = SORT_CLASS;
        btn.setAttribute('aria-label', t('view.table.sort.ariaLabel', {
            column: (th.textContent || '').trim(),
        }));
        if (th.querySelector(INTERACTIVE)) {
            // Inhalt bleibt, wie er ist; daneben ein eigener Pfeil-Button.
            btn.classList.add(SORT_ICON_CLASS);
            th.appendChild(btn);
            return;
        }
        while (th.firstChild) btn.appendChild(th.firstChild);
        th.appendChild(btn);
    });
}

function buildBar(rowCount: number): HTMLElement {
    const bar = document.createElement('div');
    bar.className = BAR_CLASS;
    if (rowCount >= FILTER_MIN_ROWS) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = FILTER_CLASS;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.placeholder = t('view.table.filter.placeholder');
        input.setAttribute('aria-label', t('view.table.filter.ariaLabel'));
        bar.appendChild(input);
        const count = document.createElement('span');
        count.className = COUNT_CLASS;
        count.setAttribute('aria-live', 'polite');
        count.hidden = true;
        bar.appendChild(count);
    }
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = EXPAND_CLASS;
    expand.title = t('view.table.expand.tooltip');
    expand.setAttribute('aria-label', t('view.table.expand.ariaLabel'));
    expand.innerHTML = EXPAND_SVG;
    bar.appendChild(expand);
    return bar;
}

/**
 * Legt um jede Tabelle unterhalb von `root` Wrapper und Leiste an und
 * wendet den gemerkten Sortier-/Filterzustand des Dokuments `path` an.
 * Idempotent: bereits umschlossene Tabellen werden uebersprungen.
 */
export function prepareTables(root: HTMLElement | null, path?: string | null): void {
    if (!root) return;
    renderedPath = path || '';
    const tables = root.querySelectorAll('table');
    const seen = new Set<string>();
    let added = 0;
    tables.forEach((table, index) => {
        if (table.parentElement && table.parentElement.classList.contains(SCROLL_CLASS)) {
            const known = table.closest('.' + WRAP_CLASS);
            const knownKey = known && known.getAttribute('data-folio-table-key');
            if (knownKey !== null && knownKey !== undefined) seen.add(knownKey);
            return;
        }
        const rows = bodyRows(table);
        rows.forEach((row, i) => row.setAttribute(ROW_ATTR, String(i)));
        table.querySelectorAll('th, td').forEach((cell) => {
            if ((cell.textContent || '').trim().length > LONG_CELL_CHARS) {
                cell.classList.add(LONG_CELL_CLASS);
            }
        });
        const key = tableKey(index, table);
        seen.add(key);
        const wrap = document.createElement('div');
        wrap.className = WRAP_CLASS;
        wrap.setAttribute('data-folio-table-key', key);
        const scroll = document.createElement('div');
        scroll.className = SCROLL_CLASS;
        table.replaceWith(wrap);
        scroll.appendChild(table);
        wrap.appendChild(buildBar(rows.length));
        wrap.appendChild(scroll);
        if (rows.length >= FILTER_MIN_ROWS) wrap.classList.add(WITH_BAR);
        if (rows.length > 0) addSortButtons(table);
        const states = docStates.get(renderedPath);
        const state = states && states.get(key);
        if (state && (state.sortDir || state.filter)) {
            const input = wrap.querySelector('.' + FILTER_CLASS) as HTMLInputElement | null;
            if (!input) state.filter = '';
            else input.value = state.filter;
            applyState(wrap, state);
        }
        added++;
    });
    // Zustaende ohne passende Tabelle (Kopfzeile geaendert, Tabelle davor
    // eingefuegt, alle Tabellen weg) verfallen, statt spaeter falsch
    // zugeordnet zu werden — auch bei einem Render ganz ohne Tabellen.
    const states = docStates.get(renderedPath);
    if (states) states.forEach((_, key) => { if (!seen.has(key)) states.delete(key); });
    if (added > 0) {
        folioLog.debug('view', 'tables prepared', { added });
        scheduleTableMeasure();
    }
}

// ----- Breite messen ----------------------------------------------------

let measureQueued = false;

/** Breite aller View-Tabellen im naechsten Frame neu bestimmen. */
export function scheduleTableMeasure(): void {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(function () {
        measureQueued = false;
        measureTables();
    });
}

/**
 * Bestimmt pro Tabelle, ob sie in ihre Spalte passt. Gemessen wird im
 * Theme-Zustand (Klassen kurz entfernt), sonst haelt eine Tabelle mit
 * `width: 100%` sich im breiten Rahmen selbst fuer breit. Alles in einem
 * Task: erst schreiben, dann lesen, dann schreiben — kein Zwischenbild.
 *
 * Solange der Rahmen kein Scroll-Container ist und keine Leiste im Fluss
 * hat, fallen die Theme-Margins der Tabelle durch ihn hindurch wie vorher.
 * Ein Scroll-Container haelt sie dagegen fest (eigener Formatierungskontext,
 * Abstaende addierten sich), eine Leiste davor trennte sie vom Absatz —
 * deshalb wandern sie in beiden Faellen auf den aeusseren Wrapper.
 */
export function measureTables(): void {
    const body = viewBody();
    if (!body) return;
    const wraps = Array.prototype.slice.call(
        body.querySelectorAll('.' + WRAP_CLASS),
    ) as HTMLElement[];
    if (wraps.length === 0) return;
    const content = document.getElementById('view-content');
    const viewTop = content ? content.scrollTop : 0;
    const scrollLefts = wraps.map((wrap) => {
        const scroll = wrap.querySelector(':scope > .' + SCROLL_CLASS) as HTMLElement | null;
        return scroll ? scroll.scrollLeft : 0;
    });

    const withBar = wraps.map((wrap) => wrap.classList.contains(WITH_BAR));
    wraps.forEach((wrap) => {
        wrap.classList.remove(WIDE, SCROLLING, WITH_BAR);
        wrap.style.marginTop = '';
        wrap.style.marginBottom = '';
    });
    const results = wraps.map((wrap) => {
        const scroll = wrap.querySelector(':scope > .' + SCROLL_CLASS) as HTMLElement | null;
        const table = scroll && scroll.querySelector(':scope > table') as HTMLElement | null;
        if (!scroll || !table || scroll.clientWidth === 0) return null;
        const cs = getComputedStyle(table);
        return {
            overflow: scroll.scrollWidth > scroll.clientWidth + 1,
            topLevel: wrap.parentElement === body,
            marginTop: cs.marginTop,
            marginBottom: cs.marginBottom,
        };
    });
    let wide = 0;
    wraps.forEach((wrap, i) => {
        const r = results[i];
        if (withBar[i]) wrap.classList.add(WITH_BAR);
        if (!r) return;
        if (r.overflow) {
            wrap.classList.add(SCROLLING);
            if (r.topLevel) {
                wrap.classList.add(WIDE);
                wide++;
            }
        }
        if (r.overflow || withBar[i]) {
            wrap.style.marginTop = r.marginTop;
            wrap.style.marginBottom = r.marginBottom;
        }
    });
    wraps.forEach((wrap, i) => {
        const scroll = wrap.querySelector(':scope > .' + SCROLL_CLASS) as HTMLElement | null;
        if (scroll && scrollLefts[i]) scroll.scrollLeft = scrollLefts[i];
    });
    if (content) content.scrollTop = viewTop;
    folioLog.debug('view', 'tables measured', { tables: wraps.length, wide });
}

// ----- Overlay ----------------------------------------------------------

type OverlayState = {
    wrap: HTMLElement;
    placeholder: HTMLElement;
    button: HTMLElement;
};

let overlay: OverlayState | null = null;

function overlayDialog(): HTMLDialogElement | null {
    return document.getElementById('table-overlay') as HTMLDialogElement | null;
}

function openOverlay(wrap: HTMLElement, button: HTMLElement): void {
    const dialog = overlayDialog();
    const host = document.getElementById('table-overlay-body');
    if (!dialog || !host || typeof dialog.showModal !== 'function') return;
    if (overlay) closeOverlay(false);
    // Fokus auf den Button, solange er noch in der View steht: dann gibt
    // auch die native Fokus-Rueckgabe des Dialogs (Escape) ihn zurueck.
    button.focus({ preventScroll: true });
    // Platzhalter mit gleicher Hoehe: die View darunter springt nicht.
    // Margins wie der Rahmen sie gerade wirksam hat: im Scroll-Zustand am
    // Wrapper, sonst fallen die der Tabelle durch ihn hindurch.
    const placeholder = document.createElement('div');
    placeholder.className = 'folio-table-placeholder';
    const table = wrap.querySelector('table');
    const onWrap = wrap.classList.contains(SCROLLING) || wrap.classList.contains(WITH_BAR);
    const cs = getComputedStyle(onWrap || !table ? wrap : table);
    placeholder.style.height = wrap.offsetHeight + 'px';
    placeholder.style.marginTop = cs.marginTop;
    placeholder.style.marginBottom = cs.marginBottom;
    wrap.replaceWith(placeholder);
    host.appendChild(wrap);
    overlay = { wrap, placeholder, button };
    dialog.showModal();
    // Fokus in den Scrollbereich: Pfeiltasten/Bild-auf/-ab scrollen sofort.
    const scroll = wrap.querySelector(':scope > .' + SCROLL_CLASS) as HTMLElement | null;
    if (scroll) {
        scroll.tabIndex = -1;
        scroll.focus({ preventScroll: true });
    }
    folioLog.debug('view', 'table overlay opened');
}

function closeOverlay(restoreFocus: boolean): void {
    const state = overlay;
    if (!state) return;
    overlay = null;
    const dialog = overlayDialog();
    if (dialog && dialog.open) dialog.close();
    const scroll = state.wrap.querySelector(':scope > .' + SCROLL_CLASS) as HTMLElement | null;
    if (scroll) scroll.removeAttribute('tabindex');
    if (state.placeholder.isConnected) {
        state.placeholder.replaceWith(state.wrap);
        scheduleTableMeasure();
    } else {
        // Platzhalter ist mit einem Re-Render verschwunden: die Tabelle
        // im Overlay ist veraltet und wird verworfen.
        state.wrap.remove();
    }
    if (restoreFocus && state.button.isConnected) {
        // WebKit haelt die Seite bis zur naechsten Style-Berechnung fuer
        // inert (modaler Dialog) — focus() liefe sonst ins Leere und der
        // Fokus landete auf <body>. Lesen von offsetWidth erzwingt sie.
        void state.button.offsetWidth;
        state.button.focus({ preventScroll: true });
    }
    folioLog.debug('view', 'table overlay closed', { restoreFocus });
}

/**
 * Schliesst ein offenes Overlay ohne Fokus-Rueckgabe. Muss VOR jedem
 * Ersetzen von `.markdown-body.innerHTML` laufen — sonst hielte der Dialog
 * eine Tabelle, deren Platzhalter es nicht mehr gibt.
 */
export function closeTableOverlay(): void {
    closeOverlay(false);
}

// ----- Boot -------------------------------------------------------------

// Nur Tabellen der App-View (View-Body oder Overlay) — nie fremdes Markup.
function ownWrap(el: Element): HTMLElement | null {
    const wrap = el.closest('.' + WRAP_CLASS) as HTMLElement | null;
    if (!wrap) return null;
    return wrap.closest('#view-region .markdown-body, #table-overlay') ? wrap : null;
}

// Aufsteigend → absteigend → Original; eine andere Spalte beginnt aufsteigend.
function onSortClick(btn: HTMLElement): void {
    const wrap = ownWrap(btn);
    const th = btn.closest('th') as HTMLTableCellElement | null;
    if (!wrap || !th) return;
    const state = stateFor(wrap);
    if (!state) return;
    const col = th.cellIndex;
    if (state.sortCol !== col || !state.sortDir) {
        state.sortCol = col;
        state.sortDir = 'asc';
    } else if (state.sortDir === 'asc') {
        state.sortDir = 'desc';
    } else {
        state.sortCol = -1;
        state.sortDir = null;
    }
    applyState(wrap, state);
    ViewFinder.refresh();
    folioLog.debug('view', 'table sorted', { col, dir: state.sortDir });
}

function onInput(e: Event): void {
    const input = e.target as HTMLInputElement | null;
    if (!input || !input.classList || !input.classList.contains(FILTER_CLASS)) return;
    const wrap = ownWrap(input);
    const state = wrap && stateFor(wrap);
    if (!wrap || !state) return;
    state.filter = input.value;
    applyState(wrap, state);
    // Versteckte Zeilen zaehlen in der Find-Bar nicht (buildWalker).
    ViewFinder.refresh();
}

// Escape im Filterfeld leert es — und schliesst dabei NICHT das Overlay.
// Ein leeres Feld laesst Escape durch (Overlay zu, Find-Bar usw.).
function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    const input = e.target as HTMLInputElement | null;
    if (!input || !input.classList || !input.classList.contains(FILTER_CLASS)) return;
    if (input.value === '') return;
    e.preventDefault();
    e.stopPropagation();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const sort = target.closest('.' + SORT_CLASS) as HTMLElement | null;
    if (sort) {
        e.preventDefault();
        onSortClick(sort);
        return;
    }
    const dialog = overlayDialog();
    if (dialog && target === dialog) {
        // Klick auf den Hintergrund (::backdrop gehoert zum Dialog-Element).
        closeOverlay(true);
        return;
    }
    if (target.closest('#table-overlay-close')) {
        closeOverlay(true);
        return;
    }
    const expand = target.closest('.' + EXPAND_CLASS) as HTMLElement | null;
    if (expand) {
        const wrap = expand.closest('.' + WRAP_CLASS) as HTMLElement | null;
        if (wrap && !wrap.closest('#table-overlay')) {
            e.preventDefault();
            openOverlay(wrap, expand);
        }
    }
}

let initialized = false;

/** Einmal beim Boot: delegierte Listener und Breiten-Beobachtung. */
export function initTables(): void {
    if (initialized) return;
    initialized = true;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('keydown', onKeydown);
    // Zustaende geschlossener Tabs verwerfen (auch Ersetzen-Oeffnen im Tab).
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && typeof ev.listen === 'function') {
        ev.listen('tabs:changed', function (event: any) {
            const tabs = (event && event.payload && event.payload.tabs) || [];
            const open = new Set<string>();
            tabs.forEach((tab: any) => { if (tab && typeof tab.path === 'string') open.add(tab.path); });
            docStates.forEach((_, path) => { if (!open.has(path)) docStates.delete(path); });
        });
    }
    // Escape (natives cancel → close) und jedes andere Schliessen. `close`
    // bubbelt nicht, erreicht document aber in der Capture-Phase.
    document.addEventListener('close', function (e: Event) {
        if (e.target === overlayDialog()) closeOverlay(true);
    }, true);
    if (typeof ResizeObserver === 'undefined') return;
    // Neu messen, wenn sich die Breite der View (Rails, Splitter) oder der
    // Textspalte (Theme, „volle Breite") aendert. Hoehenaenderungen —
    // jeder Re-Render, Bilder, Mermaid — zaehlen nicht.
    const widths = new WeakMap<Element, number>();
    const observer = new ResizeObserver(function (entries) {
        let changed = false;
        entries.forEach((entry) => {
            const width = Math.round(entry.contentRect.width);
            if (widths.get(entry.target) !== width) {
                widths.set(entry.target, width);
                changed = true;
            }
        });
        if (changed) scheduleTableMeasure();
    });
    const content = document.getElementById('view-content');
    const body = viewBody();
    if (content) observer.observe(content);
    if (body) observer.observe(body);
}
