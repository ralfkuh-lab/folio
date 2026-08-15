"""E2E: Regex-Suche + Ersetzen im aktiven Monaco-Puffer.

Deckt einzelnes Ersetzen, Alle ersetzen, Capture-Gruppe, ein Undo fuer
Alle-Ersetzen, unsichtbare Ersetzen-Zeile im View-Mode und den
invalid-Regex-Zustand ab. Fixture ist eine temporaere Kopie, das
Original unter tests/e2e/fixtures bleibt unberührt.
"""

from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

WORKDIR = Path(tempfile.gettempdir()) / "folio-e2e-find-replace"
DOC = WORKDIR / "doc.md"

ORIGINAL = "foo one foo two foo\n"


def _poll(fn, timeout: float = 5.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _wait_counter(ctx, expected_total: int, timeout_s: float = 4.0) -> str:
    suffix = f"/{expected_total}"
    last = ""

    def hit():
        nonlocal last
        snap = ctx.api.dom("#find-counter", timeout_ms=500)
        last = (snap.get("textContent") or "").strip()
        return last.endswith(suffix) and not last.startswith("0/")

    _poll(hit, timeout=timeout_s)
    return last


def _wait_text(ctx, predicate, timeout_s: float = 4.0) -> str:
    last = ""

    def hit():
        nonlocal last
        last = ctx.api.editor_text_get().get("text") or ""
        return predicate(last)

    _poll(hit, timeout=timeout_s)
    return last


def _display(ctx, selector: str) -> str:
    js = (
        "(function(){var el=document.querySelector("
        + repr(selector)
        + ");if(!el)return 'missing';"
        "return getComputedStyle(el).display;})()"
    )
    return ctx.api.eval(js).get("value") or ""


def _setup() -> Path:
    shutil.rmtree(WORKDIR, ignore_errors=True)
    WORKDIR.mkdir(parents=True)
    DOC.write_text(ORIGINAL, encoding="utf-8", newline="\n")
    return DOC


def run(ctx):
    try:
        path = _setup()

        with ctx.step("open temp fixture + edit mode"):
            ctx.api.tabs_close_all()
            ctx.api.open(str(path), discard=True)
            ctx.api.mode("edit")
            ctx.expect_event("editor.ready", timeout_ms=10000)

        with ctx.step("regex find finds three foos"):
            ctx.api.find_text("f.o", regex=True)
            counter = _wait_counter(ctx, 3)
            ctx.expect(
                counter.endswith("/3") and not counter.startswith("0/"),
                f"regex counter={counter!r}",
            )

        with ctx.step("open replace row + screenshot"):
            ctx.api.eval(
                "document.getElementById('find-replace-toggle')?.click()"
            )
            opened = _poll(
                lambda: "replace-open"
                in (
                    (ctx.api.dom("#find-bar").get("attributes") or {}).get("class")
                    or ""
                )
            )
            ctx.expect(opened, "replace-open class missing after toggle")
            ctx.screenshot("find_replace_open")

        with ctx.step("independent insert then replace-all three foos"):
            ctx.api.editor_selection(len(ORIGINAL), 0)
            ctx.api.editor_command("insertText", args="X")
            text = _wait_text(ctx, lambda t: t.endswith("X"))
            ctx.expect(text == ORIGINAL + "X", f"insert text={text!r}")
            ctx.api.find_text("foo")
            _wait_counter(ctx, 3)
            ctx.api.find_replace("foofoo", all=True)
            text = _wait_text(ctx, lambda t: t.count("foofoo") == 3)
            ctx.expect(
                text == "foofoo one foofoo two foofoo\nX",
                f"replace-all text={text!r}",
            )
            ctx.expect(
                _poll(lambda: ctx.api.state().get("dirty") is True),
                "replace-all did not dirty",
            )

        with ctx.step("one undo restores all three foos; second undo drops the insert"):
            ctx.api.editor_command("undo")
            text = _wait_text(ctx, lambda t: t == ORIGINAL + "X")
            ctx.expect(text == ORIGINAL + "X", f"undo-1 text={text!r}")
            ctx.api.editor_command("undo")
            text = _wait_text(ctx, lambda t: t == ORIGINAL)
            ctx.expect(text == ORIGINAL, f"undo-2 text={text!r}")

        with ctx.step("capture group replace"):
            ctx.api.editor_text_set("cat-dog\n")
            ctx.api.find_text("(cat)-(dog)", regex=True)
            _wait_counter(ctx, 1)
            ctx.api.find_replace("$2/$1")
            text = _wait_text(ctx, lambda t: t.startswith("dog/cat"))
            ctx.expect(text == "dog/cat\n", f"capture replace text={text!r}")

        with ctx.step("replace all with zero hits is a no-op"):
            before = ctx.api.editor_text_get().get("text")
            dirty_before = ctx.api.state().get("dirty")
            ctx.api.find_text("zzz")
            _poll(
                lambda: (ctx.api.dom("#find-counter").get("textContent") or "").strip()
                == "0/0"
            )
            ctx.api.find_replace("nope", all=True)
            after = before
            deadline = time.monotonic() + 0.4
            while time.monotonic() < deadline:
                after = ctx.api.editor_text_get().get("text")
                if after != before:
                    break
                time.sleep(0.05)
            ctx.expect(after == before, f"zero-hit replace-all mutated text={after!r}")
            ctx.expect(
                ctx.api.state().get("dirty") == dirty_before,
                "zero-hit replace-all changed dirty",
            )

        with ctx.step("invalid regex shows error state"):
            ctx.api.find_text("(", regex=True)

            def invalid():
                snap = ctx.api.dom("#find-input")
                cls = (snap.get("attributes") or {}).get("class") or ""
                counter = (ctx.api.dom("#find-counter").get("textContent") or "").strip()
                return "find-input--invalid" in cls and counter not in ("", "0/0")

            ctx.expect(_poll(invalid), "invalid regex did not mark input/counter")

        with ctx.step("replace row hidden in view mode"):
            ctx.api.mode("view")
            ctx.api.find_text("foo")
            _poll(lambda: "open" in ((ctx.api.dom("#find-bar").get("attributes") or {}).get("class") or ""))
            row = _display(ctx, "#find-replace-row")
            toggle = _display(ctx, "#find-replace-toggle")
            ctx.expect(row == "none", f"replace row visible in view-mode display={row!r}")
            ctx.expect(toggle == "none", f"replace toggle visible in view-mode display={toggle!r}")

    finally:
        try:
            ctx.api.find_close()
        except Exception:
            pass
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        shutil.rmtree(WORKDIR, ignore_errors=True)
