# Spec: KI-Integration (Settings-Bereiche „KI" + Übersetzungs-Feature)

> **Arbeitsdokument mit Fortschritts-Checkliste** (Muster:
> [`spec-multi-tabs.md`](spec-multi-tabs.md)). Checkboxen werden pro
> abgeschlossener, grün getesteter Etappe abgehakt und committet.
> Beschlossen am 2026-07-04, Implementierung ab Folgesession.

## Ziel

folio bekommt eine KI-Provider-/Modell-Verwaltung nach dem
**opencode-Muster** (Screenshots OpenCode Desktop als UI-Vorbild) und
als erste Funktion die **Dokument-Übersetzung** (offenes `.md` →
Zielsprache → neue Datei `<name>.<lang>.md` als neuer Tab).

## Architektur-Entscheidungen (verbindlich, mit User beschlossen)

1. **Kein geteiltes Crate.** Das `ai_config`-Modul aus
   `~/dev/youtube-summarizer` dient nur als VORLAGE für den
   OpenAI-kompatiblen Client-Kern (`client.rs::summarize` →
   generischer Chat-Call). Begründung: wiederverwendbarer Kern ist
   klein (~150 Zeilen), der Rest ist projektgebunden (storage-Kopplung,
   Summarize-Prompting, hartkodierter Katalog, String-Errors,
   Klartext-Keys in config.json). Extraktion erst, falls je eine
   dritte App KI braucht — dann aus der folio-Implementierung.
2. **Provider-/Modell-Katalog von models.dev** (wie opencode):
   `https://models.dev/api.json` — community-gepflegt (sst), 400+
   Modelle, Provider mit OpenAI-kompatiblen Endpoints, benötigten
   Key-Env-Namen, Doku-URLs; Modelle mit Kosten/Kontext/Fähigkeiten.
   folio bettet einen **Snapshot** ein (`include_str!`, beim Build
   eingecheckt) und refresht zur Laufzeit in eine Cache-Datei
   (`ai-catalog.json` im Config-Verzeichnis); die neuere Quelle
   gewinnt. Offline-first: ohne Netz gilt Snapshot/Cache. Refresh nur
   auf expliziten User-Klick („Katalog aktualisieren") — kein
   Auto-Fetch beim Boot.
3. **API-Keys in separater `auth.json`** im Config-Verzeichnis,
   Dateirechte **0600**, strikt getrennt von `settings.json`/`ai.json`
   (opencode-Muster: `~/.local/share/opencode/auth.json`). Keys
   erscheinen NIE in Logs, NIE in der Automation-API, NIE in
   `settings:changed`-Payloads. UI zeigt nur Status
   („hinterlegt/fehlt") + Ersetzen/Entfernen.
4. **Eigene Persistenz `ai.json`** (`AiConfigService` analog
   `SettingsService`, `persist::config_file`) statt Erweiterung von
   `settings.json`: die Patch-/changed-Mechanik der Settings ist für
   verschachtelte Provider-Strukturen ungeeignet. Inhalt: aktivierte
   Provider, Modell-Whitelist pro Provider (Toggle-Zustand),
   Custom-Provider-Definitionen (id/name/baseURL), Default-Modell
   (providerId + modelId), zuletzt gewählte Zielsprachen.
5. **Custom-Provider** wie im opencode-Dialog: `id` (slug), Anzeigename,
   Basis-URL (OpenAI-kompatibel, `/chat/completions` wird angehängt
   falls nicht vorhanden), optional Key. Lokale Endpoints (Ollama,
   LM Studio, llama.cpp) laufen darüber; Modelle dort via
   `GET /v1/models`-Refresh statt models.dev.
6. **Client**: neuer `ai/client.rs`, OpenAI-kompatibles
   `/chat/completions`, non-streaming in V1 (Übersetzung zeigt
   Progress-Zustand „läuft…"; Streaming ist Folgepunkt). `reqwest`
   als neue Dependency (tokio existiert). Timeouts + saubere
   Fehlertexte (Status + Provider-Fehlermeldung, gekürzt).
7. **UI**: zwei neue Bereichs-Tabs in der Settings-Region
   (opencode-Parität, verhindert eine überladene Seite):
   - **„KI-Anbieter"**: Liste der Katalog-Provider (aktivieren-Toggle,
     Key-Status + Eingabe, Endpoint-Anzeige) + Custom-Provider
     anlegen/bearbeiten/löschen (Dialog wie Screenshot: ID, Name,
     Basis-URL, Schlüssel).
   - **„KI-Modelle"**: Suchfeld, nach aktivierten Providern gruppierte
     Modelllisten mit Toggle pro Modell (Whitelist — nur getoggelte
     Modelle erscheinen in Feature-Modell-Auswahlen), Badge-Infos aus
     dem Katalog (Kontext, Reasoning/Tools, Kosten kompakt),
     „Katalog aktualisieren"-Button mit Stand-Datum.
8. **Erste Funktion Übersetzung**: Menü „Bearbeiten → Mit KI
   übersetzen…" (nur `kind-markdown`, Dokument offen): Dialog mit
   Zielsprache(n) (Mehrfachauswahl, zuletzt genutzte vorbelegt) und
   Modell-Auswahl (aus Whitelist, Default vorausgewählt). Ergebnis pro
   Sprache als `<stem>.<lang>.md` NEBEN der Quelldatei gespeichert
   (Kollision → `-1`-Suffix) und als neuer Tab geöffnet.
   Frontmatter/Codeblöcke werden vom Prompt ausdrücklich unverändert
   gelassen (Systemprompt-Regel), Übersetzung dokumentweise in einem
   Call (V1; Chunking für sehr große Dokumente ist Folgepunkt).
9. **E2E-Strategie**: realer KI-Call ist nicht testbar → das
   E2E-Szenario startet einen **lokalen Mock-Provider** (kleiner
   HTTP-Server im Python-Szenario, OpenAI-kompatible Antwort),
   registriert ihn per Automation als Custom-Provider und fährt den
   kompletten Übersetzungsfluss (Dialog → Datei entsteht → Tab
   öffnet). Automation-API erweitert um das Nötigste (siehe K2/K3).

## opencode-Parität (explizit)

Die Lösung folgt opencode so eng, wie es in einer Rust/Tauri-App
sinnvoll ist — wer opencode kennt, findet sich sofort zurecht:

| Aspekt | opencode | folio |
|---|---|---|
| Katalog | models.dev (api.json) | identisch (Snapshot + Refresh) |
| Keys | `auth.json` (separat, Klartext) | identisch, 0600, im Config-Dir |
| Custom-Provider | `provider.{id}` mit name + `options.baseURL` | identisches Schema in `ai.json` |
| Modell-Kuratierung | whitelist/Toggles pro Provider | identisch (Toggle-UI wie OpenCode Desktop) |
| UI-Aufteilung | Bereiche „Anbieter" / „Modelle" | identisch als Settings-Bereichs-Tabs |
| Custom-Dialog | ID/Anzeigename/Basis-URL/Key, Slug-Regel | identisch (inkl. Hinweistexte) |

**`ai.json`-Schema (an `opencode.json` angelehnt):**

```json
{
  "provider": {
    "opencode_zen": { "enabled": true, "whitelist": ["claude-fable-5"] },
    "myprovider": {
      "enabled": true,
      "name": "Mein KI-Anbieter",
      "custom": true,
      "options": { "baseURL": "https://api.myprovider.com/v1" },
      "models": { "some-model": { "name": "Some Model" } },
      "whitelist": ["some-model"]
    }
  },
  "defaultModel": { "provider": "opencode_zen", "model": "claude-fable-5" },
  "translate": { "recentLanguages": ["en", "fr"] }
}
```

**`auth.json`-Schema (opencode-Format):**

```json
{
  "opencode_zen": { "type": "api", "key": "sk-..." },
  "myprovider": { "type": "api", "key": "..." }
}
```

## Etappen & Checkliste

### Etappe K1 — Backend-Fundament

- [x] Modul `src-tauri/src/ai/` (`types.rs`, `catalog.rs`, `config.rs`,
      `auth.rs`, `client.rs` (Stub bis K3), `mod.rs`).
- [x] `catalog.rs`: models.dev-Snapshot einbetten (Datei
      `src-tauri/src/ai/models-dev-snapshot.json`, 1,33 MB reduziert
      aus 2,96 MB via `scripts/update-models-snapshot.py`, 150
      Provider / 5346 Modelle), Parser auf das api.json-Schema
      (tolerant gegen unbekannte Felder), Cache-Datei `ai-catalog.json`
      (Wrapper `{fetchedAt, catalog}`) + Refresh-Funktion (reqwest,
      Timeout 30 s, Fehler → Cache/Snapshot bleibt), Merge-Regel
      „neuere Quelle gewinnt" via `SNAPSHOT_DATE`-Konstante (beim
      Snapshot-Update manuell mitziehen).
- [x] `config.rs`: `AiConfigService` (ai.json, atomare Writes wie
      persist), Datenmodell gemäß Schema oben (opencode-Parität) inkl.
      serde-Default-Migration; CRUD für Custom-Provider (Slug-
      Validierung Kleinbuchstaben/Zahlen/-/_).
- [x] `auth.rs`: `AuthStore` (auth.json, 0600 inkl. Temp-File vor dem
      ersten Key-Byte, Unix-only-Guard gekapselt), set/remove/status;
      `get_key` nur `pub(crate)` für den K3-Client.
- [x] Tauri-Commands: `ai_catalog_get`, `ai_catalog_refresh`,
      `ai_config_get`, gezielte Mutationen als einzelne Commands
      (`ai_provider_enable`, `ai_model_toggle`, `ai_custom_upsert`,
      `ai_custom_delete`, `ai_default_model_set`,
      `ai_recent_languages_set`), `ai_auth_set/remove/status`.
- [x] Unit-Tests: Snapshot parst, Cache-Vorrang, ai.json-Roundtrip +
      Migration, auth-0600 + Status-ohne-Wert, Slug-Validierung.

### Etappe K2 — Settings-UI (Anbieter + Modelle)

- [ ] Bereichs-Tabs „KI-Anbieter" und „KI-Modelle" in der
      Settings-Region (Muster `settings-tab-<slug>`), Markup +
      `ui/settings-ai.ts` (eigenes Modul, settings-dialog.ts nur
      Tab-Registrierung).
- [ ] Anbieter-Panel: Katalog-Provider mit Toggle + Key-Zeile
      (Status-Punkt, „Schlüssel setzen/ändern/entfernen",
      Passwort-Input, nie Klartext-Anzeige), Custom-Provider-Dialog
      (ID/Name/Basis-URL/Schlüssel, Validierungshinweise wie im
      opencode-Screenshot).
- [ ] Modelle-Panel: Suchfeld (filtert live), Gruppierung nach
      aktivierten Providern, Toggle pro Modell, Katalog-Metadaten
      kompakt, „Katalog aktualisieren" + Standanzeige; Custom-Provider
      zeigen ihre via `GET /v1/models` geholten Modelle
      („Modelle abrufen"-Button pro Custom-Provider).
- [ ] Default-Modell-Auswahl (Dropdown über alle getoggelten Modelle).
- [ ] jsdom-Tests (Rendering, Toggle-Invokes, Key-Flows ohne
      Klartext-Leak); E2E `33_ai_settings.py` funktional
      (Custom-Provider anlegen via UI-Flow, Toggles, auth-Status;
      KEINE echten Netz-Calls — models.dev-Refresh wird NICHT
      getriggert).
- [ ] Automation-Contract: neue stabile Selektoren dokumentieren.

### Etappe K3 — Chat-Client + Übersetzungs-Feature

- [ ] `client.rs`: `chat(provider, model, messages) -> Result<String>`
      non-streaming, Bearer-Key aus AuthStore, Timeout, Fehlermapping;
      Übersetzungs-Systemprompt (Zielsprache, Markdown-Struktur/
      Frontmatter/Codeblöcke unangetastet, gleiche Formatierung).
- [ ] Command `ai_translate_document { languages, providerId,
      modelId }`: aktiver Tab muss Markdown sein; pro Sprache Call →
      Datei `<stem>.<lang>.md` (Kollisions-Suffix) → `tabs::open`.
      Lange Läufe: Command bleibt async, Frontend zeigt
      Busy-Indikator; Abbruch-Button ist Folgepunkt.
- [ ] Menüpunkt „Bearbeiten → Mit KI übersetzen…" (enabled nur bei
      kind-markdown + mindestens einem getoggelten Modell) +
      Übersetzungs-Dialog (Sprachen-Mehrfachauswahl mit
      Common-Presets, Modell-Dropdown, Merken der letzten Auswahl in
      ai.json).
- [ ] E2E `34_ai_translate.py`: lokaler OpenAI-kompatibler
      Mock-Server im Szenario, Custom-Provider via Automation
      registrieren, Übersetzungsfluss end-to-end (Datei entsteht mit
      Mock-Inhalt, neuer Tab aktiv); finally: Provider + Dateien
      aufräumen.
- [ ] Doku: CLAUDE.md-Abschnitt „KI", automation-contract, TODO-Abbau
      (KI-Eintrag), README-Satz.

## Risiken / bewusste Entscheidungen

- **Snapshot-Größe/Aktualität**: api.json ist groß; falls >1,5 MB,
  beim Einchecken auf die Provider-Felder reduzieren, die folio nutzt
  (Skript `scripts/update-models-snapshot.py` als Teil von K1).
- **Kein Streaming in V1** — Folgepunkt, ebenso Chunking großer
  Dokumente und Abbruch laufender Übersetzungen.
- **Keys in Klartext-Datei (0600)** — bewusste opencode-Parität statt
  keyring (Linux-Reibung, E2E-Headless). Im UI wird der Speicherort
  mit Hinweis angezeigt.
- **models.dev-Refresh ist der einzige Netz-Zugriff außer den
  Provider-Calls selbst** und ausschließlich user-initiiert.
- Übersetzung überschreibt nie existierende Dateien (Suffix-Regel).

## Verifikation pro Etappe

Wie gehabt: `cargo test` / `clippy -D warnings` / `fmt --check`;
bei TS-Änderungen `npm run build && npm test` + Bundles einchecken;
`bash scripts/run-e2e.sh` komplett. Pro grüner Etappe Commit auf
`main` + Checkboxen hier abhaken.
