/* Rail-Visibility (Vault links / TOC rechts) + Width-Persistenz via
   CSS-Custom-Properties --vault-w / --toc-w. Splitter-Drag emittiert
   railResize zum Backend (workspace-persistierter Wert).

   Zusaetzlich der mittlere Split-Mode-Splitter zwischen Editor- und
   View-Pane: steuert --split-mid (Editor-Anteil in Prozent), Persistenz
   ueber das Panel-State-Command set_split_mid_percent (Muster wie der
   Minimap-Toggle).

   Public API: setRailVisibility(side, visible), setTocWidth(w),
   setVaultWidth(w), setSplitMidPercent(p), applySplitMidFromBackend(p)
   — werden von Document-State, ApplyShellState, Boot-Restore und dem
   panel:split_mid_changed-Listener gerufen. initRails() registriert
   die drei Splitter-Drag-Listener. */

import { safeInvoke } from '../util/log';

function post(msg: any): void {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('shell:event', msg);
    }
}

export function setRailVisibility(side: 'left' | 'right', visible: boolean): void {
    if (side === 'right') {
        document.body.classList.toggle('toc-hidden', !visible);
    } else if (side === 'left') {
        document.body.classList.toggle('vault-hidden', !visible);
    }
}

export function setTocWidth(w: number): void {
    if (typeof w !== 'number' || isNaN(w) || w <= 0) return;
    document.documentElement.style.setProperty('--toc-w', w + 'px');
}

export function setVaultWidth(w: number): void {
    if (typeof w !== 'number' || isNaN(w) || w <= 0) return;
    document.documentElement.style.setProperty('--vault-w', w + 'px');
}

const SPLIT_MID_MIN = 20;
const SPLIT_MID_MAX = 80;

let midDragActive = false;

/* Backend-Sync-Pfad (panel:split_mid_changed + Boot-Restore): waehrend
   eines aktiven Drags ignorieren — ein verspaetet eintreffendes Event aus
   einem frueheren Drag wuerde sonst den Live-Wert ueberschreiben, und
   pointerup persistierte den veralteten Stand. */
export function applySplitMidFromBackend(p: number): void {
    if (midDragActive) return;
    setSplitMidPercent(p);
}

export function setSplitMidPercent(p: number): void {
    if (typeof p !== 'number' || isNaN(p)) return;
    const clamped = Math.max(SPLIT_MID_MIN, Math.min(SPLIT_MID_MAX, p));
    document.documentElement.style.setProperty('--split-mid', clamped + '%');
}

function initRightSplitter(): void {
    const splitter = document.getElementById('splitter-right');
    if (!splitter) return;
    let dragState: { startX: number; startW: number } | null = null;
    function currentTocWidth(): number {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--toc-w').trim();
        const n = parseFloat(v);
        return isNaN(n) ? 260 : n;
    }
    splitter.addEventListener('pointerdown', function (e: PointerEvent) {
        try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
        dragState = { startX: e.clientX, startW: currentTocWidth() };
        e.preventDefault();
    });
    splitter.addEventListener('pointermove', function (e: PointerEvent) {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        // Splitter sitzt links von der TOC; nach rechts ziehen verkleinert TOC.
        const maxW = Math.max(150, window.innerWidth - 320 - 8);
        const newW = Math.max(150, Math.min(maxW, dragState.startW - dx));
        document.documentElement.style.setProperty('--toc-w', newW + 'px');
    });
    function endDrag(e: PointerEvent): void {
        if (!dragState) return;
        try { splitter.releasePointerCapture(e.pointerId); } catch (_) {}
        dragState = null;
        post({ type: 'railResize', side: 'right', width: currentTocWidth() });
    }
    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
}

function initLeftSplitter(): void {
    const splitter = document.getElementById('splitter-left');
    if (!splitter) return;
    let dragState: { startX: number; startW: number } | null = null;
    function currentVaultWidth(): number {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--vault-w').trim();
        const n = parseFloat(v);
        return isNaN(n) ? 240 : n;
    }
    splitter.addEventListener('pointerdown', function (e: PointerEvent) {
        try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
        dragState = { startX: e.clientX, startW: currentVaultWidth() };
        e.preventDefault();
    });
    splitter.addEventListener('pointermove', function (e: PointerEvent) {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        // Splitter sitzt rechts vom Vault; nach rechts ziehen vergroessert Vault.
        const maxW = Math.max(150, window.innerWidth - 320 - 8);
        const newW = Math.max(150, Math.min(maxW, dragState.startW + dx));
        document.documentElement.style.setProperty('--vault-w', newW + 'px');
    });
    function endDrag(e: PointerEvent): void {
        if (!dragState) return;
        try { splitter.releasePointerCapture(e.pointerId); } catch (_) {}
        dragState = null;
        post({ type: 'railResize', side: 'left', width: currentVaultWidth() });
    }
    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
}

function initMidSplitter(): void {
    const splitter = document.getElementById('splitter-mid');
    const content = document.getElementById('content-region');
    if (!splitter || !content) return;
    let dragState: { startX: number; startPct: number; width: number } | null = null;
    function currentSplitMid(): number {
        // Inline-Style ist autoritativ — setSplitMidPercent schreibt immer
        // dorthin (Boot-Restore + Live-Drag). Kein getComputedStyle-
        // Roundtrip noetig (und in jsdom liefert der keine Custom-Props).
        const v = document.documentElement.style.getPropertyValue('--split-mid').trim();
        const n = parseFloat(v);
        return isNaN(n) ? 50 : n;
    }
    splitter.addEventListener('pointerdown', function (e: PointerEvent) {
        try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
        const width = (content as HTMLElement).clientWidth;
        dragState = { startX: e.clientX, startPct: currentSplitMid(), width };
        midDragActive = true;
        e.preventDefault();
    });
    splitter.addEventListener('pointermove', function (e: PointerEvent) {
        if (!dragState || dragState.width <= 0) return;
        // --split-mid ist der Editor-Anteil; der Editor liegt physisch
        // LINKS (row-reverse ordnet nur die DOM-Kinder um, nicht die
        // Pixel-Koordinaten). Splitter nach rechts ziehen (dx > 0)
        // vergroessert die linke Editor-Pane → Prozent steigt. Vorzeichen
        // daher positiv, trotz row-reverse.
        const dx = e.clientX - dragState.startX;
        const pct = dragState.startPct + (dx / dragState.width) * 100;
        setSplitMidPercent(pct);
    });
    function endDrag(e: PointerEvent): void {
        if (!dragState) return;
        try { splitter.releasePointerCapture(e.pointerId); } catch (_) {}
        dragState = null;
        midDragActive = false;
        safeInvoke('set_split_mid_percent', { percent: currentSplitMid() }, 'set_split_mid_percent');
    }
    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
}

export function initRails(): void {
    initRightSplitter();
    initLeftSplitter();
    initMidSplitter();
}
