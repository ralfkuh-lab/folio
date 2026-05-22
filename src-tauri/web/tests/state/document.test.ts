// Tests fuer state/document.ts — fokussiert auf die direkt aufrufbaren
// Setter (markDirty/setStatusPath/updateWordCount/showStatus) und den
// document:loaded-Listener-Pfad ueber den Tauri-Event-Mock.
//
// Der Listener-Test deckt den document:loaded-Handler ab:
// State zuerst (currentPath/cleanText/dirty), dann UI-Rendering
// (Body-innerHTML/TOC/HTML-Preview). Wir verifizieren hier nur das
// State-Setup und die DOM-Side-Effects, nicht den Editor-Mount-Pfad.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';

// Cross-Modul-Imports von state/document.ts mocken — wir testen hier
// nur State + DOM-Side-Effects von document.ts selbst, nicht die
// gerufenen View-/Vault-/Editor-Setter.
vi.mock('../../app/view/markdown', () => ({
    setTocList: vi.fn(),
    rewriteRelativeAssets: vi.fn(),
    ViewFinder: { setFindTerm: vi.fn() },
}));
vi.mock('../../app/view/html', () => ({
    clearHtmlView: vi.fn(),
    HtmlFinder: { setFindTerm: vi.fn() },
    isHtmlDocument: vi.fn((kind: string, language: string, path?: string) => {
        return kind === 'text' && ((language || '').toLowerCase() === 'html' || /\.(html|htm)$/i.test(path || ''));
    }),
    mountHtmlView: vi.fn(),
}));
vi.mock('../../app/vault/tree', () => ({
    setVaultActive: vi.fn(),
}));
vi.mock('../../app/ui/language-picker', () => ({
    setEditorLanguageDisplay: vi.fn(),
}));
vi.mock('../../app/ui/cheatsheet', () => ({
    syncCheatsheetMenu: vi.fn(),
}));
vi.mock('../../app/ui/dialogs', () => ({
    showUnsavedDialog: vi.fn(),
}));
vi.mock('../../app/editor/shell', () => ({
    isEditorMounted: vi.fn().mockReturnValue(false),
    loadEditorText: vi.fn(),
}));

let tauri: TauriMockHandles;

function buildDom(): void {
    document.body.innerHTML = `
        <div id="status-path"></div>
        <span id="status-wordcount"></span>
        <button id="tb-save"></button>
        <button id="tb-mode-view"></button>
        <button id="tb-mode-edit"></button>
        <button id="tb-mode-split"></button>
        <button id="tb-export"></button>
        <div id="view-region"><div class="markdown-body"></div></div>
        <div id="html-view-region"><iframe id="html-view-frame"></iframe></div>
        <div id="code-view-region"><div id="code-view-mount"></div></div>
        <div id="find-bar"></div>
        <input id="find-input" />
    `;
    document.body.className = '';
}

beforeEach(() => {
    tauri = installTauriMock();
    buildDom();
    vi.resetModules();
});

describe('state/document — synchronous setters', () => {
    it('markDirty toggles button + status-path class + window title', async () => {
        const { markDirty, getIsDirty } = await import('../../app/state/document');

        markDirty(true);
        expect(getIsDirty()).toBe(true);
        expect(document.getElementById('status-path')!.classList.contains('dirty')).toBe(true);
        expect((document.getElementById('tb-save') as HTMLButtonElement).disabled).toBe(false);

        markDirty(false);
        expect(getIsDirty()).toBe(false);
        expect(document.getElementById('status-path')!.classList.contains('dirty')).toBe(false);
        expect((document.getElementById('tb-save') as HTMLButtonElement).disabled).toBe(true);
    });

    it('updateWordCount renders 3-fact line and hides empty', async () => {
        const { updateWordCount } = await import('../../app/state/document');
        const el = document.getElementById('status-wordcount') as HTMLElement;

        updateWordCount('hello world\nzwei zeilen');
        expect(el.hidden).toBe(false);
        expect(el.textContent).toContain('4 Wörter');
        expect(el.textContent).toContain('Zeichen');
        expect(el.textContent).toContain('2 Zeilen');

        updateWordCount('');
        expect(el.hidden).toBe(true);
        expect(el.textContent).toBe('');
    });

    it('setStatusPath falls back to "Bereit" for empty input', async () => {
        const { setStatusPath } = await import('../../app/state/document');
        const el = document.getElementById('status-path') as HTMLElement;

        setStatusPath('/tmp/doc.md', true);
        expect(el.textContent).toBe('/tmp/doc.md');
        expect(el.classList.contains('dirty')).toBe(true);

        setStatusPath('', false);
        expect(el.textContent).toBe('Bereit');
        expect(el.classList.contains('dirty')).toBe(false);
    });
});

describe('state/document — document:loaded listener', () => {
    it('updates currentPath/cleanText/body-kind on payload', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState({ setActiveMode: vi.fn() });

        tauri.emitEvent('document:loaded', {
            path: '/tmp/example.md',
            kind: 'markdown',
            language: 'markdown',
            text: 'Hello world',
            content: '<p>Hello world</p>',
            tocHtml: '',
        });

        expect(docMod.getCurrentPath()).toBe('/tmp/example.md');
        expect(docMod.getCleanText()).toBe('Hello world');
        expect(docMod.getIsDirty()).toBe(false);
        expect(document.body.classList.contains('kind-markdown')).toBe(true);
        expect(document.getElementById('status-path')!.textContent).toBe('/tmp/example.md');
    });

    it('document:closed clears state + body-class falls back to kind-unknown', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState({ setActiveMode: vi.fn() });

        tauri.emitEvent('document:loaded', {
            path: '/tmp/a.md',
            kind: 'markdown',
            text: 'x',
            content: '',
            tocHtml: '',
        });
        expect(docMod.getCurrentPath()).toBe('/tmp/a.md');

        tauri.emitEvent('document:closed', undefined);
        expect(docMod.getCurrentPath()).toBeNull();
        expect(docMod.getCleanText()).toBe('');
        expect(document.body.classList.contains('kind-unknown')).toBe(true);
        expect(document.getElementById('status-path')!.textContent).toBe('Bereit');
    });

    it('document:dirty_changed forwards is_dirty into markDirty', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState({ setActiveMode: vi.fn() });

        tauri.emitEvent('document:dirty_changed', { is_dirty: true });
        expect(docMod.getIsDirty()).toBe(true);

        tauri.emitEvent('document:dirty_changed', { is_dirty: false });
        expect(docMod.getIsDirty()).toBe(false);
    });

    it('document:external_changed reloads when not dirty, warns when dirty', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState({ setActiveMode: vi.fn() });

        tauri.emitEvent('document:loaded', {
            path: '/tmp/a.md',
            kind: 'markdown',
            text: 'x',
            content: '',
            tocHtml: '',
        });
        tauri.invoke.mockClear();

        // Sauberer Buffer → reload_document wird gerufen
        tauri.emitEvent('document:external_changed', { path: '/tmp/a.md' });
        const reloadCalled = tauri.invoke.mock.calls.some(
            (c: any[]) => c[0] === 'reload_document',
        );
        expect(reloadCalled).toBe(true);

        // Dirty-Buffer → kein reload, statt dessen Status-Hinweis
        tauri.invoke.mockClear();
        docMod.markDirty(true);
        tauri.emitEvent('document:external_changed', { path: '/tmp/a.md' });
        const reloadCalls = tauri.invoke.mock.calls.filter((c: any[]) => c[0] === 'reload_document');
        expect(reloadCalls.length).toBe(0);
        expect(document.getElementById('status-path')!.textContent).toContain('extern geändert');
    });

    it('html text files mount sandbox HTML preview instead of code view', async () => {
        const htmlView = await import('../../app/view/html');
        const docMod = await import('../../app/state/document');
        const codeView = {
            mount: vi.fn(),
            setText: vi.fn(),
            setTheme: vi.fn(),
            layout: vi.fn(),
            dispose: vi.fn(),
            isMounted: vi.fn(),
        };
        (window as any).FolioCodeView = codeView;
        docMod.initDocumentState({ setActiveMode: vi.fn() });

        tauri.emitEvent('document:loaded', {
            path: '/tmp/page.html',
            kind: 'text',
            language: 'html',
            text: '<h1>Hello</h1>',
            content: '',
            tocHtml: '',
        });

        expect(document.body.classList.contains('kind-text')).toBe(true);
        expect(document.body.classList.contains('html-preview-mode')).toBe(true);
        expect(htmlView.mountHtmlView).toHaveBeenCalledWith(
            'html-view-frame',
            '<h1>Hello</h1>',
            '/tmp/page.html',
            expect.any(Function),
        );
        expect(codeView.mount).not.toHaveBeenCalled();
        expect(codeView.dispose).toHaveBeenCalled();
    });
});
