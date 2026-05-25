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

describe('vault/tree — pinned items drag & drop reordering', () => {
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

    it('makes only direct root pinned items draggable', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });

        // Trigger setVaultPinned to process it
        tree.setVaultPinned(`
            <li class="node" data-kind="file" data-path="/pinned/a.md"><div class="row"></div></li>
            <li class="node" data-kind="file" data-path="/pinned/b.md"><div class="row"></div></li>
            <li class="node" data-kind="dir" data-path="/pinned/c">
                <div class="row"></div>
                <ul class="children">
                    <li class="node" id="nested-item" data-kind="file" data-path="/pinned/c/nested.md"><div class="row"></div></li>
                </ul>
            </li>
        `);

        const rootA = document.querySelector('.node[data-path="/pinned/a.md"]') as HTMLElement;
        const rootB = document.querySelector('.node[data-path="/pinned/b.md"]') as HTMLElement;
        const rootC = document.querySelector('.node[data-path="/pinned/c"]') as HTMLElement;
        const nestedItem = document.getElementById('nested-item') as HTMLElement;
        const recentItem = document.querySelector('.node[data-path="/recent/r.md"]') as HTMLElement;

        expect(rootA.getAttribute('draggable')).toBe('true');
        expect(rootB.getAttribute('draggable')).toBe('true');
        expect(rootC.getAttribute('draggable')).toBe('true');
        expect(nestedItem.getAttribute('draggable')).toBeNull();
        if (recentItem) {
            expect(recentItem.getAttribute('draggable')).toBeNull();
        }
    });

    it('reorders DOM on drop and invokes workspace_reorder_pinned', async () => {
        buildPinnedVaultDom();
        const tree = await import('../../app/vault/tree');
        tree.initVaultTree({ openDocument: vi.fn() });

        // Force elements draggable & DND setup
        tree.setVaultPinned(`
            <li class="node" data-kind="file" data-path="/pinned/a.md"><div class="row"></div></li>
            <li class="node" data-kind="file" data-path="/pinned/b.md"><div class="row"></div></li>
        `);

        const rootA = document.querySelector('.node[data-path="/pinned/a.md"]') as HTMLElement;
        const rootB = document.querySelector('.node[data-path="/pinned/b.md"]') as HTMLElement;

        // Mock drag & drop events
        const dragStartEvent = new Event('dragstart', { bubbles: true }) as any;
        dragStartEvent.dataTransfer = {
            setData: vi.fn(),
            effectAllowed: 'none',
        };
        const labelA = rootA.querySelector('.row') as HTMLElement;
        labelA.dispatchEvent(dragStartEvent);

        expect(dragStartEvent.dataTransfer.setData).toHaveBeenCalledWith('application/x-folio-pin', '/pinned/a.md');
        expect(rootA.classList.contains('dragging')).toBe(true);

        const dragOverEvent = new Event('dragover', { bubbles: true }) as any;
        dragOverEvent.dataTransfer = {
            types: ['application/x-folio-pin'],
            dropEffect: 'none',
        };
        dragOverEvent.clientY = 15; // Mock y coordinate (lower half)
        rootB.getBoundingClientRect = () => ({
            top: 0,
            bottom: 20,
            left: 0,
            right: 100,
            width: 100,
            height: 20,
        } as any);

        rootB.dispatchEvent(dragOverEvent);
        expect(rootB.classList.contains('drop-over-after')).toBe(true);

        // Mock dropping
        const dropEvent = new Event('drop', { bubbles: true }) as any;
        dropEvent.dataTransfer = {
            types: ['application/x-folio-pin'],
            getData: (type: string) => type === 'application/x-folio-pin' ? '/pinned/a.md' : '',
        };
        rootB.dispatchEvent(dropEvent);

        // Check DOM is reordered locally: rootA should be placed after rootB
        const pinnedUl = document.querySelector('li.section[data-section="pinned"] > ul.children') as HTMLElement;
        const children = Array.from(pinnedUl.children);
        expect(children[0]).toBe(rootB);
        expect(children[1]).toBe(rootA);

        // Expect Tauri invoke of workspace_reorder_pinned to have been called with the new order
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

        const dragStartEvent = new Event('dragstart', { bubbles: true }) as any;
        dragStartEvent.dataTransfer = {
            setData: vi.fn(),
            effectAllowed: 'none',
        };
        rootC.querySelector('.row')!.dispatchEvent(dragStartEvent);

        const dragOverEvent = new Event('dragover', { bubbles: true }) as any;
        dragOverEvent.dataTransfer = {
            types: ['application/x-folio-pin'],
            dropEffect: 'none',
        };
        dragOverEvent.clientY = 2;
        rootA.getBoundingClientRect = () => ({
            top: 0,
            bottom: 20,
            left: 0,
            right: 100,
            width: 100,
            height: 20,
        } as any);
        rootA.dispatchEvent(dragOverEvent);
        expect(rootA.classList.contains('drop-over-before')).toBe(true);

        const dropEvent = new Event('drop', { bubbles: true }) as any;
        dropEvent.dataTransfer = {
            types: ['application/x-folio-pin'],
            getData: (type: string) => type === 'application/x-folio-pin' ? '/pinned/c' : '',
        };
        rootA.dispatchEvent(dropEvent);

        const pinnedUl = document.querySelector('li.section[data-section="pinned"] > ul.children') as HTMLElement;
        const children = Array.from(pinnedUl.children);
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

        const dragStartEvent = new Event('dragstart', { bubbles: true }) as any;
        dragStartEvent.dataTransfer = {
            setData: vi.fn(),
            effectAllowed: 'none',
        };
        rootA.querySelector('.row')!.dispatchEvent(dragStartEvent);

        const dragOverEvent = new Event('dragover', { bubbles: true }) as any;
        dragOverEvent.dataTransfer = {
            types: ['application/x-folio-pin'],
            dropEffect: 'none',
        };
        dragOverEvent.clientY = 15;
        rootC.getBoundingClientRect = () => ({
            top: 0,
            bottom: 20,
            left: 0,
            right: 100,
            width: 100,
            height: 20,
        } as any);
        nestedRow.dispatchEvent(dragOverEvent);
        expect(rootC.classList.contains('drop-over-after')).toBe(true);

        const dropEvent = new Event('drop', { bubbles: true }) as any;
        dropEvent.dataTransfer = {
            types: ['application/x-folio-pin'],
            getData: (type: string) => type === 'application/x-folio-pin' ? '/pinned/a.md' : '',
        };
        nestedRow.dispatchEvent(dropEvent);

        const pinnedUl = document.querySelector('li.section[data-section="pinned"] > ul.children') as HTMLElement;
        const children = Array.from(pinnedUl.children);
        expect(children[0].getAttribute('data-path')).toBe('/pinned/b.md');
        expect(children[1]).toBe(rootC);
        expect(children[2]).toBe(rootA);
        expect(tauri.invoke).toHaveBeenCalledWith('workspace_reorder_pinned', {
            paths: ['/pinned/b.md', '/pinned/c', '/pinned/a.md'],
        });
    });
});
