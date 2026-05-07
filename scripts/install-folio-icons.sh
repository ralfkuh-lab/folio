#!/usr/bin/env bash
# Richtet auf Linux das Folio-Icon als Anzeigesymbol für .md-Dateien im
# Datei-Manager ein. Hintergrund/Begründung: docs/linux-md-icon.md
#
# Funktioniert ohne sudo — schreibt nur ins User-Profile (XDG_DATA_HOME).
# Das system-weite .deb deckt diesen Schritt aktuell nicht ab, weil
# Mint-Y/Mint-Y-Sand ein eigenes text-markdown.png mitbringen, das jede
# hicolor-Variante schlägt. Daher wird hier der Theme-Pfad selbst
# überlagert (XDG_DATA_HOME hat höhere Prio als XDG_DATA_DIRS).
#
# Idempotent — kann jederzeit wiederholt werden.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ICON="${REPO_ROOT}/src-tauri/icons/icon.png"

if [[ ! -f "$SRC_ICON" ]]; then
    echo "Quell-Icon nicht gefunden: $SRC_ICON" >&2
    exit 1
fi

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
USER_MIME_DIR="$XDG_DATA_HOME/mime"
USER_HICOLOR="$XDG_DATA_HOME/icons/hicolor"

# Aktives Icon-Theme ermitteln (Cinnamon → GNOME → MATE → leer).
detect_theme() {
    local schema theme
    for schema in org.cinnamon.desktop.interface org.gnome.desktop.interface org.mate.interface; do
        if theme=$(gsettings get "$schema" icon-theme 2>/dev/null); then
            theme="${theme//\'/}"
            theme="${theme//\"/}"
            if [[ -n "$theme" ]]; then
                echo "$theme"
                return
            fi
        fi
    done
}

THEME="$(detect_theme || true)"

# 1) Folio-App-Icon in den hicolor-Standardgrößen ablegen, damit GIO's
#    "icon name = folio" überall einen Treffer hat (16/22/24/32/48/64/128/256).
echo "Folio-App-Icon → $USER_HICOLOR"
for sz in 16 22 24 32 48 64 128 256; do
    out="$USER_HICOLOR/${sz}x${sz}/apps"
    mkdir -p "$out"
    python3 - "$SRC_ICON" "$out/folio.png" "$sz" <<'PY'
import sys
from PIL import Image
src, dst, sz = sys.argv[1], sys.argv[2], int(sys.argv[3])
Image.open(src).resize((sz, sz), Image.LANCZOS).save(dst)
PY
done

# 2) MIME-Mapping: text/markdown soll auf Icon "folio" zeigen.
echo "MIME-Override → $USER_MIME_DIR/packages/folio.xml"
mkdir -p "$USER_MIME_DIR/packages"
cat > "$USER_MIME_DIR/packages/folio.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="text/markdown">
    <icon name="folio"/>
  </mime-type>
  <mime-type type="text/x-markdown">
    <icon name="folio"/>
  </mime-type>
</mime-info>
EOF

# 3) Aktives Theme überschreiben: Mint-Y/-Sand & Verwandte bringen ein
#    eigenes text-markdown.png mit, das den hicolor-Lookup nach "folio"
#    nie erreicht. Deshalb das Theme-File direkt überlagern.
override_theme_textmarkdown() {
    local theme="$1"
    local sys_dir="/usr/share/icons/$theme"
    local theme_dir="$XDG_DATA_HOME/icons/$theme"
    if [[ ! -f "$sys_dir/index.theme" ]]; then
        echo "  System-Theme $theme nicht gefunden, überspringe."
        return
    fi
    echo "Theme-Override (text-markdown) → $theme_dir"
    # Normale Größen + @2x-Varianten für HiDPI. Cinnamon/Nemo greifen auf
    # einem Hi-DPI-System (oder mit Display-Scaling) gezielt die @2x-PNGs
    # an — fehlt das, schlägt das Override-PNG durch.
    for variant in "16:16" "24:24" "32:32" "48:48" "64:64" "128:128" \
                   "16@2x:32" "24@2x:48" "32@2x:64" "48@2x:96" \
                   "64@2x:128" "128@2x:256"; do
        dir="${variant%:*}"
        px="${variant#*:}"
        out="$theme_dir/mimetypes/$dir"
        mkdir -p "$out"
        python3 - "$SRC_ICON" "$out/text-markdown.png" "$px" <<'PY'
import sys
from PIL import Image
src, dst, sz = sys.argv[1], sys.argv[2], int(sys.argv[3])
Image.open(src).resize((sz, sz), Image.LANCZOS).save(dst)
PY
    done
    # WICHTIG: niemals eine eigene minimal-index.theme schreiben — das
    # überschreibt Inherits/Directories des System-Themes und bricht
    # Folder/App-Icons (siehe docs/linux-md-icon.md). Stattdessen die
    # System-Datei spiegeln, dann sind alle Suchpfade konsistent.
    cp "$sys_dir/index.theme" "$theme_dir/index.theme"
    gtk-update-icon-cache -f -t "$theme_dir" >/dev/null 2>&1 || true
}

# Mint-Y-Sand inheritet von Mint-Y → beide überschreiben deckt alle Mint-Y-*-Themes ab.
case "$THEME" in
    Mint-Y*)
        override_theme_textmarkdown "Mint-Y"
        if [[ "$THEME" != "Mint-Y" ]]; then
            override_theme_textmarkdown "$THEME"
        fi
        ;;
    "")
        echo "Kein aktives Icon-Theme erkannt — überspringe Theme-Override."
        ;;
    *)
        # Anderes Theme: nur das aktive überschreiben. Wenn das Theme von
        # einem anderen erbt, das ebenfalls text-markdown definiert, hilft
        # das nicht — manuell ergänzen.
        override_theme_textmarkdown "$THEME"
        ;;
esac

# 4) Caches aktualisieren.
echo "Caches aktualisieren …"
update-mime-database "$USER_MIME_DIR" >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t "$USER_HICOLOR" >/dev/null 2>&1 || true

# 5) nemo-desktop neu starten, damit der frische icon-theme.cache
#    geladen wird (das ist der wichtigste Schritt — ohne diesen Restart
#    sieht Nemo den Override nicht).
if pgrep -x nemo-desktop >/dev/null 2>&1; then
    echo "Starte nemo-desktop neu …"
    pkill -x nemo 2>/dev/null || true
    pkill -x nemo-desktop 2>/dev/null || true
    sleep 1
    if ! pgrep -x nemo-desktop >/dev/null 2>&1; then
        ( DISPLAY="${DISPLAY:-:0}" nemo-desktop >/dev/null 2>&1 & disown ) || true
    fi
fi

echo "Fertig. Markdown-Dateien sollten ab jetzt das Folio-Icon zeigen."
