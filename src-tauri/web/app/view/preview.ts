/* Live-Preview im View-/Split-Mode.

   Beim Tippen im Monaco-Editor wird der aktuelle Text debounced
   (150 ms) ans Backend (`render_markdown_preview`) geschickt; das
   Ergebnis (HTML + TOC) wird in die View-Region geschrieben — ohne
   dass die Datei gespeichert sein muss. Im Edit-Mode (View versteckt)
   wird der dirty-Text nur gecacht und beim Mode-Switch
   (`flushPreviewRender`) sofort gerendert.

   Race-Schutz: jeder Render-Aufruf erhaelt eine `renderGen`-Generation;
   Antworten mit alter Generation werden verworfen. Bei document-
   Lifecycle-Events (loaded/saved/closed/external-reload) wird
   `invalidatePreview` gerufen, damit verspaetete Preview-Renders nie
   den kanonischen Load/Save-Render ueberschreiben.

   Trigger: in-window CustomEvent `folio-editor-text-updated` aus
   `editor/bridge.ts` — bewusst nicht ueber den Tauri-`editor:event`-
   Channel, weil das ein IPC-Round-Trip pro Tastendruck waere.

   Gating: nur bei `body.kind-markdown` UND `currentPath != null` UND
   `isDirty()`. Nicht-Markdown-Dateien (Text/Code/HTML/Image) bleiben
   beim kanonischen Backend-Render aus `document:loaded`/`saved`. */

import { setTocList, rewriteRelativeAssets, ViewFinder } from './markdown';
import { highlightCodeBlocks } from './code-highlight';
import { afterMarkdownPreviewRender, setMarkdownHeadingMap } from './scroll-sync';
import { folioLog } from '../util/log';

type Deps = {
    getCurrentPath: () => string | null;
};

const DEBOUNCE_MS = 150;

let deps: Deps | null = null;
let renderGen = 0;
let pendingTimer: number | null = null;

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
    if (editor && typeof editor.getText === 'function') {
        return editor.getText();
    }
    return null;
}

async function runRender(text: string): Promise<void> {
    const myGen = ++renderGen;
    const viewContent = $('view-content');
    const preInvokeScroll = viewContent ? viewContent.scrollTop : 0;

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

    applyToDom(result, targetScroll, userScrolledDuringRender);
    folioLog.debug('preview', 'applied', { gen: myGen, textLen: text.length });
}

function applyToDom(
    result: RenderPreview,
    targetScroll: number,
    userScrolledDuringRender: boolean,
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
    setTocList(result.tocHtml);
    setMarkdownHeadingMap(result.headingMap || []);

    // Scroll restore — view-content ist der scrollende Container,
    // nicht view-region (das ist der Flex-Wrapper).
    const viewContent = $('view-content');
    if (viewContent) viewContent.scrollTop = targetScroll;
    afterMarkdownPreviewRender(userScrolledDuringRender);

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

/** Editor-Text ist zu rendern; debounced 150 ms. Im Edit-Mode (View
 *  versteckt) tut der Pfad nichts — der Mode-Switch in shell.ts ruft
 *  `flushPreviewRender`, das den aktuellen Editor-Stand direkt nachholt. */
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
    }, DEBOUNCE_MS);
    folioLog.debug('preview', 'scheduled', { textLen: text.length });
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

/** Bei document:loaded/saved/closed aufgerufen. Bumpt die Generation,
 *  sodass pending Preview-Renders ignoriert werden. */
export function invalidatePreview(): void {
    renderGen++;
    if (pendingTimer != null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
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
