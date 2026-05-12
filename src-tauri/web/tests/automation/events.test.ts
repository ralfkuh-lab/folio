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
    // happy-dom liefert rAF nicht zuverlaessig — stuben, damit ackHandler
    // den Frame deterministisch durchlaeuft (sonst Microtask-Fallback).
    (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
        setTimeout(() => cb(0), 0);
        return 0;
    };
    vi.resetModules();
});

async function flushAck(): Promise<void> {
    // ackHandler awaitet: work → Promise.resolve() → rAF (setTimeout 0)
    // → invoke. Wir geben ihm drei Ticks plus einen Real-Sleep.
    await new Promise((r) => setTimeout(r, 5));
    await Promise.resolve();
    await Promise.resolve();
}

describe('automation/events — ackHandler', () => {
    it('ruft invoke("automation_ack",{id}) nach work() + Microtask + rAF', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        const order: string[] = [];
        tauri.invoke.mockImplementation((cmd: string, args: any) => {
            order.push('invoke:' + cmd + ':' + args.id);
            return Promise.resolve();
        });

        tauri.emitEvent('automation:click', {
            name: '#nonexistent-id',
            requestId: 42,
        });
        order.push('after-emit');

        await flushAck();

        expect(order).toContain('after-emit');
        expect(tauri.invoke).toHaveBeenCalledWith('automation_ack', { id: 42 });
    });

    it('emittiert KEIN invoke wenn requestId fehlt (Backward-Compat)', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:click', { name: '#nonexistent-id' });
        await flushAck();

        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'automation_ack',
            expect.anything(),
        );
    });

    it('schluckt work-Fehler und schickt trotzdem ACK', async () => {
        // Element mit werfendem .click() — ackHandler darf nicht durchlassen,
        // sonst bliebe das Backend im Timeout. Wir verifizieren: invoke
        // wird trotz Exception aufgerufen.
        const target = document.createElement('button');
        target.id = 'throwing-target';
        target.click = () => { throw new Error('boom'); };
        document.body.appendChild(target);

        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:click', {
            name: 'throwing-target',
            requestId: 99,
        });

        await flushAck();
        expect(tauri.invoke).toHaveBeenCalledWith('automation_ack', { id: 99 });
    });

    it('ackt automation:key mit requestId', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:key', {
            key: 'F3',
            modifiers: {},
            requestId: 7,
        });

        await flushAck();
        expect(tauri.invoke).toHaveBeenCalledWith('automation_ack', { id: 7 });
    });

    it('ackt automation:set_editor_selection mit requestId', async () => {
        (window as any).FolioEditor = { setSelection: vi.fn() };
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:set_editor_selection', {
            start: 1,
            length: 2,
            requestId: 13,
        });

        await flushAck();
        expect(tauri.invoke).toHaveBeenCalledWith('automation_ack', { id: 13 });
    });

    it('ackt automation:open_document erst nach openDocument-Promise', async () => {
        let resolveOpen: (v?: any) => void = () => {};
        const docMod = await import('../../app/state/document');
        (docMod.openDocument as any).mockImplementation(() => new Promise((r) => { resolveOpen = r; }));

        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:open_document', {
            path: '/x',
            requestId: 50,
        });

        // Vor Resolve: kein ACK.
        await flushAck();
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'automation_ack',
            { id: 50 },
        );

        resolveOpen();
        await flushAck();
        expect(tauri.invoke).toHaveBeenCalledWith('automation_ack', { id: 50 });
    });
});

describe('automation/events — automation:dom_query', () => {
    it('liefert Snapshot via automation_dom_response (id + payload)', async () => {
        const btn = document.createElement('button');
        btn.id = 'snap-target';
        btn.setAttribute('data-name', 'snap');
        btn.textContent = 'hello';
        document.body.appendChild(btn);

        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:dom_query', {
            selector: 'snap-target',
            requestId: 21,
        });

        // invoke ist async via .then chain — kurze Tick-Pause.
        await Promise.resolve();
        await Promise.resolve();

        expect(tauri.invoke).toHaveBeenCalledWith(
            'automation_dom_response',
            expect.objectContaining({
                id: 21,
                payload: expect.objectContaining({
                    exists: true,
                    textContent: 'hello',
                    tagName: 'button',
                    matchCount: 1,
                }),
            }),
        );
    });

    it('liefert exists=false fuer unbekannten Selektor', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:dom_query', {
            selector: '#really-not-there',
            requestId: 9,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(tauri.invoke).toHaveBeenCalledWith(
            'automation_dom_response',
            expect.objectContaining({
                id: 9,
                payload: expect.objectContaining({ exists: false, matchCount: 0 }),
            }),
        );
    });

    it('ignoriert Events ohne requestId', async () => {
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:dom_query', { selector: 'foo' });
        await Promise.resolve();

        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'automation_dom_response',
            expect.anything(),
        );
    });
});

describe('automation/events — automation:set_editor_selection', () => {
    it('ruft FolioEditor.setSelection mit start/length', async () => {
        const setSelection = vi.fn();
        (window as any).FolioEditor = { setSelection };

        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:set_editor_selection', {
            start: 5,
            length: 3,
        });

        expect(setSelection).toHaveBeenCalledWith(5, 3);
    });

    it('defaultet auf 0/0 wenn Felder fehlen', async () => {
        const setSelection = vi.fn();
        (window as any).FolioEditor = { setSelection };

        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        tauri.emitEvent('automation:set_editor_selection', {});

        expect(setSelection).toHaveBeenCalledWith(0, 0);
    });

    it('ignoriert das Event wenn FolioEditor fehlt', async () => {
        delete (window as any).FolioEditor;
        const events = await import('../../app/automation/events');
        events.initAutomationEvents();

        // Kein Throw bei fehlender FolioEditor-Surface.
        expect(() =>
            tauri.emitEvent('automation:set_editor_selection', { start: 1, length: 1 }),
        ).not.toThrow();
    });
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
