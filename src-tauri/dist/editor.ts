// CodeMirror 6 bundle fuer Folio's Edit-Modus.
// Wird per esbuild als IIFE gebaut (globalName "FolioEditor"), dann von der
// Shell-WebView geladen. Alle hier exportierten Funktionen liegen unter
// window.FolioEditor.* und werden von shell-template.html aufgerufen.
//
// Bridge-Vertrag zur C#-Seite:
//   Outbound (postMessage): editorReady, editorTextChanged, editorSelection,
//                           editorFindState, editorSaveRequested
//   Inbound (Funktionen):   mount, setText, getText, getSelection,
//                           applyReplace, focus, setTheme, openFind,
//                           closeFind, setFindOptions, findNext, findPrev,
//                           setFindTerm

import { EditorState, EditorSelection, Compartment, Extension, RangeSetBuilder } from "@codemirror/state";
import {
    EditorView,
    keymap,
    drawSelection,
    highlightActiveLine,
    lineNumbers,
    highlightActiveLineGutter,
    Decoration,
    DecorationSet,
    ViewPlugin,
    ViewUpdate,
    placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
    syntaxHighlighting,
    HighlightStyle,
    bracketMatching,
    foldGutter,
    foldKeymap,
    indentOnInput,
} from "@codemirror/language";
import { searchKeymap, SearchCursor } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

declare global {
    interface Window {
        __TAURI__?: {
            event?: {
                emit(event: string, payload?: unknown): Promise<void>;
            };
        };
    }
}

// ----- Bridge -----------------------------------------------------------

function post(msg: unknown): void {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit("editor:event", msg);
    }
}

// ----- Theme ------------------------------------------------------------
// Editor-Farben kommen aus den CSS-Variablen der Shell, damit Light/Dark-Toggle
// automatisch greift. Selektoren matchen CodeMirror 6 Selektor-Layout.

function buildEditorTheme(): Extension {
    return EditorView.theme(
        {
            "&": {
                color: "var(--fg)",
                backgroundColor: "var(--bg)",
                height: "100%",
                fontSize: "13.5px",
            },
            ".cm-content": {
                fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
                caretColor: "var(--fg)",
                padding: "12px 8px",
            },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
                backgroundColor: "var(--accent-bg-subtle, rgba(64,128,255,0.25))",
            },
            ".cm-activeLine": { backgroundColor: "rgba(128,128,128,0.07)" },
            ".cm-gutters": {
                backgroundColor: "var(--bg)",
                color: "var(--fg-muted, #888)",
                border: "none",
                borderRight: "1px solid var(--border, rgba(128,128,128,0.18))",
            },
            ".cm-activeLineGutter": { backgroundColor: "rgba(128,128,128,0.10)" },
            ".cm-foldPlaceholder": {
                backgroundColor: "transparent",
                border: "none",
                color: "var(--fg-muted, #888)",
            },
            ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
            ".cm-tooltip": {
                backgroundColor: "var(--bg)",
                color: "var(--fg)",
                border: "1px solid var(--border, rgba(128,128,128,0.3))",
            },
        },
        { dark: false } // wir steuern dark/light selbst per CSS-Variablen
    );
}

// Markdown-Highlight-Tags. Farben passen zu unserem AvalonEdit-XSHD und
// nutzen die Tokens-Variablen der Shell.
const markdownHighlight = HighlightStyle.define([
    { tag: t.heading1, color: "var(--md-heading, #4493F8)", fontWeight: "bold", fontSize: "1.15em" },
    { tag: t.heading2, color: "var(--md-heading, #4493F8)", fontWeight: "bold" },
    { tag: t.heading3, color: "var(--md-heading, #4493F8)", fontWeight: "bold" },
    { tag: t.heading4, color: "var(--md-heading, #4493F8)", fontWeight: "bold" },
    { tag: t.heading5, color: "var(--md-heading, #4493F8)", fontWeight: "bold" },
    { tag: t.heading6, color: "var(--md-heading, #4493F8)", fontWeight: "bold" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.link, color: "var(--md-link, #4493F8)", textDecoration: "underline" },
    { tag: t.url, color: "var(--md-link, #4493F8)" },
    { tag: t.monospace, color: "var(--md-code, #C97A28)", fontFamily: "inherit" },
    { tag: t.quote, color: "var(--fg-muted, #888)", fontStyle: "italic" },
    { tag: t.list, color: "var(--md-list, #888)" },
    { tag: t.meta, color: "var(--fg-muted, #888)" },
    { tag: t.processingInstruction, color: "var(--md-list, #888)" },
    { tag: t.contentSeparator, color: "var(--fg-muted, #888)" },
]);

// ----- Find: Decorations + Marker-Lane ----------------------------------
// Wir bauen eigene Decorations statt @codemirror/search-Panel, damit die
// HTML-Find-Bar in der Shell die UX kontrolliert (Counter, Optionen, Marker-
// Lane). SearchCursor liefert die Treffer.

interface FindOptions {
    term: string;
    caseSensitive: boolean;
    wholeWord: boolean;
}

interface FindMatch {
    from: number;
    to: number;
}

interface FindStateSnapshot {
    term: string;
    total: number;
    active: number; // -1 wenn keiner aktiv
    matches: FindMatch[];
}

let findState: FindStateSnapshot = { term: "", total: 0, active: -1, matches: [] };
let findOptions: { caseSensitive: boolean; wholeWord: boolean } = {
    caseSensitive: false,
    wholeWord: false,
};

const matchMark = Decoration.mark({ class: "folio-find-match" });
const activeMatchMark = Decoration.mark({ class: "folio-find-match active" });

function findDecorationSet(view: EditorView): DecorationSet {
    if (findState.matches.length === 0) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    findState.matches.forEach((m, idx) => {
        if (m.from === m.to) return;
        builder.add(m.from, m.to, idx === findState.active ? activeMatchMark : matchMark);
    });
    return builder.finish();
}

const findHighlightPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
            this.decorations = findDecorationSet(view);
        }
        update(u: ViewUpdate) {
            // Doc-Aenderungen invalidieren matches; werden bei naechster
            // recomputeMatches() neu gesetzt.
            this.decorations = findDecorationSet(u.view);
        }
    },
    { decorations: (v) => v.decorations }
);

function isWordChar(ch: string): boolean {
    return /[\p{L}\p{N}_]/u.test(ch);
}

function recomputeMatches(view: EditorView): void {
    const term = findOptions ? findState.term : "";
    if (!term) {
        findState = { term: "", total: 0, active: -1, matches: [] };
        view.dispatch({ effects: [] }); // trigger update
        publishFindState();
        renderMarkerLane(view);
        return;
    }
    const doc = view.state.doc;
    const text = doc.toString();
    const matches: FindMatch[] = [];

    if (findOptions.caseSensitive) {
        const cursor = new SearchCursor(view.state.doc, term, 0, doc.length, undefined);
        while (!cursor.next().done) {
            const v = cursor.value;
            if (!findOptions.wholeWord || isWholeWordHit(text, v.from, v.to)) {
                matches.push({ from: v.from, to: v.to });
            }
        }
    } else {
        const cursor = new SearchCursor(
            view.state.doc,
            term,
            0,
            doc.length,
            (s) => s.toLowerCase()
        );
        while (!cursor.next().done) {
            const v = cursor.value;
            if (!findOptions.wholeWord || isWholeWordHit(text, v.from, v.to)) {
                matches.push({ from: v.from, to: v.to });
            }
        }
    }

    // Aktiven Treffer waehlen: erster ab Caret, sonst 0.
    const caret = view.state.selection.main.from;
    let active = matches.length > 0 ? 0 : -1;
    for (let i = 0; i < matches.length; i++) {
        if (matches[i].from >= caret) {
            active = i;
            break;
        }
    }

    findState = { term, total: matches.length, active, matches };
    // Repaint Decorations + Lane.
    view.dispatch({ effects: [] });
    if (active >= 0) scrollMatchIntoView(view, matches[active]);
    publishFindState();
    renderMarkerLane(view);
}

function isWholeWordHit(text: string, from: number, to: number): boolean {
    if (from > 0 && isWordChar(text.charAt(from - 1))) return false;
    if (to < text.length && isWordChar(text.charAt(to))) return false;
    return true;
}

function scrollMatchIntoView(view: EditorView, m: FindMatch): void {
    view.dispatch({
        selection: EditorSelection.cursor(m.from),
        effects: EditorView.scrollIntoView(m.from, { y: "center" }),
    });
}

function publishFindState(): void {
    const detail = {
        term: findState.term,
        total: findState.total,
        active: findState.active,
    };
    post({ type: "editorFindState", ...detail });
    // Lokales Event fuer die Find-Bar-UI in der Shell, damit sie ohne
    // Round-Trip ueber C# auf den Stand reagieren kann.
    try {
        window.dispatchEvent(new CustomEvent("folio-find-state", { detail }));
    } catch {
        /* defensive */
    }
}

// Marker-Lane: 6px-Streifen rechts neben dem Scroller. Renderable HTML, das
// wir bei jeder findState-Aenderung neu malen.
function renderMarkerLane(view: EditorView): void {
    const lane = document.getElementById("editor-marker-lane");
    if (!lane) return;
    while (lane.firstChild) lane.removeChild(lane.firstChild);
    if (findState.matches.length === 0) return;
    const docLines = view.state.doc.lines || 1;
    const laneHeight = lane.clientHeight;
    if (laneHeight <= 0) return;
    findState.matches.forEach((m, idx) => {
        const line = view.state.doc.lineAt(m.from).number;
        const y = ((line - 1) / docLines) * laneHeight;
        const dot = document.createElement("div");
        dot.className = "folio-marker" + (idx === findState.active ? " active" : "");
        dot.style.top = Math.max(0, Math.min(laneHeight - 3, y)) + "px";
        lane.appendChild(dot);
    });
}

// ----- Mounting --------------------------------------------------------

let view: EditorView | null = null;
let suppressTextEvent = false;
const themeCompartment = new Compartment();

function buildExtensions(): Extension[] {
    return [
        history(),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        indentOnInput(),
        foldGutter(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: [] }),
        syntaxHighlighting(markdownHighlight),
        themeCompartment.of(buildEditorTheme()),
        findHighlightPlugin,
        // Keymaps: defaults + history; foldKeymap; searchKeymap intern (Esc/Enter
        // wickelt unsere Find-Bar). Ctrl-S/F/B/I/K sollen *nicht* hier behandelt
        // werden — die schluckt ansonsten unsere WPF-Bindings.
        keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...searchKeymap.filter((b) =>
                // Standard-Find-UI von CM unterdruecken — wir haben unsere eigene.
                b.key !== "Mod-f" && b.key !== "F3" && b.key !== "Shift-F3"
            ),
            indentWithTab,
        ]),
        EditorView.updateListener.of((u: ViewUpdate) => {
            if (u.docChanged && !suppressTextEvent) {
                post({ type: "editorTextChanged", text: u.state.doc.toString() });
                if (findState.term) recomputeMatches(u.view);
            }
            if (u.selectionSet || u.docChanged) {
                const sel = u.state.selection.main;
                post({
                    type: "editorSelection",
                    start: sel.from,
                    length: sel.to - sel.from,
                });
            }
            if (u.geometryChanged && findState.matches.length > 0) {
                renderMarkerLane(u.view);
            }
        }),
        cmPlaceholder(""),
    ];
}

function mount(elementId: string, initialText: string): void {
    const el = document.getElementById(elementId);
    if (!el) {
        console.error("[folio-editor] mount target '" + elementId + "' not found");
        return;
    }
    if (view) {
        // Re-mount: bestehenden View entsorgen.
        view.destroy();
        view = null;
    }
    const state = EditorState.create({
        doc: initialText || "",
        extensions: buildExtensions(),
    });
    view = new EditorView({ state, parent: el });
    post({ type: "editorReady" });
}

function setText(text: string): void {
    if (!view) return;
    suppressTextEvent = true;
    try {
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: EditorSelection.cursor(0),
            scrollIntoView: false,
        });
    } finally {
        suppressTextEvent = false;
    }
    if (findState.term) recomputeMatches(view);
}

function getText(): string {
    return view ? view.state.doc.toString() : "";
}

function getSelection(): { start: number; length: number } {
    if (!view) return { start: 0, length: 0 };
    const sel = view.state.selection.main;
    return { start: sel.from, length: sel.to - sel.from };
}

function applyReplace(args: {
    fullText: string;
    selectionStart: number;
    selectionLength: number;
}): void {
    if (!view) return;
    suppressTextEvent = true;
    try {
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: args.fullText },
            selection: EditorSelection.range(
                args.selectionStart,
                args.selectionStart + args.selectionLength
            ),
            scrollIntoView: true,
        });
    } finally {
        suppressTextEvent = false;
    }
    // Manuell post, weil wir suppress'd haben — C# erwartet aber den Change.
    post({ type: "editorTextChanged", text: view.state.doc.toString() });
    if (findState.term) recomputeMatches(view);
}

function focus(): void {
    if (view) view.focus();
}

function setTheme(_mode: "light" | "dark"): void {
    // Theme reagiert ueber CSS-Variablen automatisch — die werden vom Shell-
    // Body-Theme gesteuert. Compartment-Reconfigure hier triggert Repaint, falls
    // wir spaeter mode-spezifische Anpassungen brauchen.
    if (!view) return;
    view.dispatch({ effects: themeCompartment.reconfigure(buildEditorTheme()) });
}

function openFind(initialTerm?: string): void {
    if (!view) return;
    if (typeof initialTerm === "string" && initialTerm.length > 0) {
        findState.term = initialTerm;
    } else if (!findState.term) {
        // Selection als Default-Suchbegriff uebernehmen, falls einzeilig.
        const sel = view.state.selection.main;
        if (sel.from !== sel.to) {
            const candidate = view.state.doc.sliceString(sel.from, sel.to);
            if (!candidate.includes("\n") && candidate.length < 200) {
                findState.term = candidate;
            }
        }
    }
    recomputeMatches(view);
}

function closeFind(): void {
    if (!view) return;
    findState = { term: "", total: 0, active: -1, matches: [] };
    publishFindState();
    view.dispatch({ effects: [] });
    renderMarkerLane(view);
    view.focus();
}

function setFindOptions(opts: { caseSensitive?: boolean; wholeWord?: boolean }): void {
    if (typeof opts.caseSensitive === "boolean") findOptions.caseSensitive = opts.caseSensitive;
    if (typeof opts.wholeWord === "boolean") findOptions.wholeWord = opts.wholeWord;
    if (view && findState.term) recomputeMatches(view);
}

function setFindTerm(term: string): void {
    findState.term = term || "";
    if (view) recomputeMatches(view);
}

function findNext(): void {
    if (!view || findState.matches.length === 0) return;
    const next = (findState.active + 1) % findState.matches.length;
    findState.active = next;
    scrollMatchIntoView(view, findState.matches[next]);
    publishFindState();
    view.dispatch({ effects: [] });
    renderMarkerLane(view);
}

function findPrev(): void {
    if (!view || findState.matches.length === 0) return;
    const n = findState.matches.length;
    const prev = (findState.active - 1 + n) % n;
    findState.active = prev;
    scrollMatchIntoView(view, findState.matches[prev]);
    publishFindState();
    view.dispatch({ effects: [] });
    renderMarkerLane(view);
}

// ----- Public API (window.FolioEditor) ---------------------------------

export {
    mount,
    setText,
    getText,
    getSelection,
    applyReplace,
    focus,
    setTheme,
    openFind,
    closeFind,
    setFindOptions,
    setFindTerm,
    findNext,
    findPrev,
};
