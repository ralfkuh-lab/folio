// Shared internal state for the Monaco wrapper. Acts as the single
// source of truth for the underlying editor and monaco namespace, so
// the topic-modules (find, events, mount, text) stay free of their own
// module-level singletons.

let monacoInstance: any = null;
let editorInstance: any = null;

// Programmatic-write counter (replaces the previous `suppressTextEvent`
// boolean). When > 0, the model-content listener suppresses outbound
// editorTextChanged events. Counter — not boolean — so nested scopes
// compose: `setText` may indirectly trigger a model swap that itself
// fires content events, and the outer scope still gets to drop them.
let programmaticWriteDepth = 0;

export function getMonaco(): any {
    return monacoInstance;
}

export function getEditor(): any {
    return editorInstance;
}

export function setMonaco(m: any): void {
    monacoInstance = m;
}

export function setEditor(e: any): void {
    editorInstance = e;
}

export function disposeEditor(): void {
    if (editorInstance) {
        editorInstance.dispose();
        editorInstance = null;
    }
}

export function withProgrammaticWrite<T>(fn: () => T): T {
    programmaticWriteDepth++;
    try {
        return fn();
    } finally {
        programmaticWriteDepth--;
    }
}

export function isProgrammaticWrite(): boolean {
    return programmaticWriteDepth > 0;
}
