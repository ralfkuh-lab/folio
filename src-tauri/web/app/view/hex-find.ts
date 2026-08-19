/* HexFinder: Finder-Surface fuer kind-binary. Sucht serverseitig per
   hex_find und springt die Hex-Ansicht zum Treffer. Wrap-around und
   Pattern-Parse sind lokal; veraltete Antworten (Generation, Kontextwechsel
   oder stale:-Fehler) werden still verworfen, echte Fehler loesen keinen
   automatischen Neuversuch aus.

   Der lokale Token allein reicht dafuer nicht: `mountHexView`/`reloadHexView`
   wechseln Tab bzw. Revision **synchron**, ohne dass der Finder etwas
   aufruft. Deshalb haengt er ueber `setHexContextListener` am Kontext und
   prueft vor jedem Seiteneffekt zusaetzlich, ob der live gelesene Kontext
   noch der der Anfrage ist. */

import {
    clearHexHighlight,
    getHexSearchContext,
    revealHexOffset,
    setHexContextListener,
    type HexSearchContext,
} from './hex';
import {
    formatMatchOffset,
    parseHexSearchPattern,
    planHexSearch,
    type HexPatternMode,
} from './hex-search';

const STALE_PREFIX = 'stale:';

type HexFindState = {
    source: 'hex';
    hex: true;
    term: string;
    total: number;
    active: number;
    scanning?: boolean;
    invalidHex?: boolean;
    matchOffset?: number | null;
    offsetLabel?: string;
};

let patternMode: HexPatternMode = 'text';
let currentTerm = '';
let caseSensitive = false;
let currentMatch: number | null = null;
let searchToken = 0;

function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') {
        return Promise.reject(new Error('invoke unavailable'));
    }
    return core.invoke(cmd, args);
}

function errorText(err: unknown): string {
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
        return (err as { message: string }).message;
    }
    return String(err);
}

function isStaleError(err: unknown): boolean {
    return errorText(err).indexOf(STALE_PREFIX) === 0;
}

function parseHit(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    return n;
}

function dispatchState(partial: Partial<HexFindState>): void {
    const detail: HexFindState = {
        source: 'hex',
        hex: true,
        term: currentTerm,
        total: 0,
        active: -1,
        ...partial,
    };
    try {
        window.dispatchEvent(new CustomEvent('folio-find-state', { detail }));
    } catch {
        /* ignore */
    }
}

function dispatchEmpty(): void {
    currentMatch = null;
    clearHexHighlight();
    dispatchState({ total: 0, active: -1, matchOffset: null });
}

function dispatchInvalid(): void {
    currentMatch = null;
    clearHexHighlight();
    dispatchState({ total: 0, active: -1, invalidHex: true, matchOffset: null });
}

function dispatchNoMatch(): void {
    currentMatch = null;
    clearHexHighlight();
    dispatchState({ scanning: false, total: 0, active: -1, matchOffset: null });
}

function applyHit(offset: number, length: number): void {
    currentMatch = offset;
    revealHexOffset(offset, length);
    dispatchState({
        scanning: false,
        total: 1,
        active: 0,
        matchOffset: offset,
        offsetLabel: formatMatchOffset(offset),
    });
}

function hexFind(args: {
    tabId: number;
    revision: number;
    pattern: number[];
    from: number;
    backwards: boolean;
    caseInsensitive: boolean;
}): Promise<unknown> {
    return invoke('hex_find', args);
}

function sameContext(a: HexSearchContext, b: HexSearchContext | null): boolean {
    return !!b
        && b.tabId === a.tabId
        && b.revision === a.revision
        && b.path === a.path;
}

/** Token UND Kontext: erst beides zusammen macht eine Antwort anwendbar. */
function stillCurrent(token: number, ctx: HexSearchContext): boolean {
    return token === searchToken && sameContext(ctx, getHexSearchContext());
}

function researchFrom(backwards: boolean, fromCurrent: boolean): void {
    const token = ++searchToken;
    const term = currentTerm;
    if (!term) {
        dispatchEmpty();
        return;
    }
    const parsed = parseHexSearchPattern(term, patternMode);
    if (parsed.ok === false) {
        if (parsed.reason === 'empty') {
            dispatchEmpty();
            return;
        }
        dispatchInvalid();
        return;
    }
    const pattern = parsed.bytes;

    const ctx = getHexSearchContext();
    if (!ctx || ctx.fileSize <= 0) {
        dispatchNoMatch();
        return;
    }
    const tabId = ctx.tabId;
    const revision = ctx.revision;

    const plan = planHexSearch({
        current: fromCurrent ? currentMatch : null,
        backwards,
        fileSize: ctx.fileSize,
    });
    const caseInsensitive = patternMode === 'text' && !caseSensitive;

    dispatchState({ scanning: true, total: 0, active: -1, matchOffset: null });

    function run(from: number, allowWrap: boolean): void {
        hexFind({
            tabId,
            revision,
            pattern,
            from,
            backwards,
            caseInsensitive,
        }).then(function (raw) {
            if (!stillCurrent(token, ctx)) return;
            const hit = parseHit(raw);
            if (hit !== null) {
                applyHit(hit, pattern.length);
                return;
            }
            if (!allowWrap || plan.wrapFrom === null) {
                dispatchNoMatch();
                return;
            }
            run(plan.wrapFrom, false);
        }).catch(function (err) {
            if (!stillCurrent(token, ctx)) return;
            // `stale:` heisst: der Lauf wurde abgeloest — still verwerfen.
            // Ein Zaehlerzustand hier erschiene ohne bisherigen Treffer als
            // sichtbares „Kein Treffer"; das Beenden des scanning-Zustands
            // uebernimmt der Lauf bzw. der Kontext, der abgeloest hat.
            if (isStaleError(err)) return;
            dispatchNoMatch();
        });
    }

    run(plan.from, plan.wrapFrom !== null);
}

/**
 * Der Hex-Kontext hat gewechselt (Tab, Revision, Pfad, Groesse oder
 * Verfuegbarkeit). Laufende Antworten sind damit ungueltig; die Markierung
 * hat die Ansicht selbst schon geraeumt. Mit einem Suchbegriff startet die
 * Suche sofort neu, sodass Treffer, Zaehler und Markierung zum neuen
 * Dokument passen — ohne Begriff (Find-Bar zu) bleibt alles still.
 */
function onHexContextChanged(ctx: HexSearchContext | null): void {
    searchToken += 1;
    currentMatch = null;
    if (!currentTerm) return;
    if (!ctx || ctx.fileSize <= 0) {
        dispatchEmpty();
        return;
    }
    researchFrom(false, false);
}

setHexContextListener(onHexContextChanged);

export function getHexPatternMode(): HexPatternMode {
    return patternMode;
}

export function setHexPatternMode(mode: HexPatternMode): void {
    if (mode !== 'text' && mode !== 'hex') return;
    if (patternMode === mode) return;
    patternMode = mode;
    currentMatch = null;
    if (currentTerm) researchFrom(false, false);
}

export const HexFinder: Finder = {
    openFind: function (seed?: string): void {
        if (typeof seed === 'string' && seed.length > 0) currentTerm = seed;
        currentMatch = null;
        researchFrom(false, false);
    },
    closeFind: function (): void {
        searchToken += 1;
        currentTerm = '';
        currentMatch = null;
        clearHexHighlight();
        dispatchEmpty();
    },
    setFindTerm: function (term: string): void {
        currentTerm = term || '';
        currentMatch = null;
        researchFrom(false, false);
    },
    setFindOptions: function (opts: ResolvedFindOptions): void {
        caseSensitive = !!opts.caseSensitive;
        currentMatch = null;
        if (currentTerm) researchFrom(false, false);
    },
    findNext: function (): void {
        researchFrom(false, true);
    },
    findPrev: function (): void {
        researchFrom(true, true);
    },
};

/** Nur Tests: Sitzungszustand zuruecksetzen. */
export function resetHexFinderForTests(): void {
    searchToken += 1;
    patternMode = 'text';
    currentTerm = '';
    caseSensitive = false;
    currentMatch = null;
}
