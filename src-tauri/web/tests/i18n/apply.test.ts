import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStaticTranslations } from '../../app/i18n/apply';
import { seedCatalog, __resetI18nForTests } from '../../app/i18n/translate';

describe('applyStaticTranslations', () => {
    beforeEach(() => {
        __resetI18nForTests();
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('lang');
    });

    it('does nothing without catalog (degradation)', () => {
        document.body.innerHTML = '<span data-i18n="menu.file">Datei</span>';
        applyStaticTranslations();
        expect(document.body.querySelector('span')!.textContent).toBe('Datei');
        expect(document.documentElement.getAttribute('lang')).toBeNull();
    });

    it('applies text/title/placeholder/aria and sets lang', () => {
        seedCatalog({
            tag: 'de',
            locale: 'de-DE',
            languages: [],
            strings: {
                'menu.file': 'Datei',
                'a.title': 'Titel',
                'a.ph': 'Platzhalter',
                'a.aria': 'Label',
            },
        });
        document.body.innerHTML = `
            <span data-i18n="menu.file">xx</span>
            <input data-i18n-placeholder="a.ph" data-i18n-title="a.title" data-i18n-aria-label="a.aria" />
        `;
        applyStaticTranslations();
        expect(document.documentElement.lang).toBe('de');
        expect(document.body.querySelector('span')!.textContent).toBe('Datei');
        const input = document.body.querySelector('input')!;
        expect(input.getAttribute('placeholder')).toBe('Platzhalter');
        expect(input.getAttribute('title')).toBe('Titel');
        expect(input.getAttribute('aria-label')).toBe('Label');
    });

    it('never removes element children on non-leaf data-i18n', () => {
        seedCatalog({
            tag: 'de',
            locale: 'de-DE',
            languages: [],
            strings: { 'x.label': 'X' },
        });
        document.body.innerHTML =
            '<label data-i18n="x.label"><input type="checkbox"><span>keep</span></label>';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        applyStaticTranslations();
        const label = document.body.querySelector('label')!;
        expect(label.querySelector('input')).not.toBeNull();
        expect(label.querySelector('span')!.textContent).toBe('keep');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
