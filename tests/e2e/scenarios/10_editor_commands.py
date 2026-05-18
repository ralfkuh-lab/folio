"""Editor-Toolbar-Command-Szenario.

Verifiziert den vollen Stack hinter den Markdown-Edit-Toolbar-Buttons
(Bold, Italic, Heading). Ein /click auf tb-bold geht durch:

  DOM-Click → applyCmd('bold') → invoke('apply_editor_command') → Rust
  → applyReplace (setValue + Selection) zurueck

Wenn irgendein Glied der Kette bricht (Selektor falsch, Tauri-Command
umbenannt, Editor-Adapter-API gedreht, Rust-Befehl-Map kaputt), faengt
dieser Test es ein. Das ist die Logik, die der bestehenden 03-Suite
explizit ausgespart wurde ("apply_editor_command waere ein eigener
Step ... das spart Baseline-Drift fuer den MVP").

Da `apply_editor_command` ein invoke()-Promise ist, das ASYNC im
Hintergrund laeuft (der /click-Ack feuert vorher), pollen wir den
Editor-Text mit kurzem Timeout statt blind zu sleepen.
"""

import time

START_TEXT = "Hallo Welt\nZweite Zeile\nDritte Zeile\n"


def _poll_text(ctx, predicate, timeout_s: float = 2.0, interval_s: float = 0.05) -> str:
    """Pollt /editor/text bis predicate(text) True liefert oder Timeout.
    Liefert den letzten gelesenen Text — Caller wirft assert mit Kontext.
    """
    deadline = time.monotonic() + timeout_s
    text = ""
    while time.monotonic() < deadline:
        text = ctx.api.editor_text_get().get("text", "")
        if predicate(text):
            return text
        time.sleep(interval_s)
    return text


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    with ctx.step("switch to edit mode"):
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("kontrollierten Start-Text setzen"):
        ctx.api.editor_text_set(START_TEXT)
        text = ctx.api.editor_text_get().get("text", "")
        ctx.expect(text == START_TEXT, f"editor_text_set hat nicht gegriffen: {text!r}")

    # ----- Bold -------------------------------------------------------
    with ctx.step("selection auf 'Hallo' setzen"):
        ctx.api.editor_selection(0, 5)

    with ctx.step("click tb-bold → '**Hallo**'"):
        ctx.api.click("tb-bold")
        text = _poll_text(ctx, lambda t: "**Hallo**" in t)
        ctx.expect(
            "**Hallo**" in text,
            f"bold-wrap fehlt nach tb-bold-click (text: {text[:80]!r})",
        )

    # ----- Italic -----------------------------------------------------
    with ctx.step("selection auf 'Welt' (Position nach Bold-Wrap)"):
        # Nach Bold ist der Text "**Hallo** Welt\n..." — "Welt" beginnt
        # bei Offset 10 (UTF-16-codeunits = UTF-8 fuer ASCII identisch).
        text_now = ctx.api.editor_text_get().get("text", "")
        welt_idx = text_now.find("Welt")
        ctx.expect(welt_idx >= 0, f"'Welt' nicht im aktuellen Editor-Text: {text_now!r}")
        ctx.api.editor_selection(welt_idx, len("Welt"))

    with ctx.step("click tb-italic → '*Welt*'"):
        ctx.api.click("tb-italic")
        text = _poll_text(ctx, lambda t: "*Welt*" in t and "**Welt**" not in t)
        ctx.expect(
            "*Welt*" in text and "**Welt**" not in text,
            f"italic-wrap fehlt/falsch nach tb-italic-click (text: {text[:120]!r})",
        )

    # ----- Heading ----------------------------------------------------
    with ctx.step("cursor in 'Zweite Zeile' setzen (line-prefix-toggle)"):
        text_now = ctx.api.editor_text_get().get("text", "")
        z_idx = text_now.find("Zweite")
        ctx.expect(z_idx >= 0, f"'Zweite' nicht im Editor-Text: {text_now!r}")
        # length=0 = reiner Cursor; toggle_line_prefix arbeitet
        # zeilenbezogen.
        ctx.api.editor_selection(z_idx, 0)

    with ctx.step("click tb-heading → '# Zweite Zeile'"):
        ctx.api.click("tb-heading")
        text = _poll_text(ctx, lambda t: "# Zweite Zeile" in t)
        ctx.expect(
            "# Zweite Zeile" in text,
            f"heading-prefix fehlt nach tb-heading-click (text: {text[:160]!r})",
        )
