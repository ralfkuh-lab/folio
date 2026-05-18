// Entry point for the Monaco editor bundle (esbuild --bundle target).
// Composes the topic-modules (mount, text, find) into the legacy
// `window.FolioEditor` surface that the app-bundle and Cargo-Smoke-Test
// depend on (see `src-tauri/tests/smoke_frontend_assets.rs`).
//
// Bridge contract (unchanged from CodeMirror era):
//   Outbound (post → "editor:event"):
//     editorReady, editorTextChanged, editorSelection, editorScroll,
//     editorFindState, editorSaveRequested
//   Inbound (window.FolioEditor.*):
//     mount, setText, getText, getSelection, setSelection, getScroll,
//     setScroll, applyReplace, focus, layout, setTheme,
//     undo, redo, getLanguage, setLanguage, listLanguages,
//     openFind, closeFind, setFindOptions, setFindTerm, findNext, findPrev
//
// Window-Surface ist zentral in `globals.d.ts` deklariert.

import {
    closeFind,
    findNext,
    findPrev,
    openFind,
    setFindOptions,
    setFindTerm,
} from './find';
import { layout, mount, setTheme, setText } from './mount';
import {
    applyReplace,
    focus,
    getLanguage,
    getScroll,
    getSelection,
    getText,
    listLanguages,
    redo,
    setLanguage,
    setScroll,
    setSelection,
    undo,
} from './text';

(window as any).FolioEditor = {
    mount,
    setText,
    getText,
    getSelection,
    setSelection,
    getScroll,
    setScroll,
    applyReplace,
    focus,
    undo,
    redo,
    setTheme,
    openFind,
    closeFind,
    setFindOptions,
    setFindTerm,
    findNext,
    findPrev,
    layout,
    getLanguage,
    setLanguage,
    listLanguages,
};
