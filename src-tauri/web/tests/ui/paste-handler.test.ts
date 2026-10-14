/** Paste-Handler: HTML→Markdown, Strg+Umschalt+V, Bild-Fallback. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPasteHandler } from '../../app/ui/paste-handler';
import * as convert from '../../app/ui/html-to-markdown';

const H1_HTML = '<h2>Ziele</h2><ul><li><b>Schnell</b></li><li>Klein</li></ul>';
const H1_MD = '## Ziele\n\n- **Schnell**\n- Klein';
const H5_HTML = '<div><span style="color:#f00">**fett**</span><br><span># Titel</span></div>';

function imageBlob(): Blob {
    return new Blob(['png'], { type: 'image/png' });
}

function clipboardData(opts: { html?: string; text?: string; image?: Blob | null }): any {
    const data: any = {
        items: [] as any[],
        files: [] as any[],
        getData: (type: string) => {
            if (type === 'text/html') return opts.html || '';
            if (type === 'text/plain') return opts.text || '';
            return '';
        },
    };
    if (opts.image) {
        data.items.push({ kind: 'file', type: opts.image.type, getAsFile: () => opts.image });
        data.files.push(opts.image);
    }
    return data;
}

function dispatchPaste(target: EventTarget, data: any): Event {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: data });
    target.dispatchEvent(ev);
    return ev;
}

function dispatchPlainTextKeydown(target: EventTarget = document): void {
    target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'V', ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true,
    }));
}

let pasteText: ReturnType<typeof vi.fn>;
let imageTrigger: ReturnType<typeof vi.fn>;
let editorTarget: HTMLElement;

beforeEach(() => {
    document.body.className = 'edit-mode kind-markdown';
    document.body.innerHTML = '<div id="editor-mount"><div id="ed"></div></div><input id="find-input">';
    editorTarget = document.getElementById('ed') as HTMLElement;
    pasteText = vi.fn(() => true);
    imageTrigger = vi.fn();
    (window as any).FolioEditor = { pasteText };
    attachPasteHandler(imageTrigger);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('attachPasteHandler — HTML→Markdown', () => {
    it('P1: text/html wird konvertiert und eingefuegt', () => {
        const ev = dispatchPaste(editorTarget, clipboardData({ html: H1_HTML, text: 'Ziele Schnell Klein' }));
        expect(pasteText).toHaveBeenCalledTimes(1);
        expect(pasteText).toHaveBeenCalledWith(H1_MD);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('P2: Strg+Umschalt+V laesst reinen Text durch, Flag verbraucht', () => {
        dispatchPlainTextKeydown(editorTarget);
        const ev = dispatchPaste(editorTarget, clipboardData({ html: H1_HTML, text: 'Ziele Schnell Klein' }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);

        const again = dispatchPaste(editorTarget, clipboardData({ html: H1_HTML, text: 'Ziele' }));
        expect(pasteText).toHaveBeenCalledTimes(1);
        expect(again.defaultPrevented).toBe(true);
    });

    it('P2c: Strg+Umschalt+V mit HTML plus Vorschaubild (Word) → reiner Text, kein Bild-Dialog', () => {
        dispatchPlainTextKeydown(editorTarget);
        const ev = dispatchPaste(editorTarget, clipboardData({ html: H1_HTML, text: 'Ziele', image: imageBlob() }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(imageTrigger).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);
    });

    it('P2b: Flag verfaellt nach 1000 ms', () => {
        vi.useFakeTimers();
        dispatchPlainTextKeydown(editorTarget);
        vi.advanceTimersByTime(1001);
        const ev = dispatchPaste(editorTarget, clipboardData({ html: H1_HTML, text: 'Ziele' }));
        expect(pasteText).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('P3: pasteText false → nicht abfangen', () => {
        pasteText.mockReturnValue(false);
        const ev = dispatchPaste(editorTarget, clipboardData({ html: H1_HTML }));
        expect(pasteText).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(false);
    });

    it('P4: nur Bild → Image-Trigger', () => {
        dispatchPaste(editorTarget, clipboardData({ image: imageBlob() }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(imageTrigger).toHaveBeenCalledTimes(1);
    });

    it('P5: HTML plus Bild → Text gewinnt', () => {
        dispatchPaste(editorTarget, clipboardData({ html: H1_HTML, image: imageBlob() }));
        expect(pasteText).toHaveBeenCalledWith(H1_MD);
        expect(imageTrigger).not.toHaveBeenCalled();
    });

    it('P6: nur ein <img> plus Bild → Image-Trigger', () => {
        dispatchPaste(editorTarget, clipboardData({
            html: '<img src="file:///x.png">',
            image: imageBlob(),
        }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(imageTrigger).toHaveBeenCalledTimes(1);
    });

    it('P7: HTML ohne Struktur → nichts abfangen', () => {
        const ev = dispatchPaste(editorTarget, clipboardData({ html: H5_HTML, text: '**fett**\n# Titel' }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);
    });

    it('P8: kind-text → nichts', () => {
        document.body.classList.remove('kind-markdown');
        document.body.classList.add('kind-text');
        dispatchPaste(editorTarget, clipboardData({ html: H1_HTML, image: imageBlob() }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(imageTrigger).not.toHaveBeenCalled();
    });

    it('P9: Ziel ausserhalb #editor-mount → nichts', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        dispatchPaste(input, clipboardData({ html: H1_HTML, image: imageBlob() }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(imageTrigger).not.toHaveBeenCalled();
    });

    it('P10: HTML-Fall mit pasteText=false → kein Bild-Dialog, Default bleibt', () => {
        pasteText.mockReturnValue(false);
        const ev = dispatchPaste(editorTarget, clipboardData({
            html: '<b>word</b>', text: 'word', image: imageBlob(),
        }));
        expect(pasteText).toHaveBeenCalledTimes(1);
        expect(imageTrigger).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);
    });

    it('P11: Konvertierungs-Exception → kein Bild-Dialog, Default bleibt', () => {
        vi.spyOn(convert, 'htmlToMarkdown').mockImplementation(() => {
            throw new Error('converter failure');
        });
        const ev = dispatchPaste(editorTarget, clipboardData({
            html: '<b>word</b>', text: 'word', image: imageBlob(),
        }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(imageTrigger).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);
    });

    it('P12: FolioEditor fehlt → kein Bild-Dialog, Default bleibt', () => {
        delete (window as any).FolioEditor;
        const ev = dispatchPaste(editorTarget, clipboardData({
            html: '<b>word</b>', text: 'word', image: imageBlob(),
        }));
        expect(imageTrigger).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);
    });

    it('P13: strukturfreies HTML plus Bild → kein Bild-Dialog, Default bleibt', () => {
        const ev = dispatchPaste(editorTarget, clipboardData({
            html: H5_HTML, text: '**fett**\n# Titel', image: imageBlob(),
        }));
        expect(pasteText).not.toHaveBeenCalled();
        expect(imageTrigger).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);
    });

    it('P14: Flag ausserhalb des Editors verbraucht, spaeterer Editor-Paste konvertiert', () => {
        const findInput = document.getElementById('find-input') as HTMLElement;
        dispatchPlainTextKeydown(findInput);
        dispatchPaste(findInput, clipboardData({ html: H1_HTML, text: 'Ziele' }));
        const ev = dispatchPaste(editorTarget, clipboardData({ html: H1_HTML, text: 'Ziele' }));
        expect(pasteText).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(true);
    });
});
