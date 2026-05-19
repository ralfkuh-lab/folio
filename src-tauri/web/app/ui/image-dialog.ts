/* Image-Insert-Dialog: aus Zwischenablage oder Datei waehlen, ggf. ins
   Dokument-Verzeichnis speichern, dann Markdown-Tag an aktueller
   Cursor-Position einfuegen. Pro Dokument wird der letzte Speicherort
   gemerkt (Backend: workspace_set/get_image_dir).

   Quellen:
   - Strg+V im Editor → editor/paste-handler.ts uebergibt File-Blob.
   - tb-image-Klick → versucht navigator.clipboard.read(); wenn dort ein
     Bild liegt, wird es vorausgewaehlt, sonst Default „Datei waehlen".
*/

type Deps = {
    getCurrentPath: () => string | null;
    showStatus: (msg: string) => void;
};

type ClipboardImage = {
    rgbaB64: string;
    width: number;
    height: number;
    dataUrl: string;
};

type FileImageState = {
    sourcePath: string;
    dataUrl: string;
    /** vorgeschlagener Dateiname (Basename ohne Pfad). */
    suggestedName: string;
};

type InsertContext = {
    docPath: string | null;
    docDir: string | null;
    /** Cursor-Position im Editor, eingefroren beim Dialog-Open. */
    cursor: { start: number; length: number };
    /** Text, der bei aktiver Selection beim Open vorbelegt wurde. */
    altDefault: string;
};

let deps: Deps;
let source: 'clipboard' | 'file' = 'file';
let clipboardImage: ClipboardImage | null = null;
let fileImage: FileImageState | null = null;
let linkedFilename = false;
let ctx: InsertContext | null = null;
let lastWarning: string | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

function $(id: string): HTMLElement | null { return document.getElementById(id); }
function $i(id: string): HTMLInputElement | null { return $(id) as HTMLInputElement | null; }

function invoke<T = unknown>(cmd: string, args?: any): Promise<T> {
    return window.__TAURI__.core.invoke(cmd, args) as Promise<T>;
}

function timestampStem(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `image-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function timestampFilename(): string {
    return `${timestampStem()}.png`;
}

function slugify(text: string): string {
    if (!text) return '';
    const map: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue', ß: 'ss' };
    let s = text.trim().toLowerCase();
    s = s.replace(/[äöüÄÖÜß]/g, ch => map[ch] || ch);
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s;
}

function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
    }
    return btoa(s);
}

async function blobToClipboardImage(blob: Blob): Promise<ClipboardImage> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Bild laden fehlgeschlagen'));
        el.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const cctx = canvas.getContext('2d');
    if (!cctx) throw new Error('Canvas-Context nicht verfuegbar');
    cctx.drawImage(img, 0, 0);
    const data = cctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
        rgbaB64: bytesToBase64(new Uint8Array(data.data.buffer)),
        width: canvas.width,
        height: canvas.height,
        dataUrl,
    };
}

async function tryReadNavigatorClipboardImage(): Promise<ClipboardImage | null> {
    const nav: any = navigator;
    if (!nav.clipboard || typeof nav.clipboard.read !== 'function') return null;
    try {
        const items = await nav.clipboard.read();
        for (const it of items) {
            for (const type of it.types as string[]) {
                if (type.startsWith('image/')) {
                    const blob = await it.getType(type);
                    return await blobToClipboardImage(blob);
                }
            }
        }
    } catch {
        /* permission denied, no clipboard, oder kein Bild — fall through */
    }
    return null;
}

function setSource(s: 'clipboard' | 'file'): void {
    source = s;
    const btnClip = $('image-src-clipboard') as HTMLButtonElement | null;
    const btnFile = $('image-src-file') as HTMLButtonElement | null;
    if (btnClip) btnClip.classList.toggle('active', s === 'clipboard');
    if (btnFile) btnFile.classList.toggle('active', s === 'file');
    if (btnClip) btnClip.disabled = !clipboardImage;
    renderPreview();
    updateTagPreview();
    updateInsertEnabled();
}

function renderPreview(): void {
    const preview = $('image-dialog-preview');
    if (!preview) return;
    preview.innerHTML = '';
    let dataUrl: string | null = null;
    if (source === 'clipboard' && clipboardImage) {
        dataUrl = clipboardImage.dataUrl;
    } else if (source === 'file' && fileImage) {
        dataUrl = fileImage.dataUrl;
    }
    if (dataUrl) {
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = '';
        preview.appendChild(img);
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'placeholder';
        placeholder.textContent = source === 'clipboard'
            ? 'Kein Bild in der Zwischenablage.'
            : 'Keine Datei gewählt.';
        preview.appendChild(placeholder);
    }
}

function setLinked(on: boolean, syncNow: boolean = true): void {
    linkedFilename = on;
    const btn = $('image-link-toggle') as HTMLButtonElement | null;
    if (btn) {
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // syncNow=false beim Initial-Open: Toggle ist aktiv, aber Filename
    // bleibt auf dem Timestamp-Default — erst sobald der User den
    // Alt-Text aendert, greift der Sync ueber den input-Listener.
    if (on && syncNow) syncFilenameFromAlt();
}

function syncFilenameFromAlt(): void {
    if (!linkedFilename) return;
    const altInput = $i('image-alt-input');
    const fnInput = $i('image-filename-input');
    if (!altInput || !fnInput) return;
    const slug = slugify(altInput.value);
    fnInput.value = slug ? `${slug}.png` : timestampFilename();
    updateTagPreview();
}

function ensureExtension(name: string, fallback: string): string {
    const trimmed = name.trim();
    if (!trimmed) return fallback;
    if (/\.[a-zA-Z0-9]{2,5}$/.test(trimmed)) return trimmed;
    return `${trimmed}.png`;
}

function defaultExtensionForSource(): string {
    if (source === 'file' && fileImage) {
        const m = fileImage.sourcePath.match(/\.([a-zA-Z0-9]{2,5})$/);
        if (m) return m[1].toLowerCase();
    }
    return 'png';
}

function buildPreviewTag(): { tag: string; relPath: string } {
    const alt = ($i('image-alt-input')?.value || '').trim();
    const dir = ($i('image-dir-input')?.value || '').trim();
    const fn = ensureExtension($i('image-filename-input')?.value || '', `image.${defaultExtensionForSource()}`);
    let relPath = fn;
    if (ctx && ctx.docDir && dir && dir !== ctx.docDir) {
        // Best-effort-Frontend-Approximation: wenn dir mit docDir startet
        // → Suffix nach docDir; sonst dir/fn als absolute Anzeige. Backend
        // berechnet die wahre Relativierung beim Insert.
        const docDir = ctx.docDir.replace(/\\/g, '/');
        const tgtDir = dir.replace(/\\/g, '/');
        if (tgtDir.toLowerCase().startsWith(docDir.toLowerCase() + '/')) {
            const sub = tgtDir.slice(docDir.length + 1);
            relPath = `${sub}/${fn}`;
        } else {
            relPath = `${tgtDir}/${fn}`;
        }
    } else if (source === 'file' && fileImage && !fileImage.sourcePath.startsWith(ctx?.docDir || ' ')) {
        // Datei wird referenziert (nicht kopiert) — Pfad ist source.
        relPath = fileImage.sourcePath.replace(/\\/g, '/');
    }
    return { tag: `![${alt}](${relPath})`, relPath };
}

function updateTagPreview(): void {
    const preview = $('image-tag-preview');
    if (!preview) return;
    preview.textContent = buildPreviewTag().tag;
}

function updateInsertEnabled(): void {
    const btn = $('image-insert') as HTMLButtonElement | null;
    if (!btn) return;
    const hasImage = (source === 'clipboard' && !!clipboardImage)
        || (source === 'file' && !!fileImage);
    const fn = ($i('image-filename-input')?.value || '').trim();
    const dir = ($i('image-dir-input')?.value || '').trim();
    btn.disabled = !hasImage || !fn || !dir;
}

function showWarning(text: string | null): void {
    const el = $('image-warning');
    if (!el) return;
    if (text) {
        el.textContent = text;
        el.hidden = false;
    } else {
        el.textContent = '';
        el.hidden = true;
    }
    lastWarning = text;
}

function bindOnce(): void {
    if ($('image-dialog')?.dataset.bound === '1') return;
    if ($('image-dialog')) $('image-dialog')!.dataset.bound = '1';

    $('image-src-clipboard')?.addEventListener('click', () => setSource('clipboard'));
    $('image-src-file')?.addEventListener('click', async () => {
        const defaultDir = $i('image-dir-input')?.value
            || ctx?.docDir
            || null;
        try {
            const picked = await invoke<string | null>('pick_image_file', { defaultDir });
            if (!picked) return;
            await loadFileImage(picked);
            setSource('file');
        } catch (err) {
            deps.showStatus(typeof err === 'string' ? err : 'Datei-Auswahl fehlgeschlagen');
        }
    });
    $('image-dir-browse')?.addEventListener('click', async () => {
        try {
            const current = $i('image-dir-input')?.value || ctx?.docDir || null;
            const picked = await invoke<string | null>('pick_image_target_dir', { defaultDir: current });
            if (picked) {
                $i('image-dir-input')!.value = picked;
                updateTagPreview();
                updateInsertEnabled();
            }
        } catch (err) {
            deps.showStatus(typeof err === 'string' ? err : 'Verzeichnis-Auswahl fehlgeschlagen');
        }
    });
    $('image-link-toggle')?.addEventListener('click', () => setLinked(!linkedFilename));
    $i('image-alt-input')?.addEventListener('input', () => {
        syncFilenameFromAlt();
        updateTagPreview();
    });
    $i('image-filename-input')?.addEventListener('input', () => {
        // User-Editierung im Filename loest die Link-Bindung
        if (linkedFilename) setLinked(false);
        updateTagPreview();
        updateInsertEnabled();
    });
    $i('image-dir-input')?.addEventListener('input', () => {
        updateTagPreview();
        updateInsertEnabled();
    });
    $('image-cancel')?.addEventListener('click', closeDialog);
    $('image-insert')?.addEventListener('click', doInsert);
}

async function loadFileImage(path: string): Promise<void> {
    // Lokale Datei als data-URL fuer Preview (asset:-Protokoll wuerde
    // gehen, ist aber pfad-restricted; FileReader laesst sich nicht auf
    // einen Path anwenden). Wir nutzen convertFileSrc + fetch.
    const tauri: any = window.__TAURI__;
    let dataUrl = '';
    try {
        const src = tauri?.core?.convertFileSrc
            ? tauri.core.convertFileSrc(path)
            : `file://${path.replace(/\\/g, '/')}`;
        const resp = await fetch(src);
        const blob = await resp.blob();
        dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
        });
    } catch {
        dataUrl = '';
    }
    const base = path.replace(/\\/g, '/').split('/').pop() || path;
    fileImage = { sourcePath: path, dataUrl, suggestedName: base };
}

async function doInsert(): Promise<void> {
    if (!ctx) return;
    const altInput = $i('image-alt-input');
    const fnInput = $i('image-filename-input');
    const dirInput = $i('image-dir-input');
    if (!altInput || !fnInput || !dirInput) return;
    const alt = altInput.value.trim();
    const filename = ensureExtension(fnInput.value, `image.${defaultExtensionForSource()}`);
    const dir = dirInput.value.trim();
    if (!dir) {
        deps.showStatus('Zielordner darf nicht leer sein.');
        return;
    }

    try {
        let result: { absolutePath: string; relativePath: string; finalFilename: string; warning?: string };
        if (source === 'clipboard') {
            if (!clipboardImage) return;
            result = await invoke('save_clipboard_image', {
                args: {
                    rgbaBase64: clipboardImage.rgbaB64,
                    width: clipboardImage.width,
                    height: clipboardImage.height,
                    targetDir: dir,
                    filename,
                    docPath: ctx.docPath,
                },
            });
        } else {
            if (!fileImage) return;
            const sourceDir = fileImage.sourcePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
            const tgtDir = dir.replace(/\\/g, '/');
            const sameDir = sourceDir.toLowerCase() === tgtDir.toLowerCase();
            // Wenn Zielordner = Quellordner und User keinen anderen Namen
            // angegeben hat → keine Kopie; ansonsten kopieren.
            const sameName = filename === fileImage.suggestedName;
            const copy = !(sameDir && sameName);
            result = await invoke('save_file_image', {
                args: {
                    sourcePath: fileImage.sourcePath,
                    targetDir: dir,
                    filename,
                    docPath: ctx.docPath,
                    copy,
                },
            });
        }

        // Markdown-Tag einfuegen
        insertTagAtCursor(`![${alt}](${result.relativePath})`);

        // Per-Doc-Verzeichnis merken
        if (ctx.docPath) {
            await invoke('workspace_set_image_dir', {
                docPath: ctx.docPath,
                dir,
            }).catch(() => { /* persist-Fehler ist nicht blockierend */ });
        }

        if (result.warning) {
            deps.showStatus(result.warning);
        } else {
            deps.showStatus(`Bild eingefügt: ${result.finalFilename}`);
        }
        closeDialog();
    } catch (err) {
        const msg = typeof err === 'string' ? err : 'Bild-Insert fehlgeschlagen';
        deps.showStatus(msg);
        showWarning(msg);
    }
}

function insertTagAtCursor(tag: string): void {
    if (!window.FolioEditor || typeof window.FolioEditor.getText !== 'function') return;
    const text = window.FolioEditor.getText();
    const start = ctx?.cursor.start ?? 0;
    const length = ctx?.cursor.length ?? 0;
    const newText = text.slice(0, start) + tag + text.slice(start + length);
    window.FolioEditor.applyReplace({
        fullText: newText,
        selectionStart: start + tag.length,
        selectionLength: 0,
    });
}

function closeDialog(): void {
    const dlg = $('image-dialog');
    if (dlg) dlg.hidden = true;
    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
    }
    clipboardImage = null;
    fileImage = null;
    ctx = null;
    showWarning(null);
}

export type OpenImageDialogOptions = {
    /** Falls aus Paste-Event vorhandener Blob — wird als Clipboard-Source genutzt. */
    preloadedBlob?: Blob;
};

export async function openImageDialog(opts: OpenImageDialogOptions = {}): Promise<void> {
    bindOnce();
    const dlg = $('image-dialog');
    if (!dlg) return;

    const docPath = deps.getCurrentPath();
    const docDir = await invoke<string | null>('current_document_dir').catch(() => null);

    let cursor = { start: 0, length: 0 };
    let altDefault = '';
    const editor: any = window.FolioEditor;
    if (editor && typeof editor.getSelection === 'function') {
        cursor = editor.getSelection() || { start: 0, length: 0 };
        if (cursor.length > 0 && typeof editor.getText === 'function') {
            const t = editor.getText();
            altDefault = t.slice(cursor.start, cursor.start + cursor.length);
        }
    }
    // Wenn keine Selection: Timestamp-Stem als Default, damit Alt-Text
    // und Filename initial konsistent sind (Alt = "image-20260519-…",
    // Filename = "image-20260519-….png"). Der User kann mit einem Klick
    // auf "Einfuegen" durch oder den Alt-Text sofort drueberschreiben
    // (Input ist selektiert) — der Linked-Toggle zieht den Filename
    // dann mit.
    if (!altDefault) altDefault = timestampStem();
    ctx = { docPath, docDir, cursor, altDefault };

    // Verzeichnis-Default: gemerkter pro-Doc → sonst docDir
    let lastDir: string | null = null;
    if (docPath) {
        lastDir = await invoke<string | null>('workspace_get_image_dir', { docPath })
            .catch(() => null);
    }
    const dirInput = $i('image-dir-input');
    if (dirInput) dirInput.value = lastDir || docDir || '';

    // Alt + Filename. Linked-Toggle ist beim Open AN; syncFilenameFromAlt
    // (ueber setLinked) leitet den Filename aus altDefault ab. Bei einem
    // Timestamp-Stem als altDefault ergibt das exakt die Timestamp-Form
    // im Filename — Alt und Filename sind initial konsistent. Bei einer
    // Selection ergibt der Slug davon den Filename. Der Alt-Input ist
    // selektiert geoeffnet, sodass der User sofort drueberschreiben kann.
    const altInput = $i('image-alt-input');
    if (altInput) altInput.value = altDefault;
    const fnInput = $i('image-filename-input');
    if (fnInput) fnInput.value = timestampFilename();
    setLinked(true);

    // Clipboard versuchen
    clipboardImage = null;
    fileImage = null;
    if (opts.preloadedBlob) {
        try { clipboardImage = await blobToClipboardImage(opts.preloadedBlob); }
        catch (err) { console.warn('Preload-Blob konnte nicht gelesen werden:', err); }
    }
    if (!clipboardImage) {
        clipboardImage = await tryReadNavigatorClipboardImage();
    }

    // Initial-Source: wenn Clipboard verfuegbar → clipboard, sonst file.
    setSource(clipboardImage ? 'clipboard' : 'file');

    dlg.hidden = false;
    showWarning(!docPath
        ? 'Kein Dokument geöffnet — Bild wird mit absolutem Pfad eingefügt.'
        : null);

    keydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeDialog();
        } else if (e.key === 'Enter') {
            const t = e.target as HTMLElement | null;
            // Enter im Alt-/Filename-/Dir-Input loest Insert aus.
            if (t && (t.id === 'image-cancel' || t.tagName === 'BUTTON')) return;
            e.preventDefault();
            const insertBtn = $('image-insert') as HTMLButtonElement | null;
            if (insertBtn && !insertBtn.disabled) doInsert();
        }
    };
    document.addEventListener('keydown', keydownHandler);

    setTimeout(() => {
        altInput?.focus();
        altInput?.select();
    }, 0);
}

export function initImageDialog(d: Deps): void {
    deps = d;
    bindOnce();
}
