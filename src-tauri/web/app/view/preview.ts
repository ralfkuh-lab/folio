/* Live-Preview im View-/Split-Mode.

   Beim Tippen im Monaco-Editor wird der aktuelle Text debounced
   (adaptiv 150–600 ms, siehe DEBOUNCE_*) ans Backend
   (`render_markdown_preview`) geschickt; das Ergebnis (HTML + TOC)
   wird in die View-Region geschrieben — ohne dass die Datei
   gespeichert sein muss. Im Edit-Mode (View versteckt) wird der
   dirty-Text nur gecacht und beim Mode-Switch (`flushPreviewRender`)
   sofort gerendert.

   Race-Schutz: jeder Render-Aufruf erhaelt eine `renderGen`-Generation;
   Antworten mit alter Generation werden verworfen. Bei document-
   Lifecycle-Events (loaded/saved/closed/external-reload) wird
   `invalidatePreview` gerufen, damit verspaetete Preview-Renders nie
   den kanonischen Load/Save-Render ueberschreiben.

   Trigger: in-window CustomEvent `folio-editor-text-updated` aus
   `editor/bridge.ts` — bewusst nicht ueber den Tauri-`editor:event`-
   Channel, weil das ein IPC-Round-Trip pro Tastendruck waere.

   Gating: nur bei `body.kind-markdown` UND `currentPath != null`.
   Bewusst KEIN isDirty-Gate (Revert-auf-clean, s. gateOpen).
   Nicht-Markdown-Dateien (Text/Code/HTML/Image) bleiben beim
   kanonischen Backend-Render aus `document:loaded`/`saved` bzw.
   den eigenen Live-Pfaden (html.ts, code-live.ts). */

import { setTocList, rewriteRelativeAssets, ViewFinder, prepareMarkdownView } from './markdown';
import { highlightCodeBlocks } from './code-highlight';
import { addCodeCopyButtons } from './code-copy';
import { renderMermaidBlocks } from './mermaid';
import { afterMarkdownPreviewRender, setMarkdownHeadingMap } from './scroll-sync';
import { folioLog } from '../util/log';

type Deps = {
    getCurrentPath: () => string | null;
};

// Adaptive Debounce: Basis 150 ms fuer normale Docs; bei teuren
// Renders (grosse Docs) streckt sich das Delay bis max 600 ms, damit
// sich Render-Roundtrips nicht stauen. Formel: clamp(MIN, measured*2, MAX).
// Faktor 2: naechster Tipp-Burst bekommt Puffer in der Groessenordnung
// des letzten Roundtrips. Cap 600: spuerbar, aber kein "tot" wirkendes
// Preview. Glättung nur ueber die letzte Messung (kein EMA) — bei Doc-
// Wechsel reset, und ein Ausreisser heilt sich beim naechsten Render
// von selbst; EMA waere fuer den Nutzen hier Overkill.
const DEBOUNCE_MS_MIN = 150;
const DEBOUNCE_MS_MAX = 600;
const DEBOUNCE_FACTOR = 2;

let deps: Deps | null = null;
let renderGen = 0;
let pendingTimer: number | null = null;
let currentDebounceMs = DEBOUNCE_MS_MIN;

/** Ableitung des naechsten Debounce-Delays aus der gemessenen Render-
 *  Dauer (ms). Exportiert fuer Unit-Tests. */
export function deriveDebounceMs(renderMs: number): number {
    if (!Number.isFinite(renderMs) || renderMs < 0) return DEBOUNCE_MS_MIN;
    const scaled = renderMs * DEBOUNCE_FACTOR;
    return Math.min(DEBOUNCE_MS_MAX, Math.max(DEBOUNCE_MS_MIN, scaled));
}

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function gateOpen(): boolean {
    if (!deps) return false;
    if (deps.getCurrentPath() == null) return false;
    if (!document.body.classList.contains('kind-markdown')) return false;
    // Bewusst KEIN isDirty-Gate: wenn der User dirty wird, tippen,
    // dann auf cleanText zurueck-revertiert (z. B. Selection +
    // Backspace), wuerde markDirty(false) den Gate schliessen und die
    // View bliebe auf dem Pre-Revert-Render stehen. Ohne den Gate
    // rendern wir in diesem Fall einmal das identische HTML — kostet
    // nichts und haelt View + Editor konsistent. Race-Szenarien beim
    // doc-load/close sind durch currentPath + kind-markdown und JS-
    // Single-Threading abgedeckt.
    return true;
}

// edit-mode = View nicht sichtbar. split-mode + view-mode = sichtbar.
function viewVisible(): boolean {
    const b = document.body;
    return !b.classList.contains('edit-mode')
        || b.classList.contains('split-mode');
}

function getMarkdownBody(): HTMLElement | null {
    return document.querySelector('#view-region main.markdown-body') as HTMLElement | null;
}

type RenderPreview = {
    content: string;
    tocHtml: string;
    headingMap?: Array<{ slug: string; line: number }>;
};

function invokeRender(text: string): Promise<RenderPreview> {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') {
        return Promise.reject(new Error('Tauri core invoke not available'));
    }
    return core.invoke('render_markdown_preview', { text });
}

function currentEditorText(): string | null {
    const editor = (window as any).FolioEditor;
    // Vor dem ersten Mount gibt es keinen "Editor-Stand": getText()
    // wuerde '' liefern und ein Flush (z. B. app:set_mode beim
    // Boot-Session-Restore) den kanonischen View-Render mit leerem
    // HTML ueberschreiben (Bug: leere View nach Restore).
    if (!editor || typeof editor.hasEditor !== 'function' || !editor.hasEditor()) {
        return null;
    }
    if (editor && typeof editor.getText === 'function') {
        return editor.getText();
    }
    return null;
}

async function runRender(text: string, scrollToEnd = false): Promise<void> {
    const myGen = ++renderGen;
    const viewContent = $('view-content');
    const preInvokeScroll = viewContent ? viewContent.scrollTop : 0;
    const t0 = performance.now();

    let result: RenderPreview;
    try {
        result = await invokeRender(text);
    } catch (err) {
        folioLog.warn('preview', 'render_markdown_preview failed', { error: String(err) });
        return;
    }

    // Stale: zwischen Invoke-Start und -Resolve wurde eine neuere
    // Render-Generation gestartet — oder document:loaded/saved/closed
    // hat die Generation invalidiert. Antwort verwerfen, sonst
    // ueberschreiben wir den kanonischen Render.
    if (myGen !== renderGen) {
        folioLog.debug('preview', 'skip stale render', { gen: myGen, current: renderGen });
        return;
    }
    // Gate kann sich waehrend des Invoke geaendert haben (Doc geschlossen,
    // kind-Wechsel, dirty wurde clean).
    if (!gateOpen() || !viewVisible()) {
        folioLog.debug('preview', 'skip gate-closed', { gen: myGen });
        return;
    }

    // Scroll-Erhalt: wenn der User waehrend des Invoke gescrollt hat,
    // seinen aktuellen scrollTop respektieren; sonst Pre-Invoke-Position
    // restaurieren (innerHTML-Replace setzt scrollTop sonst auf 0).
    const userScrolledDuringRender = !!viewContent && viewContent.scrollTop !== preInvokeScroll;
    const targetScroll = userScrolledDuringRender ? viewContent.scrollTop : preInvokeScroll;

    applyToDom(result, targetScroll, userScrolledDuringRender, scrollToEnd);

    // Debounce-Messung: Invoke-Start bis Antwort angewandt (nach
    // synchronem DOM-Write). Nur hier — stale/gate-closed Renders
    // steuern das Delay nicht.
    const elapsed = performance.now() - t0;
    currentDebounceMs = deriveDebounceMs(elapsed);
    folioLog.debug('preview', 'applied', {
        gen: myGen,
        textLen: text.length,
        renderMs: Math.round(elapsed),
        nextDebounceMs: currentDebounceMs,
    });
}

function applyToDom(
    result: RenderPreview,
    targetScroll: number,
    userScrolledDuringRender: boolean,
    scrollToEnd: boolean,
): void {
    const body = getMarkdownBody();
    if (!body) return;

    body.innerHTML = result.content;

    if (deps) {
        const path = deps.getCurrentPath();
        if (path) rewriteRelativeAssets(body, path);
    }
    // highlightCodeBlocks ist async (Monaco colorize-Promise) und hat
    // intern einen `node.isConnected`-Stale-Schutz, der detached Writes
    // aus alten Render-Passes ignoriert.
    highlightCodeBlocks(body);
    addCodeCopyButtons(body);
    renderMermaidBlocks(body);
    prepareMarkdownView(body);
    setTocList(result.tocHtml);
    setMarkdownHeadingMap(result.headingMap || []);

    // Scroll restore — view-content ist der scrollende Container,
    // nicht view-region (das ist der Flex-Wrapper).
    const viewContent = $('view-content');
    if (viewContent) {
        viewContent.scrollTop = scrollToEnd ? viewContent.scrollHeight : targetScroll;
    }
    afterMarkdownPreviewRender(scrollToEnd || userScrolledDuringRender);

    // Find-Bar-Marker re-binden: nur wenn die Bar offen ist UND ein
    // Term gesetzt ist. Im Microtask getrennt vom Render, damit das
    // Layout der neuen innerHTML zuerst settle'n kann. `ViewFinder.
    // setFindTerm` cancelt seine eigene laufende Suche per Token, sodass
    // rapid re-renders nicht ineinander rauschen — kosten aber jeweils
    // einen vollen DOM-Scan, daher Gate auf nicht-leeren Term.
    const findBar = $('find-bar');
    if (findBar && findBar.classList.contains('open')) {
        const input = $('find-input') as HTMLInputElement | null;
        if (input && input.value) {
            setTimeout(function () { ViewFinder.setFindTerm(input.value); }, 0);
        }
    }
}

/** Editor-Text ist zu rendern; debounced (adaptiv 150–600 ms). Im
 *  Edit-Mode (View versteckt) tut der Pfad nichts — der Mode-Switch in
 *  shell.ts ruft `flushPreviewRender`, das den aktuellen Editor-Stand
 *  direkt nachholt. */
export function schedulePreviewRender(text: string): void {
    if (!gateOpen() || !viewVisible()) return;
    if (pendingTimer != null) {
        window.clearTimeout(pendingTimer);
    }
    pendingTimer = window.setTimeout(function () {
        pendingTimer = null;
        // Beim Timer-Fire den AKTUELLEN Editor-Stand holen statt den
        // beim Schedule-Aufruf closure-captured Text. Das macht den Pfad
        // robust gegen verlorengegangene editorTextChanged-Events: selbst
        // wenn ein Event verschluckt wurde, faengt der zuletzt gesetzte
        // Timer beim Feuern den richtigen Stand ab.
        const latest = currentEditorText();
        runRender(latest != null ? latest : text);
    }, currentDebounceMs);
    folioLog.debug('preview', 'scheduled', { textLen: text.length, debounceMs: currentDebounceMs });
}

/** Sofort rendern (kein Debounce). Wird beim Mode-Switch in view/split
 *  aufgerufen, damit der User nicht erst die alte gespeicherte Version
 *  sieht und dann das Update. */
export async function flushPreviewRender(): Promise<void> {
    if (pendingTimer != null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    if (!gateOpen() || !viewVisible()) return;
    const text = currentEditorText();
    if (text == null) return;
    await runRender(text);
}

/** Rendert den vom Backend akkumulierten Streaming-Text über denselben
 * Preview-/Generation-Pfad und hält die View am Dokumentende. */
export async function renderPreviewText(text: string): Promise<void> {
    if (pendingTimer != null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    if (!gateOpen() || !viewVisible()) return;
    await runRender(text, true);
}

/** Bei document:loaded/saved/closed aufgerufen. Bumpt die Generation,
 *  sodass pending Preview-Renders ignoriert werden.
 *  `resetDebounce: true` bei Dokumentwechsel (loaded/closed) — neues
 *  Dokument, frische Messung ab 150 ms. */
export function invalidatePreview(opts?: { resetDebounce?: boolean }): void {
    renderGen++;
    if (pendingTimer != null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    if (opts && opts.resetDebounce) {
        currentDebounceMs = DEBOUNCE_MS_MIN;
    }
}

export function initPreview(d: Deps): void {
    deps = d;
    window.addEventListener('folio-editor-text-updated', function (e: Event) {
        const detail = (e as CustomEvent).detail;
        const text = typeof detail === 'string' ? detail : String(detail || '');
        schedulePreviewRender(text);
    });
}
