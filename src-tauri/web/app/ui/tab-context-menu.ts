/* Tab-Kontextmenü: Schließen / Alle anderen / Rechts / Wiederherstellen.
   Markup #tab-ctx-menu, CSS-Klassen ctx-item/ctx-sep wie vault/context-menu.
   Serien-Close über den exportierten requestCloseTab-Pfad (Dirty-Dialog). */

import { safeInvoke } from '../util/log';
import { t } from '../i18n/translate';
import {
    getTabsSnapshot,
    requestCloseTab,
    type TabSummary,
} from '../state/tabs';

export type TabMenuState = {
    closeOthersDisabled: boolean;
    closeRightDisabled: boolean;
    restoreDisabled: boolean;
    /** IDs der anderen Dokument-Tabs (Leisten-Reihenfolge). */
    closeOthersIds: number[];
    /** IDs rechts vom Ziel (Leisten-Reihenfolge). */
    closeRightIds: number[];
};

/** Reine Berechnung für Menü-Disabled und Serien-Ziele (testbar). */
export function computeMenuState(
    tabs: TabSummary[],
    targetId: number,
    recentlyClosedCount: number,
): TabMenuState {
    const docTabs = tabs.filter(function (tab) { return !!tab.path; });
    const idx = docTabs.findIndex(function (tab) { return tab.id === targetId; });
    return {
        closeOthersDisabled: docTabs.length <= 1,
        closeRightDisabled: idx < 0 || idx >= docTabs.length - 1,
        restoreDisabled: recentlyClosedCount <= 0,
        closeOthersIds: docTabs
            .filter(function (tab) { return tab.id !== targetId; })
            .map(function (tab) { return tab.id; }),
        closeRightIds: idx >= 0
            ? docTabs.slice(idx + 1).map(function (tab) { return tab.id; })
            : [],
    };
}

// Static SVG icons only — never t() content in innerHTML.
const ICONS: Record<string, string> = {
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    'close-others': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4h6M3 8h6M3 12h4"/><path d="M11 5l3 3-3 3"/></svg>',
    'close-right': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h5M2 8h5M2 12h3"/><path d="M10 4h4M10 8h4M10 12h4"/></svg>',
    restore: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 0 1.5-3.5"/><path d="M3 3v4h4"/></svg>',
};

function appendItem(
    parent: HTMLElement,
    act: string,
    label: string,
    disabled: boolean,
): void {
    const div = document.createElement('div');
    div.className = disabled ? 'ctx-item disabled' : 'ctx-item';
    div.setAttribute('data-act', act);
    if (disabled) div.setAttribute('aria-disabled', 'true');
    const icon = document.createElement('span');
    icon.className = 'ctx-icon';
    icon.innerHTML = ICONS[act] || '';
    const lab = document.createElement('span');
    lab.className = 'ctx-label';
    lab.textContent = label;
    div.appendChild(icon);
    div.appendChild(lab);
    parent.appendChild(div);
}

function appendSep(parent: HTMLElement): void {
    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    parent.appendChild(sep);
}

let ctxMenu: HTMLElement | null = null;
let ctxTargetId: number | null = null;

export function openTabContextMenu(x: number, y: number, tabId: number): void {
    if (!ctxMenu) return;
    const snap = getTabsSnapshot();
    const target = snap.tabs.find(function (tab) {
        return tab.id === tabId && !!tab.path;
    });
    if (!target) return;

    ctxTargetId = tabId;
    const state = computeMenuState(snap.tabs, tabId, snap.recentlyClosedCount);

    ctxMenu.replaceChildren();
    appendItem(ctxMenu, 'close', t('tabs.contextMenu.close'), false);
    appendItem(
        ctxMenu,
        'close-others',
        t('tabs.contextMenu.closeOthers'),
        state.closeOthersDisabled,
    );
    appendItem(
        ctxMenu,
        'close-right',
        t('tabs.contextMenu.closeRight'),
        state.closeRightDisabled,
    );
    appendSep(ctxMenu);
    appendItem(
        ctxMenu,
        'restore',
        t('tabs.contextMenu.restoreLast'),
        state.restoreDisabled,
    );

    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.classList.add('open');
    const margin = 4;
    const rect = ctxMenu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (x + rect.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (y + rect.height > window.innerHeight - margin) {
        top = Math.max(margin, y - rect.height);
    }
    ctxMenu.style.left = left + 'px';
    ctxMenu.style.top = top + 'px';
}

export function closeTabContextMenu(): void {
    if (ctxMenu) ctxMenu.classList.remove('open');
    ctxTargetId = null;
}

/** Seriell schließen; bricht bei false von requestCloseTab ab. */
export async function closeTabsSerial(ids: number[]): Promise<void> {
    for (const id of ids) {
        const ok = await requestCloseTab(id);
        if (!ok) return;
    }
}

function docTabFromEvent(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const item = target.closest('#tab-bar .tab-item[data-tab-id]') as HTMLElement | null;
    if (!item) return null;
    const n = Number(item.dataset.tabId);
    if (!Number.isFinite(n)) return null; // virtuelle Tabs (slug)
    return item;
}

export function initTabContextMenu(): void {
    ctxMenu = document.getElementById('tab-ctx-menu');
    if (!ctxMenu) return;

    const bar = document.getElementById('tab-bar');
    if (bar) {
        bar.addEventListener('contextmenu', function (e: MouseEvent) {
            const item = docTabFromEvent(e.target);
            if (!item) {
                // Virtuelle Tabs/Leerbereich: ein noch offenes Menü darf
                // nicht am falschen Ziel haengen bleiben (Review-Befund).
                closeTabContextMenu();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            const id = Number(item.dataset.tabId);
            openTabContextMenu(e.clientX, e.clientY, id);
        });
    }

    ctxMenu.addEventListener('click', function (e) {
        const item = (e.target as HTMLElement).closest('.ctx-item') as HTMLElement;
        if (!item || item.classList.contains('disabled') || ctxTargetId == null) return;
        const act = item.getAttribute('data-act');
        const targetId = ctxTargetId;
        closeTabContextMenu();

        if (act === 'close') {
            void requestCloseTab(targetId);
            return;
        }
        if (act === 'restore') {
            safeInvoke('tab_restore_last', {}, 'tab_restore_last', 'warn');
            return;
        }

        const snap = getTabsSnapshot();
        const state = computeMenuState(snap.tabs, targetId, snap.recentlyClosedCount);
        if (act === 'close-others') {
            void closeTabsSerial(state.closeOthersIds);
        } else if (act === 'close-right') {
            void closeTabsSerial(state.closeRightIds);
        }
    });

    document.addEventListener('click', function (e) {
        if (ctxMenu && !ctxMenu.contains(e.target as Node)) {
            closeTabContextMenu();
        }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeTabContextMenu();
    });
}
