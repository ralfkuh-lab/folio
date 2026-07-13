# Freigabe-Check i18n Spec v3 — grok (Implementierer)

Stand: 2026-07-13. Gegen: `docs/spec-i18n.md` **v3**, eigener v2-Review
(`review-i18n-plan-grok.md`, B1–B5 + K1–K7), plus Kenntnis von
`review-i18n-plan-codex-v2.md`. **Keine Implementierung.**

---

## 1. Abgleich Blocker B1–B5

| ID | Thema | Status | Beleg in v3 |
| --- | --- | --- | --- |
| **B1** | I0-Key-Map / Abnahmekriterien | **Adressiert** (Spec-Kriterien scharf; Map-Artefakt separat) | `spec-i18n.md:418–426`: (a) nur kanonische Namespaces / kein `common`, (b) englische Funktions-Keys, (c) keine Test/Log/False-Positives, (d) Wrapper-Spalte HTML, (e) Plural- + Locale-Listen; **„Ohne I0-Abnahme startet I1a nicht“**. Naming: englische Segmente (`:44–45`, `:104–106`), `common` verboten außer `dialogs.common.*` (`:107–112`, `:120–122`). Für den Orchestrator abnahmefähig — Implementierer braucht keine weiteren Spec-Nachschärfungen an B1. |
| **B2** | `MenuLabels`-Lifetime | **Adressiert** | `String`-Felder, kein `Copy`; `labels() -> &'static MenuLabels` aus Boot-`OnceLock`; kein Leak; Hardcodes weg; de/en-Test über **lokale** `Translator`-Instanzen (`:210–217`). Call-Sites bleiben Borrower — umsetzbar gegen `menu/strings.rs` + `menu/build.rs`. |
| **B3** | Automation-Ready-Handshake | **Adressiert** (Inhalt I1b/I1c, nicht I1a) | Dreiphasiger Bootstrap booting → i18nReady → uiReady, Queue-Drain erst bei uiReady, `frontend_ready`, AtomicBool/Notify, Routen-Matrix wartend/nicht, `/state.frontendReady`+`lang`, Runner-Poll (`:297–342`, `:387–389`, `:452–455`, `:466–468`). |
| **B4** | Dritter Test-Katalog vs. Prod-Registry | **Adressiert** | `generate_registry(dir)` parametrisiert; Prod nur `locales/`; Fixture `tests/fixtures/locales/fr.json` außerhalb Glob; Erweiterbarkeit = Temp-Dir + Generator (`:69–94`, `:20–23`, `:443`). |
| **B5** | I1 zu fett | **Adressiert** | I1a Rust-TDD / I1b Frontend+Gate / I1c Referenz+E2E-Pin (`:428–469`). Katalog-Hotspot sequentiell (`:495`, `:543–544`). |

**K1–K7** (Build-Vertrag, Bootstrap, Referenz-Scan, Dead-Keys soft, Wrapper-Spalte, `thiserror`-Muster): in v3 eingearbeitet (`:69–88`, `:297–342`, `:403–412`, `:223–230`, `:349–351`). Kein offener Klärungs-Blocker aus dem v1-Implementierer-Review.

---

## 2. I1a mit v3 — implementierbar ohne gefährliches Raten?

**Ja.** Die I1a-Checkliste (`:428–445`) ist gegen den realen Code (drei Settings-Loads, `MenuLabels`, `build.rs`, `persist::load_json`) so geschlossen, dass Design-Raten entfällt. Arbeitsumfang ist klar abgegrenzt: **kein** Frontend, **kein** E2E-Pin, **kein** Referenz-Scan.

### Was in I1a konkret festliegt (kein Raten)

- Generator + `build.rs`: Directory- + per-file-`rerun-if-changed`, fail-closed, `OUT_DIR`, Reihenfolge vor `tauri_build` (`:69–88`).
- `Translator`/`CatalogRegistry` instanziierbar; `OnceLock` nur Fassade; `{count}`-Injektion, atomare Plural-Merges (`:200–208`, `:241–256`).
- Migration-Zustandsmaschine inkl. Sprach-Extraktion vor typisiertem Load, Artefakt-Kriterium, Testmatrix (`:160–188`).
- Resolver: `catalogTag` + `formatLocale` getrennt; Patch nur Registry-Tag/`system` (Automation 400) (`:133–158`, `:439`).
- Boot-Owner: ein Settings-Load, Logging ohne eigenen Zweit-Load, Menü nach i18n (`:190–198`).
- `menu.*`-Katalog aus den heutigen Labels in `menu/strings.rs` (Felder `:10–46`); `fr`-Fixture-Test.

### Restliste — unkritisch (kein NACHARBEIT, Implementierer-Defaults ok)

1. **CLDR-Batch-Liste im Fließtext:** Ziel verweist auf „geplanten Sprach-Batch, s. u.“ (`:18–20`), die V1-Regelliste (früher de/en/es/fr/…/ko) steht in v3 nicht mehr explizit; Folgepunkt nennt Batch 2 (`:548–549`). **I1a-Minimum klar:** de, en + fr (Fixture). Weitere Batch-Regeln in I1a mitziehen, sobald im Generator referenziert — bei Zweifel Orchestrator, kein Architektur-Raten.
2. **Öffentlicher Builder-Name** `MenuLabels` aus `Translator` (Testpfad): Spec verlangt lokale Instanzen (`:214–217`), API-Name frei wählbar (`MenuLabels::from_translator` o. ä.).
3. **OS-Locale-Crate:** „OS-Tag“ ohne Crate-Name — Default `sys-locale` (üblich, ungefährlich).
4. **I0-Gate prozessual:** I1a startet erst nach Map-Abnahme (`:424–426`). Technisch bräuchte I1a nur `menu.*`; das härtere Gate ist gewollt und akzeptiert.

Nichts davon ist ein Blocker für den ersten TDD-Commit von I1a.

---

## 3. Verdikt

### **BEREIT** (für I1a nach I0-Abnahme)

v3 räumt B1–B5 und den relevanten Klärungsbedarf aus. Sobald die I0-Map die Kriterien in `spec-i18n.md:418–426` erfüllt und der Orchestrator abgenommen hat, implementiere ich **I1a** ohne weitere Spec-Rückfragen.

**Nicht Teil dieser Freigabe:** I1b/I1c (dort greifen Bootstrap-Ereignisliste und exakte Startup-Timeouts — spezifiziert genug zum Starten, Feinschliff in der Etappe). I2+ hängen weiter an der abgenommenen I0-Map.
)
