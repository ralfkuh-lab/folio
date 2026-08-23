// Tests fuer vault/rename-guard.ts + dessen Verdrahtung in vault/tree.ts.
// Vertrag: solange ein Inline-Rename im Baum offen ist, fasst KEIN
// Baum-Update das DOM an — weder der komplette Rebuild noch ein
// Watcher-getriebenes insertVaultChildren. Nach Commit/Abbruch laeuft
// genau ein Rebuild nach. Hintergrund: ein nebenher laufender
// vault:refresh ersetzte die Baumzeile samt offenem Input, die
// angefangene Eingabe war weg (Befund aus einem E2E-Flake 2026-08-20).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

vi.mock('../../app/ui/git-diff', () => ({ openGitDiff: vi.fn() }));
vi.mock('../../app/state/tabs', () => ({
    getTabsSnapshot: () => ({ tabs: [], activeIndex: 0, recentlyClosedCount: 0 }),
}));

let tauri: TauriMockHandles;

const TREE_HTML = `
    <li class="node" data-kind="dir" data-path="/vault/notes">
        <div class="row"><span class="caret open"></span><span class="label">notes</span></div>
        <ul class="children">
            <li class="node" data-kind="file" data-path="/vault/notes/a.md">
                <div class="row"><span class="label">a.md</span></div>
            </li>
        </ul>
    </li>`;

function buildDom(): void {
    document.body.innerHTML = `
        <nav id="context-menu" role="menu"></nav>
        <div id="vault-region">
            <ul id="vault-tree">${TREE_HTML}</ul>
        </div>`;
}

beforeEach(async () => {
    vi.clearAllMocks();
    tauri = installTauriMock();
    buildDom();
    vi.resetModules();
    await seedDeCatalog();
});

// Der Initial-Load in initVaultTree wuerde den vorbereiteten Baum durch
// die Mock-Antwort ersetzen — deshalb liefert der Mock genau das HTML
// zurueck, das der Test aufgebaut hat.
function buildTreeCalls(): number {
    return tauri.invoke.mock.calls.filter((c: unknown[]) => c[0] === 'vault_build_tree').length;
}

function serveTree(): void {
    tauri.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'vault_build_tree') return Promise.resolve(TREE_HTML);
        return Promise.resolve(undefined);
    });
}

async function openRename(): Promise<HTMLInputElement> {
    const menu = await import('../../app/vault/context-menu');
    menu.initContextMenu({
        openDocument: vi.fn(),
        refreshVault: vi.fn(),
        showStatus: vi.fn(),
    });
    menu.startInlineRename('/vault/notes/a.md');
    const input = document.querySelector('.vault-rename-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    return input;
}

describe('vault/rename-guard — Zustandsmaschine', () => {
    it('schiebt nichts auf, solange kein Rename laeuft', async () => {
        const g = await import('../../app/vault/rename-guard');
        expect(g.isVaultRenameActive()).toBe(false);
        expect(g.deferVaultTreeUpdate()).toBe(false);
    });

    it('zieht genau einen Rebuild nach, egal wie viele Updates auflaufen', async () => {
        const g = await import('../../app/vault/rename-guard');
        const flush = vi.fn();
        g.setVaultRenameFlush(flush);
        await openRename();

        g.beginVaultRename();
        expect(g.deferVaultTreeUpdate()).toBe(true);
        expect(g.deferVaultTreeUpdate()).toBe(true);
        expect(flush).not.toHaveBeenCalled();

        g.endVaultRename();
        await Promise.resolve();
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it('flusht nicht, wenn waehrend des Renames nichts anfiel', async () => {
        const g = await import('../../app/vault/rename-guard');
        const flush = vi.fn();
        g.setVaultRenameFlush(flush);
        await openRename();

        g.beginVaultRename();
        g.endVaultRename();
        await Promise.resolve();
        expect(flush).not.toHaveBeenCalled();
    });

    it('loest sich selbst, wenn das Input ohne cleanup aus dem Baum faellt', async () => {
        const g = await import('../../app/vault/rename-guard');
        const flush = vi.fn();
        g.setVaultRenameFlush(flush);
        await openRename();

        g.beginVaultRename();
        expect(g.deferVaultTreeUpdate()).toBe(true);

        // Baum wird von aussen ersetzt (z. B. Rail-Neuaufbau): das Input
        // ist weg, ohne dass endVaultRename je gerufen wurde.
        document.getElementById('vault-tree')!.innerHTML = TREE_HTML;
        expect(g.isVaultRenameActive()).toBe(false);
        expect(g.deferVaultTreeUpdate()).toBe(false);
        await Promise.resolve();
        expect(flush).toHaveBeenCalledTimes(1);
    });
});

describe('vault/tree — Baum-Updates waehrend eines Inline-Renames', () => {
    it('laesst das offene Rename-Input einen vault:refresh ueberleben', async () => {
        serveTree();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });
        await Promise.resolve();

        const input = await openRename();
        input.value = 'halbfertig';
        tauri.invoke.mockClear();

        // VaultWatcher-getriebener Rebuild mitten in der Eingabe.
        tauri.emitEvent('vault:refresh', { pinned: '<li></li>', recent: '<li></li>' });
        await Promise.resolve();

        const still = document.querySelector('.vault-rename-input') as HTMLInputElement;
        expect(still).toBe(input);
        expect(still.value).toBe('halbfertig');
        expect(buildTreeCalls()).toBe(0);
    });

    it('laesst das Input auch ein insertVaultChildren ueberleben', async () => {
        serveTree();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });
        await Promise.resolve();

        const input = await openRename();
        input.value = 'halbfertig';

        // Ohne Guard ersetzt das die ul.children — mit ihr das Input.
        tree.insertVaultChildren('/vault/notes', '<li class="node" data-path="/vault/notes/neu.md"></li>');

        const still = document.querySelector('.vault-rename-input') as HTMLInputElement;
        expect(still).toBe(input);
        expect(still.value).toBe('halbfertig');
        expect(document.querySelector('.node[data-path="/vault/notes/neu.md"]')).toBeNull();
    });

    it('zieht den Baum nach, sobald das Rename abgebrochen ist', async () => {
        serveTree();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });
        await Promise.resolve();

        const input = await openRename();
        tauri.emitEvent('vault:refresh', {});
        await Promise.resolve();
        tauri.invoke.mockClear();

        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();

        expect(buildTreeCalls()).toBe(1);
        expect(document.querySelector('.vault-rename-input')).toBeNull();
    });
});
