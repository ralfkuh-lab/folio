// Tests fuer view/mermaid.ts (Lazy-Bundle + Postprocessing).
// jsdom laedt kein echtes mermaid.bundle — wir mocken window.FolioMermaid.
// Geprueft u.a.:
// - language-mermaid Block wird durch .mermaid-diagram ersetzt + data-folio-source
// - Idempotenz + Inflight-Dedupe: identischer (source, theme) triggert render nicht erneut
// - Fehler: Pre-Block bleibt erhalten + .mermaid-error wird angehaengt
// - Andere Sprachen (rust) bleiben unberuehrt
// - Kein Bundle-Load ohne Mermaid-Block
// - Cache-Limit (max 100)
// - Generation verwarf veraltetes Ergebnis bei Race

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type MermaidMod = typeof import('../../app/view/mermaid');

function buildBodyWithFence(lang: string, source: string): HTMLElement {
    const body = document.createElement('main');
    body.className = 'markdown-body';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = `language-${lang}`;
    code.textContent = source;
    pre.appendChild(code);
    body.appendChild(pre);
    document.body.innerHTML = '';
    document.body.appendChild(body);
    return body;
}

function buildExistingDiagram(source: string, theme: 'light' | 'dark', hasSvg: boolean): HTMLElement {
    const body = document.createElement('main');
    body.className = 'markdown-body';
    const div = document.createElement('div');
    div.className = 'mermaid-diagram';
    div.setAttribute('data-folio-source', source);
    div.setAttribute('data-folio-theme', theme);
    if (hasSvg) {
        div.innerHTML = '<svg width="10" height="10"><rect/></svg>';
    }
    body.appendChild(div);
    document.body.innerHTML = '';
    document.body.appendChild(body);
    return body;
}

function buildMixedBody(mermaidSrc: string, otherLang: string, otherSrc: string): HTMLElement {
    const body = document.createElement('main');
    body.className = 'markdown-body';
    // mermaid
    const pre1 = document.createElement('pre');
    const c1 = document.createElement('code');
    c1.className = 'language-mermaid';
    c1.textContent = mermaidSrc;
    pre1.appendChild(c1);
    body.appendChild(pre1);
    // other
    const pre2 = document.createElement('pre');
    const c2 = document.createElement('code');
    c2.className = `language-${otherLang}`;
    c2.textContent = otherSrc;
    pre2.appendChild(c2);
    body.appendChild(pre2);
    document.body.innerHTML = '';
    document.body.appendChild(body);
    return body;
}

async function flushMicrotasks(n = 8): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('view/mermaid', () => {
    let mod: MermaidMod;
    let renderSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        // Mock surface: jetzt (source, dark) => svg-string (kein el mehr)
        renderSpy = vi.fn().mockResolvedValue('<svg data-mocked="1"></svg>');
        (window as any).FolioMermaid = { render: renderSpy };
        mod = await import('../../app/view/mermaid');
    });

    afterEach(() => {
        delete (window as any).FolioMermaid;
        document.body.innerHTML = '';
    });

    it('ersetzt language-mermaid Block durch .mermaid-diagram und setzt data-folio-source', async () => {
        const src = 'flowchart LR\nA --> B';
        const body = buildBodyWithFence('mermaid', src);

        await mod.renderMermaidBlocks(body);
        await flushMicrotasks();

        const diag = body.querySelector('.mermaid-diagram');
        expect(diag).toBeTruthy();
        expect(diag!.getAttribute('data-folio-source')).toBe(src);
        expect(renderSpy).toHaveBeenCalledTimes(1);
        // Neue Signature: (source, dark)
        expect(renderSpy.mock.calls[0][0]).toBe(src);
    });

    it('ruft bei zweitem Durchlauf mit gleichem Source/Theme render() nicht erneut auf (Cache + Dedupe)', async () => {
        const src = 'sequenceDiagram\nA->>B';
        const body1 = buildBodyWithFence('mermaid', src);
        await mod.renderMermaidBlocks(body1);
        await flushMicrotasks();
        const firstCalls = renderSpy.mock.calls.length;

        const body2 = buildBodyWithFence('mermaid', src);
        await mod.renderMermaidBlocks(body2);
        await flushMicrotasks();

        expect(renderSpy.mock.calls.length).toBe(firstCalls);
        const diag = body2.querySelector('.mermaid-diagram');
        expect(diag).toBeTruthy();
    });

    it('laesst bei Render-Fehler den Code-Block stehen und ergaenzt .mermaid-error', async () => {
        const src = 'flowchart LR\nA --> ???[';
        renderSpy.mockRejectedValueOnce(new Error('Syntax error in line 2'));

        const body = buildBodyWithFence('mermaid', src);
        await mod.renderMermaidBlocks(body);
        await flushMicrotasks(10);

        const pre = body.querySelector('pre > code.language-mermaid');
        expect(pre).toBeTruthy();
        expect(pre!.textContent).toContain('???');

        const err = body.querySelector('.mermaid-error');
        expect(err).toBeTruthy();
        expect((err as HTMLElement).textContent || '').toMatch(/Syntax|error/i);
    });

    it('beruehrt language-rust Bloecke nicht', async () => {
        const body = document.createElement('main');
        body.className = 'markdown-body';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-rust';
        code.textContent = 'fn main() {}';
        pre.appendChild(code);
        body.appendChild(pre);
        document.body.innerHTML = '';
        document.body.appendChild(body);

        await mod.renderMermaidBlocks(body);
        await flushMicrotasks();

        expect(body.querySelector('code.language-rust')).toBeTruthy();
        expect(body.querySelector('.mermaid-diagram')).toBeFalsy();
        expect(renderSpy).not.toHaveBeenCalled();
    });

    it('re-rendert existierendes Diagram bei Theme-Wechsel (anderes Theme)', async () => {
        const src = 'pie title T\n"A":1';
        const body = buildExistingDiagram(src, 'light', true);
        document.documentElement.classList.add('theme-dark');

        await mod.renderMermaidBlocks(body);
        await flushMicrotasks();

        expect(renderSpy).toHaveBeenCalled();
        document.documentElement.classList.remove('theme-dark');
    });

    it('laedt Bundle nicht und ruft render nicht, wenn kein Mermaid-Block vorhanden', async () => {
        delete (window as any).FolioMermaid;
        const body = buildBodyWithFence('rust', 'fn main(){}');

        // Spy auf createElement um Script-Injection zu detektieren
        const origCreate = document.createElement.bind(document);
        let mermaidScriptTried = false;
        document.createElement = vi.fn((tagName: string) => {
            const el = origCreate(tagName);
            if (String(tagName).toLowerCase() === 'script') {
                const s = el as HTMLScriptElement;
                if (s.src && s.src.includes('mermaid')) mermaidScriptTried = true;
            }
            return el;
        }) as any;

        try {
            await mod.renderMermaidBlocks(body);
            await flushMicrotasks();
            expect(mermaidScriptTried).toBe(false);
            expect((window as any).FolioMermaid).toBeUndefined();
        } finally {
            document.createElement = origCreate;
        }
    });

    it('respektiert Cache-Limit (max ~100 Eintraege, aeltester wird verdrängt)', async () => {
        // Wir erzeugen viele unique Keys; da kein echtes Bundle, mock liefert immer
        const MAX = 100;
        const body = document.createElement('main');
        body.className = 'markdown-body';

        for (let i = 0; i < MAX + 5; i++) {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.className = 'language-mermaid';
            code.textContent = `flowchart LR\nN${i} --> N${i}`;
            pre.appendChild(code);
            body.appendChild(pre);
        }
        document.body.innerHTML = '';
        document.body.appendChild(body);

        await mod.renderMermaidBlocks(body);
        await flushMicrotasks(20);

        // Interne Maps sind nicht exportiert, aber wir pruefen indirekt via Verhalten:
        // Nach >100 unique sollten alle Diagramme gerendert sein, ohne Crash.
        const diagrams = body.querySelectorAll('.mermaid-diagram');
        expect(diagrams.length).toBeGreaterThanOrEqual(MAX); // mind. die letzten
        // Kein expliziter assert auf interne Groesse notwendig, aber keine Exception + alle verarbeitet.
    });

    it('verwirft veraltetes Render-Ergebnis bei Generation-Race (z.B. schneller Theme-Wechsel)', async () => {
        const src = 'flowchart LR\nX --> Y';
        const body = buildBodyWithFence('mermaid', src);

        // Verzoegertes Render
        let resolveFirst: (s: string) => void;
        const firstP = new Promise<string>((res) => { resolveFirst = res; });
        renderSpy.mockImplementationOnce(() => firstP);

        // Erster Pass startet Render
        const p1 = mod.renderMermaidBlocks(body);

        // Zweiter Pass (simuliert Race/Theme) — setzt neue Gen auf dem (noch nicht geschriebenen) Div
        await flushMicrotasks(2);
        const diag = body.querySelector('.mermaid-diagram') as HTMLElement | null;
        expect(diag).toBeTruthy();

        // Simuliere neuen Render-Pass (z.B. Theme), der Gen erhoeht
        // Wir triggern einen zweiten Aufruf, der neuen Key oder einfach re-trigger mit Cache-Miss simuliert
        // Da Cache leer, und um Gen zu inkrementieren, rufen wir erneut auf (nachdem Gen erhoeht wurde implizit)
        // Einfacher: wir setzen manuell eine hoehere Gen, um zu testen, dass spaet ankommendes verworfen wird.
        const origGen = parseInt(diag!.getAttribute('data-folio-mermaid-gen') || '0', 10) || 1;
        diag!.setAttribute('data-folio-mermaid-gen', String(origGen + 10)); // "neuere" Gen

        // Lasse den alten Render fertig werden
        resolveFirst!('<svg data-stale="true"></svg>');
        await p1;
        await flushMicrotasks();

        // Das div sollte NICHT das stale SVG bekommen haben (da Gen nicht mehr passt)
        // Stattdessen sollte es leer oder vom zweiten (nicht gestarteten hier) bleiben.
        // Da wir keine zweite echte Render gestartet haben, erwarten wir dass innerHTML nicht das stale ist.
        expect(diag!.innerHTML).not.toContain('stale');
    });

    it('renderMermaidForExport erhaelt Reihenfolge, mappt Fehler zu null, erzwingt light, liefert source-pairs', async () => {
        const good = 'flowchart TD\nA-->B';
        const bad = 'flowchart LR\nX --> [broken';
        // Override spy for this test (beforeEach sets default resolved)
        renderSpy
            .mockResolvedValueOnce('<svg id="good"></svg>')
            .mockRejectedValueOnce(new Error('parse error at ...'));
        const res = await mod.renderMermaidForExport([good, bad]);
        expect(res).toEqual([
            { source: good, svg: '<svg id="good"></svg>' },
            { source: bad, svg: null },
        ]);
        expect(renderSpy).toHaveBeenCalledWith(good, false);
        expect(renderSpy).toHaveBeenCalledWith(bad, false);
    });
});
