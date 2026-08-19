// Tests fuer ui/find-bar.ts. Schwerpunkt:
// - openEditorFind oeffnet Bar + ruft Finder.openFind mit dem Term.
// - View↔Edit-Wechsel waehlt den richtigen Finder (FolioEditor im
//   Edit-Mode, ViewFinder im View-Mode).
// - setEditorFindTerm setzt das Input-Value und ruft setFindTerm
//   (oder oeffnet die Bar, wenn sie geschlossen war).
// - afterModeSwitch schliesst beide Finder und re-opent den aktuellen.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

// ViewFinder ist Modul-Import — wir mocken ihn, damit wir die Aufrufe spy-en koennen.
const viewFinder = {
    setFindOptions: vi.fn(),
    openFind: vi.fn(),
    closeFind: vi.fn(),
    setFindTerm: vi.fn(),
    findNext: vi.fn(),
    findPrev: vi.fn(),
};
const htmlFinder = {
    setFindOptions: vi.fn(),
    openFind: vi.fn(),
    closeFind: vi.fn(),
    setFindTerm: vi.fn(),
    findNext: vi.fn(),
    findPrev: vi.fn(),
};
vi.mock('../../app/view/markdown', () => ({
    ViewFinder: viewFinder,
}));
vi.mock('../../app/view/html', () => ({
    HtmlFinder: htmlFinder,
    invalidateHtmlLive: vi.fn(),
    scheduleHtmlLiveUpdate: vi.fn(),
    initHtmlLiveUpdate: vi.fn(),
    mountHtmlView: vi.fn(),
    clearHtmlView: vi.fn(),
    isHtmlDocument: vi.fn(() => false),
}));
vi.mock('../../app/view/code-live', () => ({
    invalidateCodeLive: vi.fn(),
    scheduleCodeLiveUpdate: vi.fn(),
    initCodeLiveUpdate: vi.fn(),
}));

// window.FolioEditor stellt der Test selbst — Surface-Spy fuer Edit-Mode.
function installFolioEditorSpy() {
    const spy = {
        setFindOptions: vi.fn(),
        openFind: vi.fn(),
        closeFind: vi.fn(),
        setFindTerm: vi.fn(),
        findNext: vi.fn(),
        findPrev: vi.fn(),
        replaceCurrent: vi.fn(),
        replaceAll: vi.fn(),
        getSelection: vi.fn(() => ({ start: 0, length: 0 })),
    };
    (window as any).FolioEditor = spy;
    return spy;
}

function installCodeViewSpy() {
    const spy = {
        setFindOptions: vi.fn(),
        openFind: vi.fn(),
        closeFind: vi.fn(),
        setFindTerm: vi.fn(),
        findNext: vi.fn(),
        findPrev: vi.fn(),
        setSuppressActive: vi.fn(),
    };
    (window as any).FolioCodeView = spy;
    return spy;
}

function buildDom(): void {
    document.body.innerHTML = `
        <div id="find-bar">
            <button id="find-replace-toggle"></button>
            <input id="find-input" />
            <span id="find-counter"></span>
            <button id="find-prev"></button>
            <button id="find-next"></button>
            <button id="find-opts"></button>
            <button id="find-close"></button>
            <div id="find-replace-row">
                <input id="find-replace-input" />
                <button id="find-replace-one"></button>
                <button id="find-replace-all"></button>
            </div>
            <div id="find-opts-panel">
                <input id="find-case" type="checkbox" />
                <input id="find-word" type="checkbox" />
                <input id="find-regex" type="checkbox" />
                <input id="find-in-selection" type="checkbox" />
            </div>
        </div>
    `;
    document.body.className = '';
}

beforeEach(() => {
    installTauriMock();
    buildDom();
    delete (window as any).FolioEditor;
    delete (window as any).FolioCodeView;
    viewFinder.setFindOptions.mockClear();
    viewFinder.openFind.mockClear();
    viewFinder.closeFind.mockClear();
    viewFinder.setFindTerm.mockClear();
    viewFinder.findNext.mockClear();
    viewFinder.findPrev.mockClear();
    htmlFinder.setFindOptions.mockClear();
    htmlFinder.openFind.mockClear();
    htmlFinder.closeFind.mockClear();
    htmlFinder.setFindTerm.mockClear();
    htmlFinder.findNext.mockClear();
    htmlFinder.findPrev.mockClear();
    vi.resetModules();
});

describe('ui/find-bar — open path', () => {
    it('openEditorFind in view-mode opens bar + calls ViewFinder.openFind', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });

        findBar.openEditorFind('hello');

        const bar = document.getElementById('find-bar')!;
        expect(bar.classList.contains('open')).toBe(true);
        expect((document.getElementById('find-input') as HTMLInputElement).value).toBe('hello');
        expect(viewFinder.openFind).toHaveBeenCalledWith('hello');
    });

    it('openEditorFind in edit-mode awaits ensureEditorMounted + uses FolioEditor', async () => {
        const folioSpy = installFolioEditorSpy();
        const ensureMounted = vi.fn().mockResolvedValue(true);
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: ensureMounted,
            focusEditor: vi.fn(),
        });
        document.body.classList.add('edit-mode');

        findBar.openEditorFind('foo');
        // Erst nach Promise-Resolve ist die Bar offen.
        await Promise.resolve();
        await Promise.resolve();

        expect(ensureMounted).toHaveBeenCalledWith('');
        expect(folioSpy.openFind).toHaveBeenCalledWith('foo');
        expect(viewFinder.openFind).not.toHaveBeenCalled();
    });

    it('openEditorFind in html preview uses HtmlFinder', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text', 'html-preview-mode');

        findBar.openEditorFind('html');

        expect(htmlFinder.openFind).toHaveBeenCalledWith('html');
        expect(viewFinder.openFind).not.toHaveBeenCalled();
    });

    it('html iframe shortcut event opens the shared find bar', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text', 'html-preview-mode');

        window.dispatchEvent(new CustomEvent('folio-find-shortcut', {
            detail: { command: 'open' },
        }));

        expect(document.getElementById('find-bar')!.classList.contains('open')).toBe(true);
        expect(htmlFinder.openFind).toHaveBeenCalledWith('');
    });

    it('kind-text view-mode uses FolioCodeView finder', async () => {
        const codeSpy = installCodeViewSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text');

        findBar.openEditorFind('needle');

        expect(codeSpy.openFind).toHaveBeenCalledWith('needle');
        expect(viewFinder.openFind).not.toHaveBeenCalled();
        expect(htmlFinder.openFind).not.toHaveBeenCalled();
    });

    it('split kind-text drives editor and CodeView with passive highlights', async () => {
        const folioSpy = installFolioEditorSpy();
        const codeSpy = installCodeViewSpy();
        const ensureMounted = vi.fn().mockResolvedValue(true);
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: ensureMounted,
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text', 'split-mode');

        findBar.openEditorFind('shared');
        await Promise.resolve();
        await Promise.resolve();

        expect(ensureMounted).toHaveBeenCalledWith('');
        expect(folioSpy.openFind).toHaveBeenCalledWith('shared');
        expect(codeSpy.setSuppressActive).toHaveBeenCalledWith(true);
        expect(codeSpy.openFind).toHaveBeenCalledWith('shared');
    });
});

describe('ui/find-bar — term persistence', () => {
    it('setEditorFindTerm pushes term to input + calls setFindTerm when already open', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('initial');
        viewFinder.openFind.mockClear();

        findBar.setEditorFindTerm('new-term');

        expect((document.getElementById('find-input') as HTMLInputElement).value).toBe('new-term');
        expect(viewFinder.setFindTerm).toHaveBeenCalledWith('new-term');
        // open() wurde nicht erneut gerufen, weil die Bar bereits offen war.
        expect(viewFinder.openFind).not.toHaveBeenCalled();
    });

    it('setEditorFindTerm opens the bar if it was closed', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });

        findBar.setEditorFindTerm('first');

        expect(document.getElementById('find-bar')!.classList.contains('open')).toBe(true);
        expect((document.getElementById('find-input') as HTMLInputElement).value).toBe('first');
        expect(viewFinder.openFind).toHaveBeenCalledWith('first');
    });
});

describe('ui/find-bar — close path', () => {
    it('closeEditorFind drops .open + closes both finders', async () => {
        installFolioEditorSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('x');
        viewFinder.closeFind.mockClear();
        const folioSpy = (window as any).FolioEditor;
        folioSpy.closeFind.mockClear();

        findBar.closeEditorFind();

        expect(document.getElementById('find-bar')!.classList.contains('open')).toBe(false);
        // Beide Finder schliessen ist Race-Schutz fuer Mode-Switch.
        expect(viewFinder.closeFind).toHaveBeenCalled();
        expect(htmlFinder.closeFind).toHaveBeenCalled();
        expect(folioSpy.closeFind).toHaveBeenCalled();
    });
});

describe('ui/find-bar — shortcuts', () => {
    it('Ctrl+F opens Folio find bar in code view instead of bypassing', async () => {
        const codeSpy = installCodeViewSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text');

        const event = new KeyboardEvent('keydown', {
            key: 'f',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        });
        document.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(document.getElementById('find-bar')!.classList.contains('open')).toBe(true);
        expect(codeSpy.openFind).toHaveBeenCalledWith('');
    });

    it('F3 in code view uses Folio find next', async () => {
        const codeSpy = installCodeViewSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text');
        findBar.openEditorFind('needle');
        codeSpy.findNext.mockClear();

        const event = new KeyboardEvent('keydown', {
            key: 'F3',
            bubbles: true,
            cancelable: true,
        });
        document.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(codeSpy.findNext).toHaveBeenCalled();
    });
});

describe('ui/find-bar — pending input navigation', () => {
    it('Enter flushes pending debounce term before findNext', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('old');
        viewFinder.setFindTerm.mockClear();
        viewFinder.findNext.mockClear();

        const input = document.getElementById('find-input') as HTMLInputElement;
        input.value = 'new';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(viewFinder.setFindTerm).toHaveBeenCalledWith('new');
        expect(viewFinder.findNext).toHaveBeenCalled();
        expect(viewFinder.setFindTerm.mock.invocationCallOrder[0])
            .toBeLessThan(viewFinder.findNext.mock.invocationCallOrder[0]);
    });
});

describe('ui/find-bar — document switch', () => {
    it('afterDocumentSwitch reopens current finder with existing term without focusing input', async () => {
        const codeSpy = installCodeViewSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text');
        findBar.openEditorFind('persist');
        codeSpy.openFind.mockClear();
        codeSpy.closeFind.mockClear();
        (document.getElementById('find-input') as HTMLInputElement).blur();

        findBar.afterDocumentSwitch();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(codeSpy.closeFind).toHaveBeenCalled();
        expect(codeSpy.openFind).toHaveBeenCalledWith('persist');
        expect(document.activeElement).not.toBe(document.getElementById('find-input'));
    });

    it('afterDocumentSwitch is no-op when bar is closed', async () => {
        const codeSpy = installCodeViewSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text');

        findBar.afterDocumentSwitch();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(codeSpy.openFind).not.toHaveBeenCalled();
        expect(codeSpy.closeFind).not.toHaveBeenCalled();
    });
});

describe('ui/find-bar — image/binary gating (audit fix)', () => {
    it('openEditorFind does nothing and does not open bar on kind-image', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-image');

        findBar.openEditorFind('anything');

        expect(document.getElementById('find-bar')!.classList.contains('open')).toBe(false);
        expect(viewFinder.openFind).not.toHaveBeenCalled();
    });

    it('openEditorFind does nothing on kind-binary', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-binary');

        findBar.openEditorFind('x');

        expect(document.getElementById('find-bar')!.classList.contains('open')).toBe(false);
    });

    it('afterDocumentSwitch closes bar when switching to kind-binary', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text');
        findBar.openEditorFind('term');
        await Promise.resolve();

        document.body.classList.remove('kind-text');
        document.body.classList.add('kind-binary');
        findBar.afterDocumentSwitch();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById('find-bar')!.classList.contains('open')).toBe(false);
    });

    it('afterDocumentSwitch closes bar when switching to kind-image', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-text');
        findBar.openEditorFind('term');
        await Promise.resolve();

        document.body.classList.remove('kind-text');
        document.body.classList.add('kind-image');
        findBar.afterDocumentSwitch();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById('find-bar')!.classList.contains('open')).toBe(false);
    });

    it('F3 does not invoke findNext on non-searchable kind', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('kind-image');

        const event = new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true });
        document.dispatchEvent(event);

        // should have prevented (as capture handler) but not acted
        expect(event.defaultPrevented).toBe(true);
        expect(viewFinder.findNext).not.toHaveBeenCalled();
    });
});

describe('ui/find-bar — setEditorFindTerm with automation options (audit fix)', () => {
    it('setEditorFindTerm(term, opts) sets checkboxes and passes options to finder when open', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('t');
        await Promise.resolve();
        viewFinder.setFindOptions.mockClear();
        viewFinder.setFindTerm.mockClear();

        const caseEl = document.getElementById('find-case') as HTMLInputElement;
        const wordEl = document.getElementById('find-word') as HTMLInputElement;
        findBar.setEditorFindTerm('t2', { caseSensitive: true, wholeWord: true });

        expect(caseEl.checked).toBe(true);
        expect(wordEl.checked).toBe(true);
        expect(viewFinder.setFindOptions).toHaveBeenCalledWith({
            caseSensitive: true,
            wholeWord: true,
            regex: false,
        });
        expect(viewFinder.setFindTerm).toHaveBeenCalledWith('t2');
    });

    it('setEditorFindTerm regex disables whole-word for the finder but keeps checkbox state', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('t');
        await Promise.resolve();
        const wordEl = document.getElementById('find-word') as HTMLInputElement;
        const regexEl = document.getElementById('find-regex') as HTMLInputElement;
        wordEl.checked = true;
        viewFinder.setFindOptions.mockClear();

        findBar.setEditorFindTerm('t', { regex: true });

        expect(regexEl.checked).toBe(true);
        expect(wordEl.checked).toBe(true);
        expect(wordEl.disabled).toBe(true);
        expect(viewFinder.setFindOptions).toHaveBeenCalledWith({
            caseSensitive: false,
            wholeWord: false,
            regex: true,
        });
    });

    it('turning regex off re-enables whole-word with the remembered checkbox', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('t');
        await Promise.resolve();
        const wordEl = document.getElementById('find-word') as HTMLInputElement;
        wordEl.checked = true;
        findBar.setEditorFindTerm('t', { regex: true });
        viewFinder.setFindOptions.mockClear();

        findBar.setEditorFindTerm('t', { regex: false });

        expect(wordEl.disabled).toBe(false);
        expect(wordEl.checked).toBe(true);
        expect(viewFinder.setFindOptions).toHaveBeenCalledWith({
            caseSensitive: false,
            wholeWord: true,
            regex: false,
        });
    });

    it('invalidRegex find-state marks the input and counter, then clears on a valid state', async () => {
        await seedDeCatalog();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('(');
        const inputEl = document.getElementById('find-input') as HTMLInputElement;
        const counterEl = document.getElementById('find-counter')!;

        window.dispatchEvent(new CustomEvent('folio-find-state', {
            detail: { term: '(', total: 0, active: -1, invalidRegex: true },
        }));

        expect(inputEl.classList.contains('find-input--invalid')).toBe(true);
        expect(inputEl.getAttribute('aria-invalid')).toBe('true');
        expect(counterEl.classList.contains('find-counter--invalid')).toBe(true);
        expect(counterEl.textContent).not.toBe('0/0');
        expect(counterEl.textContent.length).toBeGreaterThan(0);

        window.dispatchEvent(new CustomEvent('folio-find-state', {
            detail: { term: 'foo', total: 0, active: -1 },
        }));

        expect(inputEl.classList.contains('find-input--invalid')).toBe(false);
        expect(inputEl.hasAttribute('aria-invalid')).toBe(false);
        expect(counterEl.classList.contains('find-counter--invalid')).toBe(false);
        expect(counterEl.textContent).toBe('0/0');
    });

    it('setEditorFindTerm(term, {caseSensitive}) leaves other option untouched', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('t');
        await Promise.resolve();
        (document.getElementById('find-word') as HTMLInputElement).checked = true;
        viewFinder.setFindOptions.mockClear();

        findBar.setEditorFindTerm('t', { caseSensitive: false });

        const caseEl = document.getElementById('find-case') as HTMLInputElement;
        expect(caseEl.checked).toBe(false);
        expect((document.getElementById('find-word') as HTMLInputElement).checked).toBe(true);
    });
});

describe('ui/find-bar — selection seed mirrored to input (audit fix)', () => {
    it('folio-find-state with term fills empty input (for Monaco selection seed on Ctrl+F)', async () => {
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        // simulate open without term (as keydown does)
        findBar.openEditorFind('');
        const inputEl = document.getElementById('find-input') as HTMLInputElement;
        expect(inputEl.value).toBe('');

        // controller publishes state with seeded term (no source filter here)
        window.dispatchEvent(new CustomEvent('folio-find-state', { detail: { term: 'selectedText', total: 2, active: 0 } }));

        expect(inputEl.value).toBe('selectedText');
    });
});

describe('ui/find-bar — replace row', () => {
    it('toggle opens the replace row and replace buttons call FolioEditor', async () => {
        const folioSpy = installFolioEditorSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('edit-mode');
        findBar.openEditorFind('foo');
        await Promise.resolve();
        await Promise.resolve();

        document.getElementById('find-replace-toggle')!.click();
        expect(document.getElementById('find-bar')!.classList.contains('replace-open')).toBe(true);
        expect(document.getElementById('find-replace-toggle')!.getAttribute('aria-expanded')).toBe('true');

        (document.getElementById('find-replace-input') as HTMLInputElement).value = 'bar';
        document.getElementById('find-replace-one')!.click();
        expect(folioSpy.replaceCurrent).toHaveBeenCalledWith('bar');
        document.getElementById('find-replace-all')!.click();
        expect(folioSpy.replaceAll).toHaveBeenCalledWith('bar', { inSelection: false });
    });

    it('replace flushes a pending debounce term before mutating', async () => {
        vi.useFakeTimers();
        const folioSpy = installFolioEditorSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('edit-mode');
        findBar.openEditorFind('old');
        await Promise.resolve();
        await Promise.resolve();
        folioSpy.setFindTerm.mockClear();
        folioSpy.replaceCurrent.mockClear();
        folioSpy.replaceAll.mockClear();

        const inputEl = document.getElementById('find-input') as HTMLInputElement;
        inputEl.value = 'new';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));

        document.getElementById('find-replace-one')!.click();
        expect(folioSpy.setFindTerm).toHaveBeenCalledWith('new');
        expect(folioSpy.replaceCurrent).toHaveBeenCalled();
        expect(folioSpy.setFindTerm.mock.invocationCallOrder[0])
            .toBeLessThan(folioSpy.replaceCurrent.mock.invocationCallOrder[0]);

        folioSpy.setFindTerm.mockClear();
        folioSpy.replaceAll.mockClear();
        inputEl.value = 'newer';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('find-replace-all')!.click();
        expect(folioSpy.setFindTerm).toHaveBeenCalledWith('newer');
        expect(folioSpy.replaceAll).toHaveBeenCalled();
        expect(folioSpy.setFindTerm.mock.invocationCallOrder[0])
            .toBeLessThan(folioSpy.replaceAll.mock.invocationCallOrder[0]);
        vi.useRealTimers();
    });

    it('prev/next buttons flush a pending debounce term before navigating', async () => {
        vi.useFakeTimers();
        const folioSpy = installFolioEditorSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('edit-mode');
        findBar.openEditorFind('old');
        await Promise.resolve();
        await Promise.resolve();
        folioSpy.setFindTerm.mockClear();
        folioSpy.findNext.mockClear();
        folioSpy.findPrev.mockClear();

        const inputEl = document.getElementById('find-input') as HTMLInputElement;
        inputEl.value = 'new';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));

        // Klick im Debounce-Fenster: ohne Flush wuerde mit 'old' navigiert.
        document.getElementById('find-next')!.click();
        expect(folioSpy.setFindTerm).toHaveBeenCalledWith('new');
        expect(folioSpy.setFindTerm.mock.invocationCallOrder[0])
            .toBeLessThan(folioSpy.findNext.mock.invocationCallOrder[0]);

        folioSpy.setFindTerm.mockClear();
        inputEl.value = 'newer';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('find-prev')!.click();
        expect(folioSpy.setFindTerm).toHaveBeenCalledWith('newer');
        expect(folioSpy.setFindTerm.mock.invocationCallOrder[0])
            .toBeLessThan(folioSpy.findPrev.mock.invocationCallOrder[0]);
        vi.useRealTimers();
    });

    it('Ctrl+H opens the replace row in edit mode', async () => {
        installFolioEditorSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        document.body.classList.add('edit-mode');
        findBar.openEditorFind('foo');
        await Promise.resolve();
        await Promise.resolve();

        const event = new KeyboardEvent('keydown', {
            key: 'h',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        });
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(document.getElementById('find-bar')!.classList.contains('replace-open')).toBe(true);
    });

    it('applyFindReplace is a no-op in view mode', async () => {
        const folioSpy = installFolioEditorSpy();
        const findBar = await import('../../app/ui/find-bar');
        findBar.initFindBar({
            ensureEditorMounted: vi.fn().mockResolvedValue(true),
            focusEditor: vi.fn(),
        });
        findBar.openEditorFind('foo');
        findBar.applyFindReplace('bar', true);
        expect(folioSpy.replaceAll).not.toHaveBeenCalled();
        expect(folioSpy.replaceCurrent).not.toHaveBeenCalled();
    });
});
