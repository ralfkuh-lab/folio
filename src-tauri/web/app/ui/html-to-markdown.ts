/* HTML aus der Zwischenablage → sauberes Markdown.
 *
 * Reine Konvertierung (kein DOM-Zugriff ausserhalb eines inerten
 * Dokument-Fragments, keine Ressourcenladung): genutzt vom Paste-Handler
 * fuer Strg+V im Markdown-Editor.
 *
 * Rueckgabe `null` heisst: das HTML traegt keine Markdown-relevante
 * Struktur. VS Code, Terminals und Monaco legen Quelltext als
 * `<div>/<span style>/<br>` ab — wuerde man das konvertieren, escapt
 * turndown Sonderzeichen und zerstoert den eingefuegten Markdown-Text.
 * Dann muss der reine Text (Monaco-Default) gewinnen.
 */

import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

// Elemente, die Markdown-Struktur bedeuten. `p`/`div`/`span`/`br`
// stehen bewusst nicht drin (Quelltext-Träger, siehe Kopfkommentar).
const STRUCTURE_SELECTOR = 'h1,h2,h3,h4,h5,h6,ul,ol,li,table,a[href],'
    + 'strong,b,em,i,code,pre,blockquote,del,s,strike,hr';

// Skript-/Kopf-/Template-Rauschen und Word-Overhead.
const NOISE_SELECTOR = 'script,style,meta,link,title,template,noscript';

let service: TurndownService | null = null;

function getService(): TurndownService {
    if (service) return service;
    const td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        fence: '```',
        bulletListMarker: '-',
        emDelimiter: '*',
        strongDelimiter: '**',
        hr: '---',
        linkStyle: 'inlined',
    });
    td.use(gfm);
    // Eigene Code-Block-Regel. turndown waehlt die Fence-Laenge nur anhand
    // von Backtick-Laeufen am ZEILENANFANG; ein Lauf nach Einrueckung
    // (`  ``` `) schliesst die aeussere Fence sonst vorzeitig. Ausserdem
    // verliert die eingebaute Regel `<pre>` ohne `<code>`-Kind.
    td.addRule('folioFencedCodeBlock', {
        filter: 'pre',
        replacement: (_content: any, node: any) => {
            const codeEl = node.firstChild && node.firstChild.nodeName === 'CODE'
                ? node.firstChild : null;
            const code = (codeEl ? codeEl.textContent : node.textContent) || '';
            const className = (codeEl && codeEl.getAttribute('class')) || '';
            const language = (className.match(/language-(\S+)/) || [null, ''])[1] || '';
            // Fence-Laenge = max(3, laengster Backtick-Lauf irgendwo + 1).
            let fenceSize = 3;
            const runs = code.match(/`{3,}/g) || [];
            for (const run of runs) {
                if (run.length >= fenceSize) fenceSize = run.length + 1;
            }
            const fence = '`'.repeat(fenceSize);
            return '\n\n' + fence + language + '\n'
                + code.replace(/\n$/, '') + '\n' + fence + '\n\n';
        },
    } as any);
    // Eigene listItem-Regel: turndown-Default setzt drei Leerzeichen
    // hinter den Marker (`-   a`) und rueckt den Inhalt um dieselbe
    // Breite ein. Wir wollen `- a` bzw. `1. a` mit EINEM Leerzeichen —
    // der Einzug muss dann zur tatsaechlichen Markerbreite passen
    // (`- ` = 2, `1. ` = 3, `10. ` = 4).
    td.addRule('folioListItem', {
        filter: 'li',
        replacement: (content, node: any, options: any) => {
            let prefix = options.bulletListMarker + ' ';
            const parent = node.parentNode;
            if (parent && parent.nodeName === 'OL') {
                const start = parent.getAttribute('start');
                const index = Array.prototype.indexOf.call(parent.children, node);
                prefix = (start ? Number(start) + index : index + 1) + '. ';
            }
            const isParagraph = /\n$/.test(content);
            content = content.replace(/^\n+|\n+$/g, '') + (isParagraph ? '\n' : '');
            content = content.replace(/\n/gm, '\n' + ' '.repeat(prefix.length));
            return prefix + content + (node.nextSibling ? '\n' : '');
        },
    } as any);
    service = td;
    return td;
}

/** Inertes Dokument fuer Parsen ohne Script-Ausfuehrung/Ressourcenladung. */
function inertRoot(html: string): HTMLElement {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html;
    return doc.body as HTMLElement;
}

/** Entfernt Kommentare, Rauschen und Office-Namespace-Elemente (`o:p`). */
function clean(root: HTMLElement): void {
    root.querySelectorAll(NOISE_SELECTOR).forEach((n) => n.remove());
    // `o:p`, `v:shape`, `w:...` u. a. — unbekannte Elemente mit Doppelpunkt
    // im Namen. SVG-Elemente (svg/path/...) tragen keinen Doppelpunkt.
    root.querySelectorAll('*').forEach((el) => {
        if (el.nodeName.indexOf(':') >= 0) el.remove();
    });
    const comments: Node[] = [];
    const walker = root.ownerDocument.createTreeWalker(root, 128 /* SHOW_COMMENT */);
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((c) => c.parentNode?.removeChild(c));
}

/** `img` mit `data:`-Quelle raus; nicht leeres `alt` bleibt als Text. */
function stripDataImages(root: HTMLElement): void {
    root.querySelectorAll('img').forEach((img) => {
        const src = (img.getAttribute('src') || '').trim();
        if (!/^data:/i.test(src)) return;
        const alt = (img.getAttribute('alt') || '').trim();
        if (alt) {
            img.replaceWith(root.ownerDocument.createTextNode(alt));
        } else {
            img.remove();
        }
    });
}

/** Links ohne sichtbaren Inhalt raus — die Anker-Symbole neben Überschriften
 *  (Hugging Face, GitHub, Doku-Seiten; leer oder nur ein SVG-Icon) würden
 *  sonst als `[](…#anker)` vor jeder Überschrift stehen. Links mit Bild
 *  bleiben. */
function stripEmptyLinks(root: HTMLElement): void {
    root.querySelectorAll('a').forEach((a) => {
        if ((a.textContent || '').trim() === '' && !a.querySelector('img')) a.remove();
    });
}

function hasStructure(root: HTMLElement): boolean {
    if (root.querySelector(STRUCTURE_SELECTOR)) return true;
    for (const img of Array.from(root.querySelectorAll('img'))) {
        const src = (img.getAttribute('src') || '').trim();
        if (src && !/^data:/i.test(src)) return true;
    }
    for (const input of Array.from(root.querySelectorAll('input'))) {
        if ((input.getAttribute('type') || '').toLowerCase() === 'checkbox') return true;
    }
    return false;
}

/** Nachbearbeitung ausserhalb von Code-Fences. Code-Zeilen (zwischen
 *  Oeffner und Schliesser, inklusive beider) werden byte-genau durchgereicht:
 *  turndown waehlt die Fence-Laenge groesser als jeder Backtick-Lauf im Code,
 *  die Erkennung `^\s*`{3,}` trifft daher nur echte Fence-Zeilen. */
function normalize(markdown: string): string {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let fenceLen = 0; // 0 = ausserhalb, sonst Laenge der offenen Fence
    for (const line of lines) {
        const fence = line.match(/^[ \t>]*(`{3,})(.*)$/);
        if (fenceLen > 0) {
            out.push(line); // Code-Zeile unveraendert
            if (fence && fence[1].length >= fenceLen && fence[2].trim() === '') {
                fenceLen = 0;
            }
            continue;
        }
        if (fence) {
            fenceLen = fence[1].length;
            out.push(line);
            continue;
        }
        // Task-Marker: Plugin liefert `[x] ` plus Quell-Whitespace → `[x]  `.
        let l = line.replace(/\[([ xX])\][ \t]{2,}/g, '[$1] ');
        // Reine Leerzeichen-Zeilen (turndown macht aus `<br>` `  \n`) als
        // Leerzeile behandeln, sonst bleibt H13b an den Paar-Leerzeichen haengen.
        if (/^\s*$/.test(l)) l = '';
        if (l === '' && out.length > 0 && out[out.length - 1] === '') continue;
        out.push(l);
    }
    while (out.length > 0 && out[0] === '') out.shift();
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out.join('\n');
}

export function htmlToMarkdown(html: string): string | null {
    if (!html || !html.trim()) return null;
    const root = inertRoot(html);
    clean(root);
    stripDataImages(root);
    stripEmptyLinks(root);
    if (!hasStructure(root)) return null;
    const markdown = normalize(getService().turndown(root as any));
    return markdown.trim() ? markdown : null;
}
