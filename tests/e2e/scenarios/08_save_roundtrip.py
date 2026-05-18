"""Save-Roundtrip-Szenario.

Verifiziert, dass DocumentStore.save() das Original-Encoding (BOM ja/nein)
und die Original-Line-Endings (LF/CRLF) erhaelt, durch den vollen
Frontend-Backend-Stack. Der Rust-Unit-Test in document_store.rs deckt
nur die Save-Funktion ab — dieser E2E-Test geht ueber:

  open(path) → /editor/text POST → /save → File-Bytes lesen → vergleichen

Damit faengt der Test sowohl Encoding-Regressionen im DocumentStore selbst
als auch ein versehentliches Normalisieren auf dem Pfad
Editor↔IPC↔Store↔Disk auf (z. B. wenn jemand `text.replace('\\r\\n','\\n')`
im Editor-Update-Pfad einbaut).

Fixtures werden zur Laufzeit als raw bytes erzeugt (umgeht `.gitattributes`-
Normalisierung und macht alle vier BOM-/EOL-Kombis trivial).
"""

import tempfile
from pathlib import Path


BOM = b"\xef\xbb\xbf"


def _make_fixture(tmp: Path, name: str, with_bom: bool, eol: bytes) -> Path:
    """Schreibt Markdown mit gewuenschtem BOM-/EOL-Setup als raw bytes."""
    lines = [b"# Roundtrip", b"", b"Original-Zeile."]
    payload = eol.join(lines) + eol  # trailing newline
    if with_bom:
        payload = BOM + payload
    path = tmp / name
    path.write_bytes(payload)
    return path


def _verify_roundtrip(
    ctx, fixture: Path, with_bom: bool, eol: bytes, new_content: str,
) -> None:
    """Open → edit → save → verify Bytes. `new_content` ist der LF-Text,
    den der Editor setzt (Monaco arbeitet intern mit LF). Der Save muss
    daraus die gewuenschten Raw-Bytes machen.
    """
    label = f"{'BOM' if with_bom else 'noBOM'}-{'CRLF' if eol == b'\\r\\n' else 'LF'}"

    with ctx.step(f"[{label}] open fixture"):
        ctx.api.open(str(fixture))

    with ctx.step(f"[{label}] switch to edit mode"):
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step(f"[{label}] editor text setzen"):
        # Setzt den vollen Editor-Inhalt; document_store sollte beim Save
        # CRLF/BOM aus seinem geladenen Meta-Zustand wiederherstellen.
        ctx.api.editor_text_set(new_content)

    with ctx.step(f"[{label}] save + auf document.saved warten"):
        # /save ist der Direkt-Endpoint (Document-Store-Save). Das
        # document:saved-Event wird vom Store-Callback emittiert, daher
        # haben wir hier ein deterministisches Synchronisations-Signal.
        ctx.api.save()
        ctx.expect_event("document.saved", timeout_ms=5000)

    with ctx.step(f"[{label}] BOM erhalten" if with_bom else f"[{label}] kein BOM hinzugefuegt"):
        raw = fixture.read_bytes()
        if with_bom:
            ctx.expect(
                raw.startswith(BOM),
                f"BOM verloren beim Save (bytes 0-3 = {raw[:3]!r})",
            )
        else:
            ctx.expect(
                not raw.startswith(BOM),
                f"BOM unerwartet hinzugefuegt (bytes 0-3 = {raw[:3]!r})",
            )

    with ctx.step(f"[{label}] line-endings erhalten"):
        raw = fixture.read_bytes()
        body = raw[3:] if with_bom else raw
        if eol == b"\r\n":
            ctx.expect(
                b"\r\n" in body,
                "kein CRLF im gespeicherten Inhalt — auf LF normalisiert?",
            )
            # Kein einzelnes LF ohne vorangehendes CR.
            lf_only = body.replace(b"\r\n", b"")
            ctx.expect(
                b"\n" not in lf_only,
                f"gemischte EOL nach CRLF-Save (rest nach CRLF-strip: {lf_only!r})",
            )
        else:
            ctx.expect(
                b"\r\n" not in body,
                f"unerwartete CRLF im LF-Save (body: {body!r})",
            )
            ctx.expect(
                b"\n" in body,
                "kein LF im gespeicherten Inhalt",
            )


def run(ctx):
    # tempfile.TemporaryDirectory ist nicht handlich, weil das Test-File
    # nach dem Run noch gelesen werden koennte (Diff-Reports). Wir legen
    # die Fixtures in einem Run-spezifischen Sub-Tmpdir an und lassen
    # sie liegen — Standard-OS-tmpdir-Cleanup raeumt das spaeter weg.
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-roundtrip-"))
    new_content = "# Roundtrip\n\nGeaenderte Zeile.\nZusatz.\n"

    variants = [
        ("bom-crlf.md", True,  b"\r\n"),
        ("bom-lf.md",   True,  b"\n"),
        ("nobom-crlf.md", False, b"\r\n"),
        ("nobom-lf.md", False, b"\n"),
    ]
    for name, with_bom, eol in variants:
        fixture = _make_fixture(tmp, name, with_bom, eol)
        _verify_roundtrip(ctx, fixture, with_bom, eol, new_content)
