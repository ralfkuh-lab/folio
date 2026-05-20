// Monaco-Adapter-Lifecycle: AMD-Loader-Init, `mount()`, Theme/Layout +
// die Text-Setter (`setText`). Diese Operationen sind die Schnittstelle
// zwischen Shell und Editor-Instanz; Lese-Operationen und detailliertere
// Text-/Selection-Manipulationen leben in `text.ts`.

import { attachEditorListeners } from './events';
import { hasActiveTerm, recomputeMatches } from './find';
import { post } from './bridge';
import {
    disposeEditor,
    getEditor,
    getMonaco,
    setEditor,
    setMonaco,
    withProgrammaticWrite,
} from './state';

let monacoReady: Promise<void> | null = null;
let mountReady: Promise<void> = Promise.resolve();

// Pre-Mount-Wunschzustand fuer optionale Editor-Optionen, die schon
// beim Boot gesetzt werden (z. B. Minimap aus persistentem Panel-State).
// Wenn `mount()` noch nicht lief, gibt es keinen Editor zum
// updateOptions(), und ein Defer auf `mountReady` waere eine
// Endlos-Microtask-Schleife (mountReady ist bis zum ersten mount()
// `Promise.resolve()`-vorbelegt). Stattdessen merken wir uns hier den
// Wunsch und applien ihn im mount()-Callback.
let pendingMinimapEnabled: boolean | null = null;

function loadMonaco(): Promise<void> {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise<void>((resolve, reject) => {
        if (window.monaco?.editor) {
            setMonaco(window.monaco);
            resolve();
            return;
        }
        if (typeof window.require === 'undefined') {
            reject(new Error('Monaco loader (window.require) not available'));
            return;
        }
        // Sprach-Worker-Bootstrap: ohne diesen Hook starten Monacos
        // JSON-/TS-/CSS-Worker im AMD-Setup nicht, weshalb z. B. "Format
        // Document" auf JSON still fehlschlaegt. Wir liefern eine kleine
        // Bootstrap-Worker-Datei zurueck — der Worker setzt sein eigenes
        // MonacoEnvironment.baseUrl auf den absoluten Origin des Frontends
        // und delegiert via importScripts an Monacos workerMain.js.
        // Wichtig: Blob-URL statt data:-URL. WebKit (macOS) behandelt
        // Worker aus data:-URLs als opaque origin und blockt deren
        // Ladevorgang ("Load failed" in editor.main.js), waehrend Blob-
        // URLs die Document-Origin erben — funktioniert in WKWebView
        // (macOS), WebKitGTK (Linux) und WebView2 (Windows).
        const origin = window.location.origin;
        const workerBootstrap = `self.MonacoEnvironment = { baseUrl: '${origin}/monaco/' };`
            + `importScripts('${origin}/monaco/vs/base/worker/workerMain.js');`;
        const workerBlob = new Blob([workerBootstrap], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(workerBlob);
        (window as any).MonacoEnvironment = {
            getWorkerUrl: function (_workerId: string, _label: string): string {
                return workerUrl;
            },
        };
        try {
            window.require.config({ paths: { vs: 'monaco/vs' } });
        } catch (e) {
            reject(e);
            return;
        }
        window.require(
            ['vs/editor/editor.main'],
            () => {
                if (!window.monaco?.editor) {
                    reject(new Error('Monaco AMD loader finished without window.monaco.editor'));
                    return;
                }
                setMonaco(window.monaco);
                resolve();
            },
            (err: any) => {
                console.error('[folio-editor] Monaco load failed:', err);
                reject(err);
            },
        );
    });
    return monacoReady;
}

// Monaco-Load wird zum Bundle-Init getriggert (verhalten wie früher in
// `editor.ts`-Monolith: `const monacoPromise = loadMonaco()` am Modul-Top).
const initialMonacoPromise = loadMonaco();

/**
 * Resolved sobald der Monaco-AMD-Loader durch ist und `window.monaco.editor`
 * zur Verfuegung steht. Geteilt zwischen Edit-Editor (`mount()`) und Code-
 * View (`editor/view-code.ts`), sodass beide auf einer einzigen AMD-Init
 * sitzen.
 */
export function whenMonacoLoaded(): Promise<void> {
    return initialMonacoPromise;
}

export function mount(elementId: string, initialText: string): Promise<void> {
    mountReady = initialMonacoPromise.then(() => {
        const el = document.getElementById(elementId);
        if (!el) {
            console.error("[folio-editor] mount target '" + elementId + "' not found");
            return;
        }
        disposeEditor();

        const monaco = getMonaco();
        const isDark = document.documentElement.classList.contains('theme-dark');

        // Pre-Mount-Wunschzustand (siehe oben) sofort in die initialen
        // create-Options ziehen — kein nachgelagertes updateOptions noetig.
        const minimapEnabled =
            pendingMinimapEnabled === null ? false : pendingMinimapEnabled;
        pendingMinimapEnabled = null;
        const editor = monaco.editor.create(el, {
            value: initialText || '',
            language: 'markdown',
            theme: isDark ? 'vs-dark' : 'vs',
            automaticLayout: true,
            minimap: { enabled: minimapEnabled },
            lineNumbers: 'on',
            wordWrap: 'on',
            folding: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            fontSize: 13.5,
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
            padding: { top: 12, bottom: 12 },
        });
        setEditor(editor);

        attachEditorListeners(editor, monaco);

        layout();
        post({ type: 'editorReady' });
    });
    return mountReady;
}

// Awaitable Ready-Promise für defensive Pre-Mount-Calls in `text.ts` &
// Co. — Programmatic Writes vor abgeschlossener Mount-Promise werden
// dadurch deferred statt silent verworfen (Phase-5-Race-Smell).
export function whenReady(): Promise<void> {
    return mountReady;
}

export function setText(text: string, language?: string): void {
    if (!getEditor()) {
        mountReady.then(() => doSetText(text, language));
        return;
    }
    doSetText(text, language);
}

function doSetText(text: string, language?: string): void {
    const editor = getEditor();
    if (!editor) return;
    const monaco = getMonaco();
    const next = text || '';
    const lang = (language && language.trim()) || 'plaintext';
    const currentModel = editor.getModel();
    const currentLang = currentModel ? currentModel.getLanguageId() : '';
    const sameText = currentModel && currentModel.getValue() === next;
    const sameLang = currentLang === lang;
    if (sameText && sameLang) return;

    withProgrammaticWrite(() => {
        if (!sameLang) {
            // Sprache wechselt: frischen Model anlegen, alten verwerfen.
            // setModelLanguage() würde reichen, aber ein frischer Model
            // resettet auch die Tokenizer-/Decoration-State sauber.
            const fresh = monaco.editor.createModel(next, lang);
            editor.setModel(fresh);
            if (currentModel) currentModel.dispose();
        } else {
            editor.setValue(next);
        }
    });
    if (hasActiveTerm()) recomputeMatches();
}

export function setTheme(mode: 'light' | 'dark'): void {
    const monaco = getMonaco();
    if (!monaco || !getEditor()) return;
    monaco.editor.setTheme(mode === 'dark' ? 'vs-dark' : 'vs');
}

export function setMinimap(enabled: boolean): void {
    const editor = getEditor();
    if (!editor) {
        // Pre-Mount: Wunsch in `pendingMinimapEnabled` merken — der
        // `mount()`-Callback zieht ihn in die initialen Create-Options.
        // Kein `mountReady.then(setMinimap)`-Defer: `mountReady` ist bis
        // zum ersten Mount `Promise.resolve()` (already-resolved), ein
        // Defer waere damit eine Endlos-Microtask-Schleife, die die
        // Event-Loop blockt und das gesamte Frontend-Init kaputtmacht.
        // Genau das war der Bug, der bei Folio-Start ohne offene Datei
        // zu "nichts funktioniert mehr" fuehrte (2026-05-19).
        pendingMinimapEnabled = !!enabled;
        return;
    }
    editor.updateOptions({ minimap: { enabled: !!enabled } });
}

export function layout(): void {
    const editor = getEditor();
    if (editor) editor.layout();
}
