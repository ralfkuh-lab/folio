"""Nimmt die README-Screenshots gegen eine laufende Folio-Instanz auf.

Wird normalerweise nicht direkt aufgerufen, sondern ueber
`bash scripts/make-readme-screenshots.sh` — der Wrapper besorgt Xvfb, ein
isoliertes Config-Verzeichnis, das Demo-Vault und den Folio-Prozess.

Erwartet eine Folio-Instanz mit `FOLIO_AUTOMATION=1` und `FOLIO_LANG=en`
auf einem 1280x800-Display; das Demo-Vault liegt unter `--vault`.

Die Bilder werden als RGB mit `optimize=True` geschrieben (die Rohaufnahme
ist RGBA und rund ein Drittel groesser). Ohne Pillow laeuft das Skript
weiter und legt die Rohdaten ab.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO_ROOT, "tests", "e2e", "lib"))
from api import AutomationApi  # noqa: E402

api = AutomationApi()
VAULT = "/tmp/folio-demo"
OUT = os.path.join(REPO_ROOT, "docs", "images")


# ---------------------------------------------------------------- helpers


def ev(js: str, timeout_ms: int = 5000):
    return api.eval(js, timeout_ms=timeout_ms).get("value")


def poll(fn, timeout: float = 6.0, interval: float = 0.15):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
        except Exception:
            last = None
        if last:
            return last
        time.sleep(interval)
    return last


def shot(name: str) -> str:
    """Screenshot nach zwei Render-Syncs — der erste Ack garantiert nicht,
    dass WebKits Frame schon im Xvfb-Framebuffer steht (Monitor-Capture
    liest den X-Server, nicht die Page; siehe docs/e2e-headless-caveats.md)."""
    api.sync_render(ack_timeout_ms=3000)
    time.sleep(0.35)
    api.sync_render(ack_timeout_ms=3000)
    raw = api.screenshot()
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}.png")
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.save(path, optimize=True)
    except ImportError:
        with open(path, "wb") as f:
            f.write(raw)
        print("  (Pillow fehlt — Rohaufnahme ohne Optimierung geschrieben)")
    print(f"  -> {os.path.relpath(path, REPO_ROOT)} ({os.path.getsize(path)} bytes)")
    return path


def click_row(path: str) -> bool:
    """Klick auf eine Vault-Zeile (Ordner auf-/zuklappen, Datei oeffnen)."""
    js = (
        "(function(){var n=document.querySelector("
        "'#vault-tree li.node[data-path=%s] > .row');"
        "if(!n)return false;n.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
        "return true;})()" % json.dumps(path)
    )
    return ev(js) is True


def tree_html() -> str:
    return ev("document.getElementById('vault-tree').innerHTML") or ""


def scroll_view_top() -> None:
    """Setzt jeden scrollbaren Vorfahren der .markdown-body auf 0. Der
    Live-Preview-Container behaelt sonst die Scroll-Position des letzten
    Screenshots (preserveScroll), und der Hero startet mitten im Dokument."""
    ev(
        "(function(){var b=document.querySelector('#view-region .markdown-body')"
        "||document.querySelector('.markdown-body');var n=b;"
        "while(n){if(n.scrollHeight>n.clientHeight+2)n.scrollTop=0;n=n.parentElement;}"
        "document.documentElement.scrollTop=0;window.scrollTo(0,0);})()"
    )


def set_tags_expanded(expanded: bool) -> None:
    """Tag-Browser auf- oder zuklappen — idempotent. Der Header ist ein
    Toggle; ein blinder Klick wuerde eine bereits offene Sektion schliessen,
    und die Sektion ueberlebt in `panel_state.tags_expanded` jede vorherige
    Aufnahme (bei `--only` also auch die, die sie geoeffnet hat)."""
    ev(
        "(function(){var s=document.getElementById('vault-tags-section');"
        "if(!s)return false;var open=!s.classList.contains('collapsed');"
        "if(open===%s)return true;"
        "var h=document.getElementById('vault-tags-header');"
        "if(h)h.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
        "return !!h;})()" % ("true" if expanded else "false")
    )


def scroll_editor_top() -> None:
    ev(
        "(function(){if(!window.monaco)return -1;"
        "var es=window.monaco.editor.getEditors();"
        "es.forEach(function(e){e.setScrollTop(0);});return es.length;})()"
    )


# ------------------------------------------------------------------ setup


def setup() -> None:
    print("setup: settings, pin, tabs")
    api.settings_set({"theme": "light", "vaultAutoRefresh": True, "viewTheme": "standard"})
    api.tabs_close_all()
    api.workspace_clear_recents()
    api.resize(1280, 800)
    time.sleep(0.4)
    api.workspace_pin(VAULT, is_directory=True)
    api.rail("left", True)
    api.rail("right", True)
    api.open(os.path.join(VAULT, "welcome.md"), discard=True)
    poll(lambda: (api.state().get("file") or "").endswith("welcome.md"))
    click_row(VAULT)
    poll(lambda: "welcome.md" in tree_html() and "guides" in tree_html())
    click_row(os.path.join(VAULT, "guides"))
    poll(lambda: "markdown-basics.md" in tree_html())
    set_tags_expanded(False)
    api.sync_render()


# ------------------------------------------------------------------ shots


def hero_split() -> None:
    """Titelbild: Split-Mode, Editor links, Live-Preview rechts."""
    print("shot: hero-split")
    api.mode("split")
    api.split(48)
    api.editor_command("setSelection", {"start": 0, "length": 0})
    time.sleep(1.2)
    api.sync_render()
    for _ in range(2):
        scroll_view_top()
        scroll_editor_top()
        time.sleep(0.4)
    shot("hero-split")


def view_features() -> None:
    """GFM-Tabelle, Syntax-Highlighting und Mermaid in einem Bild."""
    print("shot: view-features")
    api.mode("view")
    api.sync_render()
    api.toc_activate("a-quick-table")
    time.sleep(0.5)
    shot("view-features")


def light_dark() -> None:
    """Hell/Dunkel-Paar, beide am Dokumentanfang."""
    print("shot: view-light / view-dark")
    api.mode("view")
    api.theme("light")
    api.sync_render()
    for _ in range(2):
        scroll_view_top()
        time.sleep(0.3)
    shot("view-light")
    api.theme("dark")
    api.sync_render()
    time.sleep(0.4)
    shot("view-dark")
    api.theme("light")
    api.sync_render()


def wikilinks() -> None:
    """Wikilinks im Text, Backlinks rechts, Tag-Browser links."""
    print("shot: wikilinks")
    api.open(os.path.join(VAULT, "themes.md"), discard=True)
    poll(lambda: (api.state().get("file") or "").endswith("themes.md"))
    api.mode("view")
    set_tags_expanded(True)
    poll(lambda: ev("document.querySelectorAll('#vault-tags-list li').length") or 0)
    time.sleep(0.6)
    api.sync_render()
    time.sleep(0.4)
    shot("wikilinks")


def command_palette() -> None:
    print("shot: command-palette")
    api.open(os.path.join(VAULT, "welcome.md"), discard=True)
    api.mode("view")
    api.sync_render()
    # Synthetisches Strg+P ist unter Xvfb fragil — Hook statt Tastendruck.
    ev("window.__folioOpenPalette && window.__folioOpenPalette('')")
    poll(lambda: ev("!document.getElementById('cmd-palette').hidden") is True)
    time.sleep(0.4)
    shot("command-palette")
    ev("window.__folioClosePalette && window.__folioClosePalette()")
    time.sleep(0.3)


def vault_search() -> None:
    """Suchlauf ueber das ganze Vault, Treffer nach Datei gruppiert."""
    print("shot: vault-search")
    api.mode("view")
    # Zugeklappt, sonst drueckt der Tag-Browser die Trefferliste aus dem Bild.
    set_tags_expanded(False)
    api.key("F", {"ctrl": True, "shift": True})
    poll(lambda: ev("!document.getElementById('vault-search-dialog').hidden") is True)
    ev(
        "(function(){"
        "document.getElementById('vsd-query').value='export';"
        "var fr=document.querySelector('input[name=\"vsd-filter\"][value=\"markdown\"]');"
        "if(fr){fr.checked=true;fr.dispatchEvent(new Event('change',{bubbles:true}));}"
        "var sc=document.querySelector('input[name=\"vsd-scope\"][value=\"vault\"]');"
        "if(sc){sc.checked=true;sc.dispatchEvent(new Event('change',{bubbles:true}));}"
        "document.getElementById('vsd-submit')"
        ".dispatchEvent(new MouseEvent('click',{bubbles:true}));return true;})()"
    )
    poll(lambda: ev("document.getElementById('vault-search-dialog').hidden") is True)
    poll(
        lambda: (ev("document.querySelectorAll('#vault-search-list .vs-hit').length") or 0)
        > 2
    )
    time.sleep(0.4)
    shot("vault-search")
    # Suchmodus verlassen, damit ein Folgelauf im normalen Baum startet.
    ev(
        "(function(){var x=document.getElementById('vault-search-exit');"
        "if(x&&x.offsetParent)x.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()"
    )
    time.sleep(0.3)


SHOTS = {
    "hero": hero_split,
    "features": view_features,
    "lightdark": light_dark,
    "wikilinks": wikilinks,
    "palette": command_palette,
    "search": vault_search,
}


def main() -> int:
    global VAULT, OUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "only",
        nargs="*",
        choices=sorted(SHOTS),
        help="nur diese Aufnahmen (Default: alle)",
    )
    parser.add_argument("--vault", default=VAULT, help="Pfad des Demo-Vaults")
    parser.add_argument("--out", default=OUT, help="Zielverzeichnis der PNGs")
    args = parser.parse_args()
    VAULT = args.vault
    OUT = args.out

    if not api.is_alive():
        print("Keine Folio-Instanz auf 127.0.0.1:9876 — bitte den Wrapper nutzen.")
        return 1

    setup()
    for name, fn in SHOTS.items():
        if args.only and name not in args.only:
            continue
        fn()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
