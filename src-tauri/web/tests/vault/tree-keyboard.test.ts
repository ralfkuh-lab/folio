// Tests fuer die Tastaturbedienung im Vault-Baum (Spec
// docs/spec-vault-keyboard.md, K1). Laeuft ueber den echten tree.ts-Pfad
// (initVaultTree → initVaultTreeKeyboard), damit Auf-/Zuklappen,
// Rebuild-Setter und Fokus-Restore genau so zusammenspielen wie in der App.
//
// Referenz-Fixture (vorgegeben): Abschnitt „Angepinnt" (offen) mit Ordner A
// (offen; Kinder a1.md, Ordner B (zu), a2.md) und Datei p.md; Abschnitt
// „Zuletzt geöffnet" (offen) mit r.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';
import { fileNode, focused, item, press, treeHtml } from './tree-fixture';

// editor/shell.ts (Punkt 2) zieht die Find-Bar nach; deren Nebenwirkung ist
// hier egal, der Fokuspfad des Editor-Shells bleibt echt.
vi.mock('../../app/ui/find-bar', () => ({
    afterModeSwitch: vi.fn(), applyFindReplace: vi.fn(), openEditorFind: vi.fn(), setEditorFindTerm: vi.fn(),
}));

vi.mock('../../app/vault/context-menu', () => ({
    openContextMenu: vi.fn(),
    closeContextMenu: vi.fn(),
    runOrOpenFile: vi.fn(),
}));

let tauri: TauriMockHandles;
let tree: typeof import('../../app/vault/tree');
let kb: typeof import('../../app/vault/tree-keyboard');
let openDocument: ReturnType<typeof vi.fn>;
let openLeftRail: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}




function expandCalls(): string[] {
    return tauri.emit.mock.calls
        .filter((c: any[]) => c[0] === 'shell:event' && c[1]?.type === 'expand-dir')
        .map((c: any[]) => c[1].path);
}

beforeEach(async () => {
    vi.clearAllMocks();
    tauri = installTauriMock();
    tauri.invoke.mockImplementation((cmd: string) =>
        Promise.resolve(cmd === 'vault_build_tree' ? treeHtml() : undefined));
    document.body.className = '';
    document.body.innerHTML = `
        <div id="editor-mount"><textarea id="ed"></textarea></div>
        <div id="vault-region"><ul id="vault-tree" class="tree" role="tree"></ul></div>`;
    vi.resetModules();
    await seedDeCatalog();
    tree = await import('../../app/vault/tree');
    kb = await import('../../app/vault/tree-keyboard');
    openDocument = vi.fn();
    openLeftRail = vi.fn();
    tree.initVaultTree({ openDocument, openLeftRail });
    await flush();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('K1 — ARIA-Tree', () => {
    it('setzt treeitem/group/aria-level/aria-expanded und genau einen tabindex=0', () => {
        expect(item('Angepinnt').getAttribute('role')).toBe('treeitem');
        expect(item('Angepinnt').getAttribute('aria-level')).toBe('1');
        expect(item('Angepinnt').getAttribute('aria-expanded')).toBe('true');
        expect(item('A').getAttribute('aria-level')).toBe('2');
        expect(item('A').getAttribute('aria-expanded')).toBe('true');
        expect(item('B').getAttribute('aria-expanded')).toBe('false');
        expect(item('a1.md').getAttribute('aria-level')).toBe('3');
        expect(item('a1.md').hasAttribute('aria-expanded')).toBe(false);
        expect(item('a1.md').getAttribute('aria-label')).toBe('a1.md');
        expect(item('A').querySelector(':scope > ul.children')!.getAttribute('role')).toBe('group');
        expect(document.querySelectorAll('#vault-tree [tabindex="0"]').length).toBe(1);
        expect(document.querySelector('#vault-tree [tabindex="0"]')).toBe(item('Angepinnt'));
    });

    it('bleibt nach einem Rebuild konsistent (ein tabindex=0, auf der fokussierten Zeile)', async () => {
        item('a2.md').focus();
        tree.renderVaultFromHtml(treeHtml());
        await flush();
        expect(document.querySelectorAll('#vault-tree [tabindex="0"]').length).toBe(1);
        expect(item('a2.md').getAttribute('tabindex')).toBe('0');
        expect(item('a2.md').getAttribute('role')).toBe('treeitem');
    });
});

describe('K1 — Navigation (Referenzfälle)', () => {
    it('sichtbare Reihenfolge', () => {
        const names = kb.visibleVaultItems().map((li) =>
            li.querySelector(':scope > .row > .label')!.textContent);
        expect(names).toEqual(['Angepinnt', 'A', 'a1.md', 'B', 'a2.md', 'p.md', 'Zuletzt geöffnet', 'r.md']);
    });

    it('a1.md + ↓ → B; ↓ → a2.md (Inhalt von B übersprungen)', () => {
        item('a1.md').focus();
        press('ArrowDown');
        expect(focused()).toBe('B');
        press('ArrowDown');
        expect(focused()).toBe('a2.md');
    });

    it('B + → klappt auf (Expand angefordert), Fokus bleibt; mit Kindern zweites → → erstes Kind', async () => {
        item('B').focus();
        press('ArrowRight');
        expect(expandCalls()).toEqual(['/v/A/B']);
        expect(item('B').getAttribute('aria-expanded')).toBe('true');
        expect(focused()).toBe('B');
        // Kinder noch nicht da: zweites → bewirkt nichts
        press('ArrowRight');
        expect(focused()).toBe('B');
        tree.insertVaultChildren('/v/A/B', fileNode('/v/A/B/b1.md', 'b1.md'));
        await flush();
        expect(focused()).toBe('B');
        press('ArrowRight');
        expect(focused()).toBe('b1.md');
    });

    it('a2.md + ← → A; ← klappt A zu, Fokus bleibt; ↓ → p.md', () => {
        item('a2.md').focus();
        press('ArrowLeft');
        expect(focused()).toBe('A');
        press('ArrowLeft');
        expect(item('A').getAttribute('aria-expanded')).toBe('false');
        expect(item('A').querySelector(':scope > ul.children')!.classList.contains('collapsed')).toBe(true);
        expect(focused()).toBe('A');
        press('ArrowDown');
        expect(focused()).toBe('p.md');
    });

    it('r.md + Pos1 → Angepinnt; Ende → r.md', () => {
        item('r.md').focus();
        press('Home');
        expect(focused()).toBe('Angepinnt');
        press('End');
        expect(focused()).toBe('r.md');
    });

    it('Type-ahead „a2" (schnell) von Angepinnt → a2.md; danach „p" → p.md', () => {
        vi.useFakeTimers();
        item('Angepinnt').focus();
        press('a');
        press('2');
        expect(focused()).toBe('a2.md');
        vi.advanceTimersByTime(600);
        press('p');
        expect(focused()).toBe('p.md');
    });

    it('Filter blendet a1.md aus (vf-hidden): A + ↓ → B', () => {
        item('a1.md').classList.add('vf-hidden');
        item('A').focus();
        press('ArrowDown');
        expect(focused()).toBe('B');
    });

    it('← auf einer Wurzel geht zum Abschnitt; → auf einer Datei tut nichts', () => {
        item('p.md').focus();
        press('ArrowRight');
        expect(focused()).toBe('p.md');
        press('ArrowLeft');
        expect(focused()).toBe('Angepinnt');
    });

    it('Abschnitt: ← klappt zu, → klappt auf (toggle-section), Enter klappt um', () => {
        item('Zuletzt geöffnet').focus();
        press('ArrowLeft');
        const toggles = () => tauri.emit.mock.calls.filter(
            (c: any[]) => c[0] === 'shell:event' && c[1]?.type === 'toggle-section');
        expect(toggles().length).toBe(1);
        expect(toggles()[0][1]).toMatchObject({ section: 'recent', expanded: false });
        press('ArrowDown'); // r.md ist jetzt unsichtbar → kein Ziel
        expect(focused()).toBe('Zuletzt geöffnet');
        press('ArrowRight');
        expect(toggles()[1][1]).toMatchObject({ section: 'recent', expanded: true });
        press('Enter');
        expect(toggles()[2][1]).toMatchObject({ section: 'recent', expanded: false });
    });

    it('Enter/Leertaste öffnen eine Datei, Fokus bleibt; Strg+Enter → neuer Tab', () => {
        item('a1.md').focus();
        press('Enter');
        expect(openDocument).toHaveBeenCalledWith('/v/A/a1.md');
        expect(focused()).toBe('a1.md');
        item('p.md').focus();
        press(' ');
        expect(openDocument).toHaveBeenCalledWith('/v/p.md');
        expect(focused()).toBe('p.md');
        press('Enter', { ctrlKey: true });
        expect(tauri.invoke).toHaveBeenCalledWith('tab_open', { path: '/v/p.md' });
    });

    it('verarbeitete Tasten werden konsumiert (preventDefault)', () => {
        item('a1.md').focus();
        expect(press('ArrowDown').defaultPrevented).toBe(true);
        expect(press('F5').defaultPrevented).toBe(false);
    });
});

describe('K1 — Fokus überlebt Baum-Neuaufbauten', () => {
    it('renderVault: Fokus wieder auf derselben Zeile (per data-path)', async () => {
        item('a1.md').focus();
        tree.renderVaultFromHtml(treeHtml());
        await flush();
        expect(focused()).toBe('a1.md');
        expect(document.activeElement).toBe(item('a1.md'));
    });

    it('insertVaultChildren ohne die Zeile: nächster sichtbarer Vorfahr', async () => {
        item('a1.md').focus();
        tree.insertVaultChildren('/v/A', fileNode('/v/A/a2.md', 'a2.md'));
        await flush();
        expect(focused()).toBe('A');
    });

    it('setVaultPinned / setVaultRecent: Fokus bleibt erhalten', async () => {
        item('r.md').focus();
        tree.setVaultRecent(fileNode('/w/r.md', 'r.md') + fileNode('/w/s.md', 's.md'));
        await flush();
        expect(focused()).toBe('r.md');
        item('p.md').focus();
        tree.setVaultPinned(fileNode('/v/p.md', 'p.md'));
        await flush();
        expect(focused()).toBe('p.md');
    });

    it('Filter blendet die fokussierte Zeile aus: Fokus auf den sichtbaren Vorfahren', async () => {
        item('a1.md').focus();
        item('a1.md').classList.add('vf-hidden');
        await flush();
        expect(focused()).toBe('A');
    });

    it('Fokus außerhalb des Baums wird von einem Rebuild nicht gestohlen', async () => {
        item('a1.md').focus();
        (document.getElementById('ed') as HTMLTextAreaElement).focus();
        await new Promise((r) => setTimeout(r, 0));
        tree.renderVaultFromHtml(treeHtml());
        await flush();
        expect(document.activeElement!.id).toBe('ed');
    });

    it('stört das Inline-Rename nicht (Input behält den Fokus bei Klassen-Änderungen)', async () => {
        item('a1.md').focus();
        const label = item('a1.md').querySelector('.label')!;
        const input = document.createElement('input');
        input.className = 'vault-rename-input';
        label.appendChild(input);
        input.focus();
        item('A').classList.add('git-modified');
        await flush();
        expect(document.activeElement).toBe(input);
        // Pfeiltasten im Input bleiben beim Input
        expect(press('ArrowDown').defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(input);
    });
});

describe('K1 — Strg+Umschalt+E (focusVaultTree) und Escape', () => {
    it('fokussiert das aktive Dokument, falls sichtbar', async () => {
        tree.setVaultActive('/v/A/a2.md');
        await kb.focusVaultTree();
        expect(focused()).toBe('a2.md');
        expect(openLeftRail).not.toHaveBeenCalled();
    });

    it('klappt den Pfad zum aktiven Dokument auf und blendet die Rail ein', async () => {
        document.body.classList.add('vault-hidden');
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_expand_paths') {
                return Promise.resolve({ html: treeHtml(true, fileNode('/v/A/B/b1.md', 'b1.md')) });
            }
            return Promise.resolve(undefined);
        });
        tree.setVaultActive('/v/A/B/b1.md');
        await kb.focusVaultTree();
        await flush();
        expect(openLeftRail).toHaveBeenCalled();
        expect(tauri.invoke).toHaveBeenCalledWith('vault_expand_paths', { paths: ['/v/A', '/v/A/B'] });
        expect(focused()).toBe('b1.md');
    });

    it('bevorzugt den Ort im angepinnten Baum vor dem Recent-Eintrag', async () => {
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_expand_paths') {
                return Promise.resolve({ html: treeHtml(true, fileNode('/v/A/B/b1.md', 'b1.md')) });
            }
            return Promise.resolve(undefined);
        });
        tree.setVaultRecent(fileNode('/v/A/B/b1.md', 'b1.md'));
        tree.setVaultActive('/v/A/B/b1.md');
        await kb.focusVaultTree();
        await flush();
        const a = document.activeElement as HTMLElement;
        expect(a.getAttribute('data-path')).toBe('/v/A/B/b1.md');
        expect(a.closest('li.section')!.getAttribute('data-section')).toBe('pinned');
    });

    it('ohne aktives Dokument: erste Zeile', async () => {
        await kb.focusVaultTree();
        expect(focused()).toBe('Angepinnt');
    });

    it('im Zen-Modus ohne Wirkung', async () => {
        document.body.classList.add('zen-mode');
        await kb.focusVaultTree();
        expect(focused()).toBe('(BODY)');
    });

    it('Escape gibt den Fokus an das vorher fokussierte Element zurück', async () => {
        tree.setVaultActive('/v/p.md');
        const ed = document.getElementById('ed') as HTMLTextAreaElement;
        ed.focus();
        await kb.focusVaultTree();
        expect(focused()).toBe('p.md');
        press('ArrowUp');
        press('Escape');
        expect(document.activeElement).toBe(ed);
    });

    it('Escape bei offenem Kontextmenü verlässt den Baum nicht', async () => {
        const menu = document.createElement('nav');
        menu.id = 'context-menu';
        menu.className = 'open';
        document.body.appendChild(menu);
        item('p.md').focus();
        expect(press('Escape').defaultPrevented).toBe(false);
        expect(focused()).toBe('p.md');
    });
});

describe('Korrekturrunde 1 (Review Sol)', () => {
    // Das Editor-Shell-Layout läuft per requestAnimationFrame nach; vor dem
    // nächsten Fall (setup.ts entfernt window.FolioEditor) ablaufen lassen.
    afterEach(async () => {
        await new Promise((r) => setTimeout(r, 40));
    });

    it('Sol 5: Escape-Rücksprungziel überlebt einen Rebuild', async () => {
        tree.setVaultActive('/v/p.md');
        const ed = document.getElementById('ed')!;
        ed.focus();
        await kb.focusVaultTree();
        tree.renderVaultFromHtml(treeHtml());
        await flush();
        expect(focused()).toBe('p.md');
        press('Escape');
        expect(document.activeElement).toBe(ed);
    });

    it('Sol 1: Aufklappen per Strg+Umschalt+E respektiert einen Fokuswechsel nach außen', async () => {
        let finish!: (p: any) => void;
        tauri.invoke.mockImplementation((cmd: string) => cmd === 'vault_expand_paths'
            ? new Promise((r) => { finish = r; }) : Promise.resolve(undefined));
        tree.setVaultActive('/v/A/B/b1.md');
        const running = kb.focusVaultTree();
        const ed = document.getElementById('ed')!;
        ed.focus();
        finish({ html: treeHtml(true, fileNode('/v/A/B/b1.md', 'b1.md')) });
        await running;
        await flush();
        expect(document.activeElement).toBe(ed);
    });

    it('Sol 1: Aufklappen respektiert eine neuere Zeile per Klick', async () => {
        let finish!: (p: any) => void;
        tauri.invoke.mockImplementation((cmd: string) => cmd === 'vault_expand_paths'
            ? new Promise((r) => { finish = r; }) : Promise.resolve(undefined));
        tree.setVaultActive('/v/A/B/b1.md');
        const running = kb.focusVaultTree();
        item('r.md').focus(); // Nutzer klickt eine andere Zeile
        finish({ html: treeHtml(true, fileNode('/v/A/B/b1.md', 'b1.md')) });
        await running;
        await flush();
        expect(focused()).toBe('r.md');
    });

    it('Sol 7: ohne aktives Dokument die erste Zeile, auch nach früherer Navigation', async () => {
        item('a2.md').focus();
        document.getElementById('ed')!.focus();
        await kb.focusVaultTree();
        expect(focused()).toBe('Angepinnt');
    });

    it('Sol 6: Leertaste direkt nach Type-ahead öffnet die Datei', () => {
        item('Angepinnt').focus();
        press('p');
        expect(focused()).toBe('p.md');
        press(' ');
        expect(openDocument).toHaveBeenCalledWith('/v/p.md');
    });

    /** Der Mount-Pfad des Editor-Shells braucht mehr als ein paar Microtasks. */
    async function settle(): Promise<void> {
        await flush();
        await new Promise((r) => setTimeout(r, 10));
    }

    async function installShell(ed: HTMLElement) {
        (window as any).FolioEditor = {
            mount: vi.fn().mockResolvedValue(undefined),
            layout: vi.fn(),
            focus: () => ed.focus(),
        };
        const shell = await import('../../app/editor/shell');
        shell.initEditorShell({ getCleanText: () => '', requestSaveIfDirty: async () => true });
        return (window as any).FolioEditor;
    }

    it('Sol 2 / R2: Enter behält den Baumfokus, wenn der Modus durch das Öffnen auf Edit wechselt', async () => {
        const ed = document.getElementById('ed')!;
        const editor = await installShell(ed);
        openDocument.mockImplementation(() => {
            tauri.emitEvent('app:set_mode', { mode: 'edit', cause: 'open' });
        });
        item('a1.md').focus();
        press('Enter');
        await settle();
        expect(focused()).toBe('a1.md');
        // Editor ist trotzdem bereitgestellt (mount), nur ohne Fokus.
        expect(editor.mount).toHaveBeenCalled();
    });

    it('R2 (Sol N1): Enter, ↓, verspätetes app:set_mode{cause:open} → Fokus bleibt auf B', async () => {
        const ed = document.getElementById('ed')!;
        await installShell(ed);
        item('a1.md').focus();
        press('Enter');
        press('ArrowDown');
        expect(focused()).toBe('B');
        tauri.emitEvent('app:set_mode', { mode: 'edit', cause: 'open' });
        await settle();
        expect(focused()).toBe('B');
    });

    it('R2 (Sol N1): app:set_mode{cause:user} nach Enter fokussiert den Editor (auch ohne DOM-Eingabe)', async () => {
        const ed = document.getElementById('ed')!;
        await installShell(ed);
        item('a1.md').focus();
        press('Enter'); // ohne Moduswechsel
        tauri.emitEvent('app:set_mode', { mode: 'edit', cause: 'user' }); // z. B. natives Menü
        await settle();
        expect(document.activeElement).toBe(ed);
    });

    it('R2: Altpayload ohne cause gilt als ausdrücklicher Wechsel', async () => {
        const ed = document.getElementById('ed')!;
        await installShell(ed);
        item('a1.md').focus();
        tauri.emitEvent('app:set_mode', { mode: 'edit' });
        await settle();
        expect(document.activeElement).toBe(ed);
    });

    // Benutzerentscheidung 2026-10-18: Ein Klick in den Baum setzt den Fokus
    // dorthin (wie im Dateimanager). Der Browser verschiebt ihn beim
    // mousedown selbst; jsdom tut das nicht, daher hier `focus()` von Hand.
    function nativeClick(li: HTMLElement): void {
        const row = li.querySelector('.row') as HTMLElement;
        row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        row.dispatchEvent(down);
        if (!down.defaultPrevented) li.focus();
        row.click();
    }

    it('Mausklick auf eine Datei bei Fokus im Editor + cause:open → Fokus bleibt im Baum', async () => {
        const ed = document.getElementById('ed')!;
        await installShell(ed);
        ed.focus();
        openDocument.mockImplementation(() => {
            tauri.emitEvent('app:set_mode', { mode: 'edit', cause: 'open' });
        });
        nativeClick(item('a1.md'));
        await settle();
        expect(openDocument).toHaveBeenCalledWith('/v/A/a1.md');
        expect(focused()).toBe('a1.md');
    });

    it('Mausklick, danach ausdrücklicher Moduswechsel (cause:user) → Editor fokussiert', async () => {
        const ed = document.getElementById('ed')!;
        await installShell(ed);
        nativeClick(item('a1.md'));
        tauri.emitEvent('app:set_mode', { mode: 'edit', cause: 'user' });
        await settle();
        expect(document.activeElement).toBe(ed);
    });
});

describe('Korrekturrunde 2 — Mausklick und Fokus', () => {
    it('Mausklick lässt den Browser fokussieren (kein preventDefault) und setzt den wandernden tabindex', () => {
        const ed = document.getElementById('ed')!;
        ed.focus();
        const row = item('a2.md').querySelector('.row') as HTMLElement;
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        row.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(false);
        expect(item('a2.md').getAttribute('tabindex')).toBe('0');
        expect(document.querySelectorAll('#vault-tree [tabindex="0"]').length).toBe(1);
    });

    it('Klick neben ein offenes Inline-Rename: mousedown bleibt unverhindert (Blur beendet es)', () => {
        item('a1.md').focus();
        const input = document.createElement('input');
        input.className = 'vault-rename-input';
        item('a1.md').querySelector('.label')!.appendChild(input);
        input.focus();
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        (item('p.md').querySelector('.row') as HTMLElement).dispatchEvent(down);
        expect(down.defaultPrevented).toBe(false);
    });

    it('Fokusring-Markierung kb-nav: Taste im Baum setzt sie, Mausklick entfernt sie', () => {
        const tree = document.getElementById('vault-tree')!;
        item('a1.md').focus();
        item('a1.md').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        expect(tree.classList.contains('kb-nav')).toBe(true);
        (item('p.md').querySelector('.row') as HTMLElement)
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        expect(tree.classList.contains('kb-nav')).toBe(false);
    });

    it('mousedown im Rename-Input wird nicht verhindert (Cursor setzen)', () => {
        const input = document.createElement('input');
        input.className = 'vault-rename-input';
        item('a1.md').querySelector('.label')!.appendChild(input);
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        input.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(false);
    });
});
