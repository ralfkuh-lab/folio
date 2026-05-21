import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import {
    clearImageView,
    getImageViewState,
    isImageDocument,
    mountImageView,
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

beforeEach(() => {
    installTauriMock();
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
        expect(img!.getAttribute('src')).toBe('asset://D:/photos/snap.png');
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
        expect(img.getAttribute('src')).toBe('asset://D:/photos/snap.png');
    });

    it('ersetzt das vorherige <img> bei erneutem mount', () => {
        const mount = ensureMount();
        mountImageView('/a.png');
        mountImageView('/b.png');
        const imgs = mount.querySelectorAll('img');
        expect(imgs.length).toBe(1);
        expect(imgs[0]!.getAttribute('src')).toBe('asset:///b.png');
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
        expect(getImageViewState().lastError).toBe('convertFileSrc nicht verfuegbar');
        expect(mount.textContent).toContain('convertFileSrc nicht verfuegbar');
    });

    it('leerer Pfad rendert nichts', () => {
        const mount = ensureMount();
        mountImageView('');
        expect(mount.querySelector('img')).toBeNull();
        expect(getImageViewState().path).toBe('');
    });
});
