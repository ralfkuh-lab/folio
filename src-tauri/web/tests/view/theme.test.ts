import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';
import { applyViewTheme } from '../../app/view/theme';

describe('view/theme', () => {
    let handles: TauriMockHandles;

    beforeEach(() => {
        handles = installTauriMock();
        document.documentElement.classList.remove('theme-dark', 'theme-light');
        document.body.removeAttribute('data-view-theme');
        document.getElementById('view-theme-style')?.remove();
    });

    afterEach(() => {
        document.getElementById('view-theme-style')?.remove();
        document.body.removeAttribute('data-view-theme');
    });

    it('injiziert Theme-CSS als letztes Head-Element', async () => {
        handles.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'view_theme_css') {
                expect(args).toEqual({ themeId: 'github', dark: false });
                return Promise.resolve('.markdown-body { color: red; }');
            }
            return Promise.resolve();
        });
        var marker = document.createElement('meta');
        document.head.appendChild(marker);

        await applyViewTheme('github');

        var style = document.getElementById('view-theme-style');
        expect(style?.textContent).toContain('color: red');
        expect(document.head.lastElementChild).toBe(style);
        expect(document.body.dataset.viewTheme).toBe('github');
    });

    it('fragt im dunklen App-Theme die Dark-Variante ab', async () => {
        document.documentElement.classList.add('theme-dark');
        handles.invoke.mockResolvedValue('.markdown-body { background: #0d1117; }');

        await applyViewTheme('github');

        expect(handles.invoke).toHaveBeenCalledWith('view_theme_css', {
            themeId: 'github',
            dark: true,
        });
    });

    it('leert Standard-CSS und faellt bei Backend-Fehler auf Standard zurueck', async () => {
        handles.invoke.mockResolvedValueOnce('.markdown-body { color: red; }');
        await applyViewTheme('clean');
        expect(document.getElementById('view-theme-style')?.textContent).not.toBe('');

        handles.invoke.mockResolvedValueOnce('');
        await applyViewTheme('standard');
        expect(document.getElementById('view-theme-style')?.textContent).toBe('');
        expect(document.body.dataset.viewTheme).toBe('standard');

        handles.invoke.mockRejectedValueOnce(new Error('unbekannt'));
        await applyViewTheme('gibtsnicht');
        expect(document.getElementById('view-theme-style')?.textContent).toBe('');
        expect(document.body.dataset.viewTheme).toBe('standard');
    });
});

