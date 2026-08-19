#!/usr/bin/env bash
# Erzeugt die README-Screenshots unter docs/images/ neu.
#
# Bootet — wie scripts/run-e2e.sh — Xvfb + eine Folio-Instanz mit isoliertem
# Config-Verzeichnis und laesst scripts/readme-screenshots/shots.py die
# Aufnahmen ueber die Automation-API machen. Voraussetzungen: bash, Xvfb,
# python3 (+ Pillow fuer die PNG-Optimierung), Rust-Toolchain.
#
# Aufruf:
#   bash scripts/make-readme-screenshots.sh              # alle Aufnahmen
#   bash scripts/make-readme-screenshots.sh hero search  # nur einzelne
#
# Aufnahmen: hero, features, lightdark, wikilinks, palette, search.
#
# Bewusste Festlegungen:
#   - 1280x800: die Bildgroesse aller bisherigen README-Screenshots.
#   - FOLIO_LANG=en: die README ist englisch, die UI im Bild also auch.
#   - Das Demo-Vault wird nach /tmp/folio-demo kopiert und von dort gepinnt.
#     Der Pfad steht in Statusleiste und Vault-Baum und ist damit Teil des
#     Bildes — er darf nicht das Home-Verzeichnis des Bauenden verraten.
#   - Display :98 (run-e2e.sh nutzt :99), damit beides nebeneinander laufen
#     kann.
#
# Exit-Code: 0 bei Erfolg, 1 bei Setup- oder Aufnahmefehlern.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HERE="${REPO_ROOT}/scripts/readme-screenshots"
DISPLAY_NUM="${FOLIO_SHOTS_DISPLAY:-98}"
DISPLAY_ARG=":${DISPLAY_NUM}"
DEMO_VAULT="/tmp/folio-demo"
XVFB_PID=""
FOLIO_PID=""

log() { printf '[shots] %s\n' "$*"; }

cleanup() {
    local code=$?
    if [[ -n "${FOLIO_PID}" ]] && kill -0 "${FOLIO_PID}" 2>/dev/null; then
        log "stoppe Folio (pid ${FOLIO_PID}) ..."
        kill "${FOLIO_PID}" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            kill -0 "${FOLIO_PID}" 2>/dev/null || break
            sleep 0.5
        done
        kill -9 "${FOLIO_PID}" 2>/dev/null || true
    fi
    if [[ -n "${XVFB_PID}" ]] && kill -0 "${XVFB_PID}" 2>/dev/null; then
        log "stoppe Xvfb (pid ${XVFB_PID}) ..."
        kill "${XVFB_PID}" 2>/dev/null || true
    fi
    if [[ -d "${TEMP_HOME:-}" ]]; then
        rm -rf "${TEMP_HOME}"
    fi
    exit "$code"
}
trap cleanup EXIT INT TERM

# 1) Vorabchecks: eine laufende Folio-Instanz wuerde die neue per
# single-instance-Plugin sofort beenden (Symptom: "Folio-Prozess ist
# gestorben"), eine fremde Instanz auf Port 9876 stattdessen unbemerkt die
# Screenshots liefern.
if curl -sf --max-time 2 http://127.0.0.1:9876/state >/dev/null 2>&1; then
    log "Port 9876 ist belegt — dort laeuft schon eine Folio-Instanz."
    exit 1
fi
if command -v pgrep >/dev/null 2>&1 && pgrep -x -u "$(id -u)" folio >/dev/null 2>&1; then
    log "Es laeuft bereits eine Folio-Instanz dieses Users — bitte schliessen."
    exit 1
fi
if ! command -v Xvfb >/dev/null 2>&1; then
    log "Xvfb fehlt. Auf Debian/Ubuntu: 'sudo apt install xvfb'."
    exit 1
fi

# 2) Demo-Vault frisch aus der Fixture aufbauen.
log "lege Demo-Vault unter ${DEMO_VAULT} an ..."
rm -rf "${DEMO_VAULT}"
cp -r "${HERE}/demo-vault" "${DEMO_VAULT}"

# 3) Xvfb
log "starte Xvfb auf ${DISPLAY_ARG} (1280x800x24) ..."
Xvfb "${DISPLAY_ARG}" -screen 0 1280x800x24 -ac \
    +extension COMPOSITE +extension RANDR +extension RENDER \
    >/tmp/folio-shots-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1
if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
    log "Xvfb konnte nicht starten — siehe /tmp/folio-shots-xvfb.log"
    exit 1
fi
export DISPLAY="${DISPLAY_ARG}"
# WebKitGTK unter Xvfb: GPU-Compositing/DMA-BUF aus (docs/e2e-headless-caveats.md).
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1

# 4) Release-Binary sicherstellen (inkrementell, Sekunden wenn aktuell).
BIN="src-tauri/target/release/folio"
log "stelle aktuelles Release-Binary sicher (cargo build --release) ..."
(cd src-tauri && cargo build --release)
if [[ ! -x "$BIN" ]]; then
    log "Build fehlgeschlagen — kein ausfuehrbares ${BIN}"
    exit 1
fi

# 5) XDG-Isolation: Pins, Recent-Liste und Panel-State des Entwicklers
# bleiben unberuehrt, und die Aufnahme startet reproduzierbar leer.
TEMP_HOME="${HERE}/.temp_home"
rm -rf "$TEMP_HOME"
mkdir -p "$TEMP_HOME"
export XDG_CONFIG_HOME="${TEMP_HOME}/.config"
export XDG_DATA_HOME="${TEMP_HOME}/.local/share"
export XDG_STATE_HOME="${TEMP_HOME}/.local/state"

export FOLIO_AUTOMATION=1
export FOLIO_LANG=en

log "starte Folio (${BIN}) ..."
FOLIO_LOG="/tmp/folio-shots-$$.log"
"$BIN" >"${FOLIO_LOG}" 2>&1 &
FOLIO_PID=$!

log "warte auf Automation-API ..."
for _ in $(seq 1 60); do
    if curl -sf http://127.0.0.1:9876/state >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "${FOLIO_PID}" 2>/dev/null; then
        log "Folio-Prozess ist gestorben — siehe ${FOLIO_LOG}"
        exit 1
    fi
    sleep 1
done
if ! curl -sf http://127.0.0.1:9876/state >/dev/null 2>&1; then
    log "Automation-API nicht erreichbar nach 60 s — siehe ${FOLIO_LOG}"
    exit 1
fi
log "Automation-API ist online."

# 6) Aufnahmen. Danach zeigt `git status docs/images/`, was sich geaendert hat.
python3 "${HERE}/shots.py" --vault "${DEMO_VAULT}" "$@"
