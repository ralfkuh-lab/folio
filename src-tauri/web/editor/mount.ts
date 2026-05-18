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

        const editor = monaco.editor.create(el, {
            value: initialText || '',
            language: 'markdown',
            theme: isDark ? 'vs-dark' : 'vs',
            automaticLayout: true,
            minimap: { enabled: false },
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

export function layout(): void {
    const editor = getEditor();
    if (editor) editor.layout();
}
