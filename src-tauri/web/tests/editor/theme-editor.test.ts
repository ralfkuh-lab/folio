import { beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({
    promise: Promise.resolve(),
    resolve: (() => {}) as () => void,
}));

vi.mock('../../editor/mount', () => ({
    whenMonacoLoaded: vi.fn(() => loader.promise),
}));

describe('editor/theme-editor mount lifecycle', () => {
    beforeEach(() => {
        vi.resetModules();
        loader.promise = new Promise<void>((resolve) => {
            loader.resolve = resolve;
        });
        document.body.innerHTML = '<div id="theme-mount"></div>';
    });

    it('does not create an editor after dispose during the first AMD mount', async () => {
        const create = vi.fn();
        (window as any).monaco = {
            editor: {
                create,
                createModel: vi.fn(),
                setTheme: vi.fn(),
            },
        };
        const themeEditor = await import('../../editor/theme-editor');

        const mounting = themeEditor.mount('theme-mount');
        themeEditor.dispose();
        loader.resolve();
        await mounting;

        expect(create).not.toHaveBeenCalled();
    });
});
