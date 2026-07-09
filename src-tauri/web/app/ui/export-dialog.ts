import {
    EXPORT_AI_DRAFT_ID,
    clearExportAiDraft,
    exportAiDraftSave,
    initExportAi,
    prepareExportAiOpen,
    setExportMermaidSvgs,
} from './export-ai';
import { renderMermaidForExport, type MermaidSvgEntry } from '../view/mermaid';

/* Export-Dialog: HTML/PDF-Format-Wahl + Layout-Karten mit Iframe-Preview.
   Aufruf via Toolbar (tb-export). Abhaengig vom Document-State
   (currentPath, syncEditorTextToStore) und Statusbar (showStatus), die
   per Dependency-Injection uebergeben werden — wandern in 4.5 nach
   state/document.ts und statusbar-related Modul. */

type Deps = {
    getCurrentPath: () => string | null;
    syncEditorTextToStore: () => Promise<unknown>;
    showStatus: (msg: string) => void;
};

type ExportLayout = {
    id: string;
    name: string;
    description?: string;
};

type LayoutGroups = {
    favorites: ExportLayout[];
    rest: ExportLayout[];
};

let deps: Deps = null;
let selectedLayoutId: string | null = null;
let selectedExportFormat: 'html' | 'pdf' = 'html';
let exportKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let currentMermaidSvgs: MermaidSvgEntry[] | null = null;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function invoke(cmd: string, args?: any): Promise<any> {
    return window.__TAURI__.core.invoke(cmd, args);
}

function fileBaseName(p: string | null): string {
    if (!p) return 'Dokument';
    const s = p.replace(/\\/g, '/').split('/').pop() || p;
    return s.replace(/\.(md|markdown|mdown|mkd)$/i, '') || 'Dokument';
}

function setExportFormat(fmt: string): void {
    selectedExportFormat = (fmt === 'pdf') ? 'pdf' : 'html';
    const buttons = document.querySelectorAll('#export-formats button');
    for (let i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle('active',
            buttons[i].getAttribute('data-format') === selectedExportFormat);
    }
}

function selectLayoutCard(id: string | null): void {
    selectedLayoutId = id;
    const cards = document.querySelectorAll('#export-cards .export-card');
    for (let i = 0; i < cards.length; i++) {
        (cards[i] as HTMLElement).classList.toggle('selected', (cards[i] as HTMLElement).dataset.layoutId === id);
    }
    const saveBtn = $('export-save') as HTMLButtonElement;
    if (saveBtn) saveBtn.disabled = !id;
}

export function splitLayoutsByFavorites(
    layouts: ExportLayout[],
    favoriteIds: string[],
): LayoutGroups {
    const layoutsById = new Map(layouts.map(function (layout) {
        return [layout.id, layout];
    }));
    const seen = new Set<string>();
    const favorites: ExportLayout[] = [];
    favoriteIds.forEach(function (id) {
        const layout = layoutsById.get(id);
        if (layout && !seen.has(id)) {
            favorites.push(layout);
            seen.add(id);
        }
    });
    return {
        favorites,
        rest: layouts.filter(function (layout) { return !seen.has(layout.id); }),
    };
}

function loadLayoutPreview(card: HTMLElement, layoutId: string): void {
    if (card.dataset.previewLoaded === 'true') return;
    card.dataset.previewLoaded = 'true';
    const payload: any = { layoutId };
    if (currentMermaidSvgs) payload.mermaidSvgs = currentMermaidSvgs;
    invoke('export_render', payload).then(function (html) {
        const iframe = card.querySelector('iframe');
        if (iframe && typeof html === 'string') (iframe as HTMLIFrameElement).srcdoc = html;
    }).catch(function () { /* ignore */ });
}

function createLayoutCard(layout: ExportLayout, loadPreview: boolean): HTMLElement {
    const card = document.createElement('div');
    card.className = 'export-card';
    card.dataset.layoutId = layout.id;
    card.tabIndex = 0;
    card.innerHTML =
        '<div class="export-card__name"></div>' +
        '<div class="export-card__desc"></div>' +
        '<div class="export-card__preview"><iframe sandbox></iframe></div>';
    card.querySelector('.export-card__name').textContent = layout.name;
    card.querySelector('.export-card__desc').textContent = layout.description || '';
    card.addEventListener('click', function () { selectLayoutCard(layout.id); });
    card.addEventListener('keydown', function (e: KeyboardEvent) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectLayoutCard(layout.id);
        }
    });
    if (loadPreview) loadLayoutPreview(card, layout.id);
    return card;
}

function renderLayoutCards(
    cards: HTMLElement,
    layouts: ExportLayout[],
    favoriteIds: string[],
): string | null {
    cards.innerHTML = '';
    const groups = splitLayoutsByFavorites(layouts, favoriteIds);
    if (groups.favorites.length === 0) {
        groups.rest.forEach(function (layout) {
            cards.appendChild(createLayoutCard(layout, true));
        });
        return groups.rest.length > 0 ? groups.rest[0].id : null;
    }

    groups.favorites.forEach(function (layout) {
        cards.appendChild(createLayoutCard(layout, true));
    });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'export-more-toggle';
    toggle.className = 'export-more-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'export-more-cards');
    toggle.textContent = 'Weitere Layouts (' + groups.rest.length + ')';

    const moreCards = document.createElement('div');
    moreCards.id = 'export-more-cards';
    moreCards.className = 'export-more-cards';
    moreCards.hidden = true;
    groups.rest.forEach(function (layout) {
        moreCards.appendChild(createLayoutCard(layout, false));
    });
    toggle.addEventListener('click', function () {
        const expanding = moreCards.hidden;
        moreCards.hidden = !expanding;
        toggle.setAttribute('aria-expanded', expanding ? 'true' : 'false');
        if (expanding) {
            moreCards.querySelectorAll<HTMLElement>('.export-card').forEach(function (card) {
                if (card.dataset.layoutId) {
                    loadLayoutPreview(card, card.dataset.layoutId);
                }
            });
        }
    });
    cards.append(toggle, moreCards);
    return groups.favorites[0].id;
}

function openExportDialog(): void {
    if (!document.body.classList.contains('kind-markdown')) return;
    setExportFormat('html');
    // Editor-Text in den Store syncen, damit die Vorschau den aktuellen Stand zeigt.
    const sync = (document.body.classList.contains('edit-mode') && deps.getCurrentPath())
        ? deps.syncEditorTextToStore() : Promise.resolve();
    sync.then(function () {
        return Promise.all([invoke('export_layouts'), invoke('settings_get'), invoke('export_mermaid_sources')]);
    }).then(async function (result: [ExportLayout[], { themeFavorites?: string[] }, unknown]) {
        const layouts = Array.isArray(result[0]) ? result[0] : [];
        const settings = result[1];
        const favoriteIds = settings && Array.isArray(settings.themeFavorites)
            ? settings.themeFavorites : [];
        const sources = Array.isArray(result[2]) ? (result[2] as string[]) : [];
        currentMermaidSvgs = null;
        if (sources.length > 0) {
            try {
                currentMermaidSvgs = await renderMermaidForExport(sources);
            } catch (e) {
                currentMermaidSvgs = sources.map((source) => ({ source, svg: null }));
            }
        }
        setExportMermaidSvgs(currentMermaidSvgs);
        const cards = $('export-cards');
        const initiallySelected = renderLayoutCards(cards, layouts, favoriteIds);
        selectLayoutCard(initiallySelected);
        prepareExportAiOpen(layouts);
        $('export-dialog').hidden = false;
        // Defensive: bei Re-Open ohne Close (z. B. Doppelklick auf
        // tb-export) den alten Handler abraeumen, sonst leakt er —
        // closeExportDialog entfernt nur den zuletzt registrierten.
        if (exportKeydownHandler) {
            document.removeEventListener('keydown', exportKeydownHandler);
        }
        exportKeydownHandler = function (e: KeyboardEvent) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeExportDialog();
            } else if (e.key === 'Enter' && selectedLayoutId) {
                if (e.target) {
                    const targetId = (e.target as HTMLElement).id;
                    if (targetId === 'export-cancel' || targetId === 'export-more-toggle') return;
                }
                e.preventDefault();
                doExportSave();
            }
        };
        document.addEventListener('keydown', exportKeydownHandler);
    }).catch(function (err) {
        deps.showStatus(typeof err === 'string' ? err : 'Export fehlgeschlagen');
    });
}

function closeExportDialog(): void {
    $('export-dialog').hidden = true;
    if (exportKeydownHandler) {
        document.removeEventListener('keydown', exportKeydownHandler);
        exportKeydownHandler = null;
    }
    // Sonst wuerde ein verbliebener Keydown-Handler (oder der naechste
    // Enter-Druck nach Re-Open-Fehler) mit dem alten Layout exportieren.
    selectedLayoutId = null;
    currentMermaidSvgs = null;
    setExportMermaidSvgs(null);
    clearExportAiDraft();
    const cards = $('export-cards');
    if (cards) cards.innerHTML = '';
}

function doExportSave(): void {
    if (!selectedLayoutId) return;
    const fmt = selectedExportFormat;
    const defaultName = fileBaseName(deps.getCurrentPath()) + '.' + fmt;
    invoke('pick_export_target', { defaultName, format: fmt })
        .then(function (targetPath) {
            if (!targetPath) return;
            deps.showStatus('Export läuft…');
            if (selectedLayoutId === EXPORT_AI_DRAFT_ID) {
                return exportAiDraftSave(fmt, targetPath).then(function (handled) {
                    if (!handled) return;
                    closeExportDialog();
                    deps.showStatus('Exportiert: ' + targetPath);
                });
            }
            const cmd = (fmt === 'pdf') ? 'export_pdf' : 'export_html';
            const payload: any = { layoutId: selectedLayoutId, targetPath };
            if (currentMermaidSvgs) payload.mermaidSvgs = currentMermaidSvgs;
            return invoke(cmd, payload)
                .then(function () {
                    closeExportDialog();
                    deps.showStatus('Exportiert: ' + targetPath);
                });
        }).catch(function (err) {
            deps.showStatus(typeof err === 'string' ? err : 'Export fehlgeschlagen');
        });
}

export function initExportDialog(d: Deps): void {
    deps = d;
    initExportAi({
        invoke,
        showStatus: function (message) { deps.showStatus(message); },
        selectDraftCard: function () { selectLayoutCard(EXPORT_AI_DRAFT_ID); },
        isDraftSelected: function () { return selectedLayoutId === EXPORT_AI_DRAFT_ID; },
    });

    const tbExport = $('tb-export');
    if (tbExport) tbExport.addEventListener('click', openExportDialog);
    const events = window.__TAURI__ && window.__TAURI__.event;
    if (events && typeof events.listen === 'function') {
        events.listen('menu:file_export', openExportDialog);
    }
    const cancel = $('export-cancel');
    if (cancel) cancel.addEventListener('click', closeExportDialog);
    const save = $('export-save');
    if (save) save.addEventListener('click', doExportSave);

    const exportFormats = $('export-formats');
    if (exportFormats) {
        exportFormats.addEventListener('click', function (e) {
            const btn = (e.target as HTMLElement).closest('button[data-format]') as HTMLButtonElement;
            if (!btn || btn.disabled) return;
            setExportFormat(btn.getAttribute('data-format'));
        });
    }
}
