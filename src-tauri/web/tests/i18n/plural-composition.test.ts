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
        languages: [{ tag: meta.tag, name: meta.name }],
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
    });

    it('count=1 and 2 select correct branches', () => {
        expect(tPlural('search.status.hitsPart', 1)).toBe('1 résultat');
        expect(tPlural('search.status.hitsPart', 2)).toBe('2 résultats');
        expect(tPlural('search.status.filesPart', 1)).toBe('1 fichier');
        expect(tPlural('search.status.filesPart', 2)).toBe('2 fichiers');
        expect(searchSkipped(1)).toBe(' — 1 gros fichier ignoré');
        expect(searchSkipped(2)).toBe(' — 2 gros fichiers ignorés');
    });
});
