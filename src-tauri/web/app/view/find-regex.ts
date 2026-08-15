/** Flags aligned with Monaco's findMatches (`gu` / `giu`). */
export function findRegexFlags(caseSensitive: boolean): string {
    return caseSensitive ? 'gu' : 'giu';
}

/** Advance lastIndex by one Unicode code point so zero-width matches cannot loop. */
export function skipZeroWidthMatch(regex: RegExp, text: string): void {
    if (regex.lastIndex >= text.length) {
        regex.lastIndex = text.length + 1;
        return;
    }
    const cp = text.codePointAt(regex.lastIndex);
    regex.lastIndex += (cp !== undefined && cp > 0xffff) ? 2 : 1;
}
