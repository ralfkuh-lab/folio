/* Automation-API-Bridge fuer das Frontend. Drei Listener: `automation:click`
   (DOM-Lookup nach id / data-name / CSS-Selektor, dann `.click()`),
   `automation:set_editor_text` (Editor-Text setzen + Dirty/Wordcount
   nachziehen), `automation:open_document` (Document-Open mit Frontend-
   Prompt-Pfad).

   Selektor-Fallback-Reihenfolge in `automation:click` ist Teil des
   Automation-Vertrags — siehe `docs/frontend-globals.md` Abschnitt 4. */

import {
    getCleanText,
    getCurrentPath,
    markDirty,
    openDocument,
    updateWordCount,
} from '../state/document';
import { loadEditorText } from '../editor/shell';

export function initAutomationEvents(): void {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!ev || typeof ev.listen !== 'function' || !core) return;
    const invoke = core.invoke;

    ev.listen('automation:click', function (event: any) {
        var name = event && event.payload && event.payload.name;
        if (!name) return;
        var el: HTMLElement | null = document.getElementById(name);
        if (!el) {
            try { el = document.querySelector('[data-name="' + CSS.escape(name) + '"]'); } catch (_) {}
        }
        if (!el) {
            try { el = document.querySelector(name); } catch (_) {}
        }
        if (el && typeof (el as HTMLElement).click === 'function') (el as HTMLElement).click();
    });
    ev.listen('automation:set_editor_text', function (event: any) {
        var data = event && event.payload || {};
        var text = data.text || '';
        loadEditorText(text);
        updateWordCount(text);
        // currentPath/cleanText leben seit Phase-4-Extract in state/document.ts;
        // hier nicht mehr im Scope. Ueber die Getter holen, sonst
        // ReferenceError beim ersten automation:set_editor_text.
        if (getCurrentPath()) markDirty(text !== getCleanText());
    });
    ev.listen('automation:open_document', function (event: any) {
        var data = event && event.payload || {};
        if (data.path) openDocument(data.path);
    });

    // Editor-Text-Tracking fuer Wordcount im Edit-Modus. CustomEvent wird
    // von editor.ts bei jeder Text-Aenderung dispatched (nicht nur durch
    // Automation, aber gleicher Code-Pfad: Wordcount + Dirty + IPC-Sync).
    window.addEventListener('folio-editor-text-updated', function (e: Event) {
        var text = (e as CustomEvent).detail || '';
        updateWordCount(text);
        if (getCurrentPath()) markDirty(text !== getCleanText());
        invoke('editor_text_changed', { text: text }).catch(function(){});
    });
}
