/* Locale-aware formatting helpers. All use the catalog formatLocale
   (from initI18n / seedCatalog). */

let formatLocale = 'en-US';
let collator: Intl.Collator | null = null;

export function setFormatLocale(locale: string): void {
    formatLocale = locale || 'en-US';
    collator = null;
}

export function getFormatLocale(): string {
    return formatLocale;
}

export function fmtNumber(value: number, options?: Intl.NumberFormatOptions): string {
    try {
        return new Intl.NumberFormat(formatLocale, options).format(value);
    } catch {
        return String(value);
    }
}

export function fmtDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
    const d = value instanceof Date ? value : new Date(value);
    try {
        return new Intl.DateTimeFormat(formatLocale, options).format(d);
    } catch {
        return String(value);
    }
}

/** Human-readable byte size (1000-based, SI labels), locale-aware number. */
export function fmtBytes(bytes: number): string {
    if (!isFinite(bytes) || bytes < 0) return fmtNumber(0) + ' B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1000 && i < units.length - 1) {
        n /= 1000;
        i++;
    }
    const opts: Intl.NumberFormatOptions =
        i === 0 ? { maximumFractionDigits: 0 } : { maximumFractionDigits: 1 };
    return fmtNumber(n, opts) + ' ' + units[i];
}

function getCollator(): Intl.Collator {
    if (!collator) {
        try {
            collator = new Intl.Collator(formatLocale, { sensitivity: 'base' });
        } catch {
            collator = new Intl.Collator('en', { sensitivity: 'base' });
        }
    }
    return collator;
}

export function compareStrings(a: string, b: string): number {
    return getCollator().compare(a, b);
}

/** Locale-aware lowercasing for search (primary subtag of formatLocale). */
export function normalizeForSearch(text: string): string {
    if (typeof text !== 'string') return '';
    try {
        return text.toLocaleLowerCase(formatLocale);
    } catch {
        return text.toLowerCase();
    }
}
