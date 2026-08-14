import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES = resolve(__dirname, '../../../locales');
const NEW_KEYS = [
    'menu.view.gitDiff',
    'tabs.git.ariaLabel',
    'toolbar.gitDiff.ariaLabel',
    'toolbar.gitDiff.tooltip',
    'vault.filter.git.ariaLabel',
    'vault.filter.git.tooltip',
    'vault.git.tooltip.modified',
    'vault.git.tooltip.untracked',
    'vault.tree.expandCapped',
];

describe('i18n keys for git-status accessibility', () => {
    it('adds the new keys to all nine catalogs', () => {
        const files = readdirSync(LOCALES)
            .filter((name) => name.endsWith('.json'))
            .sort();
        expect(files).toHaveLength(9);
        for (const file of files) {
            const raw = JSON.parse(readFileSync(resolve(LOCALES, file), 'utf8')) as Record<
                string,
                unknown
            >;
            for (const key of NEW_KEYS) {
                expect(raw[key], `${file} missing ${key}`).toEqual(expect.any(String));
                expect(String(raw[key]).length).toBeGreaterThan(0);
            }
        }
    });
});
