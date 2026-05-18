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
