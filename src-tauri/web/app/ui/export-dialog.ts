// @ts-nocheck
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

let deps: Deps = null;
let selectedLayoutId: string | null = null;
let selectedExportFormat: 'html' | 'pdf' = 'html';
let exportKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

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

function openExportDialog(): void {
    if (!document.body.classList.contains('kind-markdown')) return;
    setExportFormat('html');
    // Editor-Text in den Store syncen, damit die Vorschau den aktuellen Stand zeigt.
    const sync = (document.body.classList.contains('edit-mode') && deps.getCurrentPath())
        ? deps.syncEditorTextToStore() : Promise.resolve();
    sync.then(function () { return invoke('export_layouts'); }).then(function (layouts: any[]) {
        const cards = $('export-cards');
        cards.innerHTML = '';
        (layouts || []).forEach(function (layout) {
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
            cards.appendChild(card);
            invoke('export_render', { layoutId: layout.id }).then(function (html) {
                const iframe = card.querySelector('iframe');
                if (iframe && typeof html === 'string') (iframe as HTMLIFrameElement).srcdoc = html;
            }).catch(function () { /* ignore */ });
        });
        selectLayoutCard((layouts && layouts[0] && layouts[0].id) || null);
        $('export-dialog').hidden = false;
        exportKeydownHandler = function (e: KeyboardEvent) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeExportDialog();
            } else if (e.key === 'Enter' && selectedLayoutId) {
                if (e.target && (e.target as HTMLElement).id === 'export-cancel') return;
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
    const cards = $('export-cards');
    if (cards) cards.innerHTML = '';
}

function doExportSave(): void {
    if (!selectedLayoutId) return;
    const fmt = selectedExportFormat;
    const defaultName = fileBaseName(deps.getCurrentPath()) + '.' + fmt;
    const cmd = (fmt === 'pdf') ? 'export_pdf' : 'export_html';
    invoke('pick_export_target', { defaultName, format: fmt })
        .then(function (targetPath) {
            if (!targetPath) return;
            deps.showStatus('Export läuft…');
            return invoke(cmd, { layoutId: selectedLayoutId, targetPath })
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

    const tbExport = $('tb-export');
    if (tbExport) tbExport.addEventListener('click', openExportDialog);
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
