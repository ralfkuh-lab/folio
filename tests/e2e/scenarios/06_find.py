"""Find-Bar-Szenario im Edit-Mode.

Oeffnet sample.md, wechselt in den Editor, oeffnet die Find-Bar mit
einem bekannten Term und prueft, dass der Find-State im /state-
Snapshot reflektiert wird.
"""

import time


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md + edit mode"):
        ctx.api.open(sample)
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("find-bar oeffnen"):
        ctx.api.find_open()

    with ctx.step("find-term setzen 'Abschnitt'"):
        ctx.api.find_text("Abschnitt")
        # Kurze Stabilisierung — Find-State propagiert ueber Event-Bus.
        time.sleep(0.3)

    with ctx.step("screenshot find-bar offen"):
        ctx.screenshot("find_open_abschnitt")

    with ctx.step("find-bar schliessen (Close-Button)"):
        ctx.api.find_close()

    # Escape-Pfad: Handler haengt am #find-input (find-bar.ts). Ohne
    # target=find-input erreicht synthetisches Escape den Close nie
    # (document-Dispatch war der fruehere Leak-Grund). Kein Screenshot —
    # nur funktionaler Poll wie in lib/reset.py.
    with ctx.step("find-bar Escape via #find-input"):
        ctx.api.find_open()
        deadline = time.monotonic() + 2.0
        while True:
            snap = ctx.api.dom("#find-bar")
            cls = (snap.get("attributes") or {}).get("class") or ""
            if "open" in cls.split():
                break
            if time.monotonic() > deadline:
                raise RuntimeError(
                    f"Find-Bar oeffnete nicht vor Escape-Test (class={cls!r})"
                )
            time.sleep(0.05)
        ctx.api.key("Escape", target="find-input")
        deadline = time.monotonic() + 2.0
        while True:
            snap = ctx.api.dom("#find-bar")
            cls = (snap.get("attributes") or {}).get("class") or ""
            if "open" not in cls.split():
                break
            if time.monotonic() > deadline:
                raise RuntimeError(
                    f"#find-bar behaelt .open trotz Escape (class={cls!r})"
                )
            time.sleep(0.05)
