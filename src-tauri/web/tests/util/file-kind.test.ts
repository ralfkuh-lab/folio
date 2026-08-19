import { describe, expect, it } from 'vitest';
import { isTextOrMarkdownPath } from '../../app/util/file-kind';

describe('util/file-kind', () => {
    it('accepts markdown and text, rejects image and binary', () => {
        expect(isTextOrMarkdownPath('/a/note.md')).toBe(true);
        expect(isTextOrMarkdownPath('/a/config.json')).toBe(true);
        expect(isTextOrMarkdownPath('README')).toBe(true);
        expect(isTextOrMarkdownPath('/a/.gitignore')).toBe(true);
        expect(isTextOrMarkdownPath('/a/pic.png')).toBe(false);
        expect(isTextOrMarkdownPath('/a/icon.svg')).toBe(false);
        expect(isTextOrMarkdownPath('/a/blob.bin')).toBe(false);
        expect(isTextOrMarkdownPath('/a/archive.zip')).toBe(false);
        expect(isTextOrMarkdownPath('/a/blob')).toBe(false);
    });
});
