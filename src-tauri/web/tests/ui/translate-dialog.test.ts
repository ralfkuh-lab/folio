import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    initTranslateDialog,
    openTranslateDialog,
} from '../../app/ui/translate-dialog';
import { installTauriMock, TauriMockHandles } from '../helpers';

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
    translate: { recentLanguages: ['de', 'sv'] },
};

function buildDom(): void {
    document.body.className = 'kind-markdown';
    document.body.innerHTML = `
        <button id="tb-ai-translate" disabled></button>
        <div id="ai-translate-dialog" hidden>
            <input type="checkbox" id="ai-translate-lang-en" />
            <input type="checkbox" id="ai-translate-lang-de" />
            <input type="checkbox" id="ai-translate-lang-fr" />
            <input type="checkbox" id="ai-translate-lang-es" />
            <input type="checkbox" id="ai-translate-lang-it" />
            <input type="checkbox" id="ai-translate-lang-pt" />
            <input type="checkbox" id="ai-translate-lang-nl" />
            <input type="checkbox" id="ai-translate-lang-pl" />
            <input type="checkbox" id="ai-translate-lang-ja" />
            <input type="checkbox" id="ai-translate-lang-zh" />
            <input id="ai-translate-langs-extra" />
            <select id="ai-translate-model"></select>
            <p id="ai-translate-error" hidden></p>
            <button id="ai-translate-cancel"></button>
            <button id="ai-translate-start">Übersetzen</button>
        </div>
        <div id="ai-translate-status" hidden>
            <span id="ai-translate-status-text"></span>
            <button id="ai-translate-status-cancel">Abbrechen</button>
        </div>
    `;
}

describe('translate-dialog', () => {
    let handles: TauriMockHandles;

    beforeEach(() => {
        buildDom();
        handles = installTauriMock();
        handles.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'ai_config_get') return Promise.resolve(config);
            if (cmd === 'ai_catalog_get') return Promise.resolve({ catalog: {} });
            if (cmd === 'ai_translate_document') return Promise.resolve(['/tmp/doc.de.md']);
            return Promise.resolve(undefined);
        });
        initTranslateDialog();
    });

    it('belegt Sprachen und Default-Modell vor und startet die Übersetzung', async () => {
        await openTranslateDialog();

        expect(document.getElementById('ai-translate-dialog')!.hidden).toBe(false);
        expect((document.getElementById('ai-translate-lang-de') as HTMLInputElement).checked)
            .toBe(true);
        expect((document.getElementById('ai-translate-langs-extra') as HTMLInputElement).value)
            .toBe('sv');
        const model = document.getElementById('ai-translate-model') as HTMLSelectElement;
        expect(model.options[0].textContent).toBe('Lokaler Provider · Mock Modell');

        document.getElementById('ai-translate-start')!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(handles.invoke).toHaveBeenCalledWith('ai_translate_document', {
            languages: ['de', 'sv'],
            providerId: 'local',
            modelId: 'mock',
        });
        expect(document.getElementById('ai-translate-dialog')!.hidden).toBe(true);
        expect(handles.invoke).toHaveBeenCalledWith('menu_set_enabled', {
            id: 'edit.ai_translate',
            enabled: true,
        });
        expect((document.getElementById('tb-ai-translate') as HTMLButtonElement).disabled)
            .toBe(false);
    });

    it('synchronisiert Menü und Toolbar-Button mit Dokumenttyp und KI-Konfiguration', async () => {
        await vi.waitFor(() => {
            expect((document.getElementById('tb-ai-translate') as HTMLButtonElement).disabled)
                .toBe(false);
        });

        handles.invoke.mockClear();
        handles.emitEvent('document:closed');
        expect((document.getElementById('tb-ai-translate') as HTMLButtonElement).disabled)
            .toBe(true);
        expect(handles.invoke).toHaveBeenCalledWith('menu_set_enabled', {
            id: 'edit.ai_translate',
            enabled: false,
        });

        handles.invoke.mockClear();
        handles.emitEvent('document:loaded', { kind: 'markdown' });
        expect((document.getElementById('tb-ai-translate') as HTMLButtonElement).disabled)
            .toBe(false);
        expect(handles.invoke).toHaveBeenCalledWith('menu_set_enabled', {
            id: 'edit.ai_translate',
            enabled: true,
        });
    });

    it('schließt den Dialog während des Laufs und aktualisiert die Statusleiste', async () => {
        let finishTranslation: (value: string[]) => void = () => {};
        handles.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'ai_config_get') return Promise.resolve(config);
            if (cmd === 'ai_catalog_get') return Promise.resolve({ catalog: {} });
            if (cmd === 'ai_translate_document') {
                return new Promise<string[]>((resolve) => {
                    finishTranslation = resolve;
                });
            }
            return Promise.resolve(undefined);
        });
        await openTranslateDialog();
        document.getElementById('ai-translate-start')!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById('ai-translate-dialog')!.hidden).toBe(true);
        expect(document.getElementById('ai-translate-status')!.hidden).toBe(false);
        handles.emitEvent('ai:translate_stream', {
            tabId: 99,
            language: 'de',
            text: 'Text',
            chars: 12400,
        });
        expect(document.getElementById('ai-translate-status-text')!.textContent)
            .toBe('KI-Übersetzung de · 12.400 Zeichen');
        handles.emitEvent('ai:translate_done', { tabId: 99, language: 'de' });
        expect(document.getElementById('ai-translate-status-text')!.textContent)
            .toContain('✓ de');

        document.getElementById('ai-translate-status-cancel')!.click();
        expect(handles.invoke).toHaveBeenCalledWith('ai_translate_cancel', undefined);

        finishTranslation(['/tmp/doc.de.md']);
        await vi.waitFor(() => {
            expect(document.getElementById('ai-translate-status')!.hidden).toBe(true);
        });
    });
});
