// Code-View: read-only Monaco-Instanz fuer den View-Mode von Non-Markdown-
// Text-Dateien (JSON, XML, YAML, Source-Code, …). Eigenstaendig zur Edit-
// Mode-Instanz aus `mount.ts`, teilt aber denselben AMD-Loader
// (`whenMonacoLoaded`), sodass Monaco genau einmal geladen wird.
//
// Pretty-Print:
//   - JSON: `JSON.parse + stringify(_, null, 2)`. Bei Parse-Error wird der
//     Roh-Inhalt angezeigt (Highlighting + Read-Only sind trotzdem ein
//     Mehrwert ggue. Plain-Pre).
//   - Andere Sprachen: roh anzeigen — Monaco liefert Highlighting, Folding,
//     Find-Widget out-of-the-box.

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

function prettyPrint(text: string, language: string): string {
    if (language !== 'json') return text;
    const trimmed = (text || '').trim();
    if (!trimmed) return text || '';
    try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(parsed, null, 2);
    } catch {
        return text || '';
    }
}

export function mount(elementId: string, text: string, language: string): Promise<void> {
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
            return;
        }
        if (editor) {
            disposeInternal();
        }
        const content = prettyPrint(text || '', language || 'plaintext');
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
    });
}

function applyContent(text: string, language: string): void {
    if (!editor || !model) return;
    const monaco = getMonaco();
    if (!monaco) return;
    const lang = language || 'plaintext';
    const content = prettyPrint(text || '', lang);
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

export function setText(text: string, language: string): void {
    if (!editor) {
        // Pre-Mount: Aufrufer ist verantwortlich, mount() zu rufen.
        return;
    }
    applyContent(text, language);
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
