import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import {
    t,
    tPlural,
    seedCatalog,
    initI18n,
    getCatalog,
    __resetI18nForTests,
} from '../../app/i18n/translate';
import { applyStaticTranslations } from '../../app/i18n/apply';

describe('i18n t / tPlural', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog({
            tag: 'de',
            locale: 'de-DE',
            languages: [{ tag: 'de', name: 'Deutsch' }],
            strings: {
                'menu.file': 'Datei',
                'search.status.hitsPart': {
                    one: '1 Treffer',
                    other: '{count} Treffer',
                },
                'search.status.done': '{hitsPart} in {filesPart} ({ms} ms)',
                'greet': 'Hallo {name}',
            },
        });
    });

    it('t returns string and interpolates', () => {
        expect(t('menu.file')).toBe('Datei');
        expect(t('greet', { name: 'Ralf' })).toBe('Hallo Ralf');
    });

    it('t missing key returns key and warns once', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(t('missing.key')).toBe('missing.key');
        expect(t('missing.key')).toBe('missing.key');
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('tPlural injects count and selects one/other', () => {
        expect(tPlural('search.status.hitsPart', 1)).toBe('1 Treffer');
        expect(tPlural('search.status.hitsPart', 0)).toBe('0 Treffer');
        expect(tPlural('search.status.hitsPart', 2)).toBe('2 Treffer');
    });

    it('tPlural throws on count override in args', () => {
        expect(() => tPlural('search.status.hitsPart', 2, { count: 9 })).toThrow(
            /count/,
        );
    });

    it('F2: tPlural rejects negative count', () => {
        expect(() => tPlural('search.status.hitsPart', -1)).toThrow(/non-negative integer/);
    });

    it('F2: tPlural rejects non-integer count', () => {
        expect(() => tPlural('search.status.hitsPart', 1.5)).toThrow(/non-negative integer/);
    });

    it('F2: tPlural rejects NaN', () => {
        expect(() => tPlural('search.status.hitsPart', NaN)).toThrow(/non-negative integer/);
    });

    it('F2: tPlural rejects Infinity', () => {
        expect(() => tPlural('search.status.hitsPart', Infinity)).toThrow(/non-negative integer/);
    });

    it('composition example matches Rust semantics', () => {
        expect(
            t('search.status.done', {
                hitsPart: tPlural('search.status.hitsPart', 2),
                filesPart: '1 Datei',
                ms: '12',
            }),
        ).toBe('2 Treffer in 1 Datei (12 ms)');
    });
});

describe('F5: initI18n', () => {
    beforeEach(() => {
        __resetI18nForTests();
        installTauriMock();
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('lang');
    });

    it('success: parses catalog from i18n_catalog invoke', async () => {
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === 'i18n_catalog') {
                return {
                    tag: 'de',
                    locale: 'de-DE',
                    languages: [{ tag: 'de', name: 'Deutsch' }],
                    strings: { 'menu.file': 'Datei' },
                };
            }
            return undefined;
        });

        const ok = await initI18n();
        expect(ok).toBe(true);
        expect(getCatalog()?.tag).toBe('de');
        expect(t('menu.file')).toBe('Datei');
    });

    it('failure: degradation (false, null catalog, no apply)', async () => {
        const invoke = (window as any).__TAURI__.core.invoke as ReturnType<typeof vi.fn>;
        invoke.mockRejectedValue(new Error('backend down'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        document.body.innerHTML = '<span data-i18n="menu.file">Platzhalter</span>';
        const ok = await initI18n();
        expect(ok).toBe(false);
        expect(getCatalog()).toBeNull();

        applyStaticTranslations();
        expect(document.body.querySelector('span')!.textContent).toBe('Platzhalter');
        expect(document.documentElement.getAttribute('lang')).toBeNull();

        warn.mockRestore();
    });
});
