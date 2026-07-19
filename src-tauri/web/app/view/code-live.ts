/* Live-Update der Code-View im Split-Mode (Nicht-MD-Text, nicht HTML).

   Muster wie view/preview.ts und view/html.ts::scheduleHtmlLiveUpdate:
   debounce 150 ms + Gen-Token + invalidate + KEIN isDirty-Gate +
   Scroll-Erhalt. Trigger: in-window CustomEvent
   `folio-editor-text-updated` (kein Tauri-IPC pro Tastendruck).

   Gating (debounced Live): body.split-mode + body.kind-text + kein
   html-preview-mode + getCurrentPath() + FolioCodeView.isMounted().
   HTML hat den eigenen Live-Pfad in html.ts.

   Mode-Switch-Flush (edit→view/split): gleiche Basis, aber Split ODER
   View (nicht edit-mode) — siehe flushCodeViewOnModeSwitch.

   Live-Tippen: setText(..., { autoFormat: false, preserveScroll: true }).
   runAutoFormat pro Tastendruck waere teuer und wuerde den Text unter
   dem User wegformatieren; der kanonische viewAutoFormat-Pfad greift
   weiterhin bei document:loaded/saved. */

type Deps = {
    getCurrentPath: () => string | null;
};

const CODE_LIVE_DEBOUNCE = 150;

let deps: Deps | null = null;
let codeLiveGen = 0;
let codeLiveTimer: number | null = null;

/** Gemeinsames Gate. requireSplit=true → nur split-mode (Live-Pfad);
 *  requireSplit=false → view oder split (nicht edit-mode, Mode-Switch). */
function gateCodeLive(requireSplit: boolean): boolean {
    if (!deps) return false;
    const b = document.body;
    if (requireSplit) {
        if (!b.classList.contains('split-mode')) return false;
    } else if (b.classList.contains('edit-mode')) {
        return false;
    }
    if (!b.classList.contains('kind-text')) return false;
    // HTML-Dokumente laufen ueber scheduleHtmlLiveUpdate, nicht hier.
    if (b.classList.contains('html-preview-mode')) return false;
    if (deps.getCurrentPath() == null) return false;
    const cv = window.FolioCodeView;
    if (!cv || typeof cv.isMounted !== 'function' || !cv.isMounted()) return false;
    return true;
}

/** Debounced Live-Pfad: nur im Split-Mode. */
function gateCodeSplitLive(): boolean {
    return gateCodeLive(true);
}

/** Mode-Switch edit→view/split: View oder Split, nicht Edit. */
function gateCodeViewOnModeSwitch(): boolean {
    return gateCodeLive(false);
}

function currentEditorText(): string | null {
    const ed: any = (window as any).FolioEditor;
    if (!ed) return null;
    if (typeof ed.hasEditor === 'function' && !ed.hasEditor()) return null;
    if (typeof ed.getText === 'function') return ed.getText();
    return null;
}

function applyCodeLiveText(text: string, requireSplit: boolean): void {
    if (!gateCodeLive(requireSplit)) return;
    const cv = window.FolioCodeView;
    if (!cv || typeof cv.setText !== 'function') return;

    // Sprache: leerer String → applyContent behaelt die Model-Sprache
    // vom Load (nicht neu klassifizieren).
    // autoFormat:false — siehe Modul-Kopfkommentar.
    // preserveScroll:true — applyContent scrollt sonst auf 0.
    cv.setText(text, '', { autoFormat: false, preserveScroll: true });
}

function cancelCodeLiveTimer(): void {
    if (codeLiveTimer != null) {
        window.clearTimeout(codeLiveTimer);
        codeLiveTimer = null;
    }
}

export function scheduleCodeLiveUpdate(text: string): void {
    if (!gateCodeSplitLive()) return;
    if (codeLiveTimer != null) {
        window.clearTimeout(codeLiveTimer);
    }
    // Generation beim Schedule capturen: invalidateCodeLive erhoeht
    // codeLiveGen und raeumt den Timer; falls der Callback dennoch
    // laeuft (oder ein stale Closure greift), verwerfen wir hier.
    const scheduledGen = codeLiveGen;
    codeLiveTimer = window.setTimeout(function () {
        codeLiveTimer = null;
        if (scheduledGen !== codeLiveGen) return;
        // Beim Timer-Fire den AKTUELLEN Editor-Stand holen statt den
        // beim Schedule-Aufruf closure-captured Text (analog preview.ts).
        const latest = currentEditorText();
        applyCodeLiveText(latest != null ? latest : text, true);
    }, CODE_LIVE_DEBOUNCE);
}

/** Sofort anwenden — Mode-Switch edit→view oder edit→split.
 *  Gate akzeptiert view oder split (nicht edit-mode); Live-Debounce
 *  bleibt split-only via gateCodeSplitLive. */
export function flushCodeViewOnModeSwitch(): void {
    cancelCodeLiveTimer();
    if (!gateCodeViewOnModeSwitch()) return;
    const text = currentEditorText();
    if (text == null) return;
    applyCodeLiveText(text, false);
}

/** Bei document:loaded/saved/closed — pending Live-Updates verwerfen. */
export function invalidateCodeLive(): void {
    codeLiveGen++;
    cancelCodeLiveTimer();
}

export function initCodeLiveUpdate(d: Deps): void {
    deps = d;
    window.addEventListener('folio-editor-text-updated', function (e: Event) {
        const detail = (e as CustomEvent).detail;
        const text = typeof detail === 'string' ? detail : String(detail || '');
        scheduleCodeLiveUpdate(text);
    });
}

/** Test-Hook: Gating-Logik ohne DOM-Event (vitest). */
export function gateCodeSplitLiveForTest(): boolean {
    return gateCodeSplitLive();
}

/** Test-Hook: Mode-Switch-Gate (view|split, nicht edit). */
export function gateCodeViewOnModeSwitchForTest(): boolean {
    return gateCodeViewOnModeSwitch();
}
