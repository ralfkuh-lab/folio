"""Workspace-Pin/Unpin-Szenario.

Testet die Phase-0-Endpoints /workspace/pin und /workspace/unpin
durch state-Roundtrip. Das war vorher nur via Tauri-Command (also nur
durchs Vault-Kontextmenue) zugaenglich.

  pin file       → state.workspace.pinned enthaelt path mit isDirectory=false
  pin nochmal    → idempotent
  unpin          → wieder weg
  pin directory  → analog mit isDirectory=true
"""

import tempfile
import time
from pathlib import Path


def _pinned_paths(state: dict):
    pinned = (state.get("workspace") or {}).get("pinned") or []
    return [(p.get("path"), p.get("isDirectory")) for p in pinned if isinstance(p, dict)]


def _poll_for(ctx, predicate, timeout_s: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout_s
    state: dict = {}
    while time.monotonic() < deadline:
        state = ctx.api.state()
        if predicate(state):
            return state
        time.sleep(0.05)
    return state


def run(ctx):
    # Eigene temp-Datei und temp-Verzeichnis, damit der Test idempotent
    # ist und nicht zwischen Runs ein wachsender Pinned-Stack uebrig
    # bleibt.
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-pin-"))
    file_path = tmp / "pinned-test.md"
    file_path.write_text("# pinned\n")
    dir_path = tmp / "subdir"
    dir_path.mkdir()

    file_str = str(file_path)
    dir_str = str(dir_path)

    with ctx.step("baseline: keine Test-Pfade im pinned-Set"):
        existing = [p for (p, _) in _pinned_paths(ctx.api.state())]
        ctx.expect(
            file_str not in existing and dir_str not in existing,
            f"Test-Pfade tauchen schon in pinned auf: {existing}",
        )

    # ----- File pinnen ------------------------------------------------
    with ctx.step("/workspace/pin file → erscheint in state.workspace.pinned"):
        ctx.api.workspace_pin(file_str, is_directory=False)
        state = _poll_for(ctx, lambda s: (file_str, False) in _pinned_paths(s))
        ctx.expect(
            (file_str, False) in _pinned_paths(state),
            f"Datei nicht in pinned: {_pinned_paths(state)}",
        )

    with ctx.step("zweimaliges Pin ist idempotent"):
        ctx.api.workspace_pin(file_str, is_directory=False)
        # Idempotent = es taucht NICHT zweimal auf.
        state = ctx.api.state()
        paths = _pinned_paths(state)
        count = sum(1 for (p, _) in paths if p == file_str)
        ctx.expect(count == 1, f"Datei {count}x in pinned (erwartet 1): {paths}")

    # ----- File unpinnen ----------------------------------------------
    with ctx.step("/workspace/unpin file → verschwindet"):
        ctx.api.workspace_unpin(file_str)
        state = _poll_for(
            ctx,
            lambda s: file_str not in [p for (p, _) in _pinned_paths(s)],
        )
        paths = _pinned_paths(state)
        ctx.expect(
            file_str not in [p for (p, _) in paths],
            f"Datei nach unpin noch in pinned: {paths}",
        )

    # ----- Directory pinnen -------------------------------------------
    with ctx.step("/workspace/pin directory → erscheint mit isDirectory=true"):
        ctx.api.workspace_pin(dir_str, is_directory=True)
        state = _poll_for(ctx, lambda s: (dir_str, True) in _pinned_paths(s))
        ctx.expect(
            (dir_str, True) in _pinned_paths(state),
            f"Directory nicht in pinned (oder falscher isDirectory): "
            f"{_pinned_paths(state)}",
        )

    with ctx.step("cleanup: directory wieder unpinnen"):
        ctx.api.workspace_unpin(dir_str)
        state = _poll_for(
            ctx,
            lambda s: dir_str not in [p for (p, _) in _pinned_paths(s)],
        )
        ctx.expect(
            dir_str not in [p for (p, _) in _pinned_paths(state)],
            f"Directory nach Cleanup-Unpin noch in pinned: {_pinned_paths(state)}",
        )

    # ----- Git-Branch-Badge + Live-Update (Spec v2) -------------------
    # Fake-Repo mit .git/HEAD manuell, pin, Badge via /dom pruefen,
    # HEAD aendern, auf Update poll (validiert GitHeadWatcher E2E).
    # Cleanup in finally. Keine Screenshots.
    git_tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-gitbranch-"))
    git_dir = git_tmp / "myrepo"
    git_dir.mkdir()
    (git_dir / ".git").mkdir()
    (git_dir / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    git_str = str(git_dir)
    sub_dir = git_dir / "docs"
    sub_dir.mkdir()
    sub_str = str(sub_dir)

    try:
        with ctx.step("pin fake-git-dir → Badge mit main + --main Klasse"):
            ctx.api.workspace_pin(git_str, is_directory=True)
            state = _poll_for(ctx, lambda s: (git_str, True) in _pinned_paths(s))
            ctx.expect(
                (git_str, True) in _pinned_paths(state),
                f"Git-Dir nicht gepinnt: {_pinned_paths(state)}",
            )

            badge_sel = f'#vault-tree li.node[data-path="{git_str}"] .git-branch'
            snap = ctx.api.dom(badge_sel, timeout_ms=2000)
            ctx.expect(
                snap.get("exists"),
                f"git-branch Badge nicht gefunden via dom: {snap}",
            )
            txt = (snap.get("textContent") or "").strip()
            cls = ((snap.get("attributes") or {}).get("class") or "")
            ctx.expect(
                txt == "main" and "git-branch--main" in cls,
                f"Badge main/--main erwartet, got txt={txt!r} cls={cls!r}",
            )

        with ctx.step("HEAD rewrite → live update auf feature/x (Poll >=4s)"):
            (git_dir / ".git" / "HEAD").write_text("ref: refs/heads/feature/x\n")
            deadline = time.monotonic() + 4.5
            updated = False
            while time.monotonic() < deadline:
                snap = ctx.api.dom(badge_sel, timeout_ms=1000)
                if (snap.get("textContent") or "").strip() == "feature/x":
                    updated = True
                    break
                time.sleep(0.1)
            ctx.expect(
                updated,
                "Badge-Text nicht auf feature/x aktualisiert (GitHeadWatcher)",
            )

        with ctx.step("pin repo-SUBDIR → Badge via Walk-up zum Repo-Root"):
            ctx.api.workspace_pin(sub_str, is_directory=True)
            state = _poll_for(ctx, lambda s: (sub_str, True) in _pinned_paths(s))
            sub_badge_sel = (
                f'#vault-tree li.node[data-path="{sub_str}"] .git-branch'
            )
            snap = ctx.api.dom(sub_badge_sel, timeout_ms=2000)
            ctx.expect(
                snap.get("exists"),
                f"git-branch Badge am Subdir nicht gefunden via dom: {snap}",
            )
            txt = (snap.get("textContent") or "").strip()
            ctx.expect(
                txt == "feature/x",
                f"Subdir-Badge feature/x erwartet, got txt={txt!r}",
            )
            ctx.api.workspace_unpin(sub_str)

        with ctx.step("gitignore + expand + dimming check (no screenshot)"):
            # .gitignore + test files im Fake-Repo anlegen (bestehender Block)
            (git_dir / ".gitignore").write_text("ignored.md\n")
            (git_dir / "ignored.md").write_text("# ignored by git\n")
            (git_dir / "normal.md").write_text("# not ignored\n")
            # expand via Klick auf .row (trigert toggleDir + expand-dir)
            row_sel = f'#vault-tree li.node[data-path="{git_str}"] > .row'
            ctx.api.click(row_sel, ack_timeout_ms=1500)
            # Kinder rendern via Backend + DOM-Update poll
            ign_path = str(git_dir / "ignored.md").replace("\\", "/")
            norm_path = str(git_dir / "normal.md").replace("\\", "/")
            ign_sel = f'#vault-tree li.node[data-path="{ign_path}"]'
            norm_sel = f'#vault-tree li.node[data-path="{norm_path}"]'
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                if ctx.api.dom(ign_sel).get("exists"):
                    break
                time.sleep(0.05)
            ign = ctx.api.dom(ign_sel, timeout_ms=1000)
            norm = ctx.api.dom(norm_sel, timeout_ms=1000)
            ign_cls = ((ign.get("attributes") or {}).get("class") or "")
            norm_cls = ((norm.get("attributes") or {}).get("class") or "")
            ctx.expect(
                ign.get("exists") and "ignored" in ign_cls,
                f"ignored.md muss Klasse ignored haben: {ign}",
            )
            ctx.expect(
                norm.get("exists") and "ignored" not in norm_cls,
                f"normal.md darf keine ignored-Klasse haben: {norm}",
            )
            ign_title = ((ign.get("attributes") or {}).get("title") or "")
            ctx.expect(
                "gitignored" in ign_title,
                f"title von ignored.md muss gitignored enthalten: {ign_title!r}",
            )

        with ctx.step("cleanup unpin git dir"):
            ctx.api.workspace_unpin(git_str)
            state = _poll_for(
                ctx,
                lambda s: git_str not in [p for (p, _) in _pinned_paths(s)],
            )
            ctx.expect(
                git_str not in [p for (p, _) in _pinned_paths(state)],
                f"Git-Dir nach Unpin noch gepinnt: {_pinned_paths(state)}",
            )
    finally:
        for cleanup_path in (sub_str, git_str):
            try:
                ctx.api.workspace_unpin(cleanup_path)
            except Exception:
                pass
        import shutil
        shutil.rmtree(git_tmp, ignore_errors=True)
