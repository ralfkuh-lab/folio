/* Vault-Kontextmenue + Inline-Rename. Das #context-menu-Element wird per
   openContextMenu() positioniert und mit Items befuellt; item-Click
   dispatcht die jeweilige Aktion (open / pin / unpin / remove-recent /
   rename / show / terminal / copy). startInlineRename ersetzt das
   .label-span des Tree-Eintrags temporaer durch ein <input>. */

type Deps = {
    openDocument: (path: string) => void;
    refreshVault: () => void;
    showStatus: (msg: string) => void;
};

let deps: Deps = null;
let ctxMenu: HTMLElement | null = null;
let ctxTarget: { path: string; isDirectory: boolean } | null = null;

function invoke(cmd: string, args?: any): Promise<any> {
    return window.__TAURI__.core.invoke(cmd, args);
}

export function openContextMenu(
    x: number,
    y: number,
    path: string,
    isDir: boolean,
    inPinned: boolean,
    inRecent: boolean,
): void {
    if (!ctxMenu) return;
    ctxTarget = { path, isDirectory: isDir };
    const parts: string[] = [];
    if (!isDir) parts.push('<div class="ctx-item" data-act="open">Öffnen</div>');
    const actionsBefore = parts.length;
    const actions: string[] = [];
    if (!isDir) actions.push('<div class="ctx-item" data-act="rename">Umbenennen</div>');
    if (!inPinned) actions.push('<div class="ctx-item" data-act="pin">Anpinnen</div>');
    if (inPinned) actions.push('<div class="ctx-item" data-act="unpin">Vom Pin lösen</div>');
    if (inRecent) actions.push('<div class="ctx-item" data-act="remove-recent">Aus „Zuletzt" entfernen</div>');
    if (actions.length && actionsBefore) parts.push('<div class="ctx-sep"></div>');
    parts.push(...actions);
    const tail = [
        '<div class="ctx-item" data-act="show">Im Explorer zeigen</div>',
        '<div class="ctx-item" data-act="terminal">Terminal hier öffnen</div>',
        '<div class="ctx-item" data-act="copy">Pfad kopieren</div>',
    ];
    if (parts.length) parts.push('<div class="ctx-sep"></div>');
    parts.push(...tail);
    ctxMenu.innerHTML = parts.join('');
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.classList.add('open');
}

export function closeContextMenu(): void {
    if (ctxMenu) ctxMenu.classList.remove('open');
    ctxTarget = null;
}

/* Inline-Rename im Vault-Baum (Explorer-Feeling): ersetzt das .label-Span
   temporär durch ein <input>, vorselektiert den Stamm ohne Endung. Enter/
   Blur committen, Escape bricht ab. Nach erfolgreichem rename_file
   emittiert das Backend vault:refresh, das den Baum neu baut — das Input
   verschwindet damit automatisch. */
export function startInlineRename(path: string): void {
    if (!path) return;
    const nodes = document.querySelectorAll('#vault-tree li.node[data-path]');
    let nodeEl: HTMLElement | null = null;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i] as HTMLElement;
        if (n.getAttribute('data-path') === path && n.getAttribute('data-kind') !== 'dir') {
            nodeEl = n;
            break;
        }
    }
    if (!nodeEl) return;
    const labelEl = nodeEl.querySelector(':scope > .row > .label') as HTMLElement;
    if (!labelEl || labelEl.dataset.editing === '1') return;
    const originalText = labelEl.textContent || '';
    const basename = originalText;
    labelEl.dataset.editing = '1';
    labelEl.classList.add('editing');
    labelEl.textContent = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'vault-rename-input';
    input.value = basename;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('data-rename-input', '1');
    labelEl.appendChild(input);

    function stop(e: Event): void { e.stopPropagation(); }
    input.addEventListener('click', stop);
    input.addEventListener('mousedown', stop);
    input.addEventListener('dblclick', stop);
    input.addEventListener('contextmenu', stop);

    let finished = false;
    function cleanup(): void {
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', onBlur);
        labelEl.classList.remove('editing');
        delete labelEl.dataset.editing;
    }
    function restore(): void {
        cleanup();
        labelEl.textContent = originalText;
    }
    function commit(): void {
        if (finished) return;
        finished = true;
        const newName = (input.value || '').trim();
        if (!newName || newName === originalText) {
            restore();
            return;
        }
        cleanup();
        labelEl.textContent = newName; // optimistisch bis vault:refresh kommt
        const normalized = path.replace(/\\/g, '/');
        const lastSlash = normalized.lastIndexOf('/');
        const parent = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
        const newPath = parent + newName;
        invoke('rename_file', { oldPath: path, newPath }).catch(function (err) {
            deps.showStatus(typeof err === 'string' ? err : 'Umbenennen fehlgeschlagen');
            deps.refreshVault();
        });
    }
    function cancel(): void {
        if (finished) return;
        finished = true;
        restore();
    }
    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        else { e.stopPropagation(); }
    }
    function onBlur(): void { commit(); }
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);

    input.focus();
    const dot = basename.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
}

export function initContextMenu(d: Deps): void {
    deps = d;
    ctxMenu = document.getElementById('context-menu');
    if (!ctxMenu) return;

    ctxMenu.addEventListener('click', function (e) {
        const item = (e.target as HTMLElement).closest('.ctx-item') as HTMLElement;
        if (!item || item.classList.contains('disabled') || !ctxTarget) return;
        const act = item.getAttribute('data-act');
        const path = ctxTarget.path;
        const isDir = ctxTarget.isDirectory;
        closeContextMenu();
        if (act === 'open' && !isDir) {
            deps.openDocument(path);
        } else if (act === 'pin') {
            invoke('workspace_pin', { path, isDirectory: isDir }).catch(function () {});
        } else if (act === 'unpin') {
            invoke('workspace_unpin', { path }).catch(function () {});
        } else if (act === 'remove-recent') {
            invoke('workspace_remove_recent', { path }).catch(function () {});
        } else if (act === 'rename') {
            startInlineRename(path);
        } else if (act === 'show') {
            invoke('show_in_file_manager', { path }).catch(function () {});
        } else if (act === 'terminal') {
            invoke('open_terminal_at', { path }).catch(function () {});
        } else if (act === 'copy') {
            if (navigator.clipboard) navigator.clipboard.writeText(path).catch(function () {});
        }
    });
    document.addEventListener('click', function (e) {
        if (!ctxMenu.contains(e.target as Node)) closeContextMenu();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeContextMenu();
    });
}
