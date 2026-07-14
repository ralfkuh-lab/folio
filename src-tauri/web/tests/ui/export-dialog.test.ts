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
import { seedDeCatalog } from '../helpers-i18n';
import {
    initExportDialog,
    splitLayoutsByFavorites,
} from '../../app/ui/export-dialog';

function buildDom(): void {
    document.body.innerHTML = `
        <button id="tb-export"></button>
        <div id="export-dialog" hidden>
            <div id="export-formats">
                <button data-format="html"></button>
                <button data-format="pdf"></button>
            </div>
            <details id="export-ai-section">
                <summary>KI</summary>
                <textarea id="export-ai-prompt"></textarea>
                <select id="export-ai-base"></select>
                <select id="export-ai-model"></select>
                <p id="export-ai-error" hidden></p>
                <div id="export-ai-status"></div>
                <button id="export-ai-start"></button>
                <button id="export-ai-cancel"></button>
                <div id="export-ai-draft-actions" hidden>
                    <button id="export-ai-regenerate"></button>
                    <button id="export-ai-save-theme"></button>
                </div>
            </details>
            <div id="export-cards"></div>
            <button id="export-save"></button>
            <button id="export-cancel"></button>
            <div id="export-ai-save-dialog" hidden>
                <form id="export-ai-save-form">
                    <input id="export-ai-save-id" />
                    <input id="export-ai-save-name" />
                    <p id="export-ai-save-error" hidden></p>
                    <button id="export-ai-save-cancel" type="button"></button>
                </form>
            </div>
        </div>
    `;
    document.body.className = 'kind-markdown';
}

function flush(): Promise<void> {
    // openExportDialog kettet mehrere Promises (sync -> Promise.all
    // -> Karten-Render) — ein paar Microtask-Runden reichen in jsdom.
    return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

let themeFavorites: string[] = [];

function setupInvokeResponses(handles: TauriMockHandles): void {
    handles.invoke.mockImplementation((cmd: string) => {
        switch (cmd) {
            case 'export_layouts':
                return Promise.resolve([
                    { id: 'plain', name: 'Plain', description: '' },
                    { id: 'github', name: 'GitHub', description: '' },
                    { id: 'clean', name: 'Clean', description: '' },
                ]);
            case 'settings_get':
                return Promise.resolve({ themeFavorites });
            case 'export_render':
                return Promise.resolve('<html></html>');
            case 'export_render_draft':
                return Promise.resolve('<html><title>draft</title></html>');
            case 'pick_export_target':
                return Promise.resolve('/tmp/out.html');
            case 'export_html':
            case 'export_pdf':
            case 'export_html_draft':
            case 'export_pdf_draft':
            case 'theme_create':
                return Promise.resolve();
            case 'ai_config_get':
                return Promise.resolve({
                    provider: {
                        mock: {
                            enabled: true,
                            name: 'Mock',
                            whitelist: ['model'],
                        },
                    },
                    defaultModel: { provider: 'mock', model: 'model' },
                });
            case 'ai_catalog_get':
                return Promise.resolve({
                    catalog: {
                        mock: {
                            id: 'mock',
                            name: 'Mock',
                            models: { model: { id: 'model', name: 'Model' } },
                        },
                    },
                });
            case 'ai_theme_author':
                return Promise.resolve({
                    manifest: {
                        name: 'Draft Layout',
                        description: 'AI',
                        code: 'light',
                        cover: false,
                        header: false,
                        footer: false,
                        hideInlineFrontmatter: false,
                        formatVersion: 1,
                    },
                    contentCss: '.markdown-body { color: red; }',
                });
            default:
                return Promise.resolve();
        }
    });
}

function exportCalls(handles: TauriMockHandles): number {
    return handles.invoke.mock.calls.filter((c) => c[0] === 'pick_export_target').length;
}

function calls(handles: TauriMockHandles, cmd: string): any[][] {
    return handles.invoke.mock.calls.filter((c) => c[0] === cmd);
}

async function openDialog(): Promise<void> {
    document.getElementById('tb-export')!.click();
    await flush();
}

describe('export-dialog', () => {
    let handles: TauriMockHandles;

    beforeEach(async () => {
        await seedDeCatalog();
        themeFavorites = [];
        handles = installTauriMock();
        setupInvokeResponses(handles);
        buildDom();
        initExportDialog({
            getCurrentPath: () => '/doc/sample.md',
            syncEditorTextToStore: () => Promise.resolve(),
            showStatus: () => undefined,
        });
    });

    it('gruppiert Favoriten in gespeicherter Reihenfolge und ignoriert tote IDs', () => {
        const groups = splitLayoutsByFavorites([
            { id: 'plain', name: 'Plain' },
            { id: 'github', name: 'GitHub' },
            { id: 'clean', name: 'Clean' },
        ], ['geloescht', 'clean', 'github', 'clean']);

        expect(groups.favorites.map((layout) => layout.id)).toEqual(['clean', 'github']);
        expect(groups.rest.map((layout) => layout.id)).toEqual(['plain']);
    });

    it('startet beim Klick auf Speichern genau einen Export', async () => {
        await openDialog();
        expect(document.getElementById('export-dialog')!.hidden).toBe(false);

        document.getElementById('export-save')!.click();
        await flush();

        expect(exportCalls(handles)).toBe(1);
    });

    it('öffnet über file.export denselben Dialogpfad wie die Toolbar', async () => {
        handles.emitEvent('menu:file_export');
        await flush();

        expect(document.getElementById('export-dialog')!.hidden).toBe(false);
        expect(document.querySelectorAll('#export-cards .export-card')).toHaveLength(3);
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

    it('rendert ohne Favoriten weiterhin eine flache Kartenliste', async () => {
        await openDialog();

        expect(document.getElementById('export-more-toggle')).toBeNull();
        expect(document.querySelectorAll('#export-cards .export-card')).toHaveLength(3);
        expect(handles.invoke.mock.calls.filter((c) => c[0] === 'export_render'))
            .toHaveLength(3);
    });

    it('priorisiert Favoriten und lädt weitere Vorschauen erst beim Aufklappen', async () => {
        themeFavorites = ['geloescht', 'github'];
        await openDialog();

        const firstCard = document.querySelector<HTMLElement>(
            '#export-cards .export-card',
        )!;
        const toggle = document.getElementById('export-more-toggle') as HTMLButtonElement;
        const moreCards = document.getElementById('export-more-cards')!;
        expect(firstCard.dataset.layoutId).toBe('github');
        expect(toggle.textContent).toBe('Weitere Layouts (2)');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(moreCards.hidden).toBe(true);
        expect(handles.invoke.mock.calls.filter((c) => c[0] === 'export_render'))
            .toHaveLength(1);

        toggle.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
        }));
        await flush();
        expect(exportCalls(handles)).toBe(0);

        toggle.click();
        await flush();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(moreCards.hidden).toBe(false);
        expect(handles.invoke.mock.calls.filter((c) => c[0] === 'export_render'))
            .toHaveLength(3);
    });

    it('injiziert nach KI-Generierung eine auswählbare Draft-Karte', async () => {
        await openDialog();
        (document.getElementById('export-ai-prompt') as HTMLTextAreaElement).value =
            'Ein Layout für diesen Bericht';

        document.getElementById('export-ai-start')!.click();
        await flush();

        const draftCard = document.getElementById('export-ai-draft-card') as HTMLElement;
        expect(draftCard).toBeTruthy();
        expect(draftCard.dataset.layoutId).toBe('__folio_export_ai_draft');
        expect(draftCard.classList.contains('selected')).toBe(true);
        expect(calls(handles, 'ai_theme_author')[0][1]).toMatchObject({
            withDocument: true,
            providerId: 'mock',
            modelId: 'model',
        });
        expect(calls(handles, 'export_render_draft')).toHaveLength(1);
    });

    it('routet Speichern bei selektiertem KI-Entwurf auf Draft-Export', async () => {
        await openDialog();
        (document.getElementById('export-ai-prompt') as HTMLTextAreaElement).value =
            'Ein Layout für diesen Bericht';
        document.getElementById('export-ai-start')!.click();
        await flush();

        document.getElementById('export-save')!.click();
        await flush();

        expect(calls(handles, 'export_html_draft')).toHaveLength(1);
        expect(calls(handles, 'export_html')).toHaveLength(0);
        expect(calls(handles, 'export_html_draft')[0][1]).toMatchObject({
            targetPath: '/tmp/out.html',
            parts: {
                contentCss: '.markdown-body { color: red; }',
            },
        });
    });

    it('verwirft den KI-Draft beim Schliessen des Exportdialogs', async () => {
        await openDialog();
        (document.getElementById('export-ai-prompt') as HTMLTextAreaElement).value =
            'Ein Layout für diesen Bericht';
        document.getElementById('export-ai-start')!.click();
        await flush();
        expect(document.getElementById('export-ai-draft-card')).toBeTruthy();

        document.getElementById('export-cancel')!.click();

        expect(document.getElementById('export-ai-draft-card')).toBeNull();
        expect(document.getElementById('export-dialog')!.hidden).toBe(true);
    });
});
