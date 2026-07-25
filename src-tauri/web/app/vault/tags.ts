/* Tag-Browser in der linken Rail (#vault-tags-section).
   Lazy-Load beim ersten Aufklappen + manueller Refresh. Collapse
   persistent via vault_toggle_section("tags"). */

import { t } from '../i18n/translate';
import { openDocument } from '../state/document';
import { folioLog, safeInvoke } from '../util/log';
import { openVaultSearchDialog } from './search';

export type VaultTagFile = { path: string; name: string };
export type VaultTagEntry = {
    tag: string;
    count: number;
    files: VaultTagFile[];
    truncated: boolean;
};
export type VaultTagsResult = {
    tags: VaultTagEntry[];
    truncated: boolean;
};

let expanded = false;
let loaded = false;
let loading = false;
let lastResult: VaultTagsResult | null = null;
/** Welche Tag-Keys (lowercase) inline aufgeklappt sind. */
const openTags = new Set<string>();
let wired = false;

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function invokeCommand(): ((cmd: string, args?: any) => Promise<any>) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

export function isTagsSectionExpanded(): boolean {
    return expanded;
}

/** Rendert die Tag-Liste aus einem vault_tags-Response. Export für Tests. */
export function renderVaultTags(result: VaultTagsResult | null | undefined): void {
    lastResult = result || { tags: [], truncated: false };
    const empty = $('vault-tags-empty');
    const list = $('vault-tags-list');
    const trunc = $('vault-tags-truncated');
    if (!empty || !list) return;

    // Loading-Zeile entfernen
    const body = $('vault-tags-body');
    if (body) {
        const loadEl = body.querySelector('.vault-tags-loading');
        if (loadEl) loadEl.remove();
    }

    const tags = lastResult.tags || [];
    if (tags.length === 0) {
        empty.hidden = false;
        empty.textContent = t('vault.tags.empty');
        list.hidden = true;
        list.innerHTML = '';
        if (trunc) trunc.hidden = true;
        return;
    }

    empty.hidden = true;
    list.hidden = false;
    list.innerHTML = '';

    for (const entry of tags) {
        const key = entry.tag.toLowerCase();
        const li = document.createElement('li');
        li.className = 'vault-tag' + (openTags.has(key) ? ' open' : '');
        li.dataset.tag = entry.tag;

        const row = document.createElement('div');
        row.className = 'vault-tag-row';
        row.setAttribute('role', 'button');
        row.tabIndex = 0;

        const caret = document.createElement('span');
        caret.className = 'vault-tag-caret';
        caret.setAttribute('aria-hidden', 'true');
        caret.textContent = '▾';
        row.appendChild(caret);

        const label = document.createElement('span');
        label.className = 'vault-tag-label';
        label.textContent = '#' + entry.tag;
        label.title = '#' + entry.tag;
        row.appendChild(label);

        const count = document.createElement('span');
        count.className = 'vault-tag-count';
        count.textContent = String(entry.count);
        row.appendChild(count);

        const searchBtn = document.createElement('button');
        searchBtn.type = 'button';
        searchBtn.className = 'vault-tag-search';
        searchBtn.title = t('vault.tags.search.tooltip');
        searchBtn.setAttribute('aria-label', t('vault.tags.search.ariaLabel'));
        searchBtn.dataset.tag = entry.tag;
        searchBtn.textContent = '\u{1F50D}';
        row.appendChild(searchBtn);

        li.appendChild(row);

        const filesUl = document.createElement('ul');
        filesUl.className = 'vault-tag-files';
        for (const f of entry.files || []) {
            const fLi = document.createElement('li');
            fLi.className = 'vault-tag-file';
            fLi.dataset.path = f.path;
            fLi.title = f.path;
            fLi.textContent = f.name || f.path;
            filesUl.appendChild(fLi);
        }
        li.appendChild(filesUl);
        list.appendChild(li);
    }

    if (trunc) {
        trunc.hidden = !lastResult.truncated;
        if (lastResult.truncated) trunc.textContent = t('vault.tags.truncated');
    }
}

function applyExpandedUi(): void {
    const section = $('vault-tags-section');
    const header = $('vault-tags-header');
    if (section) section.classList.toggle('collapsed', !expanded);
    if (header) header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function setExpanded(next: boolean, persist: boolean): void {
    expanded = next;
    applyExpandedUi();
    if (persist) {
        safeInvoke(
            'vault_toggle_section',
            { section: 'tags', expanded },
            'vault_toggle_section tags',
            'debug',
        );
    }
    if (expanded && !loaded) {
        void loadTags(false);
    }
}

function showLoading(): void {
    const body = $('vault-tags-body');
    if (!body) return;
    let el = body.querySelector('.vault-tags-loading') as HTMLElement | null;
    if (!el) {
        el = document.createElement('div');
        el.className = 'vault-tags-loading';
        body.insertBefore(el, body.firstChild);
    }
    el.textContent = t('vault.tags.loading');
    const empty = $('vault-tags-empty');
    const list = $('vault-tags-list');
    if (empty) empty.hidden = true;
    if (list) list.hidden = true;
}

/** Fehlerzustand: loaded bleibt false, Retry über ⟳. Export für Tests. */
export function renderVaultTagsError(): void {
    const body = $('vault-tags-body');
    if (body) {
        const loadEl = body.querySelector('.vault-tags-loading');
        if (loadEl) loadEl.remove();
    }
    const empty = $('vault-tags-empty');
    const list = $('vault-tags-list');
    const trunc = $('vault-tags-truncated');
    if (empty) {
        empty.hidden = false;
        empty.textContent = t('vault.tags.error');
    }
    if (list) {
        list.hidden = true;
        list.innerHTML = '';
    }
    if (trunc) trunc.hidden = true;
}

/** Test-Hook: loaded-Flag. */
export function __vaultTagsLoadedForTests(): boolean {
    return loaded;
}

/** Lädt Tags vom Backend. `force` ignoriert den loaded-Cache. */
export async function loadTags(force: boolean): Promise<void> {
    if (loading) return;
    if (loaded && !force && lastResult) {
        renderVaultTags(lastResult);
        return;
    }
    const invoke = invokeCommand();
    if (!invoke) {
        renderVaultTags({ tags: [], truncated: false });
        loaded = true;
        return;
    }
    loading = true;
    const refreshBtn = $('vault-tags-refresh') as HTMLButtonElement | null;
    if (refreshBtn) refreshBtn.disabled = true;
    showLoading();
    try {
        const result = (await invoke('vault_tags')) as VaultTagsResult;
        loaded = true;
        renderVaultTags(result || { tags: [], truncated: false });
    } catch (err) {
        folioLog.warn('tags', 'vault_tags failed', { error: String(err) });
        // F9: loaded NICHT setzen — Retry über ⟳ muss neu laden.
        renderVaultTagsError();
    } finally {
        loading = false;
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

function openPath(path: string, newTab: boolean): void {
    if (!path) return;
    if (newTab) {
        safeInvoke('tab_open', { path }, 'tab_open', 'warn');
    } else {
        void openDocument(path);
    }
}

function onHeaderClick(e: MouseEvent): void {
    const tEl = e.target as HTMLElement | null;
    if (tEl && tEl.closest('#vault-tags-refresh')) return;
    setExpanded(!expanded, true);
}

function onRefreshClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!expanded) setExpanded(true, true);
    void loadTags(true);
}

function onListClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const searchBtn = target.closest('.vault-tag-search') as HTMLElement | null;
    if (searchBtn) {
        e.preventDefault();
        e.stopPropagation();
        const tag = searchBtn.dataset.tag || '';
        openVaultSearchDialog({ prefillQuery: tag ? '#' + tag : '#' });
        return;
    }

    const file = target.closest('.vault-tag-file') as HTMLElement | null;
    if (file && file.dataset.path) {
        e.preventDefault();
        openPath(file.dataset.path, e.ctrlKey || e.metaKey);
        return;
    }

    const row = target.closest('.vault-tag-row') as HTMLElement | null;
    if (row) {
        const li = row.closest('li.vault-tag') as HTMLElement | null;
        if (!li) return;
        const tag = li.dataset.tag || '';
        const key = tag.toLowerCase();
        if (openTags.has(key)) {
            openTags.delete(key);
            li.classList.remove('open');
        } else {
            openTags.add(key);
            li.classList.add('open');
        }
    }
}

/** Test-Hook: State zurücksetzen (inkl. Wiring, damit jsdom-DOM neu bindet). */
export function __resetVaultTagsForTests(): void {
    expanded = false;
    loaded = false;
    loading = false;
    lastResult = null;
    openTags.clear();
    wired = false;
}

export function initVaultTags(): void {
    if (wired) return;
    wired = true;

    const header = $('vault-tags-header');
    if (header) {
        header.addEventListener('click', onHeaderClick);
        header.addEventListener('keydown', function (e: KeyboardEvent) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setExpanded(!expanded, true);
            }
        });
    }
    const refresh = $('vault-tags-refresh');
    if (refresh) refresh.addEventListener('click', onRefreshClick);

    const list = $('vault-tags-list');
    if (list) list.addEventListener('click', onListClick);

    // Boot: Collapse-State laden (kein Scan).
    const invoke = invokeCommand();
    if (invoke) {
        invoke('vault_tags_section_get')
            .then(function (res: any) {
                const exp = !!(res && res.expanded);
                setExpanded(exp, false);
            })
            .catch(function (err: unknown) {
                folioLog.debug('tags', 'vault_tags_section_get failed', {
                    error: String(err),
                });
                applyExpandedUi();
            });
    } else {
        applyExpandedUi();
    }
}
