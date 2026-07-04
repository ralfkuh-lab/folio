// Tests fuer ui/rails.ts, Schwerpunkt mittlerer Split-Splitter:
// - setSplitMidPercent setzt --split-mid und clamped auf 20–80.
// - Drag am #splitter-mid aktualisiert --split-mid live (Editor liegt
//   links → Drag nach rechts vergroessert den Editor-Anteil, positives
//   Vorzeichen trotz row-reverse).
// - Drag-Ende persistiert ueber set_split_mid_percent.

import { beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';
import { applySplitMidFromBackend, initRails, setSplitMidPercent } from '../../app/ui/rails';

function pe(type: string, opts: Record<string, any> = {}): any {
    const ev = new Event(type, { bubbles: true, cancelable: true }) as any;
    Object.assign(ev, { button: 0, pointerId: 1, clientX: 0, clientY: 0 }, opts);
    return ev;
}

function midVar(): number {
    return parseFloat(document.documentElement.style.getPropertyValue('--split-mid'));
}

describe('rails split-mid splitter', () => {
    let handles: TauriMockHandles;

    beforeEach(() => {
        handles = installTauriMock();
        document.documentElement.style.removeProperty('--split-mid');
        document.body.innerHTML = `
            <div class="content-region" id="content-region">
                <div class="splitter-mid" id="splitter-mid"></div>
                <div class="editor-region" id="editor-region"></div>
            </div>
        `;
        const content = document.getElementById('content-region') as HTMLElement;
        Object.defineProperty(content, 'clientWidth', { value: 1000, configurable: true });
    });

    it('setSplitMidPercent sets the css var and clamps to 20..80', () => {
        setSplitMidPercent(35);
        expect(midVar()).toBe(35);
        setSplitMidPercent(95);
        expect(midVar()).toBe(80);
        setSplitMidPercent(5);
        expect(midVar()).toBe(20);
    });

    it('dragging the mid splitter right widens the editor pane', () => {
        setSplitMidPercent(50);
        initRails();
        const splitter = document.getElementById('splitter-mid') as HTMLElement;
        splitter.dispatchEvent(pe('pointerdown', { clientX: 500 }));
        // +100px auf 1000px Breite = +10 Prozentpunkte.
        splitter.dispatchEvent(pe('pointermove', { clientX: 600 }));
        expect(midVar()).toBeCloseTo(60, 5);
        splitter.dispatchEvent(pe('pointerup', { clientX: 600 }));
        expect(handles.invoke).toHaveBeenCalledWith(
            'set_split_mid_percent',
            { percent: 60 },
        );
    });

    it('dragging past the clamp caps at 80 percent', () => {
        setSplitMidPercent(50);
        initRails();
        const splitter = document.getElementById('splitter-mid') as HTMLElement;
        splitter.dispatchEvent(pe('pointerdown', { clientX: 0 }));
        splitter.dispatchEvent(pe('pointermove', { clientX: 900 }));
        expect(midVar()).toBe(80);
    });

    it('backend sync is dropped during an active drag, applied afterwards', () => {
        setSplitMidPercent(50);
        initRails();
        const splitter = document.getElementById('splitter-mid') as HTMLElement;
        splitter.dispatchEvent(pe('pointerdown', { clientX: 500 }));
        splitter.dispatchEvent(pe('pointermove', { clientX: 600 }));
        // Verspaetetes panel:split_mid_changed aus einem frueheren Drag
        // darf den Live-Wert nicht ueberschreiben.
        applySplitMidFromBackend(42);
        expect(midVar()).toBeCloseTo(60, 5);
        splitter.dispatchEvent(pe('pointerup', { clientX: 600 }));
        applySplitMidFromBackend(42);
        expect(midVar()).toBe(42);
    });
});
