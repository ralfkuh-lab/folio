/* Tab-Leiste: Backend `tabs:changed` ist die Source of Truth. Das Modul
   rendert nur, routet Aktivieren/Schliessen und synchronisiert den
   Monaco-Model-Lifecycle mit den noch dokumenttragenden Tabs. */

import {
    getCurrentPath,
    requestSaveIfDirty,
    syncEditorTextToStore,
} from './document';
import { folioLog } from '../util/log';

export interface TabSummary {
    id: number;
    path: string | null;
    dirty: boolean;
    active: boolean;
}

export interface TabsPayload {
    tabs: TabSummary[];
    activeIndex: number;
}

let current: TabsPayload = { tabs: [], activeIndex: 0 };
let eventRevision = 0;

function invoke(command: string, args?: Record<string, unknown>): Promise<any> {
    return window.__TAURI__.core.invoke(command, args);
}

function fileName(path: string | null): string {
    if (!path) return 'Leerer Tab';
    return path.replace(/\\/g, '/').split('/').pop() || path;
}

function normalizePayload(payload: any): TabsPayload {
    const tabs = Array.isArray(payload && payload.tabs)
        ? payload.tabs.map(function (tab: any): TabSummary {
            return {
                id: Number(tab.id),
                path: typeof tab.path === 'string' ? tab.path : null,
                dirty: !!tab.dirty,
                active: !!tab.active,
            };
        }).filter(function (tab: TabSummary) {
            return Number.isFinite(tab.id);
        })
        : [];
    const activeIndex = typeof (payload && payload.activeIndex) === 'number'
        ? payload.activeIndex
        : Math.max(0, tabs.findIndex(function (tab) { return tab.active; }));
    return { tabs, activeIndex };
}

export function renderTabs(payload: TabsPayload): void {
    current = normalizePayload(payload);
    const bar = document.getElementById('tab-bar');
    if (!bar) return;

    const visible = current.tabs.length > 0
        && !(current.tabs.length === 1 && !current.tabs[0].path);
    bar.hidden = !visible;
    bar.replaceChildren();

    for (const tab of current.tabs) {
        if (!tab.path) continue;
        const item = document.createElement('div');
        item.className = 'tab-item' + (tab.active ? ' active' : '');
        item.dataset.tabId = String(tab.id);
        item.title = tab.path;
        item.setAttribute('role', 'tab');
        item.setAttribute('aria-selected', tab.active ? 'true' : 'false');
        item.tabIndex = tab.active ? 0 : -1;

        const label = document.createElement('span');
        label.className = 'tab-title';
        label.textContent = fileName(tab.path);
        item.appendChild(label);

        if (tab.dirty) {
            const dirty = document.createElement('span');
            dirty.className = 'tab-dirty';
            dirty.textContent = '•';
            dirty.setAttribute('aria-label', 'Ungespeicherte Änderungen');
            item.appendChild(dirty);
        }

        const close = document.createElement('button');
        close.className = 'tab-close';
        close.type = 'button';
        close.dataset.tabId = String(tab.id);
        close.title = 'Tab schließen';
        close.setAttribute('aria-label', fileName(tab.path) + ' schließen');
        close.textContent = '×';
        close.addEventListener('click', function (event) {
            event.stopPropagation();
            requestCloseTab(tab.id);
        });
        item.appendChild(close);

        item.addEventListener('click', function () {
            activateTab(tab.id);
        });
        item.addEventListener('auxclick', function (event) {
            if (event.button !== 1) return;
            event.preventDefault();
            requestCloseTab(tab.id);
        });
        bar.appendChild(item);
    }

    if (window.FolioEditor
        && typeof window.FolioEditor.syncTabModels === 'function') {
        window.FolioEditor.syncTabModels(
            current.tabs
                .filter(function (tab) { return !!tab.path; })
                .map(function (tab) { return tab.id; }),
        );
    }
}

export async function activateTab(id: number): Promise<boolean> {
    const tab = current.tabs.find(function (candidate) { return candidate.id === id; });
    if (!tab || tab.active) return !!tab;
    try {
        // Verhindert, dass ein unmittelbar vor dem Klick geschriebener Text
        // erst nach tab_activate im Backend eintrifft und dem Ziel-Tab
        // zugerechnet wird.
        if (getCurrentPath()) await syncEditorTextToStore();
        await invoke('tab_activate', { id });
        return true;
    } catch (error) {
        folioLog.warn('tabs', 'tab_activate failed', { id, error: String(error) });
        return false;
    }
}

export async function requestCloseTab(id: number): Promise<boolean> {
    let tab = current.tabs.find(function (candidate) { return candidate.id === id; });
    if (!tab) return false;

    try {
        // Ein inaktiver Dirty-Tab muss fuer den bestehenden Save/Discard/
        // Cancel-Fluss zuerst aktiv werden. Saubere inaktive Tabs koennen
        // ohne sichtbaren Fokuswechsel geschlossen werden.
        if (!tab.active && tab.dirty) {
            if (!await activateTab(id)) return false;
            tab = current.tabs.find(function (candidate) {
                return candidate.id === id;
            }) || { ...tab, active: true };
        }
        if (tab.active) {
            // `tab.dirty` kommt direkt vom Backend und deckt auch Faelle ab,
            // in denen document:loaded denselben Dirty-Text als cleanText
            // gesetzt hat (z. B. Rename eines ungespeicherten Dokuments).
            const proceed = await requestSaveIfDirty(tab.dirty);
            if (!proceed) return false;
        }
        await invoke('tab_close', { id });
        return true;
    } catch (error) {
        // tabs:changed kann einem sehr schnellen Close-Klick hinterherlaufen.
        // Falls das Backend bereits Dirty kennt, einmal ueber den kanonischen
        // Dialogpfad nachziehen.
        if (String(error).toLowerCase().includes('unsaved')) {
            if (!tab.active && !await activateTab(id)) return false;
            if (!await requestSaveIfDirty(true)) return false;
            try {
                await invoke('tab_close', { id });
                return true;
            } catch (retryError) {
                error = retryError;
            }
        }
        folioLog.warn('tabs', 'tab_close failed', { id, error: String(error) });
        return false;
    }
}

export function closeActiveTab(): Promise<boolean> {
    const active = current.tabs.find(function (tab) { return tab.active; })
        || current.tabs[current.activeIndex];
    return active ? requestCloseTab(active.id) : Promise.resolve(false);
}

/** Quit-Gate: fragt fuer JEDEN dirty Tab einzeln Save/Discard/Cancel ab
    (Tab wird dafuer aktiviert, damit der User sieht, worum es geht).
    Liefert false, sobald der User einmal abbricht. */
export async function confirmAllDirtyTabs(): Promise<boolean> {
    // Snapshot der IDs — current.tabs aendert sich durch Save/Aktivieren.
    const dirtyIds = current.tabs
        .filter(function (tab) { return tab.dirty; })
        .map(function (tab) { return tab.id; });
    for (const id of dirtyIds) {
        const tab = current.tabs.find(function (candidate) {
            return candidate.id === id;
        });
        if (!tab || !tab.dirty) continue;
        if (!tab.active && !await activateTab(id)) return false;
        if (!await requestSaveIfDirty(true)) return false;
    }
    return true;
}

export function activateRelativeTab(direction: 1 | -1): Promise<boolean> {
    const tabs = current.tabs.filter(function (tab) { return !!tab.path; });
    if (tabs.length < 2) return Promise.resolve(false);
    let index = tabs.findIndex(function (tab) { return tab.active; });
    if (index < 0) index = 0;
    const next = (index + direction + tabs.length) % tabs.length;
    return activateTab(tabs[next].id);
}

export function initTabs(): void {
    const runtime = window.__TAURI__;
    if (!runtime || !runtime.event || !runtime.core) return;

    runtime.event.listen('tabs:changed', function (event: any) {
        eventRevision++;
        renderTabs((event && event.payload) || {});
    });

    // Beim Boot kann das Backend-Event bereits vor der Listener-
    // Registrierung gelaufen sein. Die Revision verhindert, dass eine
    // spaete Listen-Antwort ein juengeres Event wieder ueberschreibt.
    const revisionAtRequest = eventRevision;
    invoke('tabs_list').then(function (payload) {
        if (eventRevision === revisionAtRequest) renderTabs(payload || {});
    }).catch(function (error) {
        folioLog.warn('tabs', 'tabs_list failed', { error: String(error) });
    });
}
