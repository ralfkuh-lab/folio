/* Zoom-/Pan-Mathematik fuer die Image-View — rein numerisch, kein DOM.
   scale ist relativ zur eingepassten Fit-Groesse (Fit = 1.0). Transform
   beschreibt `translate(tx,ty) scale(s)` mit transform-origin 0 0 auf
   einem Bild der Fit-Pixelgroesse. */

export const MIN_SCALE = 1.0;
export const MAX_SCALE = 20.0;
/** Multiplikativer Zoom-Faktor pro Mausrad-Tick (~+20 % pro Stufe). */
export const ZOOM_STEP = 1.2;

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Transform = { scale: number; tx: number; ty: number };

/**
 * Intrinsische Basis fuer Fit: naturalWidth/Height wenn der Browser
 * welche meldet. SVG ohne width/height (nur viewBox) liefert oft
 * naturalWidth==0 — dann Viewport als Fallback-Basis, damit das <img>
 * nicht in der Browser-Defaultbox (typ. 300×150) oben links haengt und
 * Zoom/Pan greifbar bleibt. Raster- und bemassene SVGs nutzen natural.
 */
export function resolveIntrinsicSize(natural: Size, viewport: Size): Size {
    if (natural.width > 0 && natural.height > 0) {
        return { width: natural.width, height: natural.height };
    }
    if (viewport.width > 0 && viewport.height > 0) {
        return { width: viewport.width, height: viewport.height };
    }
    return { width: 0, height: 0 };
}

/** Fit-Groesse: natural in den Viewport einpassen, nie hochskalieren
 *  (kleinere Bilder bleiben in Originalpixeln). */
export function computeFitSize(natural: Size, viewport: Size): Size {
    if (natural.width <= 0 || natural.height <= 0) {
        return { width: 0, height: 0 };
    }
    if (viewport.width <= 0 || viewport.height <= 0) {
        return { width: 0, height: 0 };
    }
    const fitS = Math.min(
        1,
        viewport.width / natural.width,
        viewport.height / natural.height,
    );
    return {
        width: natural.width * fitS,
        height: natural.height * fitS,
    };
}

/** Zentrierte Fit-Transform (scale 1). */
export function fitTransform(fitted: Size, viewport: Size): Transform {
    return {
        scale: MIN_SCALE,
        tx: (viewport.width - fitted.width) / 2,
        ty: (viewport.height - fitted.height) / 2,
    };
}

export function clampScale(scale: number): number {
    if (!Number.isFinite(scale)) return MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Kanten-Klemmung: Bild nie vollstaendig aus dem Viewport schieben.
 *  Wenn die skaliert dargestellte Kante kleiner als der Viewport ist,
 *  bleibt sie zentriert; sonst klemmt die Bildkante am Viewport-Rand. */
export function clampPan(
    t: Transform,
    fitted: Size,
    viewport: Size,
): Transform {
    const scale = clampScale(t.scale);
    const dw = fitted.width * scale;
    const dh = fitted.height * scale;
    let tx = t.tx;
    let ty = t.ty;

    if (dw <= viewport.width) {
        tx = (viewport.width - dw) / 2;
    } else {
        const minTx = viewport.width - dw;
        const maxTx = 0;
        tx = Math.min(maxTx, Math.max(minTx, tx));
    }

    if (dh <= viewport.height) {
        ty = (viewport.height - dh) / 2;
    } else {
        const minTy = viewport.height - dh;
        const maxTy = 0;
        ty = Math.min(maxTy, Math.max(minTy, ty));
    }

    return { scale, tx, ty };
}

/** Cursor-zentrierter Zoom: der Punkt unterm Cursor bleibt Fixpunkt.
 *  newScale wird auf [MIN_SCALE, MAX_SCALE] geclampt; anschliessend Pan-Clamp. */
export function zoomAt(
    current: Transform,
    cursor: Point,
    newScale: number,
    fitted: Size,
    viewport: Size,
): Transform {
    const s0 = current.scale > 0 ? current.scale : MIN_SCALE;
    const s1 = clampScale(newScale);
    // Bild-lokaler Punkt unter dem Cursor (vor dem Scale-Wechsel).
    const ix = (cursor.x - current.tx) / s0;
    const iy = (cursor.y - current.ty) / s0;
    const next: Transform = {
        scale: s1,
        tx: cursor.x - ix * s1,
        ty: cursor.y - iy * s1,
    };
    return clampPan(next, fitted, viewport);
}

/** Pan um Delta in Viewport-Pixeln, anschliessend Kanten-Clamp. */
export function panBy(
    current: Transform,
    dx: number,
    dy: number,
    fitted: Size,
    viewport: Size,
): Transform {
    return clampPan(
        { scale: current.scale, tx: current.tx + dx, ty: current.ty + dy },
        fitted,
        viewport,
    );
}

/**
 * Nach Fit-/Viewport-Wechsel: den Bildinhalt unter der alten
 * Viewport-Mitte fractional auf die neue Fit-Basis mappen und unter
 * der neuen Mitte rekonstruieren, dann clampen. Bei scale<=1 → Fit.
 * Verhindert den Sprung, wenn nur die Container-Pixelgroesse wechselt.
 */
export function reanchorOnViewportResize(
    current: Transform,
    oldViewport: Size,
    oldFitted: Size,
    newFitted: Size,
    newViewport: Size,
): Transform {
    if (
        current.scale <= MIN_SCALE ||
        oldFitted.width <= 0 ||
        oldFitted.height <= 0 ||
        newFitted.width <= 0 ||
        newFitted.height <= 0
    ) {
        return fitTransform(newFitted, newViewport);
    }
    const s = current.scale > 0 ? current.scale : MIN_SCALE;
    const cx = oldViewport.width / 2;
    const cy = oldViewport.height / 2;
    const ix = (cx - current.tx) / s;
    const iy = (cy - current.ty) / s;
    // fitted-Pixel → Anteil am Bildinhalt → neue fitted-Pixel
    const fracX = ix / oldFitted.width;
    const fracY = iy / oldFitted.height;
    const newIx = fracX * newFitted.width;
    const newIy = fracY * newFitted.height;
    return clampPan(
        {
            scale: s,
            tx: newViewport.width / 2 - newIx * s,
            ty: newViewport.height / 2 - newIy * s,
        },
        newFitted,
        newViewport,
    );
}

/** Wheel-deltaY → multiplikativer Scale-Faktor (negativ = reinzoomen). */
export function wheelDeltaToScaleFactor(deltaY: number): number {
    if (deltaY < 0) return ZOOM_STEP;
    if (deltaY > 0) return 1 / ZOOM_STEP;
    return 1;
}

/** CSS-transform-String fuer translate+scale mit origin 0 0. */
export function toCssTransform(t: Transform): string {
    return `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
}
