// Tests fuer K2 (Datei-Aktionen per Tastatur) und K3 (Kontextmenue per
// Tastatur) im Vault-Baum, Spec docs/spec-vault-keyboard.md. Anders als
// tree-keyboard.test.ts laufen hier das ECHTE Kontextmenue-Modul und die
// echte Vault-Zwischenablage: genau das ist der Vertrag — die Kuerzel gehen
// durch dieselbe Aktionsfunktion und dieselben Bedingungen wie das Menue.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';
import { fileNode, focused, item, press, treeHtml } from './tree-fixture';

vi.mock('../../app/ui/git-diff', () => ({ openGitDiff: vi.fn() }));
vi.mock('../../app/state/tabs', () => ({
    getTabsSnapshot: () => ({ tabs: [], activeIndex: 0, recentlyClosedCount: 0 }),
}));
const confirmAnswer = { value: true };
vi.mock('../../app/ui/dialogs', async () => {
    const actual = await vi.importActual<typeof import('../../app/ui/dialogs')>('../../app/ui/dialogs');
    return {
        ...actual,
        showConfirmDialog: vi.fn(() => Promise.resolve(confirmAnswer.value)),
    };
});

let tauri: TauriMockHandles;
let tree: typeof import('../../app/vault/tree');
let clipboard: typeof import('../../app/vault/clipboard');
let ctxMenu: typeof import('../../app/vault/context-menu');

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function invoked(cmd: string): any[] {
    return tauri.invoke.mock.calls.filter((c: any[]) => c[0] === cmd).map((c: any[]) => c[1]);
}

function menuOpen(): boolean {
    return document.getElementById('context-menu')!.classList.contains('open');
}

function activeAct(): string | null {
    return (document.activeElement as HTMLElement).getAttribute('data-act');
}

beforeEach(async () => {
    vi.clearAllMocks();
    confirmAnswer.value = true;
    tauri = installTauriMock();
    tauri.invoke.mockImplementation((cmd: string, args: any) => {
        if (cmd === 'vault_build_tree') return Promise.resolve(treeHtml());
        if (cmd === 'move_entry' || cmd === 'copy_entry') {
            const name = args.src.slice(args.src.lastIndexOf('/') + 1);
            return Promise.resolve(args.destDir + '/' + name);
        }
        if (cmd === 'duplicate_entry') return Promise.resolve(args.path.replace(/\.md$/, ' copy.md'));
        return Promise.resolve(undefined);
    });
    document.body.className = '';
    document.body.innerHTML = `
        <div id="editor-mount"><textarea id="ed"></textarea></div>
        <div id="vault-region"><ul id="vault-tree" class="tree" role="tree"></ul></div>
        <nav id="context-menu" role="menu"></nav>`;
    vi.resetModules();
    await seedDeCatalog();
    tree = await import('../../app/vault/tree');
    clipboard = await import('../../app/vault/clipboard');
    ctxMenu = await import('../../app/vault/context-menu');
    tree.initVaultTree({ openDocument: vi.fn() });
    ctxMenu.initContextMenu({ openDocument: vi.fn(), refreshVault: vi.fn(), showStatus: vi.fn() });
    await flush();
});

describe('K2 — Kürzel nur bei fokussiertem Baum (Referenzfälle)', () => {
    it('Strg+C mit Fokus im Editor-Mount: keine Vault-Clipboard-Aktion', () => {
        // Vorher im Baum gewesen: eine aktuelle Zeile gibt es also.
        item('a1.md').focus();
        (document.getElementById('ed') as HTMLTextAreaElement).focus();
        const ev = press('c', { ctrlKey: true });
        expect(clipboard.getClip()).toBeNull();
        expect(ev.defaultPrevented).toBe(false);
    });

    it('Strg+C mit Fokus im Baum: Vault-Clipboard „copy" auf der Zeile', () => {
        item('a1.md').focus();
        const ev = press('c', { ctrlKey: true });
        expect(clipboard.getClip()).toEqual({ path: '/v/A/a1.md', mode: 'copy' });
        expect(ev.defaultPrevented).toBe(true);
    });

    it('F2, Entf, Strg+X/V/D im Editor: nichts im Vault', async () => {
        clipboard.setClip('/v/p.md', 'copy');
        (document.getElementById('ed') as HTMLTextAreaElement).focus();
        for (const [key, opts] of [['F2', {}], ['Delete', {}], ['x', { ctrlKey: true }],
            ['v', { ctrlKey: true }], ['d', { ctrlKey: true }], ['F10', { shiftKey: true }]] as const) {
            expect(press(key, opts).defaultPrevented).toBe(false);
        }
        await flush();
        expect(document.querySelector('input.vault-rename-input')).toBeNull();
        expect(invoked('trash_path')).toEqual([]);
        expect(invoked('copy_entry')).toEqual([]);
        expect(invoked('duplicate_entry')).toEqual([]);
        expect(clipboard.getClip()).toEqual({ path: '/v/p.md', mode: 'copy' });
        expect(menuOpen()).toBe(false);
    });
});

describe('K2 — Aktionen über den Menüpfad', () => {
    it('Strg+X markiert, Strg+V auf einem Ordner verschiebt; Fokus auf den neuen Eintrag', async () => {
        item('p.md').focus();
        press('x', { ctrlKey: true });
        expect(clipboard.getClip()).toEqual({ path: '/v/p.md', mode: 'cut' });
        item('A').focus();
        press('v', { ctrlKey: true });
        await flush();
        expect(invoked('move_entry')).toEqual([{ src: '/v/p.md', destDir: '/v/A' }]);
        expect(clipboard.getClip()).toBeNull();
        expect(focused()).toBe('A');
        // Rebuild bringt den Eintrag → Fokus springt hin
        tree.insertVaultChildren('/v/A', fileNode('/v/A/a1.md', 'a1.md') + fileNode('/v/A/p.md', 'p.md'));
        await flush();
        expect((document.activeElement as HTMLElement).getAttribute('data-path')).toBe('/v/A/p.md');
    });

    it('Strg+V auf einer Datei im angepinnten Ordner: in deren Elternordner', async () => {
        clipboard.setClip('/w/r.md', 'copy');
        item('a2.md').focus();
        press('v', { ctrlKey: true });
        await flush();
        expect(invoked('copy_entry')).toEqual([{ src: '/w/r.md', destDir: '/v/A' }]);
    });

    it('Strg+V auf einer Pin-Wurzel-Datei oder einem Recent-Eintrag: nichts', async () => {
        clipboard.setClip('/v/A/a1.md', 'copy');
        item('p.md').focus();
        expect(press('v', { ctrlKey: true }).defaultPrevented).toBe(true);
        item('r.md').focus();
        press('v', { ctrlKey: true });
        await flush();
        expect(invoked('copy_entry')).toEqual([]);
        expect(invoked('move_entry')).toEqual([]);
    });

    it('Strg+V ohne Zwischenablage: nichts (Menü böte „Einfügen" nicht an)', async () => {
        item('A').focus();
        press('v', { ctrlKey: true });
        await flush();
        expect(invoked('copy_entry')).toEqual([]);
    });

    it('Strg+D dupliziert wie der Menüeintrag; Fokus auf die Kopie nach dem Rebuild', async () => {
        item('a1.md').focus();
        press('d', { ctrlKey: true });
        await flush();
        const viaKey = invoked('duplicate_entry');
        expect(viaKey).toEqual([{ path: '/v/A/a1.md' }]);
        tree.insertVaultChildren('/v/A', fileNode('/v/A/a1.md', 'a1.md') + fileNode('/v/A/a1 copy.md', 'a1 copy.md'));
        await flush();
        expect(focused()).toBe('a1 copy.md');

        // Gleicher Aufruf über das Kontextmenü (Klick)
        tauri.invoke.mockClear();
        ctxMenu.openContextMenu(0, 0, '/v/A/a1.md', false, false, false, false);
        (document.querySelector('#context-menu [data-act="duplicate"]') as HTMLElement).click();
        await flush();
        expect(invoked('duplicate_entry')).toEqual(viaKey);
    });

    it('Rebuild zwischen Tastendruck und Ergebnis: Fokus landet trotzdem auf der Kopie', async () => {
        let resolveDup: (p: string) => void = () => {};
        const base = tauri.invoke.getMockImplementation()!;
        tauri.invoke.mockImplementation((cmd: string, args: any) => cmd === 'duplicate_entry'
            ? new Promise((r) => { resolveDup = r; })
            : base(cmd, args));
        item('a1.md').focus();
        press('d', { ctrlKey: true });
        tree.renderVaultFromHtml(treeHtml()); // alte Zeile ausgehängt
        await flush();
        expect(focused()).toBe('a1.md');
        resolveDup('/v/A/a1 copy.md');
        await flush();
        tree.insertVaultChildren('/v/A', fileNode('/v/A/a1.md', 'a1.md') + fileNode('/v/A/a1 copy.md', 'a1 copy.md'));
        await flush();
        expect(focused()).toBe('a1 copy.md');
    });

    it('F2 startet das Inline-Rename; Enter committet, Fokus auf den umbenannten Eintrag', async () => {
        item('a1.md').focus();
        press('F2');
        const input = document.querySelector('input.vault-rename-input') as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
        input.value = 'neu.md';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await flush();
        expect(invoked('rename_file')).toEqual([{ oldPath: '/v/A/a1.md', newPath: '/v/A/neu.md' }]);
        expect((document.activeElement as HTMLElement).getAttribute('data-path')).toBe('/v/A/a1.md');
        tree.insertVaultChildren('/v/A', fileNode('/v/A/neu.md', 'neu.md') + fileNode('/v/A/a2.md', 'a2.md'));
        await flush();
        expect(focused()).toBe('neu.md');
    });

    it('F2 + Escape: Abbruch, Fokus zurück auf die Zeile', () => {
        item('a2.md').focus();
        press('F2');
        const input = document.querySelector('input.vault-rename-input') as HTMLInputElement;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(focused()).toBe('a2.md');
        expect(invoked('rename_file')).toEqual([]);
    });

    it('Entf mit Bestätigung: Papierkorb, Fokus auf den nächsten sichtbaren Nachbarn', async () => {
        item('a1.md').focus();
        press('Delete');
        await flush();
        expect(invoked('trash_path')).toEqual([{ path: '/v/A/a1.md' }]);
        expect(focused()).toBe('B');
    });

    it('Entf auf der letzten Zeile: Fokus auf die vorige', async () => {
        item('r.md').focus();
        press('Delete');
        await flush();
        expect(focused()).toBe('Zuletzt geöffnet');
    });

    it('Entf auf einem Ordner überspringt dessen Inhalt beim Nachbarn', async () => {
        tree.renderVaultFromHtml(treeHtml(true, fileNode('/v/A/B/b1.md', 'b1.md')));
        await flush();
        item('B').focus();
        press('Delete');
        await flush();
        expect(focused()).toBe('a2.md');
    });

    it('Entf abgebrochen: nichts gelöscht, Fokus bleibt auf der Zeile', async () => {
        confirmAnswer.value = false;
        item('a2.md').focus();
        press('Delete');
        await flush();
        expect(invoked('trash_path')).toEqual([]);
        expect(focused()).toBe('a2.md');
    });

    it('Entf auf einer Pin-Wurzel (Ordner): nichts — wie im Menü', async () => {
        item('A').focus();
        press('Delete');
        await flush();
        const dialogs = await import('../../app/ui/dialogs');
        expect(dialogs.showConfirmDialog).not.toHaveBeenCalled();
        expect(invoked('trash_path')).toEqual([]);
    });

    it('Kürzel auf einer Abschnittszeile: nichts', async () => {
        item('Angepinnt').focus();
        press('c', { ctrlKey: true });
        press('F2');
        expect(clipboard.getClip()).toBeNull();
        expect(document.querySelector('input.vault-rename-input')).toBeNull();
    });
});

describe('K3 — Kontextmenü per Tastatur', () => {
    it('Umschalt+F10: Menü offen, Fokus auf dem ersten Eintrag, Rollen gesetzt', () => {
        item('a1.md').focus();
        press('F10', { shiftKey: true });
        expect(menuOpen()).toBe(true);
        const menu = document.getElementById('context-menu')!;
        expect(menu.getAttribute('role')).toBe('menu');
        expect(menu.querySelectorAll('.ctx-item:not([role="menuitem"])').length).toBe(0);
        expect(menu.querySelectorAll('.ctx-sep[role="separator"]').length).toBeGreaterThan(0);
        expect(activeAct()).toBe('open');
    });

    it('Kontextmenü-Taste öffnet ebenfalls', () => {
        item('A').focus();
        press('ContextMenu');
        expect(menuOpen()).toBe(true);
        expect(activeAct()).toBe('new-file');
    });

    it('↑/↓ wandern und überspringen Trenner; Pos1/Ende; Umlauf', () => {
        item('a1.md').focus();
        press('F10', { shiftKey: true });
        press('ArrowDown');
        press('ArrowDown');
        expect(activeAct()).toBe('open-default');
        press('ArrowDown'); // Trenner dazwischen
        expect(activeAct()).toBe('rename');
        press('End');
        expect(activeAct()).toBe('delete');
        press('ArrowDown');
        expect(activeAct()).toBe('open');
        press('ArrowUp');
        expect(activeAct()).toBe('delete');
        press('Home');
        expect(activeAct()).toBe('open');
    });

    it('Enter löst den Eintrag aus und gibt den Fokus an die Zeile zurück', () => {
        item('a2.md').focus();
        press('F10', { shiftKey: true });
        for (let i = 0; i < 20 && activeAct() !== 'clip-copy'; i++) press('ArrowDown');
        press('Enter');
        expect(menuOpen()).toBe(false);
        expect(clipboard.getClip()).toEqual({ path: '/v/A/a2.md', mode: 'copy' });
        expect(focused()).toBe('a2.md');
    });

    it('Leertaste löst ebenfalls aus', () => {
        item('a2.md').focus();
        press('F10', { shiftKey: true });
        for (let i = 0; i < 20 && activeAct() !== 'cut'; i++) press('ArrowDown');
        press(' ');
        expect(clipboard.getClip()).toEqual({ path: '/v/A/a2.md', mode: 'cut' });
    });

    it('Escape schließt und gibt den Fokus an die Zeile zurück', () => {
        item('p.md').focus();
        press('F10', { shiftKey: true });
        press('ArrowDown');
        press('Escape');
        expect(menuOpen()).toBe(false);
        expect(focused()).toBe('p.md');
    });

    it('per Tastatur ausgelöstes contextmenu-Event ersetzt das Menü nicht', () => {
        item('p.md').focus();
        press('ContextMenu');
        item('p.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        expect(activeAct()).toBe('open');
    });

    it('Maus: Menü nimmt keinen Fokus, Klick auf Eintrag zieht ihn nicht ins Menü', () => {
        item('p.md').focus();
        ctxMenu.openContextMenu(10, 10, '/v/p.md', false, true, false, false);
        expect(focused()).toBe('p.md');
        const entry = document.querySelector('#context-menu [data-act="clip-copy"]') as HTMLElement;
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        entry.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        entry.click();
        expect(clipboard.getClip()).toEqual({ path: '/v/p.md', mode: 'copy' });
    });
});
