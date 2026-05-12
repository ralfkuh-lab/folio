/* Rail-Visibility (Vault links / TOC rechts) + Width-Persistenz via
   CSS-Custom-Properties --vault-w / --toc-w. Splitter-Drag emittiert
   railResize zum Backend (workspace-persistierter Wert).

   Public API: setRailVisibility(side, visible), setTocWidth(w),
   setVaultWidth(w) — werden von Document-State und ApplyShellState
   gerufen. initRails() registriert die zwei Splitter-Drag-Listener. */

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

export function initRails(): void {
    initRightSplitter();
    initLeftSplitter();
}
