/* Gemeinsame Dateinamen-Helfer fuer die Anlegen-/Umbenennen-Pfade.

   Die Validierung lag frueher dreifach kopiert vor (Anlegen-Dialog,
   Wikilink-Anlegen, Vault-Kontextmenue „Neue Datei"); die Kopie in
   wikilink-create.ts war dabei nur noch von Tests erreichbar. Hier
   liegt sie DOM-frei an einer Stelle, damit alle drei Aufrufer
   dieselbe Regel teilen und die Unit-Tests den produktiven Pfad
   treffen. */

/**
 * True, wenn der Name als Dateiname unbrauchbar ist: leer/whitespace,
 * pfad-qualifiziert (`/` oder `\`) oder Traversal (`.`, `..`, `..`-Anteil).
 */
export function isInvalidFileName(name: string): boolean {
    const trimmed = (name || '').trim();
    if (!trimmed) return true;
    if (/[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
        return true;
    }
    return false;
}

/** Verzeichnis + Dateiname zu einem POSIX-Pfad fuegen (ohne Doppel-Slash). */
export function joinDirFile(dir: string, fileName: string): string {
    return dir.replace(/\/+$/, '') + '/' + fileName.replace(/^\/+/, '');
}
