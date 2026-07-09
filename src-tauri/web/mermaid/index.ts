// Mermaid Lazy-Bundle: wird NICHT in app.bundle.js gebundelt (~2 MB).
// Exponiert schlanke Surface unter window.FolioMermaid.
// Lazy via <script src="mermaid.bundle.js"> in view/mermaid.ts injiziert.

import mermaid from 'mermaid';

type RenderResult = { svg: string };

let currentTheme: 'default' | 'dark' | null = null;

function ensureInitialized(dark: boolean): void {
    const wanted: 'default' | 'dark' = dark ? 'dark' : 'default';
    if (currentTheme === wanted) {
        return;
    }
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        // Kein Fehler-DOM (Bomben-SVG/div#d<id>) an document.body haengen —
        // der Fehlerpfad in view/mermaid.ts stellt den Code-Block + Hinweis
        // selbst dar. Der cleanupStray-Pfad bleibt als Belt-and-Braces.
        suppressErrorRendering: true,
        theme: wanted,
    });
    currentTheme = wanted;
}

/**
 * Rendert ein Mermaid-Diagramm und liefert das SVG-String zurueck.
 * Schreibt NICHT ins DOM (DOM-Kontrolle liegt beim Caller in view/mermaid.ts).
 * Wirft bei Parse-Fehler.
 */
// Versteckter Scratch-Container fuer mermaids Render-/Mess-Phase. Ohne
// dritten render()-Parameter arbeitet mermaid direkt an document.body und
// laesst dort bei Parse-Fehlern Artefakte liegen — die Einfuegung passiert
// teils in einem internen Microtask NACH der Rejection, ist also vom
// Caller aus nicht deterministisch aufraeumbar. Im Scratch-Container sind
// auch verspaetete Artefakte unsichtbar und werden beim naechsten Render
// weggeraeumt.
let scratch: HTMLElement | null = null;

function getScratch(): HTMLElement {
    if (!scratch || !scratch.isConnected) {
        scratch = document.createElement('div');
        scratch.id = 'folio-mermaid-scratch';
        scratch.setAttribute('aria-hidden', 'true');
        scratch.style.position = 'absolute';
        scratch.style.left = '-99999px';
        scratch.style.top = '0';
        document.body.appendChild(scratch);
    }
    return scratch;
}

export async function render(source: string, dark: boolean): Promise<string> {
    ensureInitialized(dark);
    // Eindeutige ID pro Render-Aufruf (Mermaid-Anforderung).
    const id = 'mermaid-diag-' + Math.random().toString(36).slice(2, 10);
    // Eigene Zelle PRO Aufruf: Renders laufen parallel (fire-and-forget in
    // view/mermaid.ts) — ein geteilter Container, der zwischendrin geleert
    // wird, zerschiesst laufenden Rendern das Arbeits-DOM.
    const host = getScratch();
    const cell = document.createElement('div');
    host.appendChild(cell);
    try {
        const res: RenderResult = await mermaid.render(id, source, cell);
        return res.svg;
    } finally {
        cell.remove();
    }
}

// Globale Surface fuer das injizierte Bundle (iife).
// Wird von view/mermaid.ts nach dem Script-Load abgefragt.
(window as any).FolioMermaid = { render };
