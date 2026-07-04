/* View-Theme fuer die Markdown-Ansicht.
   Das Backend liefert ausschliesslich auf `.markdown-body` gescoptes CSS.
   Die Injection bleibt absichtlich das letzte Element im Head, damit das
   gewaehlte Theme die eingebauten View-Regeln ueberstimmt. */

import { safeInvoke } from '../util/log';

export type ViewThemeDarkMap = Record<string, boolean>;

let currentThemeId = 'standard';
let applyGeneration = 0;

function themeStyle(): HTMLStyleElement {
    var style = document.getElementById('view-theme-style') as HTMLStyleElement | null;
    if (!style) {
        style = document.createElement('style');
        style.id = 'view-theme-style';
    }
    document.head.appendChild(style);
    return style;
}

export async function applyViewTheme(
    themeId: string,
    _hasDarkMap?: ViewThemeDarkMap,
): Promise<string> {
    var requested = typeof themeId === 'string' && themeId ? themeId : 'standard';
    var generation = ++applyGeneration;
    var dark = document.documentElement.classList.contains('theme-dark');
    var css = await safeInvoke<string>(
        'view_theme_css',
        { themeId: requested, dark },
        'view_theme_css',
        'warn',
    );
    if (generation !== applyGeneration) return currentThemeId;

    var effective = typeof css === 'string' ? requested : 'standard';
    var style = themeStyle();
    style.textContent = typeof css === 'string' ? css : '';
    document.body.dataset.viewTheme = effective;
    currentThemeId = effective;
    return effective;
}

export function reapplyCurrentViewTheme(): Promise<string> {
    return applyViewTheme(currentThemeId);
}

export function initViewTheme(): void {
    var ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;
    ev.listen('settings:changed', function (event: any) {
        var payload = (event && event.payload) || {};
        var changed = Array.isArray(payload.changed) ? payload.changed : [];
        var settings = payload.settings;
        if (!changed.includes('viewTheme')
            || !settings
            || typeof settings.viewTheme !== 'string') return;
        applyViewTheme(settings.viewTheme);
    });
}

