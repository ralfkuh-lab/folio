# Übergabeprompt für neue Session

> **Temporär — nicht committen.** Kopiere den Block unten in die neue
> Session. Details im [`WORK-LOG-2026-07-04.md`](WORK-LOG-2026-07-04.md).

---

Wir arbeiten am Projekt **folio** (`/home/ralf/dev/folio`, Tauri-2-
Markdown-Viewer/-Editor, Rust + framework-loses TypeScript). Lies zuerst
`CLAUDE.md`, dann `WORK-LOG-2026-07-04.md` im Repo-Root — dort steht der
vollständige Stand der laufenden Arbeit und die verbindlichen
Arbeitskonventionen. Antworte auf Deutsch.

**Stand**: Working Tree sauber, alles auf `main` gepusht (letzter Commit
`3e5ed72`), E2E-Suite mit 24 Szenarien zuletzt komplett grün.

**Laufende Aufgabe**: Ich baue den Settings-Bereich aus. Zwei von drei
Punkten sind fertig (Export-Zielverzeichnis-Default `a46b6cb`,
Settings-Dialog auf Tab-Control `3e5ed72`). Offen ist der dritte:
**Markdown-Themes-Tab mit Theme-System**, geschnitten in vier Etappen
(3a Fundament + View-Theme-Auswahl mit Light/Dark → 3b Custom-Themes →
3c Favoriten → 3d Code-Highlighting im Export via syntect). Es ist noch
kein Code für Punkt 3 geschrieben; wir stehen am Anfang von **Etappe
3a**. Die verbindlichen Design-Entscheidungen des Users und die
technische Kartierung stehen im WORK-LOG (Abschnitte „Design-
Entscheidungen" und „Technische Kartierung für 3a").

**Wichtigste Arbeitsweise** (Details im WORK-LOG): Implementierung und
Reviews laufen bevorzugt über die **Codex CLI** (`codex exec -s
workspace-write -C /home/ralf/dev/folio "<task>"`; lange Specs als Datei
in den Scratchpad und im Prompt referenzieren) — der User hat dort
Nutzungslimit-Resets. Ich (Claude) mache Oberaufsicht, Qualitätskontrolle
und bin Fallback, falls Codex ans Limit stößt. Breite Exploration/
Recherche geht an **agy** (Gemini). Nach jeder Etappe selbst verifizieren
(`cargo test` / `clippy -D warnings` / `fmt --check`; `npm run build &&
npm test`; Bundles in `dist/` neu bauen) und die E2E-Suite fahren
(`bash scripts/run-e2e.sh` — bricht ab, wenn eine Folio-Desktop-Instanz
läuft; dann User bitten zu schließen). Pro fertiger, grün getesteter
Etappe direkt auf `main` committen + pushen.

Bitte lies WORK-LOG-2026-07-04.md und CLAUDE.md, fasse mir den Stand
kurz zusammen und starte dann mit Etappe 3a (Spec schreiben, an Codex
geben). Wenn dabei eine echte Produkt-Weiche auftaucht, die meine
Entscheidung braucht, frag nach — sonst arbeite selbständig.

---

## Hinweis zur Modell-Herabstufung (Fable → Opus)

Der Grund für den Wechsel von Claude Fable 5 auf Opus 4.8 mitten in der
Session ist mir nicht bekannt — ich habe keinen Einblick in die
Account-/Kontingent-Logik. Plausibelste Vermutung (unbestätigt): ein
erreichtes Nutzungslimit für Fable mit automatischem Fallback auf Opus.
Für die inhaltliche Arbeit ist es unkritisch; die neue Session kann auf
jedem Modell mit obigem Prompt weiterarbeiten. Wenn du es klären willst,
frag den Support / prüf die Nutzungsanzeige — aus der Session heraus lässt
sich der Auslöser nicht rekonstruieren.
