// Tests fuer view/hex-find.ts — Zaehlerzustaende, Wrap-around, Stale-Guards.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const revealHexOffset = vi.fn();
const clearHexHighlight = vi.fn();
const getHexSearchContext = vi.fn();
const setHexContextListener = vi.fn();
const pullHexRevisionAfterStale = vi.fn(() => Promise.resolve('changed'));

vi.mock('../../app/view/hex', () => ({
    revealHexOffset,
    clearHexHighlight,
    getHexSearchContext,
    setHexContextListener,
    pullHexRevisionAfterStale,
}));

type HexCtx = { tabId: number; revision: number; fileSize: number; path: string };

const CTX: HexCtx = { tabId: 1, revision: 3, fileSize: 32, path: '/tmp/a.bin' };

/** Der zuletzt registrierte Kontext-Beobachter — der Finder-Instanz dieses Tests. */
function contextListener(): (ctx: HexCtx | null) => void {
    const calls = setHexContextListener.mock.calls;
    return calls[calls.length - 1][0] as (ctx: HexCtx | null) => void;
}

/** Wechselt den Kontext so, wie mountHexView/reloadHexView es tun: erst der
    neue Live-Zustand, dann synchron das Signal an den Finder. */
function switchContext(next: HexCtx | null): void {
    getHexSearchContext.mockReturnValue(next);
    contextListener()(next);
}

function foldAscii(byte: number): number {
    return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

/**
 * Backend-Attrappe mit dem echten `hex_find`-Vertrag: vorwaerts ist `from`
 * die inklusive Untergrenze, rueckwaerts die **exklusive** Obergrenze.
 */
function fakeHexFind(data: number[]) {
    return (cmd: string, args?: Record<string, unknown>) => {
        if (cmd !== 'hex_find') return Promise.resolve(undefined);
        const pattern = (args?.pattern as number[]) || [];
        const from = Number(args?.from);
        const backwards = !!args?.backwards;
        const insensitive = !!args?.caseInsensitive;
        const starts: number[] = [];
        for (let i = 0; pattern.length > 0 && i + pattern.length <= data.length; i += 1) {
            let hit = true;
            for (let j = 0; j < pattern.length; j += 1) {
                const left = insensitive ? foldAscii(data[i + j]) : data[i + j];
                const right = insensitive ? foldAscii(pattern[j]) : pattern[j];
                if (left !== right) { hit = false; break; }
            }
            if (hit) starts.push(i);
        }
        if (backwards) {
            const below = starts.filter((start) => start < from);
            return Promise.resolve(below.length ? below[below.length - 1] : null);
        }
        const forward = starts.filter((start) => start >= from);
        return Promise.resolve(forward.length ? forward[0] : null);
    };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

type FindState = {
    hex?: boolean;
    term?: string;
    scanning?: boolean;
    invalidHex?: boolean;
    matchOffset?: number | null;
    offsetLabel?: string;
    total?: number;
    active?: number;
};

function collectStates(): FindState[] {
    const seen: FindState[] = [];
    window.addEventListener('folio-find-state', ((event: CustomEvent<FindState>) => {
        seen.push(event.detail || {});
    }) as EventListener);
    return seen;
}

function last(states: FindState[]): FindState {
    return states[states.length - 1] || {};
}

describe('view/hex-find', () => {
    let tauri: TauriMockHandles;
    let HexFinder: typeof import('../../app/view/hex-find').HexFinder;
    let resetHexFinderForTests: typeof import('../../app/view/hex-find').resetHexFinderForTests;
    let setHexPatternMode: typeof import('../../app/view/hex-find').setHexPatternMode;

    beforeEach(async () => {
        tauri = installTauriMock();
        await seedDeCatalog();
        revealHexOffset.mockReset();
        clearHexHighlight.mockReset();
        getHexSearchContext.mockReset();
        getHexSearchContext.mockReturnValue({ ...CTX });
        setHexContextListener.mockClear();
        pullHexRevisionAfterStale.mockReset();
        pullHexRevisionAfterStale.mockResolvedValue('changed');
        vi.resetModules();
        const mod = await import('../../app/view/hex-find');
        HexFinder = mod.HexFinder;
        resetHexFinderForTests = mod.resetHexFinderForTests;
        setHexPatternMode = mod.setHexPatternMode;
        resetHexFinderForTests();
    });

    afterEach(() => {
        resetHexFinderForTests();
    });

    it('reports scanning then a match offset', async () => {
        const states = collectStates();
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'hex_find') return Promise.resolve(1);
            return Promise.resolve(undefined);
        });

        HexFinder.setFindTerm('o');
        expect(last(states).scanning).toBe(true);

        await Promise.resolve();
        await Promise.resolve();

        expect(tauri.invoke).toHaveBeenCalledWith('hex_find', expect.objectContaining({
            tabId: 1,
            revision: 3,
            pattern: [0x6f],
            from: 0,
            backwards: false,
            caseInsensitive: true,
        }));
        expect(revealHexOffset).toHaveBeenCalledWith(1, 1);
        expect(last(states)).toMatchObject({
            hex: true,
            matchOffset: 1,
            offsetLabel: '0x00000001',
        });
        expect(last(states).scanning).toBeFalsy();
    });

    it('wraps forward once when the first scan misses', async () => {
        const froms: number[] = [];
        tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
            if (cmd !== 'hex_find') return Promise.resolve(undefined);
            froms.push(Number(args?.from));
            if (froms.length === 1) return Promise.resolve(1);
            if (froms.length === 2) return Promise.resolve(null);
            return Promise.resolve(4);
        });

        HexFinder.setFindTerm('o');
        await Promise.resolve();
        await Promise.resolve();
        HexFinder.findNext();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(froms).toEqual([0, 2, 0]);
        expect(revealHexOffset).toHaveBeenLastCalledWith(4, 1);
    });

    it('shows no match when the next scan and its wrap both miss', async () => {
        const states = collectStates();
        const froms: number[] = [];
        tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
            if (cmd !== 'hex_find') return Promise.resolve(undefined);
            froms.push(Number(args?.from));
            if (froms.length === 1) return Promise.resolve(1);
            return Promise.resolve(null);
        });
        HexFinder.setFindTerm('o');
        await Promise.resolve();
        await Promise.resolve();
        HexFinder.findNext();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(froms).toEqual([0, 2, 0]);
        expect(last(states)).toMatchObject({ hex: true, matchOffset: null, total: 0 });
        expect(clearHexHighlight).toHaveBeenCalled();
    });

    it('discards a stale success after a newer search started', async () => {
        const states = collectStates();
        let resolveFirst: (value: unknown) => void = () => undefined;
        const first = new Promise((resolve) => { resolveFirst = resolve; });
        tauri.invoke.mockImplementationOnce(() => first);
        tauri.invoke.mockImplementationOnce(() => Promise.resolve(4));

        HexFinder.setFindTerm('o');
        HexFinder.setFindTerm('o');
        resolveFirst(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(revealHexOffset).toHaveBeenCalledTimes(1);
        expect(revealHexOffset).toHaveBeenCalledWith(4, 1);
        expect(last(states).matchOffset).toBe(4);
    });

    it('zieht bei stale:revision die Revision nach, statt still zu enden', async () => {
        const states = collectStates();
        tauri.invoke.mockRejectedValue('stale:revision 3 != 4');
        pullHexRevisionAfterStale.mockResolvedValue('changed');

        HexFinder.setFindTerm('o');
        await settle();

        // Anders als beim Abbruch gibt es hier KEINEN abloesenden Lauf.
        // Wird das still verworfen, bleiben Zaehler und Markierung stehen —
        // `find-prev` waere wirkungslos.
        expect(pullHexRevisionAfterStale).toHaveBeenCalledTimes(1);
        // Gelingt das Nachziehen, startet onHexContextChanged die Suche neu;
        // ein „Kein Treffer" hier waere falsch.
        expect(states).toHaveLength(1);
        expect(states[0].scanning).toBe(true);
        expect(clearHexHighlight).not.toHaveBeenCalled();
    });

    it('beendet den scanning-Zustand, wenn das Nachziehen nichts bringt', async () => {
        const states = collectStates();
        tauri.invoke.mockRejectedValue('stale:revision 3 != 4');
        pullHexRevisionAfterStale.mockResolvedValue('unchanged');

        HexFinder.setFindTerm('o');
        await settle();

        // Kein Neustart in Sicht — dann muss die Suche ihren eigenen
        // Zustand aufloesen, statt dauerhaft „scanning" zu zeigen.
        expect(last(states).scanning).toBe(false);
        expect(last(states).matchOffset).toBeNull();
    });

    it('laesst einen laufenden Resync aufraeumen, ohne selbst zu melden', async () => {
        const states = collectStates();
        tauri.invoke.mockRejectedValue('stale:revision 3 != 4');
        pullHexRevisionAfterStale.mockResolvedValue('inFlight');

        HexFinder.setFindTerm('o');
        await settle();

        expect(states).toHaveLength(1);
        expect(states[0].scanning).toBe(true);
    });

    it('keeps the shown match when a stale: error arrives for it', async () => {
        const states = collectStates();
        tauri.invoke.mockImplementation(fakeHexFind([0x6f, 0x00, 0x6f]));
        getHexSearchContext.mockReturnValue({ ...CTX, fileSize: 3 });

        HexFinder.setFindTerm('o');
        await settle();
        expect(last(states).matchOffset).toBe(0);

        tauri.invoke.mockRejectedValue('stale:cancelled');
        HexFinder.findNext();
        await settle();

        expect(last(states).scanning).toBe(true);
        expect(clearHexHighlight).not.toHaveBeenCalled();
        // Ein Abbruch hat einen abloesenden Lauf — hier ist nichts
        // nachzuziehen, sonst wuerde jeder Tastendruck einen IPC ausloesen.
        expect(pullHexRevisionAfterStale).not.toHaveBeenCalled();
    });

    it('does not wrap or retry after a real error', async () => {
        const states = collectStates();
        tauri.invoke.mockRejectedValue('EACCES');

        HexFinder.setFindTerm('o');
        await Promise.resolve();
        await Promise.resolve();

        expect(tauri.invoke).toHaveBeenCalledTimes(1);
        expect(last(states)).toMatchObject({ hex: true, matchOffset: null });
        expect(revealHexOffset).not.toHaveBeenCalled();
    });

    it('marks invalid hex without invoking the backend', async () => {
        const states = collectStates();
        setHexPatternMode('hex');
        HexFinder.setFindTerm('123');
        await Promise.resolve();

        expect(tauri.invoke).not.toHaveBeenCalled();
        expect(last(states)).toMatchObject({ invalidHex: true, hex: true });
    });

    describe('Kontextwechsel', () => {
        it('discards a response that arrives after the tab changed', async () => {
            const states = collectStates();
            let resolveFirst: (value: unknown) => void = () => undefined;
            tauri.invoke.mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirst = resolve;
            }));
            tauri.invoke.mockImplementationOnce(() => Promise.resolve(7));

            HexFinder.setFindTerm('o');
            await Promise.resolve();

            switchContext({ ...CTX, tabId: 2, path: '/tmp/b.bin' });
            resolveFirst(1);
            await settle();

            expect(revealHexOffset).toHaveBeenCalledTimes(1);
            expect(revealHexOffset).toHaveBeenCalledWith(7, 1);
            expect(last(states).matchOffset).toBe(7);
        });

        it('restarts the search after a revision change instead of keeping the old hit', async () => {
            const states = collectStates();
            tauri.invoke.mockImplementation(fakeHexFind([0x6f, 0x00, 0x00, 0x00]));
            getHexSearchContext.mockReturnValue({ ...CTX, fileSize: 4 });

            HexFinder.setFindTerm('o');
            await settle();
            expect(last(states).matchOffset).toBe(0);

            tauri.invoke.mockImplementation(fakeHexFind([0x00, 0x00, 0x6f, 0x00]));
            switchContext({ ...CTX, revision: 4, fileSize: 4 });
            await settle();

            expect(revealHexOffset).toHaveBeenLastCalledWith(2, 1);
            expect(last(states).matchOffset).toBe(2);
        });

        it('clears counter and highlight when the hex context disappears', async () => {
            const states = collectStates();
            tauri.invoke.mockImplementation(fakeHexFind([0x6f]));
            getHexSearchContext.mockReturnValue({ ...CTX, fileSize: 1 });

            HexFinder.setFindTerm('o');
            await settle();
            expect(last(states).matchOffset).toBe(0);

            const before = tauri.invoke.mock.calls.length;
            switchContext(null);
            await settle();

            expect(tauri.invoke.mock.calls).toHaveLength(before);
            expect(clearHexHighlight).toHaveBeenCalled();
            expect(last(states)).toMatchObject({ matchOffset: null, total: 0 });
        });

        it('stays silent on a context change while the find bar is closed', async () => {
            HexFinder.closeFind();
            const states = collectStates();
            switchContext({ ...CTX, tabId: 5, path: '/tmp/c.bin' });
            await settle();

            expect(tauri.invoke).not.toHaveBeenCalled();
            expect(states).toHaveLength(0);
        });
    });

    describe('Rueckwaertssuche (from ist exklusive Obergrenze)', () => {
        // 'o' an 0 und 1 — der Regressionsfall: `from: current - 1` liess den
        // Ruecklauf ab 0 leer laufen, der Wrap ab EOF lieferte wieder 1.
        const NEIGHBOURS = [0x6f, 0x6f, 0x00, 0x00];

        async function startOn(data: number[], term: string): Promise<void> {
            tauri.invoke.mockImplementation(fakeHexFind(data));
            getHexSearchContext.mockReturnValue({ ...CTX, fileSize: data.length });
            HexFinder.setFindTerm(term);
            await settle();
        }

        it('findet den direkten Nachbarn statt umzulaufen', async () => {
            const states = collectStates();
            await startOn(NEIGHBOURS, 'o');
            expect(last(states).matchOffset).toBe(0);

            HexFinder.findNext();
            await settle();
            expect(last(states).matchOffset).toBe(1);

            const froms: number[] = [];
            tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
                if (cmd === 'hex_find') froms.push(Number(args?.from));
                return fakeHexFind(NEIGHBOURS)(cmd, args);
            });
            HexFinder.findPrev();
            await settle();

            expect(froms).toEqual([1]);
            expect(last(states).matchOffset).toBe(0);
            expect(revealHexOffset).toHaveBeenLastCalledWith(0, 1);
        });

        it('findet den vorherigen von zwei ueberlappenden Treffern', async () => {
            const states = collectStates();
            await startOn([0x61, 0x61, 0x61], 'aa');
            expect(last(states).matchOffset).toBe(0);

            HexFinder.findNext();
            await settle();
            expect(last(states).matchOffset).toBe(1);

            HexFinder.findPrev();
            await settle();
            expect(last(states).matchOffset).toBe(0);
        });

        it('laeuft vom Treffer bei 0 einmal ans Dateiende um', async () => {
            const states = collectStates();
            const froms: number[] = [];
            await startOn(NEIGHBOURS, 'o');
            expect(last(states).matchOffset).toBe(0);

            tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
                if (cmd === 'hex_find') froms.push(Number(args?.from));
                return fakeHexFind(NEIGHBOURS)(cmd, args);
            });
            HexFinder.findPrev();
            await settle();

            expect(froms).toEqual([NEIGHBOURS.length]);
            expect(last(states).matchOffset).toBe(1);
        });

        it('bleibt bei genau einem Treffer auf diesem Treffer', async () => {
            const states = collectStates();
            await startOn([0x00, 0x6f, 0x00, 0x00], 'o');
            expect(last(states).matchOffset).toBe(1);

            HexFinder.findPrev();
            await settle();
            expect(last(states).matchOffset).toBe(1);

            HexFinder.findNext();
            await settle();
            expect(last(states).matchOffset).toBe(1);
        });

        it('meldet ohne Treffer „kein Treffer" in beide Richtungen', async () => {
            const states = collectStates();
            await startOn([0x00, 0x01, 0x02], 'o');
            expect(last(states)).toMatchObject({ matchOffset: null, total: 0 });

            HexFinder.findPrev();
            await settle();
            expect(last(states)).toMatchObject({ matchOffset: null, total: 0 });
            expect(revealHexOffset).not.toHaveBeenCalled();
        });
    });
});
