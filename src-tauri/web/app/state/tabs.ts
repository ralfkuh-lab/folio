/* Tab-Leiste: Backend `tabs:changed` ist die Source of Truth. Das Modul
   rendert nur, routet Aktivieren/Schliessen und synchronisiert den
   Monaco-Model-Lifecycle mit den noch dokumenttragenden Tabs. */

import {
    getCurrentPath,
    requestSaveIfDirty,
    syncEditorTextToStore,
} from './document';
import { ackHandler } from '../automation/events';
import { folioLog, safeInvoke } from '../util/log';

export interface TabSummary {
    id: number;
    path: string | null;
    dirty: boolean;
    active: boolean;
}

export interface TabsPayload {
    tabs: TabSummary[];
    activeIndex: number;
    requestId?: number;
}

let current: TabsPayload = { tabs: [], activeIndex: 0 };
let eventRevision = 0;

export function getActiveTabId(): number | null {
    const active = current.tabs.find(function (tab) { return tab.active; })
        || current.tabs[current.activeIndex];
    return active ? active.id : null;
}

export interface VirtualTab {
    slug: string;
    label: () => string;
    dirty?: () => boolean;
    onActivate: () => void;
    onClose: () => void | boolean | Promise<void | boolean>;
}

const virtualTabs = new Map<string, VirtualTab>();
let activeVirtualSlug: string | null = null;
let settingsTabHooks: { onActivate: () => void; onClose: () => void } | null = null;

function syncVirtualRegionClasses(): void {
    document.body.classList.toggle('settings-open', activeVirtualSlug === 'settings');
    document.body.classList.toggle('theme-editor-open', activeVirtualSlug === 'theme-editor');
}

export function registerVirtualTab(tab: VirtualTab, activate = true): void {
    virtualTabs.set(tab.slug, tab);
    if (activate) activeVirtualSlug = tab.slug;
    syncVirtualRegionClasses();
    renderTabs(current);
    if (activate) tab.onActivate();
}

export function unregisterVirtualTab(slug: string): void {
    if (!virtualTabs.delete(slug)) return;
    if (activeVirtualSlug === slug) activeVirtualSlug = null;
    syncVirtualRegionClasses();
    renderTabs(current);
}

export function activateVirtualTab(slug: string): boolean {
    const tab = virtualTabs.get(slug);
    if (!tab) return false;
    activeVirtualSlug = slug;
    syncVirtualRegionClasses();
    renderTabs(current);
    tab.onActivate();
    return true;
}

export function refreshVirtualTabs(): void {
    renderTabs(current);
}

export function isVirtualTabActive(slug: string): boolean {
    return activeVirtualSlug === slug;
}

async function requestCloseVirtualTab(slug: string): Promise<boolean> {
    const tab = virtualTabs.get(slug);
    if (!tab) return true;
    const result = await tab.onClose();
    if (result === false) return false;
    // Hooks entfernen ihren Tab regulaer selbst. Defensive Bereinigung,
    // falls ein einfacher Callback nur seine Region geschlossen hat.
    if (virtualTabs.has(slug)) unregisterVirtualTab(slug);
    return true;
}

export function configureSettingsTab(hooks: { onActivate: () => void; onClose: () => void }): void {
    settingsTabHooks = hooks;
    if (virtualTabs.has('settings')) {
        registerVirtualTab({
            slug: 'settings',
            label: () => '\u2699 Einstellungen',
            onActivate: hooks.onActivate,
            onClose: hooks.onClose,
        }, activeVirtualSlug === 'settings');
    }
}

/** Von settings-dialog.ts bei open/close gerufen; rendert die Leiste neu. */
export function setSettingsTabOpen(open: boolean): void {
    if (!open) {
        unregisterVirtualTab('settings');
        return;
    }
    if (!settingsTabHooks) return;
    registerVirtualTab({
        slug: 'settings',
        label: () => '\u2699 Einstellungen',
        onActivate: settingsTabHooks.onActivate,
        onClose: settingsTabHooks.onClose,
    });
}

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

    const visible = virtualTabs.size > 0
        || (current.tabs.length > 0
            && !(current.tabs.length === 1 && !current.tabs[0].path));
    bar.hidden = !visible;
    // Horizontale Scroll-Position der Leiste ueber den Re-Render erhalten
    // (tabs:changed nach Reorder/Aktivierung wuerde sonst nach links
    // springen, wenn viele Tabs offen sind).
    const prevScrollLeft = bar.scrollLeft;
    bar.replaceChildren();

    for (const tab of current.tabs) {
        if (!tab.path) continue;
        const item = document.createElement('div');
        item.className = 'tab-item' + (tab.active && !activeVirtualSlug ? ' active' : '');
        item.dataset.tabId = String(tab.id);
        item.title = tab.path;
        item.setAttribute('role', 'tab');
        const selected = tab.active && !activeVirtualSlug;
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        item.tabIndex = selected ? 0 : -1;

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
            // Fast-Path bewusst synchron: ohne aktive virtuelle Region
            // verhaelt sich der Klick exakt wie vor der Registry
            // (E2E 30_tabs_ui zeigte einmalig eine Timing-Race, wenn der
            // Wechsel hinter einer Promise-Kette haengt).
            if (!activeVirtualSlug) {
                activateTab(tab.id);
                return;
            }
            requestCloseVirtualTab(activeVirtualSlug).then(function (closed) {
                if (closed) activateTab(tab.id);
            });
        });
        item.addEventListener('auxclick', function (event) {
            if (event.button !== 1) return;
            event.preventDefault();
            requestCloseTab(tab.id);
        });
        bar.appendChild(item);
    }

    for (const virtual of virtualTabs.values()) {
        const selected = activeVirtualSlug === virtual.slug;
        const item = document.createElement('div');
        item.className = 'tab-item tab-' + virtual.slug + (selected ? ' active' : '');
        item.dataset.tabId = virtual.slug;
        item.title = virtual.label();
        item.setAttribute('role', 'tab');
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        item.tabIndex = selected ? 0 : -1;

        const label = document.createElement('span');
        label.className = 'tab-title';
        label.textContent = virtual.label();
        item.appendChild(label);

        if (virtual.dirty?.()) {
            const dirty = document.createElement('span');
            dirty.className = 'tab-dirty';
            dirty.textContent = '•';
            dirty.setAttribute('aria-label', 'Ungespeicherte Änderungen');
            item.appendChild(dirty);
        }

        const close = document.createElement('button');
        close.className = 'tab-close';
        close.type = 'button';
        close.title = virtual.label() + ' schließen';
        close.setAttribute('aria-label', virtual.label() + ' schließen');
        close.textContent = '×';
        close.addEventListener('click', async function (event) {
            event.stopPropagation();
            await requestCloseVirtualTab(virtual.slug);
        });
        item.appendChild(close);

        item.addEventListener('click', function () {
            activateVirtualTab(virtual.slug);
        });
        item.addEventListener('auxclick', async function (event) {
            if (event.button !== 1) return;
            event.preventDefault();
            await requestCloseVirtualTab(virtual.slug);
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

    if (prevScrollLeft > 0) {
        bar.scrollLeft = prevScrollLeft;
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

// ----- Tab Drag Reorder (Pointer-basiert, exakt wie vault/tree.ts) -----
// Nur Dokument-Tabs (data-tab-id numerisch). Virtuelle Tabs weder Quelle
// noch Ziel. 8px Threshold (quadratisch), kein setPointerCapture.
// Folge-Klick wird NUR bei echtem Reorder (Drop-Ziel vorhanden) geschluckt.
const DRAG_THRESHOLD_PX = 8;

let tabDrag: {
    item: HTMLElement;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
} | null = null;
let suppressNextClick = false;

function getDocTabItem(target: HTMLElement | null): HTMLElement | null {
    let el: HTMLElement | null = target;
    while (el && el.id !== 'tab-bar') {
        if (el.classList && el.classList.contains('tab-item')) {
            const idstr = el.dataset.tabId;
            const n = idstr ? Number(idstr) : NaN;
            if (Number.isFinite(n)) {
                // numeric id => document tab (virtuals use slugs like "settings")
                return el;
            }
            return null;
        }
        el = el.parentElement;
    }
    return null;
}

function clearTabDropMarkers(): void {
    const marks = document.querySelectorAll('#tab-bar .drop-over-before, #tab-bar .drop-over-after');
    marks.forEach(function (el) { el.classList.remove('drop-over-before', 'drop-over-after'); });
}

function endTabDrag(): void {
    if (tabDrag) {
        tabDrag.item.classList.remove('dragging');
        tabDrag = null;
    }
    document.body.classList.remove('tab-dragging');
    clearTabDropMarkers();
}

function commitTabReorder(draggedEl: HTMLElement, targetItem: HTMLElement, isBefore: boolean): void {
    const bar = document.getElementById('tab-bar');
    if (!bar || draggedEl.parentElement !== bar || draggedEl === targetItem) return;
    if (isBefore) {
        bar.insertBefore(draggedEl, targetItem);
    } else {
        bar.insertBefore(draggedEl, targetItem.nextSibling);
    }
    // collect new order from the (optimistically reordered) DOM doc tabs
    const newIds: number[] = [];
    const items = bar.querySelectorAll('.tab-item');
    for (let i = 0; i < items.length; i++) {
        const tid = (items[i] as HTMLElement).dataset.tabId;
        const n = tid ? Number(tid) : NaN;
        if (Number.isFinite(n)) newIds.push(n);
    }
    if (newIds.length > 0) {
        safeInvoke('tab_reorder', { ids: newIds }, 'tab_reorder');
    }
}

function setupTabDragListeners(): void {
    const bar = document.getElementById('tab-bar');
    if (!bar) return;

    bar.addEventListener('pointerdown', function (e: PointerEvent) {
        if (e.button !== 0) return;
        suppressNextClick = false;
        const item = getDocTabItem(e.target as HTMLElement);
        if (!item) return;
        // do not arm drag if pointerdown started on the close button
        const close = (e.target as HTMLElement).closest('.tab-close');
        if (close) return;
        tabDrag = {
            item: item,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            active: false,
        };
    });

    document.addEventListener('pointermove', function (e: PointerEvent) {
        if (!tabDrag || e.pointerId !== tabDrag.pointerId) return;

        if (!tabDrag.active) {
            const dx = e.clientX - tabDrag.startX;
            const dy = e.clientY - tabDrag.startY;
            if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
            tabDrag.active = true;
            tabDrag.item.classList.add('dragging');
            document.body.classList.add('tab-dragging');
        }
        e.preventDefault(); // prevent text selection during drag

        let targetItem = getDocTabItem(e.target as HTMLElement);
        let forceAfter = false;
        if (!targetItem) {
            // Drop im leeren Bereich der Tab-Leiste HINTER dem letzten
            // Dokument-Tab: als "nach dem letzten Tab" behandeln (Spec).
            const bar = document.getElementById('tab-bar');
            if (bar && bar.contains(e.target as Node)) {
                const docTabs = bar.querySelectorAll<HTMLElement>('.tab-item[data-tab-id]');
                const last = docTabs.length ? docTabs[docTabs.length - 1] : null;
                if (last && e.clientX > last.getBoundingClientRect().right) {
                    targetItem = last;
                    forceAfter = true;
                }
            }
        }
        clearTabDropMarkers();
        if (!targetItem || targetItem === tabDrag.item) return;
        if (forceAfter) {
            targetItem.classList.add('drop-over-after');
            return;
        }
        const rect = targetItem.getBoundingClientRect();
        const isBefore = (e.clientX - rect.left) < (rect.width / 2);
        targetItem.classList.add(isBefore ? 'drop-over-before' : 'drop-over-after');
    });

    document.addEventListener('pointerup', function (e: PointerEvent) {
        if (!tabDrag || e.pointerId !== tabDrag.pointerId) return;
        const draggedEl = tabDrag.item;
        const wasActive = tabDrag.active;
        const beforeTarget = document.querySelector('#tab-bar .drop-over-before') as HTMLElement | null;
        const afterTarget = document.querySelector('#tab-bar .drop-over-after') as HTMLElement | null;
        endTabDrag();
        if (!wasActive) return;
        const targetItem = beforeTarget || afterTarget;
        // swallow follow-up click ONLY if we had a real drop target (real reorder)
        if (!targetItem) return;
        suppressNextClick = true;
        window.setTimeout(function () { suppressNextClick = false; }, 0);
        commitTabReorder(draggedEl, targetItem, !!beforeTarget);
    });

    document.addEventListener('pointercancel', function (e: PointerEvent) {
        if (!tabDrag || e.pointerId !== tabDrag.pointerId) return;
        endTabDrag();
    });

    // Capture-phase swallow on the bar itself (analog to REGION in tree.ts).
    // Ensures the synthetic click following a real reorder is eaten.
    bar.addEventListener('click', function (e: MouseEvent) {
        if (suppressNextClick) {
            suppressNextClick = false;
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true);
}

export function initTabs(): void {
    const runtime = window.__TAURI__;
    if (runtime && runtime.event && runtime.core) {
        const invokeFn = runtime.core.invoke;
        runtime.event.listen('tabs:changed', function (event: any) {
            eventRevision++;
            const payload = (event && event.payload) || {};
            ackHandler(invokeFn, payload, function () {
                renderTabs(payload);
            });
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

    // Drag listeners are pure DOM (work in tests too); attach always if bar exists.
    setupTabDragListeners();
}
