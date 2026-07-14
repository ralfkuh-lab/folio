// Tests fuer view/code-copy.ts — der Copy-Button auf Markdown-View-
// Code-Bloecken. Geprueft:
// - addCodeCopyButtons fuegt pro <pre><code> genau einen Button ein und
//   ist idempotent (kein Doppelbutton bei Re-Aufruf).
// - <pre> ohne <code> bekommt keinen Button.
// - Klick kopiert bevorzugt data-folio-source (pristiner Plaintext),
//   sonst code.textContent, via navigator.clipboard.writeText.
// - Erfolgs-Feedback (.copied) erscheint und revertiert nach 1500 ms.
// - Clipboard-Fehler → .copy-failed (execCommand-Fallback ebenfalls weg).

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { seedDeCatalog } from '../helpers-i18n';

type CodeCopy = typeof import('../../app/view/code-copy');

function buildBlock(opts: { lang?: boolean; source?: string; text: string; withCode?: boolean }): HTMLElement {
    const body = document.createElement('main');
    body.className = 'markdown-body';
    const pre = document.createElement('pre');
    if (opts.withCode === false) {
        pre.textContent = opts.text;
    } else {
        const code = document.createElement('code');
        if (opts.lang) code.className = 'language-js';
        if (opts.source !== undefined) code.setAttribute('data-folio-source', opts.source);
        code.textContent = opts.text;
        pre.appendChild(code);
    }
    body.appendChild(pre);
    document.body.appendChild(body);
    return body;
}

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('view/code-copy', () => {
    let mod: CodeCopy;
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        document.body.innerHTML = '';
        await seedDeCatalog();
        writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });
        mod = await import('../../app/view/code-copy');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fuegt pro pre>code einen Button ein und ist idempotent', () => {
        const body = buildBlock({ text: 'echo hi' });
        mod.addCodeCopyButtons(body);
        expect(body.querySelectorAll('.code-copy-btn').length).toBe(1);
        // Re-Aufruf (z. B. Theme-Re-Highlight) darf nicht doppeln.
        mod.addCodeCopyButtons(body);
        expect(body.querySelectorAll('.code-copy-btn').length).toBe(1);
    });

    it('ignoriert pre ohne code', () => {
        const body = buildBlock({ text: 'kein code', withCode: false });
        mod.addCodeCopyButtons(body);
        expect(body.querySelectorAll('.code-copy-btn').length).toBe(0);
    });

    it('kopiert data-folio-source bevorzugt, sonst textContent', async () => {
        // data-folio-source weicht bewusst vom (tokenisierten) textContent ab.
        const body = buildBlock({ lang: true, source: 'PRISTINE\nSRC', text: 'TOKENIZED' });
        mod.addCodeCopyButtons(body);
        mod.initCodeCopy();
        const btn = body.querySelector('.code-copy-btn') as HTMLElement;
        btn.click();
        await flushMicrotasks();
        expect(writeText).toHaveBeenCalledWith('PRISTINE\nSRC');
    });

    it('faellt auf code.textContent zurueck, wenn kein data-folio-source da ist', async () => {
        const body = buildBlock({ text: 'plain block' });
        mod.addCodeCopyButtons(body);
        mod.initCodeCopy();
        (body.querySelector('.code-copy-btn') as HTMLElement).click();
        await flushMicrotasks();
        expect(writeText).toHaveBeenCalledWith('plain block');
    });

    it('zeigt copied-Feedback und revertiert nach 1500 ms', async () => {
        const body = buildBlock({ text: 'x' });
        mod.addCodeCopyButtons(body);
        mod.initCodeCopy();
        const btn = body.querySelector('.code-copy-btn') as HTMLElement;
        btn.click();
        await flushMicrotasks();
        expect(btn.classList.contains('copied')).toBe(true);
        expect(btn.getAttribute('aria-label')).toBe('Kopiert!');
        vi.advanceTimersByTime(1500);
        expect(btn.classList.contains('copied')).toBe(false);
        expect(btn.getAttribute('aria-label')).toBe('Code kopieren');
    });

    it('markiert copy-failed, wenn Clipboard und Fallback scheitern', async () => {
        writeText.mockRejectedValue(new Error('denied'));
        // execCommand-Fallback ebenfalls auf false zwingen.
        (document as any).execCommand = vi.fn().mockReturnValue(false);
        const body = buildBlock({ text: 'x' });
        mod.addCodeCopyButtons(body);
        mod.initCodeCopy();
        const btn = body.querySelector('.code-copy-btn') as HTMLElement;
        btn.click();
        await flushMicrotasks();
        expect(btn.classList.contains('copy-failed')).toBe(true);
        expect(writeText).toHaveBeenCalled();
    });
});
