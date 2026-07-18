// Tests fuer view/image-transform.ts — reine Mathematik, kein DOM.
// Fit-Berechnung, cursor-zentrierter Zoom (Fixpunkt), Scale-/Pan-Clamp,
// Doppelklick-Reset (= fitTransform), SVG-Fallback, Resize-Reanker.

import { describe, expect, it } from 'vitest';
import {
    MAX_SCALE,
    MIN_SCALE,
    ZOOM_STEP,
    clampPan,
    clampScale,
    computeFitSize,
    fitTransform,
    panBy,
    reanchorOnViewportResize,
    resolveIntrinsicSize,
    toCssTransform,
    wheelDeltaToScaleFactor,
    zoomAt,
    type Size,
    type Transform,
} from '../../app/view/image-transform';

const VIEW: Size = { width: 400, height: 300 };

describe('view/image-transform', () => {
    describe('resolveIntrinsicSize', () => {
        it('nimmt natural, wenn > 0', () => {
            expect(
                resolveIntrinsicSize({ width: 800, height: 600 }, VIEW),
            ).toEqual({ width: 800, height: 600 });
        });

        it('Fallback auf Viewport bei natural 0 (SVG nur viewBox)', () => {
            // Browser meldet naturalWidth/Height 0 → ohne Fallback haengt
            // die 300×150-Defaultbox und Zoom/Pan bleibt tot.
            expect(
                resolveIntrinsicSize({ width: 0, height: 0 }, VIEW),
            ).toEqual({ width: VIEW.width, height: VIEW.height });
        });

        it('Fallback-Fit fuellt den Viewport bei scale 1', () => {
            const intrinsic = resolveIntrinsicSize({ width: 0, height: 0 }, VIEW);
            const fit = computeFitSize(intrinsic, VIEW);
            expect(fit.width).toBeCloseTo(VIEW.width);
            expect(fit.height).toBeCloseTo(VIEW.height);
            const t = fitTransform(fit, VIEW);
            expect(t.scale).toBe(MIN_SCALE);
            expect(t.tx).toBeCloseTo(0);
            expect(t.ty).toBeCloseTo(0);
        });

        it('liefert 0 wenn natural und Viewport leer', () => {
            expect(
                resolveIntrinsicSize({ width: 0, height: 0 }, { width: 0, height: 0 }),
            ).toEqual({ width: 0, height: 0 });
        });
    });

    describe('computeFitSize', () => {
        it('passt breiteres Bild horizontal ein (kein Upscale)', () => {
            // 800×300 in 400×300 → scale 0.5 → 400×150
            const fit = computeFitSize({ width: 800, height: 300 }, VIEW);
            expect(fit.width).toBeCloseTo(400);
            expect(fit.height).toBeCloseTo(150);
        });

        it('passt hoeheres Bild vertikal ein', () => {
            // 200×600 in 400×300 → scale 0.5 → 100×300
            const fit = computeFitSize({ width: 200, height: 600 }, VIEW);
            expect(fit.width).toBeCloseTo(100);
            expect(fit.height).toBeCloseTo(300);
        });

        it('laesst kleinere Bilder in Originalgroesse', () => {
            const fit = computeFitSize({ width: 100, height: 80 }, VIEW);
            expect(fit.width).toBe(100);
            expect(fit.height).toBe(80);
        });

        it('liefert 0 bei ungueltigen Maßen', () => {
            expect(computeFitSize({ width: 0, height: 100 }, VIEW)).toEqual({
                width: 0,
                height: 0,
            });
            expect(computeFitSize({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({
                width: 0,
                height: 0,
            });
        });
    });

    describe('fitTransform / Reset', () => {
        it('zentriert die Fit-Groesse im Viewport (Doppelklick-Reset)', () => {
            const fitted = { width: 200, height: 100 };
            const t = fitTransform(fitted, VIEW);
            expect(t.scale).toBe(MIN_SCALE);
            expect(t.tx).toBeCloseTo((400 - 200) / 2); // 100
            expect(t.ty).toBeCloseTo((300 - 100) / 2); // 100
        });
    });

    describe('clampScale', () => {
        it('klemmt unter MIN und ueber MAX', () => {
            expect(clampScale(0.5)).toBe(MIN_SCALE);
            expect(clampScale(1)).toBe(MIN_SCALE);
            expect(clampScale(10)).toBe(10);
            expect(clampScale(100)).toBe(MAX_SCALE);
            expect(clampScale(NaN)).toBe(MIN_SCALE);
        });
    });

    describe('zoomAt — Fixpunkt-Eigenschaft', () => {
        it('haelt Off-Center-Cursor auf grosser ungeclampter Darstellung fest', () => {
            // Grosses fitted + hoher scale, Cursor weit ausserhalb der
            // Mitte — eine reine Center-Zoom-Implementierung wuerde hier
            // scheitern (Fixpunkt waere immer Viewport-Mitte).
            const fitted = { width: 800, height: 600 };
            const start: Transform = { scale: 2, tx: -200, ty: -150 };
            const cursor = { x: 50, y: 280 };
            const ix = (cursor.x - start.tx) / start.scale;
            const iy = (cursor.y - start.ty) / start.scale;

            // Zoom-Schritt klein genug, dass nach dem Zoom die Kanten
            // den Cursor-Punkt nicht clampen (scale 2 → 2.4, dw=1920).
            const next = zoomAt(start, cursor, start.scale * ZOOM_STEP, fitted, VIEW);
            expect(next.scale).toBeCloseTo(2 * ZOOM_STEP);

            const ixAfter = (cursor.x - next.tx) / next.scale;
            const iyAfter = (cursor.y - next.ty) / next.scale;
            expect(ixAfter).toBeCloseTo(ix, 5);
            expect(iyAfter).toBeCloseTo(iy, 5);
            // Nicht-trivial: tx aendert sich nicht nur durch Center-Logik
            expect(next.tx).not.toBeCloseTo(start.tx, 5);
        });

        it('zoomt nicht unter Fit (MIN_SCALE)', () => {
            const fitted = { width: 200, height: 150 };
            const start = fitTransform(fitted, VIEW);
            const next = zoomAt(start, { x: 100, y: 100 }, 0.5, fitted, VIEW);
            expect(next.scale).toBe(MIN_SCALE);
        });

        it('zoomt nicht ueber MAX_SCALE', () => {
            const fitted = { width: 200, height: 150 };
            const start: Transform = { scale: MAX_SCALE, tx: 0, ty: 0 };
            const next = zoomAt(
                start,
                { x: 50, y: 50 },
                MAX_SCALE * ZOOM_STEP,
                fitted,
                VIEW,
            );
            expect(next.scale).toBe(MAX_SCALE);
        });

        it('In→Out-Zyklus (20× rein/raus) landet nahe Fit', () => {
            const fitted = { width: 200, height: 150 };
            let t = fitTransform(fitted, VIEW);
            const cursor = { x: 120, y: 90 };
            for (let i = 0; i < 20; i++) {
                t = zoomAt(t, cursor, t.scale * ZOOM_STEP, fitted, VIEW);
            }
            for (let i = 0; i < 20; i++) {
                t = zoomAt(t, cursor, t.scale / ZOOM_STEP, fitted, VIEW);
            }
            const fit = fitTransform(fitted, VIEW);
            expect(t.scale).toBeCloseTo(MIN_SCALE, 5);
            expect(t.tx).toBeCloseTo(fit.tx, 4);
            expect(t.ty).toBeCloseTo(fit.ty, 4);
        });
    });

    describe('clampPan — Kanten', () => {
        it('zentriert wenn skaliertes Bild kleiner als Viewport ist', () => {
            const fitted = { width: 100, height: 80 };
            const t = clampPan({ scale: 1, tx: 999, ty: -50 }, fitted, VIEW);
            expect(t.tx).toBeCloseTo((400 - 100) / 2);
            expect(t.ty).toBeCloseTo((300 - 80) / 2);
        });

        it('klemmt grosse Bilder an den Viewport-Rand', () => {
            // fitted 200×150 @ scale 4 → 800×600 > 400×300
            const fitted = { width: 200, height: 150 };
            const scale = 4;
            const dw = fitted.width * scale; // 800
            const dh = fitted.height * scale; // 600

            // Zu weit nach rechts/unten → max = 0
            let t = clampPan({ scale, tx: 50, ty: 50 }, fitted, VIEW);
            expect(t.tx).toBe(0);
            expect(t.ty).toBe(0);

            // Zu weit nach links/oben → min = viewport - size
            t = clampPan({ scale, tx: -9999, ty: -9999 }, fitted, VIEW);
            expect(t.tx).toBeCloseTo(VIEW.width - dw);
            expect(t.ty).toBeCloseTo(VIEW.height - dh);

            // Gueltiger Wert bleibt
            t = clampPan({ scale, tx: -100, ty: -80 }, fitted, VIEW);
            expect(t.tx).toBeCloseTo(-100);
            expect(t.ty).toBeCloseTo(-80);
        });

        it('Mixed-Axis: X groesser als Viewport, Y kleiner → X clamp, Y center', () => {
            // fitted 300×50 @ scale 2 → 600×100; VIEW 400×300
            // dw=600 > 400 → X-Clamp; dh=100 < 300 → Y-Zentrierung
            const fitted = { width: 300, height: 50 };
            const scale = 2;
            const t = clampPan({ scale, tx: 999, ty: 999 }, fitted, VIEW);
            expect(t.tx).toBe(0); // maxTx
            expect(t.ty).toBeCloseTo((VIEW.height - fitted.height * scale) / 2);

            const t2 = clampPan({ scale, tx: -9999, ty: -9999 }, fitted, VIEW);
            expect(t2.tx).toBeCloseTo(VIEW.width - fitted.width * scale);
            expect(t2.ty).toBeCloseTo((VIEW.height - fitted.height * scale) / 2);
        });
    });

    describe('reanchorOnViewportResize', () => {
        it('haelt den Bildpunkt unter der Viewport-Mitte fractional fest', () => {
            const oldVp: Size = { width: 400, height: 300 };
            const oldFit: Size = { width: 200, height: 150 };
            // scale 2, Mitte des Bildes unter Viewport-Mitte:
            // ix = 100, iy = 75 → tx = 200 - 100*2 = 0, ty = 150 - 75*2 = 0
            const current: Transform = { scale: 2, tx: 0, ty: 0 };
            const newVp: Size = { width: 200, height: 150 };
            const newFit: Size = { width: 100, height: 75 };

            const next = reanchorOnViewportResize(
                current,
                oldVp,
                oldFit,
                newFit,
                newVp,
            );
            // frac 0.5/0.5 → newIx=50, newIy=37.5 → tx = 100 - 100 = 0, ty = 75 - 75 = 0
            expect(next.scale).toBe(2);
            expect(next.tx).toBeCloseTo(0, 5);
            expect(next.ty).toBeCloseTo(0, 5);
        });

        it('bei scale 1 liefert Fit-Zentrierung', () => {
            const next = reanchorOnViewportResize(
                { scale: 1, tx: 50, ty: 50 },
                VIEW,
                { width: 200, height: 150 },
                { width: 100, height: 75 },
                { width: 200, height: 150 },
            );
            expect(next.scale).toBe(MIN_SCALE);
            expect(next.tx).toBeCloseTo((200 - 100) / 2);
            expect(next.ty).toBeCloseTo((150 - 75) / 2);
        });
    });

    describe('panBy', () => {
        it('verschiebt und clampt', () => {
            const fitted = { width: 200, height: 150 };
            const start: Transform = { scale: 4, tx: 0, ty: 0 };
            const next = panBy(start, -50, -30, fitted, VIEW);
            expect(next.tx).toBeCloseTo(-50);
            expect(next.ty).toBeCloseTo(-30);
            expect(next.scale).toBe(4);
        });
    });

    describe('wheelDeltaToScaleFactor', () => {
        it('negativ = rein, positiv = raus', () => {
            expect(wheelDeltaToScaleFactor(-100)).toBe(ZOOM_STEP);
            expect(wheelDeltaToScaleFactor(100)).toBeCloseTo(1 / ZOOM_STEP);
            expect(wheelDeltaToScaleFactor(0)).toBe(1);
        });
    });

    describe('toCssTransform', () => {
        it('formatiert translate + scale', () => {
            expect(toCssTransform({ scale: 1.5, tx: 10, ty: -20 })).toBe(
                'translate(10px, -20px) scale(1.5)',
            );
        });
    });
});
