"""E2E: Vault-Dateioperationen V1 — Ordner anlegen, umbenennen, löschen.

Deckt die drei vertikalen Verträge aus `docs/spec-vault-fileops.md` V1.4 ab,
die weder Unit- noch vitest erreichen, weil sie über echte Tauri-Events,
Tree-Rebuild, Dialoge und die Pfad-Migration im Backend laufen:

  1. „Neuer Ordner…“ legt über den Dialog wirklich ein Verzeichnis an und
     der Baum zeigt es.
  2. Ordner umbenennen migriert einen offenen Tab UNTERHALB des Ordners
     präfixweise mit (der eigentliche Kern von V1).
  3. Ordner löschen schließt die Tabs darunter und räumt den Baum.

Fixture auf festem Temp-Pfad, weil der Pfad im Vault-Baum und in der
Statusleiste sichtbar und damit Teil der Visual-Baseline ist (gleiche
Begründung wie 56_git_status und 57_vault_hidden).
"""

from __future__ import annotations

import json
import shutil
import tempfile
import time
from pathlib import Path

ROOT_DIR = Path(tempfile.gettempdir()) / "folio-e2e-fileops"


def _norm(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(fn, timeout: float = 5.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _setup_fixture() -> Path:
    shutil.rmtree(ROOT_DIR, ignore_errors=True)
    ROOT_DIR.mkdir(parents=True)
    _write(ROOT_DIR / "projekt" / "datei.md", "# datei\n")
    _write(ROOT_DIR / "projekt" / "unterordner" / "notiz.md", "# notiz\n\nInhalt.\n")
    return ROOT_DIR / "projekt"


def _node_sel(path: str) -> str:
    return (
        f'#vault-tree li.section[data-section="pinned"] '
        f'li.node[data-path="{path}"]'
    )


def _node_exists(ctx, path: str) -> bool:
    sel = json.dumps(_node_sel(path))
    return _evalv(ctx, f"!!document.querySelector({sel})") is True


def _click_row(ctx, path: str) -> bool:
    sel = json.dumps(_node_sel(path) + " > .row")
    return _evalv(
        ctx,
        "(function(){"
        f"var n=document.querySelector({sel});"
        "if(!n)return false;"
        "n.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
        "return true;})()",
    ) is True


def _ctx_open(ctx, path: str) -> None:
    """Rechtsklick auf die Row und warten, bis das Menü offen ist."""
    ctx.api.right_click(_node_sel(path) + " > .row")
    opened = _poll(
        lambda: _evalv(
            ctx,
            "(function(){var m=document.getElementById('context-menu');"
            "return !!m&&m.classList.contains('open');})()",
        ) is True
    )
    ctx.expect(bool(opened), f"Kontextmenü öffnete nicht für {path}")


def _ctx_has(ctx, act: str) -> bool:
    sel = json.dumps(f'#context-menu .ctx-item[data-act="{act}"]')
    return _evalv(ctx, f"!!document.querySelector({sel})") is True


def _ctx_click(ctx, act: str) -> None:
    ctx.api.click(f'#context-menu .ctx-item[data-act="{act}"]')


def _fill_rename_dialog(ctx, value: str) -> None:
    """Der geteilte #rename-dialog bedient „Neue Datei“ und „Neuer Ordner“."""
    # Die Dialoge in ui/dialogs.ts schalten `hidden`, nicht eine open-Klasse.
    ready = _poll(
        lambda: _evalv(
            ctx,
            "(function(){var d=document.getElementById('rename-dialog');"
            "return !!d&&!d.hidden;})()",
        ) is True
    )
    ctx.expect(bool(ready), "rename-dialog wurde nicht geöffnet")
    ok = _evalv(
        ctx,
        "(function(){var i=document.getElementById('rename-input');"
        "if(!i)return false;"
        f"i.value={json.dumps(value)};"
        "i.dispatchEvent(new Event('input',{bubbles:true}));"
        "return true;})()",
    )
    ctx.expect(ok is True, "#rename-input nicht gefunden")
    ctx.api.click("#rename-ok")


def _rename_via_context(ctx, path: str, value: str, attempts: int = 3) -> None:
    """Kontextmenü → „Umbenennen" → Inline-Input füllen und committen.

    Mit Retry, weil `startInlineRename` ein stiller No-op ist, wenn der
    Knoten im Moment des Klicks nicht im DOM steht: ein vorangegangenes
    `tab_open` stößt einen asynchronen Tree-Rebuild an (`vault:refresh` →
    `refreshVault`), der die Zeile kurzzeitig ersetzt. Im Einzellauf gewinnt
    der Test das Rennen, im Voll-Lauf nicht zuverlässig.

    **Der Commit gehört in denselben Versuch.** Der Rebuild kann den Input
    auch NACH seinem Erscheinen wieder entfernen — dann brach der Test ab,
    obwohl ein neuer Versuch ihn gerettet hätte (Voll-Lauf-Fehlschlag
    2026-08-20: die Schleife fand den Input, `_inline_rename` sah ihn nicht
    mehr). Ein Versuch zählt deshalb erst als geglückt, wenn Enter auf einem
    noch vorhandenen Input abgesetzt wurde.
    """
    for _attempt in range(attempts):
        # Vor jedem Versuch sicherstellen, dass die Zeile wieder da ist.
        ctx.expect(
            bool(_poll(lambda: _node_exists(ctx, path))),
            f"Knoten {path} steht nicht im Baum",
        )
        _ctx_open(ctx, path)
        _ctx_click(ctx, "rename")
        if not _poll(
            lambda: _evalv(ctx, "!!document.querySelector('input.vault-rename-input')") is True,
            timeout=2.0,
        ):
            continue
        if _commit_inline_rename(ctx, value):
            return
    ctx.expect(False, f"Inline-Rename von {path} kam nicht zustande")


def _commit_inline_rename(ctx, value: str) -> bool:
    """Input füllen und mit Enter committen. `False`, wenn er zwischenzeitlich
    verschwunden ist — das ist ein wiederholbarer Zustand, kein Testfehler."""
    return _evalv(
        ctx,
        "(function(){var i=document.querySelector('input.vault-rename-input');"
        "if(!i)return false;"
        f"i.value={json.dumps(value)};"
        "i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));"
        "return true;})()",
    ) is True


def _tab_paths(ctx) -> list[str]:
    data = ctx.api.tabs()
    items = data.get("tabs") if isinstance(data, dict) else None
    return [_norm(t.get("path") or "") for t in (items or []) if t.get("path")]


def run(ctx):
    pin = ""
    try:
        with ctx.step("Fixture anlegen, pinnen und aufklappen"):
            projekt = _setup_fixture()
            pin = _norm(projekt)
            sub = f"{pin}/unterordner"

            ctx.api.tabs_close_all()
            ctx.api.mode("view")
            ctx.api.workspace_pin(str(projekt), is_directory=True)
            ctx.expect(
                bool(_poll(lambda: _node_exists(ctx, pin))),
                "Pin-Knoten erschien nicht im Baum",
            )
            ctx.expect(_click_row(ctx, pin), "Pin-Row nicht klickbar")
            ctx.expect(
                bool(_poll(lambda: _node_exists(ctx, sub))),
                "Unterordner nach Expand nicht im Baum",
            )

        with ctx.step("Kontextmenü: Ordner-Aktionen da, Löschen auf Pin-Wurzel nicht"):
            _ctx_open(ctx, sub)
            for act in ("new-folder", "rename", "delete"):
                ctx.expect(
                    _ctx_has(ctx, act),
                    f"Unterordner-Kontextmenü ohne '{act}'-Eintrag",
                )
            # Auf einer Pin-Wurzel fehlt „Löschen“ bewusst: dort ist „Aus
            # Vault entfernen“ gemeint, ein Fehlklick träfe sonst ein
            # ganzes Projektverzeichnis.
            _ctx_open(ctx, pin)
            ctx.expect(
                _ctx_has(ctx, "new-folder") and _ctx_has(ctx, "rename"),
                "Pin-Wurzel-Kontextmenü ohne Ordner-Aktionen",
            )
            ctx.expect(
                not _ctx_has(ctx, "delete"),
                "Pin-Wurzel-Kontextmenü bietet „Löschen“ an",
            )
            ctx.expect(
                _ctx_has(ctx, "unpin"),
                "Pin-Wurzel-Kontextmenü ohne „Aus Vault entfernen“",
            )

        with ctx.step("„Neuer Ordner…“ legt das Verzeichnis an"):
            _ctx_click(ctx, "new-folder")
            _fill_rename_dialog(ctx, "frisch")
            frisch = ROOT_DIR / "projekt" / "frisch"
            ctx.expect(
                bool(_poll(lambda: frisch.is_dir())),
                f"Verzeichnis wurde nicht angelegt: {frisch}",
            )
            ctx.expect(
                bool(_poll(lambda: _node_exists(ctx, f"{pin}/frisch"))),
                "Neuer Ordner erscheint nicht im Baum",
            )

        with ctx.step("Screenshot-Baseline vault_fileops_newfolder"):
            ctx.screenshot("vault_fileops_newfolder")

        with ctx.step("Ordner umbenennen migriert den offenen Tab darunter"):
            notiz = f"{sub}/notiz.md"
            ctx.api.tab_open(notiz)
            ctx.expect(
                notiz in _tab_paths(ctx),
                f"Tab auf {notiz} wurde nicht geöffnet: {_tab_paths(ctx)}",
            )

            _rename_via_context(ctx, sub, "umbenannt")

            renamed_dir = ROOT_DIR / "projekt" / "umbenannt"
            ctx.expect(
                bool(_poll(lambda: renamed_dir.is_dir())),
                f"Verzeichnis nicht umbenannt: {renamed_dir}",
            )
            ctx.expect(
                not (ROOT_DIR / "projekt" / "unterordner").exists(),
                "Alter Ordnername existiert nach dem Rename noch",
            )
            # Der Kern von V1: der Tab-Pfad wandert präfixweise mit.
            moved = f"{pin}/umbenannt/notiz.md"
            ctx.expect(
                bool(_poll(lambda: moved in _tab_paths(ctx))),
                f"Tab-Pfad wanderte nicht mit: {_tab_paths(ctx)}",
            )

        with ctx.step("V2: Duplizieren legt „datei copy.md“ daneben"):
            datei = f"{pin}/datei.md"
            _ctx_open(ctx, datei)
            ctx.expect(_ctx_has(ctx, "duplicate"), "Kontextmenü ohne „Duplizieren“")
            _ctx_click(ctx, "duplicate")
            dup = ROOT_DIR / "projekt" / "datei copy.md"
            ctx.expect(
                bool(_poll(lambda: dup.is_file())),
                f"Duplikat wurde nicht angelegt: {dup}",
            )
            ctx.expect(
                dup.read_text(encoding="utf-8") == "# datei\n",
                "Duplikat hat nicht den Inhalt der Quelle",
            )
            ctx.expect(
                bool(_poll(lambda: _node_exists(ctx, f"{pin}/datei copy.md"))),
                "Duplikat erscheint nicht im Baum",
            )

        with ctx.step("V2: Ausschneiden markiert, Einfügen verschiebt"):
            dup_path = f"{pin}/datei copy.md"
            # Mit offenem Tab, damit der Move den Pfad-Migrationsvertrag
            # aus V1 wirklich beweist — move_entry teilt sich perform_move.
            ctx.api.tab_open(dup_path)
            ctx.expect(
                dup_path in _tab_paths(ctx),
                f"Tab auf das Duplikat fehlt: {_tab_paths(ctx)}",
            )
            _ctx_open(ctx, dup_path)
            ctx.expect(_ctx_has(ctx, "cut"), "Kontextmenü ohne „Ausschneiden“")
            _ctx_click(ctx, "cut")
            # Der Clip muss sichtbar sein, sonst weiß niemand, dass etwas
            # ausgeschnitten wurde.
            sel = json.dumps(_node_sel(dup_path))
            ctx.expect(
                bool(_poll(
                    lambda: _evalv(
                        ctx,
                        f"(function(){{var n=document.querySelector({sel});"
                        "return !!n&&n.classList.contains('vault-cut');})()",
                    ) is True
                )),
                "Ausgeschnittener Eintrag trägt keine vault-cut-Markierung",
            )

            # „Einfügen" taucht nur bei gefülltem Clip auf — und nur auf Ordnern.
            _ctx_open(ctx, f"{pin}/frisch")
            ctx.expect(_ctx_has(ctx, "paste"), "Ordner-Kontextmenü ohne „Einfügen“")
            _ctx_click(ctx, "paste")

            target = ROOT_DIR / "projekt" / "frisch" / "datei copy.md"
            ctx.expect(
                bool(_poll(lambda: target.is_file())),
                f"Datei wurde nicht verschoben: {target}",
            )
            ctx.expect(
                not (ROOT_DIR / "projekt" / "datei copy.md").exists(),
                "Quelle liegt nach dem Verschieben noch am alten Ort",
            )
            # move_entry teilt sich perform_move — der Tab muss mitwandern.
            moved_dup = f"{pin}/frisch/datei copy.md"
            ctx.expect(
                bool(_poll(lambda: moved_dup in _tab_paths(ctx))),
                f"Tab-Pfad wanderte beim Verschieben nicht mit: {_tab_paths(ctx)}",
            )
            # Nach einem Move ist der Clip leer: „Einfügen" verschwindet wieder.
            # Gepollt, weil clearClip() erst im .then() nach der IPC-Antwort
            # läuft — die Datei liegt schon auf der Platte, bevor das Frontend
            # davon weiß.
            def _paste_gone() -> bool:
                _ctx_open(ctx, f"{pin}/frisch")
                return not _ctx_has(ctx, "paste")

            ctx.expect(
                bool(_poll(_paste_gone, timeout=5.0, interval=0.2)),
                "„Einfügen“ bleibt nach dem Verschieben im Menü",
            )

        with ctx.step("Ordner löschen schließt die Tabs darunter"):
            _ctx_open(ctx, f"{pin}/umbenannt")
            _ctx_click(ctx, "delete")
            confirmed = _poll(
                lambda: _evalv(
                    ctx,
                    "(function(){var d=document.getElementById('confirm-dialog');"
                    "return !!d&&!d.hidden;})()",
                ) is True
            )
            ctx.expect(bool(confirmed), "confirm-dialog erschien nicht")
            ctx.api.click("#confirm-ok")

            ctx.expect(
                bool(_poll(lambda: not (ROOT_DIR / "projekt" / "umbenannt").exists())),
                "Ordner wurde nicht gelöscht",
            )
            ctx.expect(
                bool(_poll(lambda: f"{pin}/umbenannt/notiz.md" not in _tab_paths(ctx))),
                f"Tab unter dem gelöschten Ordner blieb offen: {_tab_paths(ctx)}",
            )
            ctx.expect(
                bool(_poll(lambda: not _node_exists(ctx, f"{pin}/umbenannt"))),
                "Gelöschter Ordner steht noch im Baum",
            )
    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        try:
            if pin:
                ctx.api.workspace_unpin(pin)
        except Exception:
            pass
        shutil.rmtree(ROOT_DIR, ignore_errors=True)
