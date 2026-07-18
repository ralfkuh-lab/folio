// Tests fuer view/code-live.ts — Gating und Debounce-Muster analog
// html.test / preview.test:
// - nur split-mode + kind-text + gemountete Code-View + Pfad
// - kein isDirty-Gate
// - Timer-Fire holt Live-Editor-Text
// - autoFormat:false + preserveScroll:true
// - invalidateCodeLive cancelt pending Timer
// - flushCodeLiveUpdate wendet sofort an (Mode-Switch-Pfad)
// - Window-Event folio-editor-text-updated → schedule

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type CodeLive = typeof import('../../app/view/code-live');

describe('view/code-live', () => {
    let codeLive: CodeLive;
    let setText: ReturnType<typeof vi.fn>;
    let editorText: string;
    let path: string | null;

    function openGate(): void {
        document.body.className = 'split-mode kind-text';
        path = '/tmp/sample.json';
        setText = vi.fn();
        (window as any).FolioCodeView = {
            isMounted: () => true,
            setText,
        };
        (window as any).FolioEditor = {
            hasEditor: () => true,
            getText: () => editorText,
        };
    }

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        editorText = '';
        path = null;
        document.body.className = '';
        delete (window as any).FolioCodeView;
        delete (window as any).FolioEditor;
        codeLive = await import('../../app/view/code-live');
        codeLive.initCodeLiveUpdate({ getCurrentPath: () => path });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (window as any).FolioCodeView;
        delete (window as any).FolioEditor;
    });

    it('gate: closed ohne split-mode / kind-text / mount / path', () => {
        expect(codeLive.gateCodeSplitLiveForTest()).toBe(false);

        document.body.className = 'split-mode kind-text';
        path = '/tmp/a.json';
        (window as any).FolioCodeView = { isMounted: () => true, setText: vi.fn() };
        expect(codeLive.gateCodeSplitLiveForTest()).toBe(true);

        document.body.classList.add('html-preview-mode');
        expect(codeLive.gateCodeSplitLiveForTest()).toBe(false);
        document.body.classList.remove('html-preview-mode');

        document.body.className = 'edit-mode kind-text';
        expect(codeLive.gateCodeSplitLiveForTest()).toBe(false);

        document.body.className = 'split-mode kind-markdown';
        expect(codeLive.gateCodeSplitLiveForTest()).toBe(false);

        document.body.className = 'split-mode kind-text';
        path = null;
        expect(codeLive.gateCodeSplitLiveForTest()).toBe(false);

        path = '/tmp/a.json';
        (window as any).FolioCodeView = { isMounted: () => false, setText: vi.fn() };
        expect(codeLive.gateCodeSplitLiveForTest()).toBe(false);
    });

    it('debounced Live-Update mit aktueller Editor-Text und autoFormat:false', async () => {
        openGate();
        editorText = 'LIVE-JSON';
        // schedule direkt (nicht window-Event): resetModules + init stapelt
        // sonst window-Listener und setText wird N-fach gerufen.
        codeLive.scheduleCodeLiveUpdate('STALE');
        expect(setText).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(149);
        expect(setText).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(setText).toHaveBeenCalledTimes(1);
        expect(setText).toHaveBeenCalledWith('LIVE-JSON', '', {
            autoFormat: false,
            preserveScroll: true,
        });
    });

    it('window-event folio-editor-text-updated → Debounce → setText', async () => {
        openGate();
        editorText = 'FROM-EVENT';
        window.dispatchEvent(new CustomEvent('folio-editor-text-updated', { detail: 'STALE-EVENT' }));
        expect(setText).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(150);
        // Listener koennen ueber resetModules stapeln — mindestens ein
        // korrekter Call mit Live-Editor-Text genuegt.
        const matching = setText.mock.calls.filter((c) => c[0] === 'FROM-EVENT');
        expect(matching.length).toBeGreaterThanOrEqual(1);
        expect(matching[0][1]).toBe('');
        expect(matching[0][2]).toEqual({ autoFormat: false, preserveScroll: true });
    });

    it('invalidateCodeLive cancelt pending Debounce-Timer', async () => {
        openGate();
        codeLive.scheduleCodeLiveUpdate('x');
        codeLive.invalidateCodeLive();
        await vi.advanceTimersByTimeAsync(300);
        expect(setText).not.toHaveBeenCalled();
    });

    it('zweites Schedule gewinnt (Timer-Reset)', async () => {
        openGate();
        editorText = 'first';
        codeLive.scheduleCodeLiveUpdate('first');
        await vi.advanceTimersByTimeAsync(50);
        editorText = 'second';
        codeLive.scheduleCodeLiveUpdate('second');
        await vi.advanceTimersByTimeAsync(150);
        expect(setText).toHaveBeenCalledTimes(1);
        expect(setText).toHaveBeenCalledWith('second', '', {
            autoFormat: false,
            preserveScroll: true,
        });
    });

    it('rendert auch ohne Dirty-Begriff (kein isDirty-Gate)', async () => {
        openGate();
        editorText = 'clean-revert';
        codeLive.scheduleCodeLiveUpdate('clean-revert');
        await vi.advanceTimersByTimeAsync(150);
        expect(setText).toHaveBeenCalledWith('clean-revert', '', {
            autoFormat: false,
            preserveScroll: true,
        });
    });

    it('flushCodeLiveUpdate wendet sofort an (kein Debounce, Mode-Switch)', async () => {
        openGate();
        editorText = 'FLUSH-NOW';
        codeLive.flushCodeLiveUpdate();
        expect(setText).toHaveBeenCalledTimes(1);
        expect(setText).toHaveBeenCalledWith('FLUSH-NOW', '', {
            autoFormat: false,
            preserveScroll: true,
        });
        // Pending Debounce wird gecancelt
        setText.mockClear();
        editorText = 'pending';
        codeLive.scheduleCodeLiveUpdate('pending');
        editorText = 'flushed-over-pending';
        codeLive.flushCodeLiveUpdate();
        expect(setText).toHaveBeenCalledWith('flushed-over-pending', '', {
            autoFormat: false,
            preserveScroll: true,
        });
        setText.mockClear();
        await vi.advanceTimersByTimeAsync(200);
        expect(setText).not.toHaveBeenCalled();
    });

    it('flushCodeLiveUpdate ist No-Op ohne Gate', () => {
        document.body.className = 'edit-mode kind-text';
        path = '/tmp/a.json';
        setText = vi.fn();
        (window as any).FolioCodeView = { isMounted: () => true, setText };
        (window as any).FolioEditor = { hasEditor: () => true, getText: () => 'x' };
        codeLive.flushCodeLiveUpdate();
        expect(setText).not.toHaveBeenCalled();
    });
});
