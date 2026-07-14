/**
 * I3a: Plural-Kompositionen — volles kartesisches 0/1/2-Produkt de+en
 * (Wortstatistik 3×3×3, Search done/running 3×3, empty+skipped inkl. 0).
 * ms via fmtNumber wie Produktionspfad. fr count=0 nutzt {count}-Injektion
 * (fr PluralRules: 0 → "one").
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    t,
    tPlural,
    seedCatalog,
    __resetI18nForTests,
} from '../../app/i18n/translate';
import { setFormatLocale, fmtNumber } from '../../app/i18n/format';
import type { I18nCatalog } from '../../app/i18n/types';

type Tag = 'de' | 'en' | 'fr';

function loadCatalog(tag: Tag): I18nCatalog {
    // fr fixture lives under src-tauri/tests/fixtures (not repo-root tests/).
    const path =
        tag === 'fr'
            ? resolve(__dirname, '../../../tests/fixtures/locales/fr.json')
            : resolve(__dirname, `../../../locales/${tag}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const meta = raw['@meta'];
    const strings: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) {
        if (k === '@meta') continue;
        strings[k] = raw[k];
    }
    return {
        tag: meta.tag,
        locale: meta.locale,
        languages: [{ tag: meta.tag, name: meta.name, flag: meta.flag }],
        strings: strings as I18nCatalog['strings'],
    };
}

const COUNTS = [0, 1, 2] as const;

function wordCountLine(words: number, chars: number, lines: number): string {
    return t('statusBar.wordCount.template', {
        wordsPart: tPlural('statusBar.wordCount.wordsPart', words),
        charsPart: tPlural('statusBar.wordCount.charsPart', chars),
        linesPart: tPlural('statusBar.wordCount.linesPart', lines),
    });
}

function searchDone(hits: number, files: number, ms: number): string {
    return t('search.status.done', {
        hitsPart: tPlural('search.status.hitsPart', hits),
        filesPart: tPlural('search.status.filesPart', files),
        ms: fmtNumber(ms),
    });
}

function searchEmpty(filesScanned: number): string {
    return t('search.status.empty', {
        filesPart: tPlural('search.status.filesPart', filesScanned),
    });
}

function searchRunning(hits: number, files: number): string {
    return t('search.status.running', {
        hitsPart: tPlural('search.status.hitsPart', hits),
        filesPart: tPlural('search.status.filesPart', files),
    });
}

function searchSkipped(n: number): string {
    return t('search.status.skippedSuffix', {
        skippedPart: tPlural('search.status.skippedPart', n),
    });
}

/** Expected de/en segment helpers (one only for count===1). */
const de = {
    words: (n: number) => (n === 1 ? '1 Wort' : `${n} Wörter`),
    chars: (n: number) => (n === 1 ? '1 Zeichen' : `${n} Zeichen`),
    lines: (n: number) => (n === 1 ? '1 Zeile' : `${n} Zeilen`),
    hits: (n: number) => (n === 1 ? '1 Treffer' : `${n} Treffer`),
    files: (n: number) => (n === 1 ? '1 Datei' : `${n} Dateien`),
    skipped: (n: number) => (n === 1 ? '1 große Datei' : `${n} große Dateien`),
};

const en = {
    words: (n: number) => (n === 1 ? '1 word' : `${n} words`),
    chars: (n: number) => (n === 1 ? '1 character' : `${n} characters`),
    lines: (n: number) => (n === 1 ? '1 line' : `${n} lines`),
    hits: (n: number) => (n === 1 ? '1 hit' : `${n} hits`),
    files: (n: number) => (n === 1 ? '1 file' : `${n} files`),
    skipped: (n: number) => (n === 1 ? '1 large file' : `${n} large files`),
};

describe('I3a plural compositions — de (full 0/1/2 cartesian)', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('de'));
        setFormatLocale('de-DE');
    });

    it('word count 3×3×3 = 27 combinations', () => {
        for (const w of COUNTS) {
            for (const c of COUNTS) {
                for (const l of COUNTS) {
                    expect(wordCountLine(w, c, l)).toBe(
                        `${de.words(w)} · ${de.chars(c)} · ${de.lines(l)}`,
                    );
                }
            }
        }
    });

    it('search done 3×3 and running 3×3 (hits × files)', () => {
        for (const h of COUNTS) {
            for (const f of COUNTS) {
                expect(searchDone(h, f, 12)).toBe(
                    `${de.hits(h)} in ${de.files(f)} (${fmtNumber(12)} ms)`,
                );
                expect(searchRunning(h, f)).toBe(
                    `${de.hits(h)} in ${de.files(f)} …`,
                );
            }
        }
    });

    it('search empty and skipped include 0/1/2', () => {
        for (const n of COUNTS) {
            expect(searchEmpty(n)).toBe(
                `Keine Treffer (${de.files(n)} durchsucht)`,
            );
            expect(searchSkipped(n)).toBe(
                ` — ${de.skipped(n)} übersprungen`,
            );
        }
    });
});

describe('I3a plural compositions — en (full 0/1/2 cartesian)', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('en'));
        setFormatLocale('en-US');
    });

    it('word count 3×3×3 = 27 combinations', () => {
        for (const w of COUNTS) {
            for (const c of COUNTS) {
                for (const l of COUNTS) {
                    expect(wordCountLine(w, c, l)).toBe(
                        `${en.words(w)} · ${en.chars(c)} · ${en.lines(l)}`,
                    );
                }
            }
        }
    });

    it('search done 3×3 and running 3×3 (hits × files)', () => {
        for (const h of COUNTS) {
            for (const f of COUNTS) {
                expect(searchDone(h, f, 99)).toBe(
                    `${en.hits(h)} in ${en.files(f)} (${fmtNumber(99)} ms)`,
                );
                expect(searchRunning(h, f)).toBe(
                    `${en.hits(h)} in ${en.files(f)} …`,
                );
            }
        }
    });

    it('search empty and skipped include 0/1/2', () => {
        for (const n of COUNTS) {
            expect(searchEmpty(n)).toBe(
                `No matches (${en.files(n)} scanned)`,
            );
            expect(searchSkipped(n)).toBe(
                ` — ${en.skipped(n)} skipped`,
            );
        }
    });
});

describe('I3a plural compositions — fr (0→one injects {count})', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('fr'));
        setFormatLocale('fr-FR');
    });

    it('count=0 uses one-branch with {count} injection (never hard-coded 1)', () => {
        // Regression: fr PluralRules selects "one" for 0 — templates must use {count}.
        expect(new Intl.PluralRules('fr').select(0)).toBe('one');
        expect(tPlural('search.status.hitsPart', 0)).toBe('0 résultat');
        expect(tPlural('search.status.filesPart', 0)).toBe('0 fichier');
        expect(tPlural('statusBar.wordCount.wordsPart', 0)).toBe('0 mot');
        expect(tPlural('statusBar.wordCount.charsPart', 0)).toBe('0 caractère');
        expect(tPlural('statusBar.wordCount.linesPart', 0)).toBe('0 ligne');
        expect(tPlural('search.status.skippedPart', 0)).toBe('0 gros fichier ignoré');
        expect(searchEmpty(0)).toBe('Aucun résultat (0 fichier)');
        expect(searchSkipped(0)).toBe(' — 0 gros fichier ignoré');
        expect(wordCountLine(0, 0, 0)).toBe('0 mot · 0 caractère · 0 ligne');
        // I3b: export.layouts.more + ai.status.charsPart also cover 0 via one+{count}
        expect(tPlural('export.layouts.more', 0)).toBe('0 autre mise en page');
        expect(tPlural('ai.status.charsPart', 0, { formattedCount: fmtNumber(0) })).toBe('0 caractère');
    });

    it('count=1 and 2 select correct branches', () => {
        expect(tPlural('search.status.hitsPart', 1)).toBe('1 résultat');
        expect(tPlural('search.status.hitsPart', 2)).toBe('2 résultats');
        expect(tPlural('search.status.filesPart', 1)).toBe('1 fichier');
        expect(tPlural('search.status.filesPart', 2)).toBe('2 fichiers');
        expect(searchSkipped(1)).toBe(' — 1 gros fichier ignoré');
        expect(searchSkipped(2)).toBe(' — 2 gros fichiers ignorés');
        expect(tPlural('export.layouts.more', 1)).toBe('1 autre mise en page');
        expect(tPlural('export.layouts.more', 2)).toBe('2 autres mises en page');
        expect(tPlural('ai.status.charsPart', 1, { formattedCount: fmtNumber(1) })).toBe('1 caractère');
        expect(tPlural('ai.status.charsPart', 2, { formattedCount: fmtNumber(2) })).toBe('2 caractères');
    });
});

/** I3b: „Weitere Layouts (n)" + AI-Zeichen-Plural 0/1/2 de+en. */
describe('I3b export.layouts.more + ai.status.charsPart — de', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('de'));
        setFormatLocale('de-DE');
    });

    it('export.layouts.more 0/1/2', () => {
        expect(tPlural('export.layouts.more', 0)).toBe('Weitere Layouts (0)');
        expect(tPlural('export.layouts.more', 1)).toBe('Weiteres Layout (1)');
        expect(tPlural('export.layouts.more', 2)).toBe('Weitere Layouts (2)');
    });

    it('ai.status.charsPart 0/1/2 (streaming status composition)', () => {
        expect(tPlural('ai.status.charsPart', 0, { formattedCount: fmtNumber(0) })).toBe('0 Zeichen');
        expect(tPlural('ai.status.charsPart', 1, { formattedCount: fmtNumber(1) })).toBe('1 Zeichen');
        expect(tPlural('ai.status.charsPart', 2, { formattedCount: fmtNumber(2) })).toBe('2 Zeichen');
        expect(tPlural('ai.status.charsPart', 12400, { formattedCount: fmtNumber(12400) })).toBe('12.400 Zeichen');
        expect(t('ai.actions.status.charCount', {
            actionName: 'Zusammenfassen',
            charsPart: tPlural('ai.status.charsPart', 0, { formattedCount: fmtNumber(0) }),
        })).toBe('✨ Zusammenfassen · 0 Zeichen');
        expect(t('export.aiDraft.status.charCount', {
            charsPart: tPlural('ai.status.charsPart', 12, { formattedCount: fmtNumber(12) }),
        })).toBe('KI-Generierung · 12 Zeichen');
        expect(t('ai.translate.status.charCount', {
            language: 'en',
            charsPart: tPlural('ai.status.charsPart', 1, { formattedCount: fmtNumber(1) }),
        })).toBe('KI-Übersetzung en · 1 Zeichen');
    });
});

describe('I3b export.layouts.more + ai.status.charsPart — en', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('en'));
        setFormatLocale('en-US');
    });

    it('export.layouts.more 0/1/2', () => {
        expect(tPlural('export.layouts.more', 0)).toBe('0 more layouts');
        expect(tPlural('export.layouts.more', 1)).toBe('1 more layout');
        expect(tPlural('export.layouts.more', 2)).toBe('2 more layouts');
    });

    it('ai.status.charsPart 0/1/2', () => {
        expect(tPlural('ai.status.charsPart', 0, { formattedCount: fmtNumber(0) })).toBe('0 characters');
        expect(tPlural('ai.status.charsPart', 1, { formattedCount: fmtNumber(1) })).toBe('1 character');
        expect(tPlural('ai.status.charsPart', 2, { formattedCount: fmtNumber(2) })).toBe('2 characters');
    });
});

/** F1: selection scope must pluralize via ai.status.charsPart (not bare “characters”). */
function selectionScope(count: number): string {
    return t('ai.actions.scope.selectionWithCount', {
        charsPart: tPlural('ai.status.charsPart', count, {
            formattedCount: fmtNumber(count),
        }),
    });
}

describe('I3b-fix F1 selectionWithCount composition — en', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('en'));
        setFormatLocale('en-US');
    });

    it('0/1/2 plural forms', () => {
        expect(selectionScope(0)).toBe('Selection (0 characters)');
        expect(selectionScope(1)).toBe('Selection (1 character)');
        expect(selectionScope(2)).toBe('Selection (2 characters)');
    });
});

describe('I3b-fix F1 selectionWithCount composition — fr', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('fr'));
        setFormatLocale('fr-FR');
    });

    it('0/1/2 (0→one with {formattedCount})', () => {
        expect(selectionScope(0)).toBe('Sélection (0 caractère)');
        expect(selectionScope(1)).toBe('Sélection (1 caractère)');
        expect(selectionScope(2)).toBe('Sélection (2 caractères)');
    });
});

describe('I3b-fix F1 selectionWithCount composition — de', () => {
    beforeEach(() => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('de'));
        setFormatLocale('de-DE');
    });

    it('zeichengenau 0/1/2', () => {
        expect(selectionScope(0)).toBe('Selektion (0 Zeichen)');
        expect(selectionScope(1)).toBe('Selektion (1 Zeichen)');
        expect(selectionScope(2)).toBe('Selektion (2 Zeichen)');
    });
});

/** F3: catalog source labels fully translated (no hard-coded Cache/Snapshot). */
describe('I3b-fix F3 catalog source labels', () => {
    it('de + en use Cache/Snapshot; fr translates Snapshot', () => {
        __resetI18nForTests();
        seedCatalog(loadCatalog('de'));
        setFormatLocale('de-DE');
        expect(t('settings.ai.catalog.sourceCache')).toBe('Cache');
        expect(t('settings.ai.catalog.sourceSnapshot')).toBe('Snapshot');
        expect(t('settings.ai.models.catalogAge', {
            date: '1. Jan. 2020',
            source: t('settings.ai.catalog.sourceSnapshot'),
        })).toContain('Snapshot');

        __resetI18nForTests();
        seedCatalog(loadCatalog('en'));
        setFormatLocale('en-US');
        expect(t('settings.ai.catalog.sourceCache')).toBe('Cache');
        expect(t('settings.ai.catalog.sourceSnapshot')).toBe('Snapshot');

        __resetI18nForTests();
        seedCatalog(loadCatalog('fr'));
        setFormatLocale('fr-FR');
        expect(t('settings.ai.catalog.sourceCache')).toBe('Cache');
        expect(t('settings.ai.catalog.sourceSnapshot')).toBe('Instantané');
        expect(t('settings.ai.models.catalogAge', {
            date: '1 janv. 2020',
            source: t('settings.ai.catalog.sourceSnapshot'),
        })).toMatch(/Instantané/);
        expect(t('settings.ai.models.catalogAge', {
            date: '1 janv. 2020',
            source: t('settings.ai.catalog.sourceSnapshot'),
        })).not.toMatch(/Snapshot/);
    });
});
