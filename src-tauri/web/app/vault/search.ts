/* Vault-Volltextsuche — Such-Panel im linken Rail (Etappe S2 + Fix-Paket).

   Verdrahtet das #vault-search-Feld mit dem Backend-Streaming
   (vault_search_start / vault_search_cancel + search:hits/search:done),
   rendert die Treffer-Gruppen (mit <mark> exakt über die UTF-16-Ranges) und
   springt beim Klick zur Fundstelle (Edit/Split via Monaco revealMatch,
   View-Mode via Find-Bar). Optionen (Aa/W) persistieren über panel-state.

   Stale-Guard nach dem renderGen-Muster (view/preview.ts): jede neue Suche
   erhöht eine lokale Generation, cancelt den alten runId und akzeptiert nur
   Events des adoptierten runId. `search:hits` kann VOR der Auflösung des
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
import { fmtNumber } from '../i18n/format';

type Deps = {
    openDocument: (path: string) => void;
    showStatus?: (msg: string) => void;
    openLeftRail: () => void;
};

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

const DEBOUNCE_MS = 250;
const MIN_QUERY_LEN = 2;
const VIEW_FIND_CAP = 200;
const VIEW_SETTLE_TIMEOUT_MS = 2000;

let deps: Deps = { openDocument: () => {}, openLeftRail: () => {} };
let region: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let caseBtn: HTMLElement | null = null;
let wordBtn: HTMLElement | null = null;
let resultsEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;

let caseSensitive = false;
let wholeWord = false;
let optionsTouched = false; // User hat einen Toggle bedient (Boot-Restore-Guard)

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let gen = 0; // lokale Generation für Stale-Guard
let currentRunId = -1; // Backend-runId, dessen Events wir anwenden
let maxRunId = -1; // höchste je gesehene runId (verwirft abgebrochene Läufe)
let pendingHits: Record<number, FileResult[]> = {};
let pendingDone: Record<number, any> = {};

let files: FileResult[] = [];
let doneStats: Stats | null = null;
const collapsed = new Set<string>(); // eingeklappte Datei-Gruppen (per Pfad)
let flat: Array<{ f: number; h: number }> = [];
let activeIdx = -1;

let pendingJump: Jump | null = null;
// Einmal-Skip für den Navigation-Restore (tab_open): der Entry-Restore würde
// unseren Sprung mit Cursor/Scroll aus dem Entry überschreiben.
let navRestoreSkipPath: string | null = null;

// Ordner-Scope (S3): absoluter, normalisierter Pfad oder null = gesamter Vault.
// Flüchtig (nicht persistiert).
let scopePath: string | null = null;
let scopeEl: HTMLElement | null = null;
const FOLDER_SEARCH_SVG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>';

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function normalizePath(p: string | null | undefined): string {
    return (p || '').replace(/\\/g, '/');
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

function setStatus(msg: string): void {
    if (statusEl) statusEl.textContent = msg;
}

function totalHits(): number {
    let n = 0;
    for (const f of files) n += f.hits.length;
    return n;
}

// ----- Such-Modus an/aus (Tree ↔ Ergebnisse) --------------------------------

function enterSearch(): void {
    if (region) region.classList.add('vault-searching');
    if (resultsEl) resultsEl.hidden = false;
}

function exitSearch(): void {
    // Generation erhöhen, damit ausstehende Start-Promises nicht mehr adoptiert
    // werden, und alle Puffer + einen scharfen Sprung fallenlassen.
    gen++;
    cancelCurrent();
    pendingHits = {};
    pendingDone = {};
    pendingJump = null;
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (region) region.classList.remove('vault-searching');
    if (resultsEl) resultsEl.hidden = true;
    files = [];
    doneStats = null;
    flat = [];
    activeIdx = -1;
    if (listEl) listEl.innerHTML = '';
    setStatus('');
}

function cancelCurrent(): void {
    if (currentRunId >= 0) {
        safeInvoke('vault_search_cancel', { runId: currentRunId }, 'vault_search_cancel', 'debug');
    }
    currentRunId = -1;
}

// ----- Suche starten --------------------------------------------------------

function onInput(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    const q = input ? input.value : '';
    if (q === '') {
        exitSearch();
        return;
    }
    enterSearch();
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        runSearch(q);
    }, DEBOUNCE_MS);
}

function runSearch(q: string): void {
    // Ein neuer Lauf macht einen scharfen Sprung aus einer früheren Suche
    // gegenstandslos.
    pendingJump = null;
    if (Array.from(q).length < MIN_QUERY_LEN) {
        gen++;
        cancelCurrent();
        pendingHits = {};
        pendingDone = {};
        files = [];
        doneStats = null;
        activeIdx = -1;
        renderResults();
        setStatus(t('search.query.minLength.hint'));
        return;
    }
    const myGen = ++gen;
    const scopedAtStart = scopePath;
    cancelCurrent();
    pendingHits = {};
    pendingDone = {};
    files = [];
    doneStats = null;
    activeIdx = -1;
    renderResults();
    setStatus(t('search.status.runningSimple'));
    // Raw invoke (nicht safeInvoke), damit wir die Scope-Fehler
    // (RootNotFound/InvalidScope) vom generischen Startfehler unterscheiden.
    rawInvoke('vault_search_start', {
        query: q,
        scope: scopedAtStart,
        caseSensitive,
        wholeWord,
    }).then(
        (runId: any) => {
            if (typeof runId !== 'number') {
                if (myGen === gen) setStatus(t('errors.search.startFailed'));
                return;
            }
            if (runId > maxRunId) maxRunId = runId;
            if (myGen !== gen) {
                // Während des Await von einer neueren Suche überholt → canceln.
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
                runSearch(q);
                setStatus(t('search.scope.folderMissing.fallback'));
            } else {
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
    for (const f of newFiles) files.push(f);
    renderResults();
    setStatus(t('search.status.running', {
        hitsPart: tPlural('search.status.hitsPart', totalHits()),
        filesPart: tPlural('search.status.filesPart', files.length),
    }));
}

function applyDone(payload: any): void {
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
        // Vault-Scope + 0 gescannte Dateien = nichts Durchsuchbares im Vault
        // (leere Pins ODER nur Binärdateien); Ordner-Scope oder Pins mit
        // 0 Treffern liefern filesScanned>0.
        if (scopePath === null && s.filesScanned === 0) {
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
            ms: fmtNumber(s.elapsedMs),
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

// ----- Rendering ------------------------------------------------------------

function renderResults(): void {
    if (!listEl) return;
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

        const fname = document.createElement('span');
        fname.className = 'vs-fname';
        fname.textContent = f.fileName;

        const countEl = document.createElement('span');
        countEl.className = 'vs-count';
        countEl.textContent = String(count);

        head.appendChild(caret);
        head.appendChild(fname);
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

// ----- Keyboard-Navigation --------------------------------------------------

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

function onInputKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        if (input) input.value = '';
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

function openHit(fi: number, hi: number, newTab: boolean): void {
    const f = files[fi];
    if (!f) return;
    const h = f.hits[hi];
    if (!h) return;
    const term = input ? input.value : '';
    let matchOrdinal = 0;
    for (let i = 0; i < hi; i++) matchOrdinal += f.hits[i].ranges.length;
    pendingJump = {
        path: f.path,
        line: h.line,
        colUtf16: h.colUtf16,
        lenUtf16: h.lenUtf16,
        matchOrdinal,
        term,
        caseSensitive,
        wholeWord,
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

// ----- Optionen-Toggles -----------------------------------------------------

function syncOptButtons(): void {
    if (caseBtn) {
        caseBtn.classList.toggle('active', caseSensitive);
        caseBtn.setAttribute('aria-pressed', caseSensitive ? 'true' : 'false');
    }
    if (wordBtn) {
        wordBtn.classList.toggle('active', wholeWord);
        wordBtn.setAttribute('aria-pressed', wholeWord ? 'true' : 'false');
    }
}

function toggleOpt(which: 'case' | 'word'): void {
    optionsTouched = true;
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (which === 'case') caseSensitive = !caseSensitive;
    else wholeWord = !wholeWord;
    syncOptButtons();
    safeInvoke(
        'set_search_options',
        { caseSensitive, wholeWord },
        'set_search_options',
        'debug',
    );
    const q = input ? input.value : '';
    if (q !== '') runSearch(q); // laufende Suche mit neuen Optionen re-triggern
}

// ----- Ordner-Scope (S3) ----------------------------------------------------

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

function retriggerIfQuery(): void {
    const q = input ? input.value : '';
    if (Array.from(q).length >= MIN_QUERY_LEN) {
        // enterSearch, falls das Panel noch im Baum-Modus stand (Scope aus dem
        // Kontextmenü bei bereits gefülltem Suchfeld) — sonst blieben die
        // Ergebnisse unsichtbar.
        enterSearch();
        runSearch(q);
    }
}

/** Kontextmenü „In diesem Ordner suchen": Scope setzen, Panel fokussieren
 *  (Rail öffnen falls zu), laufende/letzte Suche mit neuem Scope re-triggern. */
export function searchInFolder(path: string): void {
    if (!path) return;
    scopePath = normalizePath(path);
    renderScopeChip();
    focusVaultSearch();
    retriggerIfQuery();
}

function clearScope(): void {
    if (!scopePath) return;
    scopePath = null;
    renderScopeChip();
    retriggerIfQuery();
}

// ----- Strg+Shift+F / Menü --------------------------------------------------

export function focusVaultSearch(): void {
    if (document.body.classList.contains('vault-hidden')) {
        deps.openLeftRail();
    }
    if (input) {
        input.focus();
        input.select();
    }
}

function onGlobalKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        focusVaultSearch();
    }
}

// ----- Init / Dispose -------------------------------------------------------

/** Initialisiert das Such-Panel. Gibt eine Dispose-Funktion zurück, die alle
 *  Listener (DOM + Tauri + globaler Key-Handler) wieder abmeldet — vor allem
 *  für jsdom-Tests, damit Handler zwischen Fällen nicht akkumulieren. */
export function initVaultSearch(d: Deps): () => void {
    deps = d;
    region = $('vault-region');
    input = $('vault-search-input') as HTMLInputElement | null;
    caseBtn = $('vault-search-case');
    wordBtn = $('vault-search-word');
    resultsEl = $('vault-search-results');
    statusEl = $('vault-search-status');
    listEl = $('vault-search-list');
    scopeEl = $('vault-search-scope');
    if (!input || !resultsEl || !listEl) return () => {};

    optionsTouched = false;
    scopePath = null;
    renderScopeChip();

    // Persistierte Optionen laden — aber einen inzwischen vom User gesetzten
    // Zustand nicht überschreiben.
    safeInvoke<{ caseSensitive?: boolean; wholeWord?: boolean }>(
        'search_options_get',
        undefined,
        'search_options_get',
        'debug',
    ).then((opts) => {
        if (optionsTouched) return;
        if (opts && typeof opts === 'object') {
            caseSensitive = !!opts.caseSensitive;
            wholeWord = !!opts.wholeWord;
            syncOptButtons();
        }
    });

    const caseHandler = () => toggleOpt('case');
    const wordHandler = () => toggleOpt('word');
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onInputKeydown);
    if (caseBtn) caseBtn.addEventListener('click', caseHandler);
    if (wordBtn) wordBtn.addEventListener('click', wordHandler);
    listEl.addEventListener('click', onResultClick as EventListener);
    listEl.addEventListener('auxclick', onResultAux as EventListener);
    const scopeClick = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.vs-scope-x')) clearScope();
    };
    if (scopeEl) scopeEl.addEventListener('click', scopeClick as EventListener);
    window.addEventListener('folio-doc-kind-changed', onDocKindChanged);
    document.addEventListener('keydown', onGlobalKey, { capture: true });

    const unlistenPromises: Array<Promise<() => void>> = [];
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && typeof ev.listen === 'function') {
        unlistenPromises.push(ev.listen('search:hits', (e: any) => onHits(e && e.payload)));
        unlistenPromises.push(ev.listen('search:done', (e: any) => onDone(e && e.payload)));
    }

    const localInput = input;
    const localCase = caseBtn;
    const localWord = wordBtn;
    const localList = listEl;
    const localScope = scopeEl;
    return function dispose(): void {
        localInput.removeEventListener('input', onInput);
        localInput.removeEventListener('keydown', onInputKeydown);
        if (localCase) localCase.removeEventListener('click', caseHandler);
        if (localWord) localWord.removeEventListener('click', wordHandler);
        localList.removeEventListener('click', onResultClick as EventListener);
        localList.removeEventListener('auxclick', onResultAux as EventListener);
        if (localScope) localScope.removeEventListener('click', scopeClick as EventListener);
        window.removeEventListener('folio-doc-kind-changed', onDocKindChanged);
        document.removeEventListener('keydown', onGlobalKey, { capture: true } as any);
        unlistenPromises.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
}
