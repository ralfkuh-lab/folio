// Tests fuer ui/find-bar.ts. Schwerpunkt:
// - openEditorFind oeffnet Bar + ruft Finder.openFind mit dem Term.
// - View↔Edit-Wechsel waehlt den richtigen Finder (FolioEditor im
//   Edit-Mode, ViewFinder im View-Mode).
// - setEditorFindTerm setzt das Input-Value und ruft setFindTerm
//   (oder oeffnet die Bar, wenn sie geschlossen war).
// - afterModeSwitch schliesst beide Finder und re-opent den aktuellen.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';

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
            <input id="find-input" />
            <span id="find-counter"></span>
            <button id="find-prev"></button>
            <button id="find-next"></button>
            <button id="find-opts"></button>
            <button id="find-close"></button>
            <div id="find-opts-panel">
                <input id="find-case" type="checkbox" />
                <input id="find-word" type="checkbox" />
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
