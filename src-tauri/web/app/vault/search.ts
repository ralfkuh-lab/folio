/* Vault-Volltextsuche — Inhaltsfeld im gemeinsamen Such-/Filterbereich (S9).

   Der Bereich `#vault-filter` (Funnel im Vault-Kopf) traegt zwei Felder: oben
   den Namensfilter (vault/filter.ts), darunter das Inhaltsfeld
   `#vault-search-input` mit den Umschaltern Aa / ab / Rx. Enter im Inhaltsfeld
   sucht sofort; weitere Optionen (gitignorierte Dateien, Dateityp) liegen im
   Zahnrad-Popover `#vault-search-options` (natives `popover`).

   Ein Modell: die Suche durchsucht immer, was der Filter zeigt, ohne Filter
   den ganzen Vault (`getSearchSpace()` in filter.ts). Aendert sich der Filter
   waehrend einer aktiven Suche, wird entprellt neu gesucht.

   Stale-Guard nach dem renderGen-Muster (view/preview.ts): jede neue Suche
   erhöht eine lokale Generation (auch ueber die Await-Schritte der
   Filtermenge hinweg), cancelt den alten runId und akzeptiert nur Events des
   adoptierten runId. `search:hits` kann VOR der Auflösung des
   vault_search_start-Promise eintreffen → Events eines NEUEREN, noch nicht
   adoptierten runId werden gepuffert; Events eines bereits gesehenen
   (`<= maxRunId`) abgebrochenen Laufs werden verworfen (kein Endlos-Puffer).

   Sprung-Korrelation: statt roh auf `document:loaded` zu hören, wird auf das
   in-window CustomEvent `folio-doc-kind-changed` reagiert, das state/document.ts
   NACH dem Anwenden des Dokument-States dispatcht (erbt den seq-Stale-Guard,
   CLAUDE.md-Konvention „KI-Button-Gating"). Der Pfad kommt aus getCurrentPath(). */

import { folioLog, safeInvoke } from '../util/log';
import { setEditorFindTerm, findNext } from '../ui/find-bar';
import { getCurrentPath } from '../state/document';
// Direct modules — not the app/i18n barrel (that re-exports event-queue,
// whose import side-effect patches listen() and suppresses handlers until uiReady).
import { t, tPlural } from '../i18n/translate';
import { fmtNumber, getFormatLocale } from '../i18n/format';
import {
    closeVaultFilterBar,
    filterInFolder,
    getSearchSpace,
    isVaultFilterBarVisible,
    openVaultFilterBar,
    VAULT_FILTER_CHANGED_EVENT,
    whenFilterOptionsPersisted,
    type SearchSpace,
} from './filter';
import { isPathGitChanged } from './git-status';

type Deps = {
    openDocument: (path: string) => void;
    showStatus?: (msg: string) => void;
    openLeftRail: () => void;
};

/** Dateityp aus dem Popover. „Nur Markdown" gibt es dort nicht mehr — das
 *  deckt der `.md`-Chip ab (siehe `effectiveFileFilter`). */
type FileFilter = 'allText' | 'custom';
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

const VIEW_FIND_CAP = 200;
const VIEW_SETTLE_TIMEOUT_MS = 2000;
const AUTO_COLLAPSE_THRESHOLD = 10; // > 10 Treffergruppen → Auto-Einklappen
/** Entprellung des automatischen Neu-Suchens nach Filteraenderungen (zusaetzlich
 *  zum 150-ms-Debounce des Namensfilters). */
const RERUN_DEBOUNCE_MS = 300;

let deps: Deps = { openDocument: () => {}, openLeftRail: () => {} };
let region: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let clearBtn: HTMLElement | null = null;
let caseBtn: HTMLElement | null = null;
let wordBtn: HTMLElement | null = null;
let regexBtn: HTMLElement | null = null;
let errorEl: HTMLElement | null = null;
let gearBtn: HTMLElement | null = null;
let popoverEl: HTMLElement | null = null;
let ignoredEl: HTMLInputElement | null = null;
let extEl: HTMLInputElement | null = null;
let fileTypeHintEl: HTMLElement | null = null;
let resultsEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let sortBtn: HTMLElement | null = null;
let sortLabelEl: HTMLElement | null = null;
let pathsBtn: HTMLElement | null = null;

// ----- Committed State (Suchbegriff ändert sich nur bei gültigem Enter) -----
let activeQuery = '';
let caseSensitive = false;
let wholeWord = false;
let regex = false;
let fileFilter: FileFilter = 'allText';
let customExtensions = '';
// Gitignorierte Dateien zusaetzlich durchsuchen (Zahnrad-Popover, persistiert).
// Versteckte Eintraege steuert der `.*`-Chip des Filters.
let includeIgnored = false;
// S5-Ergebnis-Header-Optionen: Verzeichnispfad-Anzeige + Sortiermodus. Persistiert
// über set_search_options/search_options_get (Muster der S4-Felder).
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
// Suchraum des laufenden/letzten Laufs (Statuszusatz, Leerfaelle, git-Schnitt).
let runSpace: SearchSpace | null = null;
// Zahl der Dateien der Filtermenge des laufenden Laufs (nur `files`).
let runFileCount = 0;
// Deckel der Filtersuche (`vault_filter_find`) für die Statuszeile: Grund +
// Zahl der gelieferten Dateien (vor dem git-Schnitt).
let filteredTruncation: { reason: 'cap' | 'time'; found: number } | null = null;
let optionsTouched = false; // Nutzer hat Optionen gesetzt (Boot-Restore-Guard)
// Entprellter Neu-Lauf nach Filteraenderung.
let rerunTimer: ReturnType<typeof setTimeout> | null = null;
// Enter-/Options-Generation: nach dem Validate-Await nur der neueste Submit.
let submitGen = 0;

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

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function normalizePath(p: string | null | undefined): string {
    return (p || '').replace(/\\/g, '/');
}

/** Persistierter Dateityp. Ein Altwert `markdown` (frühere Dialog-Option
 *  „Nur Markdown") gilt als `allText` — Quelle für Markdown ist der `.md`-Chip. */
function normalizeFilter(v: unknown): FileFilter {
    return v === 'custom' ? 'custom' : 'allText';
}

/** Wirksamer Dateityp eines Laufs: `.md`-Chip an → `markdown`, sonst die
 *  Popover-Wahl. */
function effectiveFileFilter(space: SearchSpace): string {
    return space.markdown ? 'markdown' : fileFilter;
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

/** Ermittelt die Basis, gegen die `path` relativiert wird: die längste
 *  passende Pin-Wurzel (wie der Baum); kein Treffer → null (voller Pfad). */
function scopeRootFor(path: string): string | null {
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
 *  - `relative` ohne Root-Match (kein passender Pin): voller
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

// ----- Such-Modus an/aus (Tree ↔ Ergebnisse) --------------------------------

function enterSearch(): void {
    if (document.body.classList.contains('vault-hidden')) deps.openLeftRail();
    if (region) region.classList.add('vault-searching');
    if (resultsEl) resultsEl.hidden = false;
}

function isSearching(): boolean {
    return !!region && region.classList.contains('vault-searching');
}

/** Beendet den Suchmodus (Baum kommt zurück). Der Text im Inhaltsfeld bleibt
 *  stehen — Leeren ist Sache des Aufrufers (✕/Escape); beim Schließen des
 *  Bereichs bleibt der Begriff für ein erneutes Enter erhalten. */
function exitSearch(): void {
    // Liegt der Fokus im gleich ausgeblendeten Ergebnisbereich, würde er auf
    // einem display:none-Element stranden — vorher merken und danach ins
    // Inhaltsfeld verschieben (sofern der Bereich sichtbar ist).
    const active = document.activeElement as HTMLElement | null;
    const focusWasHidden = !!active && !!resultsEl && resultsEl.contains(active);
    // Generation erhöhen, damit ausstehende Start-Promises nicht mehr adoptiert
    // werden, und alle Puffer + einen scharfen Sprung fallenlassen. Auch ein
    // noch in der Validierung steckendes Enter/Options-Submit verfällt.
    gen++;
    submitGen++;
    clearRerun();
    cancelCurrent();
    pendingHits = {};
    pendingDone = {};
    pendingJump = null;
    setRunning(false);
    if (region) region.classList.remove('vault-searching');
    if (resultsEl) resultsEl.hidden = true;
    activeQuery = '';
    runSpace = null;
    files = [];
    arrivalCounter = 0;
    doneStats = null;
    flat = [];
    activeIdx = -1;
    collapsed.clear();
    if (listEl) listEl.innerHTML = '';
    setStatus('');
    if (focusWasHidden && inputEl && isVaultFilterBarVisible()) inputEl.focus();
}

function cancelCurrent(): void {
    if (currentRunId >= 0) {
        safeInvoke('vault_search_cancel', { runId: currentRunId }, 'vault_search_cancel', 'debug');
    }
    currentRunId = -1;
}

function clearRerun(): void {
    if (rerunTimer !== null) {
        clearTimeout(rerunTimer);
        rerunTimer = null;
    }
}

// ----- Suche starten --------------------------------------------------------

/** Startet einen Lauf mit dem committed Begriff über dem aktuellen Suchraum
 *  des Filters. Ohne Namensbegriff ein Walk (`Vault`/`Folder`), mit
 *  Namensbegriff die Dateiliste aus `vault_filter_find` (ggf. git-Schnitt).
 *  Jede Stufe prüft nach ihrem Await die Generation: ein neuerer Lauf (oder
 *  exitSearch) gewinnt immer. */
async function runSearch(): Promise<void> {
    // Ein neuer Lauf macht einen scharfen Sprung aus einer früheren Suche
    // gegenstandslos.
    pendingJump = null;
    clearRerun();
    const myGen = ++gen;
    const space = getSearchSpace();
    cancelCurrent();
    pendingHits = {};
    pendingDone = {};
    files = [];
    arrivalCounter = 0;
    doneStats = null;
    activeIdx = -1;
    runSpace = space;
    runFileCount = 0;
    filteredTruncation = null;
    resetCollapseState();
    renderResults();
    setRunning(true);
    setStatus(t('search.status.runningSimple') + spaceSuffix());

    const args: Record<string, unknown> = {
        query: activeQuery,
        caseSensitive,
        wholeWord: regex ? false : wholeWord,
        regex,
        fileFilter: effectiveFileFilter(space),
        customExtensions,
        includeIgnored,
    };
    if (space.kind === 'files') {
        // `vault_filter_find` liest `.md` aus dem Backend: erst die
        // eingereihten Filter-Options-Writes abwarten.
        let res: any;
        try {
            await whenFilterOptionsPersisted();
            if (myGen !== gen) return;
            res = await rawInvoke('vault_filter_find', {
                query: space.query,
                scope: space.scope,
                hidden: space.hidden,
            });
        } catch (err) {
            if (myGen !== gen) return;
            failRun(String(err));
            return;
        }
        if (myGen !== gen) return;
        const found: string[] = Array.isArray(res && res.files)
            ? res.files
                  .filter((p: unknown): p is string => typeof p === 'string' && !!p)
                  .map((p: string) => normalizePath(p))
            : [];
        // git-Chip an → Schnitt mit den git-geänderten Dateien.
        const list = space.gitChangedOnly ? found.filter((p) => isPathGitChanged(p)) : found;
        if (res && res.truncated === true) {
            filteredTruncation = { reason: res.reason === 'time' ? 'time' : 'cap', found: found.length };
        }
        runFileCount = list.length;
        args.files = list;
        args.includeHidden = false;
    } else {
        args.scope = space.scope;
        args.includeHidden = space.includeHidden;
    }
    // Raw invoke (nicht safeInvoke): Startfehler (z. B. ein inzwischen
    // gelöschter Bereich) werden in der Statuszeile benannt.
    rawInvoke('vault_search_start', args).then(
        (runId: any) => {
            if (typeof runId !== 'number') {
                if (myGen === gen) failRun(t('errors.search.startFailed'));
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
            folioLog.warn('search', 'search start failed', { error: String(err) });
            failRun(String(err).replace(/^scope:/, ''));
        },
    );
}

function failRun(detail: string): void {
    setRunning(false);
    setStatus(t('search.status.error', { detail }));
}

/** Statuszusatz: worin gesucht wurde (gefiltert vs. ganzer Vault). */
function spaceSuffix(): string {
    if (!runSpace) return '';
    return runSpace.filtered ? t('search.status.spaceFiltered') : t('search.status.spaceVault');
}

/** Walk mit aktivem git-Chip (ohne Namensbegriff): die Filtermenge ist nicht
 *  als Liste abrufbar — Treffer außerhalb der git-geänderten Dateien werden
 *  wie im Baum clientseitig verworfen. */
function gitPostFilter(): boolean {
    return !!runSpace && runSpace.kind === 'walk' && runSpace.gitChangedOnly;
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

function applyHits(incoming: FileResult[]): void {
    const newFiles = gitPostFilter()
        ? incoming.filter((f) => isPathGitChanged(normalizePath(f.path)))
        : incoming;
    if (newFiles.length === 0) return;
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
    }) + spaceSuffix());
}

function applyDone(payload: any): void {
    setRunning(false);
    if (payload.error) {
        setStatus(t('search.status.error', { detail: String(payload.error) }) + spaceSuffix());
        folioLog.warn('search', 'search done with error', { error: String(payload.error) });
        return;
    }
    doneStats = (payload.stats as Stats) || null;
    finalStatus();
}

function finalStatus(): void {
    if (!doneStats) return;
    // Walk mit git-Schnitt: Treffer/Dateien zählen nur die übrig gebliebenen.
    const s: Stats = gitPostFilter()
        ? { ...doneStats, hits: totalHits(), filesMatched: files.length }
        : doneStats;
    const space = runSpace;
    // 1. Basissatz wählen …
    let msg: string;
    if (s.hits === 0) {
        if (space && space.kind === 'files' && runFileCount === 0) {
            // Der Vault-Filter lieferte keine Dateien.
            msg = t('search.status.noFilteredFiles');
        } else if (space && space.kind === 'walk' && space.scope === null && s.filesScanned === 0) {
            // Vault-Walk + 0 gescannte Dateien = nichts Durchsuchbares im Vault
            // (leere Pins ODER nur Binärdateien); ein Bereich oder Pins mit
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
    msg += spaceSuffix();
    // Kein stilles Teilergebnis: eine gedeckelte Filtermenge wird benannt.
    if (filteredTruncation) {
        msg +=
            filteredTruncation.reason === 'time'
                ? t('search.status.filteredTime')
                : t('search.status.filteredCapped', {
                      max: fmtNumber(filteredTruncation.found),
                  });
    }
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

/** Persistiert den Optionssatz (Umschalter am Inhaltsfeld, Popover und die
 *  Ergebnis-Header-Toggles Pfad/Sortierung). `includeHidden` fehlt bewusst:
 *  versteckte Einträge steuert der `.*`-Chip des Filters. */
function persistSearchOptions(): void {
    safeInvoke(
        'set_search_options',
        {
            caseSensitive,
            wholeWord,
            regex,
            fileFilter,
            customExtensions,
            includeIgnored,
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

// ----- Inhaltsfeld + Umschalter --------------------------------------------

function setPressed(el: HTMLElement | null, on: boolean): void {
    if (!el) return;
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.classList.toggle('active', on);
}

/** Aa / ab / Rx. Regex und Ganzes Wort schließen sich aus (Rust-`regex` hat
 *  keine Lookarounds) — bei Regex ist „ab" deaktiviert. */
function syncToggles(): void {
    setPressed(caseBtn, caseSensitive);
    setPressed(wordBtn, wholeWord && !regex);
    if (wordBtn) (wordBtn as HTMLButtonElement).disabled = regex;
    setPressed(regexBtn, regex);
}

function syncClear(): void {
    if (clearBtn && inputEl) clearBtn.hidden = inputEl.value.length === 0;
}

function showFieldError(msg: string): void {
    if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
    }
    if (inputEl) {
        inputEl.classList.add('vs-invalid');
        inputEl.setAttribute('aria-invalid', 'true');
    }
}

function clearFieldError(): void {
    if (errorEl) {
        errorEl.hidden = true;
        errorEl.textContent = '';
    }
    if (inputEl) {
        inputEl.classList.remove('vs-invalid');
        inputEl.removeAttribute('aria-invalid');
    }
}

/** Popover-Zustand aus den Optionen. Der `.md`-Chip legt den Dateityp fest —
 *  die Radios sind dann deaktiviert und ein Hinweis erklärt warum. Das
 *  Endungsfeld wird hier NICHT befüllt (sonst überschriebe jeder
 *  Filterwechsel eine laufende Eingabe). */
function syncOptionsPopover(): void {
    const md = getSearchSpace().markdown;
    if (ignoredEl) ignoredEl.checked = includeIgnored;
    const radios = document.querySelectorAll('input[name="vault-search-filetype"]');
    radios.forEach((r) => {
        const radio = r as HTMLInputElement;
        radio.checked = radio.value === fileFilter;
        radio.disabled = md;
    });
    if (extEl) extEl.disabled = md || fileFilter !== 'custom';
    if (fileTypeHintEl) fileTypeHintEl.hidden = !md;
}

/** Enter im Inhaltsfeld (bzw. Optionswechsel bei aktiver Suche): prüfen, dann
 *  sofort suchen. Ungültige Eingaben (zu kurz, kaputtes Regex, ungültige
 *  Endungen) erscheinen am Feld; es startet kein Lauf. Leeres Feld beendet die
 *  Suche. */
/** Der für `vault_search_validate` relevante Optionssatz (ohne Begriff). */
function validationOptions(): Record<string, unknown> {
    return {
        caseSensitive,
        wholeWord: regex ? false : wholeWord,
        regex,
        fileFilter: effectiveFileFilter(getSearchSpace()),
        customExtensions,
        includeIgnored,
    };
}

async function submitField(): Promise<void> {
    if (!inputEl) return;
    const mySubmit = ++submitGen;
    const query = inputEl.value;
    if (query.length === 0) {
        clearFieldError();
        if (isSearching()) exitSearch();
        return;
    }
    // Der validierungsrelevante Optionssatz kann sich während des Awaits ändern
    // (v. a. `.md` → wirksamer `fileFilter`, aber auch Aa/ab/Rx und Popover).
    // Eine Antwort zum alten Satz wird verworfen und mit dem aktuellen Satz
    // neu validiert — der Begriff bleibt erhalten.
    for (;;) {
        const options = validationOptions();
        const optionsKey = JSON.stringify(options);
        const stale = (): boolean => JSON.stringify(validationOptions()) !== optionsKey;
        try {
            await rawInvoke('vault_search_validate', { query, ...options });
        } catch (err) {
            if (mySubmit !== submitGen) return; // neuerer Submit gewinnt
            if (stale()) continue;
            showFieldError(String(err));
            return; // laufender Lauf bleibt unangetastet
        }
        if (mySubmit !== submitGen) return;
        if (stale()) continue;
        break;
    }
    clearFieldError();
    activeQuery = query;
    enterSearch();
    void runSearch();
}

/** Ein Optionswechsel (Umschalter, Popover) wird persistiert und wirkt bei
 *  aktiver Suche sofort. */
function onOptionChanged(): void {
    optionsTouched = true;
    syncToggles();
    syncOptionsPopover();
    persistSearchOptions();
    if (isSearching()) void submitField();
}

function clearField(): void {
    // Ein ausstehendes Enter darf nach dem Leeren weder starten noch einen
    // Fehler zurückbringen — auch wenn der Suchmodus noch nicht aktiv ist.
    submitGen++;
    if (inputEl) inputEl.value = '';
    syncClear();
    clearFieldError();
    if (isSearching()) exitSearch();
}

function onInputKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
        e.preventDefault();
        void submitField();
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (inputEl && inputEl.value.length > 0) clearField();
        else closeVaultFilterBar();
        return;
    }
    if (e.key === 'ArrowDown' && isSearching() && flat.length > 0 && listEl) {
        e.preventDefault();
        listEl.focus();
        moveActive(1);
    }
}

/** Filter geändert: geschlossener Bereich (Funnel, Escape, Reset) beendet die
 *  Suche und verwirft ein ausstehendes Enter. Bei aktiver Suche wird der
 *  bisherige Lauf SOFORT ungültig (Generation + Cancel) — alte Options-/Find-/
 *  Start-Antworten und `search:hits`/`search:done` wirken im Entprell-Fenster
 *  nicht mehr; nur der Start des neuen Laufs ist entprellt. */
function onFilterChanged(): void {
    syncOptionsPopover();
    if (!isVaultFilterBarVisible()) {
        submitGen++;
        clearFieldError();
        if (isSearching()) exitSearch();
        return;
    }
    if (!isSearching()) return;
    clearRerun();
    gen++;
    cancelCurrent();
    pendingHits = {};
    pendingDone = {};
    pendingJump = null;
    setRunning(true);
    setStatus(t('search.status.runningSimple'));
    rerunTimer = setTimeout(() => {
        rerunTimer = null;
        if (isSearching()) void runSearch();
    }, RERUN_DEBOUNCE_MS);
}

// ----- Zahnrad-Popover (natives `popover`) ----------------------------------

/** Unter dem Zahnrad ausrichten, rechtsbündig zu ihm (das Popover liegt im
 *  Top-Layer und soll möglichst innerhalb der Rail bleiben). */
function positionPopover(): void {
    if (!popoverEl || !gearBtn) return;
    const rect = gearBtn.getBoundingClientRect();
    const width = popoverEl.offsetWidth || 250;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    popoverEl.style.top = rect.bottom + 4 + 'px';
    popoverEl.style.left = left + 'px';
}

function onPopoverBeforeToggle(e: Event): void {
    if ((e as Event & { newState?: string }).newState === 'open') {
        syncOptionsPopover();
        if (extEl) extEl.value = customExtensions;
        positionPopover();
    }
}

/** Beim Öffnen den Fokus aufs erste Feld (kein `autofocus`-Attribut: das
 *  würde beim Laden der Seite um den Fokus konkurrieren). */
function onPopoverToggle(e: Event): void {
    const open = (e as Event & { newState?: string }).newState === 'open';
    if (gearBtn) gearBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && ignoredEl) ignoredEl.focus();
}

function isPopoverOpen(): boolean {
    if (!popoverEl) return false;
    try {
        return popoverEl.matches(':popover-open');
    } catch {
        return false; // Umgebung ohne Popover-Unterstützung
    }
}

/** Escape bei offenem Popover hat Vorrang — unabhängig vom Fokus (das native
 *  Popover ist nicht modal, Tab führt hinaus in Feld, Liste oder Kopf): Popover
 *  schließen, Fokus ans Zahnrad, Suche bleibt. Läuft in der Capture-Phase auf
 *  `#vault-region`, also vor den Feld-/Listen-/Region-Handlern. */
function onEscapeCapture(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !isPopoverOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    const pop = popoverEl as (HTMLElement & { hidePopover?: () => void }) | null;
    if (pop && typeof pop.hidePopover === 'function') {
        try {
            pop.hidePopover();
        } catch {
            // bereits geschlossen
        }
    }
    if (gearBtn) gearBtn.focus();
}

function onPopoverChange(e: Event): void {
    const target = e.target as HTMLInputElement | null;
    if (!target) return;
    if (target === ignoredEl) {
        includeIgnored = target.checked;
    } else if (target.name === 'vault-search-filetype') {
        fileFilter = normalizeFilter(target.value);
    } else if (target === extEl) {
        customExtensions = target.value;
    } else {
        return;
    }
    onOptionChanged();
}

// ----- Einstiege (Strg+Umschalt+F, Menü, Palette, Kontextmenü, Tags) -------

/** Öffnet den Such-/Filterbereich und fokussiert das Inhaltsfeld (Text
 *  selektiert). `query` ersetzt den Feldtext, `run` sucht sofort. */
export function openVaultSearch(opts?: { query?: string; run?: boolean }): void {
    openVaultFilterBar(false);
    if (!inputEl) return;
    if (opts && typeof opts.query === 'string') {
        inputEl.value = opts.query;
        syncClear();
    }
    inputEl.focus();
    inputEl.select();
    if (opts && opts.run) void submitField();
}

/** Kontextmenü „In diesem Ordner suchen": setzt den Filter-Bereich und
 *  fokussiert das Inhaltsfeld — dieselbe Darstellung wie gefiltertes Suchen. */
export function searchInFolder(path: string): void {
    if (!path) return;
    filterInFolder(path);
    openVaultSearch();
}

function onGlobalKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        openVaultSearch();
    }
}

/** Escape großzügiger: verlässt den Suchmodus auch mit Fokus auf dem
 *  Ergebnis-Header (bubbelt bis `#vault-region`). Die Felder und das Popover
 *  behandeln Escape selbst und stoppen die Weitergabe; die Ergebnisliste hat
 *  ihren eigenen Handler, der zuerst greift. */
function onRegionKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (!isSearching()) return;
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
    inputEl = $('vault-search-input') as HTMLInputElement | null;
    clearBtn = $('vault-search-clear');
    caseBtn = $('vault-search-case');
    wordBtn = $('vault-search-word');
    regexBtn = $('vault-search-regex');
    errorEl = $('vault-search-error');
    gearBtn = $('vault-search-options-toggle');
    popoverEl = $('vault-search-options');
    ignoredEl = $('vault-search-include-ignored') as HTMLInputElement | null;
    extEl = $('vault-search-custom-ext') as HTMLInputElement | null;
    fileTypeHintEl = $('vault-search-filetype-hint');
    resultsEl = $('vault-search-results');
    statusEl = $('vault-search-status');
    listEl = $('vault-search-list');
    sortBtn = $('vault-search-sort');
    sortLabelEl = $('vault-search-sort-label');
    pathsBtn = $('vault-search-paths');
    if (!inputEl || !resultsEl || !listEl) return () => {};

    optionsTouched = false;
    activeQuery = '';
    runSpace = null;
    filteredTruncation = null;
    syncToggles();
    syncClear();
    syncOptionsPopover();
    renderSortButton();
    renderPathsToggle();

    // Persistierte Optionen laden — aber einen inzwischen gesetzten Zustand
    // nicht überschreiben.
    safeInvoke<{
        caseSensitive?: boolean;
        wholeWord?: boolean;
        regex?: boolean;
        fileFilter?: string;
        customExtensions?: string;
        includeIgnored?: boolean;
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
            includeIgnored = !!opts.includeIgnored;
            showPaths = !!opts.showPaths;
            searchSort = normalizeSort(opts.sort);
            syncToggles();
            syncOptionsPopover();
            if (extEl) extEl.value = customExtensions;
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

    const localInput = inputEl;
    const onInput = (): void => {
        syncClear();
        clearFieldError();
    };
    const onClear = (e: MouseEvent): void => {
        e.preventDefault();
        clearField();
        localInput.focus();
    };
    const toggle = (which: 'case' | 'word' | 'regex') => (e: MouseEvent): void => {
        e.preventDefault();
        if (which === 'case') caseSensitive = !caseSensitive;
        else if (which === 'word') wholeWord = !wholeWord;
        else regex = !regex;
        onOptionChanged();
    };
    const onCase = toggle('case');
    const onWord = toggle('word');
    const onRegex = toggle('regex');
    const collapseAllBtn = $('vault-search-collapse-all');
    const expandAllBtn = $('vault-search-expand-all');
    const localSort = sortBtn;
    const localPaths = pathsBtn;
    const localClear = clearBtn;
    const localCase = caseBtn;
    const localWord = wordBtn;
    const localRegex = regexBtn;
    const localPopover = popoverEl;
    localInput.addEventListener('input', onInput);
    localInput.addEventListener('keydown', onInputKeydown as EventListener);
    if (localClear) localClear.addEventListener('click', onClear as EventListener);
    if (localCase) localCase.addEventListener('click', onCase as EventListener);
    if (localWord) localWord.addEventListener('click', onWord as EventListener);
    if (localRegex) localRegex.addEventListener('click', onRegex as EventListener);
    if (localPopover) {
        localPopover.addEventListener('beforetoggle', onPopoverBeforeToggle);
        localPopover.addEventListener('toggle', onPopoverToggle);
        localPopover.addEventListener('change', onPopoverChange);
    }
    if (collapseAllBtn) collapseAllBtn.addEventListener('click', collapseAll);
    if (expandAllBtn) expandAllBtn.addEventListener('click', expandAll);
    if (localSort) localSort.addEventListener('click', cycleSort);
    if (localPaths) localPaths.addEventListener('click', togglePaths);
    listEl.addEventListener('click', onResultClick as EventListener);
    listEl.addEventListener('auxclick', onResultAux as EventListener);
    listEl.addEventListener('keydown', onListKeydown as EventListener);
    if (region) region.addEventListener('keydown', onRegionKeydown as EventListener);
    if (region) region.addEventListener('keydown', onEscapeCapture as EventListener, true);
    window.addEventListener('folio-doc-kind-changed', onDocKindChanged);
    window.addEventListener(VAULT_FILTER_CHANGED_EVENT, onFilterChanged);
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

    const localCollapseAll = collapseAllBtn;
    const localExpandAll = expandAllBtn;
    const localList = listEl;
    const localRegion = region;
    return function dispose(): void {
        clearRerun();
        localInput.removeEventListener('input', onInput);
        localInput.removeEventListener('keydown', onInputKeydown as EventListener);
        if (localClear) localClear.removeEventListener('click', onClear as EventListener);
        if (localCase) localCase.removeEventListener('click', onCase as EventListener);
        if (localWord) localWord.removeEventListener('click', onWord as EventListener);
        if (localRegex) localRegex.removeEventListener('click', onRegex as EventListener);
        if (localPopover) {
            localPopover.removeEventListener('beforetoggle', onPopoverBeforeToggle);
            localPopover.removeEventListener('toggle', onPopoverToggle);
            localPopover.removeEventListener('change', onPopoverChange);
        }
        if (localCollapseAll) localCollapseAll.removeEventListener('click', collapseAll);
        if (localExpandAll) localExpandAll.removeEventListener('click', expandAll);
        if (localSort) localSort.removeEventListener('click', cycleSort);
        if (localPaths) localPaths.removeEventListener('click', togglePaths);
        localList.removeEventListener('click', onResultClick as EventListener);
        localList.removeEventListener('auxclick', onResultAux as EventListener);
        localList.removeEventListener('keydown', onListKeydown as EventListener);
        if (localRegion) localRegion.removeEventListener('keydown', onRegionKeydown as EventListener);
        if (localRegion) {
            localRegion.removeEventListener('keydown', onEscapeCapture as EventListener, true);
        }
        window.removeEventListener('folio-doc-kind-changed', onDocKindChanged);
        window.removeEventListener(VAULT_FILTER_CHANGED_EVENT, onFilterChanged);
        document.removeEventListener('keydown', onGlobalKey, { capture: true } as any);
        unlistenPromises.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
}
