/* Tastaturbedienung im Vault-Baum (Spec docs/spec-vault-keyboard.md, K1).

   Muster ist der WAI-ARIA-„Tree View" mit wanderndem tabindex: treeitem
   ist das `li` (Abschnitt bzw. Knoten), genau eines hat tabindex="0", die
   Pfeiltasten bewegen den Fokus. Der Fokusring sitzt per CSS auf der
   eigenen `.row` (`li:focus-visible > .row`).

   Rollen/Attribute setzt das Frontend nach jedem Baum-Umbau — das
   Backend-HTML bleibt unverändert (wie Gitignore-/Git-Status-Klassen).
   Ein MutationObserver (childList + class) zieht sie nach: so sieht er
   auch `vf-hidden` aus dem Filter und aufgeklappte Carets.

   Der Fokus ist kein DOM-Zustand, sondern ein Schlüssel (Abschnitt +
   `data-path`): Nach jedem Umbau landet er auf derselben Zeile, sonst auf
   dem nächsten sichtbaren Vorfahren. Zurückgeholt wird er nur, wenn er
   vorher im Baum war und seitdem niemand anderes ihn genommen hat — ein
   verspäteter Rebuild darf weder einen neueren Fokus im Baum noch den im
   Editor überschreiben.

   K2: Datei-Kürzel (F2, Entf, Strg+C/X/V/D, Umschalt+F10) hängen am
   keydown des Baums — sie wirken also nur, wenn eine Zeile den Fokus hat,
   nie im Editor oder in der View. Ausgeführt wird über dieselbe
   Aktionsfunktion und dieselben Bedingungen wie im Kontextmenü.

   Kein Import aus tree.ts/context-menu.ts: Aktionen kommen als Deps
   (vermeidet den Zyklus tree → tree-keyboard → tree). */

type Deps = {
    toggleDir: (node: HTMLElement) => void;
    toggleSection: (section: HTMLElement) => void;
    openDocument: (path: string) => void;
    openInNewTab: (path: string) => void;
    getActivePath: () => string;
    openLeftRail: () => void;
    /** Klappt die Ordner auf (`vault_expand_paths`) und baut den Baum neu. */
    expandPaths: (dirs: string[]) => Promise<void>;
    /** Kontextmenü-Aktion auf der Zeile; null = das Menü böte sie dort nicht an. */
    runAction: (act: string, node: HTMLElement) => Promise<{ done: boolean; path?: string }> | null;
    /** Kontextmenü an der Zeile, per Tastatur (Fokus in das Menü). */
    openMenu: (node: HTMLElement) => void;
};

const ITEM_SELECTOR = 'li.section, li.node';
const TYPEAHEAD_MS = 500;

let deps: Deps | null = null;
let ROOT: HTMLElement | null = null;
/** Abschnitt + "\n" + data-path (leer für die Abschnittszeile). */
let focusKey: string | null = null;
/** Ziel, das erst mit einem späteren Rebuild erscheint (umbenannter,
 *  eingefügter, duplizierter Eintrag). Eine Nutzer-Fokusbewegung verwirft es. */
let pendingKey: string | null = null;
/** Fokus lag zuletzt im Baum (überlebt das Entfernen der Zeile beim Rebuild). */
let treeFocused = false;
/** Wohin Escape zurückgibt: letztes fokussiertes Element außerhalb der Vault-Rail. */
let returnFocus: HTMLElement | null = null;
/** Jede Nutzer-Fokusbewegung erhöht sie; ein laufendes Aufdecken prüft sie. */
let focusGen = 0;
let typeBuffer = '';
let typeTime = 0;
let observer: MutationObserver | null = null;
let syncing = false;

function isItem(el: Element | null): el is HTMLElement {
    return !!el && !!ROOT && el instanceof HTMLElement && el.matches(ITEM_SELECTOR)
        && ROOT.contains(el);
}

function isSection(li: HTMLElement): boolean {
    return li.classList.contains('section');
}

function isExpandable(li: HTMLElement): boolean {
    return isSection(li) || li.getAttribute('data-kind') === 'dir';
}

function isExpanded(li: HTMLElement): boolean {
    const caret = li.querySelector(':scope > .row > .caret');
    return !!caret && caret.classList.contains('open');
}

function labelOf(li: HTMLElement): string {
    const label = li.querySelector(':scope > .row > .label');
    return label ? (label.textContent || '') : '';
}

function parentItem(li: HTMLElement): HTMLElement | null {
    const p = li.parentElement ? li.parentElement.closest(ITEM_SELECTOR) : null;
    return isItem(p) ? p : null;
}

function sectionKeyOf(li: HTMLElement): string {
    const section = li.closest('li.section');
    return section ? (section.getAttribute('data-section') || '') : '';
}

function keyOf(li: HTMLElement): string {
    return sectionKeyOf(li) + '\n' + (isSection(li) ? '' : (li.getAttribute('data-path') || ''));
}

/** Sichtbar = kein eingeklappter Vorfahr, kein `vf-hidden` (Zeile oder Vorfahr). */
export function isVaultItemVisible(li: HTMLElement): boolean {
    let el: HTMLElement | null = li;
    while (el && el !== ROOT) {
        if (el.classList.contains('vf-hidden')) return false;
        if (el !== li && el.tagName === 'UL' && el.classList.contains('collapsed')) return false;
        el = el.parentElement;
    }
    return !!el;
}

/** Alle sichtbaren Zeilen in Dokument-Reihenfolge. */
export function visibleVaultItems(): HTMLElement[] {
    if (!ROOT) return [];
    const all = ROOT.querySelectorAll<HTMLElement>(ITEM_SELECTOR);
    const out: HTMLElement[] = [];
    for (let i = 0; i < all.length; i++) {
        if (isVaultItemVisible(all[i])) out.push(all[i]);
    }
    return out;
}

function findSection(key: string): HTMLElement | null {
    if (!ROOT) return null;
    const sections = ROOT.querySelectorAll<HTMLElement>('li.section');
    for (let i = 0; i < sections.length; i++) {
        if (sections[i].getAttribute('data-section') === key) return sections[i];
    }
    return null;
}

function findNodeInSection(section: HTMLElement, path: string): HTMLElement | null {
    const nodes = section.querySelectorAll<HTMLElement>('li.node');
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('data-path') === path) return nodes[i];
    }
    return null;
}

function isRenameInput(el: Element | null): boolean {
    return !!el && el.classList.contains('vault-rename-input');
}

/** Genau die Zeile zum Schlüssel, nur wenn sichtbar (ohne Vorfahren-Rückfall). */
function exactItem(key: string): HTMLElement | null {
    const nl = key.indexOf('\n');
    const section = findSection(key.slice(0, nl));
    const path = key.slice(nl + 1);
    if (!section || !path) return null;
    const node = findNodeInSection(section, path);
    return node && isVaultItemVisible(node) ? node : null;
}

/** Zeile zum Schlüssel; fehlt sie oder ist unsichtbar, der nächste sichtbare
 *  Vorfahr (über den Pfad, weil die alte Zeile nach dem Rebuild weg ist). */
function resolveKey(key: string | null): HTMLElement | null {
    if (key === null) return null;
    const nl = key.indexOf('\n');
    const section = findSection(key.slice(0, nl));
    if (!section) return null;
    let path = key.slice(nl + 1);
    while (path) {
        const node = findNodeInSection(section, path);
        if (node && isVaultItemVisible(node)) return node;
        const slash = path.lastIndexOf('/');
        path = slash > 0 ? path.slice(0, slash) : '';
    }
    return isVaultItemVisible(section) ? section : null;
}

/** Die Zeile, die tabindex="0" trägt bzw. den Fokus bekommt. */
function currentItem(): HTMLElement | null {
    return resolveKey(focusKey) || visibleVaultItems()[0] || null;
}

function setAttr(el: Element, name: string, value: string): void {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function levelOf(li: HTMLElement): number {
    let level = 0;
    let el: HTMLElement | null = li;
    while (el && el !== ROOT) {
        if (el.matches(ITEM_SELECTOR)) level++;
        el = el.parentElement;
    }
    return level;
}

/** Rollen, ARIA-Zustand und wandernder tabindex; danach ggf. Fokus zurück. */
export function syncVaultTreeA11y(): void {
    if (!ROOT) return;
    const items = ROOT.querySelectorAll<HTMLElement>(ITEM_SELECTOR);
    for (let i = 0; i < items.length; i++) {
        const li = items[i];
        setAttr(li, 'role', 'treeitem');
        setAttr(li, 'aria-level', String(levelOf(li)));
        setAttr(li, 'tabindex', '-1');
        const expandable = isExpandable(li);
        if (expandable) setAttr(li, 'aria-expanded', String(isExpanded(li)));
        else if (li.hasAttribute('aria-expanded')) li.removeAttribute('aria-expanded');
        // Ohne eigenen Namen läse ein Screenreader den ganzen Unterbaum vor.
        const label = labelOf(li);
        if (label) setAttr(li, 'aria-label', label);
        const ul = li.querySelector(':scope > ul.children');
        if (ul) setAttr(ul, 'role', expandable ? 'group' : 'none');
    }
    const empties = ROOT.querySelectorAll('li.empty');
    for (let i = 0; i < empties.length; i++) setAttr(empties[i], 'role', 'none');

    const active = document.activeElement as HTMLElement | null;
    if (pendingKey !== null) {
        const arrived = exactItem(pendingKey);
        if (arrived) {
            focusKey = pendingKey;
            pendingKey = null;
            const inTree = !!active && (ROOT.contains(active) || active === document.body);
            if (treeFocused && inTree && !isRenameInput(active)) {
                focusItem(arrived);
                return;
            }
        }
    }
    const target = currentItem();
    if (target) target.setAttribute('tabindex', '0');
    if (!target || !treeFocused) return;
    if (active === target) return;
    const lost = !active || active === document.body || !active.isConnected
        || (isItem(active) && !isVaultItemVisible(active));
    if (lost) focusItem(target);
}

function focusItem(li: HTMLElement): void {
    focusKey = keyOf(li);
    if (ROOT) {
        const prev = ROOT.querySelectorAll('[tabindex="0"]');
        for (let i = 0; i < prev.length; i++) {
            if (prev[i] !== li) prev[i].setAttribute('tabindex', '-1');
        }
    }
    li.setAttribute('tabindex', '0');
    li.focus({ preventScroll: true });
    const row = li.querySelector(':scope > .row') as HTMLElement | null;
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
}

/** Fokus zurück an eine Baumzeile (nach Rename, Menü, Dialog). Mit
 *  `pendingPath` springt er auf diesen Eintrag desselben Abschnitts, sobald
 *  ein Rebuild ihn zeigt (umbenannt, eingefügt, dupliziert). */
export function focusVaultItem(li: HTMLElement, pendingPath?: string): void {
    if (!ROOT) return;
    // Eine inzwischen ausgehängte Zeile kennt ihren Abschnitt nicht mehr;
    // dann gilt der zuletzt gemerkte Schlüssel.
    focusByKey(li.isConnected ? keyOf(li) : focusKey, pendingPath);
}

/** Wie focusVaultItem, aber über den Schlüssel — für asynchrone Aktionen,
 *  deren Zeile beim Abschluss schon durch einen Rebuild ersetzt sein kann. */
function focusByKey(key: string | null, pendingPath?: string): void {
    if (key === null) return;
    treeFocused = true;
    pendingKey = pendingPath ? key.slice(0, key.indexOf('\n')) + '\n' + pendingPath : null;
    focusKey = key;
    const target = currentItem();
    if (target) focusItem(target);
    if (pendingKey !== null) syncVaultTreeA11y();
}

function firstVisibleChild(li: HTMLElement): HTMLElement | null {
    const ul = li.querySelector(':scope > ul.children');
    if (!ul) return null;
    for (let i = 0; i < ul.children.length; i++) {
        const c = ul.children[i] as HTMLElement;
        if (isItem(c) && isVaultItemVisible(c)) return c;
    }
    return null;
}

function toggle(li: HTMLElement): void {
    if (!deps) return;
    if (isSection(li)) deps.toggleSection(li);
    else deps.toggleDir(li);
    // Sofort, nicht erst per Observer: der Screenreader sagt den Zustand an.
    li.setAttribute('aria-expanded', String(isExpanded(li)));
}

function activate(li: HTMLElement, newTab: boolean): void {
    if (!deps) return;
    if (isExpandable(li)) {
        if (!newTab) toggle(li);
        return;
    }
    const path = li.getAttribute('data-path');
    if (!path) return;
    if (newTab) deps.openInNewTab(path);
    else deps.openDocument(path);
}

function typeAhead(ch: string, current: HTMLElement): void {
    const now = Date.now();
    typeBuffer = now - typeTime <= TYPEAHEAD_MS ? typeBuffer + ch.toLowerCase() : ch.toLowerCase();
    typeTime = now;
    const items = visibleVaultItems();
    const start = items.indexOf(current);
    // Ein Zeichen springt weiter, mehrere suchen ab der aktuellen Zeile —
    // sonst verließe „a2" die bereits passende Zeile „a…" sofort wieder.
    const offset = typeBuffer.length === 1 ? 1 : 0;
    for (let i = 0; i < items.length; i++) {
        const li = items[(start + offset + i + items.length) % items.length];
        if (labelOf(li).toLowerCase().startsWith(typeBuffer)) {
            focusItem(li);
            return;
        }
    }
}

/** Escape: Fokus zurück an Editor bzw. View, wo er vorher war. */
function leaveTree(): void {
    const from = document.activeElement;
    if (returnFocus && returnFocus.isConnected && !returnFocus.closest('[hidden]')) {
        returnFocus.focus();
        if (document.activeElement !== from) return;
    }
    const body = document.body.classList;
    if ((body.contains('edit-mode') || body.contains('split-mode'))
        && window.FolioEditor && typeof window.FolioEditor.focus === 'function') {
        window.FolioEditor.focus();
        if (document.activeElement !== from) return;
    }
    // View ohne fokussierbares Ziel: den Baum verlassen, Tasten gehen ans Dokument.
    treeFocused = false;
    if (from instanceof HTMLElement) from.blur();
}

function onKeydown(e: KeyboardEvent): void {
    if (!ROOT || e.defaultPrevented || e.isComposing) return;
    const li = e.target as HTMLElement;
    if (!isItem(li)) return; // z. B. das Inline-Rename-Input
    if (e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    focusGen++;
    pendingKey = null;
    if (ctrl && !e.shiftKey && handleClipboardKey(e.key.toLowerCase(), li)) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }
    switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
            if (ctrl) { handled = false; break; }
            const items = visibleVaultItems();
            const i = items.indexOf(li);
            const next = items[e.key === 'ArrowDown' ? i + 1 : i - 1];
            if (i >= 0 && next) focusItem(next);
            break;
        }
        case 'ArrowRight':
            if (ctrl || !isExpandable(li)) break;
            if (!isExpanded(li)) toggle(li);
            else {
                const child = firstVisibleChild(li);
                if (child) focusItem(child);
            }
            break;
        case 'ArrowLeft': {
            if (ctrl) break;
            if (isExpandable(li) && isExpanded(li)) {
                toggle(li);
                break;
            }
            const parent = parentItem(li);
            if (parent) focusItem(parent);
            break;
        }
        case 'Home':
        case 'End': {
            if (ctrl) { handled = false; break; }
            const items = visibleVaultItems();
            const target = e.key === 'Home' ? items[0] : items[items.length - 1];
            if (target) focusItem(target);
            break;
        }
        case 'Enter':
            activate(li, ctrl);
            break;
        case 'F2':
            if (ctrl) { handled = false; break; }
            runOnItem('rename', li);
            break;
        case 'Delete':
            if (ctrl || e.shiftKey) { handled = false; break; }
            deleteItem(li);
            break;
        case 'F10':
            if (!e.shiftKey || ctrl) { handled = false; break; }
            openMenuAt(li);
            break;
        case 'ContextMenu':
            openMenuAt(li);
            break;
        case 'Escape':
            // Zen und offene Kontextmenüs haben Vorrang (deren Capture-/
            // Dokument-Handler schließen zuerst bzw. danach).
            if (document.body.classList.contains('zen-mode')
                || document.querySelector('#context-menu.open, #tab-ctx-menu.open')) {
                handled = false;
                break;
            }
            leaveTree();
            break;
        default:
            if (e.key.length === 1 && !ctrl
                && (e.key !== ' ' || (typeBuffer && Date.now() - typeTime <= TYPEAHEAD_MS))) {
                typeAhead(e.key, li);
            } else if (e.key === ' ' && !ctrl) {
                activate(li, false);
            } else {
                handled = false;
            }
    }
    if (handled) {
        e.preventDefault();
        e.stopPropagation();
    }
}

/** Abschnittszeilen haben keine Datei-Aktionen. */
function runOnItem(act: string, li: HTMLElement): Promise<{ done: boolean; path?: string }> | null {
    if (!deps || isSection(li)) return null;
    return deps.runAction(act, li);
}

let menuOpenedAt = 0;

function openMenuAt(li: HTMLElement): void {
    if (!deps || isSection(li)) return;
    menuOpenedAt = Date.now();
    deps.openMenu(li);
}

/** Löst der Browser zur Kontextmenü-Taste zusätzlich ein `contextmenu`-Event
 *  aus, darf der Maus-Pfad das gerade per Tastatur geöffnete Menü nicht
 *  ersetzen. */
export function isKeyboardMenuJustOpened(): boolean {
    return Date.now() - menuOpenedAt < 300;
}

/** Strg+C/X/V/D. Einfügen auf einer Datei zielt auf ihren Elternordner —
 *  aber nur, wenn der ein Ordner im Baum ist (nicht bei Pin-Wurzel-Dateien
 *  und Recent-Einträgen, deren Elternordner nicht zum Vault gehört). */
function handleClipboardKey(key: string, li: HTMLElement): boolean {
    const act = key === 'c' ? 'clip-copy' : key === 'x' ? 'cut' : key === 'd' ? 'duplicate'
        : key === 'v' ? 'paste' : '';
    if (!act) return false;
    if (isSection(li)) return true;
    let target = li;
    if (act === 'paste' && li.getAttribute('data-kind') !== 'dir') {
        const parent = parentItem(li);
        if (!parent || isSection(parent)) return true;
        target = parent;
    }
    const run = runOnItem(act, target);
    if (run && (act === 'paste' || act === 'duplicate')) {
        // Ein zugeklappter Zielordner würde den neuen Eintrag verbergen.
        if (act === 'paste' && !isExpanded(target)) toggle(target);
        const gen = focusGen;
        const key = keyOf(li);
        void run.then(function (res) {
            if (res.done && res.path && gen === focusGen) focusByKey(key, res.path);
        });
    }
    return true;
}

/** Entf: nach dem Löschen auf den nächsten sichtbaren Nachbarn (außerhalb
 *  des gelöschten Unterbaums), sonst den vorigen; Abbruch → zurück zur Zeile. */
function deleteItem(li: HTMLElement): void {
    const items = visibleVaultItems();
    const i = items.indexOf(li);
    const after = items.slice(i + 1).find(function (x) { return !li.contains(x); });
    const neighbor = after || items[i - 1] || null;
    const run = runOnItem('delete', li);
    if (!run) return;
    const ownKey = keyOf(li);
    const neighborKey = neighbor ? keyOf(neighbor) : null;
    void run.then(function (res) {
        focusByKey(res.done ? neighborKey : ownKey);
    });
}

function onFocusIn(e: FocusEvent): void {
    const target = e.target as HTMLElement;
    treeFocused = true;
    if (isItem(target)) {
        focusKey = keyOf(target);
        const prev = ROOT!.querySelectorAll('[tabindex="0"]');
        for (let i = 0; i < prev.length; i++) {
            if (prev[i] !== target) prev[i].setAttribute('tabindex', '-1');
        }
        target.setAttribute('tabindex', '0');
    }
    const from = e.relatedTarget as HTMLElement | null;
    const region = document.getElementById('vault-region');
    if (!from) returnFocus = null;
    else if (!(region ? region.contains(from) : ROOT!.contains(from))) returnFocus = from;
}

function onFocusOut(e: FocusEvent): void {
    const to = e.relatedTarget as Node | null;
    if (to && ROOT!.contains(to)) return;
    if (to) {
        treeFocused = false;
        return;
    }
    // Ohne Ziel: Klick ins Leere (Fokus geht an body) ODER die Zeile ist
    // beim Rebuild verschwunden bzw. ausgeblendet worden. Nur im ersten
    // Fall hat der Baum den Fokus wirklich abgegeben.
    const from = e.target as HTMLElement;
    setTimeout(function () {
        const active = document.activeElement;
        if (active && active !== document.body) {
            if (!ROOT!.contains(active)) treeFocused = false;
            return;
        }
        if (from.isConnected && (!isItem(from) || isVaultItemVisible(from))) treeFocused = false;
    }, 0);
}

function onPointerDown(): void {
    focusGen++;
    pendingKey = null;
}

/** Pfad des aktiven Dokuments unterhalb einer Ordner-Pin-Wurzel: die
 *  aufzuklappende Ordnerkette (Wurzel bis Elternordner). */
function ancestorDirsUnderPin(path: string): string[] | null {
    const pinned = findSection('pinned');
    if (!pinned) return null;
    const ul = pinned.querySelector(':scope > ul.children');
    if (!ul) return null;
    let best = '';
    for (let i = 0; i < ul.children.length; i++) {
        const c = ul.children[i] as HTMLElement;
        if (c.getAttribute('data-kind') !== 'dir') continue;
        const root = (c.getAttribute('data-path') || '').replace(/\/+$/, '');
        if (root && path.startsWith(root + '/') && root.length > best.length) best = root;
    }
    if (!best) return null;
    const dirs = [best];
    const rest = path.slice(best.length + 1).split('/');
    rest.pop();
    let acc = best;
    for (const seg of rest) {
        acc += '/' + seg;
        dirs.push(acc);
    }
    return dirs;
}

function findVisibleInSection(key: string, path: string): HTMLElement | null {
    const section = findSection(key);
    const node = section ? findNodeInSection(section, path) : null;
    return node && isVaultItemVisible(node) ? node : null;
}

/** Strg+Umschalt+E / Ansicht → „Vault fokussieren": Vault-Rail einblenden,
 *  Fokus auf das aktive Dokument (Pfad bei Bedarf aufklappen), sonst auf die
 *  aktuelle bzw. erste Zeile. Im Zen-Modus ohne Wirkung. */
export async function focusVaultTree(): Promise<void> {
    if (!ROOT || !deps) return;
    if (document.body.classList.contains('zen-mode')) return;
    if (document.body.classList.contains('vault-hidden')) deps.openLeftRail();
    const gen = ++focusGen;
    const path = (deps.getActivePath() || '').replace(/\\/g, '/');
    // Der Ort im angepinnten Baum geht vor dem Eintrag in „Zuletzt geöffnet"
    // (dort steht das aktive Dokument fast immer auch).
    let target: HTMLElement | null = path ? findVisibleInSection('pinned', path) : null;
    const dirs = !target && path ? ancestorDirsUnderPin(path) : null;
    const pinned = findSection('pinned');
    if (dirs && pinned) {
        if (!isExpanded(pinned)) deps.toggleSection(pinned);
        const interim = currentItem();
        if (interim) focusItem(interim);
        await deps.expandPaths(dirs);
        // Hat der Nutzer inzwischen selbst den Fokus bewegt, gewinnt er.
        if (gen !== focusGen) return;
        target = findVisibleInSection('pinned', path);
    }
    if (!target && path) {
        const recent = findSection('recent');
        if (recent && findNodeInSection(recent, path) && !isExpanded(recent)) {
            deps.toggleSection(recent);
        }
        target = findVisibleInSection('recent', path);
    }
    target = target || currentItem();
    if (target) {
        treeFocused = true;
        focusItem(target);
    }
}

export function initVaultTreeKeyboard(root: HTMLElement, d: Deps): void {
    ROOT = root;
    deps = d;
    focusKey = null;
    pendingKey = null;
    treeFocused = false;
    returnFocus = null;
    typeBuffer = '';
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('pointerdown', onPointerDown);
    if (observer) observer.disconnect();
    if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(function () {
            if (syncing) return;
            syncing = true;
            try {
                syncVaultTreeA11y();
            } finally {
                // Eigene Attribut-Änderungen beobachtet er nicht (nur class),
                // trotzdem leeren — Muster aus filter.ts/clipboard.ts.
                observer?.takeRecords();
                syncing = false;
            }
        });
        observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }
    syncVaultTreeA11y();
}
