/* [[-Autocomplete für Markdown (Obsidian-kompatibel).
   Reine Prefix-/Filter-/Fence-Logik ist DOM-frei exportiert (vitest).
   Kandidaten kommen aus dem Wikilink-Index (`wikilink_candidates`, F7).
   Provider registriert sich einmal nach Monaco-Load. */

import { getMonaco } from './state';

export const PALETTE_CACHE_MS = 5000;
export const SUGGESTION_CAP = 50;

const IMAGE_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
]);

/** Kandidat aus `wikilink_candidates` (Backend). */
export type WikilinkCandidate = {
    path: string;
    name: string;
    relative: string;
    kind: string;
    insert: string;
};

/** @deprecated Alias — Tests/ältere Call-Sites. */
export type PaletteFile = {
    path: string;
    name: string;
    relative: string;
    kind?: string;
    insert?: string;
};

export type WikilinkPrefix =
    | {
        mode: 'file';
        embed: boolean;
        /** Text nach `[[` (ohne schließendes `]]`). */
        query: string;
        /** 0-basierter Index in linePrefix: erstes Zeichen nach `[[`. */
        rangeStart: number;
    }
    | {
        mode: 'heading';
        embed: boolean;
        /** Name vor `#` (leer = aktuelles Dokument). */
        name: string;
        /** Text nach `#`. */
        headingQuery: string;
        /** 0-basierter Index: erstes Zeichen nach `#`. */
        rangeStart: number;
    };

/**
 * Analysiert den Zeilenpräfix bis zum Cursor.
 * Aktiv nur bei offenem `[[…` / `![[…` ohne schließendes `]]`.
 */
export function parseWikilinkPrefix(linePrefix: string): WikilinkPrefix | null {
    if (typeof linePrefix !== 'string' || !linePrefix) return null;
    // Letztes offenes [[… ohne ]] im Rest der Zeile (bis Cursor).
    const m = linePrefix.match(/(!?)\[\[([^\]]*)$/);
    if (!m) return null;
    const embed = m[1] === '!';
    const content = m[2] || '';
    const matchStart = linePrefix.length - m[0].length;
    const afterBrackets = matchStart + m[1].length + 2; // nach `[[`

    const hash = content.indexOf('#');
    if (hash >= 0) {
        return {
            mode: 'heading',
            embed,
            name: content.slice(0, hash),
            headingQuery: content.slice(hash + 1),
            rangeStart: afterBrackets + hash + 1,
        };
    }
    return {
        mode: 'file',
        embed,
        query: content,
        rangeStart: afterBrackets,
    };
}

export function isImageFileName(name: string): boolean {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

export function isMarkdownFileName(name: string): boolean {
    return /\.md$/i.test(name);
}

/** Basename ohne `.md` (case-preserving). */
export function stripMdExtension(name: string): string {
    return name.replace(/\.md$/i, '');
}

/**
 * Insert-Text für eine Datei-Suggestion (Fallback, wenn Backend kein
 * `insert` liefert). MD: Basename ohne .md wenn im Set eindeutig, sonst
 * relative ohne .md. Bilder: voller Dateiname.
 */
export function chooseInsertText(entry: PaletteFile, mdFiles: PaletteFile[]): string {
    if (entry.insert) return entry.insert;
    if (isImageFileName(entry.name)) {
        return entry.name;
    }
    const stem = stripMdExtension(entry.name);
    const stemLower = stem.toLowerCase();
    let same = 0;
    for (const f of mdFiles) {
        if (stripMdExtension(f.name).toLowerCase() === stemLower) same += 1;
        if (same > 1) break;
    }
    if (same <= 1) return stem;
    return stripMdExtension(entry.relative.replace(/\\/g, '/'));
}

/** Verzeichnis eines absoluten Pfads (POSIX-normalisiert), '' ohne '/'. */
function dirOf(path: string): string {
    const norm = (path || '').replace(/\\/g, '/');
    const i = norm.lastIndexOf('/');
    return i < 0 ? '' : norm.slice(0, i);
}

/**
 * Proximity-Rang eines Kandidaten relativ zum aktuellen Dokument:
 * `[hoch, runter]` = Komponenten, die man vom Dokument-Verzeichnis
 * aufwärts bzw. danach abwärts gehen muss. Gleiche Ablage = [0,0],
 * Unterordner = [0,n], Elternordner schlägt Geschwisterordner.
 * Exportiert für Tests.
 */
export function proximityRank(candidatePath: string, currentDocPath: string): [number, number] {
    const docDir = dirOf(currentDocPath);
    const candDir = dirOf(candidatePath);
    if (!docDir) return [0, 0];
    const a = docDir.toLowerCase().split('/');
    const b = candDir.toLowerCase().split('/');
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
    return [a.length - common, b.length - common];
}

/**
 * Filtert Kandidaten für den aktuellen Prefix (md; Bilder nur bei embed)
 * und sortiert sie VOR dem 50er-Cap nach Nähe zum aktuellen Dokument
 * (gleiches Verzeichnis > darunter > nächstgelegene Nachbarn), Tiebreak
 * alphabetisch nach relative — sonst schnitte der Cap nahe Treffer ab.
 */
export function filterPaletteFiles(
    files: Array<PaletteFile | WikilinkCandidate>,
    query: string,
    embed: boolean,
    currentDocPath?: string | null,
): Array<PaletteFile | WikilinkCandidate> {
    const q = (query || '').toLowerCase();
    const matches: Array<PaletteFile | WikilinkCandidate> = [];
    for (const f of files) {
        const kind = (f as WikilinkCandidate).kind;
        const isMd = kind === 'markdown' || (!kind && isMarkdownFileName(f.name));
        const isImg = kind === 'image' || (!kind && isImageFileName(f.name));
        if (isMd) {
            // always ok
        } else if (embed && isImg) {
            // ok
        } else {
            continue;
        }
        if (q) {
            const name = f.name.toLowerCase();
            const rel = (f.relative || '').toLowerCase();
            const insert = ((f as WikilinkCandidate).insert || '').toLowerCase();
            if (
                !name.includes(q)
                && !rel.includes(q)
                && !stripMdExtension(name).includes(q)
                && !insert.includes(q)
            ) {
                continue;
            }
        }
        matches.push(f);
    }
    if (currentDocPath) {
        const ranks = new Map<PaletteFile | WikilinkCandidate, [number, number]>();
        for (const f of matches) ranks.set(f, proximityRank(f.path, currentDocPath));
        matches.sort((x, y) => {
            const rx = ranks.get(x)!;
            const ry = ranks.get(y)!;
            if (rx[0] !== ry[0]) return rx[0] - ry[0];
            if (rx[1] !== ry[1]) return rx[1] - ry[1];
            return (x.relative || '').toLowerCase().localeCompare((y.relative || '').toLowerCase());
        });
    }
    return matches.slice(0, SUGGESTION_CAP);
}

export function filterHeadings(
    headings: Array<{ text: string; level: number }>,
    query: string,
): Array<{ text: string; level: number }> {
    const q = (query || '').toLowerCase();
    const out: Array<{ text: string; level: number }> = [];
    for (const h of headings) {
        if (q && !(h.text || '').toLowerCase().includes(q)) continue;
        out.push(h);
        if (out.length >= SUGGESTION_CAP) break;
    }
    return out;
}

// ----- Fence / Inline-Code-Gate (F10) -------------------------------------

/**
 * True, wenn die Zeile `lineIndex` (0-basiert) in einem Code-Fence liegt.
 * Scannt Zeilen `0..lineIndex-1` auf ```-/~~~-Toggles (CommonMark: gleicher
 * Marker-Char, Schließen mit ≥ Länge). Ungerade = drin → keine Suggestions.
 */
export function isInsideCodeFence(lines: readonly string[], lineIndex: number): boolean {
    let open: { ch: string; len: number } | null = null;
    const limit = Math.min(lineIndex, lines.length);
    for (let i = 0; i < limit; i++) {
        const line = lines[i] ?? '';
        // Fence-Zeile: optionaler Indent + ```… / ~~~… am Zeilenanfang.
        const m = line.match(/^[\t ]*(`{3,}|~{3,})/);
        if (!m) continue;
        const fence = m[1];
        const ch = fence[0];
        const len = fence.length;
        if (!open) {
            open = { ch, len };
        } else if (open.ch === ch && len >= open.len) {
            open = null;
        }
    }
    return open !== null;
}

/**
 * True, wenn der Zeilenpräfix in einem ungeschlossenen Inline-`` ` ``-Span
 * endet (ungerade Anzahl Backticks vor dem Cursor).
 */
export function isInUnclosedInlineCode(linePrefix: string): boolean {
    if (!linePrefix) return false;
    let odd = false;
    for (let i = 0; i < linePrefix.length; i++) {
        if (linePrefix[i] === '`') odd = !odd;
    }
    return odd;
}

/**
 * Kombiniert Fence + Inline-Gate für den Cursor.
 * `lines` = alle Model-Zeilen (0-basiert); `lineIndex` = aktuelle Zeile;
 * `linePrefix` = Text bis Cursor.
 */
export function shouldSuppressWikilinkComplete(
    lines: readonly string[],
    lineIndex: number,
    linePrefix: string,
): boolean {
    if (isInsideCodeFence(lines, lineIndex)) return true;
    if (isInUnclosedInlineCode(linePrefix)) return true;
    return false;
}

// ----- Provider / Cache (Monaco) ------------------------------------------

let registered = false;
let candidateCache: { at: number; path: string | null; files: WikilinkCandidate[] } | null = null;

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') {
        return Promise.reject(new Error('Tauri invoke not available'));
    }
    return core.invoke(cmd, args) as Promise<T>;
}

async function loadCandidates(): Promise<WikilinkCandidate[]> {
    const now = Date.now();
    const currentPath = currentDocumentPath();
    if (
        candidateCache
        && now - candidateCache.at < PALETTE_CACHE_MS
        && candidateCache.path === currentPath
    ) {
        return candidateCache.files;
    }
    // W7: currentPath steuert lokalitätsbewusste Insert-Verkürzung.
    const args = currentPath ? { currentPath } : {};
    const res = await tauriInvoke<WikilinkCandidate[]>('wikilink_candidates', args);
    const files = Array.isArray(res) ? res : [];
    candidateCache = { at: now, path: currentPath, files };
    return files;
}

function currentDocumentPath(): string | null {
    // Shell spiegelt den aktiven Pfad oft auf window; defensive Fallbacks.
    try {
        const w = window as any;
        if (typeof w.__folioCurrentPath === 'string') return w.__folioCurrentPath;
    } catch { /* ignore */ }
    return null;
}

/**
 * Optional: Shell kann den aktuellen Pfad setzen, damit `[[#` die
 * Überschriften des aktiven Dokuments liefern kann.
 */
export function setWikilinkCompleteCurrentPath(path: string | null): void {
    (window as any).__folioCurrentPath = path || null;
}

async function resolveCurrentPath(): Promise<string | null> {
    const cached = currentDocumentPath();
    if (cached) return cached;
    return null;
}

export function registerWikilinkCompletion(): void {
    if (registered) return;
    const monaco = getMonaco() || (window as any).monaco;
    if (!monaco || !monaco.languages || typeof monaco.languages.registerCompletionItemProvider !== 'function') {
        return;
    }
    registered = true;

    monaco.languages.registerCompletionItemProvider('markdown', {
        triggerCharacters: ['[', '#', '/'],
        provideCompletionItems: async function (
            model: any,
            position: { lineNumber: number; column: number },
        ) {
            try {
                const lineNumber = position.lineNumber;
                const line = model.getLineContent(lineNumber) as string;
                const prefix = line.substring(0, Math.max(0, position.column - 1));

                // F10: keine Suggestions in Code-Fences / unclosed Inline-Code.
                const lineCount = typeof model.getLineCount === 'function' ? model.getLineCount() : lineNumber;
                const lines: string[] = [];
                for (let i = 1; i <= lineCount; i++) {
                    lines.push(model.getLineContent(i) as string);
                }
                if (shouldSuppressWikilinkComplete(lines, lineNumber - 1, prefix)) {
                    return { suggestions: [] };
                }

                const ctx = parseWikilinkPrefix(prefix);
                if (!ctx) return { suggestions: [] };

                if (ctx.mode === 'heading') {
                    return await provideHeadings(monaco, model, position, ctx);
                }
                return await provideFiles(monaco, model, position, ctx);
            } catch {
                return { suggestions: [] };
            }
        },
    });
}

async function provideFiles(
    monaco: any,
    _model: any,
    position: { lineNumber: number; column: number },
    ctx: Extract<WikilinkPrefix, { mode: 'file' }>,
): Promise<{ suggestions: any[]; incomplete?: boolean }> {
    let files: WikilinkCandidate[] = [];
    try {
        files = await loadCandidates();
    } catch {
        return { suggestions: [] };
    }
    const filtered = filterPaletteFiles(files, ctx.query, ctx.embed, currentDocumentPath());
    // Cap erreicht → Liste ist unvollständig. Ohne `incomplete: true`
    // filtert Monaco beim Weitertippen nur clientseitig in dieser
    // Teilmenge und ruft den Provider nie erneut auf — Treffer außerhalb
    // der ersten 50 (z. B. eine weitere README.md) blieben unsichtbar.
    const incomplete = filtered.length >= SUGGESTION_CAP;
    const range = {
        startLineNumber: position.lineNumber,
        // Monaco columns are 1-based; rangeStart is 0-based index in line.
        startColumn: ctx.rangeStart + 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
    };
    const FileKind = monaco.languages.CompletionItemKind?.File
        ?? monaco.languages.CompletionItemKind?.Text
        ?? 18;
    const suggestions = filtered.map((f, i) => {
        const insertText = (f as WikilinkCandidate).insert
            || chooseInsertText(f, files.filter((x) => x.kind === 'markdown' || isMarkdownFileName(x.name)));
        return {
            // Pfad als `description` → sichtbar in JEDER Listenzeile
            // (Monaco-`detail` erscheint nur beim markierten Eintrag).
            label: { label: f.name, description: f.relative || '' },
            kind: FileKind,
            detail: f.path,
            // Pfad + insert mit matchen lassen, damit `[[docs/re` trifft.
            filterText: f.name + ' ' + (f.relative || '') + ' ' + insertText,
            insertText,
            range,
            sortText: String(i).padStart(5, '0'),
        };
    });
    return { suggestions, incomplete };
}

async function provideHeadings(
    monaco: any,
    _model: any,
    position: { lineNumber: number; column: number },
    ctx: Extract<WikilinkPrefix, { mode: 'heading' }>,
): Promise<{ suggestions: any[] }> {
    const currentPath = await resolveCurrentPath();
    let headings: Array<{ text: string; level: number }> = [];
    try {
        headings = await tauriInvoke('wikilink_headings', {
            name: ctx.name,
            currentPath: currentPath || null,
        });
    } catch {
        return { suggestions: [] };
    }
    if (!Array.isArray(headings)) return { suggestions: [] };
    const filtered = filterHeadings(headings, ctx.headingQuery);
    const range = {
        startLineNumber: position.lineNumber,
        startColumn: ctx.rangeStart + 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
    };
    const Kind = monaco.languages.CompletionItemKind?.Text ?? 18;
    const suggestions = filtered.map((h, i) => ({
        label: h.text,
        kind: Kind,
        detail: 'H' + String(h.level || ''),
        insertText: h.text,
        range,
        sortText: String(i).padStart(5, '0'),
    }));
    return { suggestions };
}

/** Test-Hook: Cache leeren. */
export function __resetWikilinkCompleteCacheForTests(): void {
    candidateCache = null;
    registered = false;
}
