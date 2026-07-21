/* Kuratierte Befehls-Registry für die Command Palette (`>`-Modus).
   Ausführung ausschließlich über `menu_dispatch` (gleicher Pfad wie Menü/
   Automation). Ausnahme: Tab-Wiederherstellen hat kein Menü-Item und läuft
   über `tab_restore_last`. Disabled-Einträge werden ausgeblendet.

   Labels via label() mit t('…')-Literalen (i18n_reference_gate). */

import { t } from '../i18n/translate';
import { getTabsSnapshot } from '../state/tabs';

export type PaletteCommand = {
    id: string;
    /** Label zur Render-Zeit (t()-Literale, kein dynamischer Key). */
    label: () => string;
    /**
     * Menü-ID für `menu_dispatch`. `null` = Spezial-Pfad (siehe
     * `specialInvoke`).
     */
    menuAction: string | null;
    /** Optionaler Tauri-Command, wenn `menuAction` null ist. */
    specialInvoke?: string;
    /** Anzeige-Shortcut rechts (optional). */
    shortcut?: string;
    enabled: () => boolean;
};

function bodyHas(...classes: string[]): boolean {
    return classes.some((c) => document.body.classList.contains(c));
}

/** Geladenes Dokument (View-fähig) — analog applyDocKind. */
function hasDoc(): boolean {
    return bodyHas('kind-markdown', 'kind-text', 'kind-image');
}

/** View-Mode: Markdown, Text, Image. */
function hasViewMode(): boolean {
    return bodyHas('kind-markdown', 'kind-text', 'kind-image');
}

/** Edit/Split: Markdown + Text (nicht Image). */
function canEdit(): boolean {
    return bodyHas('kind-markdown', 'kind-text');
}

function isMarkdown(): boolean {
    return bodyHas('kind-markdown');
}

function hasRecentlyClosed(): boolean {
    return getTabsSnapshot().recentlyClosedCount > 0;
}

/**
 * Feste Startliste nach Spec. `enabled()` spiegelt die Body-Klassen-
 * Gates analog zu `applyDocKind` / Menü-Enable.
 */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
    {
        id: 'file.open',
        label: () => t('menu.file.open'),
        menuAction: 'file.open',
        shortcut: 'Ctrl+O',
        enabled: () => true,
    },
    {
        id: 'file.save',
        label: () => t('menu.file.save'),
        menuAction: 'file.save',
        shortcut: 'Ctrl+S',
        enabled: () => hasDoc(),
    },
    {
        id: 'file.save_as',
        label: () => t('menu.file.saveAs'),
        menuAction: 'file.save_as',
        shortcut: 'Ctrl+Shift+S',
        enabled: () => canEdit(),
    },
    {
        id: 'file.close',
        label: () => t('menu.file.closeTab'),
        menuAction: 'file.close',
        shortcut: 'Ctrl+W',
        enabled: () => hasDoc(),
    },
    {
        id: 'tab.restore',
        label: () => t('tabs.contextMenu.restoreLast'),
        menuAction: null,
        specialInvoke: 'tab_restore_last',
        enabled: () => hasRecentlyClosed(),
    },
    {
        id: 'file.export',
        label: () => t('menu.file.export'),
        menuAction: 'file.export',
        enabled: () => isMarkdown(),
    },
    {
        id: 'view.mode.view',
        label: () => t('menu.view.modeView'),
        menuAction: 'view.mode.view',
        shortcut: 'Ctrl+1',
        enabled: () => hasViewMode(),
    },
    {
        id: 'view.mode.edit',
        label: () => t('menu.view.modeEdit'),
        menuAction: 'view.mode.edit',
        shortcut: 'Ctrl+2',
        enabled: () => canEdit(),
    },
    {
        id: 'view.mode.split',
        label: () => t('menu.view.modeSplit'),
        menuAction: 'view.mode.split',
        shortcut: 'Ctrl+3',
        enabled: () => canEdit(),
    },
    {
        id: 'edit.find',
        label: () => t('menu.edit.find'),
        menuAction: 'edit.find',
        shortcut: 'Ctrl+F',
        enabled: () => hasDoc(),
    },
    {
        id: 'edit.search_vault',
        label: () => t('menu.edit.searchVault'),
        menuAction: 'edit.search_vault',
        shortcut: 'Ctrl+Shift+F',
        enabled: () => true,
    },
    {
        id: 'edit.settings',
        label: () => t('menu.edit.settings'),
        menuAction: 'edit.settings',
        shortcut: 'Ctrl+,',
        enabled: () => true,
    },
    {
        id: 'view.theme.light',
        label: () => t('menu.view.themeLight'),
        menuAction: 'view.theme.light',
        enabled: () => true,
    },
    {
        id: 'view.theme.dark',
        label: () => t('menu.view.themeDark'),
        menuAction: 'view.theme.dark',
        enabled: () => true,
    },
];

/** Enabled-Befehle in Registry-Reihenfolge (kein Score ohne Query). */
export function listEnabledCommands(): PaletteCommand[] {
    return PALETTE_COMMANDS.filter((cmd) => {
        try {
            return cmd.enabled();
        } catch {
            return false;
        }
    });
}
