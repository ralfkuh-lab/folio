// Smoke-Test: Stellt sicher, dass das Vitest-Setup laeuft (jsdom
// liefert `window`/`document`, der Tauri-Mock ist installiert).

import { describe, expect, it } from 'vitest';

describe('vitest setup', () => {
    it('exposes jsdom window + document', () => {
        expect(typeof window).toBe('object');
        expect(typeof document.createElement).toBe('function');
    });

    it('installs default __TAURI__ mock', () => {
        expect((window as any).__TAURI__).toBeDefined();
        expect(typeof (window as any).__TAURI__.core.invoke).toBe('function');
        expect(typeof (window as any).__TAURI__.event.listen).toBe('function');
    });
});
