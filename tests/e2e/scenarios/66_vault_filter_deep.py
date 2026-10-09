"""E2E: Vault-Tree-Filter R4 — Tiefenfilter (`**`) und Ordnerbereich.

Fixture auf festem Temp-Pfad (Grund wie 56/57/59: der Pfad steht im
Vault-Baum und in der Visual-Baseline). `git init` + `.gitignore`
(`ignoriert/`) belegen, dass der Tiefenfilter Gitignore bewusst NICHT
anwendet; eine repo-lokale `core.excludesFile` isoliert gegen die globale
Ignore-Datei des Bauenden.

Geprüft: Chip an + `ziel` → alle vier Treffer samt ganzer Vorfahrenkette
sichtbar und aufgeklappt, `leer/` versteckt; Ordnerbereich (echtes
Kontextmenü `filter-folder` und Hook) → nur der Treffer im Bereich;
Schließen klappt die vom Filter geoeffneten Ordner wieder zu, ein vorher
von Hand aufgeklappter Fremdzweig (`leer/`) bleibt offen;
`vaultShowHidden=false` lässt `ziel-versteckt.md` verschwinden.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT_DIR = Path(tempfile.gettempdir()) / "folio-e2e-deepfilter"
EXCLUDES = ROOT_DIR / ".empty-excludes"


def _norm(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(fn, timeout: float = 6.0, interval: float = 0.05):
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


def _git_env() -> dict[str, str]:
    env = os.environ.copy()
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_CONFIG_SYSTEM"] = "/dev/null"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env.pop("GIT_DIR", None)
    env.pop("GIT_WORK_TREE", None)
    return env


def _git(*args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=ROOT_DIR,
        check=True,
        env=_git_env(),
        capture_output=True,
        text=True,
    )


def _setup_fixture() -> Path:
    shutil.rmtree(ROOT_DIR, ignore_errors=True)
    ROOT_DIR.mkdir(parents=True)
    _write(ROOT_DIR / ".gitignore", "ignoriert/\n")
    _write(EXCLUDES, "")
    _write(ROOT_DIR / "projekt" / "a" / "b" / "c" / "ziel-tief.md", "# tief\n")
    _write(ROOT_DIR / "projekt" / ".versteckt" / "ziel-versteckt.md", "# versteckt\n")
    _write(ROOT_DIR / "projekt" / "ignoriert" / "ziel-ignoriert.md", "# ignoriert\n")
    _write(ROOT_DIR / "projekt" / "andere" / "ziel-anders.md", "# anders\n")
    _write(ROOT_DIR / "projekt" / "leer" / "nichts.md", "# nichts\n")
    _git("init", "-b", "main")
    _git("config", "--local", "core.excludesFile", _norm(EXCLUDES))
    _git("config", "--local", "core.autocrlf", "false")
    _git("config", "--local", "user.name", "Folio E2E")
    _git("config", "--local", "user.email", "folio-e2e@example.test")
    _git("add", "-A")
    _git("commit", "-m", "initial")
    return ROOT_DIR / "projekt"


def _node_sel(path: str) -> str:
    return f'#vault-tree li.section[data-section="pinned"] li.node[data-path="{path}"]'


def _exists(ctx, path: str) -> bool:
    sel = json.dumps(_node_sel(path))
    return _evalv(ctx, f"!!document.querySelector({sel})") is True


def _is_visible(ctx, path: str) -> bool:
    sel = json.dumps(_node_sel(path))
    js = (
        "(function(){"
        f"var n=document.querySelector({sel});"
        "return !!n&&!n.classList.contains('vf-hidden');})()"
    )
    return _evalv(ctx, js) is True


def _is_hidden(ctx, path: str) -> bool:
    sel = json.dumps(_node_sel(path))
    js = (
        "(function(){"
        f"var n=document.querySelector({sel});"
        "return !!n&&n.classList.contains('vf-hidden');})()"
    )
    return _evalv(ctx, js) is True


def _caret_open(ctx, path: str) -> bool:
    sel = json.dumps(_node_sel(path) + " > .row > .caret")
    return (
        _evalv(
            ctx,
            f"(function(){{var c=document.querySelector({sel});"
            "return !!c&&c.classList.contains('open');})()",
        )
        is True
    )


def _ancestor_dirs(pin: str, file_path: str) -> list[str]:
    """Pin-Wurzel und alle Ordner bis zur Datei (jeweils inklusive)."""
    rel = file_path[len(pin):].lstrip("/")
    parts = rel.split("/")[:-1]
    out = [pin]
    cur = pin
    for part in parts:
        cur = f"{cur}/{part}"
        out.append(cur)
    return out


def _chain_visible_and_open(ctx, pin: str, file_path: str) -> bool:
    for d in _ancestor_dirs(pin, file_path):
        if not _is_visible(ctx, d) or not _caret_open(ctx, d):
            return False
    return True


def _click_row(ctx, path: str) -> bool:
    sel = json.dumps(_node_sel(path) + " > .row")
    return (
        _evalv(
            ctx,
            "(function(){"
            f"var n=document.querySelector({sel});"
            "if(!n)return false;"
            "n.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
            "return true;})()",
        )
        is True
    )


def _set_query(ctx, query: str) -> None:
    js = (
        "(function(){var el=document.getElementById('vault-filter-input');"
        "if(!el)return false;el.value=%s;"
        "el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()"
        % json.dumps(query)
    )
    ctx.expect(_evalv(ctx, js) is True, "Filter-Input nicht gesetzt")


def _click_id(ctx, el_id: str) -> None:
    ctx.api.eval(
        "document.getElementById(%s)"
        ".dispatchEvent(new MouseEvent('click',{bubbles:true}))" % json.dumps(el_id)
    )


def _filter_bar_open(ctx) -> bool:
    return _evalv(ctx, "!document.getElementById('vault-filter')?.hidden") is True


def _chip_pressed(ctx, el_id: str) -> bool:
    v = _evalv(
        ctx,
        f"document.getElementById({json.dumps(el_id)})?.getAttribute('aria-pressed')",
    )
    return v == "true"


def _ctx_open(ctx, path: str) -> None:
    ctx.api.right_click(_node_sel(path) + " > .row")
    opened = _poll(
        lambda: _evalv(
            ctx,
            "(function(){var m=document.getElementById('context-menu');"
            "return !!m&&m.classList.contains('open');})()",
        )
        is True
    )
    ctx.expect(bool(opened), f"Kontextmenü öffnete nicht für {path}")


def _ctx_click(ctx, act: str) -> None:
    ctx.api.click(f'#context-menu .ctx-item[data-act="{act}"]')


def run(ctx):
    pinned = _setup_fixture()
    p = _norm(pinned)
    ziel_tief = f"{p}/a/b/c/ziel-tief.md"
    ziel_versteckt = f"{p}/.versteckt/ziel-versteckt.md"
    ziel_ignoriert = f"{p}/ignoriert/ziel-ignoriert.md"
    ziel_anders = f"{p}/andere/ziel-anders.md"
    leer = f"{p}/leer"

    try:
        with ctx.step("pin fixture, open a document, pre-open a foreign branch"):
            ctx.api.workspace_pin(_norm(pinned), is_directory=True)
            ctx.api.open(f"{p}/leer/nichts.md")
            ctx.api.mode("view")
            ctx.api.sync_render()
            # Fremdzweig von Hand aufklappen: Projekt-Wurzel + `leer/`. Diese
            # Ordner hat NICHT der Filter geoeffnet und sie müssen nach dem
            # Schließen offen bleiben (R4 Semantik 7).
            ctx.expect(_poll(lambda: _exists(ctx, p)), "Pin-Knoten fehlt")
            ctx.expect(_click_row(ctx, p), "Pin-Row nicht klickbar")
            ctx.expect(
                _poll(lambda: _exists(ctx, leer)),
                "Unterordner nach Expand nicht im Baum",
            )
            ctx.expect(_click_row(ctx, leer), "leer-Row nicht klickbar")
            ctx.expect(
                _poll(lambda: _exists(ctx, f"{leer}/nichts.md")),
                "leer/ wurde nicht aufgeklappt",
            )

        with ctx.step("flat name filter respects the hidden chip"):
            # `.versteckt` von Hand aufklappen: der Baum zeigt Dot-Namen bei
            # vaultShowHidden=true, R3 filtert nur, was schon gerendert ist.
            _click_id(ctx, "vault-filter-toggle")
            ctx.expect(_poll(lambda: _filter_bar_open(ctx)), "Filterzeile öffnet nicht")
            ctx.expect(_click_row(ctx, f"{p}/.versteckt"), ".versteckt-Row nicht klickbar")
            ctx.expect(
                _poll(lambda: _exists(ctx, ziel_versteckt)),
                ".versteckt wurde nicht aufgeklappt",
            )
            _set_query(ctx, "ziel")
            ok = _poll(
                lambda: _exists(ctx, ziel_versteckt)
                and (not _is_visible(ctx, ziel_versteckt))
                and (not _is_visible(ctx, f"{leer}/nichts.md")),
                timeout=6.0,
            )
            ctx.expect(
                ok,
                "flach/Chip aus: "
                f"exists={_exists(ctx, ziel_versteckt)} "
                f"versteckt_visible={_is_visible(ctx, ziel_versteckt)}",
            )
            _click_id(ctx, "vault-filter-hidden")
            ctx.expect(
                _poll(lambda: _chip_pressed(ctx, "vault-filter-hidden")),
                "Hidden-Chip nicht aktiv",
            )
            ctx.expect(
                _poll(lambda: _is_visible(ctx, ziel_versteckt), timeout=6.0),
                "flach/Chip an: versteckte Treffer fehlen",
            )
            # Aufräumen für den Tiefen-Schritt: Query leeren, Chip aus.
            _click_id(ctx, "vault-filter-clear")
            _click_id(ctx, "vault-filter-hidden")
            ctx.expect(
                _poll(lambda: not _chip_pressed(ctx, "vault-filter-hidden")),
                "Hidden-Chip ließ sich nicht zurücksetzen",
            )

        with ctx.step("deep chip + ziel: hidden only with the hidden chip"):
            if not _filter_bar_open(ctx):
                _click_id(ctx, "vault-filter-toggle")
                ctx.expect(
                    _poll(lambda: _filter_bar_open(ctx)), "Filterzeile öffnet nicht"
                )
            _click_id(ctx, "vault-filter-deep")
            ctx.expect(
                _poll(lambda: _chip_pressed(ctx, "vault-filter-deep")),
                "Tiefen-Chip nicht aktiv",
            )
            _set_query(ctx, "ziel")
            ok = _poll(
                lambda: _is_visible(ctx, ziel_tief)
                and (not _is_visible(ctx, ziel_versteckt))
                and _is_visible(ctx, ziel_ignoriert)
                and _is_visible(ctx, ziel_anders)
                and _is_hidden(ctx, leer)
                and _chain_visible_and_open(ctx, p, ziel_tief),
                timeout=8.0,
            )
            ctx.expect(
                ok,
                "Tiefen/Chip aus: "
                f"tief={_is_visible(ctx, ziel_tief)} "
                f"versteckt_visible={_is_visible(ctx, ziel_versteckt)} "
                f"ignoriert={_is_visible(ctx, ziel_ignoriert)} "
                f"anders={_is_visible(ctx, ziel_anders)} "
                f"leer_hidden={_is_hidden(ctx, leer)} "
                f"kette={_chain_visible_and_open(ctx, p, ziel_tief)}",
            )
            _click_id(ctx, "vault-filter-hidden")
            ctx.expect(
                _poll(lambda: _chip_pressed(ctx, "vault-filter-hidden")),
                "Hidden-Chip nicht aktiv",
            )
            ok = _poll(
                lambda: _is_visible(ctx, ziel_versteckt)
                and _chain_visible_and_open(ctx, p, ziel_versteckt),
                timeout=8.0,
            )
            ctx.expect(
                ok,
                "Tiefen/Chip an: "
                f"versteckt_visible={_is_visible(ctx, ziel_versteckt)} "
                f"kette={_chain_visible_and_open(ctx, p, ziel_versteckt)}",
            )

        with ctx.step("folder scope via real context menu limits to that subtree"):
            _ctx_open(ctx, f"{p}/a")
            ctx.expect(
                _evalv(
                    ctx,
                    "!!document.querySelector("
                    '\'#context-menu .ctx-item[data-act="filter-folder"]\')',
                )
                is True,
                "Kontextmenü-Eintrag filter-folder fehlt",
            )
            _ctx_click(ctx, "filter-folder")
            ok = _poll(
                lambda: _is_visible(ctx, ziel_tief)
                and _is_hidden(ctx, ziel_versteckt)
                and _is_hidden(ctx, ziel_ignoriert)
                and _is_hidden(ctx, ziel_anders)
                and _evalv(
                    ctx,
                    "!document.getElementById('vault-filter-scope')?.hidden",
                )
                is True,
                timeout=8.0,
            )
            scope_hidden = _evalv(
                ctx, "document.getElementById('vault-filter-scope')?.hidden"
            )
            ctx.expect(
                ok,
                "Bereichs-Sicht falsch: "
                f"tief={_is_visible(ctx, ziel_tief)} "
                f"versteckt={_is_visible(ctx, ziel_versteckt)} "
                f"scope_hidden={scope_hidden}",
            )
            scope_name = _evalv(
                ctx,
                "document.getElementById('vault-filter-scope-name')?.textContent",
            )
            ctx.expect(scope_name == "a", f"Bereichs-Name falsch: {scope_name!r}")
            scope_title = _evalv(
                ctx,
                "document.getElementById('vault-filter-scope')?.getAttribute('title')",
            )
            ctx.expect(
                scope_title == f"{p}/a",
                f"Bereichs-Tooltip falsch: {scope_title!r}",
            )
            ctx.api.sync_render()
            ctx.screenshot("66_filter_deep_scope")

        with ctx.step("hook replaces the scope, query stays"):
            ctx.api.eval(
                "window.__folioVaultFilterInFolder(%s)" % json.dumps(p)
            )
            ok = _poll(
                lambda: _is_visible(ctx, ziel_tief)
                and _is_visible(ctx, ziel_versteckt)
                and _is_visible(ctx, ziel_ignoriert)
                and _is_visible(ctx, ziel_anders),
                timeout=8.0,
            )
            ctx.expect(ok, "Hook-Bereich zeigt nicht wieder alle Treffer")

        with ctx.step("closing the bar keeps user-opened branches, collapses filter ones"):
            _click_id(ctx, "vault-filter-close")
            ok = _poll(
                lambda: (not _filter_bar_open(ctx))
                and (not _caret_open(ctx, f"{p}/a"))
                and (not _exists(ctx, ziel_tief)),
                timeout=8.0,
            )
            ctx.expect(
                ok,
                "Close räumt die Filter-Ordner nicht auf: "
                f"bar_open={_filter_bar_open(ctx)} "
                f"a_open={_caret_open(ctx, f'{p}/a')} "
                f"tief_exists={_exists(ctx, ziel_tief)}",
            )
            # Vorher offene Fremdzweige bleiben offen.
            ctx.expect(
                _caret_open(ctx, p) and _caret_open(ctx, leer),
                "vorher offene Ordner (projekt, leer) wurden mit zugeklappt",
            )
            ctx.expect(
                _exists(ctx, f"{leer}/nichts.md"),
                "leer/ ist nach dem Aufräumen nicht mehr aufgeklappt",
            )

        with ctx.step("vaultShowHidden=false hides ziel-versteckt.md"):
            _click_id(ctx, "vault-filter-toggle")
            ctx.expect(_poll(lambda: _filter_bar_open(ctx)), "Filterzeile öffnet nicht")
            ctx.api.settings_set({"vaultShowHidden": False})
            ctx.expect(
                _poll(lambda: ctx.api.settings_get().get("vaultShowHidden") is False),
                "vaultShowHidden nicht auf false",
            )
            _set_query(ctx, "ziel")
            ok = _poll(
                lambda: _is_visible(ctx, ziel_tief)
                and (not _exists(ctx, ziel_versteckt)),
                timeout=8.0,
            )
            ctx.expect(
                ok,
                "hidden=aus: "
                f"tief={_is_visible(ctx, ziel_tief)} "
                f"versteckt_exists={_exists(ctx, ziel_versteckt)}",
            )
            ctx.api.settings_set({"vaultShowHidden": True})
            _poll(
                lambda: ctx.api.settings_get().get("vaultShowHidden") is True,
            )

        with ctx.step("scope + md-only without query shows Markdown under the scope"):
            # Query leeren (der hidden-Schritt liess `ziel` stehen), Bereich
            # projekt/a per Hook setzen und .md anschalten.
            _click_id(ctx, "vault-filter-clear")
            ctx.api.eval(
                "window.__folioVaultFilterInFolder(%s)" % json.dumps(f"{p}/a")
            )
            _click_id(ctx, "vault-filter-md")
            ok = _poll(
                lambda: _is_visible(ctx, ziel_tief)
                and _is_hidden(ctx, f"{p}/andere")
                and _chain_visible_and_open(ctx, p, ziel_tief),
                timeout=8.0,
            )
            ctx.expect(
                ok,
                "Bereich + .md ohne Query: "
                f"tief={_is_visible(ctx, ziel_tief)} "
                f"andere_hidden={_is_hidden(ctx, f'{p}/andere')} "
                f"kette={_chain_visible_and_open(ctx, p, ziel_tief)}",
            )
            # .md aus → der Filter raeumt die von ihm geoeffneten Ordner weg.
            _click_id(ctx, "vault-filter-md")
            ok = _poll(
                lambda: (not _caret_open(ctx, f"{p}/a"))
                and (not _exists(ctx, ziel_tief)),
                timeout=8.0,
            )
            ctx.expect(
                ok,
                ".md aus raeumt die Filter-Ordner nicht: "
                f"a_open={_caret_open(ctx, f'{p}/a')} "
                f"tief_exists={_exists(ctx, ziel_tief)}",
            )
            _click_id(ctx, "vault-filter-scope-remove")
            _poll(
                lambda: _evalv(
                    ctx, "document.getElementById('vault-filter-scope')?.hidden"
                )
                is True
            )

        with ctx.step("scope + git shows only the changed branch under the scope"):
            # Nach dem initialen Commit zwei Dateien aendern: eine im Bereich,
            # eine ausserhalb. create/delete eines Probe-Files stoesst den
            # Git-Refresh an, der die externen Aenderungen einsammelt.
            _write(Path(ziel_tief), "# tief\n\nGEAENDERT\n")
            _write(Path(f"{p}/andere/ziel-anders.md"), "# anders\n\nGEAENDERT\n")
            probe = f"{p}/__r41_probe.md"
            ctx.api.eval(
                "window.__folioInvoke('create_file',{path:%s})" % json.dumps(probe)
            )
            ctx.api.eval(
                "window.__folioInvoke('trash_path',{path:%s})" % json.dumps(probe)
            )
            ctx.api.eval(
                "window.__folioVaultFilterInFolder(%s)" % json.dumps(f"{p}/a")
            )
            _click_id(ctx, "vault-filter-git")
            ok = _poll(
                lambda: _is_visible(ctx, ziel_tief)
                and _is_hidden(ctx, f"{p}/andere")
                and _is_hidden(ctx, f"{p}/.versteckt")
                and _chain_visible_and_open(ctx, p, ziel_tief),
                timeout=10.0,
            )
            ctx.expect(
                ok,
                "Bereich + git: "
                f"tief={_is_visible(ctx, ziel_tief)} "
                f"andere_hidden={_is_hidden(ctx, f'{p}/andere')} "
                f"kette={_chain_visible_and_open(ctx, p, ziel_tief)}",
            )
            _click_id(ctx, "vault-filter-git")

    finally:
        try:
            _click_id(ctx, "vault-filter-close")
        except Exception:
            pass
        try:
            ctx.api.settings_set({"vaultShowHidden": True})
        except Exception:
            pass
        try:
            ctx.api.workspace_unpin(_norm(pinned))
        except Exception:
            try:
                ctx.api.workspace_unpin(p)
            except Exception:
                pass
