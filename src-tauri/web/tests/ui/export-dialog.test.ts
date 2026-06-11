// Tests fuer ui/export-dialog.ts. Schwerpunkt (Regression K3 aus dem
// Code-Review 2026-06-11):
// - "Speichern" loest genau EINEN Export aus (der historische
//   Doppel-Init aus main.ts + toolbar-actions.ts band alle Listener
//   doppelt -> zwei pick_export_target-Dialoge).
// - Nach dem Schliessen ist der Keydown-Handler weg und
//   selectedLayoutId genullt: Enter irgendwo in der App darf keinen
//   Export mehr starten.
// - Re-Open ohne Close raeumt den alten Keydown-Handler ab (kein Leak,
//   Escape schliesst genau einmal).

import { beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';
import { initExportDialog } from '../../app/ui/export-dialog';

function buildDom(): void {
    document.body.innerHTML = `
        <button id="tb-export"></button>
        <div id="export-dialog" hidden>
            <div id="export-formats">
                <button data-format="html"></button>
                <button data-format="pdf"></button>
            </div>
            <div id="export-cards"></div>
            <button id="export-save"></button>
            <button id="export-cancel"></button>
        </div>
    `;
    document.body.className = 'kind-markdown';
}

function flush(): Promise<void> {
    // openExportDialog kettet mehrere Promises (sync -> export_layouts
    // -> Karten-Render) — ein paar Microtask-Runden reichen in jsdom.
    return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function setupInvokeResponses(handles: TauriMockHandles): void {
    handles.invoke.mockImplementation((cmd: string) => {
        switch (cmd) {
            case 'export_layouts':
                return Promise.resolve([{ id: 'plain', name: 'Plain', description: '' }]);
            case 'export_render':
                return Promise.resolve('<html></html>');
            case 'pick_export_target':
                return Promise.resolve('/tmp/out.html');
            case 'export_html':
            case 'export_pdf':
                return Promise.resolve();
            default:
                return Promise.resolve();
        }
    });
}

function exportCalls(handles: TauriMockHandles): number {
    return handles.invoke.mock.calls.filter((c) => c[0] === 'pick_export_target').length;
}

async function openDialog(): Promise<void> {
    document.getElementById('tb-export')!.click();
    await flush();
}

describe('export-dialog', () => {
    let handles: TauriMockHandles;

    beforeEach(() => {
        handles = installTauriMock();
        setupInvokeResponses(handles);
        buildDom();
        initExportDialog({
            getCurrentPath: () => '/doc/sample.md',
            syncEditorTextToStore: () => Promise.resolve(),
            showStatus: () => undefined,
        });
    });

    it('startet beim Klick auf Speichern genau einen Export', async () => {
        await openDialog();
        expect(document.getElementById('export-dialog')!.hidden).toBe(false);

        document.getElementById('export-save')!.click();
        await flush();

        expect(exportCalls(handles)).toBe(1);
    });

    it('Enter nach dem Schliessen startet keinen Export mehr', async () => {
        await openDialog();
        document.getElementById('export-cancel')!.click();
        expect(document.getElementById('export-dialog')!.hidden).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flush();

        expect(exportCalls(handles)).toBe(0);
    });

    it('Re-Open ohne Close leakt keinen Keydown-Handler', async () => {
        await openDialog();
        await openDialog();

        // Escape schliesst den Dialog; ein geleakter Alt-Handler wuerde
        // beim nachfolgenden Enter trotzdem noch exportieren.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.getElementById('export-dialog')!.hidden).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flush();

        expect(exportCalls(handles)).toBe(0);
    });
});
