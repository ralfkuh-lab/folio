import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';
import {
    clearImageView,
    getImageViewState,
    isImageDocument,
    mountImageView,
    reloadImageView,
} from '../../app/view/image';

function ensureMount(): HTMLElement {
    let mount = document.getElementById('image-view-mount');
    if (!mount) {
        mount = document.createElement('div');
        mount.id = 'image-view-mount';
        document.body.appendChild(mount);
    }
    return mount;
}

beforeEach(async () => {
    installTauriMock();
    await seedDeCatalog();
    // Default-Mock fuer convertFileSrc: einfach den Pfad zurueckgeben.
    (window as any).__TAURI__.core.convertFileSrc = vi.fn((p: string) => 'asset://' + p);
    document.body.innerHTML = '';
});

describe('view/image', () => {
    it('isImageDocument matcht exakt das image-Kind', () => {
        expect(isImageDocument('image')).toBe(true);
        expect(isImageDocument('text')).toBe(false);
        expect(isImageDocument('markdown')).toBe(false);
        expect(isImageDocument('')).toBe(false);
    });

    it('mountImageView fuegt ein <img> mit konvertierter src ein', () => {
        const mount = ensureMount();
        mountImageView('D:/photos/snap.png');
        const img = mount.querySelector('img');
        expect(img).not.toBeNull();
        const src1 = img!.getAttribute('src') || '';
        expect(src1).toMatch(/^asset:\/\/D:\/photos\/snap\.png\?v=\d+$/);
        expect(img!.alt).toBe('D:/photos/snap.png');
        expect(img!.draggable).toBe(false);
        expect(getImageViewState()).toEqual({ path: 'D:/photos/snap.png', lastError: null });
    });

    it('normalisiert Windows-Backslashes vor convertFileSrc', () => {
        const mount = ensureMount();
        const convert = (window as any).__TAURI__.core.convertFileSrc as ReturnType<typeof vi.fn>;
        mountImageView('D:\\photos\\snap.png');
        expect(convert).toHaveBeenCalledWith('D:/photos/snap.png');
        const img = mount.querySelector('img')!;
        const src2 = img.getAttribute('src') || '';
        expect(src2).toMatch(/^asset:\/\/D:\/photos\/snap\.png\?v=\d+$/);
    });

    it('ersetzt das vorherige <img> bei erneutem mount', () => {
        const mount = ensureMount();
        mountImageView('/a.png');
        mountImageView('/b.png');
        const imgs = mount.querySelectorAll('img');
        expect(imgs.length).toBe(1);
        const src3 = imgs[0]!.getAttribute('src') || '';
        expect(src3).toMatch(/^asset:\/\/\/b\.png\?v=\d+$/);
    });

    it('clearImageView entfernt das gerenderte Bild und resettet State', () => {
        const mount = ensureMount();
        mountImageView('/x.png');
        expect(mount.querySelector('img')).not.toBeNull();
        clearImageView();
        expect(mount.querySelector('img')).toBeNull();
        expect(getImageViewState()).toEqual({ path: '', lastError: null });
    });

    it('No-op ohne convertFileSrc — meldet Fehler im State und im DOM', () => {
        delete (window as any).__TAURI__.core.convertFileSrc;
        const mount = ensureMount();
        mountImageView('/photo.png');
        expect(mount.querySelector('img')).toBeNull();
        expect(getImageViewState().lastError).toBe('convertFileSrc nicht verfügbar');
        expect(mount.textContent).toContain('convertFileSrc nicht verfügbar');
    });

    it('leerer Pfad rendert nichts', () => {
        const mount = ensureMount();
        mountImageView('');
        expect(mount.querySelector('img')).toBeNull();
        expect(getImageViewState().path).toBe('');
    });

    it('mountImageView haengt ?v= Cache-Buster an die convertFileSrc-URL an', () => {
        const mount = ensureMount();
        mountImageView('/photos/snap.png');
        const img = mount.querySelector('img')!;
        const src = img.getAttribute('src') || '';
        expect(src).toMatch(/^asset:\/\/\/photos\/snap\.png\?v=\d+$/);
    });

    it('reloadImageView remountet mit neuem Buster-Wert', async () => {
        const mount = ensureMount();
        mountImageView('/a.png');
        const img1 = mount.querySelector('img')!;
        const src1 = img1.getAttribute('src') || '';
        // Kleiner Delay, damit Date.now() einen anderen ms-Wert liefert.
        await new Promise((r) => setTimeout(r, 2));
        // Zweiter Call mit gleichem currentPath
        reloadImageView();
        const img2 = mount.querySelector('img')!;
        const src2 = img2.getAttribute('src') || '';
        expect(src2).toMatch(/^asset:\/\/\/a\.png\?v=\d+$/);
        // Buster-Wert muss sich aendern (neuer Timestamp)
        expect(src2).not.toBe(src1);
        // Pfad im State bleibt erhalten
        expect(getImageViewState().path).toBe('/a.png');
    });
});
