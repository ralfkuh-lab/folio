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
    });});

describe('isInsideCodeFence — Öffner direkt am Listenmarker (Korrekturrunde T1)', () => {
    it('L1: `- ```` öffnet', () => {
        expect(lastInFence('- ```text /   | a | b |')).toBe(true);
    });
    it('L2: geordneter Marker, Inhalt auf Markerbreite', () => {
        expect(lastInFence('1. ```js /    x')).toBe(true);
    });
    it('L3: Listenmarker im Zitat', () => {
        expect(lastInFence('> - ``` / >   - x')).toBe(true);
    });
    it('L4: verschachtelte Marker', () => {
        expect(lastInFence('- 1. ``` /      x')).toBe(true);
    });
    it('L5: Schließer im Listenpunkt schließt; danach keine Fence', () => {
        expect(lastInFence('- ```js /   code /   ``` / - x')).toBe(false);
    });
    it('L6: weniger eingerückte Zeile beendet Listenpunkt und Fence', () => {
        expect(lastInFence('- ``` /   code / x')).toBe(false);
        expect(lastInFence('- ``` /   code / x / y')).toBe(false);
    });
    it('L7: Leerzeile beendet den Listenpunkt nicht', () => {
        expect(isInsideCodeFence(['- ```', '', '  x'], 2)).toBe(true);
    });
    it('L8: Marker innerhalb einer offenen Fence ist Inhalt, kein Schließer', () => {
        expect(lastInFence('- ``` /   - ``` /   x')).toBe(true);
        expect(lastInFence('``` / - ``` / x')).toBe(true);
    });
    it('L9: Backtick im Info-String → kein Öffner', () => {
        expect(lastInFence('- ```a`b /   x')).toBe(false);
    });
});
