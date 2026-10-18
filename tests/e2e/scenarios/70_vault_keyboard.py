"""E2E: Tastaturbedienung im Vault-Baum (Spec docs/spec-vault-keyboard.md).

K1 — Fokus und Navigation, mit echten Tasten über xdotool (die
synthetischen `/key`-Events erreichen weder den DOM-Capture-Block noch
`:focus-visible`):

  1. ARIA-Tree: `role="tree"`, treeitems mit `aria-level`/`aria-expanded`,
     genau ein `tabindex="0"`.
  2. Strg+Umschalt+E bei zugeklappter Rail und zugeklapptem Ordner: Rail
     geht auf, der Pfad zum aktiven Dokument wird aufgeklappt, der Fokus
     steht auf dem Dokument.
  3. Pfeiltasten, Pos1/Ende, Type-ahead; → klappt einen Ordner lazy auf,
     das zweite → geht ins erste Kind; ← zum Eltern bzw. zuklappen.
  4. Enter öffnet die Datei im aktiven Tab, der Fokus bleibt im Baum.
  5. Ein `vault:refresh`-Rebuild hält den Fokus auf derselben Zeile.
  6. Escape gibt den Fokus ab; im Zen-Modus ist Strg+Umschalt+E wirkungslos;
     die Command Palette bietet „Vault fokussieren“ an.
  7. Fokusring sichtbar (Screenshot hell/dunkel).

K2/K3 — Datei-Aktionen und Kontextmenü per Tastatur:

  8. Umschalt+F10 öffnet das Kontextmenü mit Fokus auf dem ersten Eintrag,
     ↓ überspringt Trenner, Escape gibt den Fokus an die Zeile zurück
     (Screenshot hell/dunkel).
  9. Strg+D dupliziert, Fokus auf der Kopie; Entf mit Bestätigung löscht,
     Fokus auf dem nächsten Nachbarn.
 10. Strg+X / Strg+V verschiebt in einen Ordner, Fokus auf dem Ziel.
 11. F2 benennt inline um; der Tab-Pfad wandert mit, Fokus auf dem
     umbenannten Eintrag.

Feste Fixture unter /tmp (nicht mkdtemp): der Pfad steht im Vault-Baum und
in der Statusleiste und ist damit Teil der Visual-Baseline — gleiche
Begründung wie bei 56/57/59/67.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

ROOT_DIR = Path("/tmp/folio-e2e-vaultkb")

FOCUSED_JS = """
(() => {
    const a = document.activeElement;
    if (!a || !a.matches || !a.matches('#vault-tree li.node, #vault-tree li.section')) {
        return a ? ('outside:' + a.tagName + '#' + (a.id || '')) : 'outside:null';
    }
    return a.getAttribute('data-path') || ('section:' + a.getAttribute('data-section'));
})()
"""

ARIA_JS = """
(() => {
    const tree = document.getElementById('vault-tree');
    const items = [...tree.querySelectorAll('li.node, li.section')];
    return {
        role: tree.getAttribute('role'),
        label: tree.getAttribute('aria-label'),
        tabbable: tree.querySelectorAll('[tabindex="0"]').length,
        nonItem: items.filter((li) => li.getAttribute('role') !== 'treeitem').length,
        dirs: [...tree.querySelectorAll('li.node[data-kind="dir"]')].map((li) => ({
            path: li.getAttribute('data-path'),
            expanded: li.getAttribute('aria-expanded'),
            level: li.getAttribute('aria-level'),
        })),
    };
})()
"""

MENU_JS = """
(() => {
    const m = document.getElementById('context-menu');
    const a = document.activeElement;
    return {
        open: m.classList.contains('open'),
        role: m.getAttribute('role'),
        nonMenuitem: m.querySelectorAll('.ctx-item:not([role="menuitem"])').length,
        active: a && m.contains(a) ? a.getAttribute('data-act') : null,
    };
})()
"""

RING_JS = """
(() => {
    const a = document.activeElement;
    const row = a && a.querySelector(':scope > .row');
    if (!row) return null;
    const s = getComputedStyle(row);
    return { visible: a.matches(':focus-visible'), style: s.outlineStyle, width: s.outlineWidth };
})()
"""


def _norm(path) -> str:
    return str(path).replace("\\", "/")


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    response = ctx.api.eval(js, timeout_ms=timeout_ms)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


def _poll(fn, timeout: float = 5.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _xdotool(*args: str) -> bool:
    try:
        subprocess.run(["xdotool", *args], check=True, capture_output=True, timeout=5)
        return True
    except (subprocess.SubprocessError, OSError):
        return False


def _focus_app_window() -> bool:
    for query in (["--class", "folio"], ["--name", "Folio"], ["--name", "."]):
        try:
            out = subprocess.run(
                ["xdotool", "search", "--onlyvisible", *query],
                check=True, capture_output=True, text=True, timeout=5,
            ).stdout.split()
        except (subprocess.SubprocessError, OSError):
            continue
        if out:
            return _xdotool("windowfocus", "--sync", out[-1])
    return False


def _key(*keys: str) -> None:
    for k in keys:
        _xdotool("key", "--clearmodifiers", k)
        time.sleep(0.08)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _setup_fixture() -> Path:
    shutil.rmtree(ROOT_DIR, ignore_errors=True)
    projekt = ROOT_DIR / "projekt"
    _write(projekt / "alpha.md", "# Alpha\n\nErste Notiz.\n")
    _write(projekt / "ordner" / "beta.md", "# Beta\n\nIm Ordner.\n")
    _write(projekt / "ordner" / "gamma.md", "# Gamma\n\nAuch im Ordner.\n")
    _write(projekt / "zeta.md", "# Zeta\n\nLetzte Notiz.\n")
    return projekt


def _focused(ctx) -> str:
    return _evalv(ctx, FOCUSED_JS)


def _wait_focus(ctx, want: str, label: str, timeout: float = 5.0) -> None:
    got = _poll(lambda: _focused(ctx) == want, timeout=timeout)
    ctx.expect(bool(got), f"[{label}] Fokus erwartet auf {want}, ist {_focused(ctx)!r}")


def _node_exists(ctx, path: str) -> bool:
    sel = json.dumps(f'#vault-tree li.section[data-section="pinned"] li.node[data-path="{path}"]')
    return _evalv(ctx, f"!!document.querySelector({sel})") is True


def _expanded(ctx, path: str) -> bool:
    sel = json.dumps(f'#vault-tree li.section[data-section="pinned"] li.node[data-path="{path}"]')
    return _evalv(
        ctx, f"(function(){{var n=document.querySelector({sel});"
        "return !!n && n.getAttribute('aria-expanded')==='true';})()",
    ) is True


def _active_tab_path(ctx) -> str:
    data = ctx.api.tabs()
    for t in (data.get("tabs") or []):
        if t.get("active"):
            return _norm(t.get("path") or "")
    return ""


def run(ctx):
    projekt = _setup_fixture()
    pin = _norm(projekt)
    ordner = f"{pin}/ordner"
    alpha, beta, gamma, zeta = (f"{pin}/alpha.md", f"{ordner}/beta.md",
                                f"{ordner}/gamma.md", f"{pin}/zeta.md")
    try:
        with ctx.step("Vorbereiten: Fixture pinnen, beta.md öffnen, Ordner zu"):
            ctx.expect(bool(shutil.which("xdotool")) and bool(os.environ.get("DISPLAY")),
                       "xdotool/DISPLAY fehlt — echte Tasten nötig")
            ctx.api.settings_set({"zenFullscreen": False})
            ctx.api.tabs_close_all()
            ctx.api.mode("view")
            ctx.api.workspace_pin(str(projekt), is_directory=True)
            ctx.expect(bool(_poll(lambda: _node_exists(ctx, pin))), "Pin erschien nicht")
            ctx.api.open(beta)
            ctx.api.mode("view")
            ctx.api.click("#vault-collapse-all")
            ctx.expect(bool(_poll(lambda: not _node_exists(ctx, beta))),
                       "Ordner nach „Alles einklappen“ noch offen")
            ctx.expect(_focus_app_window(), "Folio-Fenster nicht per xdotool fokussierbar")

        with ctx.step("ARIA-Tree: role, Label, genau ein tabindex=0"):
            aria = _evalv(ctx, ARIA_JS)
            ctx.expect(aria["role"] == "tree", f"#vault-tree ohne role=tree: {aria!r}")
            ctx.expect(bool(aria["label"]), f"#vault-tree ohne aria-label: {aria!r}")
            ctx.expect(aria["tabbable"] == 1, f"nicht genau ein tabindex=0: {aria!r}")
            ctx.expect(aria["nonItem"] == 0, f"Zeilen ohne role=treeitem: {aria!r}")
            root = next((d for d in aria["dirs"] if d["path"] == pin), None)
            ctx.expect(root is not None and root["expanded"] == "false" and root["level"] == "2",
                       f"Pin-Wurzel ohne aria-expanded=false/aria-level=2: {aria!r}")

        with ctx.step("Strg+Umschalt+E bei zugeklappter Rail: Rail auf, Pfad auf, Fokus auf beta.md"):
            ctx.api.rail("left", False)
            ctx.expect(bool(_poll(lambda: _evalv(
                ctx, "document.body.classList.contains('vault-hidden')") is True)),
                "Rail ging nicht zu")
            _key("ctrl+shift+e")
            _wait_focus(ctx, beta, "Strg+Umschalt+E")
            ctx.expect(_evalv(ctx, "document.body.classList.contains('vault-hidden')") is False,
                       "Vault-Rail wurde nicht eingeblendet")
            ctx.expect(_expanded(ctx, ordner), "Ordner zum aktiven Dokument nicht aufgeklappt")

        with ctx.step("Pfeiltasten, Pos1/Ende, Type-ahead"):
            _key("Down")
            _wait_focus(ctx, gamma, "↓")
            _key("Up")
            _wait_focus(ctx, beta, "↑")
            _key("Home")
            _wait_focus(ctx, "section:pinned", "Pos1")
            _key("End")
            last = _focused(ctx)
            ctx.expect(last.startswith("section:") or last.startswith("/"),
                       f"Ende landete nicht im Baum: {last!r}")
            _key("Home", "z")
            _wait_focus(ctx, zeta, "Type-ahead z")

        with ctx.step("Enter öffnet die Datei, Fokus bleibt im Baum"):
            _key("Return")
            ctx.expect(bool(_poll(lambda: _active_tab_path(ctx) == zeta)),
                       f"Enter öffnete zeta.md nicht: {_active_tab_path(ctx)!r}")
            time.sleep(0.3)
            _wait_focus(ctx, zeta, "nach Enter")

        with ctx.step("←/→: zuklappen, Lazy-Expand, erstes Kind, Eltern"):
            # Ordner vor Dateien: ordner (beta, gamma), alpha.md, zeta.md
            for want in (alpha, gamma, beta, ordner):
                _key("Up")
                _wait_focus(ctx, want, "↑ nach oben")
            _key("Left")
            ctx.expect(bool(_poll(lambda: not _expanded(ctx, ordner))), "← klappte nicht zu")
            _wait_focus(ctx, ordner, "← bleibt auf ordner")
            _key("Right")
            ctx.expect(bool(_poll(lambda: _node_exists(ctx, beta))),
                       "→ lud die Kinder nicht (Lazy-Expand)")
            _wait_focus(ctx, ordner, "→ bleibt auf ordner")
            _key("Right")
            _wait_focus(ctx, beta, "zweites → erstes Kind")
            _key("Left")
            _wait_focus(ctx, ordner, "← zum Eltern")
            _key("Down", "Down")
            _wait_focus(ctx, gamma, "↓↓ auf gamma")

        with ctx.step("vault:refresh-Rebuild hält den Fokus"):
            # clear_recents emittiert vault:refresh → kompletter Neuaufbau
            # (setVaultRecent + refreshVault ersetzen das DOM).
            marker = _evalv(ctx, "(function(){var n=document.activeElement;"
                                 "n.__vkbOld=true;return true;})()")
            ctx.expect(marker is True, "Marker ließ sich nicht setzen")
            ctx.api.workspace_clear_recents()
            ctx.expect(bool(_poll(lambda: _evalv(
                ctx, "!(document.activeElement&&document.activeElement.__vkbOld)") is True)),
                "Baum wurde nicht neu aufgebaut")
            _wait_focus(ctx, gamma, "nach Rebuild")
            aria = _evalv(ctx, ARIA_JS)
            ctx.expect(aria["tabbable"] == 1, f"nach Rebuild nicht genau ein tabindex=0: {aria!r}")

        with ctx.step("Fokusring sichtbar (Screenshot hell/dunkel)"):
            ring = _evalv(ctx, RING_JS)
            ctx.expect(bool(ring) and ring["visible"] and ring["style"] == "solid",
                       f"kein sichtbarer Fokusring: {ring!r}")
            ctx.api.theme("light")
            ctx.screenshot("vault_keyboard_focus_light")
            ctx.api.theme("dark")
            _wait_focus(ctx, gamma, "nach Theme-Wechsel")
            ctx.screenshot("vault_keyboard_focus_dark")
            ctx.api.theme("light")

        with ctx.step("Escape gibt den Fokus ab"):
            _key("Escape")
            ctx.expect(bool(_poll(lambda: _focused(ctx).startswith("outside:"))),
                       f"Escape: Fokus noch im Baum ({_focused(ctx)!r})")

        with ctx.step("Mausklick in den Baum setzt den Fokus dorthin, ohne Fokusring"):
            # Benutzerentscheidung 2026-10-18: wie im Dateimanager. Der
            # Webview beginnt unter der GTK-Menüleiste, daher der Versatz
            # outerHeight − innerHeight.
            geo = _evalv(
                ctx,
                "(() => { const li = document.querySelector('#vault-tree li.node[data-path=\"%s\"]');"
                " const r = li.querySelector(':scope > .row').getBoundingClientRect();"
                " return {x: window.screenX + r.left + 30,"
                " y: window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2}; })()"
                % zeta,
            )
            # zeta.md ist das aktive Dokument: der Klick öffnet nichts Neues.
            _xdotool("mousemove", str(int(geo["x"])), str(int(geo["y"])), "click", "1")
            _wait_focus(ctx, zeta, "Mausklick")
            ring = _evalv(ctx, "document.activeElement.matches(':focus-visible')")
            ctx.expect(ring is False, "Mausklick zeigt einen Fokusring")
            _key("Escape")
            ctx.expect(bool(_poll(lambda: _focused(ctx).startswith("outside:"))),
                       f"Escape nach Mausklick: Fokus noch im Baum ({_focused(ctx)!r})")

        with ctx.step("Zen-Modus: Strg+Umschalt+E ohne Wirkung"):
            ctx.api.menu_click("view.zen")
            ctx.expect(bool(_poll(lambda: _evalv(
                ctx, "document.body.classList.contains('zen-mode')") is True)), "Zen ging nicht an")
            _key("ctrl+shift+e")
            time.sleep(0.5)
            ctx.expect(_focused(ctx).startswith("outside:"),
                       f"Strg+Umschalt+E wirkte im Zen-Modus: {_focused(ctx)!r}")
            ctx.api.menu_click("view.zen")
            ctx.expect(bool(_poll(lambda: _evalv(
                ctx, "document.body.classList.contains('zen-mode')") is False)), "Zen ging nicht aus")

        with ctx.step("Command Palette: „Vault fokussieren“"):
            _evalv(ctx, "window.__folioOpenPalette('>Vault fokussieren')")
            time.sleep(0.4)
            label = _evalv(
                ctx, "(function(){var r=document.querySelector('#cmd-palette .cmd-palette-item');"
                "return r?r.textContent:'';})()")
            ctx.expect("Vault fokussieren" in (label or ""), f"Palette ohne Eintrag: {label!r}")
            _key("Return")
            _wait_focus(ctx, zeta, "Palette → aktives Dokument")

        with ctx.step("K3: Umschalt+F10 öffnet das Kontextmenü, ↓ überspringt Trenner"):
            _key("shift+F10")
            ctx.expect(bool(_poll(lambda: _evalv(ctx, MENU_JS)["open"])), "Kontextmenü ging nicht auf")
            menu = _evalv(ctx, MENU_JS)
            ctx.expect(menu["role"] == "menu" and menu["active"] == "open",
                       f"Fokus nicht auf dem ersten Eintrag: {menu!r}")
            ctx.expect(menu["nonMenuitem"] == 0, f"Einträge ohne role=menuitem: {menu!r}")
            _key("Down", "Down")
            ctx.expect(_evalv(ctx, MENU_JS)["active"] == "open-default", "↓↓ nicht auf open-default")
            _key("Down")
            ctx.expect(_evalv(ctx, MENU_JS)["active"] == "rename",
                       f"↓ übersprang den Trenner nicht: {_evalv(ctx, MENU_JS)!r}")

        with ctx.step("Kontextmenü per Tastatur (Screenshot hell/dunkel)"):
            ctx.api.theme("light")
            ctx.screenshot("vault_keyboard_menu_light")
            ctx.api.theme("dark")
            ctx.expect(_evalv(ctx, MENU_JS)["active"] == "rename", "Menüfokus nach Theme-Wechsel weg")
            ctx.screenshot("vault_keyboard_menu_dark")
            ctx.api.theme("light")

        with ctx.step("K3: Escape schließt, Fokus zurück an die Zeile"):
            _key("Escape")
            ctx.expect(bool(_poll(lambda: not _evalv(ctx, MENU_JS)["open"])), "Escape schloss das Menü nicht")
            _wait_focus(ctx, zeta, "nach Escape im Menü")

        with ctx.step("K2: Strg+D dupliziert, Fokus auf der Kopie"):
            copy = f"{pin}/zeta copy.md"
            _key("ctrl+d")
            ctx.expect(bool(_poll(lambda: Path(copy).is_file())), "Kopie nicht angelegt")
            _wait_focus(ctx, copy, "nach Strg+D")

        with ctx.step("K2: Entf mit Bestätigung, Fokus auf dem Nachbarn"):
            _key("Delete")
            ctx.expect(bool(_poll(lambda: _evalv(
                ctx, "!document.getElementById('confirm-dialog').hidden") is True)),
                "Bestätigungsdialog erschien nicht")
            ctx.api.click("#confirm-ok")
            ctx.expect(bool(_poll(lambda: not Path(copy).exists())), "Kopie nicht gelöscht")
            _wait_focus(ctx, zeta, "Nachbar nach Entf")

        with ctx.step("K2: Strg+X / Strg+V verschiebt alpha.md in den Ordner"):
            _key("Up")
            _wait_focus(ctx, alpha, "↑ auf alpha")
            _key("ctrl+x")
            _key("Home", "Down", "Down")
            _wait_focus(ctx, ordner, "zum Ordner")
            _key("ctrl+v")
            moved = f"{ordner}/alpha.md"
            ctx.expect(bool(_poll(lambda: Path(moved).is_file() and not Path(alpha).exists())),
                       "alpha.md nicht verschoben")
            _wait_focus(ctx, moved, "Fokus auf dem verschobenen Eintrag")

        with ctx.step("K2: F2 benennt um, Tab-Pfad wandert mit"):
            _key("Down", "Down")
            _wait_focus(ctx, gamma, "auf gamma")
            _key("Return")
            ctx.expect(bool(_poll(lambda: _active_tab_path(ctx) == gamma)), "gamma.md nicht geöffnet")
            _wait_focus(ctx, gamma, "nach Enter auf gamma")
            _key("F2")
            ctx.expect(bool(_poll(lambda: _evalv(
                ctx, "document.activeElement && document.activeElement.classList"
                     ".contains('vault-rename-input')") is True)), "Inline-Rename-Feld fehlt")
            _xdotool("type", "--delay", "40", "gamma2")
            _key("Return")
            renamed = f"{ordner}/gamma2.md"
            ctx.expect(bool(_poll(lambda: Path(renamed).is_file())), "gamma.md nicht umbenannt")
            ctx.expect(bool(_poll(lambda: _active_tab_path(ctx) == renamed)),
                       f"Tab-Pfad nicht mitgewandert: {_active_tab_path(ctx)!r}")
            _wait_focus(ctx, renamed, "Fokus auf dem umbenannten Eintrag")
    finally:
        try:
            ctx.api.workspace_unpin(str(projekt))
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(ROOT_DIR, ignore_errors=True)
