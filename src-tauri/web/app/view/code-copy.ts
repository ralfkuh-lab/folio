// Copy-Button fuer Markdown-View-Code-Bloecke (wie in KI-Web-Chats).
// Pro <pre>-Block ein Button oben rechts, sichtbar bei Hover/Fokus.
// Klick kopiert den Plaintext in die Zwischenablage und zeigt kurz eine
// "Kopiert!"-Bestaetigung (Icon-Wechsel auf Haken).
//
// Source-Text: bevorzugt das von code-highlight.ts bewahrte
// `data-folio-source` (pristiner Plaintext VOR der Tokenisierung), sonst
// `code.textContent`. Gelesen wird am Klick (lazy) — so ist die
// Reihenfolge relativ zu highlightCodeBlocks() egal: der Button haengt am
// <pre> (Sibling des <code>), highlight ersetzt nur `code.innerHTML`,
// beide Schritte stoeren sich also nicht.
//
// Listener: ein einziger delegierter Click-Handler (initCodeCopy, einmal
// beim Boot) statt pro Button — so akkumulieren Re-Renders keine Listener.
// addCodeCopyButtons() ist idempotent (Mark-Attribut auf dem <pre>) und
// wird an denselben Render-Stellen wie highlightCodeBlocks() gerufen.

import { folioLog } from '../util/log';
import { t } from '../i18n/translate';

const SOURCE_ATTR = 'data-folio-source';
const BTN_CLASS = 'code-copy-btn';
const READY_ATTR = 'data-copy-ready';

// Icons im Stil der Toolbar (16er-Viewbox, stroke=currentColor).
const COPY_SVG =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>'
    + '<path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>'
    + '</svg>';
const CHECK_SVG =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<polyline points="3 8.5 6.5 12 13 4.5"/>'
    + '</svg>';

// Revert-Timer pro Button (Icon zurueck auf "kopieren"). WeakMap, damit
// entfernte Buttons (Re-Render) nicht festgehalten werden.
const revertTimers = new WeakMap<Element, number>();

/**
 * Fuegt jedem `pre > code`-Block unterhalb von `root` einen Copy-Button
 * hinzu. Idempotent: bereits markierte `<pre>` werden uebersprungen.
 */
export function addCodeCopyButtons(root: HTMLElement | null): void {
    if (!root) return;
    const pres = root.querySelectorAll('pre');
    let added = 0;
    pres.forEach((pre) => {
        if (pre.getAttribute(READY_ATTR) !== null) return;
        if (!pre.querySelector('code')) return; // nur echte Code-Bloecke
        pre.setAttribute(READY_ATTR, '1');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BTN_CLASS;
        btn.title = t('view.codeCopy.tooltip');
        btn.setAttribute('aria-label', t('view.codeCopy.ariaLabel'));
        btn.innerHTML =
            '<span class="cc-icon cc-copy">' + COPY_SVG + '</span>'
            + '<span class="cc-icon cc-check">' + CHECK_SVG + '</span>';
        pre.appendChild(btn);
        added++;
    });
    if (added > 0) folioLog.debug('view', 'code copy buttons added', { added });
}

function codeSource(pre: HTMLElement): string {
    const code = pre.querySelector('code');
    if (!code) return '';
    const preserved = code.getAttribute(SOURCE_ATTR);
    if (preserved !== null) return preserved;
    return code.textContent || '';
}

async function copyText(text: string): Promise<boolean> {
    const clip = navigator && navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
        try {
            await clip.writeText(text);
            return true;
        } catch (err) {
            folioLog.warn('view', 'clipboard.writeText fehlgeschlagen, execCommand-Fallback', {
                error: String(err),
            });
        }
    }
    // Fallback fuer Kontexte ohne Async-Clipboard-API (alte WebViews):
    // verstecktes Textarea + execCommand('copy').
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
    } catch (err) {
        folioLog.warn('view', 'execCommand-copy-Fallback fehlgeschlagen', { error: String(err) });
        return false;
    }
}

function showFeedback(btn: HTMLElement, ok: boolean): void {
    btn.classList.remove('copied', 'copy-failed');
    btn.classList.add(ok ? 'copied' : 'copy-failed');
    const label = ok ? t('view.codeCopy.copied') : t('view.codeCopy.failed');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    const prev = revertTimers.get(btn);
    if (prev) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
        btn.classList.remove('copied', 'copy-failed');
        btn.title = t('view.codeCopy.tooltip');
        btn.setAttribute('aria-label', t('view.codeCopy.ariaLabel'));
        revertTimers.delete(btn);
    }, 1500);
    revertTimers.set(btn, timer);
}

function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const btn = target.closest('.' + BTN_CLASS) as HTMLElement | null;
    if (!btn) return;
    const pre = btn.closest('pre') as HTMLElement | null;
    if (!pre) return;
    e.preventDefault();
    const source = codeSource(pre);
    copyText(source).then((ok) => {
        showFeedback(btn, ok);
        folioLog.debug('view', 'code block copied', { ok, chars: source.length });
    });
}

let initialized = false;

/** Einmal beim Boot: delegierter Click-Listener fuer alle Copy-Buttons. */
export function initCodeCopy(): void {
    if (initialized) return;
    initialized = true;
    document.addEventListener('click', onClick);
}
