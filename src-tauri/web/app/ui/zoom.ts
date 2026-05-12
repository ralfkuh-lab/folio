/* WebView-Zoom-Steuerung: Strg+Mausrad, Strg+0, Strg+± (auch Strg+'-').
   Persistiert in localStorage, wird beim Boot ohne Indicator-Flash
   reaktiviert. capture:true + stopPropagation greift, bevor Monaco das
   Wheel-Event im Editor-Fokus verschluckt. */

const ZOOM_KEY = 'folio.zoom';
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;

let current = 1.0;
let indicator: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

function showIndicator(z: number): void {
    if (!indicator) return;
    indicator.textContent = Math.round(z * 100) + ' %';
    indicator.hidden = false;
    // requestAnimationFrame, damit die Transition aus 'hidden' heraus greift.
    requestAnimationFrame(function () { indicator.classList.add('visible'); });
    if (hideTimer) clearTimeout(hideTimer);
    if (fadeTimer) clearTimeout(fadeTimer);
    hideTimer = setTimeout(function () {
        indicator.classList.remove('visible');
        fadeTimer = setTimeout(function () { indicator.hidden = true; }, 250);
    }, 1500);
}

function loadStoredZoom(): number {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY));
    return (isFinite(z) && z > 0) ? z : 1.0;
}

function applyZoom(z: number, opts?: { indicator?: boolean }): number {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
    current = z;
    // Native Webview-Zoom — passt Viewport-Einheiten korrekt an,
    // im Gegensatz zu document.documentElement.style.zoom.
    if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('set_webview_zoom', { zoom: z })
            .catch(function () { /* ignore */ });
    }
    try { localStorage.setItem(ZOOM_KEY, String(z)); } catch (_) { /* ignore */ }
    if (!opts || opts.indicator !== false) showIndicator(z);
    return z;
}

function adjustZoom(delta: number): number { return applyZoom(current + delta); }
function resetZoom(): number { return applyZoom(1.0); }

export function initZoom(): void {
    indicator = document.getElementById('zoom-indicator');

    // Beim Boot persistierten Zoom anwenden — ohne Indikator-Flash.
    applyZoom(loadStoredZoom(), { indicator: false });

    window.addEventListener('wheel', function (e: WheelEvent) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    }, { capture: true, passive: false });

    document.addEventListener('keydown', function (e: KeyboardEvent) {
        if (!e.ctrlKey && !e.metaKey) return;
        if (e.key === '0') { e.preventDefault(); resetZoom(); }
        else if (e.key === '+' || e.key === '=') { e.preventDefault(); adjustZoom(ZOOM_STEP); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); adjustZoom(-ZOOM_STEP); }
    });
}
