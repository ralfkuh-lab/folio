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
#   bash scripts/run-e2e.sh --lang-smoke    # kurzer en-Boot + DOM-Checks
#   bash scripts/run-e2e.sh 21_split_mode    # nur einzelne Szenarien
#                                              (Name oder Praefix, z. B. 21;
#                                              vergleicht gegen Baselines)
#   bash scripts/run-e2e.sh 21 --update-baselines
#                                              # einzelne Baselines erneuern
#   bash scripts/run-e2e.sh --attach         # bypass Xvfb+folio, gegen
#                                              laufende Instanz testen
#                                              (kanonischer Reset dabei
#                                              uebersprungen; opt-in:
#                                              --attach-reset)
#
# Exit-Code: 0 bei Erfolg, 1 bei Fehlern in der Suite oder im Setup,
# 2 bei Aufruf-Fehlern (z. B. unbekanntes Szenario).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DISPLAY_NUM="${FOLIO_E2E_DISPLAY:-99}"
DISPLAY_ARG=":${DISPLAY_NUM}"
SCREEN_WH="${FOLIO_E2E_SCREEN:-1280x800x24}"
XVFB_PID=""
FOLIO_PID=""
ATTACH=0
LANG_SMOKE=0
PASSTHROUGH_ARGS=()

for arg in "$@"; do
    case "$arg" in
        --attach) ATTACH=1 ;;
        --lang-smoke) LANG_SMOKE=1 ;;
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

if [[ "$LANG_SMOKE" -eq 1 && ( "$ATTACH" -eq 1 || "${#PASSTHROUGH_ARGS[@]}" -ne 0 ) ]]; then
    log "--lang-smoke muss als einziger Modus ohne --attach/Szenario-Argumente laufen."
    exit 1
fi

if [[ "$ATTACH" -eq 1 ]]; then
    log "attach mode — Xvfb + Folio werden nicht selbst gestartet."
    exec python3 "tests/e2e/run.py" --attach "${PASSTHROUGH_ARGS[@]}"
fi

# 1) Port-Vorabcheck: Folio bindet die Automation-API fix auf 9876. Ist der
# Port schon belegt (z. B. eine parallel laufende Desktop-Instanz), startet
# die Test-Instanz zwar, aber ohne API — und die Suite verbindet sich
# unbemerkt mit der fremden Instanz. Deshalb hier hart abbrechen.
if curl -sf --max-time 2 http://127.0.0.1:9876/state >/dev/null 2>&1; then
    log "Port 9876 ist bereits belegt — dort laeuft schon eine Folio-Instanz."
    log "Diese Instanz beenden (oder mit --attach gegen sie testen)."
    exit 1
elif command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q '127\.0\.0\.1:9876 '; then
    log "Port 9876 ist bereits belegt (Prozess antwortet nicht wie Folio)."
    log "Belegenden Prozess beenden: ss -tlnp | grep 9876"
    exit 1
fi

# 1b) Single-Instance-Vorabcheck: laeuft bereits IRGENDEIN Folio dieses
# Users (typisch: die Desktop-Instanz ohne Automation-API — die faengt
# der Port-Check oben nicht), beendet tauri-plugin-single-instance die
# Test-Instanz sofort nach dem Boot: sauberer Exit 0, im Log steht nur
# die eine Logging-Init-Zeile. Das Symptom ("Folio-Prozess ist
# gestorben") ist ohne diesen Check kaum diagnostizierbar.
if command -v pgrep >/dev/null 2>&1; then
    RUNNING_FOLIO="$(pgrep -a -u "$(id -u)" -x folio || true)"
    if [[ -n "${RUNNING_FOLIO}" ]]; then
        log "Es laeuft bereits eine Folio-Instanz dieses Users:"
        while IFS= read -r line; do log "    ${line}"; done <<< "${RUNNING_FOLIO}"
        log "tauri-plugin-single-instance wuerde die Test-Instanz sofort beenden."
        log "Bitte die Instanz schliessen — oder mit --attach gegen sie testen"
        log "(dann muss sie mit FOLIO_AUTOMATION=1 gestartet sein)."
        exit 1
    fi
fi

# 2) Xvfb anwerfen
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

# 2b) Frontend-Bundles gegen den Quellstand pruefen. Dieselbe Falle wie
# beim stalen Release-Binary unten, nur eine Ebene tiefer: `src-tauri/dist/`
# ist eingecheckt und wird beim cargo-Build EINGEBETTET — ein vergessenes
# `npm run build` laesst die Suite gegen Frontend-Code laufen, der nicht im
# Repo steht (passiert real 2026-08-20, Commit 565f1c2 -> 3ed5714).
# Exit 2 heisst „nicht pruefbar" (kein npm/node_modules) und ist kein Fehler.
if [[ -x "${REPO_ROOT}/scripts/check-bundles.sh" ]]; then
    bash "${REPO_ROOT}/scripts/check-bundles.sh"
    bundle_check=$?
    if [[ ${bundle_check} -eq 1 ]]; then
        log "Abbruch: die Suite wuerde einen anderen Frontend-Stand testen"
        log "als im Repo steht. Neu gebaute Bundles pruefen und mitcommitten."
        exit 1
    fi
fi

# 3) Folio-Release-Binary sicherstellen. Immer bauen, nicht nur bei
# fehlendem Binary: cargo ist inkrementell (Sekunden, wenn aktuell),
# und ein stales Release-Binary testet sonst stillschweigend alten
# Code (passiert real: neue API-Endpoints -> 404 im frischen Szenario).
BIN="src-tauri/target/release/folio"
log "stelle aktuelles Release-Binary sicher (cargo build --release) ..."
(cd src-tauri && cargo build --release)
if [[ ! -x "$BIN" ]]; then
    log "Build fehlgeschlagen — kein ausfuehrbares ${BIN}"
    exit 1
fi

# 4) XDG-Isolation: Folios Config/State/Data-Verzeichnisse vom User-Profil
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
# Release-Builds starten die Automation-API nur mit explizitem Opt-in.
export FOLIO_AUTOMATION=1
# i18n: Der Voll-Lauf ist fuer stabile Baselines auf Deutsch gepinnt.
# --lang-smoke bootet dagegen bewusst einen eigenen englischen Prozess.
if [[ "$LANG_SMOKE" -eq 1 ]]; then
    export FOLIO_LANG=en
else
    export FOLIO_LANG=de
fi
# Konsole pro Run in eine eigene Datei (kein Ueberschreiben durch den
# naechsten Lauf); run.py kopiert sie am Ende in den Artefaktordner
# (Vertrag: FOLIO_E2E_CONSOLE_LOG).
FOLIO_LOG="/tmp/folio-stdout-$$.log"
export FOLIO_E2E_CONSOLE_LOG="${FOLIO_LOG}"
"$BIN" >"${FOLIO_LOG}" 2>&1 &
FOLIO_PID=$!

# 5) Automation-API abwarten
log "warte auf Automation-API ..."
for _ in $(seq 1 60); do
    if curl -sf http://127.0.0.1:9876/state >/dev/null 2>&1; then
        log "Automation-API ist online."
        break
    fi
    if ! kill -0 "${FOLIO_PID}" 2>/dev/null; then
        log "Folio-Prozess ist gestorben — siehe ${FOLIO_LOG}"
        log "(Endet das Log nach der Logging-Init-Zeile mit Exit 0, hat"
        log " vermutlich eine parallel gestartete Folio-Instanz per"
        log " single-instance-Plugin uebernommen.)"
        exit 1
    fi
    sleep 1
done

if ! curl -sf http://127.0.0.1:9876/state >/dev/null 2>&1; then
    log "Automation-API nicht erreichbar nach 60 s."
    exit 1
fi

# 6a) Kurzer englischer Prozess-Smoke ohne Szenarien/Baselines.
if [[ "$LANG_SMOKE" -eq 1 ]]; then
    log "starte englischen Sprach-Smoke ..."
    set +e
    python3 "tests/e2e/lang_smoke.py"
    SMOKE_CODE=$?
    set -e
    log "Sprach-Smoke beendet mit exit-code ${SMOKE_CODE}"
    exit "${SMOKE_CODE}"
fi

# 6b) Python-Suite anwerfen (im --attach-Mode, weil Folio schon laeuft).
# --attach-reset ist hier Pflicht: der Wrapper besitzt die Instanz (frischer
# XDG-Temp-Home), der kanonische Reset muss laufen. Reines User-`--attach`
# (oben, ohne Reset) bleibt opt-in via --attach-reset im PASSTHROUGH.
log "starte E2E-Suite ..."
set +e
python3 "tests/e2e/run.py" --attach --attach-reset "${PASSTHROUGH_ARGS[@]}"
SUITE_CODE=$?
set -e

log "Suite beendet mit exit-code ${SUITE_CODE}"
exit "${SUITE_CODE}"
