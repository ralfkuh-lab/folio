import { beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock } from '../helpers';
import { isHtmlDocument, prepareHtmlForPreview } from '../../app/view/html';

beforeEach(() => {
    installTauriMock();
});

function parse(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html');
}

describe('view/html', () => {
    it('detects html text documents by language or extension', () => {
        expect(isHtmlDocument('text', 'html', '/tmp/page.txt')).toBe(true);
        expect(isHtmlDocument('text', 'plaintext', '/tmp/page.htm')).toBe(true);
        expect(isHtmlDocument('text', 'json', '/tmp/page.json')).toBe(false);
        expect(isHtmlDocument('markdown', 'html', '/tmp/page.md')).toBe(false);
    });

    it('removes scripts, inline handlers, meta refresh and javascript URLs', () => {
        const out = prepareHtmlForPreview(`
            <html>
              <head><meta http-equiv="refresh" content="0;url=https://example.com"></head>
              <body>
                <button onclick="window.evil = true">Click</button>
                <a href="javascript:alert(1)">bad</a>
                <script>window.evil = true</script>
              </body>
            </html>
        `, '/tmp/page.html');
        const doc = parse(out);

        // Foreign-Scripts/Inline-Handler raus; nur die Folio-Bridge bleibt.
        const scripts = Array.from(doc.querySelectorAll('script'));
        expect(scripts.length).toBe(1);
        expect(scripts[0]!.hasAttribute('data-folio-html-bridge')).toBe(true);
        expect(doc.querySelector('meta[http-equiv]')).toBeNull();
        expect(doc.querySelector('button')!.hasAttribute('onclick')).toBe(false);
        expect(doc.querySelector('a')!.hasAttribute('href')).toBe(false);
    });

    it('injects exactly one folio bridge script', () => {
        const out = prepareHtmlForPreview('<html><body><p>x</p></body></html>', '/tmp/page.html');
        const doc = parse(out);
        const scripts = Array.from(doc.querySelectorAll('script'));
        expect(scripts.length).toBe(1);
        expect(scripts[0]!.getAttribute('data-folio-html-bridge')).toBe('');
        expect(scripts[0]!.textContent).toContain('folio');
        expect(scripts[0]!.textContent).toContain('linkClick');
    });

    it('adds a light preview background before author styles', () => {
        const out = prepareHtmlForPreview(`
            <html>
              <head><style>body { background: #123456; }</style></head>
              <body><h1>Preview</h1></body>
            </html>
        `, '/tmp/page.html');
        const doc = parse(out);
        const defaults = doc.querySelector('style[data-folio-html-preview-defaults]')!;

        expect(defaults.textContent).toContain('background:#fff');
        expect(doc.head.firstElementChild).toBe(defaults);
    });

    it('rewrites relative local resources through Tauri asset conversion', () => {
        const out = prepareHtmlForPreview(`
            <html>
              <head><link rel="stylesheet" href="styles/site.css"></head>
              <body>
                <img src="./images/a.png" srcset="./small.png 1x, /abs/large.png 2x">
                <a href="docs/readme.md" target="_blank">normal link is routed by Folio</a>
                <a href="mailto:test@example.invalid">mail stays native</a>
              </body>
            </html>
        `, '/tmp/site/page.html');
        const doc = parse(out);

        expect(doc.querySelector('link')!.getAttribute('href')).toBe('/tmp/site/styles/site.css');
        expect(doc.querySelector('img')!.getAttribute('src')).toBe('/tmp/site/./images/a.png');
        expect(doc.querySelector('img')!.getAttribute('srcset')).toContain('/tmp/site/./small.png 1x');
        expect(doc.querySelector('img')!.getAttribute('srcset')).toContain('/abs/large.png 2x');
        const routed = doc.querySelector('a[data-folio-href]')!;
        expect(routed.hasAttribute('href')).toBe(false);
        expect(routed.getAttribute('target')).toBeNull();
        expect(routed.getAttribute('data-folio-href')).toBe('docs/readme.md');
        expect(doc.querySelector('a[href^="mailto:"]')).not.toBeNull();
    });
});
