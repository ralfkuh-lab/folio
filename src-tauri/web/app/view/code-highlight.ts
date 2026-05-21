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
//
// Logging: pro Block ein `folioLog.trace` (nur sichtbar wenn
// `RUST_LOG=folio=trace` startet UND `window.__folioSetLogLevel('trace')`
// in DevTools aktiviert wird — das Settings-UI bietet `trace` bewusst
// nicht an), bei colorize-Fehler ein `folioLog.warn`. Damit ist der
// "warum ist Block X nicht koloriert?"-Pfad in einer Diagnose-Session
// sofort sichtbar.

import { folioLog } from '../util/log';

const SOURCE_ATTR = 'data-folio-source';

// Aliasse fuer Sprach-IDs in Markdown-Fences. Monaco kennt zwar viele
// Sprachen direkt, aber nicht jede Schreibweise — z. B. `bash` ist bei
// Monaco kein eigener Mode, sondern muss als `shell` adressiert werden.
// Linker Eintrag: Schreibweise im Markdown-Fence; rechter: Monaco-ID.
// Schluessel werden vor dem Lookup auf lowercase normalisiert.
const LANG_ALIASES: Record<string, string> = {
    // Shells — Monaco hat nur "shell".
    bash: 'shell',
    sh: 'shell',
    zsh: 'shell',
    fish: 'shell',
    console: 'shell',
    'shell-session': 'shell',

    // JS-Familie.
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    node: 'javascript',

    // Sonstige populaere Kuerzel.
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    kt: 'kotlin',
    kts: 'kotlin',
    cs: 'csharp',
    'c++': 'cpp',
    'c#': 'csharp',
    hpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'c',
    yml: 'yaml',
    md: 'markdown',
    mdown: 'markdown',
    docker: 'dockerfile',

    // Windows-Welt.
    ps: 'powershell',
    ps1: 'powershell',
    pwsh: 'powershell',
    cmd: 'bat',
    bat: 'bat',
    batch: 'bat',

    // Doc-/Markup-Kram.
    htm: 'html',
    svg: 'xml',
    text: 'plaintext',
    txt: 'plaintext',
    plain: 'plaintext',
    none: 'plaintext',
    gql: 'graphql',
};

function resolveLang(raw: string): string {
    const lower = raw.toLowerCase();
    return LANG_ALIASES[lower] || lower;
}

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
    if (!colorize) {
        folioLog.warn('view', 'highlightCodeBlocks: monaco.editor.colorize nicht verfuegbar');
        return;
    }
    const blocks = root.querySelectorAll('pre > code[class*="language-"]');
    folioLog.trace('view', 'highlightCodeBlocks start', { blocks: blocks.length });
    blocks.forEach((block, index) => {
        const raw = extractLang(block);
        if (!raw) return;
        const lang = resolveLang(raw);
        let source = block.getAttribute(SOURCE_ATTR);
        if (source === null) {
            source = block.textContent || '';
            block.setAttribute(SOURCE_ATTR, source);
        }
        const chars = source.length;
        colorize(source, lang, { tabSize: 4 })
            .then((html) => {
                // colorize() trennt Zeilen mit <br/> — in einem <pre> wuerde
                // das zu Doppel-Newlines fuehren, weil <pre> bereits den
                // Whitespace respektiert. Also <br>-Varianten durch \n
                // ersetzen.
                block.innerHTML = html.replace(/<br\s*\/?>/g, '\n');
                folioLog.trace('view', 'code block colorized', { index, lang, chars });
            })
            .catch((err) => {
                // Unbekannte Sprache oder Tokenizer-Fehler — Block bleibt
                // unkoloriert. Default-CSS rendert ihn trotzdem als <pre>.
                // Den Fail loggen wir auf `warn`, weil "json failed" oft
                // ein echter Bug ist (Race-Condition, Worker-Setup).
                folioLog.warn('view', 'code block colorize failed', {
                    index,
                    rawLang: raw,
                    resolvedLang: lang,
                    chars,
                    error: String(err),
                });
            });
    });
}
