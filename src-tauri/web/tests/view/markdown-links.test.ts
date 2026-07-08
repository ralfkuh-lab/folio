import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { initMarkdownView } from '../../app/view/markdown';

function renderMarkdownShell(): HTMLAnchorElement {
    document.body.innerHTML = `
        <main id="view-content">
            <p><a href="target.md">Target</a></p>
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
        vi.restoreAllMocks();
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
});
