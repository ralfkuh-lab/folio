import { beforeEach, describe, expect, it } from 'vitest';
import {
    fmtNumber,
    fmtDate,
    fmtBytes,
    compareStrings,
    normalizeForSearch,
    setFormatLocale,
} from '../../app/i18n/format';

describe('i18n format', () => {
    beforeEach(() => {
        setFormatLocale('de-DE');
    });

    it('F7: fmtNumber differs de vs en', () => {
        setFormatLocale('de-DE');
        const de = fmtNumber(1234.5);
        setFormatLocale('en-US');
        const en = fmtNumber(1234.5);
        // de-DE: 1.234,5  — en-US: 1,234.5
        expect(de).toBe('1.234,5');
        expect(en).toBe('1,234.5');
        expect(de).not.toBe(en);
    });

    it('fmtBytes uses 1000-based SI units (KB/MB)', () => {
        expect(fmtBytes(500)).toBe('500 B');
        expect(fmtBytes(2000)).toBe('2 KB');
        // 5_000_000 bytes → 5 MB (matches theme asset limit wording)
        expect(fmtBytes(5_000_000)).toBe('5 MB');
        setFormatLocale('en-US');
        expect(fmtBytes(1500)).toBe('1.5 KB');
    });

    it('F7: fmtDate differs de vs en for fixed UTC date', () => {
        const d = new Date('2020-01-15T12:00:00Z');
        const opts: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
        };
        setFormatLocale('de-DE');
        const de = fmtDate(d, opts);
        setFormatLocale('en-US');
        const en = fmtDate(d, opts);
        expect(de).not.toBe(en);
        // de: Januar / en: January (or numeric month variants — month:long is language-specific)
        expect(de.toLowerCase()).toMatch(/januar|15/);
        expect(en.toLowerCase()).toMatch(/january|15/);
    });

    it('compareStrings is locale-aware ordering', () => {
        expect(compareStrings('a', 'a')).toBe(0);
        expect(compareStrings('a', 'b')).toBeLessThan(0);
    });

    it('normalizeForSearch lowercases', () => {
        expect(normalizeForSearch('Äpfel')).toBe(normalizeForSearch('äpfel'));
    });
});
