/** confirmRunFile uses dialogs.run.confirm with {name} (I3a F1). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDeCatalog, loadLocaleCatalog } from '../helpers-i18n';

function buildDom(): void {
    document.body.innerHTML = `
        <div id="run-confirm-dialog" hidden>
            <p id="run-confirm-text"></p>
            <button id="run-confirm-ok">Ausführen</button>
            <button id="run-confirm-cancel">Abbrechen</button>
        </div>
    `;
}

describe('confirmRunFile i18n — de', () => {
    beforeEach(async () => {
        vi.resetModules();
        buildDom();
        await seedDeCatalog();
    });

    it('interpolates filename into confirm text via textContent', async () => {
        const { confirmRunFile } = await import('../../app/ui/dialogs');
        const p = confirmRunFile('tool.sh');
        const text = document.getElementById('run-confirm-text')!;
        expect(text.textContent).toBe('„tool.sh" als Programm ausführen?');
        document.getElementById('run-confirm-cancel')!.click();
        await expect(p).resolves.toBe(false);
    });
});

describe('confirmRunFile i18n — en', () => {
    beforeEach(async () => {
        vi.resetModules();
        buildDom();
        // Dynamic import after resetModules so seed hits the live translate module.
        const { seedCatalog, __resetI18nForTests } = await import('../../app/i18n/translate');
        __resetI18nForTests();
        seedCatalog(loadLocaleCatalog('en'));
    });

    it('interpolates filename into confirm text', async () => {
        const { confirmRunFile } = await import('../../app/ui/dialogs');
        const p = confirmRunFile('run_me.py');
        const text = document.getElementById('run-confirm-text')!;
        expect(text.textContent).toBe('Run “run_me.py” as a program?');
        document.getElementById('run-confirm-cancel')!.click();
        await expect(p).resolves.toBe(false);
    });
});
