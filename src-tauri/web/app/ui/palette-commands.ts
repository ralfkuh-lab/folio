/* Kuratierte Befehls-Registry für die Command Palette (`>`-Modus).
   Ausführung über `menu_dispatch` (gleicher Pfad wie Menü/Automation)
   bzw. `run()` für Frontend-Aktionen ohne Menü-ID (Restore).
   Disabled-Einträge werden ausgeblendet.

   Labels via label() mit t('…')-Literalen (i18n_reference_gate). */

import { t } from '../i18n/translate';
import { getCurrentPath, getIsDirty } from '../state/document';
import { getTabsSnapshot, restoreLastTab } from '../state/tabs';
import { isPathGitModified } from '../vault/git-status';

export type PaletteCommand = {
    id: string;
    /** Label zur Render-Zeit (t()-Literale, kein dynamischer Key). */
    label: () => string;
    /**
     * Menü-ID für `menu_dispatch`. `null` = Frontend-`run()`-Pfad.
     */
    menuAction: string | null;
    /** Frontend-Aktion ohne Menü-ID (z. B. Tab-Restore). */
    run?: () => void;
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
 * Feste Startliste nach Spec. `enabled()` spiegelt Menü-/Body-Gates
 * (Save nur dirty). Theme-System: V1 nur hell/dunkel (kein Backend-Support).
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
        // Kanonischer Menü-State: Save nur bei dirty (document.ts)
        enabled: () => hasDoc() && getIsDirty(),
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
        run: () => restoreLastTab(),
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
        id: 'view.git_diff',
        label: () => t('menu.view.gitDiff'),
        menuAction: 'view.git_diff',
        enabled: () => {
            const path = getCurrentPath();
            return !!path && isPathGitModified(path);
        },
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
