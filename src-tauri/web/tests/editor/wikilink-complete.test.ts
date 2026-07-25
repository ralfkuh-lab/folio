/** Pure helpers for [[ autocomplete — no Monaco, no DOM. */
import { describe, expect, it } from 'vitest';
import {
    chooseInsertText,
    filterHeadings,
    filterPaletteFiles,
    isImageFileName,
    isInsideCodeFence,
    isInUnclosedInlineCode,
    isMarkdownFileName,
    parseWikilinkPrefix,
    proximityRank,
    shouldSuppressWikilinkComplete,
    stripMdExtension,
    type PaletteFile,
    type WikilinkCandidate,
} from '../../editor/wikilink-complete';

const files: PaletteFile[] = [
    { path: '/v/Alpha.md', name: 'Alpha.md', relative: 'Alpha.md' },
    { path: '/v/notes/Alpha.md', name: 'Alpha.md', relative: 'notes/Alpha.md' },
    { path: '/v/notes/Beta.md', name: 'Beta.md', relative: 'notes/Beta.md' },
    { path: '/v/images/bild.png', name: 'bild.png', relative: 'images/bild.png' },
    { path: '/v/data.json', name: 'data.json', relative: 'data.json' },
];

const candidates: WikilinkCandidate[] = [
    { path: '/v/Alpha.md', name: 'Alpha.md', relative: 'Alpha.md', kind: 'markdown', insert: 'Alpha' },
    {
        path: '/v/notes/Alpha.md',
        name: 'Alpha.md',
        relative: 'notes/Alpha.md',
        kind: 'markdown',
        insert: 'notes/Alpha',
    },
    { path: '/v/notes/Beta.md', name: 'Beta.md', relative: 'notes/Beta.md', kind: 'markdown', insert: 'Beta' },
    {
        path: '/v/images/bild.png',
        name: 'bild.png',
        relative: 'images/bild.png',
        kind: 'image',
        insert: 'bild.png',
    },
    { path: '/v/data.json', name: 'data.json', relative: 'data.json', kind: 'text', insert: 'data.json' },
];

const mdOnly = files.filter((f) => isMarkdownFileName(f.name));

describe('parseWikilinkPrefix', () => {
    it('returns null without open [[', () => {
        expect(parseWikilinkPrefix('hello')).toBeNull();
        expect(parseWikilinkPrefix('[single')).toBeNull();
        expect(parseWikilinkPrefix('[[closed]] more')).toBeNull();
        expect(parseWikilinkPrefix('[[done]]')).toBeNull();
    });

    it('detects open [[ query', () => {
        const p = parseWikilinkPrefix('See [[Note');
        expect(p).toEqual({
            mode: 'file',
            embed: false,
            query: 'Note',
            rangeStart: 'See [['.length,
        });
    });

    it('detects ![[ embed prefix', () => {
        const p = parseWikilinkPrefix('![[img');
        expect(p).toMatchObject({ mode: 'file', embed: true, query: 'img' });
        expect(p!.rangeStart).toBe('![['.length);
    });

    it('detects heading mode with name', () => {
        const p = parseWikilinkPrefix('[[Beta#He');
        expect(p).toEqual({
            mode: 'heading',
            embed: false,
            name: 'Beta',
            headingQuery: 'He',
            rangeStart: '[[Beta#'.length,
        });
    });

    it('detects [[# for current document headings', () => {
        const p = parseWikilinkPrefix('[[#');
        expect(p).toEqual({
            mode: 'heading',
            embed: false,
            name: '',
            headingQuery: '',
            rangeStart: '[[#'.length,
        });
    });

    it('allows empty query right after [[', () => {
        const p = parseWikilinkPrefix('[[');
        expect(p).toMatchObject({ mode: 'file', query: '', embed: false });
    });
});

describe('chooseInsertText', () => {
    it('uses basename without .md when unique', () => {
        expect(chooseInsertText(files[2], mdOnly)).toBe('Beta');
    });

    it('uses relative without .md when basename ambiguous', () => {
        expect(chooseInsertText(files[0], mdOnly)).toBe('Alpha');
        // both Alpha.md → relative disambiguates
        expect(chooseInsertText(files[1], mdOnly)).toBe('notes/Alpha');
    });

    it('keeps image extension', () => {
        expect(chooseInsertText(files[3], mdOnly)).toBe('bild.png');
    });

    it('prefers backend insert when present', () => {
        expect(chooseInsertText({ ...files[1], insert: 'notes/Alpha' }, mdOnly)).toBe('notes/Alpha');
    });
});

describe('filterPaletteFiles', () => {
    it('includes only .md by default', () => {
        const r = filterPaletteFiles(files, '', false);
        expect(r.every((f) => isMarkdownFileName(f.name))).toBe(true);
        expect(r.some((f) => f.name === 'bild.png')).toBe(false);
        expect(r.some((f) => f.name === 'data.json')).toBe(false);
    });

    it('includes images for embed prefix', () => {
        const r = filterPaletteFiles(files, '', true);
        expect(r.some((f) => f.name === 'bild.png')).toBe(true);
        expect(r.some((f) => f.name === 'data.json')).toBe(false);
    });

    it('filters by query case-insensitively', () => {
        const r = filterPaletteFiles(files, 'bet', false);
        expect(r.map((f) => f.name)).toEqual(['Beta.md']);
    });

    it('filters candidates by kind from backend', () => {
        const r = filterPaletteFiles(candidates, '', false);
        expect(r.every((f) => (f as WikilinkCandidate).kind === 'markdown')).toBe(true);
        const emb = filterPaletteFiles(candidates, '', true);
        expect(emb.some((f) => (f as WikilinkCandidate).kind === 'image')).toBe(true);
        expect(emb.some((f) => (f as WikilinkCandidate).kind === 'text')).toBe(false);
    });

    it('ranks candidates by proximity to the current document', () => {
        const mk = (path: string, relative: string): PaletteFile => ({
            path,
            name: path.slice(path.lastIndexOf('/') + 1),
            relative,
        });
        const set = [
            mk('/v/other/README.md', 'other/README.md'),
            mk('/v/docs/sub/README.md', 'docs/sub/README.md'),
            mk('/v/README.md', 'README.md'),
            mk('/v/docs/README.md', 'docs/README.md'),
        ];
        const r = filterPaletteFiles(set, 'readme', false, '/v/docs/CLAUDE.md');
        expect(r.map((f) => f.relative)).toEqual([
            'docs/README.md',      // gleiches Verzeichnis
            'docs/sub/README.md',  // darunter
            'README.md',           // Elternordner
            'other/README.md',     // Geschwisterzweig
        ]);
    });

    it('proximityRank orders parent before sibling directory', () => {
        expect(proximityRank('/v/docs/A.md', '/v/docs/B.md')).toEqual([0, 0]);
        expect(proximityRank('/v/docs/sub/A.md', '/v/docs/B.md')).toEqual([0, 1]);
        expect(proximityRank('/v/A.md', '/v/docs/B.md')).toEqual([1, 0]);
        expect(proximityRank('/v/other/A.md', '/v/docs/B.md')).toEqual([1, 1]);
    });

    it('keeps alphabetical order without a current document', () => {
        const r = filterPaletteFiles(files, '', false);
        expect(r.map((f) => f.name)).toEqual(files.filter((f) => isMarkdownFileName(f.name)).map((f) => f.name));
    });
});

describe('filterHeadings', () => {
    const hs = [
        { text: 'Erste Ueberschrift', level: 1 },
        { text: 'Zweite Überschrift', level: 2 },
    ];
    it('filters by substring', () => {
        expect(filterHeadings(hs, 'zweite').map((h) => h.text)).toEqual([
            'Zweite Überschrift',
        ]);
    });
});

describe('helpers', () => {
    it('stripMdExtension / isImage', () => {
        expect(stripMdExtension('Note.MD')).toBe('Note');
        expect(isImageFileName('x.WEBP')).toBe(true);
        expect(isImageFileName('x.md')).toBe(false);
    });
});

describe('F10 fence / inline-code gate', () => {
    it('isInsideCodeFence toggles on ``` lines', () => {
        const lines = [
            '# Title',
            '```js',
            'const x = [[Note]]',
            '```',
            'after [[Note',
        ];
        expect(isInsideCodeFence(lines, 0)).toBe(false);
        expect(isInsideCodeFence(lines, 1)).toBe(false); // fence line itself: not yet open before it
        expect(isInsideCodeFence(lines, 2)).toBe(true);
        expect(isInsideCodeFence(lines, 3)).toBe(true); // still open until close line processed
        expect(isInsideCodeFence(lines, 4)).toBe(false);
    });

    it('isInsideCodeFence supports ~~~ fences', () => {
        const lines = ['~~~', '[[X]]', '~~~', 'out'];
        expect(isInsideCodeFence(lines, 1)).toBe(true);
        expect(isInsideCodeFence(lines, 3)).toBe(false);
    });

    it('isInsideCodeFence ignores shorter close of different length rules', () => {
        // Open with ```` needs at least 4 backticks to close (CommonMark).
        const lines = ['````', 'code', '```', 'still', '````', 'out'];
        expect(isInsideCodeFence(lines, 2)).toBe(true);
        expect(isInsideCodeFence(lines, 3)).toBe(true); // ``` does not close ````
        expect(isInsideCodeFence(lines, 5)).toBe(false);
    });

    it('isInUnclosedInlineCode counts backticks', () => {
        expect(isInUnclosedInlineCode('plain [[')).toBe(false);
        expect(isInUnclosedInlineCode('code `[[')).toBe(true);
        expect(isInUnclosedInlineCode('code `x` [[')).toBe(false);
        expect(isInUnclosedInlineCode('`a` `b')).toBe(true);
    });

    it('shouldSuppressWikilinkComplete combines both', () => {
        const lines = ['```', '[[N', '```', 'ok [[N'];
        expect(shouldSuppressWikilinkComplete(lines, 1, '[[N')).toBe(true);
        expect(shouldSuppressWikilinkComplete(lines, 3, 'ok [[N')).toBe(false);
        expect(shouldSuppressWikilinkComplete(['x'], 0, 'see `[[')).toBe(true);
    });
});
