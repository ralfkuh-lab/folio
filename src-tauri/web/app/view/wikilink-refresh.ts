/* Re-Render nach Wikilink-Suchraum-/Index-Wechsel (Spec W8).

   Zwei Backend-Events, ein Verhalten — deshalb ein gemeinsamer Handler
   statt zwei Kopien im Bootstrap:

   - `wikilink:roots_changed`: eine Opt-in-Wurzel wurde ein-/ausgeschaltet.
     Der Suchraum hat sich geaendert, aber es laeuft noch KEIN Build — den
     startet erst der `get()` des hier ausgeloesten Renders.
   - `wikilink:index_ready`: ein Hintergrund-Build ist beendet (veroeffentlicht
     ODER verworfen). Der Index-Zustand hat sich geaendert, die sichtbare View
     muss nachziehen; bei einem verworfenen Build ist dieser Re-Render
     zugleich der Wiederanlauf, weil sein `get()` den Build mit dem aktuellen
     Suchraum neu anstoesst.

   Bewusst KEIN Re-Emit von `document:loaded` (Scroll- und Seiteneffekte):
   `flushPreviewRender` ist der scroll-erhaltende Live-Render-Pfad und traegt
   den `renderGen`-Stale-Guard selbst; der Backlinks-Refresh ist debounced und
   generation-geschuetzt. Ist keine Markdown-View sichtbar (Edit-Mode,
   Nicht-Markdown-Dokument), sind beide Aufrufe No-ops. */

import { folioLog } from '../util/log';
import { refreshBacklinksAfterIndexReady } from './backlinks';
import { flushPreviewRender } from './preview';

/** Event-Namen sind Integrationsvertrag (docs/automation-contract.md). */
export const WIKILINK_REFRESH_EVENTS = [
    'wikilink:index_ready',
    'wikilink:roots_changed',
] as const;

let wired = false;

/** Sichtbare View + Backlinks neu ziehen. Exportiert für Tests. */
export function refreshAfterWikilinkChange(): void {
    void flushPreviewRender();
    refreshBacklinksAfterIndexReady();
}

export function initWikilinkRefresh(): void {
    if (wired) return;
    wired = true;
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;
    for (const name of WIKILINK_REFRESH_EVENTS) {
        void ev.listen(name, function () {
            folioLog.debug('wikilink', 'refresh after index change', { event: name });
            refreshAfterWikilinkChange();
        });
    }
}

/** Test-Hook: Wiring-Flag zurücksetzen (jsdom bindet ein neues DOM). */
export function __resetWikilinkRefreshForTests(): void {
    wired = false;
}
