// Syntax-Highlighting fuer Markdown-Code-Bloecke in der View-Region.
// Nutzt `monaco.editor.colorize(text, lang, options)` — Monaco ist
// ohnehin im Bundle (Edit-Editor + Code-View teilen denselben AMD-Loader),
// also keine zusaetzliche Dep (highlight.js, Prism o. ae.) noetig.
//
// Comrak rendert fenced Code-Bloecke als `<pre><code class="language-xyz">…</code></pre>`.
// Wir extrahieren `xyz`, schicken den Plaintext durch colorize() und ersetzen
// den Inhalt durch das tokenisierte HTML. Theme-Wechsel triggern ein
// Re-Highlight; weil colorize() das jeweils aktive Monaco-Theme nutzt,
// matchen die Token-Farben automatisch zum Editor-Theme.
//
// Re-Highlight-Idempotenz: das Original-Plaintext wird beim ersten Pass
// im `data-source`-Attribut bewahrt — sonst wuerde der zweite Pass das
// bereits HTML-tokenisierte Markup ein zweites Mal tokenisieren und
// alles zerstoeren.

const SOURCE_ATTR = 'data-folio-source';

function extractLang(codeEl: Element): string | null {
    const match = codeEl.className.match(/(?:^|\s)language-(\S+)/);
    return match ? match[1] : null;
}

function getMonacoColorize(): ((text: string, lang: string, opts?: any) => Promise<string>) | null {
    const monaco = (window as any).monaco;
    if (!monaco || !monaco.editor || typeof monaco.editor.colorize !== 'function') {
        return null;
    }
    return monaco.editor.colorize.bind(monaco.editor);
}

/**
 * Highlightet alle `pre > code[class*="language-…"]`-Bloecke unterhalb von
 * `root`. Bei Re-Aufrufen (z. B. nach Theme-Wechsel) wird der bewahrte
 * Plaintext aus `data-folio-source` verwendet, damit der zweite Pass
 * nicht das bereits tokenisierte HTML weiter-tokenisiert.
 */
export function highlightCodeBlocks(root: HTMLElement | null): void {
    if (!root) return;
    const colorize = getMonacoColorize();
    if (!colorize) return;
    const blocks = root.querySelectorAll('pre > code[class*="language-"]');
    blocks.forEach((block) => {
        const lang = extractLang(block);
        if (!lang) return;
        let source = block.getAttribute(SOURCE_ATTR);
        if (source === null) {
            source = block.textContent || '';
            block.setAttribute(SOURCE_ATTR, source);
        }
        colorize(source, lang, { tabSize: 4 })
            .then((html) => {
                // colorize() trennt Zeilen mit <br/> — in einem <pre> wuerde
                // das zu Doppel-Newlines fuehren, weil <pre> bereits den
                // Whitespace respektiert. Also <br>-Varianten durch \n
                // ersetzen.
                block.innerHTML = html.replace(/<br\s*\/?>/g, '\n');
            })
            .catch(() => {
                /* Unbekannte Sprache oder Tokenizer-Fehler — Block bleibt
                   unkoloriert. Default-CSS rendert ihn trotzdem als <pre>. */
            });
    });
}
