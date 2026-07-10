import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';

vi.mock('../../app/state/tabs', () => ({
    getActiveTabId: vi.fn(() => 7),
}));
vi.mock('../../app/state/document', () => ({
    getCurrentPath: vi.fn(() => '/tmp/doc.md'),
    getEditorText: vi.fn(() => '# Doc'),
    syncEditorTextToStoreForTab: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../app/view/preview', () => ({
    renderPreviewText: vi.fn(() => Promise.resolve()),
}));

import { initAiActionsDialog, openAiActionsDialog } from '../../app/ui/ai-actions-dialog';
import { getActiveTabId } from '../../app/state/tabs';
import {
    getCurrentPath,
    getEditorText,
    syncEditorTextToStoreForTab,
} from '../../app/state/document';
import { renderPreviewText } from '../../app/view/preview';

const config = {
    provider: {
        local: {
            enabled: true,
            custom: true,
            name: 'Lokaler Provider',
            models: { mock: { name: 'Mock Modell' } },
            whitelist: ['mock'],
        },
    },
    defaultModel: { provider: 'local', model: 'mock' },
};

const templates = [
    {
        id: 'summarize',
        name: 'Zusammenfassen',
        description: 'Prägnante Zusammenfassung als neues Dokument.',
        prompt: 'Fasse zusammen.',
        masking: false,
        scope: 'document',
        target: 'new-file',
        suffix: 'summary',
        builtin: true,
    },
    {
        id: 'eigenes',
        name: 'Eigenes Template',
        description: 'Vom User.',
        prompt: 'Mach was.',
        masking: true,
        scope: 'auto',
        target: 'replace',
        suffix: 'eigenes',
        builtin: false,
    },
];

function buildDom(): void {
    document.body.className = 'kind-markdown';
    document.body.innerHTML = `
        <button id="tb-ai-actions" disabled></button>
        <div id="ai-actions-dialog" hidden>
            <ul id="ai-actions-list"></ul>
            <textarea id="ai-actions-prompt"></textarea>
            <div id="ai-actions-target-row">
                <input type="radio" name="ai-actions-target" id="ai-actions-target-newfile" value="new-file" checked />
                <label id="ai-actions-target-replace-label">
                    <input type="radio" name="ai-actions-target" id="ai-actions-target-replace" value="replace" />
                </label>
            </div>
            <div id="ai-actions-scope-row" hidden>
                <input type="radio" name="ai-actions-scope" id="ai-actions-scope-selection" value="selection" />
                <span id="ai-actions-scope-selection-label"></span>
                <input type="radio" name="ai-actions-scope" id="ai-actions-scope-document" value="document" />
            </div>
            <select id="ai-actions-model"></select>
            <p id="ai-actions-error" hidden></p>
            <button id="ai-actions-cancel"></button>
            <button id="ai-actions-start">Ausführen</button>
        </div>
        <div id="ai-action-status" hidden>
            <span id="ai-action-status-text"></span>
            <button id="ai-action-status-cancel">Abbrechen</button>
        </div>
    `;
}

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ai-actions-dialog', () => {
    let handles: TauriMockHandles;
    let runResolver: ((value: unknown) => void) | null;
    let runRejecter: ((reason: unknown) => void) | null;
    let lastRunArgs: any;

    beforeEach(() => {
        buildDom();
        vi.mocked(getActiveTabId).mockReturnValue(7);
        vi.mocked(getCurrentPath).mockReturnValue('/tmp/doc.md');
        vi.mocked(getEditorText).mockReturnValue('# Doc');
        vi.mocked(syncEditorTextToStoreForTab).mockResolvedValue(undefined);
        vi.mocked(renderPreviewText).mockClear();
        runResolver = null;
        runRejecter = null;
        lastRunArgs = null;
        handles = installTauriMock();
        handles.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'ai_config_get') return Promise.resolve(config);
            if (cmd === 'ai_catalog_get') return Promise.resolve({ catalog: {} });
            if (cmd === 'ai_actions_list') return Promise.resolve(templates);
            if (cmd === 'ai_action_run') {
                lastRunArgs = args;
                return new Promise((resolve, reject) => {
                    runResolver = resolve;
                    runRejecter = reject;
                });
            }
            return Promise.resolve(undefined);
        });
        initAiActionsDialog();
    });

    it('rendert Built-ins, eigene Templates und den Custom-Eintrag und wählt das erste Built-in vor', async () => {
        await openAiActionsDialog();

        const dialog = document.getElementById('ai-actions-dialog')!;
        expect(dialog.hidden).toBe(false);
        const items = Array.from(document.querySelectorAll('.ai-actions-dialog__item'));
        expect(items.map((item) => (item as HTMLElement).dataset.actionId))
            .toEqual(['summarize', 'eigenes', '__custom__']);
        expect(items[0].getAttribute('aria-selected')).toBe('true');
        expect((document.getElementById('ai-actions-prompt') as HTMLTextAreaElement).value)
            .toBe('Fasse zusammen.');
        // Seit A3 ist Replace wählbar; summarize (target new-file) wählt Neue Datei vor.
        expect((document.getElementById('ai-actions-target-replace') as HTMLInputElement).disabled)
            .toBe(false);
        expect((document.getElementById('ai-actions-target-newfile') as HTMLInputElement).checked)
            .toBe(true);
        const model = document.getElementById('ai-actions-model') as HTMLSelectElement;
        expect(model.options[0].textContent).toBe('Lokaler Provider · Mock Modell');
    });

    it('startet den Lauf mit eingefrorenem Quellkontext (tabId, Pfad, sha256, tab-gebundener Sync)', async () => {
        await openAiActionsDialog();
        document.getElementById('ai-actions-start')!.click();
        await flush();

        expect(syncEditorTextToStoreForTab).toHaveBeenCalledWith(7, '# Doc');
        expect(lastRunArgs.request.actionId).toBe('summarize');
        expect(lastRunArgs.request.prompt).toBe('Fasse zusammen.');
        expect(lastRunArgs.request.providerId).toBe('local');
        expect(lastRunArgs.request.modelId).toBe('mock');
        expect(lastRunArgs.request.target).toBe('new-file');
        expect(lastRunArgs.request.masking).toBe(false);
        expect(lastRunArgs.request.suffix).toBe('summary');
        expect(lastRunArgs.request.scope).toBeNull();
        expect(lastRunArgs.request.sourceTabId).toBe(7);
        expect(lastRunArgs.request.sourcePath).toBe('/tmp/doc.md');
        expect(lastRunArgs.request.sourceTextSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof lastRunArgs.request.requestId).toBe('string');
        expect(document.getElementById('ai-actions-dialog')!.hidden).toBe(true);
        expect(document.getElementById('ai-action-status')!.hidden).toBe(false);
    });

    it('bricht ab, wenn sich der aktive Tab vor dem Start geändert hat', async () => {
        await openAiActionsDialog();
        vi.mocked(getActiveTabId).mockReturnValue(99);
        document.getElementById('ai-actions-start')!.click();
        await flush();

        expect(lastRunArgs).toBeNull();
        const error = document.getElementById('ai-actions-error')!;
        expect(error.hidden).toBe(false);
        expect(error.textContent).toContain('Quelle hat sich geändert');
    });

    it('bindet Cancel an die runId aus dem Started-Handshake — auch bei Cancel VOR Started', async () => {
        await openAiActionsDialog();
        document.getElementById('ai-actions-start')!.click();
        await flush();

        // Cancel vor Started: nur Abort-Flag, noch kein Backend-Call.
        document.getElementById('ai-action-status-cancel')!.click();
        expect(handles.invoke).not.toHaveBeenCalledWith('ai_action_cancel', expect.anything());

        handles.emitEvent('ai:action_started', {
            runId: 42,
            requestId: lastRunArgs.request.requestId,
        });
        await flush();
        expect(handles.invoke).toHaveBeenCalledWith('ai_action_cancel', { runId: 42 });
    });

    it('filtert Stream-Events per runId und rendert die Preview nur für den aktiven Tab', async () => {
        await openAiActionsDialog();
        document.getElementById('ai-actions-start')!.click();
        await flush();
        handles.emitEvent('ai:action_started', {
            runId: 5,
            requestId: lastRunArgs.request.requestId,
        });

        // Fremde runId → ignoriert.
        handles.emitEvent('ai:action_stream', { runId: 4, chars: 999, tabId: 7, text: 'fremd' });
        expect(renderPreviewText).not.toHaveBeenCalled();

        // Eigene runId, aktiver Ziel-Tab → Status + Preview.
        handles.emitEvent('ai:action_stream', { runId: 5, chars: 12, tabId: 7, text: 'Hallo' });
        expect(document.getElementById('ai-action-status-text')!.textContent)
            .toContain('12');
        expect(renderPreviewText).toHaveBeenCalledWith('Hallo');

        // Eigene runId, anderer Tab aktiv → kein Preview-Render.
        vi.mocked(renderPreviewText).mockClear();
        vi.mocked(getActiveTabId).mockReturnValue(8);
        handles.emitEvent('ai:action_stream', { runId: 5, chars: 20, tabId: 7, text: 'Mehr' });
        expect(renderPreviewText).not.toHaveBeenCalled();
    });

    it('öffnet den Dialog bei Fehlern mit Fehlertext wieder, wenn die Quelle noch da ist', async () => {
        await openAiActionsDialog();
        document.getElementById('ai-actions-start')!.click();
        await flush();

        runRejecter!('Provider kaputt');
        await flush();

        expect(document.getElementById('ai-actions-dialog')!.hidden).toBe(false);
        expect(document.getElementById('ai-actions-error')!.textContent)
            .toContain('Provider kaputt');
        expect(document.getElementById('ai-action-status')!.hidden).toBe(true);
    });

    it('zeigt bei Erfolg keinen Dialog und räumt die Statusleiste über done auf', async () => {
        await openAiActionsDialog();
        document.getElementById('ai-actions-start')!.click();
        await flush();
        handles.emitEvent('ai:action_started', {
            runId: 6,
            requestId: lastRunArgs.request.requestId,
        });

        runResolver!({ kind: 'file', runId: 6, path: '/tmp/doc.summary.md' });
        await flush();

        expect(document.getElementById('ai-actions-dialog')!.hidden).toBe(true);
        expect(document.getElementById('ai-action-status')!.hidden).toBe(true);
    });

    it('invalidiert ein Close während des Ladens (openGeneration-Token)', async () => {
        let resolveConfig: ((value: unknown) => void) | null = null;
        handles.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'ai_config_get') {
                return new Promise((resolve) => { resolveConfig = resolve; });
            }
            if (cmd === 'ai_catalog_get') return Promise.resolve({ catalog: {} });
            if (cmd === 'ai_actions_list') return Promise.resolve(templates);
            return Promise.resolve(undefined);
        });

        const opening = openAiActionsDialog();
        await flush();
        // Close während loading.
        document.getElementById('ai-actions-cancel')!.click();
        resolveConfig!(config);
        await opening;

        expect(document.getElementById('ai-actions-dialog')!.hidden).toBe(true);
    });

    it('zeigt die Scope-Zeile nur bei vorhandener Selektion und schickt deren Offsets', async () => {
        (window as any).FolioEditor = {
            getSelection: () => ({ start: 2, length: 3 }),
        };
        await openAiActionsDialog();

        expect(document.getElementById('ai-actions-scope-row')!.hidden).toBe(false);
        expect((document.getElementById('ai-actions-scope-selection') as HTMLInputElement).checked)
            .toBe(false); // summarize hat scope=document → Dokument vorgewählt
        // Eigenes Template (scope=auto) → Selektion vorgewählt.
        (document.querySelectorAll('.ai-actions-dialog__item')[1] as HTMLElement).click();
        expect((document.getElementById('ai-actions-scope-selection') as HTMLInputElement).checked)
            .toBe(true);

        document.getElementById('ai-actions-start')!.click();
        await flush();
        expect(lastRunArgs.request.scope).toEqual({ start: 2, length: 3 });
        expect(lastRunArgs.request.masking).toBe(true);
        expect(lastRunArgs.request.suffix).toBe('eigenes');
    });
});
