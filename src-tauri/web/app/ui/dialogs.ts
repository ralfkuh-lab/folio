// @ts-nocheck
/* Modale Dialoge: Rename-Modal und Unsaved-Changes-Modal. Beide
   Promise-basiert, mit eigener Event-Listener-Registrierung pro Aufruf
   (kein dauerhafter Wiring-State). DOM-Lookup ist lazy — die HTML-Shell
   muss zum Zeitpunkt des Aufrufs gemountet sein. */

function $(id: string): HTMLElement | null { return document.getElementById(id); }

// Rename-Modal: gibt einen neuen Dateinamen (ohne Pfad) zurück oder null
// bei Abbruch. Wird heute nicht aufgerufen — Rename geht ueber Inline-
// Editor im Vault-Tree und einen nativen Save-Dialog im Backend.
export function showRenameDialog(initialName: string, subtitle?: string): Promise<string | null> {
    return new Promise<string | null>(function (resolve) {
        const dialog = $('rename-dialog');
        const input = $('rename-input') as HTMLInputElement;
        const ok = $('rename-ok');
        const cancel = $('rename-cancel');
        const sub = $('rename-subtitle');
        if (!dialog || !input || !ok || !cancel) {
            resolve(null);
            return;
        }
        if (sub) sub.textContent = subtitle || 'Neuen Dateinamen eingeben:';
        input.value = initialName || '';
        dialog.hidden = false;
        // Selektion: Stamm vor der Endung markieren, damit Tippen den Namen
        // ersetzt aber die Endung erhaelt. Bei "notes.md" wird "notes" selektiert.
        const dot = input.value.lastIndexOf('.');
        input.focus();
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
        function done(result: string | null): void {
            dialog.hidden = true;
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKey);
            document.removeEventListener('keydown', onEsc);
            resolve(result);
        }
        function onOk(): void {
            const v = (input.value || '').trim();
            done(v.length ? v : null);
        }
        function onCancel(): void { done(null); }
        function onKey(e: KeyboardEvent): void {
            if (e.key === 'Enter') { e.preventDefault(); onOk(); }
        }
        function onEsc(e: KeyboardEvent): void {
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }
        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKey);
        document.addEventListener('keydown', onEsc);
    });
}

// Unsaved-Changes-Dialog: Promise resolves with 'save' | 'discard' | 'cancel'.
export function showUnsavedDialog(): Promise<'save' | 'discard' | 'cancel'> {
    const dialog = $('unsaved-dialog');
    if (!dialog) return Promise.resolve('cancel');
    dialog.hidden = false;
    return new Promise<'save' | 'discard' | 'cancel'>(function (resolve) {
        function done(decision: 'save' | 'discard' | 'cancel'): void {
            dialog.hidden = true;
            $('unsaved-save').removeEventListener('click', save);
            $('unsaved-discard').removeEventListener('click', discard);
            $('unsaved-cancel').removeEventListener('click', cancel);
            document.removeEventListener('keydown', onKey);
            resolve(decision);
        }
        function save(): void { done('save'); }
        function discard(): void { done('discard'); }
        function cancel(): void { done('cancel'); }
        function onKey(e: KeyboardEvent): void {
            if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        }
        $('unsaved-save').addEventListener('click', save);
        $('unsaved-discard').addEventListener('click', discard);
        $('unsaved-cancel').addEventListener('click', cancel);
        document.addEventListener('keydown', onKey);
        setTimeout(function () { const btn = $('unsaved-save'); if (btn) btn.focus(); }, 0);
    });
}
