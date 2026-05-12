// Tests fuer vault/tree.ts. Schwerpunkt: setVaultActive (Active-Marker
// auf .node mit passendem data-path) und toggleDir (Klick auf
// .row eines dir-Nodes feuert shell:event `expand-dir`/`collapse-dir`
// plus toggelt die caret/ul-Klassen DOM-seitig). toggleDir ist privat,
// also wird der Effekt ueber den Click-Handler getestet, den
// initVaultTree am #vault-region registriert.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';

vi.mock('../../app/vault/context-menu', () => ({
    openContextMenu: vi.fn(),
    closeContextMenu: vi.fn(),
}));

let tauri: TauriMockHandles;

function buildVaultDom(): void {
    document.body.innerHTML = `
        <div id="vault-region">
            <ul id="vault-tree">
                <li class="node" data-kind="dir" data-path="/foo">
                    <div class="row">
                        <span class="caret"></span>
                        <span class="icon">📁</span>
                        <span class="label">foo</span>
                    </div>
                    <ul class="children collapsed"></ul>
                </li>
                <li class="node" data-kind="file" data-path="/foo/bar.md">
                    <div class="row">
                        <span class="caret hidden"></span>
                        <span class="label">bar.md</span>
                    </div>
                </li>
            </ul>
        </div>
    `;
}

beforeEach(() => {
    tauri = installTauriMock();
    buildVaultDom();
    vi.resetModules();
});

describe('vault/tree — setVaultActive', () => {
    it('paints .active on the node matching data-path', async () => {
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });

        tree.setVaultActive('/foo/bar.md');
        const fileNode = document.querySelector('.node[data-path="/foo/bar.md"]');
        expect(fileNode!.classList.contains('active')).toBe(true);

        // Wechsel auf anderen Pfad raeumt den alten Marker auf.
        tree.setVaultActive('/foo');
        expect(fileNode!.classList.contains('active')).toBe(false);
        const dirNode = document.querySelector('.node[data-path="/foo"]');
        expect(dirNode!.classList.contains('active')).toBe(true);

        // Leerer Pfad raeumt alles auf.
        tree.setVaultActive('');
        expect(document.querySelectorAll('.node.active').length).toBe(0);
    });
});

describe('vault/tree — toggleDir via click', () => {
    it('expand: caret.open, ul not collapsed, shell:event expand-dir emitted', async () => {
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });

        const row = document.querySelector('.node[data-kind="dir"] .row') as HTMLElement;
        row.click();

        const dirNode = document.querySelector('.node[data-kind="dir"]') as HTMLElement;
        expect(dirNode.querySelector('.caret')!.classList.contains('open')).toBe(true);
        expect(dirNode.querySelector('ul.children')!.classList.contains('collapsed')).toBe(false);

        const expandCalls = tauri.emit.mock.calls.filter(
            (c: any[]) => c[0] === 'shell:event' && c[1]?.type === 'expand-dir',
        );
        expect(expandCalls.length).toBe(1);
        expect(expandCalls[0][1].path).toBe('/foo');
    });

    it('collapse on second click: caret.open removed, shell:event collapse-dir', async () => {
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });

        const row = document.querySelector('.node[data-kind="dir"] .row') as HTMLElement;
        row.click();
        tauri.emit.mockClear();
        row.click();

        const dirNode = document.querySelector('.node[data-kind="dir"]') as HTMLElement;
        expect(dirNode.querySelector('.caret')!.classList.contains('open')).toBe(false);
        expect(dirNode.querySelector('ul.children')!.classList.contains('collapsed')).toBe(true);

        const collapseCalls = tauri.emit.mock.calls.filter(
            (c: any[]) => c[0] === 'shell:event' && c[1]?.type === 'collapse-dir',
        );
        expect(collapseCalls.length).toBe(1);
        expect(collapseCalls[0][1].path).toBe('/foo');
    });

    it('clicking a file row calls deps.openDocument with the path', async () => {
        const tree = await import('../../app/vault/tree');
        const openDocument = vi.fn();
        tree.initVaultTree({ openDocument });

        const fileRow = document.querySelector('.node[data-kind="file"] .row') as HTMLElement;
        fileRow.click();

        expect(openDocument).toHaveBeenCalledWith('/foo/bar.md');
    });
});

describe('vault/tree — insertVaultChildren', () => {
    it('replaces ul.children innerHTML and sets caret.open / icon 📂', async () => {
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });

        tree.insertVaultChildren(
            '/foo',
            '<li class="node" data-kind="file" data-path="/foo/x.md"><div class="row"></div></li>',
        );

        const dirNode = document.querySelector('.node[data-path="/foo"]') as HTMLElement;
        expect(dirNode.querySelector('.caret')!.classList.contains('open')).toBe(true);
        expect(dirNode.querySelector('.icon')!.textContent).toBe('📂');
        expect(dirNode.querySelector('ul.children')!.querySelector('.node[data-path="/foo/x.md"]')).not.toBeNull();
    });
});
