// Tests fuer view/wikilink-refresh.ts (Spec W8): beide Backend-Events
// (`wikilink:index_ready` nach einem beendeten Hintergrund-Build und
// `wikilink:roots_changed` nach dem Opt-in-Toggle) muessen denselben
// Re-Render-Pfad anstossen — sichtbare Preview + Backlinks. `preview` und
// `backlinks` sind gemockt: hier interessiert nur das Routing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';

const flushPreviewRender = vi.fn().mockResolvedValue(undefined);
const refreshBacklinksAfterIndexReady = vi.fn();

vi.mock('../../app/view/preview', () => ({
    flushPreviewRender: () => flushPreviewRender(),
}));

vi.mock('../../app/view/backlinks', () => ({
    refreshBacklinksAfterIndexReady: () => refreshBacklinksAfterIndexReady(),
}));

let handles: ReturnType<typeof installTauriMock>;

beforeEach(async () => {
    flushPreviewRender.mockClear();
    refreshBacklinksAfterIndexReady.mockClear();
    handles = installTauriMock();
    const mod = await import('../../app/view/wikilink-refresh');
    mod.__resetWikilinkRefreshForTests();
    mod.initWikilinkRefresh();
});

describe('view/wikilink-refresh', () => {
    it('zieht View und Backlinks bei wikilink:index_ready nach', () => {
        handles.emitEvent('wikilink:index_ready', {});
        expect(flushPreviewRender).toHaveBeenCalledTimes(1);
        expect(refreshBacklinksAfterIndexReady).toHaveBeenCalledTimes(1);
    });

    // Review sol MAJOR #2: ohne diesen Pfad startet das Aktivieren einer
    // Wurzel gar keinen Build, und beim Deaktivieren bleiben aufgeloeste
    // Links sichtbar.
    it('zieht View und Backlinks bei wikilink:roots_changed nach', () => {
        handles.emitEvent('wikilink:roots_changed', {});
        expect(flushPreviewRender).toHaveBeenCalledTimes(1);
        expect(refreshBacklinksAfterIndexReady).toHaveBeenCalledTimes(1);
    });

    it('behandelt beide Events identisch (ein gemeinsamer Handler)', () => {
        handles.emitEvent('wikilink:roots_changed', {});
        handles.emitEvent('wikilink:index_ready', {});
        expect(flushPreviewRender).toHaveBeenCalledTimes(2);
        expect(refreshBacklinksAfterIndexReady).toHaveBeenCalledTimes(2);
    });

    it('registriert die Listener nur einmal', async () => {
        const mod = await import('../../app/view/wikilink-refresh');
        // Zweiter Init ohne Reset: darf keine doppelten Listener anhaengen,
        // sonst rendert jedes Event mehrfach.
        mod.initWikilinkRefresh();
        handles.emitEvent('wikilink:index_ready', {});
        expect(flushPreviewRender).toHaveBeenCalledTimes(1);
    });

    it('exportiert beide Event-Namen als Vertrag', async () => {
        const mod = await import('../../app/view/wikilink-refresh');
        expect(Array.from(mod.WIKILINK_REFRESH_EVENTS)).toEqual([
            'wikilink:index_ready',
            'wikilink:roots_changed',
        ]);
    });
});
