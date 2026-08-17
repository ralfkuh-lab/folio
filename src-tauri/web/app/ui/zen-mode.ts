/* Zen-Modus: CSS-Layer (body.zen-mode), kein persistierter UI-Zustand.
   Spec: docs/spec-zen-mode.md. Rails/Toolbar/Tabs/Statusleiste werden
   nur überdeckt; panel_state.json bleibt unangetastet. */

import { isBlockingModalOpen, isElementEffectivelyVisible, isPaletteOpen } from './command-palette';
import { t } from '../i18n/translate';
import { folioLog } from '../util/log';

const HINT_MS = 4000;
const ZEN_CLASS = 'zen-mode';

let zenOn = false;
let enteredFullscreenByZen = false;
let zenFullscreenSetting = true;
let hintSeenLocal = false;
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let hintEl: HTMLElement | null = null;
let escapeInstalled = false;
let settingsListenerInstalled = false;
/** Monotone Generation: nachlaufende async-Zweige brechen ab. */
let zenGen = 0;
/** Serialisiert toggleZenMode, damit !zenOn erst nach dem Vorgänger gelesen wird. */
let zenOpChain: Promise<void> = Promise.resolve();

function invokeFn(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke.bind(core) : null;
}

function isCurrent(gen: number): boolean {
    return gen === zenGen;
}

export function isZenMode(): boolean {
    return zenOn;
}

function visibleById(id: string): boolean {
    const el = document.getElementById(id);
    return !!el && isElementEffectivelyVisible(el);
}

function visibleQuery(selector: string): boolean {
    const el = document.querySelector(selector);
    return !!el && isElementEffectivelyVisible(el);
}

/** Offene, effektiv sichtbare Overlays — Zen ist der letzte Escape-Kandidat. */
export function hasPriorityEscapeTarget(): boolean {
    if (visibleQuery('#context-menu.open') || visibleQuery('#tab-ctx-menu.open')) {
        return true;
    }
    const findBar = document.getElementById('find-bar');
    if (findBar && findBar.classList.contains('open') && isElementEffectivelyVisible(findBar)) {
        return true;
    }
    const palette = document.getElementById('cmd-palette');
    let paletteOpen = false;
    try {
        paletteOpen = isPaletteOpen();
    } catch {
        /* Palette nicht initialisiert */
    }
    if (paletteOpen) {
        if (!palette || isElementEffectivelyVisible(palette)) return true;
    } else if (palette && isElementEffectivelyVisible(palette)) {
        return true;
    }
    if (isBlockingModalOpen()) {
        return true;
    }
    if (document.body.classList.contains('settings-open')) {
        const dlg = document.getElementById('settings-dialog');
        if (!dlg || isElementEffectivelyVisible(dlg)) return true;
    }
    if (document.body.classList.contains('theme-editor-open')) {
        const dlg = document.getElementById('theme-editor-dialog');
        if (!dlg || isElementEffectivelyVisible(dlg)) return true;
    }
    if (document.body.classList.contains('ai-diff-open')) {
        const region = document.getElementById('ai-diff-region');
        if (!region || isElementEffectivelyVisible(region)) return true;
    }
    if (document.body.classList.contains('git-diff-open')) {
        const region = document.getElementById('ai-diff-region');
        if (!region || isElementEffectivelyVisible(region)) return true;
    }
    if (visibleById('vault-filter')) return true;
    if (visibleById('lang-picker')) return true;
    if (visibleById('ai-actions-fav-menu')) return true;
    return false;
}

function applyBodyClass(on: boolean): void {
    document.body.classList.toggle(ZEN_CLASS, on);
}

function hideHint(): void {
    if (hintTimer !== null) {
        clearTimeout(hintTimer);
        hintTimer = null;
    }
    if (hintEl) hintEl.hidden = true;
}

function showExitHint(): void {
    if (!hintEl) hintEl = document.getElementById('zen-hint');
    if (!hintEl) return;
    hintEl.textContent = t('zen.hint.exit');
    hintEl.hidden = false;
    if (hintTimer !== null) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
        hintTimer = null;
        if (hintEl) hintEl.hidden = true;
    }, HINT_MS);
}

async function maybeShowFirstHint(gen: number): Promise<void> {
    if (hintSeenLocal) return;
    if (!isCurrent(gen)) return;
    const invoke = invokeFn();
    let seen = false;
    if (invoke) {
        try {
            seen = !!(await invoke('zen_hint_seen_get'));
        } catch (err) {
            folioLog.debug('zen', 'zen_hint_seen_get failed', { error: String(err) });
        }
    }
    if (!isCurrent(gen)) return;
    if (seen) {
        hintSeenLocal = true;
        return;
    }
    showExitHint();
    hintSeenLocal = true;
    if (invoke) {
        try {
            await invoke('set_zen_hint_seen', { seen: true });
        } catch (err) {
            folioLog.debug('zen', 'set_zen_hint_seen failed', { error: String(err) });
        }
    }
}

async function applyFullscreenOnEnter(gen: number): Promise<void> {
    if (!isCurrent(gen)) return;
    enteredFullscreenByZen = false;
    if (!zenFullscreenSetting) return;
    const invoke = invokeFn();
    if (!invoke) return;
    let already = false;
    try {
        already = !!(await invoke('get_fullscreen'));
    } catch (err) {
        folioLog.debug('zen', 'get_fullscreen failed', { error: String(err) });
        return;
    }
    if (!isCurrent(gen)) return;
    if (already) return;
    try {
        await invoke('set_fullscreen', { enabled: true });
    } catch (err) {
        folioLog.warn('zen', 'set_fullscreen on enter failed', { error: String(err) });
        return;
    }
    if (!isCurrent(gen)) {
        try {
            await invoke('set_fullscreen', { enabled: false });
        } catch (err) {
            folioLog.debug('zen', 'set_fullscreen revert after stale enter failed', {
                error: String(err),
            });
        }
        return;
    }
    enteredFullscreenByZen = true;
}

async function restoreFullscreenOnExit(gen: number): Promise<void> {
    if (!enteredFullscreenByZen) return;
    enteredFullscreenByZen = false;
    const invoke = invokeFn();
    if (!invoke) return;
    try {
        await invoke('set_fullscreen', { enabled: false });
    } catch (err) {
        folioLog.warn('zen', 'set_fullscreen on exit failed', { error: String(err) });
    }
    if (!isCurrent(gen)) return;
}

async function reportZenActive(active: boolean): Promise<void> {
    const invoke = invokeFn();
    if (!invoke) return;
    try {
        await invoke('set_zen_active', { active });
    } catch (err) {
        folioLog.debug('zen', 'set_zen_active failed', { error: String(err) });
    }
}

export async function setZenMode(on: boolean): Promise<void> {
    if (on === zenOn) return;
    const gen = ++zenGen;
    zenOn = on;
    applyBodyClass(on);
    await reportZenActive(on);
    if (!isCurrent(gen)) {
        await reportZenActive(zenOn);
        return;
    }
    if (on) {
        await applyFullscreenOnEnter(gen);
        if (!isCurrent(gen)) return;
        await maybeShowFirstHint(gen);
    } else {
        hideHint();
        await restoreFullscreenOnExit(gen);
    }
}

export function toggleZenMode(): Promise<void> {
    const run = zenOpChain.then(function () {
        return setZenMode(!zenOn);
    });
    zenOpChain = run.then(
        function () { return undefined; },
        function () { return undefined; },
    );
    return run;
}

export async function handleZenEscape(e: KeyboardEvent): Promise<boolean> {
    if (e.key !== 'Escape') return false;
    if (!zenOn) return false;
    if (hasPriorityEscapeTarget()) return false;
    e.preventDefault();
    e.stopPropagation();
    await setZenMode(false);
    return true;
}

function onDocumentKeydown(e: KeyboardEvent): void {
    void handleZenEscape(e);
}

function cacheZenFullscreenFromSettings(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const value = (raw as { zenFullscreen?: unknown }).zenFullscreen;
    if (typeof value === 'boolean') {
        zenFullscreenSetting = value;
    }
}

async function loadZenFullscreenSetting(): Promise<void> {
    const invoke = invokeFn();
    if (!invoke) return;
    try {
        const data = await invoke('settings_get');
        cacheZenFullscreenFromSettings(data);
    } catch (err) {
        folioLog.debug('zen', 'settings_get failed', { error: String(err) });
    }
}

function installSettingsListener(): void {
    if (settingsListenerInstalled) return;
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;
    settingsListenerInstalled = true;
    ev.listen('settings:changed', function (event: { payload?: { settings?: unknown } }) {
        const settings = event && event.payload && event.payload.settings;
        cacheZenFullscreenFromSettings(settings);
    });
}

/** Test-Reset: inkl. Einmal-Hinweis-Cache. Bricht nachlaufende async-Zweige ab. */
export function __resetZenForTests(): void {
    zenGen += 1;
    zenOpChain = Promise.resolve();
    hideHint();
    zenOn = false;
    applyBodyClass(false);
    enteredFullscreenByZen = false;
    hintSeenLocal = false;
    zenFullscreenSetting = true;
}

export async function resetZenForAutomation(): Promise<void> {
    zenGen += 1;
    zenOpChain = Promise.resolve();
    hideHint();
    zenOn = false;
    applyBodyClass(false);
    const ownedFullscreen = enteredFullscreenByZen;
    enteredFullscreenByZen = false;
    await reportZenActive(false);
    if (!ownedFullscreen) return;
    const invoke = invokeFn();
    if (!invoke) return;
    try {
        await invoke('set_fullscreen', { enabled: false });
    } catch (err) {
        folioLog.debug('zen', 'reset set_fullscreen failed', { error: String(err) });
    }
}

export async function initZenMode(): Promise<void> {
    hintEl = document.getElementById('zen-hint');
    if (!escapeInstalled) {
        escapeInstalled = true;
        // Capture: Overlays sind beim Check noch offen; Target-Handler
        // (Find-Bar, Palette, Dialoge) laufen danach und duerfen zuerst greifen.
        document.addEventListener('keydown', onDocumentKeydown, { capture: true });
    }
    installSettingsListener();
    await loadZenFullscreenSetting();
    (window as unknown as { __folioZenReset?: () => Promise<void> }).__folioZenReset =
        resetZenForAutomation;
}
