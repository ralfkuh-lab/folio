// Code-View: read-only Monaco-Instanz fuer den View-Mode von Non-Markdown-
// Text-Dateien (JSON, XML, YAML, Source-Code, …). Eigenstaendig zur Edit-
// Mode-Instanz aus `mount.ts`, teilt aber denselben AMD-Loader
// (`whenMonacoLoaded`), sodass Monaco genau einmal geladen wird.
//
// Auto-Format: einheitlich ueber Monacos eingebauten `formatDocument`-
// Pfad fuer alle Sprachen (inkl. JSON). Keine Sonderbehandlung — wenn
// fuer eine Sprache kein Formatter registriert ist, wird der rohe Inhalt
// gezeigt (Highlighting/Folding/Find sind trotzdem da).

import { whenMonacoLoaded } from './mount';
import { getMonaco, setMonaco } from './state';

let editor: any = null;
let model: any = null;
let mountedElementId: string | null = null;
let pendingTheme: 'light' | 'dark' | null = null;

function ensureMonaco(): Promise<any> {
    return whenMonacoLoaded().then(() => {
        // `state.getMonaco()` ist erst befuellt, nachdem mount.ts ihn beim
        // ersten Editor-Mount via setMonaco gesetzt hat. Beim Code-View
        // wollen wir Monaco auch dann nutzen, wenn der Edit-Editor noch
        // nie gemounted wurde — daher faulen-faellig nachholen.
        if (!getMonaco() && (window as any).monaco?.editor) {
            setMonaco((window as any).monaco);
        }
        return getMonaco();
    });
}

// Best-Effort-Autoformat: Monacos eingebauter Formatter wird asynchron
// getriggert — fuer alle Sprachen, fuer die ein Formatter registriert
// ist (JSON, XML, HTML, CSS, JS/TS, …). Fehler/fehlender Formatter
// werden still verschluckt — der Rohinhalt bleibt sichtbar. Plaintext
// wird ausgespart, weil dort sowieso nichts zu formatieren ist.
//
// WARUM einheitlich Monaco statt eigenem JSON-Pretty: Konsistenz zwischen
// Edit- und View-Mode. Wenn der User im Edit-Mode mit Strg+Shift+F
// (Monacos formatDocument) formatiert und dann in den View-Mode wechselt,
// muss die Ansicht IDENTISCH aussehen — sonst gibt es Diskrepanzen bei
// Indents, Trailing-Newline, Key-Order etc.
//
// readOnly umgehen: Monacos `editor.action.formatDocument` will Edits
// gegen das Editor-Model ausfuehren und sieht `readOnly: true` als Stop.
// Wir heben das fuer den Formatter-Aufruf kurz auf und setzen es danach
// zurueck. User-Input ist trotzdem geblockt, weil `domReadOnly: true`
// bleibt — der DOM-Layer akzeptiert keine Tastatur-Edits.
function runAutoFormat(language: string): void {
    if (!editor) return;
    if (language === 'plaintext') return;
    setTimeout(function () {
        if (!editor) return;
        var action = editor.getAction && editor.getAction('editor.action.formatDocument');
        if (!action) return;
        editor.updateOptions({ readOnly: false });
        try {
            Promise.resolve(action.run())
                .catch(function () { /* ignore */ })
                .finally(function () {
                    if (editor) editor.updateOptions({ readOnly: true });
                });
        } catch {
            // Sprach-Worker noch nicht hoch, Formatter nicht registriert,
            // o.ae. — best effort, nicht eskalieren.
            if (editor) editor.updateOptions({ readOnly: true });
        }
    }, 50);
}

type MountOptions = { autoFormat?: boolean };

export function mount(elementId: string, text: string, language: string, options?: MountOptions): Promise<void> {
    const autoFormat = !!(options && options.autoFormat);
    return ensureMonaco().then((monaco) => {
        if (!monaco) return;
        const el = document.getElementById(elementId);
        if (!el) {
            console.error(`[folio-code-view] mount target '${elementId}' not found`);
            return;
        }
        if (editor && mountedElementId === elementId) {
            // Re-Use: vorhandene Instanz auf neuen Text/Lang updaten.
            applyContent(text, language);
            if (autoFormat) runAutoFormat(language || 'plaintext');
            return;
        }
        if (editor) {
            disposeInternal();
        }
        const content = text || '';
        const isDark = document.documentElement.classList.contains('theme-dark')
            || pendingTheme === 'dark';
        model = monaco.editor.createModel(content, language || 'plaintext');
        editor = monaco.editor.create(el, {
            model,
            readOnly: true,
            theme: isDark ? 'vs-dark' : 'vs',
            automaticLayout: true,
            minimap: { enabled: false },
            lineNumbers: 'on',
            wordWrap: 'on',
            folding: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'none',
            // Read-Only-Cursor stoert visuell — versteckt halten.
            renderValidationDecorations: 'on',
            fontSize: 13.5,
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
            padding: { top: 12, bottom: 12 },
            domReadOnly: true,
            contextmenu: false,
        });
        mountedElementId = elementId;
        if (pendingTheme) {
            monaco.editor.setTheme(pendingTheme === 'dark' ? 'vs-dark' : 'vs');
            pendingTheme = null;
        }
        if (autoFormat) runAutoFormat(language || 'plaintext');
    });
}

function applyContent(text: string, language: string): void {
    if (!editor || !model) return;
    const monaco = getMonaco();
    if (!monaco) return;
    const lang = language || 'plaintext';
    const content = text || '';
    if (model.getLanguageId() !== lang) {
        // Sprache aendert sich → frisches Model. setModelLanguage wuerde
        // den Tokenizer-State des alten Models nicht resetten.
        const fresh = monaco.editor.createModel(content, lang);
        editor.setModel(fresh);
        model.dispose();
        model = fresh;
    } else if (model.getValue() !== content) {
        model.setValue(content);
    }
    // Beim Inhalt-Update scrollen wir zurueck nach oben — der User soll
    // jede neue Datei "von vorn" sehen.
    editor.setScrollTop(0);
}

export function setText(text: string, language: string, options?: MountOptions): void {
    if (!editor) {
        // Pre-Mount: Aufrufer ist verantwortlich, mount() zu rufen.
        return;
    }
    const autoFormat = !!(options && options.autoFormat);
    applyContent(text, language);
    if (autoFormat) runAutoFormat(language || 'plaintext');
}

export function setTheme(mode: 'light' | 'dark'): void {
    const monaco = getMonaco();
    if (!editor || !monaco) {
        pendingTheme = mode;
        return;
    }
    monaco.editor.setTheme(mode === 'dark' ? 'vs-dark' : 'vs');
}

export function layout(): void {
    if (editor) editor.layout();
}

export function dispose(): void {
    disposeInternal();
}

function disposeInternal(): void {
    if (editor) {
        try { editor.dispose(); } catch { /* ignore */ }
        editor = null;
    }
    if (model) {
        try { model.dispose(); } catch { /* ignore */ }
        model = null;
    }
    mountedElementId = null;
}

export function isMounted(): boolean {
    return !!editor;
}
