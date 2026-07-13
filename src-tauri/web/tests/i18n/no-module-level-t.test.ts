/**
 * Convention (docs/spec-i18n.md): no t() / tPlural() in module-level
 * initializers. Translated data must be factories/getters evaluated after
 * initI18n(). This scanner is a regression guard for I1b+.
 *
 * Allowed: import { t } from ...; function/method bodies calling t().
 * Forbidden at top level: export const x = t('...'); const rows = [t(...)];
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.resolve(__dirname, '../../app');

function walkTs(dir: string, out: string[] = []): string[] {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkTs(p, out);
        else if (ent.name.endsWith('.ts')) out.push(p);
    }
    return out;
}

/** Strip block/line comments roughly. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

/**
 * Very lightweight heuristic: a t( or tPlural( call whose opening is at
 * the start of a statement line (optional export/const/let/var) and not
 * inside a function — detected by zero open braces before that line in a
 * simplified brace walk. Not a full parser; good enough for convention.
 */
function findModuleLevelTCalls(src: string): string[] {
    const clean = stripComments(src);
    const lines = clean.split('\n');
    let depth = 0;
    const hits: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Count braces roughly (ignore strings — acceptable for guard)
        for (const ch of line) {
            if (ch === '{') depth++;
            else if (ch === '}') depth = Math.max(0, depth - 1);
        }
        if (depth > 0) continue;
        // Skip import lines
        if (/^\s*import\b/.test(line)) continue;
        if (/\btPlural\s*\(/.test(line) || /(?<![.\w])t\s*\(/.test(line)) {
            // Allow type-only or re-exports without call at module level
            // that are just `export { t }` — already excluded (no paren after)
            if (/\b(export\s+)?(const|let|var)\b/.test(line) || /^\s*t\s*\(/.test(line)
                || /^\s*tPlural\s*\(/.test(line)
                || /=\s*t\s*\(/.test(line)
                || /=\s*tPlural\s*\(/.test(line)) {
                hits.push(`L${i + 1}: ${line.trim()}`);
            }
        }
    }
    return hits;
}

describe('no module-level t()/tPlural()', () => {
    it('app/**/*.ts has no module-level t calls', () => {
        const files = walkTs(APP_ROOT);
        const violations: string[] = [];
        for (const f of files) {
            // translate.ts defines t — skip definition file internals
            if (f.endsWith(`${path.sep}i18n${path.sep}translate.ts`)) continue;
            if (f.endsWith(`${path.sep}i18n${path.sep}index.ts`)) continue;
            const src = fs.readFileSync(f, 'utf8');
            const hits = findModuleLevelTCalls(src);
            for (const h of hits) {
                violations.push(`${path.relative(APP_ROOT, f)}: ${h}`);
            }
        }
        expect(violations).toEqual([]);
    });
});
