/* About-Dialog: ersetzt den vormaligen `alert('folio v…')`-Stub aus
   menu-router.ts. Hoert direkt auf `menu:about` (vom HELP_ABOUT-Branch
   in `src-tauri/src/menu/events.rs`); Payload enthaelt version, gitHash
   und buildDate (aus build.rs als compile-time env). */

type AboutPayload = {
    version?: string;
    gitHash?: string;
    buildDate?: string;
};

let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function setField(id: string, value: string | undefined): void {
    const el = $(id);
    if (!el) return;
    el.textContent = value && value.length > 0 ? value : '—';
}

export function openAboutDialog(payload: AboutPayload): void {
    const dlg = $('about-dialog');
    if (!dlg) return;
    setField('about-version', payload.version);
    setField('about-build', payload.buildDate);
    setField('about-commit', payload.gitHash);
    dlg.hidden = false;
    keydownHandler = function (e: KeyboardEvent) {
        if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault();
            closeAboutDialog();
        }
    };
    document.addEventListener('keydown', keydownHandler);
    setTimeout(function () {
        const btn = $('about-close') as HTMLButtonElement | null;
        if (btn) btn.focus();
    }, 0);
}

export function closeAboutDialog(): void {
    const dlg = $('about-dialog');
    if (dlg) dlg.hidden = true;
    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
    }
}

export function initAboutDialog(): void {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;
    ev.listen('menu:about', function (event: any) {
        const payload = (event && event.payload) || {};
        openAboutDialog(payload);
    });
    const closeBtn = $('about-close');
    if (closeBtn) closeBtn.addEventListener('click', closeAboutDialog);
    // Klick auf den dunklen Overlay-Bereich (ausserhalb des Panels)
    // schliesst ebenfalls — wie beim Export-Dialog.
    const dlg = $('about-dialog');
    if (dlg) {
        dlg.addEventListener('click', function (e) {
            if (e.target === dlg) closeAboutDialog();
        });
    }
}
