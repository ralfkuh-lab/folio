// Test-Helper: Tauri-Event-Listener-Map + invoke-Spy. Die meisten
// Frontend-Module rufen `listen('event:name', handler)`; helper macht
// die Listener-Registrierung in eine Map, sodass Tests sie per
// `emitTauriEvent('event:name', { payload })` aufrufen koennen.

import { vi } from 'vitest';

export type TauriListener = (event: { payload: unknown }) => void;

export interface TauriMockHandles {
    invoke: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    listeners: Map<string, TauriListener[]>;
    emitEvent(event: string, payload?: unknown): void;
}

export function installTauriMock(): TauriMockHandles {
    const listeners = new Map<string, TauriListener[]>();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const emit = vi.fn().mockResolvedValue(undefined);
    const listen = vi.fn((name: string, handler: TauriListener) => {
        const list = listeners.get(name) ?? [];
        list.push(handler);
        listeners.set(name, list);
        return Promise.resolve(() => {
            const next = (listeners.get(name) ?? []).filter((l) => l !== handler);
            listeners.set(name, next);
        });
    });

    (window as any).__TAURI__ = {
        core: { invoke, convertFileSrc: (p: string) => p },
        event: { emit, listen },
    };

    return {
        invoke,
        emit,
        listeners,
        emitEvent(event, payload) {
            const list = listeners.get(event) ?? [];
            for (const handler of list) handler({ payload });
        },
    };
}
