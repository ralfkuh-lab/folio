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
        renderMarkerLane();
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
    renderMarkerLane();
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

function renderMarkerLane(): void {
    const lane = document.getElementById("editor-marker-lane");
    if (!lane) return;
    while (lane.firstChild) lane.removeChild(lane.firstChild);
    if (findState.matches.length === 0) return;

    const editor = editorInstance;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    const lineCount = model.getLineCount();
    const laneHeight = lane.clientHeight;
    if (laneHeight <= 0) return;

    findState.matches.forEach((m: FindMatch, idx: number) => {
        const pos = model.getPositionAt(m.from);
        const y = ((pos.lineNumber - 1) / lineCount) * laneHeight;
        const dot = document.createElement("div");
        dot.className =
            "folio-marker" + (idx === findState.active ? " active" : "");
        dot.style.top = Math.max(0, Math.min(laneHeight - 3, y)) + "px";
        lane.appendChild(dot);
    });
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

        // Disable Monaco built-in find widget shortcuts
        editorInstance.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
            () => {
                /* handled by shell find-bar */
            }
        );
        editorInstance.addCommand(monaco.KeyCode.F3, () => {
            /* handled by shell find-bar */
        });
        editorInstance.addCommand(
            monaco.KeyMod.Shift | monaco.KeyCode.F3,
            () => {
                /* handled by shell find-bar */
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

        layout();
        post({ type: "editorReady" });
    }).catch((err: any) => {
        throw err;
    });
}

function setText(text: string): void {
    if (!editorInstance) return;
    suppressTextEvent = true;
    try {
        editorInstance.setValue(text || "");
    } finally {
        suppressTextEvent = false;
    }
    if (findState.term) recomputeMatches();
}

function getText(): string {
    return editorInstance ? editorInstance.getValue() : "";
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
    renderMarkerLane();
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
    renderMarkerLane();
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
    renderMarkerLane();
}

function findPrev(): void {
    if (!editorInstance || findState.matches.length === 0) return;
    const n = findState.matches.length;
    const prev = (findState.active - 1 + n) % n;
    findState.active = prev;
    scrollMatchIntoView(findState.matches[prev]);
    publishFindState();
    applyDecorations();
    renderMarkerLane();
}

// ----- Public API (window.FolioEditor) ---------------------------------

(window as any).FolioEditor = {
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
    layout,
};
