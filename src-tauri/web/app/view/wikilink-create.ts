/* folio-new:-Klick → „Notiz anlegen?"-Dialog → create_file → openDocument.

   Reine Parsing-Helfer sind exportiert fuer Unit-Tests (decodeURI, .md-
   Default, Verzeichnis aus getCurrentPath). Der Dialog bleibt bei
   create_file-Fehlern offen und zeigt den Fehlertext. */

import { getCurrentPath, openDocument } from '../state/document';
import { showCreateNoteDialog } from '../ui/dialogs';
import { folioLog } from '../util/log';

export const FOLIO_NEW_SCHEME = 'folio-new:';

/** True, wenn href das Missing-Wikilink-Schema ist. */
export function isFolioNewHref(href: string): boolean {
    return typeof href === 'string' && href.startsWith(FOLIO_NEW_SCHEME);
}

/**
 * Extrahiert und dekodiert den Notiznamen aus `folio-new:<urlencoded>`.
 * Bei kaputtem %-Encoding: roher Rest (kein throw).
 */
export function parseFolioNewName(href: string): string {
    if (!isFolioNewHref(href)) return '';
    const raw = href.slice(FOLIO_NEW_SCHEME.length);
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/** Stellt sicher, dass der Dateiname auf `.md` endet (case-insensitive). */
export function ensureMdExtension(name: string): string {
    const trimmed = (name || '').trim();
    if (!trimmed) return 'untitled.md';
    if (/\.md$/i.test(trimmed)) return trimmed;
    return trimmed + '.md';
}

/** Verzeichnis des Dokumentpfads (POSIX-Slashes), oder null. */
export function documentDirectory(docPath: string | null | undefined): string | null {
    if (!docPath) return null;
    const norm = String(docPath).replace(/\\/g, '/');
    const i = norm.lastIndexOf('/');
    if (i < 0) return null;
    return norm.slice(0, i);
}

/**
 * Vorbefüllung des Anlegen-Dialogs: bei pfad-qualifiziertem Namen
 * (`Ordner/Name`) nur die **letzte** Pfadkomponente (Obsidian legt flach an).
 */
export function initialNameFromWikilink(name: string): string {
    const trimmed = (name || '').trim().replace(/\\/g, '/');
    const parts = trimmed.split('/').filter((p) => p.length > 0);
    const last = parts.length > 0 ? parts[parts.length - 1]! : 'untitled';
    return ensureMdExtension(last);
}

/** Modulweiter Reentranz-Guard (F8): nur ein Dialog gleichzeitig. */
let createDialogOpen = false;

/**
 * Öffnet den Anlegen-Dialog fuer einen folio-new:-Klick.
 * Bei Erfolg create_file + openDocument; bei Abbruch nichts.
 * Reentrante Klicks während eines laufenden Dialogs werden ignoriert.
 */
export async function handleFolioNewClick(href: string): Promise<void> {
    if (createDialogOpen) return;
    createDialogOpen = true;
    try {
        const name = parseFolioNewName(href);
        const dir = documentDirectory(getCurrentPath());
        if (!dir) {
            folioLog.warn('wikilink', 'folio-new click without open document', { href });
            // Dialog trotzdem mit leerem Ziel — showCreateNoteDialog zeigt den Fehler.
        }
        const initialName = initialNameFromWikilink(name || 'untitled');
        const created = await showCreateNoteDialog({
            initialName,
            targetDir: dir || '',
        });
        if (!created) return;
        try {
            await openDocument(created);
        } catch (err) {
            folioLog.warn('wikilink', 'openDocument after create failed', {
                path: created,
                error: String(err),
            });
        }
    } finally {
        createDialogOpen = false;
    }
}
