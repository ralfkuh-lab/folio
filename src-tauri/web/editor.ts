// Monaco Editor wrapper for Folio's Tauri shell.
// Loads Monaco via AMD loader (window.require), exposes window.FolioEditor API
// compatible with the previous CodeMirror 6 bundle.
//
// Bridge contract (unchanged from CodeMirror era):
//   Outbound (postMessage): editorReady, editorTextChanged, editorSelection,
//                           editorFindState, editorSaveRequested
//   Inbound (functions):    mount, setText, getText, getSelection,
//                           applyReplace, focus, setTheme, openFind,
//                           closeFind, setFindOptions, findNext, findPrev,
//                           setFindTerm

declare global {
    interface Window {
        require?: any;
        monaco?: any;
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
    if (
        msg &&
        typeof msg === "object" &&
        (msg as { type?: unknown }).type === "editorTextChanged"
    ) {
        try {
            window.dispatchEvent(
                new CustomEvent("folio-editor-text-updated", {
                    detail: (msg as { text?: unknown }).text || "",
                })
            );
        } catch {
            /* ignored */
        }
    }
}

// ----- Monaco Loading ---------------------------------------------------

let monacoInstance: any = null;
let editorInstance: any = null;
let suppressTextEvent = false;

const monacoPromise = loadMonaco();

function loadMonaco(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (window.monaco?.editor) {
            monacoInstance = window.monaco;
            resolve();
            return;
        }
        if (typeof window.require === "undefined") {
            reject(new Error("Monaco loader (window.require) not available"));
            return;
        }
        try {
            window.require.config({ paths: { vs: "monaco/vs" } });
        } catch (e) {
            reject(e);
            return;
        }
        window.require(
            ["vs/editor/editor.main"],
            () => {
                if (!window.monaco?.editor) {
                    reject(new Error("Monaco AMD loader finished without window.monaco.editor"));
                    return;
                }
                monacoInstance = window.monaco;
                resolve();
            },
            (err: any) => {
                console.error("[folio-editor] Monaco load failed:", err);
                reject(err);
            }
        );
    });
}

// ----- Find State -------------------------------------------------------

interface FindMatch {
    from: number;
    to: number;
}

interface FindStateSnapshot {
    term: string;
    total: number;
    active: number;
    matches: FindMatch[];
}

let findState: FindStateSnapshot = { term: "", total: 0, active: -1, matches: [] };
let findOptions: { caseSensitive: boolean; wholeWord: boolean } = {
    caseSensitive: false,
    wholeWord: false,
};

let matchDecorations: string[] = [];

function isWordChar(ch: string): boolean {
    return /[\p{L}\p{N}_]/u.test(ch);
}

function isWholeWordHit(text: string, from: number, to: number): boolean {
    if (from > 0 && isWordChar(text.charAt(from - 1))) return false;
    if (to < text.length && isWordChar(text.charAt(to))) return false;
    return true;
}

function recomputeMatches(): void {
    const editor = editorInstance;
    const monaco = monacoInstance;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const term = findState.term;
    if (!term) {
        findState = { term: "", total: 0, active: -1, matches: [] };
        clearDecorations();
        publishFindState();
            return;
    }

    const text = model.getValue();
    const matches: FindMatch[] = [];

    const searchTerm = findOptions.caseSensitive ? term : term.toLowerCase();
    const searchText = findOptions.caseSensitive ? text : text.toLowerCase();
    let pos = 0;
    while (true) {
        const idx = searchText.indexOf(searchTerm, pos);
        if (idx === -1) break;
        const end = idx + term.length;
        if (!findOptions.wholeWord || isWholeWordHit(text, idx, end)) {
            matches.push({ from: idx, to: end });
        }
        pos = end;
    }

    const cursorPos = editor.getPosition();
    const cursorOffset = cursorPos ? model.getOffsetAt(cursorPos) : 0;
    let active = matches.length > 0 ? 0 : -1;
    for (let i = 0; i < matches.length; i++) {
        if (matches[i].from >= cursorOffset) {
            active = i;
            break;
        }
    }

    findState = { term, total: matches.length, active, matches };
    applyDecorations();
    if (active >= 0) scrollMatchIntoView(matches[active]);
    publishFindState();
}

function applyDecorations(): void {
    const editor = editorInstance;
    const monaco = monacoInstance;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const decorations: any[] = [];
    findState.matches.forEach((m: FindMatch, idx: number) => {
        const startPos = model.getPositionAt(m.from);
        const endPos = model.getPositionAt(m.to);
        decorations.push({
            range: new monaco.Range(
                startPos.lineNumber,
                startPos.column,
                endPos.lineNumber,
                endPos.column
            ),
            options: {
                inlineClassName:
                    idx === findState.active
                        ? "folio-find-match-active"
                        : "folio-find-match",
                overviewRuler: {
                    color: idx === findState.active ? "#FF8C00" : "#FFD700",
                    position: monaco.editor.OverviewRulerLane.Center,
                },
                minimap: {
                    color: idx === findState.active ? "#FF8C00" : "#FFD700",
                    position: monaco.editor.MinimapPosition.Inline,
                },
            },
        });
    });

    matchDecorations = editor.deltaDecorations(matchDecorations, decorations);
}

function clearDecorations(): void {
    if (editorInstance) {
        matchDecorations = editorInstance.deltaDecorations(matchDecorations, []);
    }
}

function scrollMatchIntoView(m: FindMatch): void {
    const editor = editorInstance;
    const monaco = monacoInstance;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const pos = model.getPositionAt(m.from);
    editor.setPosition(pos);
    editor.revealPositionInCenterIfOutsideViewport(pos);
}

function publishFindState(): void {
    const detail = {
        term: findState.term,
        total: findState.total,
        active: findState.active,
    };
    post({ type: "editorFindState", ...detail });
    try {
        window.dispatchEvent(new CustomEvent("folio-find-state", { detail }));
    } catch {
        /* defensive */
    }
}

// ----- Mounting --------------------------------------------------------

function mount(elementId: string, initialText: string): Promise<void> {
    return monacoPromise.then(() => {
        const el = document.getElementById(elementId);
        if (!el) {
            console.error(
                "[folio-editor] mount target '" + elementId + "' not found"
            );
            return;
        }
        if (editorInstance) {
            editorInstance.dispose();
            editorInstance = null;
        }
        const monaco = monacoInstance;

        const isDark = document.documentElement.classList.contains("theme-dark");

        try {
            editorInstance = monaco.editor.create(el, {
                value: initialText || "",
                language: "markdown",
                theme: isDark ? "vs-dark" : "vs",
                automaticLayout: true,
                minimap: { enabled: false },
                lineNumbers: "on",
                wordWrap: "on",
                folding: true,
                scrollBeyondLastLine: false,
                renderLineHighlight: "all",
                fontSize: 13.5,
                fontFamily:
                    'Consolas, "Cascadia Mono", "Courier New", monospace',
                padding: { top: 12, bottom: 12 },
            });
        } catch (e) {
            throw e;
        }

        // Find-Shortcuts: Monacos eigenes Find-Widget bleibt deaktiviert,
        // stattdessen die Shell-Find-Bar öffnen / weiterspringen. Monaco
        // schluckt die Tasten in seinem Bubble-Handler, also müssen die
        // addCommand-Callbacks die window-Funktionen selbst aufrufen.
        editorInstance.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
            () => {
                const open = (window as any).openEditorFind;
                if (typeof open !== "function") return;
                // Einzeilige Selektion als Seed übernehmen (VS-Code-Verhalten);
                // mehrzeilige Selektion ignorieren — der Find-Term ist Single-Line.
                let seed = "";
                if (editorInstance) {
                    const sel = editorInstance.getSelection();
                    const model = editorInstance.getModel();
                    if (
                        sel && model && !sel.isEmpty() &&
                        sel.startLineNumber === sel.endLineNumber
                    ) {
                        seed = model.getValueInRange(sel) || "";
                    }
                }
                open(seed);
            }
        );
        editorInstance.addCommand(monaco.KeyCode.F3, () => {
            const next = (window as any).findNext;
            if (typeof next === "function") next();
        });
        editorInstance.addCommand(
            monaco.KeyMod.Shift | monaco.KeyCode.F3,
            () => {
                const prev = (window as any).findPrev;
                if (typeof prev === "function") prev();
            }
        );

        // Content change listener
        editorInstance.onDidChangeModelContent(() => {
            if (!suppressTextEvent) {
                const text = editorInstance.getValue();
                post({ type: "editorTextChanged", text });
                if (findState.term) recomputeMatches();
            }
        });

        // Selection change listener
        editorInstance.onDidChangeCursorSelection((e: any) => {
            const model = editorInstance.getModel();
            if (!model) return;
            const start = model.getOffsetAt(e.selection.getStartPosition());
            const end = model.getOffsetAt(e.selection.getEndPosition());
            post({
                type: "editorSelection",
                start,
                length: end - start,
            });
        });

        // Save shortcut (Ctrl+S)
        editorInstance.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
            () => {
                post({ type: "editorSaveRequested" });
            }
        );

        // Scroll listener (RAF-debounced) → editorScroll-Event für History-Capture
        let scrollRafQueued = false;
        editorInstance.onDidScrollChange(() => {
            if (scrollRafQueued || !editorInstance) return;
            scrollRafQueued = true;
            requestAnimationFrame(() => {
                scrollRafQueued = false;
                if (!editorInstance) return;
                post({ type: "editorScroll", y: editorInstance.getScrollTop() });
            });
        });

        layout();
        post({ type: "editorReady" });
    }).catch((err: any) => {
        throw err;
    });
}

function setText(text: string, language?: string): void {
    if (!editorInstance) return;
    const monaco = monacoInstance;
    const next = text || "";
    const lang = (language && language.trim()) || "plaintext";
    const currentModel = editorInstance.getModel();
    const currentLang = currentModel ? currentModel.getLanguageId() : "";
    const sameText = currentModel && currentModel.getValue() === next;
    const sameLang = currentLang === lang;
    if (sameText && sameLang) return;

    suppressTextEvent = true;
    try {
        if (!sameLang) {
            // Sprache wechselt: frischen Model anlegen, alten verwerfen.
            // setModelLanguage() würde reichen, aber ein frischer Model
            // resettet auch die Tokenizer-/Decoration-State sauber.
            const fresh = monaco.editor.createModel(next, lang);
            editorInstance.setModel(fresh);
            if (currentModel) currentModel.dispose();
        } else {
            editorInstance.setValue(next);
        }
    } finally {
        suppressTextEvent = false;
    }
    if (findState.term) recomputeMatches();
}

function getText(): string {
    return editorInstance ? editorInstance.getValue() : "";
}

function getLanguage(): string {
    if (!editorInstance) return "";
    const model = editorInstance.getModel();
    return model ? model.getLanguageId() : "";
}

function setLanguage(language: string): void {
    if (!editorInstance) return;
    const monaco = monacoInstance;
    const model = editorInstance.getModel();
    if (!model) return;
    const lang = (language && language.trim()) || "plaintext";
    if (model.getLanguageId() === lang) return;
    monaco.editor.setModelLanguage(model, lang);
}

function listLanguages(): Array<{ id: string; label: string; aliases: string[] }> {
    const monaco = monacoInstance;
    if (!monaco) return [];
    return monaco.languages.getLanguages().map((l: any) => {
        const aliases: string[] = Array.isArray(l.aliases) ? l.aliases.slice() : [];
        const label = aliases[0] || l.id;
        return { id: l.id, label, aliases };
    });
}

function getSelection(): { start: number; length: number } {
    if (!editorInstance) return { start: 0, length: 0 };
    const model = editorInstance.getModel();
    if (!model) return { start: 0, length: 0 };
    const sel = editorInstance.getSelection();
    if (!sel) return { start: 0, length: 0 };
    const start = model.getOffsetAt(sel.getStartPosition());
    const end = model.getOffsetAt(sel.getEndPosition());
    return { start, length: end - start };
}

function setSelection(start: number, length: number): void {
    if (!editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const monaco = monacoInstance;
    const docLen = model.getValueLength();
    const from = Math.max(0, Math.min(start, docLen));
    const to = Math.max(0, Math.min(start + length, docLen));
    const startPos = model.getPositionAt(from);
    const endPos = model.getPositionAt(to);
    editorInstance.setSelection(
        new monaco.Selection(
            startPos.lineNumber,
            startPos.column,
            endPos.lineNumber,
            endPos.column
        )
    );
}

function getScroll(): number {
    return editorInstance ? editorInstance.getScrollTop() : 0;
}

function setScroll(y: number): void {
    if (!editorInstance) return;
    editorInstance.setScrollTop(Math.max(0, y));
}

function applyReplace(args: {
    fullText: string;
    selectionStart: number;
    selectionLength: number;
}): void {
    if (!editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const monaco = monacoInstance;

    suppressTextEvent = true;
    try {
        editorInstance.setValue(args.fullText || "");
        const startPos = model.getPositionAt(args.selectionStart || 0);
        const endPos = model.getPositionAt(
            (args.selectionStart || 0) + (args.selectionLength || 0)
        );
        editorInstance.setSelection(
            new monaco.Selection(
                startPos.lineNumber,
                startPos.column,
                endPos.lineNumber,
                endPos.column
            )
        );
        editorInstance.revealPositionInCenterIfOutsideViewport(startPos);
    } finally {
        suppressTextEvent = false;
    }
    post({ type: "editorTextChanged", text: editorInstance.getValue() });
    if (findState.term) recomputeMatches();
}

function focus(): void {
    if (!editorInstance) return;
    layout();
    editorInstance.focus();
}

function layout(): void {
    if (!editorInstance) return;
    editorInstance.layout();
}

function undo(): void {
    if (!editorInstance) return;
    editorInstance.focus();
    editorInstance.trigger("menu", "undo", null);
}

function redo(): void {
    if (!editorInstance) return;
    editorInstance.focus();
    editorInstance.trigger("menu", "redo", null);
}

function setTheme(_mode: "light" | "dark"): void {
    if (!monacoInstance || !editorInstance) return;
    monacoInstance.editor.setTheme(_mode === "dark" ? "vs-dark" : "vs");
}

function openFind(initialTerm?: string): void {
    if (!editorInstance) return;
    if (typeof initialTerm === "string" && initialTerm.length > 0) {
        findState.term = initialTerm;
    } else if (!findState.term) {
        const sel = getSelection();
        if (sel.length > 0) {
            const text = getText();
            const candidate = text.substring(sel.start, sel.start + sel.length);
            if (!candidate.includes("\n") && candidate.length < 200) {
                findState.term = candidate;
            }
        }
    }
    recomputeMatches();
}

function closeFind(): void {
    if (!editorInstance) return;
    findState = { term: "", total: 0, active: -1, matches: [] };
    publishFindState();
    clearDecorations();
    editorInstance.focus();
}

function setFindOptions(opts: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
}): void {
    if (typeof opts.caseSensitive === "boolean")
        findOptions.caseSensitive = opts.caseSensitive;
    if (typeof opts.wholeWord === "boolean")
        findOptions.wholeWord = opts.wholeWord;
    if (editorInstance && findState.term) recomputeMatches();
}

function setFindTerm(term: string): void {
    findState.term = term || "";
    if (editorInstance) recomputeMatches();
}

function findNext(): void {
    if (!editorInstance || findState.matches.length === 0) return;
    const next = (findState.active + 1) % findState.matches.length;
    findState.active = next;
    scrollMatchIntoView(findState.matches[next]);
    publishFindState();
    applyDecorations();
}

function findPrev(): void {
    if (!editorInstance || findState.matches.length === 0) return;
    const n = findState.matches.length;
    const prev = (findState.active - 1 + n) % n;
    findState.active = prev;
    scrollMatchIntoView(findState.matches[prev]);
    publishFindState();
    applyDecorations();
}

// ----- Public API (window.FolioEditor) ---------------------------------

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
