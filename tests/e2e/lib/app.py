"""Folio-Lifecycle-Controller. Startet/Stoppt das `folio`-Binary und
schreibt Stdout/Stderr in eine Log-Datei, damit der E2E-Report später
darauf zeigen kann.

Plattform-Verhalten:
- Linux: `folio` (Release-Binary) wird unter dem aktuell exportierten
  `DISPLAY` gestartet — der Caller (scripts/run-e2e.sh) ist für Xvfb
  zuständig.
- Windows: `folio.exe` wird sichtbar gestartet (Fenster erscheint).
  Headless-Tests auf Windows sind nicht supported (siehe CLAUDE.md
  "Headless-Screenshots").
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional


class AppController:
    """Wraps the Folio process lifecycle."""

    def __init__(self, binary: Path, console_log: Path, env: Optional[dict] = None):
        self.binary = Path(binary)
        self.console_log = Path(console_log)
        self.console_log.parent.mkdir(parents=True, exist_ok=True)
        self.env = env
        self.process: Optional[subprocess.Popen] = None
        self._log_handle = None

    def start(self) -> None:
        if not self.binary.exists():
            raise FileNotFoundError(
                f"Folio binary not found: {self.binary}. Build via "
                f"`cargo build --release` (or the wrapper run-e2e.sh)."
            )
        self._log_handle = self.console_log.open("wb")
        creationflags = 0
        if sys.platform == "win32":
            # CREATE_NEW_PROCESS_GROUP so Ctrl-C in the runner doesn't kill us.
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        self.process = subprocess.Popen(
            [str(self.binary)],
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
            env=self.env or os.environ.copy(),
            creationflags=creationflags,
        )

    def is_running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def stop(self, api=None, graceful_timeout: float = 5.0) -> int:
        """Stop the app. Tries /quit first (if api is provided), then SIGTERM,
        then SIGKILL. Returns the process exit code (or -1 if unknown).
        """
        if self.process is None:
            return 0

        if api is not None and self.is_running():
            try:
                api.quit()
            except Exception:
                pass

        try:
            self.process.wait(timeout=graceful_timeout)
        except subprocess.TimeoutExpired:
            self._terminate()
            try:
                self.process.wait(timeout=graceful_timeout)
            except subprocess.TimeoutExpired:
                self._kill()
                try:
                    self.process.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    pass

        exit_code = self.process.returncode if self.process else -1
        if self._log_handle is not None:
            try:
                self._log_handle.flush()
                self._log_handle.close()
            except Exception:
                pass
            self._log_handle = None
        return exit_code if exit_code is not None else -1

    def _terminate(self) -> None:
        if self.process is None:
            return
        if sys.platform == "win32":
            try:
                self.process.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
            except Exception:
                self.process.terminate()
        else:
            self.process.terminate()

    def _kill(self) -> None:
        if self.process is None:
            return
        try:
            self.process.kill()
        except Exception:
            pass


def discover_folio_binary(repo_root: Path) -> Path:
    """Find the release binary, preferring release/ over debug/. Returns the
    path even if it doesn't exist yet — the caller is expected to build.
    """
    exe_suffix = ".exe" if sys.platform == "win32" else ""
    candidates = [
        repo_root / "src-tauri" / "target" / "release" / f"folio{exe_suffix}",
        repo_root / "src-tauri" / "target" / "debug" / f"folio{exe_suffix}",
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


def ensure_xvfb_or_no_op() -> None:
    """On Linux, sanity-check that a DISPLAY is available. The actual
    Xvfb-Start ist Sache von scripts/run-e2e.sh — wir wollen hier nur eine
    klare Fehlermeldung, wenn jemand `python run.py` ohne Wrapper aufruft.
    """
    if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
        raise RuntimeError(
            "DISPLAY environment variable is not set. On a headless Linux\n"
            "system, start Xvfb first (or use scripts/run-e2e.sh, which\n"
            "handles that for you)."
        )


def have_executable(name: str) -> bool:
    return shutil.which(name) is not None
