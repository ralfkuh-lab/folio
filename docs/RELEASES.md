# Release-Strategie

Folio folgt [Semantic Versioning 2.0.0](https://semver.org/lang/de/spec/v2.0.0.html).
Versionen sind in `src-tauri/Cargo.toml` als `version = "X.Y.Z"` gepflegt,
GitHub-Releases werden mit dem Tag `vX.Y.Z` versehen.

## Versionsschema

```
MAJOR . MINOR . PATCH
```

- **MAJOR** — Breaking Changes für User oder Automation-API-Konsumenten
  (entfernte CLI-Flags, geänderte HTTP-Endpunkt-Signaturen, inkompatible
  Workspace-/Panel-State-Datei-Formate ohne Migration).
- **MINOR** — neue Features, abwärtskompatibel (neue Toolbar-Aktionen,
  neue Datei-Typ-Unterstützung, neue Automation-Endpunkte, neue
  Settings-Optionen mit sinnvollen Defaults).
- **PATCH** — Bugfixes, kein Funktionszuwachs, kein Verhaltenswechsel
  außer „funktioniert jetzt richtig".

## 0.x.y-Phase (Pre-stable)

Solange `MAJOR == 0` ist, gilt Folio offiziell als **„noch nicht stabil"**.
Konkret heißt das:

- **Breaking Changes** sind zwischen `0.X.0`-Versionen erlaubt — also
  z. B. zwischen `0.1.5` und `0.2.0` darf ein Workspace-Format brechen,
  ein Tauri-Command umbenannt werden o. ä.
- **Patch-Versionen** (`0.X.Y` mit `Y > 0`) bleiben aber strikt
  rückwärtskompatibel; sie sind sichere Bugfix-Updates.
- Jede `0.x.y`-Release wird auf GitHub mit **Pre-release-Flag**
  veröffentlicht (`gh release create --prerelease`). Damit zeigt
  GitHub das „Pre-release"-Badge, und `gh release list` zeigt das
  „neueste stabile" als das nächste verfügbare 1.x.y (sobald wir
  dort sind).
- Im UI sprechen wir umgangssprachlich von „Beta" für die 0.x.y-Phase
  — das matched die GitHub-Pre-release-Semantik.

## Wann ist 1.0.0?

Wenn folgende Punkte stehen:

- Settings-Panel ist da (heute der größte gewünschte Feature-Block).
- Workspace-/Panel-State-Format ist „eingefroren" mit Migrationen
  für ältere Versionen.
- Die E2E-Suite läuft auf Windows + Linux durchgehend grün.
- Es gibt keine bekannten Datenverlust-Bugs.
- Ein dokumentierter Release-Build-Prozess existiert (vorerst manuell,
  später ggf. CI).

Ab `1.0.0` ist jede Breaking Change ein Major-Bump (= `2.0.0`). Vorher
ist die Welt entspannter.

## Release-Workflow

Voraussetzungen:

- Working Tree clean (`git status` zeigt nichts).
- Aktueller Stand auf `main` gemerged oder auf einem Release-Branch.
- `cargo test` grün, `cargo clippy --all-targets -- -D warnings` grün,
  `cd src-tauri/web && npm run build` (inkl. `tsc --noEmit`) grün.
- Smoke-Test der gebauten Binary durchgelaufen (manuell auf Windows;
  Linux+Xvfb-E2E-Run ist Bonus, wenn verfügbar).

Schritte:

1. **Version in `src-tauri/Cargo.toml` bumpen** (MAJOR/MINOR/PATCH je
   nach Änderungs-Set).
2. **Frontend neu bauen** (`cd src-tauri/web && npm run build`), damit
   die eingecheckten Bundles dem Tag-Stand entsprechen.
3. **Commit**: `chore(release): vX.Y.Z` mit Stichwort-Liste der Highlights.
4. **Annotierter Tag**: `git tag -a vX.Y.Z -m "Folio vX.Y.Z"`. Tag-Body
   darf länger sein und Release-Notes vorwegnehmen.
5. **Tag pushen**: `git push origin vX.Y.Z`.
6. **Release-Bundles bauen**: `cd src-tauri && cargo tauri build` —
   produziert MSI + NSIS unter `target/release/bundle/{msi,nsis}/`.
   Auf Linux entsprechend `deb`/`rpm`/`AppImage`.
7. **GitHub Release** erstellen:
   ```
   gh release create vX.Y.Z \
       --prerelease \         # solange MAJOR == 0
       --title "Folio vX.Y.Z" \
       --notes-file release-notes.md \
       'target/release/bundle/msi/Folio_X.Y.Z_x64_en-US.msi' \
       'target/release/bundle/nsis/Folio_X.Y.Z_x64-setup.exe'
   ```
8. **Sanity-Check**: Release auf GitHub öffnen, Pre-release-Badge
   sichtbar? Assets ladbar? Tag matched mit Code?

## Release-Notes-Template

Eine pragmatische Vorlage in `release-notes.md`:

```markdown
## Highlights

- Drei-Punkt-Liste der wichtigsten User-sichtbaren Änderungen seit
  der letzten Release. **Was ist neu?** — kurz und konkret.

## Verbesserungen

- Punkte, die kein „Highlight" sind, aber spürbar polishen.

## Bugfixes

- Was wurde behoben.

## Bekannte Einschränkungen

- Was noch nicht funktioniert oder eingeschränkt ist. Ehrlich
  benennen, statt zu beschönigen.

## Installation

- Windows: `Folio_X.Y.Z_x64-setup.exe` oder `Folio_X.Y.Z_x64_en-US.msi`.
- Linux (`deb`-basierte Distros): `Folio_X.Y.Z_amd64.deb`.
- macOS: noch nicht gebaut.

## Commit-Log

`git log vPREV..vCURRENT --oneline` als Anhang, optional.
```

## Was nicht Teil des Schemas ist

- **`-beta.N`/`-rc.N`-Suffixe** an der Versions-Nummer. GitHub
  Pre-release-Flag tut den Job, ohne Cargo-Edge-Cases (z. B. beim
  Bundle-Naming) zu erzeugen.
- **Build-Metadata** (`+gitsha`). Build-Date + Git-Hash sind im
  About-Dialog erreichbar (kommen aus `build.rs`), nicht in der
  Versions-Nummer.
- **Calendar Versioning** (`YYYY.MM.PATCH`). Folio ist
  Feature-orientiert, nicht Date-orientiert.
