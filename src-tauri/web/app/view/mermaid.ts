// Mermaid-Postprocessing fuer .markdown-body (View/Split/Live-Preview).
// Analog zu code-highlight.ts: comrak liefert <pre><code class="language-mermaid">,
// wir ersetzen durch gerendertes SVG in .mermaid-diagram.
//
// - Eigenes Lazy-Bundle (mermaid.bundle.js), NICHT Teil von app.bundle.js.
// - Idempotenz via (source, theme)-Cache: unveraenderte Bloecke flackern nicht
//   bei Preview-Re-Renders.
// - Theme-Wechsel triggert Re-Render existierender Diagramme.
// - Fehler: originaler Code-Block bleibt + .mermaid-error; Stray-SVGs von
//   mermaid v11 bei Parse-Fehlern werden aufgeraeumt.
// - Race: pro-Element Generation + isConnected + in-flight Dedupe.
// - Lazy: Bundle wird nur geladen, wenn tatsaechlich Mermaid-Bloecke vorhanden sind.

import { folioLog } from '../util/log';

const SOURCE_ATTR = 'data-folio-source';
const THEME_ATTR = 'data-folio-theme';
const GEN_ATTR = 'data-folio-mermaid-gen';

let mermaidApi: { render: (source: string, dark: boolean) => Promise<string> } | null = null;
let loadPromise: Promise<any> | null = null;

// Bounded caches (FIFO via Map insertion order, max 100 Eintraege).
const svgCache = new Map<string, string>();
const errorCache = new Map<string, string>();
const PENDING_MAX = 100;

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max = PENDING_MAX): void {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > max) {
        const oldest = map.keys().next().value as K;
        map.delete(oldest);
    }
}

// In-flight Dedupe: gleicher (source+theme) wartet auf laufendes Promise.
const pendingRenders = new Map<string, Promise<string>>();

function isDarkMode(): boolean {
    return document.documentElement.classList.contains('theme-dark');
}

function cacheKey(source: string, dark: boolean): string {
    return source + '\u0000' + (dark ? 'd' : 'l');
}

async function ensureMermaidLoaded(): Promise<any> {
    if (mermaidApi) return mermaidApi;
    const w = window as any;
    if (w.FolioMermaid && typeof w.FolioMermaid.render === 'function') {
        mermaidApi = w.FolioMermaid;
        return mermaidApi;
    }
    if (loadPromise) return loadPromise;

    loadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'mermaid.bundle.js';
        script.onload = () => {
            const api = (window as any).FolioMermaid;
            if (api && typeof api.render === 'function') {
                mermaidApi = api;
                resolve(api);
            } else {
                // Surface nicht gefunden: reset fuer Retry
                loadPromise = null;
                try { script.parentNode?.removeChild(script); } catch (_) {}
                reject(new Error('FolioMermaid surface nicht gefunden'));
            }
        };
        script.onerror = () => {
            loadPromise = null;
            try { script.parentNode?.removeChild(script); } catch (_) {}
            reject(new Error('Laden von mermaid.bundle.js fehlgeschlagen'));
        };
        document.head.appendChild(script);
    });
    return loadPromise;
}

/**
 * Entfernt mermaid-Fehler-Artefakte an document.body. WICHTIG: mermaid v11
 * fuegt das Artefakt (div#d<renderId>) in einem eigenen internen
 * catch-Microtask NACH der Rejection ein — ein rein synchroner Cleanup im
 * Caller-catch (und selbst ein finally im Bundle-Wrapper) laeuft davor ins
 * Leere. Deshalb zusaetzlich verzoegert aufraeumen.
 */
function cleanupStrayMermaidLater(): void {
    cleanupStrayMermaidSvg();
    window.setTimeout(cleanupStrayMermaidSvg, 0);
    window.setTimeout(cleanupStrayMermaidSvg, 150);
}

function cleanupStrayMermaidSvg(): void {
    try {
        // mermaid v11 haengt bei Parse-Fehlern je nach Pfad ein <svg> ODER
        // einen <div id="d<renderId>">-Container direkt an den Body.
        const candidates = document.querySelectorAll('body > svg, body > div[id]');
        candidates.forEach((s) => {
            const id = (s as HTMLElement).id || '';
            // Nur IDs mit bekanntem Render-Praefix (vom Bundle generiert
            // oder mermaid-intern 'd' + Render-ID).
            if (id.startsWith('mermaid-diag-') || id.startsWith('dmermaid-diag-')) {
                s.parentNode?.removeChild(s);
            }
        });
    } catch (_) {
        /* best effort */
    }
}

function extractFirstErrorLine(err: unknown): string {
    const raw = String((err as any)?.message || err || 'unbekannter Mermaid-Fehler');
    const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || raw;
    return line.length > 120 ? line.slice(0, 117) + '...' : line;
}

function insertErrorAfter(pre: HTMLElement, msg: string): void {
    const next = pre.nextElementSibling as HTMLElement | null;
    if (next && next.classList.contains('mermaid-error')) {
        next.textContent = msg;
        return;
    }
    const err = document.createElement('div');
    err.className = 'mermaid-error';
    err.textContent = msg;
    pre.insertAdjacentElement('afterend', err);
}

function restorePreWithError(div: HTMLElement, source: string, msg: string): void {
    if (!div.isConnected || !div.parentElement) return;
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.setAttribute(SOURCE_ATTR, source);
    code.textContent = source;
    pre.appendChild(code);
    // Erst ersetzen, dann Hinweis via insertErrorAfter — das dedupliziert
    // gegen einen evtl. schon vorhandenen .mermaid-error hinter dem Block
    // (z. B. aus dem vorherigen Theme: der errorCache-Key ist theme-
    // abhaengig, der Fehlerpfad laeuft nach einem Wechsel erneut).
    div.replaceWith(pre);
    insertErrorAfter(pre, msg);
}

function hasMermaidContent(root: HTMLElement): boolean {
    if (root.querySelector(`.mermaid-diagram[${SOURCE_ATTR}]`)) return true;
    const codes = root.querySelectorAll('pre > code');
    for (const c of Array.from(codes)) {
        if ((c as HTMLElement).classList.contains('language-mermaid')) return true;
    }
    return false;
}

function getGen(div: HTMLElement): number {
    return parseInt(div.getAttribute(GEN_ATTR) || '0', 10) || 0;
}

function setGen(div: HTMLElement, gen: number): void {
    div.setAttribute(GEN_ATTR, String(gen));
}

/**
 * Ersetzt alle Mermaid-Code-Bloecke unter root durch gerenderte Diagramme.
 * Wird nach jedem body.innerHTML (document:loaded, preview apply) sowie
 * nach Theme-Wechsel aufgerufen (analog highlightCodeBlocks).
 */
export async function renderMermaidBlocks(root: HTMLElement | null): Promise<void> {
    if (!root) return;

    // WICHTIG: Lazy-Check VOR jedem Load-Versuch. Nur laden, wenn tatsaechlich Mermaid vorhanden.
    if (!hasMermaidContent(root)) {
        return;
    }

    const dark = isDarkMode();
    let api: any;
    try {
        api = await ensureMermaidLoaded();
    } catch (e) {
        folioLog.warn('mermaid', 'Mermaid-Bundle konnte nicht geladen werden', { error: String(e) });
        return;
    }

    // --- Existierende Diagramme (Theme-Wechsel-Pfad; DOM nicht ersetzt) ---
    const existingDiagrams = root.querySelectorAll<HTMLElement>(`.mermaid-diagram[${SOURCE_ATTR}]`);
    for (const div of Array.from(existingDiagrams)) {
        const source = div.getAttribute(SOURCE_ATTR) || '';
        const prevTheme = div.getAttribute(THEME_ATTR) || '';
        const want = dark ? 'dark' : 'light';
        if (prevTheme === want && div.querySelector('svg')) {
            continue; // bereits korrekt
        }
        const key = cacheKey(source, dark);
        div.setAttribute(THEME_ATTR, want);
        if (svgCache.has(key)) {
            div.innerHTML = svgCache.get(key)!;
            continue;
        }
        if (!div.isConnected) continue;

        // Generation fuer dieses Element
        const myGen = getGen(div) + 1;
        setGen(div, myGen);

        // In-flight Dedupe
        let p = pendingRenders.get(key);
        if (!p) {
            p = (async () => {
                try {
                    return await api.render(source, dark);
                } finally {
                    // Entferne nach Abschluss (auch bei Fehler), damit Folgefehler nicht haengen
                    pendingRenders.delete(key);
                }
            })();
            boundedSet(pendingRenders, key, p);
        }

        try {
            const svg = await p;
            if (!div.isConnected) continue;
            if (getGen(div) !== myGen) continue; // verworfen durch spaeteren Pass
            div.innerHTML = svg;
            boundedSet(svgCache, key, svg);
        } catch (err) {
            cleanupStrayMermaidLater();
            folioLog.warn('mermaid', 'Mermaid Re-Render (Theme) fehlgeschlagen', { error: String(err) });
            if (!div.isConnected || getGen(div) !== myGen) continue;
            const msg = extractFirstErrorLine(err);
            boundedSet(errorCache, key, msg);
            const preLike = document.createElement('pre');
            const c = document.createElement('code');
            c.className = 'language-mermaid';
            c.textContent = source;
            preLike.appendChild(c);
            div.replaceWith(preLike);
            insertErrorAfter(preLike, msg);
        }
    }

    // --- Frische Bloecke aus comrak-Render (exakte class language-mermaid) ---
    const codeEls = root.querySelectorAll<HTMLElement>('pre > code');
    const fresh = Array.from(codeEls).filter(c => c.classList.contains('language-mermaid'));
    if (fresh.length > 0) {
        folioLog.debug('mermaid', 'renderMermaidBlocks start', { blocks: fresh.length });
    }

    for (const code of fresh) {
        const pre = code.parentElement as HTMLElement | null;
        if (!pre || !pre.parentElement) continue;

        let source = code.getAttribute(SOURCE_ATTR);
        if (source === null) {
            source = code.textContent || '';
            code.setAttribute(SOURCE_ATTR, source);
        }
        const key = cacheKey(source, dark);

        if (errorCache.has(key)) {
            // Bekannter Fehler: Pre lassen + Error-Hinweis (kein Render-Versuch)
            insertErrorAfter(pre, errorCache.get(key)!);
            continue;
        }

        // Ersetze Pre sofort durch Platzhalter-Div (stabilisiert Position)
        const div = document.createElement('div');
        div.className = 'mermaid-diagram';
        div.setAttribute(SOURCE_ATTR, source);
        div.setAttribute(THEME_ATTR, dark ? 'dark' : 'light');
        pre.replaceWith(div);

        if (svgCache.has(key)) {
            div.innerHTML = svgCache.get(key)!;
            continue;
        }

        // Generation + Dedupe + Race-Schutz
        const myGen = getGen(div) + 1;
        setGen(div, myGen);

        let p = pendingRenders.get(key);
        if (!p) {
            p = (async () => {
                try {
                    return await api.render(source, dark);
                } finally {
                    pendingRenders.delete(key);
                }
            })();
            boundedSet(pendingRenders, key, p);
        }

        // Fire-and-forget mit Guards (kein Blocken des Loops)
        (async () => {
            try {
                const svg = await p;
                if (!div.isConnected) return;
                if (getGen(div) !== myGen) return;
                div.innerHTML = svg;
                boundedSet(svgCache, key, svg);
            } catch (err) {
                cleanupStrayMermaidLater();
                const msg = extractFirstErrorLine(err);
                boundedSet(errorCache, key, msg);
                if (div.isConnected && getGen(div) === myGen) {
                    restorePreWithError(div, source, msg);
                }
                folioLog.warn('mermaid', 'Mermaid render failed', {
                    preview: source.slice(0, 60),
                    error: String(err),
                });
            }
        })();
    }
}

export type MermaidSvgEntry = { source: string; svg: string | null };

/**
 * Rendert eine Liste von Mermaid-Quellen fuer den Export (immer light/default Theme).
 * Liefert Paare {source, svg} zurueck (source-Identitaet fuer Backend-Match).
 * Bei Render-Fehler svg=null (Backend faellt dann auf Code-Block zurueck).
 */
export async function renderMermaidForExport(sources: string[]): Promise<MermaidSvgEntry[]> {
    if (sources.length === 0) {
        return [];
    }
    let api: any;
    try {
        api = await ensureMermaidLoaded();
    } catch (e) {
        folioLog.warn('mermaid', 'Mermaid-Bundle für Export konnte nicht geladen werden', { error: String(e) });
        return sources.map((source) => ({ source, svg: null }));
    }
    const results: MermaidSvgEntry[] = [];
    for (const source of sources) {
        try {
            // Export verwendet IMMER die light Variante.
            const svg = await api.render(source, false);
            results.push({ source, svg });
        } catch (err) {
            cleanupStrayMermaidLater();
            folioLog.warn('mermaid', 'Mermaid Export-Render fehlgeschlagen', { error: String(err) });
            results.push({ source, svg: null });
        }
    }
    return results;
}

// Expose fuer E2E (/eval in 43_mermaid_export.py). Wird NICHT fuer normale
// App-View oder Dialog-Logik benoetigt.
(window as any).__renderMermaidForExport = renderMermaidForExport;

