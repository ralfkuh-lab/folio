#!/usr/bin/env bash
# Prüft, ob die eingecheckten Frontend-Bundles zum Quellstand passen.
#
# Warum das ein eigenes Gate braucht: `src-tauri/dist/` ist eingecheckt und
# wird von Tauri zur COMPILE-Zeit ins Binary eingebettet. Wer eine Quelle in
# `src-tauri/web/` ändert und `npm run build` vergisst, committet ein Bundle,
# das nicht zu seinem Quellcode gehört — und testet danach etwas anderes, als
# im Repo steht. Weder `tsc --noEmit` noch vitest noch cargo bemerken das:
# alle drei lesen die Quellen, nicht das Bundle.
#
# Real passiert 2026-08-20 (Commit 565f1c2 -> Korrektur 3ed5714): der
# funktionale Fix war im Bundle, die kurz darauf ergänzte Diagnose-Spur nicht.
# Ausgerechnet die brauchte die Verifikation danach.
#
# Exit 0 = Bundles aktuell, 1 = Drift (Dateien liegen dann neu gebaut im
# Arbeitsbaum und wollen geprüft + mitcommittet werden), 2 = nicht prüfbar.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${REPO_ROOT}/src-tauri/web"
DIST_DIR="src-tauri/dist"

log() { printf '[check-bundles] %s\n' "$*"; }

if ! command -v npm >/dev/null 2>&1; then
    log "npm fehlt — Bundle-Prüfung übersprungen."
    exit 2
fi
if [[ ! -d "${WEB_DIR}/node_modules" ]]; then
    log "node_modules fehlt (${WEB_DIR}) — Bundle-Prüfung übersprungen."
    log "Einmalig: cd src-tauri/web && npm install"
    exit 2
fi
if ! git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
    log "kein git-Repo — Bundle-Prüfung übersprungen."
    exit 2
fi

# Drift, die schon VOR dem Build im Arbeitsbaum lag, gehört dem Nutzer und
# darf nicht als Bundle-Fehler gemeldet werden.
pre_existing="$(git -C "${REPO_ROOT}" status --porcelain -- "${DIST_DIR}")"

log "baue Frontend-Bundles ..."
if ! (cd "${WEB_DIR}" && npm run build >/tmp/folio-check-bundles.log 2>&1); then
    log "npm run build ist fehlgeschlagen — siehe /tmp/folio-check-bundles.log"
    tail -20 /tmp/folio-check-bundles.log
    exit 1
fi

post_build="$(git -C "${REPO_ROOT}" status --porcelain -- "${DIST_DIR}")"

if [[ "${pre_existing}" == "${post_build}" ]]; then
    log "Bundles sind aktuell."
    exit 0
fi

log "DRIFT: die eingecheckten Bundles passen nicht zum Quellstand."
log "Die neu gebauten Dateien liegen jetzt im Arbeitsbaum:"
git -C "${REPO_ROOT}" status --short -- "${DIST_DIR}" | sed 's/^/    /'
log "Prüfen und mitcommitten — ein Test gegen den alten Stand prüft den"
log "falschen Code (siehe Kopf dieses Skripts)."
exit 1
