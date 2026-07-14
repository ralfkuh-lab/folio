#!/usr/bin/env bash
# Ad-hoc-Boot-Smoke für eine Sprache: bootet den Debug-Build isoliert in
# Xvfb mit FOLIO_LANG=<tag>, öffnet die Settings-Seite und legt einen
# Screenshot unter /tmp/folio-lang-smoke/<tag>.png ab.
# Orchestrierungs-Helfer für Sprach-Batch 2 — bewusst NICHT Teil der E2E-Suite.
set -euo pipefail
TAG="${1:?usage: lang-boot-smoke.sh <lang-tag>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR=/tmp/folio-lang-smoke
mkdir -p "$OUT_DIR"
DISPLAY_ARG=":98"
BIN="src-tauri/target/debug/folio"

cleanup() {
    [ -n "${FOLIO_PID:-}" ] && kill "$FOLIO_PID" 2>/dev/null || true
    [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

Xvfb "$DISPLAY_ARG" -screen 0 1600x1000x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 1

TEMP_HOME="$OUT_DIR/.temp_home_$TAG"
rm -rf "$TEMP_HOME"; mkdir -p "$TEMP_HOME"
export XDG_CONFIG_HOME="$TEMP_HOME/.config"
export XDG_DATA_HOME="$TEMP_HOME/.local/share"
export XDG_STATE_HOME="$TEMP_HOME/.local/state"
export DISPLAY="$DISPLAY_ARG"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export FOLIO_LANG="$TAG"

"$BIN" >/dev/null 2>&1 &
FOLIO_PID=$!

for i in $(seq 1 120); do
    if curl -sf http://127.0.0.1:9876/state 2>/dev/null | grep -q '"frontendReady":[[:space:]]*true'; then
        break
    fi
    kill -0 "$FOLIO_PID" 2>/dev/null || { echo "folio gestorben"; exit 1; }
    sleep 0.5
done
LANG_SEEN=$(curl -sf http://127.0.0.1:9876/state | python3 -c 'import sys,json;print(json.load(sys.stdin).get("lang"))')
[ "$LANG_SEEN" = "$TAG" ] || { echo "FEHLER: lang=$LANG_SEEN, erwartet $TAG"; exit 1; }
sleep 1

curl -sf -X POST http://127.0.0.1:9876/click \
    -H 'Content-Type: application/json' -d '{"name":"tb-settings"}' >/dev/null
curl -sf -X POST http://127.0.0.1:9876/sync/render -H 'Content-Type: application/json' -d '{}' >/dev/null
curl -sf http://127.0.0.1:9876/screenshot -o "$OUT_DIR/$TAG.png"
python3 - "$OUT_DIR/$TAG.png" <<'EOF'
import sys
from PIL import Image
p = sys.argv[1]
img = Image.open(p)
img.resize((img.width // 2, img.height // 2)).save(p)
EOF
echo "OK: $OUT_DIR/$TAG.png"
