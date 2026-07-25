import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';

const { handleFolioNewClick } = vi.hoisted(() => ({
    handleFolioNewClick: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../app/view/wikilink-create', async () => {
    const actual = await vi.importActual<typeof import('../../app/view/wikilink-create')>(
        '../../app/view/wikilink-create',
    );
    return {
        ...actual,
        handleFolioNewClick: (...args: unknown[]) => handleFolioNewClick(...args),
    };
});

import { initMarkdownView } from '../../app/view/markdown';

function renderMarkdownShell(href = 'target.md'): HTMLAnchorElement {
    document.body.innerHTML = `
        <main id="view-content">
            <p><a href="${href}">Target</a></p>
            <button id="outside">Outside</button>
        </main>
        <aside id="toc-region"><ul class="toc"></ul></aside>
    `;
    return document.querySelector('a')!;
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('view/markdown links', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        handleFolioNewClick.mockResolvedValue(undefined);
        installTauriMock();
    });

    it('posts normal link clicks after waiting for dirty-save handling', async () => {
        const link = renderMarkdownShell();
        const requestSaveIfDirty = vi.fn().mockResolvedValue(true);
        initMarkdownView({ requestSaveIfDirty });

        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        const dispatched = link.dispatchEvent(event);
        await flushPromises();

        expect(dispatched).toBe(false);
        expect(requestSaveIfDirty).toHaveBeenCalledTimes(1);
        expect(window.__TAURI__!.event.emit).toHaveBeenCalledWith('shell:event', {
            type: 'linkClick',
            href: 'target.md',
            newTab: false,
        });
    });

    it('posts ctrl-clicks as new-tab link clicks without dirty-save handling', () => {
        const link = renderMarkdownShell();
        const requestSaveIfDirty = vi.fn().mockResolvedValue(true);
        initMarkdownView({ requestSaveIfDirty });

        const dispatched = link.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
        );

        expect(dispatched).toBe(false);
        expect(requestSaveIfDirty).not.toHaveBeenCalled();
        expect(window.__TAURI__!.event.emit).toHaveBeenCalledWith('shell:event', {
            type: 'linkClick',
            href: 'target.md',
            newTab: true,
        });
    });

    it('posts cmd-clicks as new-tab link clicks without dirty-save handling', () => {
        const link = renderMarkdownShell();
        const requestSaveIfDirty = vi.fn().mockResolvedValue(true);
        initMarkdownView({ requestSaveIfDirty });

        link.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
        );

        expect(requestSaveIfDirty).not.toHaveBeenCalled();
        expect(window.__TAURI__!.event.emit).toHaveBeenCalledWith('shell:event', {
            type: 'linkClick',
            href: 'target.md',
            newTab: true,
        });
    });

    it('posts middle-clicks as new-tab link clicks', () => {
        const link = renderMarkdownShell();
        const requestSaveIfDirty = vi.fn().mockResolvedValue(true);
        initMarkdownView({ requestSaveIfDirty });

        const dispatched = link.dispatchEvent(
            new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
        );

        expect(dispatched).toBe(false);
        expect(requestSaveIfDirty).not.toHaveBeenCalled();
        expect(window.__TAURI__!.event.emit).toHaveBeenCalledWith('shell:event', {
            type: 'linkClick',
            href: 'target.md',
            newTab: true,
        });
    });

    it('ignores clicks outside links', () => {
        renderMarkdownShell();
        initMarkdownView({ requestSaveIfDirty: vi.fn().mockResolvedValue(true) });
        document.getElementById('outside')!.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        );

        expect(window.__TAURI__!.event.emit).not.toHaveBeenCalled();
    });

    it('intercepts folio-new: clicks in the frontend (no shell:event)', async () => {
        const link = renderMarkdownShell('folio-new:Missing%20Note');
        const requestSaveIfDirty = vi.fn().mockResolvedValue(true);
        initMarkdownView({ requestSaveIfDirty });

        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await flushPromises();

        expect(handleFolioNewClick).toHaveBeenCalledWith('folio-new:Missing%20Note');
        expect(requestSaveIfDirty).not.toHaveBeenCalled();
        expect(window.__TAURI__!.event.emit).not.toHaveBeenCalled();
    });

    it('intercepts folio-new: middle-clicks without newTab backend path', () => {
        const link = renderMarkdownShell('folio-new:X');
        initMarkdownView({ requestSaveIfDirty: vi.fn().mockResolvedValue(true) });

        link.dispatchEvent(
            new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
        );

        expect(handleFolioNewClick).toHaveBeenCalledWith('folio-new:X');
        expect(window.__TAURI__!.event.emit).not.toHaveBeenCalled();
    });

    it('does not treat resolved relative links as folio-new', async () => {
        const link = renderMarkdownShell('other.md#heading');
        initMarkdownView({ requestSaveIfDirty: vi.fn().mockResolvedValue(true) });
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await flushPromises();

        expect(handleFolioNewClick).not.toHaveBeenCalled();
        expect(window.__TAURI__!.event.emit).toHaveBeenCalledWith('shell:event', {
            type: 'linkClick',
            href: 'other.md#heading',
            newTab: false,
        });
    });
});
