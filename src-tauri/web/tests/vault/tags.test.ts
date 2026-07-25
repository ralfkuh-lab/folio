import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { seedDeCatalog } from '../helpers-i18n';

const openVaultSearchDialog = vi.fn();
vi.mock('../../app/vault/search', () => ({
    openVaultSearchDialog: (...args: unknown[]) => openVaultSearchDialog(...args),
}));

vi.mock('../../app/state/document', () => ({
    openDocument: vi.fn(),
}));

import {
    __resetVaultTagsForTests,
    __vaultTagsLoadedForTests,
    initVaultTags,
    loadTags,
    renderVaultTags,
    renderVaultTagsError,
    type VaultTagsResult,
} from '../../app/vault/tags';
import { openDocument } from '../../app/state/document';

function buildDom(): void {
    document.body.innerHTML = `
        <section class="vault-tags-section collapsed" id="vault-tags-section">
            <header class="vault-tags-header" id="vault-tags-header" aria-expanded="false">
                <span class="vault-tags-caret" id="vault-tags-caret">▾</span>
                <span class="vault-tags-title" id="vault-tags-title">Tags</span>
                <button type="button" id="vault-tags-refresh">↻</button>
            </header>
            <div class="vault-tags-body" id="vault-tags-body">
                <div class="vault-tags-empty" id="vault-tags-empty"></div>
                <ul class="vault-tags-list" id="vault-tags-list" hidden></ul>
                <div class="vault-tags-truncated" id="vault-tags-truncated" hidden></div>
            </div>
        </section>
    `;
}

const sample: VaultTagsResult = {
    tags: [
        {
            tag: 'work',
            count: 2,
            files: [
                { path: '/v/a.md', name: 'a.md' },
                { path: '/v/b.md', name: 'b.md' },
            ],
            truncated: false,
        },
        {
            tag: 'life',
            count: 1,
            files: [{ path: '/v/c.md', name: 'c.md' }],
            truncated: false,
        },
    ],
    truncated: false,
};

describe('vault/tags', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        __resetVaultTagsForTests();
        buildDom();
        await seedDeCatalog();
        installTauriMock();
    });

    it('renderVaultTags fills list and labels', () => {
        renderVaultTags(sample);
        expect(document.getElementById('vault-tags-empty')!.hidden).toBe(true);
        const list = document.getElementById('vault-tags-list')!;
        expect(list.hidden).toBe(false);
        expect(list.querySelectorAll('li.vault-tag').length).toBe(2);
        expect(list.textContent).toContain('#work');
        expect(list.textContent).toContain('2');
        expect(list.querySelectorAll('li.vault-tag-file').length).toBe(3);
    });

    it('renderVaultTags shows empty state', () => {
        renderVaultTags({ tags: [], truncated: false });
        expect(document.getElementById('vault-tags-empty')!.hidden).toBe(false);
        expect(document.getElementById('vault-tags-empty')!.textContent).toBe('Keine Tags');
        expect(document.getElementById('vault-tags-list')!.hidden).toBe(true);
    });

    it('renderVaultTags shows truncated hint', () => {
        renderVaultTags({ ...sample, truncated: true });
        const hint = document.getElementById('vault-tags-truncated')!;
        expect(hint.hidden).toBe(false);
        expect(hint.textContent).toBe('Liste gekürzt');
    });

    it('tag row toggles open class (inline file list)', () => {
        renderVaultTags(sample);
        const row = document.querySelector('.vault-tag-row') as HTMLElement;
        const li = row.closest('li.vault-tag')!;
        expect(li.classList.contains('open')).toBe(false);
        // Need listeners — initVaultTags wires list click
        initVaultTags();
        row.click();
        expect(li.classList.contains('open')).toBe(true);
        row.click();
        expect(li.classList.contains('open')).toBe(false);
    });

    it('search icon calls openVaultSearchDialog with #tag prefill', () => {
        renderVaultTags(sample);
        initVaultTags();
        const btn = document.querySelector('.vault-tag-search') as HTMLButtonElement;
        btn.click();
        expect(openVaultSearchDialog).toHaveBeenCalledWith({ prefillQuery: '#work' });
    });

    it('file click calls openDocument', () => {
        renderVaultTags(sample);
        initVaultTags();
        // open first tag
        (document.querySelector('.vault-tag-row') as HTMLElement).click();
        const file = document.querySelector('.vault-tag-file') as HTMLElement;
        file.click();
        expect(openDocument).toHaveBeenCalledWith('/v/a.md');
    });

    it('loadTags invokes vault_tags and renders', async () => {
        const tauri = installTauriMock();
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_tags') return Promise.resolve(sample);
            if (cmd === 'vault_tags_section_get') return Promise.resolve({ expanded: false });
            return Promise.resolve(undefined);
        });
        initVaultTags();
        await loadTags(true);
        expect(tauri.invoke).toHaveBeenCalledWith('vault_tags');
        expect(document.getElementById('vault-tags-list')!.textContent).toContain('#work');
        expect(__vaultTagsLoadedForTests()).toBe(true);
    });

    it('F9: loadTags error leaves loaded=false and shows error text', async () => {
        const tauri = installTauriMock();
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_tags') return Promise.reject(new Error('boom'));
            if (cmd === 'vault_tags_section_get') return Promise.resolve({ expanded: false });
            return Promise.resolve(undefined);
        });
        initVaultTags();
        await loadTags(true);
        expect(__vaultTagsLoadedForTests()).toBe(false);
        const empty = document.getElementById('vault-tags-empty')!;
        expect(empty.hidden).toBe(false);
        expect(empty.textContent).toBe('Tags konnten nicht geladen werden');
        // Retry via force still works after error
        tauri.invoke.mockImplementation((cmd: string) => {
            if (cmd === 'vault_tags') return Promise.resolve(sample);
            return Promise.resolve(undefined);
        });
        await loadTags(true);
        expect(__vaultTagsLoadedForTests()).toBe(true);
        expect(document.getElementById('vault-tags-list')!.textContent).toContain('#work');
    });

    it('F9: renderVaultTagsError shows i18n message', () => {
        renderVaultTagsError();
        expect(document.getElementById('vault-tags-empty')!.textContent).toBe(
            'Tags konnten nicht geladen werden',
        );
    });
});
