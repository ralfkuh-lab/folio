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
// Logging: pro Block ein `folioLog.debug` (sichtbar ab logLevel=debug),
// bei colorize-Fehler ein `folioLog.warn`. Per-Block-Granularitaet ist
// fuer typische Markdown-Dateien (<50 Code-Bloecke) unkritisch und der
// Pfad "warum ist Block X nicht koloriert?" wird damit ohne Trace-/
// DevTools-Setup sichtbar.

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

// Monaco liefert JSON-Highlighting nur ueber seinen sprachspezifischen
// Worker (`vs/language/json/jsonWorker.js`). `monaco.editor.colorize()`
// laeuft aber synchron im Hauptthread und kennt nur die einfachen
// Monarch-Tokenizer aus `vs/basic-languages/` — und JSON fehlt dort.
// Folge: alle Tokens fallen auf `mtk1` (Standard-Vordergrund) zurueck,
// der Block sieht ungefaerbt aus, obwohl `colorize` resolved.
// Loesung: eine kompakte Monarch-Definition fuer JSON einmalig
// registrieren. Token-Stems passen zu Monacos vs-/vs-dark-Theme
// (string/number/keyword/delimiter), sodass die `mtk*`-Klassen
// dieselben Farben kriegen wie z.B. shell oder yaml. Andere
// Worker-only-Sprachen (HTML/CSS/TS) haben in `basic-languages/`
// einen Monarch-Fallback und sind nicht betroffen.
let monarchJsonRegistered = false;
function ensureMonarchJson(): void {
    if (monarchJsonRegistered) return;
    const monaco = (window as any).monaco;
    if (!monaco || !monaco.languages || typeof monaco.languages.setMonarchTokensProvider !== 'function') {
        folioLog.warn('view', 'ensureMonarchJson: monaco.languages.setMonarchTokensProvider fehlt');
        return;
    }
    try {
        monaco.languages.setMonarchTokensProvider('json', {
            defaultToken: '',
            tokenPostfix: '.json',
            tokenizer: {
                root: [
                    [/[{}\[\],]/, 'delimiter.bracket.json'],
                    [/:/, 'delimiter'],
                    // Property-Key: String unmittelbar gefolgt von `:`
                    // (mit optionalem Whitespace). Monaco's Monarch
                    // erlaubt Lookahead via `(?=…)`.
                    [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
                    [/"(?:[^"\\]|\\.)*"/, 'string'],
                    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
                    [/\b(?:true|false|null)\b/, 'keyword'],
                    [/\/\/.*$/, 'comment'],
                    [/\s+/, 'white'],
                ],
            },
        });
        monarchJsonRegistered = true;
        folioLog.debug('view', 'Monarch-Tokenizer fuer json registriert');
    } catch (err) {
        folioLog.warn('view', 'Monarch-Registrierung fuer json fehlgeschlagen', {
            error: String(err),
        });
    }
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
    ensureMonarchJson();
    const blocks = root.querySelectorAll('pre > code[class*="language-"]');
    folioLog.debug('view', 'highlightCodeBlocks start', { blocks: blocks.length });
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
                // Stale-Schutz fuer Live-Preview: zwischen Promise-Start und
                // -Resolve kann ein neuer Render den Code-Block ersetzt haben.
                // Den alten Block dann nicht mehr anfassen (waere ein
                // detached-Node-Write, harmless aber verschwendet CPU und
                // koennte mit dem neuen Render-Pass konkurrieren).
                if (!block.isConnected) return;
                // colorize() trennt Zeilen mit <br/> — in einem <pre> wuerde
                // das zu Doppel-Newlines fuehren, weil <pre> bereits den
                // Whitespace respektiert. Also <br>-Varianten durch \n
                // ersetzen.
                block.innerHTML = html.replace(/<br\s*\/?>/g, '\n');
                // Diagnose-Indikator: ein echt tokenisierter Output enthaelt
                // Monacos `mtk*`-Klassen-Spans. Wenn `colorize()` bei kaltem
                // Tokenizer mit Plain-Text-HTML resolved, fehlen die Spans
                // — dann sehen wir das hier statt am Doc-Render-Pfad.
                const tokenSpans = (html.match(/class="mtk/g) || []).length;
                folioLog.debug('view', 'code block colorized', {
                    index, lang, chars, htmlBytes: html.length, tokenSpans,
                });
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
