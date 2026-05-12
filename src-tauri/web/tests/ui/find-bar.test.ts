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
vi.mock('../../app/view/markdown', () => ({
    ViewFinder: viewFinder,
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
    viewFinder.setFindOptions.mockClear();
    viewFinder.openFind.mockClear();
    viewFinder.closeFind.mockClear();
    viewFinder.setFindTerm.mockClear();
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
        expect(folioSpy.closeFind).toHaveBeenCalled();
    });
});
