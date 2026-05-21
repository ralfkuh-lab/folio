#!/usr/bin/env bash
# Folio E2E-Wrapper. Bootet Xvfb + Folio + die Python-Suite auf einem
# Linux-Headless-System. Erwartet wird ausschliesslich:
#   - bash
#   - Xvfb (apt: xvfb)
#   - python3 + Pillow (`pip install Pillow`)
#   - Rust-Toolchain (fuer den initialen Release-Build, falls noetig)
#
# Aufruf:
#   bash scripts/run-e2e.sh                  # voller Run
#   bash scripts/run-e2e.sh --update-baselines
#   bash scripts/run-e2e.sh --attach         # bypass Xvfb+folio, gegen
#                                              laufende Instanz testen
#
# Exit-Code: 0 bei Erfolg, 1 bei Fehlern in der Suite oder im Setup.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DISPLAY_NUM="${FOLIO_E2E_DISPLAY:-99}"
DISPLAY_ARG=":${DISPLAY_NUM}"
SCREEN_WH="${FOLIO_E2E_SCREEN:-1280x800x24}"
XVFB_PID=""
FOLIO_PID=""
ATTACH=0
PASSTHROUGH_ARGS=()

for arg in "$@"; do
    case "$arg" in
        --attach) ATTACH=1 ;;
        *) PASSTHROUGH_ARGS+=("$arg") ;;
    esac
done

log() { printf '[run-e2e] %s\n' "$*"; }

cleanup() {
    local code=$?
    if [[ -n "${FOLIO_PID}" ]] && kill -0 "${FOLIO_PID}" 2>/dev/null; then
        log "stopping folio (pid ${FOLIO_PID})..."
        kill "${FOLIO_PID}" 2>/dev/null || true
        # Kurz auf graceful exit warten.
        for _ in 1 2 3 4 5; do
            kill -0 "${FOLIO_PID}" 2>/dev/null || break
            sleep 0.5
        done
        kill -9 "${FOLIO_PID}" 2>/dev/null || true
    fi
    if [[ -n "${XVFB_PID}" ]] && kill -0 "${XVFB_PID}" 2>/dev/null; then
        log "stopping Xvfb (pid ${XVFB_PID})..."
        kill "${XVFB_PID}" 2>/dev/null || true
    fi
    if [[ -d "${TEMP_HOME:-}" ]]; then
        log "cleaning up temporary config directory ${TEMP_HOME} ..."
        rm -rf "${TEMP_HOME}"
    fi
    exit "$code"
}
trap cleanup EXIT INT TERM

if [[ "$ATTACH" -eq 1 ]]; then
    log "attach mode — Xvfb + Folio werden nicht selbst gestartet."
    exec python3 "tests/e2e/run.py" --attach "${PASSTHROUGH_ARGS[@]}"
fi

# 1) Xvfb anwerfen
if ! command -v Xvfb >/dev/null 2>&1; then
    log "Xvfb fehlt. Auf Debian/Ubuntu: 'sudo apt install xvfb'."
    exit 1
fi

log "starte Xvfb auf ${DISPLAY_ARG} (${SCREEN_WH}) ..."
Xvfb "${DISPLAY_ARG}" \
    -screen 0 "${SCREEN_WH}" \
    -ac \
    +extension COMPOSITE +extension RANDR +extension RENDER \
    >/tmp/folio-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1
if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
    log "Xvfb konnte nicht starten — siehe /tmp/folio-xvfb.log"
    exit 1
fi
export DISPLAY="${DISPLAY_ARG}"

# WebKitGTK unter Xvfb: GPU-Compositing/DMA-BUF deaktivieren, sonst hängt
# der erste Render unter Umständen mehrere Sekunden in DRI-Initialisierung.
# Documented: docs/e2e-headless-caveats.md (2026-05-22 Stabilisierung).
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1

# 2) Folio-Release-Binary sicherstellen
BIN="src-tauri/target/release/folio"
if [[ ! -x "$BIN" ]]; then
    log "Release-Binary fehlt — baue mit 'cargo build --release' ..."
    (cd src-tauri && cargo build --release)
fi
if [[ ! -x "$BIN" ]]; then
    log "Build fehlgeschlagen — kein ausfuehrbares ${BIN}"
    exit 1
fi

# 3) XDG-Isolation: Folios Config/State/Data-Verzeichnisse vom User-Profil
# entkoppeln, damit Tests reproduzierbar laufen und nicht das Recent/
# Workspace/Panel-State des Devs verändern. $HOME bleibt absichtlich
# intakt — WebKitGTK- und fontconfig-Caches werden gemeinsam genutzt
# (sonst friert der erste Boot ein).
TEMP_HOME="${REPO_ROOT}/tests/e2e/.temp_home"
rm -rf "$TEMP_HOME"
mkdir -p "$TEMP_HOME"
export XDG_CONFIG_HOME="${TEMP_HOME}/.config"
export XDG_DATA_HOME="${TEMP_HOME}/.local/share"
export XDG_STATE_HOME="${TEMP_HOME}/.local/state"

log "starte Folio (${BIN}) ..."
"$BIN" >/tmp/folio-stdout.log 2>&1 &
FOLIO_PID=$!

# 4) Automation-API abwarten
log "warte auf Automation-API ..."
for _ in $(seq 1 60); do
    if curl -sf http://127.0.0.1:9876/state >/dev/null 2>&1; then
        log "Automation-API ist online."
        break
    fi
    if ! kill -0 "${FOLIO_PID}" 2>/dev/null; then
        log "Folio-Prozess ist gestorben — siehe /tmp/folio-stdout.log"
        exit 1
    fi
    sleep 1
done

if ! curl -sf http://127.0.0.1:9876/state >/dev/null 2>&1; then
    log "Automation-API nicht erreichbar nach 60 s."
    exit 1
fi

# 5) Python-Suite anwerfen (im --attach-Mode, weil Folio schon laeuft)
log "starte E2E-Suite ..."
set +e
python3 "tests/e2e/run.py" --attach "${PASSTHROUGH_ARGS[@]}"
SUITE_CODE=$?
set -e

log "Suite beendet mit exit-code ${SUITE_CODE}"
exit "${SUITE_CODE}"
