// Monaco-Adapter-Lifecycle: AMD-Loader-Init, `mount()`, Theme/Layout +
// die Text-Setter (`setText`). Diese Operationen sind die Schnittstelle
// zwischen Shell und Editor-Instanz; Lese-Operationen und detailliertere
// Text-/Selection-Manipulationen leben in `text.ts`.

import { attachEditorListeners } from './events';
import { clearFindDecorations, hasActiveTerm, recomputeMatches } from './find';
import { post } from './bridge';
import {
    disposeEditor,
    getEditor,
    getMonaco,
    setEditor,
    setMonaco,
    withProgrammaticWrite,
} from './state';
import { registerWikilinkCompletion } from './wikilink-complete';

let monacoReady: Promise<void> | null = null;
// `mountReady` ist bis zum ERSTEN erfolgreichen mount() ein pending
// Promise (nicht `Promise.resolve()`): die whenReady()-Defers in
// text.ts warten damit tatsaechlich auf den Editor, statt in einer
// Endlos-Microtask-Schleife sofort erneut zu feuern (der Bug, der bei
// Boot ohne Dokument + navigation:changed das gesamte Frontend killte).
let resolveFirstMount: (() => void) | null = null;
let mountReady: Promise<void> = new Promise(function (resolve) {
    resolveFirstMount = resolve;
});

interface TabModelEntry {
    model: any;
    viewState: any;
    path: string;
}

interface PendingDocument {
    tabId: number;
    path: string;
    text: string;
    language?: string;
}

// Monaco-Modelle gehoeren zu Backend-Tabs, nicht zu Dateipfaden. Dadurch
// bleiben Undo-Stack und Cursor auch bei Save-As/Rename innerhalb desselben
// Tabs erhalten.
const tabModels = new Map<number, TabModelEntry>();
let activeTabId: number | null = null;
let pendingDocument: PendingDocument | null = null;

// Pre-Mount-Wunschzustand fuer optionale Editor-Optionen, die schon
// beim Boot gesetzt werden (z. B. Minimap aus persistentem Panel-State).
// Wenn `mount()` noch nicht lief, gibt es keinen Editor zum
// updateOptions(). Der Wunsch wird hier gemerkt und im mount()-Callback
// in die create-Options gezogen — direkter als ein mountReady-Defer
// (und historisch: mountReady war frueher pre-mount bereits resolved,
// ein Defer war damals eine Endlos-Microtask-Schleife).
let pendingMinimapEnabled: boolean | null = null;

function loadMonaco(): Promise<void> {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise<void>((resolve, reject) => {
        if (window.monaco?.editor) {
            setMonaco(window.monaco);
            try { registerWikilinkCompletion(); } catch { /* ignore */ }
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
                // [[-Autocomplete (W4) — einmal nach AMD-Init, shared mit
                // Code-View über whenMonacoLoaded.
                try { registerWikilinkCompletion(); } catch { /* ignore */ }
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
const initialMonacoPromise = loadMonaco().then(function () {
    // Pfad, wenn Monaco bereits global war (kein require-Callback):
    try { registerWikilinkCompletion(); } catch { /* ignore */ }
});

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
        // Model EXPLIZIT erzeugen statt ueber `value` im create-Options-
        // Objekt: das implizite create-Model gehoert Monaco und wird beim
        // ersten editor.setModel(anderes) automatisch disposed — der
        // Tab-Model-Cache hielte dann eine tote Referenz und setModel
        // darauf wirft (Bug: leerer Editor + Phantom-Dirty nach
        // Session-Restore). Explizite Models besitzt unser Cache.
        const initialModel = monaco.editor.createModel(initialText || '', 'markdown');
        const editor = monaco.editor.create(el, {
            model: initialModel,
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
            // Monaco-internal context menu is English-only; disable like
            // view-code / diff-view (I3a). Folio does not ship Monaco i18n.
            contextmenu: false,
        });
        setEditor(editor);

        // Wie pendingMinimapEnabled ein echter Pre-Mount-Wunschzustand:
        // direkt im mount()-Callback anwenden statt via mountReady-Defer.
        if (pendingDocument) {
            const pending = pendingDocument;
            pendingDocument = null;
            doSetDocument(
                pending.tabId,
                pending.path,
                pending.text,
                pending.language,
            );
        }

        attachEditorListeners(editor, monaco);

        layout();
        post({ type: 'editorReady' });

        // Erster erfolgreicher Mount: das initiale pending mountReady
        // aufloesen, damit alle Pre-Mount-Defers jetzt (mit existierendem
        // Editor) genau einmal feuern.
        if (resolveFirstMount) {
            const resolve = resolveFirstMount;
            resolveFirstMount = null;
            resolve();
        }
    });
    return mountReady;
}

// Awaitable Ready-Promise für defensive Pre-Mount-Calls in `text.ts` &
// Co. — Programmatic Writes vor abgeschlossener Mount-Promise werden
// dadurch deferred statt silent verworfen (Phase-5-Race-Smell).
/** Existiert eine lebende Editor-Instanz? (Fuer Konsumenten ausserhalb
 *  des Editor-Bundles, z. B. den Live-Preview-Mount-Guard.) */
export function hasEditor(): boolean {
    return !!getEditor();
}

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
    const currentModel = editor.getModel();
    const currentLang = currentModel ? currentModel.getLanguageId() : '';
    // Ohne explizite Sprache die aktuelle Model-Sprache behalten:
    // automation:set_editor_text / shell:loadEditorText liefern keine —
    // ein Default auf plaintext wuerde unten den Model-Wechsel erzwingen
    // (Undo-Stack + Syntax-Highlighting weg), obwohl nur der Text
    // ersetzt werden soll.
    const lang = (language && language.trim()) || currentLang || 'plaintext';
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
            if (activeTabId !== null) {
                const entry = tabModels.get(activeTabId);
                if (entry && entry.model === currentModel) entry.model = fresh;
            }
            if (currentModel) currentModel.dispose();
        } else {
            editor.setValue(next);
        }
    });
    if (hasActiveTerm()) recomputeMatches();
}

/**
 * Aktiviert den Monaco-Model-Cache fuer ein `document:loaded`-Payload.
 * Derselbe Tab wird wie bisher ueber doSetText aktualisiert (Save/Reload);
 * beim Tab-Wechsel wird dagegen das gehaltene Model wieder eingesetzt.
 */
export function setDocument(
    tabId: number,
    path: string,
    text: string,
    language?: string,
): void {
    if (!Number.isFinite(tabId)) return;
    if (!getEditor()) {
        pendingDocument = { tabId, path: path || '', text: text || '', language };
        return;
    }
    doSetDocument(tabId, path || '', text || '', language);
}

function doSetDocument(
    tabId: number,
    path: string,
    text: string,
    language?: string,
): void {
    const editor = getEditor();
    if (!editor) return;
    const monaco = getMonaco();
    const nextLanguage = (language && language.trim()) || 'plaintext';
    const currentModel = editor.getModel();

    if (activeTabId === tabId) {
        let entry = tabModels.get(tabId);
        if (!entry && currentModel) {
            entry = { model: currentModel, viewState: null, path };
            tabModels.set(tabId, entry);
        }
        if (entry && entry.path !== path
            && entry.model.getValue() === (text || '')) {
            // Save-As/Rename bleibt derselbe Tab MIT unveraendertem
            // Inhalt: Model und Undo-Stack behalten, nur den
            // pfadabhaengigen Sprachmodus aktualisieren. Der
            // Inhaltsvergleich unterscheidet diesen Fall vom Ersetzen-
            // Open im selben Tab (Vault-Klick, History-Back) — dort MUSS
            // der neue Text gesetzt werden (Undo-Reset ist da korrekt).
            entry.path = path;
            if (entry.model.getLanguageId() !== nextLanguage
                && typeof monaco.editor.setModelLanguage === 'function') {
                monaco.editor.setModelLanguage(entry.model, nextLanguage);
            }
            return;
        }
        if (entry) entry.path = path;
        doSetText(text, language);
        return;
    }

    if (activeTabId !== null) {
        const previous = tabModels.get(activeTabId);
        if (previous && previous.model === currentModel
            && typeof editor.saveViewState === 'function') {
            previous.viewState = editor.saveViewState();
        }
    }

    let target = tabModels.get(tabId);
    if (!target) {
        // Beim allerersten Dokument das von editor.create() angelegte Model
        // weiterverwenden; danach erhalten Cache-Misses ein eigenes Model.
        if (activeTabId === null && currentModel) {
            target = { model: currentModel, viewState: null, path };
            tabModels.set(tabId, target);
            activeTabId = tabId;
            doSetText(text, language);
            return;
        }
        target = {
            model: monaco.editor.createModel(text || '', nextLanguage),
            viewState: null,
            path,
        };
        tabModels.set(tabId, target);
    } else if (typeof target.model.isDisposed === 'function' && target.model.isDisposed()) {
        // Defensive Selbstheilung: tote Model-Referenz (z. B. durch
        // externes Disposal) verwerfen und aus dem Payload neu bauen —
        // setModel auf einem disposed Model wuerde werfen und den
        // Tab-Wechsel-Handler killen.
        target = {
            model: monaco.editor.createModel(text || '', nextLanguage),
            viewState: null,
            path,
        };
        tabModels.set(tabId, target);
    } else {
        target.path = path;
        const currentLanguage = target.model.getLanguageId();
        if (currentLanguage !== nextLanguage
            && typeof monaco.editor.setModelLanguage === 'function') {
            // Sprache ist Model-State. setModelLanguage behaelt den Undo-
            // Stack, anders als ein frisches Model beim normalen setText-
            // Sprachwechsel.
            monaco.editor.setModelLanguage(target.model, nextLanguage);
        }
    }

    withProgrammaticWrite(() => {
        clearFindDecorations();
        editor.setModel(target!.model);
    });
    activeTabId = tabId;
    if (target.viewState && typeof editor.restoreViewState === 'function') {
        editor.restoreViewState(target.viewState);
    }
    if (hasActiveTerm()) recomputeMatches();
}

/** Entfernt Models geschlossener bzw. leer gewordener Tabs. */
export function syncTabModels(openDocumentTabIds: number[]): void {
    const keep = new Set(openDocumentTabIds);
    for (const id of Array.from(tabModels.keys())) {
        if (!keep.has(id)) disposeTabModel(id);
    }
}

/** Sofortiger Cleanup fuer `document:closed`; tabs:changed ist das Backup. */
export function closeDocument(tabId: number): void {
    if (!Number.isFinite(tabId)) return;
    disposeTabModel(tabId);
}

function disposeTabModel(tabId: number): void {
    const entry = tabModels.get(tabId);
    if (!entry) return;
    const editor = getEditor();
    const isActiveModel = activeTabId === tabId
        && editor
        && editor.getModel() === entry.model;

    if (isActiveModel) {
        withProgrammaticWrite(() => {
            editor.setModel(null);
        });
        activeTabId = null;
    }
    entry.model.dispose();
    tabModels.delete(tabId);
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
        // Historie: mountReady war frueher pre-mount bereits resolved,
        // ein `mountReady.then(setMinimap)`-Defer war damit eine
        // Endlos-Microtask-Schleife ("nichts funktioniert mehr"-Bug
        // 2026-05-19; seit 2026-07-04 ist mountReady bis zum ersten
        // Mount pending und die Defers in text.ts sind single-shot).
        pendingMinimapEnabled = !!enabled;
        return;
    }
    editor.updateOptions({ minimap: { enabled: !!enabled } });
}

export function layout(): void {
    const editor = getEditor();
    if (editor) editor.layout();
}
