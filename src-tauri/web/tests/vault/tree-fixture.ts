// Gemeinsames Baum-Fixture fuer die Tastatur-Tests des Vault-Baums
// (Referenz-Fixture aus dem Auftrag): „Angepinnt" mit Ordner A (offen;
// a1.md, Ordner B (zu), a2.md) und p.md; „Zuletzt geöffnet" mit r.md.
// Markup wie vault.rs::item_html/section_html.

export function fileNode(path: string, name: string): string {
    return `<li class="node" data-kind="file" data-path="${path}" title="${path}"><div class="row"><span class="caret hidden">▾</span><span class="icon"></span><span class="label">${name}</span></div><ul class="children collapsed"></ul></li>`;
}

export function dirNode(path: string, name: string, open: boolean, children: string): string {
    return `<li class="node" data-kind="dir" data-path="${path}" title="${path}"><div class="row"><span class="caret${open ? ' open' : ''}">▾</span><span class="icon">${open ? '📂' : '📁'}</span><span class="label">${name}</span></div><ul class="children${open ? '' : ' collapsed'}">${children}</ul></li>`;
}

export function section(key: string, title: string, children: string): string {
    return `<li class="section" data-section="${key}"><div class="row"><span class="caret open">▾</span><span class="icon">📌</span><span class="label">${title}</span></div><ul class="children">${children}</ul></li>`;
}

export function treeHtml(bOpen = false, bChildren = ''): string {
    return section('pinned', 'Angepinnt',
        dirNode('/v/A', 'A', true,
            fileNode('/v/A/a1.md', 'a1.md')
            + dirNode('/v/A/B', 'B', bOpen, bChildren)
            + fileNode('/v/A/a2.md', 'a2.md'))
        + fileNode('/v/p.md', 'p.md'))
        + section('recent', 'Zuletzt geöffnet', fileNode('/w/r.md', 'r.md'));
}

export function item(name: string): HTMLElement {
    if (name === 'Angepinnt') return document.querySelector('li.section[data-section="pinned"]') as HTMLElement;
    if (name === 'Zuletzt geöffnet') return document.querySelector('li.section[data-section="recent"]') as HTMLElement;
    const labels = document.querySelectorAll('#vault-tree .label');
    for (let i = 0; i < labels.length; i++) {
        if (labels[i].textContent === name) return labels[i].closest('li') as HTMLElement;
    }
    throw new Error('no item ' + name);
}

export function focused(): string {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !el.matches('li.section, li.node')) return '(' + (el ? el.tagName : 'null') + ')';
    return el.querySelector(':scope > .row > .label')!.textContent || '';
}

export function press(key: string, opts: KeyboardEventInit = {}): KeyboardEvent {
    const target = (document.activeElement || document.body) as HTMLElement;
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
    target.dispatchEvent(ev);
    return ev;
}

