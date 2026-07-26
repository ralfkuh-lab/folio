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
//     applyReplace, focus, layout, setTheme, triggerSuggest,
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
import {
    closeDocument,
    layout,
    mount,
    setDocument,
    setMinimap,
    setTheme,
    setText,
    syncTabModels,
    hasEditor,
} from './mount';
import {
    applyReplace,
    focus,
    getLanguage,
    getCursorLine,
    getScroll,
    getScrollHeight,
    getSelection,
    getText,
    getVisibleHeight,
    insertText,
    listLanguages,
    redo,
    revealLineFractionNearTop,
    revealLineNearTop,
    revealMatch,
    setLanguage,
    setScroll,
    setSelection,
    triggerSuggest,
    undo,
} from './text';
import * as codeView from './view-code';
import * as themeEditor from './theme-editor';
import * as diffView from './diff-view';

(window as any).FolioEditor = {
    mount,
    hasEditor,
    setText,
    setDocument,
    syncTabModels,
    closeDocument,
    getText,
    getSelection,
    setSelection,
    getScroll,
    setScroll,
    getCursorLine,
    revealLineNearTop,
    revealLineFractionNearTop,
    revealMatch,
    applyReplace,
    focus,
    insertText,
    triggerSuggest,
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
    getScrollHeight,
    getVisibleHeight,
};

// Zweiter Surface: Read-Only Code-View fuer den View-Mode von Non-Markdown-
// Dateien. Sitzt auf derselben Monaco-AMD-Init wie FolioEditor.
(window as any).FolioCodeView = {
    mount: codeView.mount,
    setText: codeView.setText,
    getText: codeView.getText,
    setTheme: codeView.setTheme,
    layout: codeView.layout,
    dispose: codeView.dispose,
    isMounted: codeView.isMounted,
    openFind: codeView.openFind,
    closeFind: codeView.closeFind,
    setFindOptions: codeView.setFindOptions,
    setFindTerm: codeView.setFindTerm,
    findNext: codeView.findNext,
    findPrev: codeView.findPrev,
    setSuppressActive: codeView.setSuppressActive,
};

// Vierte Surface: Monaco-DiffEditor fuer die KI-Aktions-Review (A3).
(window as any).FolioDiffView = {
    mount: diffView.mount,
    setContents: diffView.setContents,
    onModifiedChange: diffView.onModifiedChange,
    getModified: diffView.getModified,
    setTheme: diffView.setTheme,
    layout: diffView.layout,
    focus: diffView.focus,
    clear: diffView.clear,
    dispose: diffView.dispose,
    isMounted: diffView.isMounted,
};

// Dritte Surface: editierbare Theme-Paketteile mit Model-pro-Part.
(window as any).FolioThemeEditor = {
    mount: themeEditor.mount,
    setParts: themeEditor.setParts,
    showPart: themeEditor.showPart,
    getPart: themeEditor.getPart,
    getAllParts: themeEditor.getAllParts,
    isDirty: themeEditor.isDirty,
    onChange: themeEditor.onChange,
    setTheme: themeEditor.setTheme,
    dispose: themeEditor.dispose,
    layout: themeEditor.layout,
};
