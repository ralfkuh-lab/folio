import { describe, expect, it } from 'vitest';
import { toggleTaskInDocument, toggleTaskListItem } from '../../app/view/task-toggle';

describe('view/task-toggle pure line transformations', () => {
    it('toggles unchecked item to checked', () => {
        const line = '- [ ] Buy milk';
        expect(toggleTaskListItem(line)).toBe('- [x] Buy milk');
        expect(toggleTaskListItem(line, false)).toBe('- [x] Buy milk');
    });

    it('toggles checked item to unchecked', () => {
        const line = '- [x] Buy milk';
        expect(toggleTaskListItem(line)).toBe('- [ ] Buy milk');
        expect(toggleTaskListItem(line, true)).toBe('- [ ] Buy milk');
    });

    it('toggles uppercase [X] to unchecked', () => {
        const line = '- [X] Task done in uppercase';
        expect(toggleTaskListItem(line)).toBe('- [ ] Task done in uppercase');
        expect(toggleTaskListItem(line, true)).toBe('- [ ] Task done in uppercase');
    });

    it('preserves indentation (spaces and tabs)', () => {
        expect(toggleTaskListItem('  - [ ] Two spaces')).toBe('  - [x] Two spaces');
        expect(toggleTaskListItem('    - [x] Four spaces', true)).toBe('    - [ ] Four spaces');
        expect(toggleTaskListItem('\t- [ ] Tab indented')).toBe('\t- [x] Tab indented');
        expect(toggleTaskListItem('\t\t- [X] Double tab', true)).toBe('\t\t- [ ] Double tab');
    });

    it('handles asterisk list marker (*)', () => {
        expect(toggleTaskListItem('* [ ] Star task')).toBe('* [x] Star task');
        expect(toggleTaskListItem('  * [x] Star task checked', true)).toBe('  * [ ] Star task checked');
        expect(toggleTaskListItem('* [X] Star task uppercase', true)).toBe('* [ ] Star task uppercase');
    });

    it('handles plus list marker (+)', () => {
        expect(toggleTaskListItem('+ [ ] Plus task')).toBe('+ [x] Plus task');
        expect(toggleTaskListItem('  + [x] Plus task checked', true)).toBe('  + [ ] Plus task checked');
        expect(toggleTaskListItem('+ [X] Plus task uppercase', true)).toBe('+ [ ] Plus task uppercase');
    });

    it('handles ordered list markers (1. / 1) / multi-digit)', () => {
        expect(toggleTaskListItem('1. [ ] First ordered task')).toBe('1. [x] First ordered task');
        expect(toggleTaskListItem('1. [x] First ordered checked', true)).toBe('1. [ ] First ordered checked');
        expect(toggleTaskListItem('2) [ ] Second ordered paren')).toBe('2) [x] Second ordered paren');
        expect(toggleTaskListItem('42. [X] Multi-digit uppercase', true)).toBe('42. [ ] Multi-digit uppercase');
        expect(toggleTaskListItem('  123) [ ] Indented ordered')).toBe('  123) [x] Indented ordered');
    });

    it('handles blockquote task markers (> and nested >>)', () => {
        expect(toggleTaskListItem('> - [ ] Quoted task')).toBe('> - [x] Quoted task');
        expect(toggleTaskListItem('> - [x] Quoted task checked', true)).toBe('> - [ ] Quoted task checked');
        expect(toggleTaskListItem('>> * [ ] Nested quote star')).toBe('>> * [x] Nested quote star');
        expect(toggleTaskListItem('> > 1. [X] Spaced quote ordered', true)).toBe('> > 1. [ ] Spaced quote ordered');
        expect(toggleTaskListItem('  >  + [ ] Indented quote plus')).toBe('  >  + [x] Indented quote plus');
    });

    it('preserves all line content after brackets (links, tags, formatting)', () => {
        const line = '  - [ ] [[Wikilink|Alias]] #tag `code` **bold** [external](https://example.com)';
        expect(toggleTaskListItem(line, false)).toBe(
            '  - [x] [[Wikilink|Alias]] #tag `code` **bold** [external](https://example.com)',
        );
    });

    it('handles task item without description', () => {
        expect(toggleTaskListItem('- [ ]')).toBe('- [x]');
        expect(toggleTaskListItem('- [x]', true)).toBe('- [ ]');
    });

    it('stale-guard: rejects line when expected state does not match actual state', () => {
        // Expected unchecked, but line is checked
        expect(toggleTaskListItem('- [x] Already checked', false)).toBeNull();
        expect(toggleTaskListItem('- [X] Already checked uppercase', false)).toBeNull();
        expect(toggleTaskListItem('1. [x] Ordered checked', false)).toBeNull();
        expect(toggleTaskListItem('> - [x] Quoted checked', false)).toBeNull();

        // Expected checked, but line is unchecked
        expect(toggleTaskListItem('- [ ] Still unchecked', true)).toBeNull();
        expect(toggleTaskListItem('1. [ ] Ordered unchecked', true)).toBeNull();
        expect(toggleTaskListItem('> - [ ] Quoted unchecked', true)).toBeNull();
    });

    it('stale-guard: rejects non-task lines', () => {
        expect(toggleTaskListItem('Plain text line')).toBeNull();
        expect(toggleTaskListItem('# Heading line')).toBeNull();
        expect(toggleTaskListItem('- Regular bullet item without checkbox')).toBeNull();
        expect(toggleTaskListItem('* Regular asterisk item without checkbox')).toBeNull();
        expect(toggleTaskListItem('+ Regular plus item without checkbox')).toBeNull();
        expect(toggleTaskListItem('1. Numbered item')).toBeNull();
        expect(toggleTaskListItem('> Plain quote')).toBeNull();
        expect(toggleTaskListItem('- [a] Invalid checkbox character')).toBeNull();
        expect(toggleTaskListItem('- [] Empty brackets')).toBeNull();
        expect(toggleTaskListItem('- [  ] Double space in brackets')).toBeNull();
        expect(toggleTaskListItem('')).toBeNull();
    });
});

describe('view/task-toggle document-level transformations', () => {
    it('toggles task in a single-line document', () => {
        const doc = '- [ ] Single task';
        const res = toggleTaskInDocument(doc, 1, false);
        expect(res).toEqual({
            fullText: '- [x] Single task',
            changed: true,
        });
    });

    it('toggles task in a multi-line document with LF line endings', () => {
        const doc = '# Title\n\n- [ ] Task 1\n- [x] Task 2\n\nFooter';
        const res1 = toggleTaskInDocument(doc, 3, false);
        expect(res1).toEqual({
            fullText: '# Title\n\n- [x] Task 1\n- [x] Task 2\n\nFooter',
            changed: true,
        });

        const res2 = toggleTaskInDocument(doc, 4, true);
        expect(res2).toEqual({
            fullText: '# Title\n\n- [ ] Task 1\n- [ ] Task 2\n\nFooter',
            changed: true,
        });
    });

    it('strictly preserves CRLF line endings', () => {
        const doc = '# Title\r\n\r\n- [ ] Task 1\r\n- [x] Task 2\r\n\r\nFooter';
        const res = toggleTaskInDocument(doc, 3, false);
        expect(res).toEqual({
            fullText: '# Title\r\n\r\n- [x] Task 1\r\n- [x] Task 2\r\n\r\nFooter',
            changed: true,
        });
        expect(res!.fullText.includes('\r\n')).toBe(true);
        expect(res!.fullText.split('\r\n').length).toBe(6);
    });

    it('handles nested lists and trailing newlines', () => {
        const doc = '- [x] Parent\n  - [ ] Child\n';
        const res = toggleTaskInDocument(doc, 2, false);
        expect(res).toEqual({
            fullText: '- [x] Parent\n  - [x] Child\n',
            changed: true,
        });
    });

    it('handles ordered lists and blockquotes at document level', () => {
        const doc = '1. [ ] Ordered item\n> - [ ] Quoted item\n';
        const res1 = toggleTaskInDocument(doc, 1, false);
        expect(res1).toEqual({
            fullText: '1. [x] Ordered item\n> - [ ] Quoted item\n',
            changed: true,
        });

        const res2 = toggleTaskInDocument(doc, 2, false);
        expect(res2).toEqual({
            fullText: '1. [ ] Ordered item\n> - [x] Quoted item\n',
            changed: true,
        });
    });

    it('stale-guard: returns null when line number is out of range', () => {
        const doc = '- [ ] Task 1\n- [ ] Task 2';
        expect(toggleTaskInDocument(doc, 0, false)).toBeNull();
        expect(toggleTaskInDocument(doc, -1, false)).toBeNull();
        expect(toggleTaskInDocument(doc, 3, false)).toBeNull();
        expect(toggleTaskInDocument(doc, 100, false)).toBeNull();
    });

    it('stale-guard: returns null when target line is not a matching task item', () => {
        const doc = '# Heading\n- [ ] Task 1\nSome text';
        // Line 1 is a heading, not a task item
        expect(toggleTaskInDocument(doc, 1, false)).toBeNull();
        // Line 3 is plain text
        expect(toggleTaskInDocument(doc, 3, false)).toBeNull();
        // Line 2 is unchecked, but we expected checked (stale render)
        expect(toggleTaskInDocument(doc, 2, true)).toBeNull();
    });
});
