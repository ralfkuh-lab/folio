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
vi.mock('../../app/state/tabs', () => ({
    getActiveTabId: vi.fn(),
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

    it('verwirft stale document:loaded mit aelterer seq (Undo-Stack-Schutz)', async () => {
        const docMod = await import('../../app/state/document');
        const shellMod = await import('../../app/editor/shell');
        const loadEditorTextMock = vi.mocked(shellMod.loadEditorText);
        loadEditorTextMock.mockClear();
        docMod.initDocumentState({ setActiveMode: vi.fn() });

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

describe('state/document — lifecycle seq guards (spec)', () => {
    async function initAndLoadWithSeq(seq: number, path = '/tmp/doc.md', text = 'content') {
        const docMod = await import('../../app/state/document');
        const tabsMod = await import('../../app/state/tabs');
        vi.mocked(tabsMod.getActiveTabId).mockReturnValue(1);
        docMod.initDocumentState({ setActiveMode: vi.fn() });
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
        docMod.initDocumentState({ setActiveMode: vi.fn() });
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
        docMod.initDocumentState({ setActiveMode: vi.fn() });

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
