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

describe('vault/tree — pinned items pointer-drag reordering', () => {
    // Reordering laeuft Pointer-basiert (kein HTML5-DnD, das auf
    // Windows/WebView2 vom OS-Drag-Handler geschluckt wird).
    function buildPinnedVaultDom(): void {
        document.body.innerHTML = `
            <div id="vault-region">
                <ul id="vault-tree">
                    <li class="section" data-section="pinned">
                        <div class="row"><span class="label">Angepinnt</span></div>
                        <ul class="children">
                            <li class="node" data-kind="file" data-path="/pinned/a.md">
                                <div class="row"><span class="label">a.md</span></div>
                                <ul class="children collapsed"></ul>
                            </li>
                            <li class="node" data-kind="file" data-path="/pinned/b.md">
                                <div class="row"><span class="label">b.md</span></div>
                                <ul class="children collapsed"></ul>
                            </li>
                            <li class="node" data-kind="dir" data-path="/pinned/c">
                                <div class="row"><span class="label">c</span></div>
                                <ul class="children">
                                    <li class="node" data-kind="file" data-path="/pinned/c/nested.md">
                                        <div class="row"><span class="label">nested.md</span></div>
                                    </li>
                                </ul>
                            </li>
                        </ul>
                    </li>
                    <li class="section" data-section="recent">
                        <div class="row"><span class="label">Zuletzt</span></div>
                        <ul class="children">
                            <li class="node" data-kind="file" data-path="/recent/r.md">
                                <div class="row"><span class="label">r.md</span></div>
                            </li>
                        </ul>
                    </li>
                </ul>
            </div>
        `;
    }

    // jsdom kennt PointerEvent nicht vollstaendig — wir bauen ein generisches
    // Event und haengen die genutzten Felder dran (analog zur vorigen
    // dataTransfer-Mock-Strategie).
    function pe(type: string, opts: Record<string, any> = {}): any {
        const ev = new Event(type, { bubbles: true, cancelable: true }) as any;
        Object.assign(ev, { button: 0, pointerId: 1, clientX: 0, clientY: 0 }, opts);
        return ev;
    }

    const RECT_20 = () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 } as any);

    function row(path: string): HTMLElement {
        return document.querySelector(`.node[data-path="${path}"] > .row`) as HTMLElement;
    }
    function pinnedChildren(): Element[] {
        const ul = document.querySelector('li.section[data-section="pinned"] > ul.children') as HTMLElement;
        return Array.from(ul.children);
    }

    it('does not start a drag from a nested child of a pinned folder', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });
        tree.setVaultPinned(`
            <li class="node" data-kind="file" data-path="/pinned/a.md"><div class="row"></div></li>
            <li class="node" data-kind="dir" data-path="/pinned/c">
                <div class="row"></div>
                <ul class="children">
                    <li class="node" data-kind="file" data-path="/pinned/c/nested.md"><div class="row" id="nested-row"></div></li>
                </ul>
            </li>
        `);

        const nestedRow = document.getElementById('nested-row') as HTMLElement;
        nestedRow.dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientY: 30 }));

        expect(document.querySelector('.node.dragging')).toBeNull();
        expect(tauri.invoke).not.toHaveBeenCalledWith('workspace_reorder_pinned', expect.anything());
    });

    it('does not start a drag from a recent-section item', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });

        const recentRow = document.querySelector('.node[data-path="/recent/r.md"] > .row') as HTMLElement;
        recentRow.dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientY: 30 }));

        expect(document.querySelector('.node.dragging')).toBeNull();
    });

    it('a sub-threshold pointer movement does not start a drag', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });
        tree.setVaultPinned(`
            <li class="node" data-kind="file" data-path="/pinned/a.md"><div class="row"></div></li>
            <li class="node" data-kind="file" data-path="/pinned/b.md"><div class="row"></div></li>
        `);

        row('/pinned/a.md').dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
        document.dispatchEvent(pe('pointermove', { clientX: 2, clientY: 2 })); // dist ~2.8 < 4
        expect(document.querySelector('.node.dragging')).toBeNull();
    });

    it('reorders DOM on drop and invokes workspace_reorder_pinned', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });
        tree.setVaultPinned(`
            <li class="node" data-kind="file" data-path="/pinned/a.md"><div class="row"></div></li>
            <li class="node" data-kind="file" data-path="/pinned/b.md"><div class="row"></div></li>
        `);

        const rootA = document.querySelector('.node[data-path="/pinned/a.md"]') as HTMLElement;
        const rootB = document.querySelector('.node[data-path="/pinned/b.md"]') as HTMLElement;

        row('/pinned/a.md').dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientY: 15 })); // exceed threshold -> active
        expect(rootA.classList.contains('dragging')).toBe(true);

        rootB.getBoundingClientRect = RECT_20;
        rootB.dispatchEvent(pe('pointermove', { clientY: 15 })); // lower half -> after
        expect(rootB.classList.contains('drop-over-after')).toBe(true);

        document.dispatchEvent(pe('pointerup', { clientY: 15 }));

        const children = pinnedChildren();
        expect(children[0]).toBe(rootB);
        expect(children[1]).toBe(rootA);
        expect(rootA.classList.contains('dragging')).toBe(false);
        expect(tauri.invoke).toHaveBeenCalledWith('workspace_reorder_pinned', {
            paths: ['/pinned/b.md', '/pinned/a.md'],
        });
    });

    it('can move a pinned folder before another root item', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });
        tree.setVaultPinned(`
            <li class="node" data-kind="file" data-path="/pinned/a.md"><div class="row"></div></li>
            <li class="node" data-kind="file" data-path="/pinned/b.md"><div class="row"></div></li>
            <li class="node" data-kind="dir" data-path="/pinned/c">
                <div class="row"></div>
                <ul class="children">
                    <li class="node" data-kind="file" data-path="/pinned/c/nested.md"><div class="row"></div></li>
                </ul>
            </li>
        `);

        const rootA = document.querySelector('.node[data-path="/pinned/a.md"]') as HTMLElement;
        const rootC = document.querySelector('.node[data-path="/pinned/c"]') as HTMLElement;

        row('/pinned/c').dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientY: 15 })); // activate

        rootA.getBoundingClientRect = RECT_20;
        rootA.dispatchEvent(pe('pointermove', { clientY: 2 })); // upper half -> before
        expect(rootA.classList.contains('drop-over-before')).toBe(true);

        document.dispatchEvent(pe('pointerup', { clientY: 2 }));

        const children = pinnedChildren();
        expect(children[0]).toBe(rootC);
        expect(children[1]).toBe(rootA);
        expect(tauri.invoke).toHaveBeenCalledWith('workspace_reorder_pinned', {
            paths: ['/pinned/c', '/pinned/a.md', '/pinned/b.md'],
        });
    });

    it('treats nested children of a pinned folder as part of the root drop target', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });
        tree.setVaultPinned(`
            <li class="node" data-kind="file" data-path="/pinned/a.md"><div class="row"></div></li>
            <li class="node" data-kind="file" data-path="/pinned/b.md"><div class="row"></div></li>
            <li class="node" data-kind="dir" data-path="/pinned/c">
                <div class="row"></div>
                <ul class="children">
                    <li class="node" data-kind="file" data-path="/pinned/c/nested.md"><div class="row" id="nested-row"></div></li>
                </ul>
            </li>
        `);

        const rootA = document.querySelector('.node[data-path="/pinned/a.md"]') as HTMLElement;
        const rootC = document.querySelector('.node[data-path="/pinned/c"]') as HTMLElement;
        const nestedRow = document.getElementById('nested-row') as HTMLElement;

        row('/pinned/a.md').dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientY: 15 })); // activate

        rootC.getBoundingClientRect = RECT_20;
        nestedRow.dispatchEvent(pe('pointermove', { clientY: 15 })); // over nested -> targets c, after
        expect(rootC.classList.contains('drop-over-after')).toBe(true);

        document.dispatchEvent(pe('pointerup', { clientY: 15 }));

        const children = pinnedChildren();
        expect(children[0].getAttribute('data-path')).toBe('/pinned/b.md');
        expect(children[1]).toBe(rootC);
        expect(children[2]).toBe(rootA);
        expect(tauri.invoke).toHaveBeenCalledWith('workspace_reorder_pinned', {
            paths: ['/pinned/b.md', '/pinned/c', '/pinned/a.md'],
        });
    });

    it('suppresses the click that follows a real drag, but not a plain click', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        const openDocument = vi.fn();
        tree.initVaultTree({ openDocument });
        tree.setVaultPinned(`
            <li class="node" data-kind="file" data-path="/pinned/a.md"><div class="row"></div></li>
            <li class="node" data-kind="file" data-path="/pinned/b.md"><div class="row"></div></li>
        `);

        const rootB = document.querySelector('.node[data-path="/pinned/b.md"]') as HTMLElement;

        // Real drag of a over b, then the synthetic click must NOT open a.md.
        row('/pinned/a.md').dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointermove', { clientY: 15 }));
        rootB.getBoundingClientRect = RECT_20;
        rootB.dispatchEvent(pe('pointermove', { clientY: 15 }));
        document.dispatchEvent(pe('pointerup', { clientY: 15 }));
        row('/pinned/a.md').dispatchEvent(pe('click'));
        expect(openDocument).not.toHaveBeenCalled();

        // A plain click (pointerdown/up without movement) still opens.
        row('/pinned/b.md').dispatchEvent(pe('pointerdown'));
        document.dispatchEvent(pe('pointerup'));
        row('/pinned/b.md').dispatchEvent(pe('click'));
        expect(openDocument).toHaveBeenCalledWith('/pinned/b.md');
    });
});
