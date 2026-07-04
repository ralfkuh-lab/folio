import { beforeEach, describe, expect, it } from 'vitest';
import { installTauriMock, TauriMockHandles } from '../helpers';
import { initSettingsDialog, openSettingsDialog } from '../../app/ui/settings-dialog';

const settings = {
    language: 'de',
    defaultModeMarkdown: 'current',
    defaultModeText: 'current',
    viewAutoFormat: true,
    vaultAutoRefresh: true,
    documentAutoReload: true,
    exportDirMode: 'document',
    logLevel: 'info',
};

function buildDom(): void {
    document.body.innerHTML = `
        <div id="settings-dialog" hidden>
            <select id="settings-export-dir-mode">
                <option value="document">Verzeichnis der Datei</option>
                <option value="last">Zuletzt gewähltes Verzeichnis</option>
            </select>
            <button id="settings-close"></button>
        </div>
    `;
}

function flush(): Promise<void> {
    return Promise.resolve().then(() => Promise.resolve());
}

describe('settings-dialog exportDirMode', () => {
    let handles: TauriMockHandles;

    beforeEach(() => {
        handles = installTauriMock();
        buildDom();
        handles.invoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'settings_get') return Promise.resolve(settings);
            if (cmd === 'settings_update') {
                return Promise.resolve({ ...settings, ...args.patch });
            }
            return Promise.resolve();
        });
        initSettingsDialog();
    });

    it('lädt den Default und persistiert den ausgewählten Modus', async () => {
        openSettingsDialog();
        await flush();

        const select = document.getElementById(
            'settings-export-dir-mode',
        ) as HTMLSelectElement;
        expect(select.value).toBe('document');

        select.value = 'last';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();

        expect(handles.invoke).toHaveBeenCalledWith('settings_update', {
            patch: { exportDirMode: 'last' },
        });
        expect(select.value).toBe('last');
    });
});
