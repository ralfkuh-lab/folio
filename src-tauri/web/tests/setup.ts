// Globaler Setup fuer alle Vitest-Files. happy-dom liefert `window`/
// `document`; wir haengen einen Default-Mock fuer `window.__TAURI__` an,
// damit Module-Init nicht in `core.invoke is undefined`-Errors laeuft.
// Einzelne Tests koennen den Mock ueber `installTauriMock(overrides)`
// (siehe ./helpers.ts) ueberschreiben.

import { vi, beforeEach } from 'vitest';

beforeEach(() => {
    (window as any).__TAURI__ = {
        core: {
            invoke: vi.fn().mockResolvedValue(undefined),
            convertFileSrc: vi.fn((p: string) => p),
        },
        event: {
            emit: vi.fn().mockResolvedValue(undefined),
            listen: vi.fn().mockResolvedValue(() => {}),
        },
    };
    delete (window as any).FolioEditor;
    delete (window as any).__folioInvoke;
    delete (window as any).openDocument;
});
