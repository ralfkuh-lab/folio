// Tests fuer automation/events.ts — Schwerpunkt auf dem
// `automation:key`-Listener: synthetische KeyboardEvents fuer
// preventDefault-Listener (Find-Bar, Toolbar-Actions, Zoom). Die
// uebrigen Listener (`automation:click`, `set_editor_text`,
// `open_document`) sind smoke-getestet, weil ihre Subjektmodule
// schon eigene Coverage haben.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, type TauriMockHandles } from '../helpers';

vi.mock('../../app/state/document', () => ({
    getCleanText: vi.fn(() => ''),
    getCurrentPath: vi.fn(() => null),
    markDirty: vi.fn(),
    openDocument: vi.fn(),
    updateWordCount: vi.fn(),
}));
vi.mock('../../app/editor/shell', () => ({
    loadEditorText: vi.fn(),
}));

let tauri: TauriMockHandles;

beforeEach(() => {
    tauri = installTauriMock();
    document.body.innerHTML = '';
    vi.resetModules();
});

describe('automation/events — automation:key', () => {
    it('dispatcht KeyboardEvent mit key/code/Modifier auf document', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        const captured: KeyboardEvent[] = [];
        document.addEventListener('keydown', (e) => captured.push(e));

        tauri.emitEvent('automation:key', {
            key: 's',
            modifiers: { ctrl: true, shift: false, alt: false, meta: false },
            target: 'document',
        });

        expect(captured).toHaveLength(1);
        expect(captured[0].key).toBe('s');
        expect(captured[0].code).toBe('KeyS');
        expect(captured[0].ctrlKey).toBe(true);
        expect(captured[0].shiftKey).toBe(false);
    });

    it('mappt F3 auf code F3 und keyCode 114', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        const captured: KeyboardEvent[] = [];
        document.addEventListener('keydown', (e) => captured.push(e));

        tauri.emitEvent('automation:key', {
            key: 'F3',
            modifiers: {},
        });

        expect(captured).toHaveLength(1);
        expect(captured[0].key).toBe('F3');
        expect(captured[0].code).toBe('F3');
        expect(captured[0].keyCode).toBe(114);
    });

    it('mappt ArrowLeft + Alt fuer Back-Navigation', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        const captured: KeyboardEvent[] = [];
        document.addEventListener('keydown', (e) => captured.push(e));

        tauri.emitEvent('automation:key', {
            key: 'ArrowLeft',
            modifiers: { alt: true },
        });

        expect(captured).toHaveLength(1);
        expect(captured[0].key).toBe('ArrowLeft');
        expect(captured[0].altKey).toBe(true);
        expect(captured[0].keyCode).toBe(37);
    });

    it('dispatcht zusaetzlich keyup', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        const downs: KeyboardEvent[] = [];
        const ups: KeyboardEvent[] = [];
        document.addEventListener('keydown', (e) => downs.push(e));
        document.addEventListener('keyup', (e) => ups.push(e));

        tauri.emitEvent('automation:key', { key: 'Escape', modifiers: {} });

        expect(downs).toHaveLength(1);
        expect(ups).toHaveLength(1);
        expect(ups[0].key).toBe('Escape');
    });

    it('target editor dispatcht auf #editor-mount (oder Fallback body)', async () => {
        const host = document.createElement('div');
        host.id = 'editor-mount';
        document.body.appendChild(host);

        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        const onHost = vi.fn();
        const onDoc = vi.fn();
        host.addEventListener('keydown', onHost);
        document.addEventListener('keydown', onDoc);

        tauri.emitEvent('automation:key', {
            key: 'a',
            modifiers: {},
            target: 'editor',
        });

        // Listener auf #editor-mount feuert. document sieht durch
        // bubbles:true denselben Event ebenfalls — entscheidend ist,
        // dass das Target-Element der Host ist.
        expect(onHost).toHaveBeenCalledTimes(1);
        expect(onHost.mock.calls[0][0].target).toBe(host);
        expect(onDoc).toHaveBeenCalledTimes(1);
    });

    it('ignoriert Events ohne key-Feld', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        const captured: KeyboardEvent[] = [];
        document.addEventListener('keydown', (e) => captured.push(e));

        tauri.emitEvent('automation:key', { modifiers: { ctrl: true } });
        tauri.emitEvent('automation:key', { key: '', modifiers: {} });

        expect(captured).toHaveLength(0);
    });
});
