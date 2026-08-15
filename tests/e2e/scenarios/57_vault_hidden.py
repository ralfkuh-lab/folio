"""E2E: Setting vaultShowHidden + .git immer ausgeblendet.

Der Vault-Baum folgt dem includeHidden-Modell der Suche: Default an
(historischer Stand), .git immer weg, Dot-Namen name-basiert.

Fixture auf festem Temp-Pfad, weil der Pfad im Vault sichtbar und damit
Teil der Visual-Baseline ist (gleiche Begründung wie 56_git_status).
"""

from __future__ import annotations

import json
import shutil
import tempfile
import time
from pathlib import Path

REPO_DIR = Path(tempfile.gettempdir()) / "folio-e2e-hidden"


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
    shutil.rmtree(REPO_DIR, ignore_errors=True)
    REPO_DIR.mkdir(parents=True)
    _write(REPO_DIR / "note.md", "# note\n\nSichtbar.\n")
    _write(REPO_DIR / ".versteckt" / "drin.md", "# drin\n")
    _write(REPO_DIR / ".versteckte-datei.md", "# hidden file\n")
    (REPO_DIR / ".git").mkdir()
    return REPO_DIR


def _node_sel(path: str) -> str:
    return (
        f'#vault-tree li.section[data-section="pinned"] '
        f'li.node[data-path="{path}"]'
    )


def _node(ctx, path: str):
    sel = json.dumps(_node_sel(path))
    return _evalv(
        ctx,
        "(function(){"
        f"var n=document.querySelector({sel});"
        "if(!n)return null;"
        "return{"
        "className:n.className,"
        "kind:n.getAttribute('data-kind')"
        "};})()",
    )


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


def _visible(ctx, path: str) -> bool:
    return _node(ctx, path) is not None


def _hidden(ctx, path: str) -> bool:
    return _node(ctx, path) is None


def run(ctx):
    repo = None
    pin_norm = ""
    note = ""
    hidden_dir = ""
    hidden_file = ""
    git_dir = ""
    try:
        with ctx.step("Fixture anlegen, pinnen und aufklappen"):
            repo = _setup_fixture()
            pin_norm = _norm(repo)
            note = f"{pin_norm}/note.md"
            hidden_dir = f"{pin_norm}/.versteckt"
            hidden_file = f"{pin_norm}/.versteckte-datei.md"
            git_dir = f"{pin_norm}/.git"

            ctx.api.tabs_close_all()
            ctx.api.mode("view")
            ctx.api.workspace_pin(str(repo), is_directory=True)
            pin_ok = _poll(lambda: _node(ctx, pin_norm) is not None, timeout=5.0)
            ctx.expect(bool(pin_ok), f"Pin-Knoten fehlt: {_node(ctx, pin_norm)!r}")

            ctx.expect(_click_row(ctx, pin_norm), "Pin-Ordner-Row nicht klickbar")
            kids = _poll(
                lambda: _visible(ctx, note) and _visible(ctx, hidden_dir) and _visible(ctx, hidden_file),
                timeout=5.0,
            )
            ctx.expect(
                bool(kids),
                "Default-Expand zeigt Kinder nicht: "
                f"note={_node(ctx, note)!r} hidden_dir={_node(ctx, hidden_dir)!r} "
                f"hidden_file={_node(ctx, hidden_file)!r}",
            )
            ctx.expect(
                _hidden(ctx, git_dir),
                f".git darf beim Default nicht sichtbar sein: {_node(ctx, git_dir)!r}",
            )

        with ctx.step("Screenshot-Baseline vault_hidden_default"):
            ctx.screenshot("vault_hidden_default")

        with ctx.step("vaultShowHidden=false blendet Dot-Namen aus, .git bleibt weg"):
            before = ctx.api.settings_get()
            ctx.expect(
                before.get("vaultShowHidden") is True,
                f"Default vaultShowHidden sollte true sein: {before.get('vaultShowHidden')!r}",
            )
            ctx.api.settings_set({"vaultShowHidden": False})
            after = ctx.api.settings_get()
            ctx.expect(
                after.get("vaultShowHidden") is False,
                f"Setting nicht auf false: {after.get('vaultShowHidden')!r}",
            )
            gone = _poll(
                lambda: (
                    _visible(ctx, note)
                    and _hidden(ctx, hidden_dir)
                    and _hidden(ctx, hidden_file)
                    and _hidden(ctx, git_dir)
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(gone),
                "Nach Aus-Schalten falsch: "
                f"note={_node(ctx, note)!r} hidden_dir={_node(ctx, hidden_dir)!r} "
                f"hidden_file={_node(ctx, hidden_file)!r} git={_node(ctx, git_dir)!r}",
            )
            ctx.expect(_visible(ctx, pin_norm), "Pin-Wurzel darf nicht verschwinden")

        with ctx.step("vaultShowHidden=true stellt Dot-Namen wieder her"):
            ctx.api.settings_set({"vaultShowHidden": True})
            back = _poll(
                lambda: (
                    _visible(ctx, note)
                    and _visible(ctx, hidden_dir)
                    and _visible(ctx, hidden_file)
                    and _hidden(ctx, git_dir)
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(back),
                "Nach Wieder-An falsch: "
                f"note={_node(ctx, note)!r} hidden_dir={_node(ctx, hidden_dir)!r} "
                f"hidden_file={_node(ctx, hidden_file)!r} git={_node(ctx, git_dir)!r}",
            )
    finally:
        try:
            ctx.api.settings_set({"vaultShowHidden": True})
        except Exception:
            pass
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        try:
            if pin_norm:
                ctx.api.workspace_unpin(pin_norm)
        except Exception:
            try:
                if repo is not None:
                    ctx.api.workspace_unpin(str(repo))
            except Exception:
                pass
        shutil.rmtree(REPO_DIR, ignore_errors=True)
