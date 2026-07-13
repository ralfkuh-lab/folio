/**
 * Convention (docs/spec-i18n.md): no t() / tPlural() in module-level
 * initializers. Translated data must be factories/getters evaluated after
 * initI18n().
 *
 * I1c: TypeScript AST walk (replaces the fragile line/brace heuristic).
 * CallExpression of `t` / `tPlural` outside function/class bodies = error.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const APP_ROOT = path.resolve(__dirname, '../../app');
const EDITOR_ROOT = path.resolve(__dirname, '../../editor');

function walkTs(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (ent.name === 'node_modules') continue;
            walkTs(p, out);
        } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
            out.push(p);
        }
    }
    return out;
}

function isFunctionLike(node: ts.Node): boolean {
    return (
        ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node)
        || ts.isConstructorDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node)
    );
}

function isClassLike(node: ts.Node): boolean {
    return ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

/**
 * Find t()/tPlural() CallExpressions that are not nested inside a
 * function-like or class-like body (true module-level).
 */
function findModuleLevelTCalls(fileName: string, src: string): string[] {
    const sf = ts.createSourceFile(
        fileName,
        src,
        ts.ScriptTarget.ES2020,
        /*setParentNodes*/ true,
        ts.ScriptKind.TS,
    );
    const hits: string[] = [];

    function visit(node: ts.Node, insideFnOrClass: boolean): void {
        if (isFunctionLike(node) || isClassLike(node)) {
            // Descend with inside=true so bodies are exempt.
            ts.forEachChild(node, (child) => visit(child, true));
            return;
        }

        if (!insideFnOrClass && ts.isCallExpression(node)) {
            const expr = node.expression;
            if (ts.isIdentifier(expr) && (expr.text === 't' || expr.text === 'tPlural')) {
                const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                const text = node.getText(sf).replace(/\s+/g, ' ');
                hits.push(`L${line + 1}: ${text.slice(0, 80)}`);
            }
        }

        ts.forEachChild(node, (child) => visit(child, insideFnOrClass));
    }

    visit(sf, false);
    return hits;
}

function shouldSkip(filePath: string): boolean {
    // i18n core defines / re-exports t — not call sites of concern
    if (filePath.includes(`${path.sep}i18n${path.sep}translate.ts`)) return true;
    if (filePath.includes(`${path.sep}i18n${path.sep}index.ts`)) return true;
    if (filePath.includes(`${path.sep}i18n${path.sep}apply.ts`)) return true;
    return false;
}

describe('no module-level t()/tPlural() (AST)', () => {
    it('app + editor have no module-level t/tPlural calls', () => {
        const files = [...walkTs(APP_ROOT), ...walkTs(EDITOR_ROOT)];
        const violations: string[] = [];
        for (const f of files) {
            if (shouldSkip(f)) continue;
            const src = fs.readFileSync(f, 'utf8');
            const hits = findModuleLevelTCalls(f, src);
            const rel = path.relative(path.resolve(__dirname, '../..'), f);
            for (const h of hits) {
                violations.push(`${rel}: ${h}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('detects multi-line top-level object initializer (regression)', () => {
        const sample = `
import { t } from './i18n';
export const labels = {
    save: t(
        'menu.file.save'
    ),
};
export function ok() {
    return t('menu.file');
}
`;
        const hits = findModuleLevelTCalls('sample.ts', sample);
        expect(hits.length).toBe(1);
        expect(hits[0]).toMatch(/menu\.file\.save/);
    });
});
