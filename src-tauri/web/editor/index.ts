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
//     setScroll, getCursorLine, revealLineNearTop, revealLineFractionNearTop,
//     applyReplace, focus, layout, setTheme,
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
import { layout, mount, setMinimap, setTheme, setText } from './mount';
import {
    applyReplace,
    focus,
    getLanguage,
    getCursorLine,
    getScroll,
    getSelection,
    getText,
    insertText,
    listLanguages,
    redo,
    revealLineFractionNearTop,
    revealLineNearTop,
    setLanguage,
    setScroll,
    setSelection,
    undo,
} from './text';
import * as codeView from './view-code';

(window as any).FolioEditor = {
    mount,
    setText,
    getText,
    getSelection,
    setSelection,
    getScroll,
    setScroll,
    getCursorLine,
    revealLineNearTop,
    revealLineFractionNearTop,
    applyReplace,
    focus,
    insertText,
    undo,
    redo,
    setTheme,
    setMinimap,
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

// Zweiter Surface: Read-Only Code-View fuer den View-Mode von Non-Markdown-
// Dateien. Sitzt auf derselben Monaco-AMD-Init wie FolioEditor.
(window as any).FolioCodeView = {
    mount: codeView.mount,
    setText: codeView.setText,
    setTheme: codeView.setTheme,
    layout: codeView.layout,
    dispose: codeView.dispose,
    isMounted: codeView.isMounted,
};
