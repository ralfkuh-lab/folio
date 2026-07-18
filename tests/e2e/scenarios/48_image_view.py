"""Image-View Zoom/Pan (Mausrad + Doppelklick-Reset).

Oeffnet ein zur Laufzeit erzeugtes PNG aus einem Temp-Verzeichnis
(KEINE neuen Dateien unter tests/e2e/fixtures/ — Vault-Baum steckt in
Visual-Baselines anderer Szenarien). Prueft via /eval: kind-image,
<img> vorhanden, synthetisches WheelEvent erhoeht transform-scale,
Doppelklick setzt auf Fit zurueck. Zusaetzlich Mini-SVG nur mit viewBox
(naturalWidth oft 0) — Fit-Fallback + Zoom greifen. Keine Screenshots.
"""

import shutil
import tempfile
import time
from pathlib import Path

from PIL import Image


def _wait_image(ctx, require_natural: bool = True, timeout_s: float = 4.0) -> dict:
    """Wartet bis #image-view-mount ein geladenes <img> mit Fit-Transform hat.

    require_natural=False fuer SVG-only-viewBox (naturalWidth kann 0 sein);
    dann reichen complete + nichtleerer Transform + positive Style-Maße.
    """
    deadline = time.monotonic() + timeout_s
    last = {}
    script = """
    (() => {
        const body = document.body;
        const mount = document.getElementById('image-view-mount');
        const img = mount && mount.querySelector('img');
        const tw = img ? parseFloat(img.style.width) || 0 : 0;
        const th = img ? parseFloat(img.style.height) || 0 : 0;
        const transform = img ? (img.style.transform || '') : '';
        return {
            kindImage: body.classList.contains('kind-image'),
            hasImg: !!img,
            complete: !!(img && img.complete),
            naturalWidth: img ? img.naturalWidth : 0,
            transform,
            styleWidth: tw,
            styleHeight: th,
        };
    })()
    """
    while time.monotonic() < deadline:
        result = ctx.api.eval(script, timeout_ms=1000)
        if result.get("ok"):
            last = result.get("value") or {}
            transform = (last.get("transform") or "").strip()
            style_ok = (last.get("styleWidth") or 0) > 0 and (last.get("styleHeight") or 0) > 0
            natural_ok = (not require_natural) or (last.get("naturalWidth") or 0) > 0
            if (
                last.get("kindImage")
                and last.get("hasImg")
                and last.get("complete")
                and natural_ok
                and transform
                and style_ok
            ):
                return last
        time.sleep(0.05)
    return last


def _parse_scale(transform: str) -> float:
    """Extrahiert scale(...) aus dem CSS-transform-String."""
    if not transform:
        return 0.0
    # "translate(x, y) scale(s)" — toCssTransform-Format
    marker = "scale("
    i = transform.find(marker)
    if i < 0:
        return 0.0
    rest = transform[i + len(marker) :]
    end = rest.find(")")
    if end < 0:
        return 0.0
    try:
        return float(rest[:end])
    except ValueError:
        return 0.0


def _wheel_zoom(ctx) -> dict:
    result = ctx.api.eval(
        """
        (() => {
            const mount = document.getElementById('image-view-mount');
            const img = mount && mount.querySelector('img');
            if (!img) return { ok: false, reason: 'no-img' };
            const before = img.style.transform || '';
            const rect = mount.getBoundingClientRect();
            const ev = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
                deltaY: -100,
                deltaMode: 0,
            });
            mount.dispatchEvent(ev);
            return {
                ok: true,
                before,
                after: img.style.transform || '',
            };
        })()
        """,
        timeout_ms=2000,
    )
    ctx.expect(result.get("ok") is True, f"eval fehlgeschlagen: {result!r}")
    value = result.get("value") or {}
    ctx.expect(value.get("ok") is True, f"Wheel-Dispatch: {value!r}")
    return value


def run(ctx):
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-image-view-"))
    png_path = tmp / "zoom-sample.png"
    # 400×300 reicht, damit Fit < Natural in typischen Fenstern und
    # Zoom-Steps sichtbar skalieren.
    Image.new("RGB", (400, 300), color=(80, 120, 200)).save(png_path)

    # SVG nur mit viewBox — oft naturalWidth==0; Fallback-Fit muss greifen.
    svg_path = tmp / "viewbox-only.svg"
    svg_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">'
        '<rect width="100" height="50" fill="#4a88cc"/>'
        "</svg>\n",
        encoding="utf-8",
    )

    try:
        with ctx.step("PNG oeffnen und kind-image + img abwarten"):
            ctx.api.tabs_close_all()
            ctx.api.open(str(png_path), discard=True)
            ctx.api.mode("view")
            snap = _wait_image(ctx, require_natural=True)
            ctx.expect(snap.get("kindImage") is True, f"kein kind-image: {snap!r}")
            ctx.expect(snap.get("hasImg") is True, f"kein <img>: {snap!r}")
            ctx.expect(
                (snap.get("naturalWidth") or 0) > 0,
                f"Bild nicht geladen: {snap!r}",
            )
            ctx.expect(
                (snap.get("transform") or "").strip() != "",
                f"leerer Transform: {snap!r}",
            )
            scale0 = _parse_scale(snap.get("transform") or "")
            ctx.expect(
                abs(scale0 - 1.0) < 1e-6,
                f"erwartete Fit-scale≈1, got {scale0!r} transform={snap.get('transform')!r}",
            )

        with ctx.step("Statuszelle Zoom: Ausgangswert lesen"):
            zoom0 = ctx.api.eval(
                """
                (() => {
                    const el = document.getElementById('status-image-zoom');
                    return {
                        hidden: !el || el.hidden,
                        text: el ? (el.textContent || '') : '',
                    };
                })()
                """,
                timeout_ms=1000,
            )
            ctx.expect(zoom0.get("ok") is True, f"status-image-zoom eval: {zoom0!r}")
            z0 = zoom0.get("value") or {}
            ctx.expect(z0.get("hidden") is False, f"Zoom-Zelle hidden vor Wheel: {z0!r}")
            text0 = (z0.get("text") or "").strip()
            ctx.expect(text0.endswith("%"), f"Zoom-Text endet nicht auf %: {text0!r}")
            ctx.expect(len(text0) > 0, f"leerer Zoom-Text: {z0!r}")

        with ctx.step("WheelEvent zoomt (scale waechst)"):
            value = _wheel_zoom(ctx)
            scale_before = _parse_scale(value.get("before") or "")
            scale_after = _parse_scale(value.get("after") or "")
            ctx.expect(
                abs(scale_before - 1.0) < 1e-6,
                f"vor Wheel scale!=1: {scale_before!r} raw={value!r}",
            )
            ctx.expect(
                scale_after > scale_before + 1e-6,
                f"scale wuchs nicht: before={scale_before!r} after={scale_after!r} "
                f"raw={value!r}",
            )

        with ctx.step("Statuszelle Zoom aendert sich nach Wheel und endet auf %"):
            zoom1 = ctx.api.eval(
                """
                (() => {
                    const el = document.getElementById('status-image-zoom');
                    return {
                        hidden: !el || el.hidden,
                        text: el ? (el.textContent || '') : '',
                    };
                })()
                """,
                timeout_ms=1000,
            )
            ctx.expect(zoom1.get("ok") is True, f"status-image-zoom eval: {zoom1!r}")
            z1 = zoom1.get("value") or {}
            ctx.expect(z1.get("hidden") is False, f"Zoom-Zelle hidden nach Wheel: {z1!r}")
            text1 = (z1.get("text") or "").strip()
            ctx.expect(text1.endswith("%"), f"Zoom-Text nach Wheel endet nicht auf %: {text1!r}")
            ctx.expect(
                text1 != text0,
                f"Zoom-Text unveraendert nach Wheel: before={text0!r} after={text1!r}",
            )

        with ctx.step("Doppelklick resettet auf Fit (scale 1)"):
            result = ctx.api.eval(
                """
                (() => {
                    const mount = document.getElementById('image-view-mount');
                    const img = mount && mount.querySelector('img');
                    if (!img) return { ok: false, reason: 'no-img' };
                    const before = img.style.transform || '';
                    const ev = new MouseEvent('dblclick', {
                        bubbles: true,
                        cancelable: true,
                        clientX: 10,
                        clientY: 10,
                    });
                    mount.dispatchEvent(ev);
                    const el = document.getElementById('status-image-zoom');
                    return {
                        ok: true,
                        before,
                        after: img.style.transform || '',
                        zoomText: el ? (el.textContent || '') : '',
                        zoomHidden: !el || el.hidden,
                    };
                })()
                """,
                timeout_ms=2000,
            )
            ctx.expect(result.get("ok") is True, f"eval fehlgeschlagen: {result!r}")
            value = result.get("value") or {}
            ctx.expect(value.get("ok") is True, f"dblclick-Dispatch: {value!r}")
            scale_reset = _parse_scale(value.get("after") or "")
            ctx.expect(
                abs(scale_reset - 1.0) < 1e-6,
                f"Reset-scale nicht 1: {scale_reset!r} raw={value!r}",
            )
            zoom_reset = (value.get("zoomText") or "").strip()
            ctx.expect(value.get("zoomHidden") is False, f"Zoom-Zelle hidden nach Reset: {value!r}")
            ctx.expect(
                zoom_reset == text0,
                f"Zoom-Text nach Doppelklick nicht zurueck: expected={text0!r} got={zoom_reset!r}",
            )

        with ctx.step("SVG nur viewBox: Fit-Fallback + Zoom"):
            ctx.api.open(str(svg_path), discard=True)
            ctx.api.mode("view")
            # naturalWidth darf 0 sein — warten auf Transform + Style-Maße.
            snap = _wait_image(ctx, require_natural=False)
            ctx.expect(snap.get("kindImage") is True, f"SVG kein kind-image: {snap!r}")
            ctx.expect(snap.get("hasImg") is True, f"SVG kein <img>: {snap!r}")
            ctx.expect(
                (snap.get("styleWidth") or 0) > 0 and (snap.get("styleHeight") or 0) > 0,
                f"SVG ohne Fit-Style-Maße: {snap!r}",
            )
            scale_svg = _parse_scale(snap.get("transform") or "")
            ctx.expect(
                abs(scale_svg - 1.0) < 1e-6,
                f"SVG Fit-scale!=1: {scale_svg!r} snap={snap!r}",
            )
            value = _wheel_zoom(ctx)
            scale_after = _parse_scale(value.get("after") or "")
            ctx.expect(
                scale_after > 1.0 + 1e-6,
                f"SVG Zoom wuchs nicht: after={scale_after!r} raw={value!r}",
            )

    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)
