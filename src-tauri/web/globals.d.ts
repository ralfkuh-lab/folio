// Cross-Bundle- und DevTools-Surface auf `window`. Source of Truth fuer
// die in `docs/frontend-globals.md` inventarisierten globalen Bridges.
// Editor- und App-Bundle teilen `window.FolioEditor` (Monaco-Adapter).
// Tauri-Runtime und Monaco-AMD-Loader sind drittseitig. `__folioInvoke`
// und `openDocument` sind defensive DevTools-Hooks aus Phase 4.6.

// Spiegelt die in `editor.ts::window.FolioEditor = {...}` exportierte
// API. Index-Signature deckt selten genutzte Methoden ab; haeufige
// werden konkret typisiert, damit Aufrufer ueberraschungsfrei sind.
interface FolioEditorSurface {
    mount(elementId: string, initialText: string): Promise<void>;
    setText(text: string, language?: string): void;
    getText(): string;
    setSelection(start: number, length: number): void;
    getSelection(): { start: number; length: number };
    setScroll(y: number): void;
    getScroll(): number;
    setTheme(mode: string): void;
    setMinimap(enabled: boolean): void;
    layout(): void;
    focus(): void;
    applyReplace(args: { fullText: string; selectionStart: number; selectionLength: number }): void;
    openFind(initialTerm?: string): void;
    closeFind(): void;
    setFindOptions(opts: Record<string, unknown>): void;
    setFindTerm(term: string): void;
    findNext(): void;
    findPrev(): void;
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
    mount(elementId: string, text: string, language: string, options?: { autoFormat?: boolean }): Promise<void>;
    setText(text: string, language: string, options?: { autoFormat?: boolean }): void;
    setTheme(mode: 'light' | 'dark'): void;
    layout(): void;
    dispose(): void;
    isMounted(): boolean;
}

interface Window {
    FolioEditor?: FolioEditorSurface;
    FolioCodeView?: FolioCodeViewSurface;
    __TAURI__?: TauriRuntime;
    __folioInvoke?: TauriCoreApi['invoke'];
    openDocument?: (path: string) => Promise<boolean>;
    monaco?: any;
    require?: any;
}
