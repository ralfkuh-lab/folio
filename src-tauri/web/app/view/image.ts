/* Bild-Vorschau fuer .png/.jpg/.gif/.webp/.svg/.bmp/.ico/.avif.
   Rendert ein `<img>`-Element in den Container `#image-view-mount`,
   src kommt ueber `convertFileSrc` direkt von Disk — kein Read-Roundtrip
   ins Backend, kein Base64-Embedding. CSS uebernimmt Zentrierung +
   Downscaling auf Container-Groesse (siehe `content.css` →
   `.image-view-mount img`). */

let currentPath = '';
let lastError: string | null = null;

function getConvertFileSrc(): ((path: string) => string) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.convertFileSrc !== 'function') return null;
    return core.convertFileSrc.bind(core);
}

/** Liefert `kind === 'image'` zurueck. Aufrufer entscheiden damit, ob
 *  sie statt Markdown-/Code-/HTML-View die Bild-Surface aktivieren. */
export function isImageDocument(kind: string): boolean {
    return kind === 'image';
}

/** Setzt den Image-Container auf das Bild unter `path`. Beim Setzen
 *  der src wird ein Cache-Buster `?v=<Date.now()>` angehaengt, damit
 *  der Browser das Bild auch bei externer Aenderung (oder Re-Mount
 *  eines inaktiven Tabs) frisch von Disk laedt. */
export function mountImageView(path: string): void {
    const mount = document.getElementById('image-view-mount');
    if (!mount) return;
    currentPath = path || '';
    lastError = null;
    mount.innerHTML = '';
    if (!path) return;
    const convert = getConvertFileSrc();
    if (!convert) {
        lastError = 'convertFileSrc nicht verfuegbar';
        mount.textContent = lastError;
        return;
    }
    let src: string;
    try {
        // Pfad auf Forward-Slashes normalisieren — gleicher Trick wie in
        // `view/html.ts::resolveResourceUrl`, weil convertFileSrc auf
        // Windows mit Backslashes verschluckt wird.
        src = convert(path.replace(/\\/g, '/'));
    } catch (err) {
        lastError = 'convertFileSrc warf: ' + String(err);
        mount.textContent = lastError;
        return;
    }
    // Cache-Buster: jeder mount (inkl. reloadImageView) erzwingt frischen
    // Fetch vom FS. Date.now() reicht; kein mtime-Roundtrip noetig.
    const sep = src.indexOf('?') >= 0 ? '&' : '?';
    src = src + sep + 'v=' + Date.now();
    const img = document.createElement('img');
    img.alt = path;
    img.draggable = false;
    img.onerror = function () {
        lastError = 'Bild konnte nicht geladen werden';
        mount.innerHTML = '';
        mount.textContent = lastError + ' — ' + path;
    };
    img.src = src;
    mount.appendChild(img);
}

/** Laedt das aktuell gemountete Bild neu (remount mit neuem Buster).
 *  Wird vom document:external_changed-Handler fuer kind=image aufgerufen.
 *  Deckt auch Re-Aktivierung inaktiver Tabs ab. */
export function reloadImageView(): void {
    if (currentPath) {
        mountImageView(currentPath);
    }
}

/** Entfernt das gerenderte Bild. Wird beim Wechsel auf ein anderes
 *  Dokument-Kind (Markdown/Text/HTML) bzw. `document:closed` aufgerufen. */
export function clearImageView(): void {
    const mount = document.getElementById('image-view-mount');
    if (mount) mount.innerHTML = '';
    currentPath = '';
    lastError = null;
}

/** Nur fuer Tests/Diagnose: aktueller Pfad und letzter Fehler. */
export function getImageViewState(): { path: string; lastError: string | null } {
    return { path: currentPath, lastError };
}
