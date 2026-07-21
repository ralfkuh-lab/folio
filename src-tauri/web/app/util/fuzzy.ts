/* Purer Fuzzy-Matcher für die Command Palette.
   Subsequence, case-insensitive via toLowerCase (kein Unicode-Case-Folding —
   Konvention wie Vault-Filter). DOM-frei, vitest-abgedeckt. */

export interface FuzzyResult {
    /** Höher = besser. */
    score: number;
    /** Indizes in den Original-Haystack (nicht lowercased). */
    positions: number[];
}

/** Wortgrenzen-Zeichen vor einem Match-Charakter (Spec: `/[ _\-./]/`). */
const WORD_BOUNDARY = /[ _\-./]/;

/**
 * Subsequence-Match. Leere Query → Score 0, keine Positionen.
 * Kein Match → null.
 */
export function fuzzyMatch(query: string, haystack: string): FuzzyResult | null {
    if (!query) {
        return { score: 0, positions: [] };
    }
    const q = query.toLowerCase();
    const h = haystack.toLowerCase();
    if (!q) {
        return { score: 0, positions: [] };
    }

    const positions: number[] = [];
    let qi = 0;
    for (let hi = 0; hi < h.length && qi < q.length; hi++) {
        if (h.charCodeAt(hi) === q.charCodeAt(qi)) {
            positions.push(hi);
            qi++;
        }
    }
    if (qi < q.length) return null;

    let score = 0;
    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        // Basis pro Treffer-Zeichen
        score += 10;
        // Zusammenhängende Folge
        if (i > 0 && positions[i] === positions[i - 1] + 1) {
            score += 8;
        }
        // Wortanfang (String-Start oder Grenze davor)
        if (pos === 0 || WORD_BOUNDARY.test(haystack.charAt(pos - 1))) {
            score += 16;
        }
    }
    // Match am Namensanfang (erstes Query-Zeichen am Index 0)
    if (positions[0] === 0) {
        score += 24;
    }
    // Später Match-Start
    score -= positions[0] * 3;

    return { score, positions };
}

/** Anzahl Pfadsegmente (POSIX-Slashes); leerer String → 0. */
export function pathDepth(relativePath: string): number {
    if (!relativePath) return 0;
    let depth = 0;
    const parts = relativePath.replace(/\\/g, '/').split('/');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i]) depth++;
    }
    return depth;
}

export interface FileFuzzyResult {
    score: number;
    /** Positionen im `name`, falls name der beste Match war (sonst null). */
    namePositions: number[] | null;
    /** Positionen im `relativePath`, falls path der beste Match war (sonst null). */
    pathPositions: number[] | null;
}

/**
 * Match gegen `name` und `relativePath`; bestes Ergebnis zählt.
 * Pfadtiefe-Malus wird auf beide Kandidaten angewandt (tiefer = schlechter).
 */
export function fuzzyMatchFile(
    query: string,
    name: string,
    relativePath: string,
): FileFuzzyResult | null {
    const depth = pathDepth(relativePath);
    const depthMalus = depth * 4;

    const nameHit = fuzzyMatch(query, name);
    const pathHit = relativePath ? fuzzyMatch(query, relativePath) : null;

    if (!nameHit && !pathHit) return null;

    const nameScore = nameHit ? nameHit.score - depthMalus : Number.NEGATIVE_INFINITY;
    const pathScore = pathHit ? pathHit.score - depthMalus : Number.NEGATIVE_INFINITY;

    // Bei Gleichstand: name bevorzugen (sichtbares Label).
    if (nameHit && nameScore >= pathScore) {
        return {
            score: nameScore,
            namePositions: nameHit.positions,
            pathPositions: null,
        };
    }
    if (pathHit) {
        return {
            score: pathScore,
            namePositions: null,
            pathPositions: pathHit.positions,
        };
    }
    return null;
}

/**
 * Baut Text-Nodes + `.cp-hit`-Spans aus Originaltext und Positionsliste.
 * Text-Node-sicher (kein innerHTML).
 */
export function applyHighlight(
    container: HTMLElement,
    text: string,
    positions: number[] | null | undefined,
): void {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!text) return;
    if (!positions || positions.length === 0) {
        container.appendChild(document.createTextNode(text));
        return;
    }
    const hitSet = new Set(positions);
    let runStart = 0;
    let runIsHit = hitSet.has(0);
    for (let i = 1; i <= text.length; i++) {
        const isHit = i < text.length ? hitSet.has(i) : !runIsHit;
        if (i === text.length || isHit !== runIsHit) {
            const slice = text.slice(runStart, i);
            if (slice) {
                if (runIsHit) {
                    const span = document.createElement('span');
                    span.className = 'cp-hit';
                    span.appendChild(document.createTextNode(slice));
                    container.appendChild(span);
                } else {
                    container.appendChild(document.createTextNode(slice));
                }
            }
            runStart = i;
            runIsHit = isHit;
        }
    }
}
