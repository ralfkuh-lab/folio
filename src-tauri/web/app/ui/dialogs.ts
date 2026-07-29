/* Modale Dialoge: Rename-Modal und Unsaved-Changes-Modal. Beide
   Promise-basiert, mit eigener Event-Listener-Registrierung pro Aufruf
   (kein dauerhafter Wiring-State). DOM-Lookup ist lazy — die HTML-Shell
   muss zum Zeitpunkt des Aufrufs gemountet sein. */

import { t } from '../i18n/translate';
import { isInvalidFileName, joinDirFile } from '../util/filename';
import { folioLog } from '../util/log';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function invokeCommand(): ((cmd: string, args?: any) => Promise<any>) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

// Rename-Modal: gibt einen neuen Dateinamen (ohne Pfad) zurück oder null
// bei Abbruch. Wird heute nicht aufgerufen — Rename geht ueber Inline-
// Editor im Vault-Tree und einen nativen Save-Dialog im Backend.
export function showRenameDialog(
    initialName: string,
    subtitle?: string,
    options?: { title?: string; okLabel?: string },
): Promise<string | null> {
    return new Promise<string | null>(function (resolve) {
        const dialog = $('rename-dialog');
        const input = $('rename-input') as HTMLInputElement;
        const ok = $('rename-ok');
        const cancel = $('rename-cancel');
        const sub = $('rename-subtitle');
        const title = $('rename-title');
        if (!dialog || !input || !ok || !cancel) {
            resolve(null);
            return;
        }
        // Titel/Button pro Aufruf setzen (Dialog wird zwischen Umbenennen und
        // „Neue Datei" geteilt) — ohne Angabe zurueck auf die Rename-Defaults.
        if (title) title.textContent = options?.title || 'Umbenennen';
        ok.textContent = options?.okLabel || 'Umbenennen';
        if (sub) sub.textContent = subtitle || 'Neuen Dateinamen eingeben:';
        input.value = initialName || '';
        const errEl = $('rename-error');
        if (errEl) {
            errEl.textContent = '';
            errEl.setAttribute('hidden', '');
        }
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

/**
 * „Notiz anlegen?"-Dialog fuer missing Wikilinks (`folio-new:`).
 * Nutzt dasselbe DOM wie showRenameDialog (+ optionales #rename-error).
 * OK → create_file; bei Fehler bleibt der Dialog offen und zeigt den
 * Fehlertext. Resolve: erstellter Pfad oder null (Abbruch).
 */
export function showCreateNoteDialog(opts: {
    initialName: string;
    targetDir: string;
}): Promise<string | null> {
    return new Promise<string | null>(function (resolve) {
        const dialog = $('rename-dialog');
        const input = $('rename-input') as HTMLInputElement | null;
        const ok = $('rename-ok');
        const cancel = $('rename-cancel');
        const sub = $('rename-subtitle');
        const title = $('rename-title');
        const errEl = $('rename-error');
        if (!dialog || !input || !ok || !cancel) {
            resolve(null);
            return;
        }

        let busy = false;

        function setError(msg: string): void {
            if (!errEl) return;
            errEl.textContent = msg || '';
            if (msg) errEl.removeAttribute('hidden');
            else errEl.setAttribute('hidden', '');
        }

        if (title) title.textContent = t('wikilinks.createDialog.title');
        ok.textContent = t('wikilinks.createDialog.submit.action');
        if (sub) {
            sub.textContent = opts.targetDir
                ? t('wikilinks.createDialog.subtitle', { dir: opts.targetDir })
                : t('wikilinks.createDialog.noDocument');
        }
        input.value = opts.initialName || 'untitled.md';
        setError('');
        dialog.hidden = false;
        const dot = input.value.lastIndexOf('.');
        input.focus();
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();

        function done(result: string | null): void {
            dialog.hidden = true;
            setError('');
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKey);
            document.removeEventListener('keydown', onEsc);
            resolve(result);
        }

        function onCancel(): void {
            if (busy) return;
            done(null);
        }

        function onOk(): void {
            if (busy) return;
            const name = (input.value || '').trim();
            if (isInvalidFileName(name)) {
                setError(t('errors.file.invalidName'));
                return;
            }
            if (!opts.targetDir) {
                setError(t('wikilinks.createDialog.noDocument'));
                return;
            }
            const path = joinDirFile(opts.targetDir, name);
            const invoke = invokeCommand();
            if (!invoke) {
                setError(t('errors.file.createFailed', { detail: 'no invoke' }));
                return;
            }
            busy = true;
            ok.setAttribute('disabled', '');
            invoke('create_file', { path }).then(
                function (created: string) {
                    busy = false;
                    ok.removeAttribute('disabled');
                    done(typeof created === 'string' && created ? created : path);
                },
                function (err: unknown) {
                    busy = false;
                    ok.removeAttribute('disabled');
                    const msg = typeof err === 'string' ? err : String(err || '');
                    setError(msg || t('errors.file.createFailed', { detail: '' }));
                    folioLog.warn('wikilink', 'create_file failed', { path, error: msg });
                    input.focus();
                },
            );
        }

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

// Generische Bestätigung: resolves true = OK, false = Abbrechen.
// Default-Fokus auf "Abbrechen" (destruktive Aktionen nie per Enter).
export function showConfirmDialog(
    message: string,
    options?: { title?: string; okLabel?: string },
): Promise<boolean> {
    return new Promise<boolean>(function (resolve) {
        const dialog = $('confirm-dialog');
        const ok = $('confirm-ok');
        const cancel = $('confirm-cancel');
        const text = $('confirm-text');
        const title = $('confirm-title');
        if (!dialog || !ok || !cancel || !text) {
            resolve(false);
            return;
        }
        if (title) title.textContent = options?.title || t('dialogs.confirm.title');
        ok.textContent = options?.okLabel || 'OK';
        text.textContent = message;
        dialog.hidden = false;
        function done(result: boolean): void {
            dialog.hidden = true;
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        }
        function onOk(): void { done(true); }
        function onCancel(): void { done(false); }
        function onKey(e: KeyboardEvent): void {
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }
        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
        setTimeout(function () { if (cancel) cancel.focus(); }, 0);
    });
}

// Ausführen-Bestätigung: resolves true = ausführen, false = abbrechen.
// Default-Fokus liegt bewusst auf "Abbrechen" (kein versehentliches
// Ausführen per Enter).
export function confirmRunFile(name: string): Promise<boolean> {
    return new Promise<boolean>(function (resolve) {
        const dialog = $('run-confirm-dialog');
        const ok = $('run-confirm-ok');
        const cancel = $('run-confirm-cancel');
        const text = $('run-confirm-text');
        if (!dialog || !ok || !cancel) { resolve(false); return; }
        // textContent only — t() never into innerHTML (i18n Spec).
        if (text) text.textContent = t('dialogs.run.confirm', { name });
        dialog.hidden = false;
        function done(result: boolean): void {
            dialog.hidden = true;
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        }
        function onOk(): void { done(true); }
        function onCancel(): void { done(false); }
        function onKey(e: KeyboardEvent): void {
            if (e.key === 'Escape') { e.preventDefault(); done(false); }
        }
        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
        setTimeout(function () { cancel.focus(); }, 0);
    });
}

