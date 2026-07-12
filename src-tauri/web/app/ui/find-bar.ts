/* Find-Bar (HTML in der Shell, FolioEditor / ViewFinder / FolioCodeView
   liefern Logik). Im Edit-Mode bedient sie Monaco (via window.FolioEditor);
   im View-Mode den passenden Sucher (Markdown-DOM, HTML-iframe oder
   Read-Only-Code-View).

   ensureEditorMounted + focusEditor kommen aus dem Editor-Shell und
   werden per init injiziert (statt frueher window.focusEditor — die
   Bridge existiert seit Phase 4.6 nicht mehr). */

import { ViewFinder } from '../view/markdown';
import { HtmlFinder } from '../view/html';

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
function isSplitMode(): boolean { return document.body.classList.contains('split-mode'); }
function isHtmlPreviewMode(): boolean { return document.body.classList.contains('html-preview-mode'); }
function isTextKind(): boolean { return document.body.classList.contains('kind-text'); }
function isCodeViewMode(): boolean {
    return isTextKind() && !isEditMode() && !isSplitMode() && !isHtmlPreviewMode();
}

function isSearchableKind(): boolean {
    const body = document.body;
    return !body.classList.contains('kind-image') && !body.classList.contains('kind-binary');
}

const CodeViewFinder = {
    openFind: function (seed?: string): void { if (window.FolioCodeView) window.FolioCodeView.openFind(seed); },
    closeFind: function (): void { if (window.FolioCodeView) window.FolioCodeView.closeFind(); },
    setFindTerm: function (term: string): void { if (window.FolioCodeView) window.FolioCodeView.setFindTerm(term); },
    setFindOptions: function (opts: any): void { if (window.FolioCodeView) window.FolioCodeView.setFindOptions(opts); },
    findNext: function (): void { if (window.FolioCodeView) window.FolioCodeView.findNext(); },
    findPrev: function (): void { if (window.FolioCodeView) window.FolioCodeView.findPrev(); },
    setSuppressActive: function (on: boolean): void { if (window.FolioCodeView) window.FolioCodeView.setSuppressActive(on); },
};

function makeSplitFinder(viewFinder: any): any {
    return {
        openFind: function (seed?: string): void {
            if (window.FolioEditor) window.FolioEditor.openFind(seed);
            if (typeof viewFinder.setSuppressActive === 'function') viewFinder.setSuppressActive(true);
            viewFinder.openFind(seed);
        },
        closeFind: function (): void {
            if (window.FolioEditor) window.FolioEditor.closeFind();
            if (typeof viewFinder.setSuppressActive === 'function') viewFinder.setSuppressActive(false);
            viewFinder.closeFind();
        },
        setFindTerm: function (term: string): void {
            if (window.FolioEditor) window.FolioEditor.setFindTerm(term);
            if (typeof viewFinder.setSuppressActive === 'function') viewFinder.setSuppressActive(true);
            viewFinder.setFindTerm(term);
        },
        setFindOptions: function (opts: any): void {
            if (window.FolioEditor) window.FolioEditor.setFindOptions(opts);
            viewFinder.setFindOptions(opts);
        },
        findNext: function (): void { if (window.FolioEditor) window.FolioEditor.findNext(); },
        findPrev: function (): void { if (window.FolioEditor) window.FolioEditor.findPrev(); },
    };
}

const SplitFinder = makeSplitFinder(ViewFinder);
const SplitHtmlFinder = makeSplitFinder(HtmlFinder);
const SplitCodeFinder = makeSplitFinder(CodeViewFinder);

function getFinder(): any {
    if (isEditMode()) return window.FolioEditor;
    if (isSplitMode()) {
        if (isHtmlPreviewMode()) return SplitHtmlFinder;
        return isTextKind() ? SplitCodeFinder : SplitFinder;
    }
    if (isHtmlPreviewMode()) return HtmlFinder;
    return isCodeViewMode() ? CodeViewFinder : ViewFinder;
}

function isOpen(): boolean { return bar.classList.contains('open'); }

function closeAllFinders(): void {
    if (window.FolioEditor) window.FolioEditor.closeFind();
    if (ViewFinder) ViewFinder.closeFind();
    if (HtmlFinder) HtmlFinder.closeFind();
    if (window.FolioCodeView) window.FolioCodeView.closeFind();
}

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
    if (!isSearchableKind()) return;
    if (isEditMode() || isSplitMode()) {
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
    closeAllFinders();
    if (isEditMode() && focusEditorDep) focusEditorDep();
}

export function openEditorFind(initialTerm?: string): void { open(initialTerm); }
export function closeEditorFind(): void { close(); }

export function setEditorFindTerm(term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean }): void {
    input.value = term || '';
    const opts = options || {};
    if (typeof opts.caseSensitive === 'boolean') caseChk.checked = opts.caseSensitive;
    if (typeof opts.wholeWord === 'boolean') wordChk.checked = opts.wholeWord;
    if (!isOpen()) {
        open(term || '');
    } else {
        const f = getFinder();
        if (f) {
            const patch: any = {};
            if (typeof opts.caseSensitive === 'boolean') patch.caseSensitive = opts.caseSensitive;
            if (typeof opts.wholeWord === 'boolean') patch.wholeWord = opts.wholeWord;
            if (Object.keys(patch).length > 0) f.setFindOptions(patch);
            f.setFindTerm(term || '');
        }
    }
}

function pickSeed(arg?: string): string {
    if (typeof arg === 'string' && arg) return arg;
    if (input.value) return input.value;
    return lastTermMemo;
}

function flushPendingInputTerm(): void {
    if (!inputDebounce) return;
    clearTimeout(inputDebounce);
    inputDebounce = null;
    const f = getFinder();
    if (f) f.setFindTerm(input.value);
}

export function findNext(lastTerm?: string): void {
    if (!isSearchableKind()) return;
    const seed = pickSeed(lastTerm);
    if (!bar.classList.contains('open')) { open(seed); return; }
    if (!input.value) {
        if (seed) { input.value = seed; const f0 = getFinder(); if (f0) f0.openFind(seed); }
        else { input.focus(); input.select(); return; }
    }
    flushPendingInputTerm();
    const f = getFinder(); if (f) f.findNext();
}

export function findPrev(lastTerm?: string): void {
    if (!isSearchableKind()) return;
    const seed = pickSeed(lastTerm);
    if (!bar.classList.contains('open')) { open(seed); return; }
    if (!input.value) {
        if (seed) { input.value = seed; const f0 = getFinder(); if (f0) f0.openFind(seed); }
        else { input.focus(); input.select(); return; }
    }
    flushPendingInputTerm();
    const f = getFinder(); if (f) f.findPrev();
}

// Wird nach Mode-Switch von setMode getriggert. Wenn die Find-Bar offen war,
// bleibt sie offen: alten Mode-Finder closen, neuen mit aktuellem Term
// (+ Optionen) starten. setTimeout(0), damit pending PostMessage-Events
// (z.B. loadEditorText beim Wechsel zu Edit) vor dem Re-Mount drankommen.
export function afterModeSwitch(): void {
    setTimeout(function () {
        if (bar.classList.contains('open')) {
            closeAllFinders();
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

export function afterDocumentSwitch(): void {
    setTimeout(function () {
        if (!bar) return;
        if (!bar.classList.contains('open')) return;
        if (!isSearchableKind()) {
            close();
            return;
        }
        const activeBefore = document.activeElement as HTMLElement | null;
        closeAllFinders();
        const f = getFinder();
        if (f) {
            f.setFindOptions({
                caseSensitive: caseChk.checked,
                wholeWord: wordChk.checked,
            });
            f.openFind(input.value);
        }
        if (activeBefore && activeBefore !== document.body
            && document.contains(activeBefore)
            && typeof activeBefore.focus === 'function') {
            activeBefore.focus();
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
            flushPendingInputTerm();
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
    // stopPropagation deckt Editor-, Code-View-, View- und Vault-Fokus ab.
    document.addEventListener('keydown', function (e: KeyboardEvent) {
        // Strg+Shift+F ist die Vault-Suche (vault/search.ts) — hier NICHT
        // abfangen, sonst öffnet sich die Editor-Find-Bar mit.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            e.stopPropagation();
            openEditorFind('');
        } else if (e.key === 'F3') {
            e.preventDefault();
            e.stopPropagation();
            if (isSearchableKind()) {
                if (e.shiftKey) findPrev(); else findNext();
            }
        }
    }, { capture: true });

    window.addEventListener('folio-find-shortcut', function (e: CustomEvent) {
        const command = e.detail && e.detail.command;
        if (command === 'open') {
            if (isSearchableKind()) openEditorFind('');
        } else if (command === 'next') {
            findNext();
        } else if (command === 'prev') {
            findPrev();
        }
    });

    window.addEventListener('folio-find-state', function (e: CustomEvent) {
        const s = e.detail || {};
        if (typeof s.term === 'string' && s.term.length > 0 && !input.value) {
            input.value = s.term;
            lastTermMemo = s.term;
        }
        if (isSplitMode() && s.source !== 'editor') return;
        if (!s.term && !input.value) { counter.textContent = ''; return; }
        const totalStr = (s.capped ? '5000+' : (typeof s.total === 'number' ? s.total : 0));
        if (typeof s.total !== 'number' || s.total === 0) {
            counter.textContent = (input.value || s.term) ? '0/0' : '';
        } else if (s.scanning || s.active < 0) {
            counter.textContent = '…/' + totalStr;
        } else {
            counter.textContent = (s.active + 1) + '/' + totalStr;
        }
    });
}
