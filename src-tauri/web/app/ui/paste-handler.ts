// Capture-Phase-Paste-Listener fuer den Markdown-Editor.
//
// Strg+V mit `text/html` in der Zwischenablage (Browser, Word, Confluence,
// E-Mail, Folios eigene View) wird ueber `html-to-markdown` konvertiert und
// mit `FolioEditor.pasteText` als ein Undo-Schritt eingefuegt. Enthaelt das
// HTML keine Markdown-Struktur (z.B. Quelltext aus VS Code/Terminals, nur
// `<div>/<span>/<br>`), faellt der Handler durch und Monaco fuegt
// `text/plain` ein — sonst wuerde turndown Markdown-Sonderzeichen escapen.
// Traegt das HTML nur ein einzelnes `img` (Word/Excel legen ein Bild der
// Auswahl daneben), gewinnt der Image-Insert-Dialog.
//
// Strg+Umschalt+V erzwingt reinen Text: der Keydown-Handler setzt ein
// Einmal-Flag, der naechste Paste ueberspringt die HTML-Konvertierung
// (Monaco fuegt `text/plain` ein). Der Bild-Pfad bleibt davon unberuehrt —
// ein Bild-Blob oeffnet weiterhin den Image-Insert-Dialog.
//
// Wir lauschen am Document mit `capture:true`, weil Monacos eigener
// Paste-Handler dieselben Events schluckt, sobald der Fokus im Editor liegt.

import { folioLog } from '../util/log';
import { htmlToMarkdown } from './html-to-markdown';

type Trigger = (blob: Blob) => void;

let trigger: Trigger | null = null;
let attached = false;

// „Reiner Text“-Flag fuer Strg+Umschalt+V: wird vom naechsten Paste
// verbraucht oder verfaellt nach 1000 ms.
const PLAIN_TEXT_TTL_MS = 1000;
let plainTextOnce = false;
let plainTextTimer: ReturnType<typeof setTimeout> | null = null;

function isInEditorScope(target: EventTarget | null): boolean {
    // Split-Mode zaehlt mit: dort ist der Editor sichtbar/editierbar
    // und tb-image aktiv — Strg+V mit Bild soll denselben Dialog oeffnen.
    const editorVisible = document.body.classList.contains('edit-mode')
        || document.body.classList.contains('split-mode');
    if (!editorVisible) return false;
    if (!document.body.classList.contains('kind-markdown')) return false;
    if (!(target instanceof Node)) return true;
    // Editor-Mount + dessen Descendant zaehlen. Wenn der Fokus in der
    // Find-Bar oder im Vault-Tree liegt, ignorieren wir Image-Pastes —
    // sonst stoeren wir Text-Pastes in regulaere <input>-Felder.
    const mount = document.getElementById('editor-mount');
    return !!mount && (mount === target || mount.contains(target as Node));
}

function findImageBlob(data: DataTransfer | null): Blob | null {
    if (!data) return null;
    const items = data.items;
    if (items) {
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
                const file = it.getAsFile();
                if (file) return file;
            }
        }
    }
    if (data.files && data.files.length > 0) {
        for (let i = 0; i < data.files.length; i++) {
            const f = data.files[i];
            if (f.type && f.type.startsWith('image/')) return f;
        }
    }
    return null;
}

/** True, wenn das HTML nur ein einzelnes `img` traegt und sonst keinen Text. */
function isSingleImageOnly(html: string): boolean {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html;
    if (doc.body.querySelectorAll('img').length !== 1) return false;
    const clone = doc.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script,style,meta,link,title,template,noscript')
        .forEach((n) => n.remove());
    const img = clone.querySelector('img');
    if (img) img.remove();
    return (clone.textContent || '').trim() === '';
}

function onKeydown(e: KeyboardEvent): void {
    if (!isInEditorScope(e.target)) return;
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (typeof e.key !== 'string' || e.key.toLowerCase() !== 'v') return;
    plainTextOnce = true;
    if (plainTextTimer !== null) clearTimeout(plainTextTimer);
    plainTextTimer = setTimeout(() => {
        plainTextOnce = false;
        plainTextTimer = null;
    }, PLAIN_TEXT_TTL_MS);
}

function consumePlainTextFlag(): boolean {
    if (!plainTextOnce) return false;
    plainTextOnce = false;
    if (plainTextTimer !== null) {
        clearTimeout(plainTextTimer);
        plainTextTimer = null;
    }
    return true;
}

function onPaste(e: ClipboardEvent): void {
    // Jeder Paste verbraucht das Einmal-Flag — auch ausserhalb des Editors,
    // sonst ueberspringt ein spaeterer Editor-Paste unerwartet das HTML.
    const forcePlainText = consumePlainTextFlag();
    if (!isInEditorScope(e.target)) return;
    const data = e.clipboardData;
    try {
        const html = data && typeof data.getData === 'function'
            ? data.getData('text/html')
            : '';
        if (html && !isSingleImageOnly(html)) {
            // Strg+Umschalt+V: reiner Text — auch dann kein Bild-Dialog, wenn
            // Word/Excel ein Vorschaubild neben das HTML legen.
            if (forcePlainText) return;
            // HTML-Fall: nie in den Bild-Zweig fallen. Jeder Ausgang ausser
            // einem erfolgreichen pasteText laesst Monaco (text/plain) ran.
            const md = htmlToMarkdown(html);
            if (md !== null && window.FolioEditor
                && typeof window.FolioEditor.pasteText === 'function'
                && window.FolioEditor.pasteText(md)) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }
    } catch (err) {
        // Nie Inhalt verlieren: Fehler loggen, Monaco-Default greifen lassen.
        folioLog.warn('paste', 'html paste failed', { error: String(err) });
        return;
    }
    // Kein HTML oder nur ein einzelnes <img>: Bild-Blob → Bild-Dialog.
    if (!trigger) return;
    const blob = findImageBlob(data);
    if (!blob) return; // Text-Paste oder kein Bild — Monaco macht normal weiter.
    e.preventDefault();
    e.stopPropagation();
    trigger(blob);
}

export function attachPasteHandler(onImagePaste: Trigger): void {
    trigger = onImagePaste;
    if (attached) return;
    document.addEventListener('keydown', onKeydown, { capture: true });
    document.addEventListener('paste', onPaste, { capture: true });
    attached = true;
}
