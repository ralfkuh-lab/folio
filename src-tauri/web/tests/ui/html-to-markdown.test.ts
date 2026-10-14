/** htmlToMarkdown — Referenzfälle aus dem Auftrag. */
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../app/ui/html-to-markdown';

describe('htmlToMarkdown', () => {
    it('H1: H2 + Bulletliste → ATX + `- `-Marker', () => {
        expect(htmlToMarkdown('<h2>Ziele</h2><ul><li><b>Schnell</b></li><li>Klein</li></ul>'))
            .toBe('## Ziele\n\n- **Schnell**\n- Klein');
    });

    it('H2: Absatz mit Inline-Link', () => {
        expect(htmlToMarkdown('<p>Siehe <a href="https://example.com">Doku</a>.</p>'))
            .toBe('Siehe [Doku](https://example.com).');
    });

    it('H3: Tabelle mit th → GFM-Tabelle', () => {
        const md = htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
        expect(md).not.toBeNull();
        const lines = (md as string).split('\n');
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            expect(line.startsWith('|')).toBe(true);
            expect(line.endsWith('|')).toBe(true);
        }
        const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
        expect(cells(lines[0])).toEqual(['A', 'B']);
        for (const cell of cells(lines[1])) expect(cell).toMatch(/^[-:]+$/);
        expect(cells(lines[2])).toEqual(['1', '2']);
    });

    it('H3b: Tabelle ohne th → trotzdem GFM (kein rohes <table>)', () => {
        const md = htmlToMarkdown('<table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table>');
        expect(md).not.toBeNull();
        expect(md).not.toContain('<table');
        const values = (md as string).split('\n')
            .flatMap((line) => line.split('|'))
            .map((c) => c.trim())
            .filter((c) => c && !/^[-:]+$/.test(c));
        expect(values).toContain('x');
        expect(values).toContain('y');
        expect(values).toContain('1');
        expect(values).toContain('2');
    });

    it('H4: Code-Fence mit Sprach-Info', () => {
        expect(htmlToMarkdown('<pre><code class="language-js">const a = 1;</code></pre>'))
            .toBe('```js\nconst a = 1;\n```');
    });

    it('H5: nur div/span/br → null (Quelltext-Träger)', () => {
        expect(htmlToMarkdown('<div><span style="color:#f00">**fett**</span><br><span># Titel</span></div>'))
            .toBeNull();
    });

    it('H6: style/script raus, em bleibt', () => {
        expect(htmlToMarkdown('<style>p{color:red}</style><script>alert(1)</script><p><em>x</em></p>'))
            .toBe('*x*');
    });

    it('H7: data:-Bild raus, alt bleibt, kein base64', () => {
        const md = htmlToMarkdown('<p><img src="data:image/png;base64,AAAA" alt="Logo"><strong>a</strong></p>');
        expect(md).toContain('**a**');
        expect(md).toContain('Logo');
        expect(md).not.toContain('data:');
        expect(md).not.toContain('base64');
    });

    it('H8: Durchgestrichen', () => {
        expect(htmlToMarkdown('<p><del>alt</del> neu</p>')).toBe('~~alt~~ neu');
    });

    it('H9: Task-Liste mit genau einem Leerzeichen', () => {
        expect(htmlToMarkdown(
            '<ul><li><input type="checkbox" checked disabled> fertig</li>'
            + '<li><input type="checkbox" disabled> offen</li></ul>',
        )).toBe('- [x] fertig\n- [ ] offen');
    });

    it('H10: verschachtelte Bulletliste eingerückt', () => {
        expect(htmlToMarkdown('<ul><li>a<ul><li>b</li></ul></li></ul>')).toBe('- a\n  - b');
    });

    it('H11: verschachtelte Liste in geordneter Liste', () => {
        expect(htmlToMarkdown('<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>'))
            .toBe('1. a\n   - b\n2. c');
    });

    it('H12: Blockquote', () => {
        expect(htmlToMarkdown('<blockquote><p>Zitat</p></blockquote>')).toBe('> Zitat');
    });

    it('H13: nur p/b → null; b + br → kollabiert', () => {
        expect(htmlToMarkdown('<p>a</p><p></p><p></p><p>b</p>')).toBeNull();
        expect(htmlToMarkdown('<p><b>a</b></p><br><br><br><p>b</p>')).toBe('**a**\n\nb');
    });

    it('H14: Office-Markup (Kommentar, o:p) wird aufgelöst', () => {
        const html = '<html><head><title>T</title><meta charset="utf-8"></head>'
            + '<body><!--[if gte mso 9]><xml>x</xml><![endif]-->'
            + '<p class="MsoNormal"><b>Wort</b><o:p></o:p></p></body></html>';
        expect(htmlToMarkdown(html)).toBe('**Wort**');
    });

    it('H15: leer/whitespace → null', () => {
        expect(htmlToMarkdown('')).toBeNull();
        expect(htmlToMarkdown('<p>   </p>')).toBeNull();
    });

    it('H16: Mehrfach-Leerzeilen und Whitespace im Code bleiben byte-genau', () => {
        expect(htmlToMarkdown('<pre><code>a\n\n\n\nb   \n  \nc</code></pre>'))
            .toBe('```\na\n\n\n\nb   \n  \nc\n```');
    });

    it('H17: Task-Marker im Code wird nicht umgeschrieben', () => {
        expect(htmlToMarkdown('<pre><code>- [x]   task</code></pre>'))
            .toBe('```\n- [x]   task\n```');
    });

    it('H18: Code-Fence zwischen Absaetzen bleibt intakt', () => {
        expect(htmlToMarkdown(
            '<p><b>x</b></p><pre><code>1\n\n\n2</code></pre><p></p><p></p><p>y</p>',
        )).toBe('**x**\n\n```\n1\n\n\n2\n```\n\ny');
    });
});
