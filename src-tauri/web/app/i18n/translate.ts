/* t / tPlural — semantics match Rust Translator (merged catalog from
   backend: active over en already applied). Missing key → key + one-shot
   console.warn. {count} injected by tPlural; count in args throws. */

import type { CatalogValue, I18nCatalog } from './types';
import { setFormatLocale } from './format';

let catalog: I18nCatalog | null = null;
const warnDedup = new Set<string>();
/** Cache Intl.PluralRules per catalog tag — status bar calls tPlural 3× per keystroke. */
const pluralRulesCache = new Map<string, Intl.PluralRules>();

function warnOnce(key: string, kind: string): void {
    const id = (catalog ? catalog.tag : '?') + '|' + key + '|' + kind;
    if (warnDedup.has(id)) return;
    warnDedup.add(id);
    // eslint-disable-next-line no-console
    console.warn('[folio:i18n]', kind, key);
}

function interpolate(template: string, args: Record<string, string | number> | undefined): string {
    if (!args) return template;
    let out = template;
    for (const name of Object.keys(args)) {
        out = out.split('{' + name + '}').join(String(args[name]));
    }
    return out;
}

function lookup(key: string): CatalogValue | undefined {
    if (!catalog || !catalog.strings) return undefined;
    return catalog.strings[key];
}

/**
 * Seed a catalog without Tauri (jsdom tests). Also used after successful
 * initI18n. Passing null clears the catalog (degradation path).
 */
export function seedCatalog(next: I18nCatalog | null): void {
    catalog = next;
    warnDedup.clear();
    pluralRulesCache.clear();
    if (next && next.locale) {
        setFormatLocale(next.locale);
    }
}

export function getCatalog(): I18nCatalog | null {
    return catalog;
}

export function isI18nReady(): boolean {
    return catalog !== null;
}

export function t(key: string, args?: Record<string, string | number>): string {
    const val = lookup(key);
    if (val === undefined) {
        warnOnce(key, 'missing');
        return interpolate(key, args);
    }
    if (typeof val !== 'string') {
        warnOnce(key, 'plural_as_text');
        return interpolate(key, args);
    }
    return interpolate(val, args);
}

export function tPlural(
    key: string,
    count: number,
    args?: Record<string, string | number>,
): string {
    if (args && Object.prototype.hasOwnProperty.call(args, 'count')) {
        throw new Error('tPlural: args must not override reserved placeholder "count"');
    }
    // Spec: finite non-negative integer only — reject, never clamp/round.
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
        throw new Error(
            'tPlural: count must be a finite non-negative integer, got ' + String(count),
        );
    }

    const val = lookup(key);
    let template: string;
    if (val === undefined) {
        warnOnce(key, 'missing');
        template = key;
    } else if (typeof val === 'string') {
        template = val;
    } else {
        const tag = catalog ? catalog.tag : 'en';
        let cat = 'other';
        try {
            let pr = pluralRulesCache.get(tag);
            if (!pr) {
                pr = new Intl.PluralRules(tag);
                pluralRulesCache.set(tag, pr);
            }
            cat = pr.select(count);
        } catch {
            cat = count === 1 ? 'one' : 'other';
        }
        if (val[cat] !== undefined) {
            template = val[cat];
        } else if (val.other !== undefined) {
            warnOnce(key, 'missing_branch_' + cat);
            template = val.other;
        } else {
            warnOnce(key, 'missing_other');
            template = key;
        }
    }

    const merged: Record<string, string | number> = Object.assign({}, args || {}, {
        count: count,
    });
    return interpolate(template, merged);
}

/**
 * Load catalog via one `i18n_catalog` invoke. Returns true on success.
 * On failure leaves catalog null (degradation: no static apply, t→key).
 */
export async function initI18n(): Promise<boolean> {
    const core = window.__TAURI__ && window.__TAURI__.core;
    const invoke = core && typeof core.invoke === 'function' ? core.invoke : null;
    if (!invoke) {
        // No Tauri (jsdom without seed): degradation.
        seedCatalog(null);
        return false;
    }
    try {
        const resp = await invoke('i18n_catalog');
        if (!resp || typeof resp !== 'object' || !resp.strings) {
            seedCatalog(null);
            return false;
        }
        seedCatalog({
            tag: String(resp.tag || 'en'),
            locale: String(resp.locale || 'en-US'),
            languages: Array.isArray(resp.languages) ? resp.languages : [],
            strings: resp.strings,
        });
        return true;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[folio:i18n] initI18n failed', err);
        seedCatalog(null);
        return false;
    }
}


/** Test-only: clear warn dedup / catalog. */
export function __resetI18nForTests(): void {
    catalog = null;
    warnDedup.clear();
    pluralRulesCache.clear();
    setFormatLocale('en-US');
}
