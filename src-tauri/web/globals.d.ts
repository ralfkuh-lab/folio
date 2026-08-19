// Cross-Bundle- und DevTools-Surface auf `window`. Source of Truth ist
// `docs/automation-contract.md`.
// Editor- und App-Bundle teilen `window.FolioEditor` (Monaco-Adapter).
// Tauri-Runtime und Monaco-AMD-Loader sind drittseitig. `__folioInvoke`
// und `openDocument` sind defensive DevTools-Hooks aus Phase 4.6.

/** Partial bag on the input side (setEditorFindTerm / Automation). */
interface FindOptions {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
}

/** Complete option bag at the setFindOptions boundary — partial objects do not compile. */
interface ResolvedFindOptions {
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
}

/** Duck-type surface used by the find-bar controller (`getFinder()`). */
interface Finder {
    openFind(seed?: string): void;
    closeFind(): void;
    setFindTerm(term: string): void;
    setFindOptions(opts: ResolvedFindOptions): void;
    findNext(): void;
    findPrev(): void;
    setSuppressActive?(on: boolean): void;
}

// Spiegelt die in `editor.ts::window.FolioEditor = {...}` exportierte
// API. Index-Signature deckt selten genutzte Methoden ab; haeufige
// werden konkret typisiert, damit Aufrufer ueberraschungsfrei sind.
interface FolioEditorSurface {
    mount(elementId: string, initialText: string): Promise<void>;
    setText(text: string, language?: string): void;
    setDocument(tabId: number, path: string, text: string, language?: string): void;
    syncTabModels(openDocumentTabIds: number[]): void;
    closeDocument(tabId: number): void;
    getText(): string;
    getTextForTab(tabId: number): string | null;
    getVersionId(): number | null;
    setSelection(start: number, length: number): void;
    getSelection(): { start: number; length: number };
    setScroll(y: number): void;
    getScroll(): number;
    getScrollHeight(): number;
    getVisibleHeight(): number;
    getCursorLine(): number;
    revealLineNearTop(line: number): void;
    revealLineFractionNearTop(line: number): void;
    revealMatch(line: number, colUtf16: number, lenUtf16: number): void;
    setTheme(mode: string): void;
    setMinimap(enabled: boolean): void;
    layout(): void;
    focus(): void;
    applyReplace(args: { fullText: string; selectionStart: number; selectionLength: number; noReveal?: boolean }): void;
    /** Opens Monaco suggest (used after inserting empty `[[]]` for wikilink autocomplete). */
    triggerSuggest(): void;
    openFind(initialTerm?: string): void;
    closeFind(): void;
    setFindOptions(opts: ResolvedFindOptions): void;
    setFindTerm(term: string): void;
    findNext(): void;
    findPrev(): void;
    replaceCurrent(replacement: string): boolean;
    replaceAll(replacement: string, opts?: { inSelection?: boolean }): boolean;
    undo(): void;
    redo(): void;
    insertText(text: string): void;
    setLanguage(language: string): void;
    getLanguage(): string;
    listLanguages(): Array<{ id: string; label: string; aliases: string[] }>;
    [key: string]: any;
}

interface TauriEventApi {
    emit(event: string, payload?: unknown): Promise<void>;
    listen(event: string, handler: (event: { payload: any }) => void): Promise<any>;
}

interface TauriCoreApi {
    invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    convertFileSrc?(path: string, protocol?: string): string;
}

interface TauriRuntime {
    event?: TauriEventApi;
    core?: TauriCoreApi;
}

// Zweiter Monaco-Surface fuer den View-Mode von Non-Markdown-Dateien.
// Read-only, eigener Container; nur Operationen, die fuer eine reine
// Anzeige sinnvoll sind.
interface FolioCodeViewSurface {
    mount(elementId: string, text: string, language: string, options?: { autoFormat?: boolean; preserveScroll?: boolean }): Promise<void>;
    setText(text: string, language: string, options?: { autoFormat?: boolean; preserveScroll?: boolean }): void;
    getText(): string;
    setTheme(mode: 'light' | 'dark'): void;
    layout(): void;
    dispose(): void;
    isMounted(): boolean;
    openFind(initialTerm?: string): void;
    closeFind(): void;
    setFindOptions(opts: ResolvedFindOptions): void;
    setFindTerm(term: string): void;
    findNext(): void;
    findPrev(): void;
    setSuppressActive(on: boolean): void;
}

type FolioThemePart = 'content' | 'dark' | 'page' | 'cover' | 'header' | 'footer';
type FolioThemeParts = Partial<Record<FolioThemePart, string>>;

interface FolioDiffViewSurface {
    mount(elementId: string): Promise<void>;
    setContents(original: string, modified: string, language: string, options?: { readOnly?: boolean }): void;
    onModifiedChange(callback: (() => void) | null): void;
    getModified(): string;
    setTheme(mode: 'light' | 'dark'): void;
    layout(): void;
    focus(): void;
    clear(): void;
    dispose(): void;
    isMounted(): boolean;
}

interface FolioThemeEditorSurface {
    mount(elementId: string): Promise<void>;
    setParts(parts: FolioThemeParts, cleanParts?: FolioThemeParts): void;
    showPart(part: FolioThemePart): boolean;
    getPart(part: FolioThemePart): string | null;
    getAllParts(): FolioThemeParts;
    isDirty(): boolean;
    onChange(handler: (() => void) | null): void;
    setTheme(mode: 'light' | 'dark'): void;
    dispose(): void;
    layout(): void;
}

/** Optional cross-bundle i18n surface (set by app.bundle after initI18n).
 *  Reserved for future editor-bundle strings; pre-init is undefined —
 *  consumers must keep a German/fallback until ready. editor.bundle must
 *  not import app/ modules; it may read this lazily. */
interface FolioI18nSurface {
    t(key: string, args?: Record<string, string | number>): string;
    tPlural(key: string, count: number, args?: Record<string, string | number>): string;
    ready: boolean;
}

interface Window {
    FolioEditor?: FolioEditorSurface;
    FolioCodeView?: FolioCodeViewSurface;
    FolioThemeEditor?: FolioThemeEditorSurface;
    FolioDiffView?: FolioDiffViewSurface;
    FolioI18n?: FolioI18nSurface;
    __TAURI__?: TauriRuntime;
    __folioInvoke?: TauriCoreApi['invoke'];
    /** Test/Automation-Hook: Command Palette öffnen (optionaler Prefill). */
    __folioOpenPalette?: (prefill?: string) => void;
    /** Test/Automation-Hook: Command Palette schließen (No-op wenn zu). */
    __folioClosePalette?: () => void;
    /** Test/Automation-Hook: Zen-Layer verlassen (ohne Hinweis-Flag zurückzusetzen). */
    __folioZenReset?: () => void | Promise<void>;
    /** Test/Automation-Hook: Hex-Ansicht-State (Pfad, Fenster, Fehler). */
    __folioHexViewState?: () => {
        path: string;
        fileSize: number;
        windowStart: number;
        windowLen: number;
        loadedChunks: number[];
        error: string | null;
        status: string;
        revision: number;
        tabId: number | null;
        firstLine: { offset: string; bytes: string; ascii: string } | null;
        lineHeightPx: number;
    };
    openDocument?: (path: string) => Promise<boolean>;
    openThemeEditor?: (id: string) => Promise<boolean>;
    monaco?: any;
    require?: any;
}
