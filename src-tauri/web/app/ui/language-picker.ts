// @ts-nocheck
/* Editor-Sprach-Picker: Status-Cell oeffnet Quick-Pick mit Suchfeld +
   scrollbarer Liste. Override gilt bis zum naechsten Document-Wechsel;
   danach setzt document:loaded die Anzeige (und Monacos Model-Sprache)
   wieder auf die Auto-Erkennung aus der Pfad-Endung.

   Cross-Bundle-Abhaengigkeit: window.FolioEditor.{listLanguages,setLanguage}. */

let btn: HTMLElement | null = null;
let picker: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLElement | null = null;

let allLanguages: Array<{ id: string; label: string; aliases: string[] }> = [];
let currentId = 'plaintext';
let visibleItems: HTMLElement[] = [];
let activeIdx = -1;

function ensureLoaded(): boolean {
    if (allLanguages.length > 0) return true;
    const f = window.FolioEditor;
    if (!f || typeof f.listLanguages !== 'function') return false;
    allLanguages = f.listLanguages();
    allLanguages.sort(function (a, b) { return a.label.localeCompare(b.label); });
    return allLanguages.length > 0;
}

function labelFor(id: string): string {
    for (let i = 0; i < allLanguages.length; i++) {
        if (allLanguages[i].id === id) return allLanguages[i].label;
    }
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Plain Text';
}

function highlightActive(): void {
    for (let i = 0; i < visibleItems.length; i++) {
        visibleItems[i].classList.toggle('active', i === activeIdx);
    }
    if (activeIdx >= 0 && visibleItems[activeIdx]) {
        visibleItems[activeIdx].scrollIntoView({ block: 'nearest' });
    }
}

function renderList(filter: string): void {
    list.innerHTML = '';
    visibleItems = [];
    const f = (filter || '').trim().toLowerCase();
    for (let i = 0; i < allLanguages.length; i++) {
        const l = allLanguages[i];
        if (f) {
            const hay = (l.label + ' ' + l.id + ' ' + l.aliases.join(' ')).toLowerCase();
            if (hay.indexOf(f) === -1) continue;
        }
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.langId = l.id;
        if (l.id === currentId) li.classList.add('current');
        const labelEl = document.createElement('span');
        labelEl.textContent = l.label;
        const idEl = document.createElement('span');
        idEl.className = 'lang-id';
        idEl.textContent = l.id;
        li.appendChild(labelEl);
        li.appendChild(idEl);
        list.appendChild(li);
        visibleItems.push(li);
    }
    // Initial Highlight: aktuelle Sprache, sonst erstes Item.
    activeIdx = -1;
    for (let j = 0; j < visibleItems.length; j++) {
        if (visibleItems[j].dataset.langId === currentId) { activeIdx = j; break; }
    }
    if (activeIdx === -1 && visibleItems.length > 0) activeIdx = 0;
    highlightActive();
}

function open(): void {
    if (!ensureLoaded()) return;
    picker.hidden = false;
    input.value = '';
    renderList('');
    input.focus();
}

function close(): void { picker.hidden = true; }

function select(langId: string): void {
    if (!langId) return;
    const f = window.FolioEditor;
    if (f && typeof f.setLanguage === 'function') f.setLanguage(langId);
    setEditorLanguageDisplay(langId);
    close();
}

export function setEditorLanguageDisplay(id: string): void {
    if (!btn) return; // Init noch nicht gelaufen.
    currentId = id || 'plaintext';
    ensureLoaded();
    btn.textContent = labelFor(currentId);
    btn.hidden = false;
}

export function initLanguagePicker(): void {
    btn = document.getElementById('status-language');
    picker = document.getElementById('lang-picker');
    input = document.getElementById('lang-picker-input') as HTMLInputElement;
    list = document.getElementById('lang-picker-list');
    if (!btn || !picker || !input || !list) return;

    btn.addEventListener('click', function (e: MouseEvent) {
        e.stopPropagation();
        if (picker.hidden) open(); else close();
    });
    input.addEventListener('input', function () { renderList(input.value); });
    input.addEventListener('keydown', function (e: KeyboardEvent) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIdx >= 0 && visibleItems[activeIdx]) {
                select(visibleItems[activeIdx].dataset.langId);
            }
        }
        else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (visibleItems.length === 0) return;
            activeIdx = (activeIdx + 1) % visibleItems.length;
            highlightActive();
        }
        else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (visibleItems.length === 0) return;
            activeIdx = (activeIdx - 1 + visibleItems.length) % visibleItems.length;
            highlightActive();
        }
    });
    list.addEventListener('click', function (e: MouseEvent) {
        const li = (e.target as HTMLElement).closest('li');
        if (li && (li as HTMLElement).dataset.langId) select((li as HTMLElement).dataset.langId);
    });
    document.addEventListener('mousedown', function (e: MouseEvent) {
        if (picker.hidden) return;
        if (e.target === btn || picker.contains(e.target as Node)) return;
        close();
    });
}
