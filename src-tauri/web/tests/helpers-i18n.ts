/** Seed the real de/en catalog into the in-memory i18n module (jsdom tests).
 *
 * IMPORTANT: after `vi.resetModules()`, call this with `await` so it loads the
 * *current* translate module instance (static imports would seed a stale one).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { I18nCatalog } from '../app/i18n/types';

export function loadLocaleCatalog(tag: 'de' | 'en' | 'fr'): I18nCatalog {
    // fr: src-tauri/tests/fixtures/locales/fr.json (from web/tests → ../../tests/…)
    const path =
        tag === 'fr'
            ? resolve(__dirname, '../../tests/fixtures/locales/fr.json')
            : resolve(__dirname, `../../locales/${tag}.json`);
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

/** Reset + seed German catalog (default for E2E-parity unit tests). */
export async function seedDeCatalog(): Promise<void> {
    const { seedCatalog, __resetI18nForTests } = await import('../app/i18n/translate');
    __resetI18nForTests();
    seedCatalog(loadLocaleCatalog('de'));
}
