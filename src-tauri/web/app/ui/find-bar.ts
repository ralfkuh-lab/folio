/* Find-Bar (HTML in der Shell, FolioEditor / ViewFinder liefern Logik).
   Im Edit-Mode bedient sie Monaco (via window.FolioEditor); im View-Mode
   den DOM-Sucher (ViewFinder aus view/markdown.ts).

   ensureEditorMounted + focusEditor kommen aus dem Editor-Shell und
   werden per init injiziert (statt frueher window.focusEditor — die
   Bridge existiert seit Phase 4.6 nicht mehr). */

import { ViewFinder } from '../view/markdown';

let bar: HTMLElement = null;
let input: HTMLInputElement = null;
let counter: HTMLElement = null;
let prevBtn: HTMLElement = null;
let nextBtn: HTMLElement = null;
let optsBtn: HTMLElement = null;
let closeBtn: HTMLElement = null;
let optsPanel: HTMLElement = null;
let caseChk: HTMLInputElement = null;
let wordChk: HTMLInputElement = null;

let ensureEditorMountedDep: (initial?: string) => Promise<boolean> = null;
let focusEditorDep: () => void = null;
let lastTermMemo = '';
let inputDebounce: ReturnType<typeof setTimeout> | null = null;
const INPUT_DEBOUNCE_MS = 150;

function isEditMode(): boolean { return document.body.classList.contains('edit-mode'); }

// Liefert die aktive Backend-Implementierung: Monaco-Editor (Edit) oder DOM-Sucher (View).
function getFinder(): any {
    return isEditMode() ? window.FolioEditor : ViewFinder;
}

function isOpen(): boolean { return bar.classList.contains('open'); }

function doOpen(initial?: string): void {
    bar.classList.add('open');
    if (typeof initial === 'string' && initial.length > 0) {
        input.value = initial;
    }
    const f = getFinder();
    if (f) {
        f.setFindOptions({
            caseSensitive: caseChk.checked,
            wholeWord: wordChk.checked,
        });
        f.openFind(input.value);
    }
    input.focus();
    input.select();
}

function open(initial?: string): void {
    if (isEditMode()) {
        ensureEditorMountedDep('').then(function (ok: boolean) {
            if (!ok) return;
            doOpen(initial);
        });
    } else {
        doOpen(initial);
    }
}

function close(): void {
    bar.classList.remove('open');
    optsPanel.classList.remove('open');
    optsBtn.classList.remove('active');
    // Beide Finder closen — robust gegen Mode-Switch-Race: SetEditMode laeuft im
    // Edit→View-Wechsel vor CloseEditorFind, sonst wuerde getFinder() den falschen
    // Finder treffen und die Edit-Highlights blieben haengen.
    if (window.FolioEditor) window.FolioEditor.closeFind();
    if (ViewFinder) ViewFinder.closeFind();
    if (isEditMode() && focusEditorDep) focusEditorDep();
}

export function openEditorFind(initialTerm?: string): void { open(initialTerm); }
export function closeEditorFind(): void { close(); }

export function setEditorFindTerm(term: string): void {
    input.value = term || '';
    if (!isOpen()) open(term || '');
    else { const f = getFinder(); if (f) f.setFindTerm(term || ''); }
}

function pickSeed(arg?: string): string {
    if (typeof arg === 'string' && arg) return arg;
    if (input.value) return input.value;
    return lastTermMemo;
}

export function findNext(lastTerm?: string): void {
    const seed = pickSeed(lastTerm);
    if (!bar.classList.contains('open')) { open(seed); return; }
    if (!input.value) {
        if (seed) { input.value = seed; const f0 = getFinder(); if (f0) f0.openFind(seed); }
        else { input.focus(); input.select(); return; }
    }
    const f = getFinder(); if (f) f.findNext();
}

export function findPrev(lastTerm?: string): void {
    const seed = pickSeed(lastTerm);
    if (!bar.classList.contains('open')) { open(seed); return; }
    if (!input.value) {
        if (seed) { input.value = seed; const f0 = getFinder(); if (f0) f0.openFind(seed); }
        else { input.focus(); input.select(); return; }
    }
    const f = getFinder(); if (f) f.findPrev();
}

// Wird nach Mode-Switch von setMode getriggert. Wenn die Find-Bar offen war,
// bleibt sie offen: alten Mode-Finder closen, neuen mit aktuellem Term
// (+ Optionen) starten. setTimeout(0), damit pending PostMessage-Events
// (z.B. loadEditorText beim Wechsel zu Edit) vor dem Re-Mount drankommen.
export function afterModeSwitch(): void {
    setTimeout(function () {
        if (bar.classList.contains('open')) {
            if (window.FolioEditor) window.FolioEditor.closeFind();
            if (ViewFinder) ViewFinder.closeFind();
            const f = getFinder();
            if (f) {
                f.setFindOptions({
                    caseSensitive: caseChk.checked,
                    wholeWord: wordChk.checked,
                });
                f.openFind(input.value);
            }
            input.focus();
            input.select();
        } else if (isEditMode() && focusEditorDep) {
            focusEditorDep();
        }
    }, 0);
}

export function initFindBar(deps: {
    ensureEditorMounted: (initial?: string) => Promise<boolean>;
    focusEditor: () => void;
}): void {
    ensureEditorMountedDep = deps.ensureEditorMounted;
    focusEditorDep = deps.focusEditor;

    bar = document.getElementById('find-bar');
    input = document.getElementById('find-input') as HTMLInputElement;
    counter = document.getElementById('find-counter');
    prevBtn = document.getElementById('find-prev');
    nextBtn = document.getElementById('find-next');
    optsBtn = document.getElementById('find-opts');
    closeBtn = document.getElementById('find-close');
    optsPanel = document.getElementById('find-opts-panel');
    caseChk = document.getElementById('find-case') as HTMLInputElement;
    wordChk = document.getElementById('find-word') as HTMLInputElement;

    // Debounce: setFindTerm laeuft erst nach kurzer Tipp-Pause. Sonst startet
    // pro Zeichen eine Suche, die in grossen Dokumenten zwar dank Chunking
    // nicht mehr blockiert, aber unnoetig DOM-Mutation produziert.
    input.addEventListener('input', function () {
        if (input.value) lastTermMemo = input.value;
        if (inputDebounce) clearTimeout(inputDebounce);
        inputDebounce = setTimeout(function () {
            inputDebounce = null;
            const f = getFinder(); if (f) f.setFindTerm(input.value);
        }, INPUT_DEBOUNCE_MS);
    });
    input.addEventListener('keydown', function (e: KeyboardEvent) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const f = getFinder(); if (!f) return;
            if (e.shiftKey) f.findPrev(); else f.findNext();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    });
    prevBtn.addEventListener('click', function () { const f = getFinder(); if (f) f.findPrev(); });
    nextBtn.addEventListener('click', function () { const f = getFinder(); if (f) f.findNext(); });
    closeBtn.addEventListener('click', close);
    optsBtn.addEventListener('click', function () {
        const on = !optsPanel.classList.contains('open');
        optsPanel.classList.toggle('open', on);
        optsBtn.classList.toggle('active', on);
    });
    function syncOptions(): void {
        const f = getFinder();
        if (f) {
            f.setFindOptions({
                caseSensitive: caseChk.checked,
                wholeWord: wordChk.checked,
            });
        }
    }
    caseChk.addEventListener('change', syncOptions);
    wordChk.addEventListener('change', syncOptions);

    // Strg+F und F3 muessen vor Monaco greifen, sonst schluckt Monacos
    // eingebauter Find-Widget die Tasten im Editor-Fokus. capture:true +
    // stopPropagation deckt sowohl Editor- als auch View-/Vault-Fokus ab.
    document.addEventListener('keydown', function (e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            e.stopPropagation();
            openEditorFind('');
        } else if (e.key === 'F3') {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) findPrev(); else findNext();
        }
    }, { capture: true });

    window.addEventListener('folio-find-state', function (e: CustomEvent) {
        const s = e.detail || {};
        if (!s.term && !input.value) { counter.textContent = ''; return; }
        if (typeof s.total !== 'number' || s.total === 0) {
            counter.textContent = (input.value || s.term) ? '0/0' : '';
        } else if (s.scanning || s.active < 0) {
            // Suchlauf laeuft noch — Total waechst, Active steht erst am Ende fest.
            counter.textContent = '…/' + s.total;
        } else {
            counter.textContent = (s.active + 1) + '/' + s.total;
        }
    });
}
