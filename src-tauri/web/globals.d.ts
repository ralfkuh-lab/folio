// Cross-Bundle- und DevTools-Surface auf `window`. Source of Truth fuer
// die in `docs/frontend-globals.md` inventarisierten globalen Bridges.
// Editor- und App-Bundle teilen `window.FolioEditor` (Monaco-Adapter).
// Tauri-Runtime und Monaco-AMD-Loader sind drittseitig. `__folioInvoke`
// und `openDocument` sind defensive DevTools-Hooks aus Phase 4.6.

interface FolioEditorSurface {
    mount(node: HTMLElement, text: string, theme?: string, language?: string): void;
    setText(text: string): void;
    setSelection(start: number, length: number): void;
    setScroll(y: number): void;
    setTheme(theme: string): void;
    layout(): void;
    focus(): void;
    getSelection(): { start: number; length: number };
    applyReplace(start: number, length: number, text: string): void;
    openFind(initialTerm?: string): void;
    closeFind(): void;
    setFindTerm(term: string): void;
    findNext(): void;
    findPrev(): void;
    isMounted?: () => boolean;
    setLanguage?: (language: string) => void;
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

interface Window {
    FolioEditor?: FolioEditorSurface;
    __TAURI__?: TauriRuntime;
    __folioInvoke?: TauriCoreApi['invoke'];
    openDocument?: (path: string) => Promise<boolean>;
    monaco?: any;
    require?: any;
}
