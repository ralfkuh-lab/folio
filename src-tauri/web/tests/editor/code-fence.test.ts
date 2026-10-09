/** isInsideCodeFence — CommonMark-Fences inkl. Blockquotes (Korrektur 1). */
import { describe, expect, it } from 'vitest';
import { isInsideCodeFence } from '../../editor/wikilink-complete';

/** Zeilen durch ` / ` getrennt; gefragt ist die letzte Zeile. */
function lastInFence(spec: string): boolean {
    const lines = spec.split(' / ');
    return isInsideCodeFence(lines, lines.length - 1);
}

describe('isInsideCodeFence — Referenzfälle Korrektur 1', () => {
    it('1: offene Fence', () => {
        expect(lastInFence('``` / - x')).toBe(true);
    });
    it('2: geschlossene Fence', () => {
        expect(lastInFence('``` / x / ``` / - x')).toBe(false);
    });
    it('3: Fence im Zitat', () => {
        expect(lastInFence('> ``` / > - literal')).toBe(true);
    });
    it('4: geschlossene Fence im Zitat', () => {
        expect(lastInFence('> ``` / > code / > ``` / > - x')).toBe(false);
    });
    it('5: ```not-a-close schließt nicht', () => {
        expect(lastInFence('``` / ```not-a-close / - literal')).toBe(true);
    });
    it('6: Leerraum hinter dem Schließer', () => {
        expect(lastInFence('``` / ```   / - x')).toBe(false);
    });
    it('7: anderes Fence-Zeichen schließt nicht', () => {
        expect(lastInFence('~~~ / ``` / - x')).toBe(true);
    });
    it('8: kürzerer Schließer schließt nicht', () => {
        expect(lastInFence('```` / ``` / - x')).toBe(true);
    });
    it('9: längerer Schließer schließt', () => {
        expect(lastInFence('```` / ````` / - x')).toBe(false);
    });
    it('10: Zitat endet → Fence endet', () => {
        expect(lastInFence('> ``` / > code / - x')).toBe(false);
    });
    it('11: Fence in Listen-Einrückung', () => {
        expect(lastInFence('- item /   ``` /   - x')).toBe(true);
    });
    it('12: verschachteltes Zitat', () => {
        expect(lastInFence('> > ``` / > > - x')).toBe(true);
    });
});
