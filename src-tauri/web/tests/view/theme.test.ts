import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';
import { applyViewTheme, initViewTheme, reapplyCurrentViewTheme } from '../../app/view/theme';

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

    it('wendet das aktuelle Theme nach themes:changed erneut an', async () => {
        handles.invoke.mockResolvedValue('.markdown-body { color: red; }');
        await applyViewTheme('github');
        handles.invoke.mockClear();
        initViewTheme();

        handles.emitEvent('themes:changed', { id: 'github', action: 'write' });
        await Promise.resolve();

        expect(handles.invoke).toHaveBeenCalledWith('view_theme_css', {
            themeId: 'github',
            dark: false,
        });
    });

    it('reapply waehrend eines laufenden Theme-Wechsels nutzt die angeforderte ID', async () => {
        // Regression: View-Theme umstellen und direkt danach Hell/Dunkel
        // wechseln (reapplyCurrentViewTheme) liess das ALTE Theme gewinnen,
        // weil die ID erst nach dem await uebernommen wurde.
        handles.invoke.mockResolvedValue('.markdown-body { font-family: serif; }');
        await applyViewTheme('classic');
        expect(document.body.dataset.viewTheme).toBe('classic');

        var pending: Array<() => void> = [];
        handles.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd !== 'view_theme_css') return Promise.resolve();
            var css = args.themeId === 'standard' ? '' : '.markdown-body { font-family: serif; }';
            return new Promise((resolve) => pending.push(() => resolve(css)));
        });

        var switching = applyViewTheme('standard');
        var reapplying = reapplyCurrentViewTheme();
        pending.forEach((resolve) => resolve());
        await Promise.all([switching, reapplying]);

        expect(handles.invoke).toHaveBeenLastCalledWith('view_theme_css', {
            themeId: 'standard',
            dark: false,
        });
        expect(document.body.dataset.viewTheme).toBe('standard');
        expect(document.getElementById('view-theme-style')?.textContent).toBe('');
    });
});
