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
import { seedDeCatalog } from '../helpers-i18n';

// Cross-Modul-Imports von state/document.ts mocken — wir testen hier
// nur State + DOM-Side-Effects von document.ts selbst, nicht die
// gerufenen View-/Vault-/Editor-Setter.
vi.mock('../../app/view/markdown', () => ({
    setTocList: vi.fn(),
    rewriteRelativeAssets: vi.fn(),
    prepareMarkdownView: vi.fn(),
    ViewFinder: { setFindTerm: vi.fn() },
}));
vi.mock('../../app/view/html', () => ({
    clearHtmlView: vi.fn(),
    HtmlFinder: { setFindTerm: vi.fn() },
    isHtmlDocument: vi.fn((kind: string, language: string, path?: string) => {
        return kind === 'text' && ((language || '').toLowerCase() === 'html' || /\.(html|htm)$/i.test(path || ''));
    }),
    mountHtmlView: vi.fn(),
    invalidateHtmlLive: vi.fn(),
    scheduleHtmlLiveUpdate: vi.fn(),
    initHtmlLiveUpdate: vi.fn(),
}));
vi.mock('../../app/view/code-live', () => ({
    invalidateCodeLive: vi.fn(),
    scheduleCodeLiveUpdate: vi.fn(),
    initCodeLiveUpdate: vi.fn(),
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
vi.mock('../../app/state/tabs', () => ({
    getActiveTabId: vi.fn(),
}));

let tauri: TauriMockHandles;

function buildDom(): void {
    document.body.innerHTML = `
        <div id="status-path"></div>
        <span id="status-wordcount"></span>
        <span id="status-cursor" hidden></span>
        <span id="status-encoding" hidden></span>
        <button id="status-eol" type="button" hidden></button>
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

beforeEach(async () => {
    tauri = installTauriMock();
    buildDom();
    vi.resetModules();
    await seedDeCatalog();
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

    it('updateWordCount matches sample.md sizes exactly (E2E status bar)', async () => {
        // Production algorithm on tests/e2e/fixtures/sample.md (JS string length).
        // Protects visual baselines that include the status word-count cell.
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const { updateWordCount } = await import('../../app/state/document');
        const el = document.getElementById('status-wordcount') as HTMLElement;
        const sample = readFileSync(
            resolve(__dirname, '../../../../tests/e2e/fixtures/sample.md'),
            'utf8',
        );
        updateWordCount(sample);
        expect(el.hidden).toBe(false);
        expect(el.textContent).toBe('95 Wörter · 611 Zeichen · 35 Zeilen');
    });

    it('updateEncoding shows technical label only for non-UTF-8 text docs', async () => {
        const { updateEncoding } = await import('../../app/state/document');
        const el = document.getElementById('status-encoding') as HTMLElement;

        // Reines UTF-8 (Normalfall) -> versteckt.
        updateEncoding('utf8', 'markdown');
        expect(el.hidden).toBe(true);
        expect(el.textContent).toBe('');

        // Windows-1252 auf Text-Dokument -> sichtbar, technisches Label.
        updateEncoding('windows1252', 'text');
        expect(el.hidden).toBe(false);
        expect(el.textContent).toBe('Windows-1252');

        // UTF-8 BOM / UTF-16 -> eigene Labels.
        updateEncoding('utf8-bom', 'markdown');
        expect(el.textContent).toBe('UTF-8 BOM');
        updateEncoding('utf16le', 'text');
        expect(el.textContent).toBe('UTF-16 LE');
        updateEncoding('utf16be', 'markdown');
        expect(el.textContent).toBe('UTF-16 BE');

        // Nicht-Text-Kind (Bild) -> immer versteckt, selbst bei non-UTF-8.
        updateEncoding('windows1252', 'image');
        expect(el.hidden).toBe(true);

        // Fehlendes/leeres Encoding -> versteckt.
        updateEncoding(undefined, 'markdown');
        expect(el.hidden).toBe(true);
    });

    it('updateLineEnding shows LF/CRLF only for textual docs', async () => {
        const { updateLineEnding } = await import('../../app/state/document');
        const el = document.getElementById('status-eol') as HTMLButtonElement;

        updateLineEnding('lf', 'markdown');
        expect(el.hidden).toBe(false);
        expect(el.textContent).toBe('LF');

        updateLineEnding('crlf', 'text');
        expect(el.hidden).toBe(false);
        expect(el.textContent).toBe('CRLF');

        updateLineEnding('lf', 'image');
        expect(el.hidden).toBe(true);

        updateLineEnding(undefined, 'markdown');
        expect(el.hidden).toBe(true);
        expect(el.textContent).toBe('');
    });

    it('updateSelectionWordCount swaps in selection stats and restores doc stats', async () => {
        const { updateWordCount, updateSelectionWordCount } = await import('../../app/state/document');
        const el = document.getElementById('status-wordcount') as HTMLElement;

        updateWordCount('hello world');
        expect(el.hidden).toBe(false);
        const docText = el.textContent;
        expect(docText).toContain('Wörter');
        expect(docText).toMatch(/Zeile/);

        updateSelectionWordCount(5, 1);
        expect(el.hidden).toBe(false);
        expect(el.textContent).toContain('ausgewählt');
        expect(el.textContent).toContain('1 Wort');
        expect(el.textContent).toContain('5 Zeichen');

        updateSelectionWordCount(0, 0);
        expect(el.textContent).toBe(docText);
    });

    it('updateCursorStatus shows template and hideCursorStatus clears', async () => {
        const { updateCursorStatus, hideCursorStatus } = await import('../../app/state/document');
        const el = document.getElementById('status-cursor') as HTMLElement;

        updateCursorStatus(3, 12);
        expect(el.hidden).toBe(false);
        expect(el.textContent).toBe('Zeile 3, Spalte 12');

        hideCursorStatus();
        expect(el.hidden).toBe(true);
        expect(el.textContent).toBe('');
    });

    it('saveCurrent surfaces a rejected save as a visible status message', async () => {
        const docMod = await import('../../app/state/document');
        const msg = 'Datei enthält Zeichen, die sich nicht in Windows-1252 speichern lassen: 😀';
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'editor_save_requested') return Promise.reject(msg);
            return Promise.resolve(undefined);
        });
        const ok = await docMod.saveCurrent();
        expect(ok).toBe(false);
        expect(document.getElementById('status-path')!.textContent).toBe(msg);
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

    it('applyDocKind synchronisiert Export-Button und file.export-Menüeintrag', async () => {
        const { applyDocKind } = await import('../../app/state/document');
        const button = document.getElementById('tb-export') as HTMLButtonElement;

        applyDocKind('markdown');
        expect(button.disabled).toBe(false);
        expect(tauri.invoke).toHaveBeenCalledWith('menu_set_enabled', {
            id: 'file.export',
            enabled: true,
        });

        tauri.invoke.mockClear();
        applyDocKind('text');
        expect(button.disabled).toBe(true);
        expect(tauri.invoke).toHaveBeenCalledWith('menu_set_enabled', {
            id: 'file.export',
            enabled: false,
        });
    });

    it('applyDocKind sendet kind und path additiv im CustomEvent', async () => {
        const { applyDocKind } = await import('../../app/state/document');
        const seen: Array<{ kind?: string; path?: string | null }> = [];
        window.addEventListener('folio-doc-kind-changed', (event) => {
            seen.push((event as CustomEvent<{ kind?: string; path?: string | null }>).detail);
        });
        applyDocKind('image', '/tmp/pic.png');
        expect(seen[0]).toEqual({ kind: 'image', path: '/tmp/pic.png' });
    });
});

describe('state/document — document:loaded listener', () => {
    it('updates currentPath/cleanText/body-kind on payload', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState();

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

    it('document:loaded liefert kind+path korreliert im folio-doc-kind-changed', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState();
        const seen: Array<{ kind?: string; path?: string | null }> = [];
        window.addEventListener('folio-doc-kind-changed', (event) => {
            seen.push((event as CustomEvent<{ kind?: string; path?: string | null }>).detail);
        });
        tauri.emitEvent('document:loaded', {
            path: '/tmp/example.md',
            kind: 'markdown',
            language: 'markdown',
            text: 'Hello world',
            content: '<p>Hello world</p>',
            tocHtml: '',
        });
        expect(seen.some((d) => d.kind === 'markdown' && d.path === '/tmp/example.md')).toBe(true);
    });

    it('verwirft stale document:loaded mit aelterer seq (Undo-Stack-Schutz)', async () => {
        const docMod = await import('../../app/state/document');
        const shellMod = await import('../../app/editor/shell');
        const loadEditorTextMock = vi.mocked(shellMod.loadEditorText);
        loadEditorTextMock.mockClear();
        docMod.initDocumentState();

        tauri.emitEvent('document:loaded', {
            path: '/tmp/neu.md',
            kind: 'markdown',
            text: 'neuer Stand',
            content: '',
            tocHtml: '',
            seq: 7,
        });
        expect(docMod.getCurrentPath()).toBe('/tmp/neu.md');
        expect(docMod.getCleanText()).toBe('neuer Stand');
        expect(loadEditorTextMock).toHaveBeenCalledTimes(1);

        // Verspaetet zugestelltes Event mit aelterer seq: darf NICHTS anfassen —
        // insbesondere loadEditorText nicht erreichen (der Weg zu
        // FolioEditor.setDocument -> doSetText -> setValue, der den
        // Undo-Stack loeschen wuerde).
        tauri.emitEvent('document:loaded', {
            path: '/tmp/alt.md',
            kind: 'markdown',
            text: 'alter Stand',
            content: '',
            tocHtml: '',
            seq: 6,
        });
        expect(docMod.getCurrentPath()).toBe('/tmp/neu.md');
        expect(docMod.getCleanText()).toBe('neuer Stand');
        expect(loadEditorTextMock).toHaveBeenCalledTimes(1);

        // Gleiche seq (Duplikat) ebenfalls verwerfen.
        tauri.emitEvent('document:loaded', {
            path: '/tmp/dup.md',
            kind: 'markdown',
            text: 'duplikat',
            content: '',
            tocHtml: '',
            seq: 7,
        });
        expect(docMod.getCurrentPath()).toBe('/tmp/neu.md');

        // Neuere seq wird normal angewandt; Events OHNE seq (Alt-Pfad)
        // bleiben kompatibel.
        tauri.emitEvent('document:loaded', {
            path: '/tmp/neuer.md',
            kind: 'markdown',
            text: 'noch neuer',
            content: '',
            tocHtml: '',
            seq: 8,
        });
        expect(docMod.getCurrentPath()).toBe('/tmp/neuer.md');
        tauri.emitEvent('document:loaded', {
            path: '/tmp/ohne-seq.md',
            kind: 'markdown',
            text: 'ohne seq',
            content: '',
            tocHtml: '',
        });
        expect(docMod.getCurrentPath()).toBe('/tmp/ohne-seq.md');
    });

    it('document:closed clears state + body-class falls back to kind-unknown', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState();

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
        docMod.initDocumentState();

        tauri.emitEvent('document:dirty_changed', { is_dirty: true });
        expect(docMod.getIsDirty()).toBe(true);

        tauri.emitEvent('document:dirty_changed', { is_dirty: false });
        expect(docMod.getIsDirty()).toBe(false);
    });

    it('document:external_changed reloads when not dirty, warns when dirty', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState();

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
        docMod.initDocumentState();

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

    it('document:encoding_changed updates the cell via the body kind, validating tabId', async () => {
        const docMod = await import('../../app/state/document');
        const tabsMod = await import('../../app/state/tabs');
        vi.mocked(tabsMod.getActiveTabId).mockReturnValue(1);
        docMod.initDocumentState();
        const el = document.getElementById('status-encoding') as HTMLElement;

        // Markdown-Dokument (utf8, kein encoding-Feld) laden -> Zelle versteckt.
        tauri.emitEvent('document:loaded', {
            path: '/tmp/a.md', kind: 'markdown', text: 'x', content: '', tocHtml: '', tabId: 1,
        });
        expect(el.hidden).toBe(true);

        // Metadaten-only-Reload zu UTF-8-BOM -> Zelle sichtbar, kind aus body.
        tauri.emitEvent('document:encoding_changed', { encoding: 'utf8-bom', tabId: 1 });
        expect(el.hidden).toBe(false);
        expect(el.textContent).toBe('UTF-8 BOM');

        // Fremde tabId -> verworfen, Zelle unveraendert.
        tauri.emitEvent('document:encoding_changed', { encoding: 'windows1252', tabId: 99 });
        expect(el.textContent).toBe('UTF-8 BOM');
    });

    it('document:loaded sets EOL cell and hides cursor until selection event', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState();
        const eol = document.getElementById('status-eol') as HTMLButtonElement;
        const cursor = document.getElementById('status-cursor') as HTMLElement;

        tauri.emitEvent('document:loaded', {
            path: '/tmp/a.md',
            kind: 'markdown',
            text: 'hello',
            content: '',
            tocHtml: '',
            lineEnding: 'crlf',
            tabId: 1,
        });
        expect(eol.hidden).toBe(false);
        expect(eol.textContent).toBe('CRLF');
        expect(cursor.hidden).toBe(true);

        window.dispatchEvent(new CustomEvent('folio-editor-selection', {
            detail: { line: 1, column: 3, selChars: 0, selWords: 0 },
        }));
        expect(cursor.hidden).toBe(false);
        expect(cursor.textContent).toBe('Zeile 1, Spalte 3');
    });

    it('document:eol_changed updates the cell with tabId guard', async () => {
        const docMod = await import('../../app/state/document');
        const tabsMod = await import('../../app/state/tabs');
        vi.mocked(tabsMod.getActiveTabId).mockReturnValue(1);
        docMod.initDocumentState();
        const eol = document.getElementById('status-eol') as HTMLButtonElement;

        tauri.emitEvent('document:loaded', {
            path: '/tmp/a.md', kind: 'markdown', text: 'x', content: '', tocHtml: '',
            lineEnding: 'lf', tabId: 1,
        });
        expect(eol.textContent).toBe('LF');

        tauri.emitEvent('document:eol_changed', { eol: 'crlf', tabId: 1 });
        expect(eol.textContent).toBe('CRLF');

        tauri.emitEvent('document:eol_changed', { eol: 'lf', tabId: 99 });
        expect(eol.textContent).toBe('CRLF');
    });

    it('EOL button click invokes set_line_ending with toggled value', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState();
        const eol = document.getElementById('status-eol') as HTMLButtonElement;

        tauri.emitEvent('document:loaded', {
            path: '/tmp/a.md', kind: 'markdown', text: 'x', content: '', tocHtml: '',
            lineEnding: 'lf', tabId: 1,
        });
        tauri.invoke.mockClear();
        eol.click();
        expect(tauri.invoke).toHaveBeenCalledWith('set_line_ending', { eol: 'crlf' });
    });

    it('EOL toggle keeps dirty through refreshDirtyFromEditor / requestSaveIfDirty', async () => {
        // FX1: refreshDirtyFromEditor darf Backend-EOL-Dirty nicht still loeschen.
        const dialogs = await import('../../app/ui/dialogs');
        vi.mocked(dialogs.showUnsavedDialog).mockResolvedValue('cancel');
        const docMod = await import('../../app/state/document');
        const tabsMod = await import('../../app/state/tabs');
        vi.mocked(tabsMod.getActiveTabId).mockReturnValue(1);
        docMod.initDocumentState();

        tauri.emitEvent('document:loaded', {
            path: '/tmp/a.md',
            kind: 'markdown',
            text: 'hello',
            content: '',
            tocHtml: '',
            lineEnding: 'lf',
            tabId: 1,
            seq: 1,
        });
        expect(docMod.getIsDirty()).toBe(false);

        // Toggle via Backend-Event (currentEol aendert sich, cleanEol bleibt lf).
        tauri.emitEvent('document:eol_changed', { eol: 'crlf', tabId: 1 });
        tauri.emitEvent('document:dirty_changed', { is_dirty: true, tabId: 1, seq: 2 });
        expect(docMod.getIsDirty()).toBe(true);

        // requestSaveIfDirty ruft refreshDirtyFromEditor — muss dirty halten.
        const ok = await docMod.requestSaveIfDirty();
        expect(ok).toBe(false); // cancel
        expect(docMod.getIsDirty()).toBe(true);
        expect(dialogs.showUnsavedDialog).toHaveBeenCalled();
    });

    it('document:save_error surfaces the localized message in the status bar', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState();
        const msg = 'Datei enthält Zeichen, die sich nicht in Windows-1252 speichern lassen: 😀';
        tauri.emitEvent('document:save_error', { message: msg });
        expect(document.getElementById('status-path')!.textContent).toBe(msg);
    });
});

describe('state/document — lifecycle seq guards (spec)', () => {
    async function initAndLoadWithSeq(seq: number, path = '/tmp/doc.md', text = 'content') {
        const docMod = await import('../../app/state/document');
        const tabsMod = await import('../../app/state/tabs');
        vi.mocked(tabsMod.getActiveTabId).mockReturnValue(1);
        docMod.initDocumentState();
        tauri.emitEvent('document:loaded', {
            path,
            kind: 'markdown',
            text,
            content: '',
            tocHtml: '',
            seq,
            tabId: 1,
        });
        return docMod;
    }

    beforeEach(() => {
        // ensure fresh modules for each subtest
        vi.clearAllMocks();
    });

    it('verwirft saved mit aelterer seq (cleanText bleibt unveraendert)', async () => {
        const docMod = await initAndLoadWithSeq(10, '/tmp/a.md', 'original');
        expect(docMod.getCleanText()).toBe('original');

        tauri.emitEvent('document:saved', {
            path: '/tmp/a.md',
            text: 'from-old-save',
            seq: 9,
            tabId: 1,
        });
        expect(docMod.getCleanText()).toBe('original'); // stale verworfen

        tauri.emitEvent('document:saved', {
            path: '/tmp/a.md',
            text: 'fresh-save',
            seq: 11,
            tabId: 1,
        });
        expect(docMod.getCleanText()).toBe('fresh-save');
    });

    it('verwirft dirty_changed mit aelterer seq', async () => {
        const docMod = await initAndLoadWithSeq(20);
        expect(docMod.getIsDirty()).toBe(false);

        tauri.emitEvent('document:dirty_changed', { is_dirty: true, seq: 19, tabId: 1 });
        expect(docMod.getIsDirty()).toBe(false);

        tauri.emitEvent('document:dirty_changed', { is_dirty: true, seq: 21, tabId: 1 });
        expect(docMod.getIsDirty()).toBe(true);
    });

    it('verwirft closed mit aelterer seq (state bleibt)', async () => {
        const docMod = await initAndLoadWithSeq(30);
        expect(docMod.getCurrentPath()).toBe('/tmp/doc.md');

        tauri.emitEvent('document:closed', { seq: 29, tabId: 1 });
        expect(docMod.getCurrentPath()).toBe('/tmp/doc.md');

        tauri.emitEvent('document:closed', { seq: 31, tabId: 1 });
        expect(docMod.getCurrentPath()).toBeNull();
    });

    it('dirty_changed mit fremder tabId wird verworfen; ohne oder passend angewandt', async () => {
        // Referenz fuer "passend" ist der zuletzt GELADENE Tab (tabId 1 aus
        // initAndLoadWithSeq), NICHT getActiveTabId() — die tabs:changed-
        // Sicht hinkt bei Tab-Aktivierung hinterher (Emit-Reihenfolge
        // loaded -> dirty -> tabs:changed).
        const docMod = await initAndLoadWithSeq(40);
        const tabsMod = await import('../../app/state/tabs');
        vi.mocked(tabsMod.getActiveTabId).mockReturnValue(42);

        // fremd (weder geladener Tab noch sonstwas Passendes)
        tauri.emitEvent('document:dirty_changed', { is_dirty: true, seq: 41, tabId: 99 });
        expect(docMod.getIsDirty()).toBe(false);

        // ohne tabId -> anwenden
        tauri.emitEvent('document:dirty_changed', { is_dirty: true, seq: 42 });
        expect(docMod.getIsDirty()).toBe(true);

        // passend = zuletzt geladener Tab
        tauri.emitEvent('document:dirty_changed', { is_dirty: false, seq: 43, tabId: 1 });
        expect(docMod.getIsDirty()).toBe(false);
    });

    it('verworfenes Fremd-Event rueckt die Sequenz NICHT vor (last-applied-Semantik)', async () => {
        // codex-Review-Befund: ein per tabId verworfenes dirty darf die
        // Lifecycle-Sequenz nicht vorruecken — sonst wuerde ein danach
        // zugestelltes legitimes Event mit kleinerer seq unterdrueckt.
        const docMod = await initAndLoadWithSeq(60); // laedt tab 1, seq 60
        tauri.emitEvent('document:dirty_changed', { is_dirty: true, seq: 65, tabId: 99 });
        expect(docMod.getIsDirty()).toBe(false); // verworfen
        // Legitimes Event mit seq zwischen 60 und 65 muss noch anwenden.
        tauri.emitEvent('document:dirty_changed', { is_dirty: true, seq: 62, tabId: 1 });
        expect(docMod.getIsDirty()).toBe(true);
    });

    it('dirty_changed des frisch aktivierten Tabs wird angewandt, obwohl tabs:changed noch aussteht', async () => {
        // Aktivierungs-Sequenz aus commands/tabs.rs: loaded(tab 2) ->
        // dirty_changed(tab 2) -> tabs:changed. getActiveTabId() liefert
        // zu diesem Zeitpunkt noch den ALTEN Tab — das dirty des neuen
        // Tabs darf trotzdem nicht als "fremd" verworfen werden.
        const docMod = await initAndLoadWithSeq(50); // laedt tab 1
        const tabsMod = await import('../../app/state/tabs');
        vi.mocked(tabsMod.getActiveTabId).mockReturnValue(1); // tabs:changed haengt

        tauri.emitEvent('document:loaded', {
            path: '/tmp/zwei.md',
            kind: 'markdown',
            text: 'tab zwei',
            content: '',
            tocHtml: '',
            seq: 51,
            tabId: 2,
        });
        tauri.emitEvent('document:dirty_changed', { is_dirty: true, seq: 52, tabId: 2 });
        expect(docMod.getIsDirty()).toBe(true);
    });

    it('bestehende Events ohne seq bleiben kompatibel (Alt-Pfad)', async () => {
        const docMod = await import('../../app/state/document');
        docMod.initDocumentState();
        tauri.emitEvent('document:loaded', { path: '/tmp/no-seq.md', kind: 'text', text: 'no-seq', content: '', tocHtml: '' });
        expect(docMod.getCurrentPath()).toBe('/tmp/no-seq.md');
        tauri.emitEvent('document:dirty_changed', { is_dirty: true });
        expect(docMod.getIsDirty()).toBe(true);
        tauri.emitEvent('document:saved', { path: '/tmp/no-seq.md', text: 'saved-no-seq' });
        expect(docMod.getCleanText()).toBe('saved-no-seq');
        tauri.emitEvent('document:closed', {});
        expect(docMod.getCurrentPath()).toBeNull();
    });

    it('Szenario: loaded(5) -> closed(6) -> verspaetetes loaded(4/5) verworfen; loaded(7) nach closed wird angewandt', async () => {
        const docMod = await import('../../app/state/document');
        const tabsMod = await import('../../app/state/tabs');
        vi.mocked(tabsMod.getActiveTabId).mockReturnValue(1);
        docMod.initDocumentState();

        tauri.emitEvent('document:loaded', { path: '/p.md', text: 'v5', seq: 5, tabId: 1 });
        expect(docMod.getCleanText()).toBe('v5');

        tauri.emitEvent('document:closed', { seq: 6, tabId: 1 });
        expect(docMod.getCurrentPath()).toBeNull();

        // verspaetetes altes loaded
        tauri.emitEvent('document:loaded', { path: '/p.md', text: 'stale4', seq: 4, tabId: 1 });
        expect(docMod.getCurrentPath()).toBeNull();

        tauri.emitEvent('document:loaded', { path: '/p.md', text: 'stale5', seq: 5, tabId: 1 });
        expect(docMod.getCurrentPath()).toBeNull();

        // neues nach close
        tauri.emitEvent('document:loaded', { path: '/q.md', text: 'v7', seq: 7, tabId: 1 });
        expect(docMod.getCurrentPath()).toBe('/q.md');
        expect(docMod.getCleanText()).toBe('v7');
    });
});
