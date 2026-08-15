/* Vault-Volltextsuche — Such-Panel im linken Rail (Etappe S2/S3 + S4-Dialog).

   S4 verlagert die Bedienung von der Inline-Zeile (Input + Aa/W) in einen
   modalen Dialog (`#vault-search-dialog`, Muster wie `.unsaved-dialog__panel`).
   Der linke Rail zeigt nur noch einen Summary-Button (`#vault-search-summary`)
   mit dem aktiven Begriff + Options-Glyphen sowie darunter die Ergebnisse.

   Draft vs. Committed [Sol#7]: Der Dialog arbeitet ausschließlich auf dem
   DOM-Draft (Felder). Der committed State (activeQuery, Optionen, Scope) ändert
   sich NUR bei gültigem Submit. Abbrechen verwirft den Draft und lässt einen
   laufenden Lauf unangetastet. `openVaultSearchDialog()` ist idempotent.

   Stale-Guard nach dem renderGen-Muster (view/preview.ts): jede neue Suche
   erhöht eine lokale Generation, cancelt den alten runId und akzeptiert nur
   Events des adoptierten runId. `search:hits` kann VOR der Auflösung des
   vault_search_start-Promise eintreffen → Events eines NEUEREN, noch nicht
   adoptierten runId werden gepuffert; Events eines bereits gesehenen
   (`<= maxRunId`) abgebrochenen Laufs werden verworfen (kein Endlos-Puffer).

   Sprung-Korrelation: statt roh auf `document:loaded` zu hören, wird auf das
   in-window CustomEvent `folio-doc-kind-changed` reagiert, das state/document.ts
   NACH dem Anwenden des Dokument-States dispatcht (erbt den seq-Stale-Guard,
   CLAUDE.md-Konvention „KI-Button-Gating"). Der Pfad kommt aus getCurrentPath().

   OpenTabs-Sprung [Sol#2]: Treffer in offenen Tabs werden NICHT über
   openDocument geöffnet (Save-Prompt + Reload würden den dirty Puffer
   zerstören), sondern über Pfad→Tab-ID (findTabIdByPath) + activateTab. */

import { folioLog, safeInvoke } from '../util/log';
import { setEditorFindTerm, findNext } from '../ui/find-bar';
import { getCurrentPath, syncEditorTextToStoreRequired } from '../state/document';
import { activateTab, findTabIdByPath, getActiveTabId } from '../state/tabs';
// Direct modules — not the app/i18n barrel (that re-exports event-queue,
// whose import side-effect patches listen() and suppresses handlers until uiReady).
import { t, tPlural } from '../i18n/translate';
import { fmtNumber, getFormatLocale } from '../i18n/format';

type Deps = {
    openDocument: (path: string) => void;
    showStatus?: (msg: string) => void;
    openLeftRail: () => void;
};

type FileFilter = 'markdown' | 'allText' | 'custom';
type ScopeMode = 'vault' | 'folder' | 'openTabs';
type SortMode = 'none' | 'name' | 'path';
type PathDisplay = 'relative' | 'absolute';

type Range = [number, number];
interface Hit {
    line: number;
    colUtf16: number;
    lenUtf16: number;
    snippet: string;
    snippetOffsetUtf16: number;
    ranges: Range[];
}
interface FileResult {
    path: string;
    fileName: string;
    hits: Hit[];
    truncated: boolean;
    /** [S5/Sol#1] Frontend-vergebene Ankunftssequenz (Fundreihenfolge). Wird in
     *  applyHits gesetzt; `none` sortiert explizit danach, damit der Rückweg
     *  aus name/path die Fundreihenfolge wiederherstellt. */
    arrival?: number;
}
interface Stats {
    filesScanned: number;
    filesMatched: number;
    hits: number;
    skippedLarge: number;
    truncated: boolean;
    elapsedMs: number;
}
interface Jump {
    path: string;
    line: number;
    colUtf16: number;
    lenUtf16: number;
    matchOrdinal: number;
    term: string;
    caseSensitive: boolean;
    wholeWord: boolean;
}

const MIN_QUERY_LEN = 2;
const VIEW_FIND_CAP = 200;
const VIEW_SETTLE_TIMEOUT_MS = 2000;
const AUTO_COLLAPSE_THRESHOLD = 10; // > 10 Treffergruppen → Auto-Einklappen

let deps: Deps = { openDocument: () => {}, openLeftRail: () => {} };
let region: HTMLElement | null = null;
let summaryBtn: HTMLElement | null = null;
let summaryTextEl: HTMLElement | null = null;
let summaryOptsEl: HTMLElement | null = null;
let resultsEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let sortBtn: HTMLElement | null = null;
let sortLabelEl: HTMLElement | null = null;
let pathsBtn: HTMLElement | null = null;

// ----- Committed State (ändert sich nur bei gültigem Submit) ----------------
let activeQuery = '';
let caseSensitive = false;
let wholeWord = false;
let regex = false;
let fileFilter: FileFilter = 'allText';
let customExtensions = '';
let includeHidden = false;
// S5-Ergebnis-Header-Optionen: Verzeichnispfad-Anzeige + Sortiermodus. Persistiert
// über set_search_options/search_options_get (Muster der S4-Felder). Anders als
// die Dialog-Optionen leben diese Toggles im Ergebnis-Header und wirken sofort.
let showPaths = false;
let searchSort: SortMode = 'none';
// [S7] Pfad-Darstellung der Pfadzeile: `relative` (Pin-/Ordnername + Rest) oder
// `absolute` (voller Verzeichnispfad). Anders als showPaths/searchSort ist das
// ein echtes App-Setting (`searchPathDisplay` in settings.json), NICHT Teil der
// panel_state-Suchoptionen — beim Boot aus settings_get gelesen, live über
// `settings:changed` aktualisiert. Unbekannt → `relative`.
let pathDisplay: PathDisplay = 'relative';
// [Sol-Rev S7#5] Boot-Race-Guard: sobald ein Live-`settings:changed` die
// Pfad-Darstellung gesetzt hat, darf eine (evtl. langsamere) `settings_get`-
// Boot-Antwort sie nicht mehr still zurücksetzen.
let pathDisplaySettingsEventSeen = false;
// Scope: folder (scopePath gesetzt) | openTabs (openTabs=true) | vault (beides leer).
let scopePath: string | null = null;
let openTabs = false;
// Zuletzt bekannter Ordner-Kontext (Kontextmenü ODER committed Folder-Scope).
// Steuert die Sichtbarkeit der Folder-Radio-Option im Dialog.
let folderDraftPath: string | null = null;
let optionsTouched = false; // Submit hat Optionen committed (Boot-Restore-Guard)

let gen = 0; // lokale Generation für Stale-Guard
let currentRunId = -1; // Backend-runId, dessen Events wir anwenden
let maxRunId = -1; // höchste je gesehene runId (verwirft abgebrochene Läufe)
let pendingHits: Record<number, FileResult[]> = {};
let pendingDone: Record<number, any> = {};

let files: FileResult[] = [];
let arrivalCounter = 0; // monotone Ankunftssequenz pro Lauf (Fundreihenfolge)
let doneStats: Stats | null = null;
const collapsed = new Set<string>(); // eingeklappte Datei-Gruppen (per Pfad)
let collapseMode: 'auto' | 'collapsed' | 'expanded' = 'auto';
let autoCollapseApplied = false; // einmaliges Auto-Einklappen pro Lauf
let flat: Array<{ f: number; h: number }> = [];
let activeIdx = -1;

let pendingJump: Jump | null = null;
// Einmal-Skip für den Navigation-Restore (tab_open): der Entry-Restore würde
// unseren Sprung mit Cursor/Scroll aus dem Entry überschreiben.
let navRestoreSkipPath: string | null = null;

let scopeEl: HTMLElement | null = null;
const FOLDER_SEARCH_SVG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>';

// ----- Dialog-State ---------------------------------------------------------
let dialogOpen = false;
let dialogPrevFocus: HTMLElement | null = null;
let dialogUnwire: (() => void) | null = null;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function normalizePath(p: string | null | undefined): string {
    return (p || '').replace(/\\/g, '/');
}

function normalizeFilter(v: unknown): FileFilter {
    return v === 'markdown' || v === 'custom' ? v : 'allText';
}

function normalizeSort(v: unknown): SortMode {
    return v === 'name' || v === 'path' ? v : 'none';
}

function normalizePathDisplay(v: unknown): PathDisplay {
    return v === 'absolute' ? 'absolute' : 'relative';
}

// Locale-aware, numerische Sortierung (Monaco-nahe „natürliche" Ordnung, z. B.
// f2 < f10). Collator wird bei Locale-Wechsel neu erzeugt.
let sortCollator: Intl.Collator | null = null;
let sortCollatorLocale = '';
function nameCompare(a: string, b: string): number {
    const loc = getFormatLocale();
    if (!sortCollator || sortCollatorLocale !== loc) {
        try {
            sortCollator = new Intl.Collator(loc, { numeric: true, sensitivity: 'base' });
        } catch {
            sortCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
        }
        sortCollatorLocale = loc;
    }
    return sortCollator.compare(a, b);
}

/** [S5-Punkt 5] Preformatierte, locale-aware Dauer: unter 1 s in Millisekunden,
 *  ab 1 s in Sekunden mit einer Nachkommastelle (z. B. „30,1 s"). Einheiten sind
 *  bewusst SI-Symbole (Muster fmtBytes). */
function formatDuration(ms: number): string {
    if (!isFinite(ms) || ms < 0) ms = 0;
    if (ms < 1000) return fmtNumber(Math.round(ms)) + ' ms';
    const secs = ms / 1000;
    return fmtNumber(secs, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Baut den Snippet-HTML mit <mark> über die Ranges. Ranges sind
 *  0-basierte UTF-16-Offsets relativ zum Snippet — in JS sind
 *  String-Indizes ebenfalls UTF-16-Code-Units, daher direktes slice(). */
function markedSnippet(snippet: string, ranges: Range[]): string {
    if (!snippet) return '';
    if (!ranges || ranges.length === 0) return escapeHtml(snippet);
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
    let html = '';
    let cursor = 0;
    for (const [start, len] of sorted) {
        if (start < cursor) continue; // Überlappung defensiv überspringen
        html += escapeHtml(snippet.slice(cursor, start));
        html += '<mark>' + escapeHtml(snippet.slice(start, start + len)) + '</mark>';
        cursor = start + len;
    }
    html += escapeHtml(snippet.slice(cursor));
    return html;
}

// ----- Pfadanzeige (S5-Punkt 3) ---------------------------------------------

/** [Sol-Rev S7#6] Trailing-Separatoren entfernen, aber laufwerks-/dateisystem-
 *  wurzel-sicher: die Unix-Wurzel `/` bleibt `/` (nicht `""`) — sonst verliert
 *  eine direkt darunter liegende Datei ihre Pfadzeile (S7-Garantie „nie leer"). */
function trimTrailingSlash(p: string): string {
    const t = p.replace(/\/+$/, '');
    return t === '' ? '/' : t;
}

/** Ob `path` unter `root` liegt (Gleichheit oder echtes Präfix an Separator-
 *  Grenze). Root-sicher: eine bereits auf `/` endende Wurzel (Unix-Root `/`)
 *  bekommt kein zweites `/` angehängt. */
function isUnderRoot(path: string, root: string): boolean {
    if (path === root) return true;
    const prefix = root.endsWith('/') ? root : root + '/';
    return path.startsWith(prefix);
}

/** Die angepinnten Top-Level-Wurzeln aus dem Vault-Baum (forward-slash-
 *  normalisiert). Nur die direkten `li.node`-Kinder der Pinned-Section — die
 *  Kandidaten für die Präfix-Relativierung im Vault-Scope. */
function pinRoots(): string[] {
    const tree = $('vault-tree');
    if (!tree) return [];
    const ul = tree.querySelector('li.section[data-section="pinned"] > ul.children');
    if (!ul) return [];
    const roots: string[] = [];
    const nodes = ul.querySelectorAll(':scope > li.node[data-path]');
    nodes.forEach((n) => {
        const p = n.getAttribute('data-path');
        if (p) roots.push(trimTrailingSlash(normalizePath(p)));
    });
    return roots;
}

/** Ermittelt die Basis, gegen die `path` relativiert wird: Folder-Scope →
 *  scopePath; Vault-Scope → längste passende Pin-Wurzel; OpenTabs bzw. kein
 *  Treffer → null (voller Pfad). */
function scopeRootFor(path: string): string | null {
    if (openTabs) return null;
    if (scopePath) {
        const r = trimTrailingSlash(normalizePath(scopePath));
        return isUnderRoot(path, r) ? r : null;
    }
    let best: string | null = null;
    for (const root of pinRoots()) {
        if (isUnderRoot(path, root)) {
            if (!best || root.length > best.length) best = root;
        }
    }
    return best;
}

/** Basisname (letztes Segment) einer Wurzel — der angezeigte Pin-/Ordnername.
 *  Die Unix-Wurzel `/` wird als `/` angezeigt (nie leer). */
function rootBaseName(root: string): string {
    const r = trimTrailingSlash(root);
    if (r === '/') return '/';
    const idx = r.lastIndexOf('/');
    return idx >= 0 ? r.slice(idx + 1) : r;
}

/** Reiner Verzeichnisanteil (ohne Dateiname) eines Pfads. Eine Datei direkt
 *  unter der Unix-Wurzel hat den Verzeichnisanteil `/` (nicht leer). */
function dirOf(p: string): string {
    const idx = p.lastIndexOf('/');
    if (idx < 0) return '';
    if (idx === 0) return '/';
    return p.slice(0, idx);
}

/** Fügt Wurzel-Anzeigenamen und relativen Rest zusammen, ohne Doppel-Slash
 *  (`/` + `sub` → `/sub`, nicht `//sub`). */
function joinDisplay(a: string, b: string): string {
    return a.endsWith('/') ? a + b : a + '/' + b;
}

/** [S7] Die angezeigte Pfadzeile (Verzeichnisanteil — der Dateiname steht
 *  separat in Zeile 1, deshalb nie mitgeführt). Diese Zeichenkette ist zugleich
 *  der Sortierschlüssel für `sort=path` (und Sekundärschlüssel bei `sort=name`).
 *
 *  - `absolute`: voller normalisierter Verzeichnispfad.
 *  - `relative` mit Root-Match: Wurzel-Basisname + relativer Rest-Verzeichnis-
 *    pfad; liegt die Datei direkt in der Wurzel, nur der Basisname (nie leer).
 *  - `relative` ohne Root-Match (OpenTabs / kein passender Pin): voller
 *    Verzeichnispfad (wie `absolute`). */
function displayPath(path: string): string {
    const p = normalizePath(path);
    if (pathDisplay === 'absolute') return dirOf(p);
    const root = scopeRootFor(p);
    if (!root) return dirOf(p);
    const name = rootBaseName(root);
    const rel = p.slice(root.length).replace(/^\/+/, '');
    const relDir = dirOf(rel);
    return relDir ? joinDisplay(name, relDir) : name;
}

function setStatus(msg: string): void {
    if (statusEl) statusEl.textContent = msg;
}

/** [Sol#14] Zentraler Spinner-Toggle, gekoppelt an den adoptierten Lauf. */
function setRunning(on: boolean): void {
    if (statusEl) statusEl.classList.toggle('vs-running', on);
}

function totalHits(): number {
    let n = 0;
    for (const f of files) n += f.hits.length;
    return n;
}

function currentScopeMode(): ScopeMode {
    if (openTabs) return 'openTabs';
    if (scopePath) return 'folder';
    return 'vault';
}

// ----- Such-Modus an/aus (Tree ↔ Ergebnisse) --------------------------------

function enterSearch(): void {
    if (document.body.classList.contains('vault-hidden')) deps.openLeftRail();
    if (region) region.classList.add('vault-searching');
    if (resultsEl) resultsEl.hidden = false;
}

function exitSearch(): void {
    // [Sol#2] Liegt der Fokus im gleich ausgeblendeten Exit-/Ergebnisbereich
    // (×-Button, Ergebnis-Header, Liste), würde er auf einem display:none-
    // Element stranden — vorher merken und nach dem Ausblenden auf den weiter
    // sichtbaren Summary-Button verschieben.
    const active = document.activeElement as HTMLElement | null;
    const focusWasHidden =
        !!active &&
        ((resultsEl ? resultsEl.contains(active) : false) || active.id === 'vault-search-exit');
    // Generation erhöhen, damit ausstehende Start-Promises nicht mehr adoptiert
    // werden, und alle Puffer + einen scharfen Sprung fallenlassen.
    gen++;
    cancelCurrent();
    pendingHits = {};
    pendingDone = {};
    pendingJump = null;
    setRunning(false);
    if (region) region.classList.remove('vault-searching');
    if (resultsEl) resultsEl.hidden = true;
    activeQuery = '';
    files = [];
    arrivalCounter = 0;
    doneStats = null;
    flat = [];
    activeIdx = -1;
    collapsed.clear();
    if (listEl) listEl.innerHTML = '';
    setStatus('');
    renderSummary();
    if (focusWasHidden && summaryBtn && typeof summaryBtn.focus === 'function') {
        summaryBtn.focus();
    }
}

function cancelCurrent(): void {
    if (currentRunId >= 0) {
        safeInvoke('vault_search_cancel', { runId: currentRunId }, 'vault_search_cancel', 'debug');
    }
    currentRunId = -1;
}

// ----- Suche starten --------------------------------------------------------

/** Startet einen Lauf aus dem committed State. Wird von Submit, Scope-Fallback
 *  und Scope-Chip-× gerufen. */
function runSearch(): void {
    // Ein neuer Lauf macht einen scharfen Sprung aus einer früheren Suche
    // gegenstandslos.
    pendingJump = null;
    const q = activeQuery;
    if (Array.from(q).length < MIN_QUERY_LEN) {
        gen++;
        cancelCurrent();
        pendingHits = {};
        pendingDone = {};
        files = [];
        arrivalCounter = 0;
        doneStats = null;
        activeIdx = -1;
        resetCollapseState();
        renderResults();
        setRunning(false);
        setStatus(t('search.query.minLength.hint'));
        return;
    }
    const myGen = ++gen;
    const scopedAtStart = openTabs ? null : scopePath;
    const openTabsAtStart = openTabs;
    cancelCurrent();
    pendingHits = {};
    pendingDone = {};
    files = [];
    arrivalCounter = 0;
    doneStats = null;
    activeIdx = -1;
    resetCollapseState();
    renderResults();
    setRunning(true);
    setStatus(t('search.status.runningSimple'));
    // Raw invoke (nicht safeInvoke), damit wir die Scope-Fehler
    // (RootNotFound/InvalidScope) vom generischen Startfehler unterscheiden.
    rawInvoke('vault_search_start', {
        query: q,
        scope: scopedAtStart,
        openTabs: openTabsAtStart,
        caseSensitive,
        wholeWord,
        regex,
        fileFilter,
        customExtensions,
        includeHidden,
    }).then(
        (runId: any) => {
            if (typeof runId !== 'number') {
                if (myGen === gen) {
                    setRunning(false);
                    setStatus(t('errors.search.startFailed'));
                }
                return;
            }
            if (runId > maxRunId) maxRunId = runId;
            if (myGen !== gen) {
                // Während des Await von einer neueren Suche überholt → canceln.
                // Der neuere Lauf besitzt den Spinner-Zustand.
                safeInvoke('vault_search_cancel', { runId }, 'vault_search_cancel', 'debug');
                return;
            }
            adoptRun(runId);
        },
        (err: unknown) => {
            if (myGen !== gen) return;
            // Nur die beiden Scope-Fehler (Backend-Präfix `scope:`) lösen den
            // Fallback aus — Chip entfernen + vault-weit weitersuchen. Jeder
            // andere Fehler behält den Scope-Chip und zeigt einen generischen
            // Startfehler.
            if (scopedAtStart && String(err).startsWith('scope:')) {
                folioLog.warn('search', 'scoped search failed → fallback', {
                    error: String(err),
                });
                scopePath = null;
                renderScopeChip();
                renderSummary();
                runSearch();
                setStatus(t('search.scope.folderMissing.fallback'));
            } else {
                setRunning(false);
                setStatus(t('errors.search.startFailed'));
            }
        },
    );
}

function rawInvoke(cmd: string, args?: any): Promise<any> {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') {
        return Promise.reject(new Error('invoke unavailable'));
    }
    return core.invoke(cmd, args);
}

function adoptRun(runId: number): void {
    currentRunId = runId;
    if (runId > maxRunId) maxRunId = runId;
    const buffered = pendingHits[runId];
    if (buffered && buffered.length) applyHits(buffered);
    if (pendingDone[runId]) applyDone(pendingDone[runId]);
    pendingHits = {};
    pendingDone = {};
}

// ----- Event-Handler (Streaming) --------------------------------------------

function onHits(payload: any): void {
    if (!payload || typeof payload.runId !== 'number') return;
    const rid = payload.runId as number;
    const incoming: FileResult[] = Array.isArray(payload.files) ? payload.files : [];
    if (rid === currentRunId) {
        applyHits(incoming);
        return;
    }
    if (rid <= maxRunId) return; // abgebrochener/alter Lauf → verwerfen
    (pendingHits[rid] = pendingHits[rid] || []).push(...incoming); // neuer, noch nicht adoptiert
}

function onDone(payload: any): void {
    if (!payload || typeof payload.runId !== 'number') return;
    const rid = payload.runId as number;
    if (rid === currentRunId) {
        applyDone(payload);
        return;
    }
    if (rid <= maxRunId) return;
    pendingDone[rid] = payload;
}

function applyHits(newFiles: FileResult[]): void {
    const anchor = activeAnchor();
    for (const f of newFiles) {
        f.arrival = arrivalCounter++;
        files.push(f);
    }
    applyCollapsePolicy(newFiles);
    // Beim Streaming die neue Gruppe stabil einsortieren (Modus-abhängig); der
    // aktive Treffer bleibt über (Pfad, Hit-Index) erhalten.
    sortFiles();
    renderResults();
    restoreActive(anchor);
    setStatus(t('search.status.running', {
        hitsPart: tPlural('search.status.hitsPart', totalHits()),
        filesPart: tPlural('search.status.filesPart', files.length),
    }));
}

function applyDone(payload: any): void {
    setRunning(false);
    if (payload.error) {
        setStatus(t('search.status.error', { detail: String(payload.error) }));
        folioLog.warn('search', 'search done with error', { error: String(payload.error) });
        return;
    }
    doneStats = (payload.stats as Stats) || null;
    finalStatus();
}

function finalStatus(): void {
    if (!doneStats) return;
    const s = doneStats;
    // 1. Basissatz wählen …
    let msg: string;
    if (s.hits === 0) {
        if (openTabs && s.filesScanned === 0) {
            // OpenTabs-Scope ohne durchsuchbare offene Dateien.
            msg = t('search.status.noOpenFiles');
        } else if (scopePath === null && !openTabs && s.filesScanned === 0) {
            // Vault-Scope + 0 gescannte Dateien = nichts Durchsuchbares im Vault
            // (leere Pins ODER nur Binärdateien); Ordner-Scope oder Pins mit
            // 0 Treffern liefern filesScanned>0.
            msg = t('search.status.noFiles');
        } else {
            msg = t('search.status.empty', {
                filesPart: tPlural('search.status.filesPart', s.filesScanned),
            });
        }
    } else {
        msg = t('search.status.done', {
            hitsPart: tPlural('search.status.hitsPart', s.hits),
            filesPart: tPlural('search.status.filesPart', s.filesMatched),
            duration: formatDuration(s.elapsedMs),
        });
    }
    // 2. … DANN die Zusätze anhängen (auch im „alle zu groß"-Fall sichtbar).
    if (s.truncated) msg += t('search.status.truncated');
    if (s.skippedLarge > 0) {
        msg += t('search.status.skippedSuffix', {
            skippedPart: tPlural('search.status.skippedPart', s.skippedLarge),
        });
    }
    setStatus(msg);
}

// ----- Auto-Collapse (Modus auto|collapsed|expanded) [Sol#8] ----------------

function resetCollapseState(): void {
    collapsed.clear();
    collapseMode = 'auto';
    autoCollapseApplied = false;
}

/** Wendet den Collapse-Modus auf die neu eingetroffenen Gruppen an. Im
 *  Auto-Modus wird beim ersten Überschreiten der Schwelle EINMALIG alles
 *  eingeklappt; danach kommen weitere Gruppen ebenfalls eingeklappt. */
function applyCollapsePolicy(newFiles: FileResult[]): void {
    if (collapseMode === 'expanded') {
        for (const f of newFiles) collapsed.delete(f.path);
        return;
    }
    if (collapseMode === 'collapsed') {
        for (const f of newFiles) collapsed.add(f.path);
        return;
    }
    // auto
    if (!autoCollapseApplied) {
        if (files.length > AUTO_COLLAPSE_THRESHOLD) {
            for (const f of files) collapsed.add(f.path);
            autoCollapseApplied = true;
        }
    } else {
        for (const f of newFiles) collapsed.add(f.path);
    }
}

function collapseAll(): void {
    collapseMode = 'collapsed';
    autoCollapseApplied = true;
    for (const f of files) collapsed.add(f.path);
    activeIdx = -1;
    renderResults();
}

function expandAll(): void {
    collapseMode = 'expanded';
    autoCollapseApplied = true;
    collapsed.clear();
    renderResults();
}

// ----- Sortierung + Pfad-Toggle (S5) ----------------------------------------

/** Persistiert den kompletten committed Optionssatz (Dialog-Optionen + die
 *  Ergebnis-Header-Toggles Pfad/Sortierung). Scope bleibt flüchtig. */
function persistSearchOptions(): void {
    safeInvoke(
        'set_search_options',
        {
            caseSensitive,
            wholeWord,
            regex,
            fileFilter,
            customExtensions,
            includeHidden,
            showPaths,
            sort: searchSort,
        },
        'set_search_options',
        'debug',
    );
}

/** Ordnet die Gruppen gemäß aktivem Modus. `none` sortiert explizit nach der
 *  Ankunftssequenz (`arrival`) — die Fundreihenfolge ist damit auch nach einem
 *  Ausflug über name/path wiederherstellbar [Sol#1]. Array.sort ist stabil;
 *  Dateiname sekundär nach Pfad → deterministisch bei gleichnamigen Dateien
 *  (README.md). */
function sortFiles(): void {
    if (searchSort === 'none') {
        files.sort((a, b) => (a.arrival ?? 0) - (b.arrival ?? 0));
        return;
    }
    // [S7] Schlüssel/Sekundärschlüssel = angezeigte Pfad-Zeichenkette (nicht der
    // absolute Pfad). Memoisiert, damit displayPath (DOM-Query über pinRoots)
    // pro Datei nur einmal je Sortierdurchlauf läuft.
    const dispCache = new Map<string, string>();
    const disp = (p: string): string => {
        let d = dispCache.get(p);
        if (d === undefined) {
            d = displayPath(p);
            dispCache.set(p, d);
        }
        return d;
    };
    files.sort((a, b) => {
        if (searchSort === 'name') {
            const c = nameCompare(a.fileName, b.fileName);
            return c !== 0 ? c : nameCompare(disp(a.path), disp(b.path));
        }
        return nameCompare(disp(a.path), disp(b.path));
    });
}

/** Aktiven Treffer über (Pfad, Hit-Index) festhalten — überlebt Re-Sort und
 *  Collapse (das collapsed-Set ist pfadbasiert). */
function activeAnchor(): { path: string; h: number } | null {
    if (activeIdx < 0 || activeIdx >= flat.length) return null;
    const { f, h } = flat[activeIdx];
    const file = files[f];
    return file ? { path: file.path, h } : null;
}

function restoreActive(anchor: { path: string; h: number } | null): void {
    if (!anchor) {
        activeIdx = -1;
        return;
    }
    const fi = files.findIndex((x) => x.path === anchor.path);
    if (fi < 0) {
        activeIdx = -1;
        return;
    }
    activeIdx = flat.findIndex((x) => x.f === fi && x.h === anchor.h);
    paintActive();
}

const SORT_CYCLE: SortMode[] = ['none', 'name', 'path'];

function cycleSort(): void {
    optionsTouched = true; // Boot-Restore-Guard: nutzergewählt, nicht überschreiben
    const idx = SORT_CYCLE.indexOf(searchSort);
    searchSort = SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
    // [S7] Einbahn-Kopplung: Pfad-Sortierung ohne sichtbare Pfade ist nicht
    // nachvollziehbar (die Reihenfolge wäre unerklärlich) — deshalb blenden wir
    // die Pfadzeile beim Wechsel auf `path` einmalig ein. Bewusst KEINE
    // Rück-Kopplung: verlässt der User `path` wieder, bleibt showPaths, wie es
    // ist; und er darf die Pfade danach jederzeit wieder ausblenden.
    if (searchSort === 'path' && !showPaths) {
        showPaths = true;
        renderPathsToggle();
    }
    const anchor = activeAnchor();
    sortFiles();
    renderResults();
    restoreActive(anchor);
    renderSortButton();
    persistSearchOptions();
}

function sortModeLabel(): string {
    // Literale Keys (der i18n-Referenz-Gate erkennt keine String-Konkatenation).
    if (searchSort === 'name') return t('search.sort.mode.name');
    if (searchSort === 'path') return t('search.sort.mode.path');
    return t('search.sort.mode.none');
}

function renderSortButton(): void {
    if (sortBtn) {
        sortBtn.classList.toggle('active', searchSort !== 'none');
        const mode = sortModeLabel();
        sortBtn.title = t('search.sort.tooltip', { mode });
        sortBtn.setAttribute('aria-label', t('search.sort.ariaLabel', { mode }));
    }
    if (sortLabelEl) {
        // Kurzlabel nur in den sortierten Modi; „none" zeigt nur das Icon.
        sortLabelEl.textContent = searchSort === 'none' ? '' : sortModeLabel();
    }
}

function togglePaths(): void {
    optionsTouched = true; // Boot-Restore-Guard: nutzergewählt, nicht überschreiben
    showPaths = !showPaths;
    renderPathsToggle();
    renderResults();
    persistSearchOptions();
}

function renderPathsToggle(): void {
    if (!pathsBtn) return;
    pathsBtn.classList.toggle('active', showPaths);
    pathsBtn.setAttribute('aria-pressed', showPaths ? 'true' : 'false');
}

/** [S7] Setzt die Pfad-Darstellung (App-Setting) und rendert bei Änderung neu:
 *  Anzeige UND Sortierschlüssel hängen davon ab. Der aktive Treffer bleibt über
 *  den (Pfad, Hit-Index)-Anker erhalten. */
function setPathDisplay(next: PathDisplay): void {
    if (next === pathDisplay) return;
    pathDisplay = next;
    if (!files.length) return;
    const anchor = activeAnchor();
    sortFiles();
    renderResults();
    restoreActive(anchor);
}

/** [S7] Live-Reaktion auf `settings:changed`: nur `searchPathDisplay` ist hier
 *  relevant. Andere Settings-Felder ignorieren. */
function onSettingsChanged(payload: any): void {
    if (!payload || !payload.settings || typeof payload.settings !== 'object') return;
    pathDisplaySettingsEventSeen = true;
    setPathDisplay(normalizePathDisplay(payload.settings.searchPathDisplay));
}

// ----- Rendering ------------------------------------------------------------

function renderResults(): void {
    if (!listEl) return;
    // [S7] Emphasis-Swap ohne DOM-Umbau: die Modifier-Klasse auf der Liste
    // steuert per CSS Reihenfolge (order) + Farb-Betonung von Datei-/Pfadzeile.
    // Nur wirksam, wenn die Pfadzeile überhaupt sichtbar ist (`showPaths`):
    // ohne sie gäbe es keine `.vs-fpath`, und der Swap würde den einzigen
    // sichtbaren Dateinamen fälschlich dimmen [Sol-Rev S7#4]. Die Sortierung
    // selbst bleibt davon unabhängig (läuft weiter über `displayPath`).
    listEl.classList.toggle('vs-sort-path', searchSort === 'path' && showPaths);
    // DOM construction + textContent for user/t() values (i18n Spec).
    // Snippet HTML is the sole exception: controlled <mark> around escapeHtml.
    listEl.replaceChildren();
    for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        const isCollapsed = collapsed.has(f.path);
        const count = f.hits.length + (f.truncated ? '+' : '');

        const group = document.createElement('div');
        group.className = 'vs-group';
        group.setAttribute('data-file-idx', String(fi));

        const head = document.createElement('div');
        head.className = 'vs-group-head';
        head.setAttribute('data-file-idx', String(fi));
        head.title = f.path;

        const caret = document.createElement('span');
        caret.className = 'vs-caret' + (isCollapsed ? ' collapsed' : '');
        caret.textContent = '▾';

        // [S7] Zweizeiliger Kopf: Dateiname (Zeile 1) + Pfad (Zeile 2). Die
        // Reihenfolge/Betonung tauscht CSS (`vs-sort-path`); der Zähler-Badge
        // ist Geschwister des Textblocks und dadurch über beide Zeilen zentriert.
        const main = document.createElement('span');
        main.className = 'vs-main';

        const fname = document.createElement('span');
        fname.className = 'vs-fname';
        fname.textContent = f.fileName;
        main.appendChild(fname);

        if (showPaths) {
            const disp = displayPath(f.path);
            if (disp) {
                const fpath = document.createElement('span');
                fpath.className = 'vs-fpath';
                fpath.textContent = disp;
                main.appendChild(fpath);
            }
        }

        const countEl = document.createElement('span');
        countEl.className = 'vs-count';
        countEl.textContent = String(count);

        head.appendChild(caret);
        head.appendChild(main);
        head.appendChild(countEl);
        group.appendChild(head);

        const hitsWrap = document.createElement('div');
        hitsWrap.className = 'vs-hits';
        if (isCollapsed) hitsWrap.hidden = true;

        for (let hi = 0; hi < f.hits.length; hi++) {
            const h = f.hits[hi];
            const hit = document.createElement('div');
            hit.className = 'vs-hit';
            hit.setAttribute('data-file-idx', String(fi));
            hit.setAttribute('data-hit-idx', String(hi));

            const lineEl = document.createElement('span');
            lineEl.className = 'vs-line';
            lineEl.textContent = String(h.line);

            const snippetEl = document.createElement('span');
            snippetEl.className = 'vs-snippet';
            // markedSnippet only embeds escapeHtml(snippet) + static <mark> tags.
            snippetEl.innerHTML = markedSnippet(h.snippet, h.ranges);

            hit.appendChild(lineEl);
            hit.appendChild(snippetEl);
            hitsWrap.appendChild(hit);
        }
        if (f.truncated) {
            const more = document.createElement('div');
            more.className = 'vs-more';
            more.textContent = t('search.results.moreInFile');
            hitsWrap.appendChild(more);
        }
        group.appendChild(hitsWrap);
        listEl.appendChild(group);
    }
    rebuildFlat();
    paintActive();
}

// Nur sichtbare (nicht eingeklappte) Treffer sind navigierbar.
function rebuildFlat(): void {
    flat = [];
    for (let fi = 0; fi < files.length; fi++) {
        if (collapsed.has(files[fi].path)) continue;
        for (let hi = 0; hi < files[fi].hits.length; hi++) {
            flat.push({ f: fi, h: hi });
        }
    }
    if (activeIdx >= flat.length) activeIdx = flat.length - 1;
    if (activeIdx < 0) activeIdx = -1;
}

function paintActive(): void {
    if (!listEl) return;
    const rows = listEl.querySelectorAll('.vs-hit.active');
    rows.forEach((r) => r.classList.remove('active'));
    if (activeIdx < 0 || activeIdx >= flat.length) return;
    const { f, h } = flat[activeIdx];
    const row = listEl.querySelector(
        '.vs-hit[data-file-idx="' + f + '"][data-hit-idx="' + h + '"]',
    ) as HTMLElement | null;
    if (row) {
        row.classList.add('active');
        if (typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
        }
    }
}

// ----- Summary-Button -------------------------------------------------------

function renderSummary(): void {
    if (summaryBtn) summaryBtn.classList.toggle('has-query', !!activeQuery);
    if (summaryTextEl) {
        summaryTextEl.textContent = activeQuery ? activeQuery : t('search.summary.empty');
    }
    if (summaryOptsEl) {
        summaryOptsEl.replaceChildren();
        if (!activeQuery) return;
        // Kurze Optionen-Glyphen; optionaler title (Tooltip) bei weniger
        // selbsterklärenden Schaltern (includeHidden).
        const glyphs: Array<{ text: string; title?: string }> = [];
        if (caseSensitive) glyphs.push({ text: 'Aa' });
        if (wholeWord) glyphs.push({ text: 'W' });
        if (regex) glyphs.push({ text: '.*' });
        if (includeHidden) {
            glyphs.push({ text: '·', title: t('search.dialog.includeHidden.label') });
        }
        if (fileFilter === 'markdown') glyphs.push({ text: 'md' });
        else if (fileFilter === 'custom') glyphs.push({ text: '*.…' });
        if (openTabs) glyphs.push({ text: '⧉' });
        for (const g of glyphs) {
            const span = document.createElement('span');
            span.className = 'vs-summary-opt';
            span.textContent = g.text;
            if (g.title) span.title = g.title;
            summaryOptsEl.appendChild(span);
        }
    }
}

// ----- Keyboard-Navigation (auf der Ergebnisliste) --------------------------

function moveActive(dir: number): void {
    if (flat.length === 0) return;
    if (activeIdx < 0) {
        activeIdx = dir > 0 ? 0 : flat.length - 1;
    } else {
        activeIdx = Math.max(0, Math.min(activeIdx + dir, flat.length - 1));
    }
    paintActive();
}

function openActive(newTab: boolean): void {
    if (activeIdx < 0 || activeIdx >= flat.length) return;
    const { f, h } = flat[activeIdx];
    openHit(f, h, newTab);
}

function onListKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        exitSearch();
        e.preventDefault();
        return;
    }
    if (e.key === 'ArrowDown') {
        moveActive(1);
        e.preventDefault();
        return;
    }
    if (e.key === 'ArrowUp') {
        moveActive(-1);
        e.preventDefault();
        return;
    }
    if (e.key === 'Enter') {
        if (activeIdx >= 0) {
            openActive(e.ctrlKey || e.metaKey);
            e.preventDefault();
        }
        return;
    }
}

// ----- Treffer öffnen + Sprung ---------------------------------------------

/** [Sol#3] Bei Regex-Läufen ist der Suchbegriff ein Pattern — als Jump-Term
 *  wird der konkret gematchte Text (aus Snippet + erster Range) genutzt und im
 *  View-Mode als Literal ohne Whole-Word gesucht. */
function jumpTerm(h: Hit): string {
    if (regex && h.snippet && h.ranges && h.ranges.length) {
        const [start, len] = h.ranges[0];
        const matched = h.snippet.slice(start, start + len);
        if (matched) return matched;
    }
    return activeQuery;
}

function openHit(fi: number, hi: number, newTab: boolean): void {
    const f = files[fi];
    if (!f) return;
    const h = f.hits[hi];
    if (!h) return;
    let matchOrdinal = 0;
    for (let i = 0; i < hi; i++) matchOrdinal += f.hits[i].ranges.length;
    pendingJump = {
        path: f.path,
        line: h.line,
        colUtf16: h.colUtf16,
        lenUtf16: h.lenUtf16,
        matchOrdinal,
        term: jumpTerm(h),
        caseSensitive,
        wholeWord: regex ? false : wholeWord,
    };
    if (openTabs) {
        // [Sol#2] Der dirty Puffer darf nicht durch openDocument (Reload) zerstört
        // werden — Pfad→Tab-ID, dann aktivieren. Beim schon aktiven Tab direkt
        // springen (kein document:loaded, das onDocKindChanged triggern würde).
        const tabId = findTabIdByPath(normalizePath(f.path));
        if (tabId != null) {
            if (getActiveTabId() === tabId) {
                const jump = pendingJump;
                pendingJump = null;
                requestAnimationFrame(() => performJump(jump));
            } else {
                navRestoreSkipPath = normalizePath(f.path);
                activateTab(tabId);
            }
            return;
        }
        // [Sol#2] Tab seit dem Snapshot geschlossen (Frontend-Tabliste war beim
        // Klick nicht mehr synchron): NIEMALS über tab_open/openDocument
        // nachladen — das würde für ein Ergebnis aus einem inzwischen
        // verworfenen dirty Puffer den Disk-Inhalt öffnen bzw. einen
        // Save-Prompt auslösen. Scharfen Sprung + Skip zurücknehmen und den
        // Treffer als veraltet melden; kein Öffnungspfad.
        pendingJump = null;
        navRestoreSkipPath = null;
        setStatus(t('search.status.hitStale'));
        return;
    }
    if (newTab) {
        // Der Entry-Restore (navigation:changed) würde unseren Sprung sonst mit
        // Cursor/Scroll aus dem Entry überschreiben → einmal überspringen.
        navRestoreSkipPath = normalizePath(f.path);
        safeInvoke('tab_open', { path: f.path }, 'tab_open');
    } else {
        deps.openDocument(f.path);
    }
}

/** main.ts konsultiert das im navigation:changed-Restore: liefert true (und
 *  disarmt), wenn für `path` ein Sprung scharf ist → Restore überspringen. */
export function consumeNavRestoreSkip(path: string): boolean {
    if (navRestoreSkipPath && normalizePath(path) === navRestoreSkipPath) {
        navRestoreSkipPath = null;
        return true;
    }
    return false;
}

// Reagiert auf das state-synchrone folio-doc-kind-changed (seq-geschützt).
function onDocKindChanged(): void {
    if (!pendingJump) return;
    const cur = getCurrentPath();
    if (!cur || normalizePath(cur) !== normalizePath(pendingJump.path)) {
        // Ein ANDERES Dokument wurde geladen → Sprung verwerfen.
        pendingJump = null;
        return;
    }
    const jump = pendingJump;
    pendingJump = null;
    requestAnimationFrame(() => performJump(jump));
}

function performJump(jump: Jump): void {
    // Race Tab-Wechsel ↔ rAF: nur springen, wenn das Zieldokument noch aktiv ist.
    const cur = getCurrentPath();
    if (cur && normalizePath(cur) !== normalizePath(jump.path)) return;

    const body = document.body.classList;
    const editMode = body.contains('edit-mode') || body.contains('split-mode');
    if (editMode && window.FolioEditor && typeof window.FolioEditor.revealMatch === 'function') {
        window.FolioEditor.revealMatch(jump.line, jump.colUtf16, jump.lenUtf16);
        return;
    }
    performViewJump(jump);
}

/** View-Mode-Sprung: Find-Bar mit Term + Optionen öffnen und den N-ten Treffer
 *  aktivieren. Der ViewFinder sucht asynchron (chunkweise) und feuert dabei
 *  MEHRERE `folio-find-state`-Events (setFindOptions + openFind/setFindTerm
 *  lösen je ein Research aus, jedes endet mit active=0). Deshalb wird nicht auf
 *  das erste Settle reagiert, sondern gewartet, bis die Settle-Events ruhen
 *  (Debounce), und ERST DANN das Ziel-Ordinal angesteuert — der Listener wird
 *  vor der eigenen findNext-Iteration entfernt, damit deren Settle keinen
 *  Loop auslöst. Nach dem Settle ist Treffer 0 aktiv → Ordinal 0 = keine
 *  Iteration. */
function performViewJump(jump: Jump): void {
    if (jump.matchOrdinal <= 0) {
        // Erster Treffer ist nach dem Settle ohnehin aktiv — nur Bar + Term setzen.
        try {
            setEditorFindTerm(jump.term, {
                caseSensitive: jump.caseSensitive,
                wholeWord: jump.wholeWord,
                regex: false,
            });
        } catch (err) {
            folioLog.warn('search', 'view-mode jump failed', { error: String(err) });
        }
        return;
    }

    let lastTotal = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;

    const applyOrdinal = (): void => {
        window.removeEventListener('folio-find-state', onState as EventListener);
        if (settleTimer) clearTimeout(settleTimer);
        if (overallTimer) clearTimeout(overallTimer);
        if (lastTotal <= 1) return;
        const target = Math.min(jump.matchOrdinal, lastTotal - 1, VIEW_FIND_CAP);
        for (let i = 0; i < target; i++) findNext();
    };
    const onState = (e: Event): void => {
        const d = (e as CustomEvent).detail;
        if (!d || d.term !== jump.term || d.scanning) return;
        lastTotal = typeof d.total === 'number' ? d.total : 0;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(applyOrdinal, 80); // nach dem letzten Settle
    };

    window.addEventListener('folio-find-state', onState as EventListener);
    overallTimer = setTimeout(() => {
        window.removeEventListener('folio-find-state', onState as EventListener);
        if (settleTimer) clearTimeout(settleTimer);
    }, VIEW_SETTLE_TIMEOUT_MS);

    try {
        setEditorFindTerm(jump.term, {
            caseSensitive: jump.caseSensitive,
            wholeWord: jump.wholeWord,
            regex: false,
        });
    } catch (err) {
        folioLog.warn('search', 'view-mode jump failed', { error: String(err) });
        window.removeEventListener('folio-find-state', onState as EventListener);
        if (overallTimer) clearTimeout(overallTimer);
    }
}

// ----- Klick auf Ergebnisse -------------------------------------------------

function onResultClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const hitEl = target.closest('.vs-hit') as HTMLElement | null;
    if (hitEl) {
        const fi = parseInt(hitEl.getAttribute('data-file-idx') || '-1', 10);
        const hi = parseInt(hitEl.getAttribute('data-hit-idx') || '-1', 10);
        if (fi >= 0 && hi >= 0) openHit(fi, hi, e.ctrlKey || e.metaKey);
        return;
    }
    const head = target.closest('.vs-group-head') as HTMLElement | null;
    if (head) {
        const fi = parseInt(head.getAttribute('data-file-idx') || '-1', 10);
        toggleCollapse(fi);
    }
}

function toggleCollapse(fi: number): void {
    const f = files[fi];
    if (!f) return;
    const active = activeIdx >= 0 && activeIdx < flat.length ? flat[activeIdx] : null;
    if (collapsed.has(f.path)) collapsed.delete(f.path);
    else collapsed.add(f.path);
    renderResults(); // rebuildFlat + paintActive
    // Aktiven Treffer erhalten, wenn noch sichtbar; sonst deselektieren.
    if (active) {
        activeIdx = flat.findIndex((x) => x.f === active.f && x.h === active.h);
        paintActive();
    }
}

function onResultAux(e: MouseEvent): void {
    if (e.button !== 1) return;
    const hitEl = (e.target as HTMLElement).closest('.vs-hit') as HTMLElement | null;
    if (!hitEl) return;
    const fi = parseInt(hitEl.getAttribute('data-file-idx') || '-1', 10);
    const hi = parseInt(hitEl.getAttribute('data-hit-idx') || '-1', 10);
    if (fi >= 0 && hi >= 0) {
        e.preventDefault();
        openHit(fi, hi, true);
    }
}

// ----- Ordner-Scope-Chip (S3) -----------------------------------------------

function scopeFolderName(p: string): string {
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function renderScopeChip(): void {
    if (!scopeEl) return;
    if (!scopePath) {
        scopeEl.hidden = true;
        scopeEl.replaceChildren();
        return;
    }
    scopeEl.hidden = false;
    // DOM + textContent for path/t() (never interpolate into innerHTML).
    scopeEl.replaceChildren();
    const chip = document.createElement('span');
    chip.className = 'vs-scope-chip';
    chip.title = scopePath;

    const icon = document.createElement('span');
    icon.className = 'vs-scope-icon';
    // Static SVG constant only.
    icon.innerHTML = FOLDER_SEARCH_SVG;

    const nameEl = document.createElement('span');
    nameEl.className = 'vs-scope-name';
    nameEl.textContent = scopeFolderName(scopePath);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'vs-scope-x';
    clearBtn.setAttribute('aria-label', t('search.scope.clear.ariaLabel'));
    clearBtn.title = t('search.scope.clear.tooltip');
    clearBtn.textContent = '×';

    chip.appendChild(icon);
    chip.appendChild(nameEl);
    chip.appendChild(clearBtn);
    scopeEl.appendChild(chip);
}

function clearScope(): void {
    if (!scopePath) return;
    scopePath = null;
    renderScopeChip();
    renderSummary();
    if (Array.from(activeQuery).length >= MIN_QUERY_LEN) {
        enterSearch();
        runSearch();
    }
}

// ----- Dialog ---------------------------------------------------------------

function clearDialogError(): void {
    const err = $('vsd-error');
    if (err) {
        err.hidden = true;
        err.textContent = '';
    }
}

function showDialogError(msg: string): void {
    const err = $('vsd-error');
    if (err) {
        err.textContent = msg;
        err.hidden = false;
    }
}

function radioValue(name: string): string | null {
    const el = document.querySelector(
        'input[name="' + name + '"]:checked',
    ) as HTMLInputElement | null;
    return el ? el.value : null;
}

function setRadio(name: string, value: string): void {
    const el = document.querySelector(
        'input[name="' + name + '"][value="' + value + '"]',
    ) as HTMLInputElement | null;
    if (el) el.checked = true;
}

function syncFilterDependents(): void {
    const filter = radioValue('vsd-filter');
    const ext = $('vsd-custom-ext') as HTMLInputElement | null;
    if (ext) ext.disabled = filter !== 'custom';
}

function syncRegexDependents(): void {
    const regexEl = $('vsd-regex') as HTMLInputElement | null;
    const wordEl = $('vsd-word') as HTMLInputElement | null;
    if (regexEl && wordEl) {
        // Regex + Whole-Word schließen sich aus (Backend lehnt sie ab).
        wordEl.disabled = regexEl.checked;
        if (regexEl.checked) wordEl.checked = false;
    }
}

/** Befüllt die Dialog-Felder aus dem committed State (bzw. dem Folder-Draft). */
function populateDialog(preselectScope?: ScopeMode): void {
    const query = $('vsd-query') as HTMLInputElement | null;
    const caseEl = $('vsd-case') as HTMLInputElement | null;
    const wordEl = $('vsd-word') as HTMLInputElement | null;
    const regexEl = $('vsd-regex') as HTMLInputElement | null;
    const hiddenEl = $('vsd-include-hidden') as HTMLInputElement | null;
    const ext = $('vsd-custom-ext') as HTMLInputElement | null;
    const folderRow = $('vsd-scope-folder-row');
    const folderLabel = $('vsd-scope-folder-label');

    if (query) query.value = activeQuery;
    if (caseEl) caseEl.checked = caseSensitive;
    if (wordEl) wordEl.checked = wholeWord;
    if (regexEl) regexEl.checked = regex;
    if (hiddenEl) hiddenEl.checked = includeHidden;
    setRadio('vsd-filter', fileFilter);
    if (ext) ext.value = customExtensions;

    // Folder-Option nur, wenn ein Folder-Draft existiert.
    if (folderRow) folderRow.hidden = !folderDraftPath;
    if (folderLabel) {
        folderLabel.textContent = folderDraftPath
            ? t('search.dialog.scope.folder', { name: scopeFolderName(folderDraftPath) })
            : '';
    }

    let scopeMode: ScopeMode = preselectScope || currentScopeMode();
    if (scopeMode === 'folder' && !folderDraftPath) scopeMode = 'vault';
    setRadio('vsd-scope', scopeMode);

    syncRegexDependents();
    syncFilterDependents();
}

function focusDialogQuery(): void {
    const query = $('vsd-query') as HTMLInputElement | null;
    if (query) {
        query.focus();
        query.select();
    }
}

function closeDialog(restoreFocus: boolean): void {
    const dlg = $('vault-search-dialog');
    if (dlg) dlg.hidden = true;
    if (dialogUnwire) {
        dialogUnwire();
        dialogUnwire = null;
    }
    dialogOpen = false;
    const prev = dialogPrevFocus;
    dialogPrevFocus = null;
    if (restoreFocus && prev && typeof prev.focus === 'function') prev.focus();
}

async function submitDialog(): Promise<void> {
    const query = ($('vsd-query') as HTMLInputElement | null)?.value ?? '';
    const dCase = !!($('vsd-case') as HTMLInputElement | null)?.checked;
    const dRegex = !!($('vsd-regex') as HTMLInputElement | null)?.checked;
    // Whole-Word ist bei aktivem Regex disabled → als false werten.
    const dWord = !dRegex && !!($('vsd-word') as HTMLInputElement | null)?.checked;
    const dHidden = !!($('vsd-include-hidden') as HTMLInputElement | null)?.checked;
    const dFilter = normalizeFilter(radioValue('vsd-filter'));
    const dExt = ($('vsd-custom-ext') as HTMLInputElement | null)?.value ?? '';
    const dScope = (radioValue('vsd-scope') as ScopeMode | null) || 'vault';

    // 1. Feld-Validierung (Query/Regex/Filter/Custom-Endungen) vor jeder Aktion.
    try {
        await rawInvoke('vault_search_validate', {
            query,
            caseSensitive: dCase,
            wholeWord: dWord,
            regex: dRegex,
            fileFilter: dFilter,
            customExtensions: dExt,
            includeHidden: dHidden,
        });
    } catch (err) {
        showDialogError(String(err));
        return; // Dialog bleibt offen, laufender Lauf unangetastet.
    }

    // 2. OpenTabs-Scope: der Editor-Puffer muss VOR dem Snapshot im Backend
    //    liegen, sonst durchsucht das Backend veralteten DocumentStore-Text.
    if (dScope === 'openTabs') {
        try {
            await syncEditorTextToStoreRequired();
        } catch (err) {
            folioLog.warn('search', 'editor sync before open-tabs search failed', {
                error: String(err),
            });
            showDialogError(t('errors.search.startFailed'));
            return;
        }
    }

    // 3. Alten Lauf canceln, committed State setzen.
    cancelCurrent();
    gen++; // späte Events des alten Laufs verwerfen
    setRunning(false);
    activeQuery = query;
    caseSensitive = dCase;
    wholeWord = dWord;
    regex = dRegex;
    includeHidden = dHidden;
    fileFilter = dFilter;
    customExtensions = dExt;
    optionsTouched = true;
    if (dScope === 'folder' && folderDraftPath) {
        scopePath = folderDraftPath;
        openTabs = false;
    } else if (dScope === 'openTabs') {
        scopePath = null;
        openTabs = true;
    } else {
        scopePath = null;
        openTabs = false;
    }

    // 4. Persistieren (flüchtiger Scope wird nicht persistiert). Enthält auch
    //    die Ergebnis-Header-Toggles Pfad/Sortierung.
    persistSearchOptions();

    // 5. Dialog schließen, Suche starten, Summary/Chip rendern.
    closeDialog(false);
    renderScopeChip();
    renderSummary();
    enterSearch();
    runSearch();
    if (listEl && typeof listEl.focus === 'function') listEl.focus();
}

function onDialogKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void submitDialog();
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeDialog(true);
    }
}

function wireDialog(): void {
    const dlg = $('vault-search-dialog');
    const cancel = $('vsd-cancel');
    const submit = $('vsd-submit');
    const regexEl = $('vsd-regex');
    const filterRadios = Array.from(
        document.querySelectorAll('input[name="vsd-filter"]'),
    ) as HTMLInputElement[];
    if (!dlg) return;

    const onCancel = (): void => closeDialog(true);
    const onSubmit = (): void => {
        void submitDialog();
    };
    const onRegexChange = (): void => syncRegexDependents();
    const onFilterChange = (): void => syncFilterDependents();

    if (cancel) cancel.addEventListener('click', onCancel);
    if (submit) submit.addEventListener('click', onSubmit);
    if (regexEl) regexEl.addEventListener('change', onRegexChange);
    filterRadios.forEach((r) => r.addEventListener('change', onFilterChange));
    dlg.addEventListener('keydown', onDialogKeydown as EventListener);

    dialogUnwire = (): void => {
        if (cancel) cancel.removeEventListener('click', onCancel);
        if (submit) submit.removeEventListener('click', onSubmit);
        if (regexEl) regexEl.removeEventListener('change', onRegexChange);
        filterRadios.forEach((r) => r.removeEventListener('change', onFilterChange));
        dlg.removeEventListener('keydown', onDialogKeydown as EventListener);
    };
}

/** Öffnet den Such-Dialog (Strg+Shift+F, Menü, Summary-Klick, Kontextmenü).
 *  Idempotent: erneutes Öffnen re-populiert nur die Felder und fokussiert das
 *  Query-Feld — kein doppeltes Wiring, laufender Lauf bleibt.
 *
 *  `prefillQuery`: setzt nur den Draft-Query (kein Auto-Submit) — z. B.
 *  Tag-Browser „In Dateien suchen" mit `#tag`. */
export function openVaultSearchDialog(opts?: {
    folder?: string;
    prefillQuery?: string;
}): void {
    const dlg = $('vault-search-dialog');
    if (!dlg) return;
    let preselect: ScopeMode | undefined;
    if (opts && opts.folder) {
        folderDraftPath = normalizePath(opts.folder);
        preselect = 'folder';
    } else if (scopePath) {
        folderDraftPath = scopePath;
    }
    if (dialogOpen) {
        populateDialog(preselect);
        if (opts && typeof opts.prefillQuery === 'string') {
            applyPrefillQuery(opts.prefillQuery);
        }
        clearDialogError();
        focusDialogQuery();
        return;
    }
    dialogOpen = true;
    dialogPrevFocus = document.activeElement as HTMLElement | null;
    populateDialog(preselect);
    if (opts && typeof opts.prefillQuery === 'string') {
        applyPrefillQuery(opts.prefillQuery);
    }
    clearDialogError();
    dlg.hidden = false;
    wireDialog();
    focusDialogQuery();
}

function applyPrefillQuery(query: string): void {
    const input = $('vsd-query') as HTMLInputElement | null;
    if (input) input.value = query;
}

/** Kontextmenü „In diesem Ordner suchen": Folder-Draft setzen und den Dialog
 *  öffnen [Sol#7] — der committed Scope ändert sich erst beim Submit. */
export function searchInFolder(path: string): void {
    if (!path) return;
    openVaultSearchDialog({ folder: path });
}

// ----- Strg+Shift+F --------------------------------------------------------

function onGlobalKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        openVaultSearchDialog();
    }
}

/** [S5-Punkt 1] Escape großzügiger: verlässt den Suchmodus auch mit Fokus auf
 *  Summary/Exit/Ergebnis-Header (bubbelt bis `#vault-region`). Feuert NICHT bei
 *  offenem Dialog (der hat sein eigenes Escape) und nur bei aktivem Suchmodus.
 *  Die Ergebnisliste hat weiterhin ihren eigenen Escape-Handler
 *  (`onListKeydown`), der zuerst greift und die Klasse entfernt → die Guard hier
 *  verhindert eine doppelte Ausführung. Die Find-Bar behandelt Escape nur am
 *  eigenen Input, daher keine Interferenz. */
function onRegionKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (dialogOpen) return;
    if (!region || !region.classList.contains('vault-searching')) return;
    exitSearch();
    e.preventDefault();
}

// ----- Init / Dispose -------------------------------------------------------

/** Initialisiert das Such-Panel. Gibt eine Dispose-Funktion zurück, die alle
 *  Listener (DOM + Tauri + globaler Key-Handler) wieder abmeldet — vor allem
 *  für jsdom-Tests, damit Handler zwischen Fällen nicht akkumulieren. */
export function initVaultSearch(d: Deps): () => void {
    deps = d;
    region = $('vault-region');
    summaryBtn = $('vault-search-summary');
    summaryTextEl = $('vault-search-summary-text');
    summaryOptsEl = $('vault-search-summary-opts');
    resultsEl = $('vault-search-results');
    statusEl = $('vault-search-status');
    listEl = $('vault-search-list');
    scopeEl = $('vault-search-scope');
    sortBtn = $('vault-search-sort');
    sortLabelEl = $('vault-search-sort-label');
    pathsBtn = $('vault-search-paths');
    if (!summaryBtn || !resultsEl || !listEl) return () => {};

    optionsTouched = false;
    scopePath = null;
    openTabs = false;
    activeQuery = '';
    folderDraftPath = null;
    renderScopeChip();
    renderSummary();
    renderSortButton();
    renderPathsToggle();

    // Persistierte Optionen laden — aber einen inzwischen per Submit gesetzten
    // Zustand nicht überschreiben.
    safeInvoke<{
        caseSensitive?: boolean;
        wholeWord?: boolean;
        regex?: boolean;
        fileFilter?: string;
        customExtensions?: string;
        includeHidden?: boolean;
        showPaths?: boolean;
        sort?: string;
    }>('search_options_get', undefined, 'search_options_get', 'debug').then((opts) => {
        if (optionsTouched) return;
        if (opts && typeof opts === 'object') {
            caseSensitive = !!opts.caseSensitive;
            wholeWord = !!opts.wholeWord;
            regex = !!opts.regex;
            fileFilter = normalizeFilter(opts.fileFilter);
            customExtensions = typeof opts.customExtensions === 'string' ? opts.customExtensions : '';
            includeHidden = !!opts.includeHidden;
            showPaths = !!opts.showPaths;
            searchSort = normalizeSort(opts.sort);
            renderSortButton();
            renderPathsToggle();
        }
    });

    // [S7] Pfad-Darstellung ist ein App-Setting (nicht Teil der panel_state-
    // Suchoptionen): Startwert aus settings_get, Live-Update via settings:changed.
    safeInvoke<{ searchPathDisplay?: string }>(
        'settings_get',
        undefined,
        'settings_get',
        'debug',
    ).then((data) => {
        // [Sol-Rev S7#5] Ein zwischenzeitliches Live-`settings:changed` gewinnt:
        // in dem Fall die Boot-Antwort verwerfen (sonst könnte sie einen bereits
        // korrekt angewandten neueren Wert still überschreiben). Sonst über
        // `setPathDisplay()` anwenden (Re-Sort/Re-Render statt roher Zuweisung).
        if (pathDisplaySettingsEventSeen) return;
        if (data && typeof data === 'object') {
            setPathDisplay(normalizePathDisplay(data.searchPathDisplay));
        }
    });

    const summaryClick = (): void => openVaultSearchDialog();
    const collapseAllBtn = $('vault-search-collapse-all');
    const expandAllBtn = $('vault-search-expand-all');
    const exitBtn = $('vault-search-exit');
    const localSort = sortBtn;
    const localPaths = pathsBtn;
    summaryBtn.addEventListener('click', summaryClick);
    if (collapseAllBtn) collapseAllBtn.addEventListener('click', collapseAll);
    if (expandAllBtn) expandAllBtn.addEventListener('click', expandAll);
    if (exitBtn) exitBtn.addEventListener('click', exitSearch);
    if (localSort) localSort.addEventListener('click', cycleSort);
    if (localPaths) localPaths.addEventListener('click', togglePaths);
    listEl.addEventListener('click', onResultClick as EventListener);
    listEl.addEventListener('auxclick', onResultAux as EventListener);
    listEl.addEventListener('keydown', onListKeydown as EventListener);
    const scopeClick = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.vs-scope-x')) clearScope();
    };
    if (scopeEl) scopeEl.addEventListener('click', scopeClick as EventListener);
    if (region) region.addEventListener('keydown', onRegionKeydown as EventListener);
    window.addEventListener('folio-doc-kind-changed', onDocKindChanged);
    document.addEventListener('keydown', onGlobalKey, { capture: true });

    const unlistenPromises: Array<Promise<() => void>> = [];
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && typeof ev.listen === 'function') {
        unlistenPromises.push(ev.listen('search:hits', (e: any) => onHits(e && e.payload)));
        unlistenPromises.push(ev.listen('search:done', (e: any) => onDone(e && e.payload)));
        unlistenPromises.push(
            ev.listen('settings:changed', (e: any) => onSettingsChanged(e && e.payload)),
        );
    }

    const localSummary = summaryBtn;
    const localCollapseAll = collapseAllBtn;
    const localExpandAll = expandAllBtn;
    const localExit = exitBtn;
    const localList = listEl;
    const localScope = scopeEl;
    const localRegion = region;
    return function dispose(): void {
        if (dialogOpen) closeDialog(false);
        localSummary.removeEventListener('click', summaryClick);
        if (localCollapseAll) localCollapseAll.removeEventListener('click', collapseAll);
        if (localExpandAll) localExpandAll.removeEventListener('click', expandAll);
        if (localExit) localExit.removeEventListener('click', exitSearch);
        if (localSort) localSort.removeEventListener('click', cycleSort);
        if (localPaths) localPaths.removeEventListener('click', togglePaths);
        localList.removeEventListener('click', onResultClick as EventListener);
        localList.removeEventListener('auxclick', onResultAux as EventListener);
        localList.removeEventListener('keydown', onListKeydown as EventListener);
        if (localScope) localScope.removeEventListener('click', scopeClick as EventListener);
        if (localRegion) localRegion.removeEventListener('keydown', onRegionKeydown as EventListener);
        window.removeEventListener('folio-doc-kind-changed', onDocKindChanged);
        document.removeEventListener('keydown', onGlobalKey, { capture: true } as any);
        unlistenPromises.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
}
