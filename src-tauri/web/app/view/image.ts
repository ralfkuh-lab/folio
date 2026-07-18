/* Bild-Vorschau fuer .png/.jpg/.gif/.webp/.svg/.bmp/.ico/.avif.
   Rendert ein `<img>`-Element in den Container `#image-view-mount`,
   src kommt ueber `convertFileSrc` direkt von Disk — kein Read-Roundtrip
   ins Backend, kein Base64-Embedding.

   Zoom/Pan: Mausrad zoomt cursor-zentriert (scale relativ zur Fit-
   Groesse, Clamp [1, 20]); Drag pannt bei scale > 1; Doppelklick setzt
   auf Fit zurueck. Mathe in `image-transform.ts` (DOM-frei). Fit wird
   hier bewusst per naturalWidth/Height vs. Container berechnet statt
   via CSS object-fit — sonst waere die Basisgroesse fuer
   transform-origin:0 0 + scale mehrdeutig. SVG mit intrinsischen Maßen
   laeuft denselben natural-Pfad; SVG nur mit viewBox (naturalWidth==0)
   bekommt die Viewport-Groesse als Fallback-Fit-Basis (s.
   resolveIntrinsicSize) — sonst haengt die Browser-Defaultbox (300×150)
   und Zoom/Pan bleibt tot. */

import { t } from '../i18n/translate';
import {
    MIN_SCALE,
    computeFitScale,
    computeFitSize,
    fitTransform,
    formatZoomPercent,
    panBy,
    reanchorOnViewportResize,
    resolveIntrinsicSize,
    toCssTransform,
    wheelDeltaToScaleFactor,
    zoomAt,
    type Size,
    type Transform,
} from './image-transform';

let currentPath = '';
let lastError: string | null = null;

/** Aktuelle Fit-Pixelgroesse des <img> (Basis vor dem Zoom-Scale). */
let fitted: Size = { width: 0, height: 0 };
let viewport: Size = { width: 0, height: 0 };
/** fitted/intrinsic — Anzeige-Zoom = fitScale × transform.scale. */
let fitScale = 0;
let transform: Transform = { scale: MIN_SCALE, tx: 0, ty: 0 };
let dragging = false;
let lastPointerX = 0;
let lastPointerY = 0;
/** Listener haengen einmalig am Mount-Container (innerHTML-Swap der
 *  <img>s reisst sie nicht ab). */
let listenersAttached = false;
let resizeObserver: ResizeObserver | null = null;

function getConvertFileSrc(): ((path: string) => string) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.convertFileSrc !== 'function') return null;
    return core.convertFileSrc.bind(core);
}

function getMount(): HTMLElement | null {
    return document.getElementById('image-view-mount');
}

function getImg(): HTMLImageElement | null {
    const mount = getMount();
    return mount ? (mount.querySelector('img') as HTMLImageElement | null) : null;
}

function measureViewport(): Size {
    const mount = getMount();
    if (!mount) return { width: 0, height: 0 };
    return { width: mount.clientWidth, height: mount.clientHeight };
}

function getZoomStatusEl(): HTMLElement | null {
    return document.getElementById('status-image-zoom');
}

/**
 * Statusleisten-Zelle `#status-image-zoom`: Zoom % relativ zur
 * Originalgroesse. Sichtbar nur bei gemountetem Bild mit Fit-Basis;
 * sonst hidden. Kein Body-Class-Observer — Aufrufer verdrahten mount/clear.
 */
function updateImageZoomStatus(): void {
    const el = getZoomStatusEl();
    if (!el) return;
    const img = getImg();
    if (!img || !currentPath || fitScale <= 0 || fitted.width <= 0) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.textContent = formatZoomPercent(fitScale, transform.scale);
}

function hideImageZoomStatus(): void {
    const el = getZoomStatusEl();
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
}

function applyTransform(): void {
    const img = getImg();
    const mount = getMount();
    if (!img) return;
    img.style.transform = toCssTransform(transform);
    if (mount) {
        if (dragging) {
            mount.style.cursor = 'grabbing';
        } else if (transform.scale > MIN_SCALE) {
            mount.style.cursor = 'grab';
        } else {
            mount.style.cursor = '';
        }
    }
    updateImageZoomStatus();
}

/** Loest onload/onerror am gegebenen img, damit spaete Events keine
 *  veralteten Closures mehr ausfuehren (zusaetzlich zum Instanz-Check). */
function detachImgHandlers(img: HTMLImageElement | null): void {
    if (!img) return;
    img.onload = null;
    img.onerror = null;
}

/**
 * Misst Viewport, berechnet Fit-Basis (inkl. SVG-Fallback) und schreibt
 * width/height aufs <img>. Wenn sich Fit/Viewport aendern und schon
 * eine alte Basis da war: Re-Anker (Mitte erhalten). Liefert false,
 * wenn keine brauchbare Basis entsteht.
 */
function syncFitBasis(img: HTMLImageElement, reanchor: boolean): boolean {
    const oldVp = viewport;
    const oldFit = fitted;
    const newVp = measureViewport();
    if (newVp.width <= 0 || newVp.height <= 0) return false;
    const intrinsic = resolveIntrinsicSize(
        { width: img.naturalWidth, height: img.naturalHeight },
        newVp,
    );
    const newFit = computeFitSize(intrinsic, newVp);
    if (newFit.width <= 0 || newFit.height <= 0) return false;
    const newFitScale = computeFitScale(intrinsic, newFit);
    if (newFitScale <= 0) return false;

    const basisChanged =
        oldFit.width !== newFit.width ||
        oldFit.height !== newFit.height ||
        oldVp.width !== newVp.width ||
        oldVp.height !== newVp.height;

    if (reanchor && oldFit.width > 0 && basisChanged) {
        transform = reanchorOnViewportResize(
            transform,
            oldVp,
            oldFit,
            newFit,
            newVp,
        );
    }

    viewport = newVp;
    fitted = newFit;
    fitScale = newFitScale;
    img.style.width = fitted.width + 'px';
    img.style.height = fitted.height + 'px';
    return true;
}

/** Setzt scale/translate auf Fit (zentriert). Braucht geladenes Bild
 *  (complete); naturalWidth==0 ist ok (SVG-Fallback). */
function resetTransformToFit(): void {
    const img = getImg();
    if (!img || !img.complete) return;
    if (!syncFitBasis(img, false)) return;
    transform = fitTransform(fitted, viewport);
    dragging = false;
    applyTransform();
}

/** Viewport-Resize: Fit-Basis neu, betrachteten Punkt unter der
 *  Viewport-Mitte fractional re-ankern, clampen. */
function onViewportResize(): void {
    const img = getImg();
    if (!img || !img.complete) return;
    if (!syncFitBasis(img, true)) return;
    if (transform.scale <= MIN_SCALE) {
        transform = fitTransform(fitted, viewport);
    }
    applyTransform();
}

function onWheel(e: WheelEvent): void {
    const img = getImg();
    const mount = getMount();
    if (!img || !mount || !img.complete) return;
    // Keine konkurrierende Scroll-Semantik in der Bild-View.
    // Desktop-Fokus: nur deltaY-Vorzeichen → multiplikativer Zoom-Schritt
    // (wheelDeltaToScaleFactor). deltaMode (Pixel/Line/Page) und
    // Touch-Pinch/Gesture-Events werden bewusst nicht ausgewertet —
    // kein Touch-Zoom-Pfad in dieser Etappe.
    e.preventDefault();
    // Fit-Basis frisch aus aktuellem Viewport (Race: Resize schon
    // geschehen, ResizeObserver-Callback noch ausstehend).
    if (!syncFitBasis(img, true)) return;
    const rect = mount.getBoundingClientRect();
    const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const factor = wheelDeltaToScaleFactor(e.deltaY);
    transform = zoomAt(
        transform,
        cursor,
        transform.scale * factor,
        fitted,
        viewport,
    );
    applyTransform();
}

function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (transform.scale <= MIN_SCALE) return;
    const mount = getMount();
    if (!mount) return;
    dragging = true;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    // setPointerCapture ist hier ERLAUBT und sinnvoll — Abweichung von
    // der tree.ts-Konvention (Pin-Reorder ohne Capture, weil e.target
    // bei pointermove das Drop-Ziel unter dem Cursor sein muss). Hier
    // gibt es kein Drop-Ziel zu treffen, nur Drag-Deltas; Capture
    // haelt den Drag, wenn der Pointer den Mount verlaesst.
    mount.setPointerCapture(e.pointerId);
    applyTransform();
}

function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    // fitted frisch halten (gleicher Resize-Race wie onWheel).
    const img = getImg();
    if (img && img.complete) {
        syncFitBasis(img, true);
    } else {
        viewport = measureViewport();
    }
    transform = panBy(transform, dx, dy, fitted, viewport);
    applyTransform();
}

function onPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const mount = getMount();
    if (mount && mount.hasPointerCapture(e.pointerId)) {
        mount.releasePointerCapture(e.pointerId);
    }
    applyTransform();
}

function onDblClick(e: MouseEvent): void {
    e.preventDefault();
    resetTransformToFit();
}

function ensureListeners(): void {
    const mount = getMount();
    if (!mount || listenersAttached) return;
    listenersAttached = true;
    mount.addEventListener('wheel', onWheel, { passive: false });
    mount.addEventListener('pointerdown', onPointerDown);
    mount.addEventListener('pointermove', onPointerMove);
    mount.addEventListener('pointerup', onPointerUp);
    mount.addEventListener('pointercancel', onPointerUp);
    mount.addEventListener('dblclick', onDblClick);
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
            onViewportResize();
        });
        resizeObserver.observe(mount);
    }
}

function clearTransformState(): void {
    fitted = { width: 0, height: 0 };
    viewport = { width: 0, height: 0 };
    fitScale = 0;
    transform = { scale: MIN_SCALE, tx: 0, ty: 0 };
    dragging = false;
    const mount = getMount();
    if (mount) mount.style.cursor = '';
    hideImageZoomStatus();
}

/** Liefert `kind === 'image'` zurueck. Aufrufer entscheiden damit, ob
 *  sie statt Markdown-/Code-/HTML-View die Bild-Surface aktivieren. */
export function isImageDocument(kind: string): boolean {
    return kind === 'image';
}

/** Setzt den Image-Container auf das Bild unter `path`. Beim Setzen
 *  der src wird ein Cache-Buster `?v=<Date.now()>` angehaengt, damit
 *  der Browser das Bild auch bei externer Aenderung (oder Re-Mount
 *  eines inaktiven Tabs) frisch von Disk laedt.
 *  Zoom/Pan wird bewusst zurueckgesetzt (Dokumentwechsel / frischer
 *  Mount) — Zoom-Erhalt ueber Reloads waere Massstabs-Raterei. */
export function mountImageView(path: string): void {
    const mount = getMount();
    if (!mount) return;
    ensureListeners();
    currentPath = path || '';
    lastError = null;
    // Alte Handler loesen, bevor das Element entfernt wird — verhindert
    // spaete onload/onerror-Closures auf dem naechsten Mount.
    detachImgHandlers(getImg());
    clearTransformState();
    mount.innerHTML = '';
    if (!path) return;
    const convert = getConvertFileSrc();
    if (!convert) {
        lastError = t('errors.view.imageConvertUnavailable');
        mount.textContent = lastError;
        return;
    }
    let src: string;
    try {
        // Pfad auf Forward-Slashes normalisieren — gleicher Trick wie in
        // `view/html.ts::resolveResourceUrl`, weil convertFileSrc auf
        // Windows mit Backslashes verschluckt wird.
        src = convert(path.replace(/\\/g, '/'));
    } catch (err) {
        lastError = t('errors.view.imageConvertFailed', { detail: String(err) });
        mount.textContent = lastError;
        return;
    }
    // Cache-Buster: jeder mount (inkl. reloadImageView) erzwingt frischen
    // Fetch vom FS. Date.now() reicht; kein mtime-Roundtrip noetig.
    const sep = src.indexOf('?') >= 0 ? '&' : '?';
    src = src + sep + 'v=' + Date.now();
    const img = document.createElement('img');
    img.alt = path;
    img.draggable = false;
    img.onerror = function () {
        // Stale-Guard: nur das aktuell gemountete <img> darf den Mount leeren.
        if (getImg() !== img) return;
        detachImgHandlers(img);
        lastError = t('errors.view.imageLoadFailed');
        clearTransformState();
        mount.innerHTML = '';
        mount.textContent = lastError + ' — ' + path;
    };
    img.onload = function () {
        // Stale-Guard: schneller Reload/Tab-Wechsel — altes onload darf
        // nicht resetTransformToFit aufs neue Bild anwenden.
        if (getImg() !== img) return;
        detachImgHandlers(img);
        resetTransformToFit();
    };
    img.src = src;
    mount.appendChild(img);
    // Cache-Hit: onload kann schon vor Handler-Zuweisung gelaufen sein
    // (complete=true). naturalWidth==0 (SVG/viewBox-only) ist zulaessig.
    if (img.complete) {
        if (getImg() === img) {
            detachImgHandlers(img);
            resetTransformToFit();
        }
    }
}

/** Laedt das aktuell gemountete Bild neu (remount mit neuem Buster).
 *  Wird vom document:external_changed-Handler fuer kind=image aufgerufen.
 *  Deckt auch Re-Aktivierung inaktiver Tabs ab.
 *  Zoom/Pan wird mit-reset (Bildmaße koennen sich geaendert haben). */
export function reloadImageView(): void {
    if (currentPath) {
        mountImageView(currentPath);
    }
}

/** Entfernt das gerenderte Bild. Wird beim Wechsel auf ein anderes
 *  Dokument-Kind (Markdown/Text/HTML) bzw. `document:closed` aufgerufen. */
export function clearImageView(): void {
    detachImgHandlers(getImg());
    const mount = getMount();
    if (mount) mount.innerHTML = '';
    currentPath = '';
    lastError = null;
    clearTransformState();
}

/** Nur fuer Tests/Diagnose: aktueller Pfad und letzter Fehler. */
export function getImageViewState(): { path: string; lastError: string | null } {
    return { path: currentPath, lastError };
}

/** Nur fuer Tests/Diagnose: aktueller Zoom/Pan-Stand. */
export function getImageTransformForTest(): Transform {
    return { scale: transform.scale, tx: transform.tx, ty: transform.ty };
}
