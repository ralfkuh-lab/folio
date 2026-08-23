/* Aufschub-Guard fuer das Inline-Rename im Vault-Baum.

   Jeder Baum-Rebuild ersetzt DOM: der komplette (vault:refresh ->
   refreshVault), der eines Ordners (VaultWatcher -> expand-dir ->
   insertVaultChildren) und der der Pinned-/Recent-Sektionen. Steckt in
   der betroffenen Zeile gerade ein offenes input.vault-rename-input, ist
   die angefangene Eingabe damit weg — ohne dass der Nutzer den Grund
   sieht. Im Alltag reicht dafuer eine Logdatei oder ein git-Lauf im
   aufgeklappten Ordner (Befund aus einem E2E-Flake 2026-08-20).

   Deshalb: solange ein Rename laeuft, werden Baum-Updates aufgeschoben
   und nach Commit/Abbruch als EIN kompletter Rebuild nachgezogen —
   vault_build_tree deckt auch aufgeschobene Teil-Updates ab. Der Baum
   hinkt fuer die Dauer der Eingabe hinterher; das ist der bewusst
   gewaehlte Preis gegenueber einem Rebuild, der die Eingabe durch den
   DOM-Austausch hindurchrettet.

   Der Guard verifiziert das Input im DOM, statt nur dem Flag zu
   glauben: verschwindet es auf einem Weg, der cleanup() umgeht, waere
   der Baum sonst bis zum Neustart eingefroren. */

let renaming = false;
let pending = false;
let flush: (() => void) | null = null;

/** tree.ts meldet hier seinen Nachzieh-Rebuild an (vermeidet den
    Import-Zyklus tree -> context-menu -> tree). */
export function setVaultRenameFlush(fn: () => void): void {
    flush = fn;
}

export function beginVaultRename(): void {
    renaming = true;
    pending = false;
}

export function endVaultRename(): void {
    if (!renaming) return;
    renaming = false;
    if (!pending) return;
    pending = false;
    scheduleFlush();
}

/** Aufgeschobene Updates laufen als Microtask nach, nie synchron aus
    einem Render heraus — sonst rendert der Baum re-entrant. */
function scheduleFlush(): void {
    if (flush) queueMicrotask(flush);
}

function renameStillOpen(): boolean {
    if (!renaming) return false;
    const input = document.querySelector('#vault-tree .vault-rename-input') as HTMLElement | null;
    if (input && input.isConnected) return true;
    renaming = false;
    if (pending) {
        pending = false;
        scheduleFlush();
    }
    return false;
}

export function isVaultRenameActive(): boolean {
    return renameStillOpen();
}

/** true = das Update wurde aufgeschoben und laeuft nach dem Rename nach;
    false = der Aufrufer darf den Baum jetzt anfassen. */
export function deferVaultTreeUpdate(): boolean {
    if (!renameStillOpen()) return false;
    pending = true;
    return true;
}
