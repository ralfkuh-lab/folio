// Dritte Monaco-Surface fuer Theme-Paketteile. Jeder Part besitzt ein
// eigenes Model, damit Undo-Stack und Cursor beim Umschalten erhalten
// bleiben. Monaco selbst wird ueber denselben AMD-Loader wie die beiden
// bestehenden Surfaces bezogen.

import { whenMonacoLoaded } from './mount';
import { getMonaco, setMonaco } from './state';

export type ThemePartName =
    'content' | 'dark' | 'page' | 'cover' | 'header' | 'footer';
export type ThemeEditorParts = Partial<Record<ThemePartName, string>>;

type PartEntry = {
    model: any;
    viewState: any;
    subscription: { dispose(): void } | null;
};

const CSS_PARTS = new Set<ThemePartName>(['content', 'dark', 'page']);
const PART_ORDER: ThemePartName[] =
    ['content', 'dark', 'page', 'cover', 'header', 'footer'];

let editor: any = null;
let mountedElementId: string | null = null;
let activePart: ThemePartName | null = null;
let pendingParts: ThemeEditorParts | null = null;
let pendingTheme: 'light' | 'dark' | null = null;
let changeHandler: (() => void) | null = null;
const entries = new Map<ThemePartName, PartEntry>();
const cleanValues = new Map<ThemePartName, string>();

function ensureMonaco(): Promise<any> {
    return whenMonacoLoaded().then(() => {
        if (!getMonaco() && window.monaco?.editor) setMonaco(window.monaco);
        return getMonaco();
    });
}

export function mount(elementId: string): Promise<void> {
    return ensureMonaco().then((monaco) => {
        if (!monaco) return;
        const element = document.getElementById(elementId);
        if (!element) {
            console.error(`[folio-theme-editor] mount target '${elementId}' not found`);
            return;
        }
        if (editor && mountedElementId === elementId) {
            layout();
            return;
        }
        const queuedParts = pendingParts;
        dispose();
        pendingParts = queuedParts;
        const isDark = document.documentElement.classList.contains('theme-dark')
            || pendingTheme === 'dark';
        editor = monaco.editor.create(element, {
            model: null,
            theme: isDark ? 'vs-dark' : 'vs',
            automaticLayout: true,
            minimap: { enabled: false },
            lineNumbers: 'on',
            wordWrap: 'on',
            folding: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            fontSize: 13.5,
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
            padding: { top: 12, bottom: 12 },
        });
        mountedElementId = elementId;
        if (pendingTheme) {
            monaco.editor.setTheme(pendingTheme === 'dark' ? 'vs-dark' : 'vs');
            pendingTheme = null;
        }
        if (pendingParts) {
            const parts = pendingParts;
            pendingParts = null;
            setParts(parts);
        }
    });
}

export function setParts(parts: ThemeEditorParts, cleanParts?: ThemeEditorParts): void {
    const normalized: ThemeEditorParts = {};
    for (const part of PART_ORDER) {
        if (Object.prototype.hasOwnProperty.call(parts, part)) {
            normalized[part] = parts[part] || '';
        }
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, 'content')) {
        normalized.content = '';
    }
    if (!editor || !getMonaco()) {
        pendingParts = normalized;
        return;
    }

    const keys = Object.keys(normalized) as ThemePartName[];
    const sameModels = keys.length === entries.size
        && keys.every((part) => entries.has(part)
            && entries.get(part)!.model.getValue() === normalized[part]);
    if (sameModels) {
        cleanValues.clear();
        const baseForClean = cleanParts || normalized;
        for (const part of keys) cleanValues.set(part, baseForClean[part] || '');
        notifyChange();
        return;
    }

    disposeModels();
    const monaco = getMonaco();
    const baseForClean = cleanParts || normalized;
    for (const part of keys) {
        const model = monaco.editor.createModel(
            normalized[part] || '',
            CSS_PARTS.has(part) ? 'css' : 'html',
        );
        const subscription = model.onDidChangeContent(function () {
            notifyChange();
        });
        entries.set(part, { model, viewState: null, subscription });
        cleanValues.set(part, baseForClean[part] || '');
    }
    activePart = entries.has('content') ? 'content' : keys[0] || null;
    if (activePart) editor.setModel(entries.get(activePart)!.model);
    notifyChange();
}

export function showPart(part: ThemePartName): boolean {
    if (!editor) return false;
    const target = entries.get(part);
    if (!target) return false;
    if (activePart) {
        const current = entries.get(activePart);
        if (current && typeof editor.saveViewState === 'function') {
            current.viewState = editor.saveViewState();
        }
    }
    editor.setModel(target.model);
    activePart = part;
    if (target.viewState && typeof editor.restoreViewState === 'function') {
        editor.restoreViewState(target.viewState);
    }
    editor.focus();
    return true;
}

export function getPart(part: ThemePartName): string | null {
    return entries.get(part)?.model.getValue() ?? null;
}

export function getAllParts(): ThemeEditorParts {
    const result: ThemeEditorParts = {};
    for (const part of PART_ORDER) {
        const entry = entries.get(part);
        if (entry) result[part] = entry.model.getValue();
    }
    return result;
}

export function isDirty(): boolean {
    for (const [part, entry] of entries) {
        if (entry.model.getValue() !== cleanValues.get(part)) return true;
    }
    return false;
}

export function onChange(handler: (() => void) | null): void {
    changeHandler = handler;
}

export function setTheme(mode: 'light' | 'dark'): void {
    const monaco = getMonaco();
    if (!editor || !monaco) {
        pendingTheme = mode;
        return;
    }
    monaco.editor.setTheme(mode === 'dark' ? 'vs-dark' : 'vs');
}

export function layout(): void {
    if (editor) editor.layout();
}

export function dispose(): void {
    disposeModels();
    if (editor) {
        try { editor.dispose(); } catch { /* ignore */ }
        editor = null;
    }
    mountedElementId = null;
    pendingParts = null;
    activePart = null;
    changeHandler = null;
}

function disposeModels(): void {
    if (editor) editor.setModel(null);
    for (const entry of entries.values()) {
        try { entry.subscription?.dispose(); } catch { /* ignore */ }
        try { entry.model.dispose(); } catch { /* ignore */ }
    }
    entries.clear();
    cleanValues.clear();
    activePart = null;
}

function notifyChange(): void {
    if (changeHandler) changeHandler();
}
