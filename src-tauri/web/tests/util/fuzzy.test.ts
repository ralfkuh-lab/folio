import { describe, expect, it } from 'vitest';
import {
    applyHighlight,
    fuzzyMatch,
    fuzzyMatchFile,
    pathDepth,
} from '../../app/util/fuzzy';

describe('fuzzyMatch', () => {
    it('returns null when query is not a subsequence', () => {
        expect(fuzzyMatch('xyz', 'readme.md')).toBeNull();
        expect(fuzzyMatch('abz', 'ab')).toBeNull();
    });

    it('matches case-insensitively via toLowerCase', () => {
        const hit = fuzzyMatch('Rd', 'ReadMe.md');
        expect(hit).not.toBeNull();
        expect(hit!.positions).toEqual([0, 3]);
    });

    it('empty query matches with score 0 and no positions', () => {
        const hit = fuzzyMatch('', 'anything');
        expect(hit).toEqual({ score: 0, positions: [] });
    });

    it('awards consecutive-match bonus over sparse matches', () => {
        // Gleicher Startindex 0: zusammenhängend schlägt lückenhaft.
        const consecutive = fuzzyMatch('abc', 'abcdef')!;
        const sparse = fuzzyMatch('abc', 'axbycz')!;
        expect(consecutive.score).toBeGreaterThan(sparse.score);
    });

    it('awards word-start bonus (boundary chars / _ - .)', () => {
        // Match "md" at word start after '_' vs mid-token
        const atBoundary = fuzzyMatch('md', 'foo_md_bar')!;
        const midToken = fuzzyMatch('md', 'foodmdbar')!;
        expect(atBoundary.score).toBeGreaterThan(midToken.score);

        const afterSlash = fuzzyMatch('bar', 'foo/bar')!;
        const mid = fuzzyMatch('bar', 'foobar')!;
        expect(afterSlash.score).toBeGreaterThan(mid.score);
    });

    it('awards name-start bonus and penalizes late match start', () => {
        const atStart = fuzzyMatch('note', 'notes.md')!;
        const late = fuzzyMatch('note', 'my-notes.md')!;
        expect(atStart.score).toBeGreaterThan(late.score);
        expect(atStart.positions[0]).toBe(0);
        expect(late.positions[0]).toBeGreaterThan(0);
    });

    it('returns correct match positions (indices into original)', () => {
        // R e a d M e . m d
        // 0 1 2 3 4 5 6 7 8 — greedy: R, M(e), d
        const hit = fuzzyMatch('rmd', 'ReadMe.md')!;
        expect(hit.positions).toEqual([0, 4, 8]);
        const original = 'ReadMe.md';
        const rebuilt = hit.positions.map((i) => original[i]).join('');
        expect(rebuilt.toLowerCase()).toBe('rmd');
    });
});

describe('pathDepth', () => {
    it('counts non-empty path segments', () => {
        expect(pathDepth('')).toBe(0);
        expect(pathDepth('file.md')).toBe(1);
        expect(pathDepth('a/b/c.md')).toBe(3);
        expect(pathDepth('a\\b\\c.md')).toBe(3);
    });
});

describe('fuzzyMatchFile', () => {
    it('takes best of name vs relativePath', () => {
        // Query only in path
        const onlyPath = fuzzyMatchFile('src', 'main.ts', 'src/main.ts')!;
        expect(onlyPath.pathPositions).not.toBeNull();
        expect(onlyPath.namePositions).toBeNull();

        // Query only in name
        const onlyName = fuzzyMatchFile('main', 'main.ts', 'lib/util.ts')!;
        expect(onlyName.namePositions).not.toBeNull();
        expect(onlyName.pathPositions).toBeNull();
    });

    it('prefers name when scores are equal (visible label)', () => {
        // Query "x" matches both equally as start? Use identical strings.
        const hit = fuzzyMatchFile('a', 'a.md', 'a.md')!;
        expect(hit.namePositions).not.toBeNull();
        expect(hit.pathPositions).toBeNull();
    });

    it('applies path-depth malus (deeper files score lower)', () => {
        const shallow = fuzzyMatchFile('util', 'util.ts', 'util.ts')!;
        const deep = fuzzyMatchFile('util', 'util.ts', 'a/b/c/util.ts')!;
        expect(shallow.score).toBeGreaterThan(deep.score);
    });

    it('returns null when neither field matches', () => {
        expect(fuzzyMatchFile('zzz', 'readme.md', 'docs/readme.md')).toBeNull();
    });
});

describe('applyHighlight', () => {
    it('wraps matched positions in .cp-hit spans (text-node safe)', () => {
        const el = document.createElement('span');
        applyHighlight(el, 'ReadMe.md', [0, 4, 8]);
        const hits = el.querySelectorAll('span.cp-hit');
        expect(hits.length).toBeGreaterThan(0);
        // Full text preserved
        expect(el.textContent).toBe('ReadMe.md');
        // Each hit span only contains matched chars
        let hitText = '';
        hits.forEach((h) => {
            hitText += h.textContent;
        });
        expect(hitText).toBe('RMd');
        // No HTML injection path — children are Text or SPAN
        for (let i = 0; i < el.childNodes.length; i++) {
            const n = el.childNodes[i];
            expect(
                n.nodeType === Node.TEXT_NODE
                    || (n.nodeType === Node.ELEMENT_NODE
                        && (n as Element).tagName === 'SPAN'),
            ).toBe(true);
        }
    });

    it('renders plain text when positions empty/null', () => {
        const el = document.createElement('span');
        applyHighlight(el, 'plain', null);
        expect(el.querySelectorAll('span.cp-hit').length).toBe(0);
        expect(el.textContent).toBe('plain');
    });
});
