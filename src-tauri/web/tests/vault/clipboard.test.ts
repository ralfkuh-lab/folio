import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
});

async function load() {
    return import('../../app/vault/clipboard');
}

describe('vault/clipboard — Zustandsmaschine', () => {
    it('startet leer', async () => {
        const { getClip } = await load();
        expect(getClip()).toBeNull();
    });

    it('setzt, liest und leert den Clip', async () => {
        const { getClip, setClip, clearClip } = await load();
        setClip('/vault/a.md', 'copy');
        expect(getClip()).toEqual({ path: '/vault/a.md', mode: 'copy' });
        setClip('/vault/b.md', 'cut');
        expect(getClip()).toEqual({ path: '/vault/b.md', mode: 'cut' });
        clearClip();
        expect(getClip()).toBeNull();
    });

    it('normalisiert Backslashes und Trailing-Slashes', async () => {
        const { getClip, setClip } = await load();
        setClip('C:\\vault\\ordner\\', 'copy');
        expect(getClip()?.path).toBe('C:/vault/ordner');
    });
});

describe('vault/clipboard — vault-cut Klasse', () => {
    it('markiert nur den ausgeschnittenen Knoten', async () => {
        document.body.innerHTML = `
            <ul id="vault-tree">
              <li class="node" data-path="/vault/a.md"></li>
              <li class="node" data-path="/vault/b.md"></li>
            </ul>`;
        const { setClip, applyVaultCutMarks, clearClip } = await load();
        setClip('/vault/a.md', 'cut');
        applyVaultCutMarks();
        expect(document.querySelector('[data-path="/vault/a.md"]')!.classList.contains('vault-cut')).toBe(
            true,
        );
        expect(document.querySelector('[data-path="/vault/b.md"]')!.classList.contains('vault-cut')).toBe(
            false,
        );
        setClip('/vault/a.md', 'copy');
        expect(document.querySelector('[data-path="/vault/a.md"]')!.classList.contains('vault-cut')).toBe(
            false,
        );
        setClip('/vault/b.md', 'cut');
        expect(document.querySelector('[data-path="/vault/b.md"]')!.classList.contains('vault-cut')).toBe(
            true,
        );
        clearClip();
        expect(document.querySelectorAll('.vault-cut')).toHaveLength(0);
    });
});

describe('vault/clipboard — Pfad-Migration', () => {
    it('remapClip schreibt Präfix um, clearClipIfUnder leert darunter', async () => {
        const { setClip, getClip, remapClip, clearClipIfUnder } = await load();
        setClip('/vault/notes/a.md', 'cut');
        remapClip('/vault/notes', '/vault/neu');
        expect(getClip()).toEqual({ path: '/vault/neu/a.md', mode: 'cut' });
        clearClipIfUnder('/vault/neu');
        expect(getClip()).toBeNull();
    });
});
