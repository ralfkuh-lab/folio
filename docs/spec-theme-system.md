# Spec: Theme-System-Ausbau (In-App-Editor, Corporate Design, KI-Autor)

> **Arbeitsdokument mit Fortschritts-Checkliste** (Muster:
> [`spec-ki-tab.md`](spec-ki-tab.md) / [`spec-multi-tabs.md`](spec-multi-tabs.md)).
> Status pro Etappe: ⬜ offen · 🔧 in Arbeit · ✅ umgesetzt · ❌ wontfix.
> Beschlossen am 2026-07-06 (Design-Session mit User-Entscheidungen, siehe
> „Architektur-Entscheidungen“). Dieses Dokument ist selbsttragend — alle
> Verträge, Pfade und Begründungen stehen hier bzw. in
> [`CLAUDE.md`](../CLAUDE.md).

## Ziel

Corporate Designs sollen in folio leicht abbildbar sein. Dafür bekommt das
bestehende View-Theme-System („Layouts“ in `src-tauri/src/export.rs`):

1. **In-App-Verwaltung + Editor**: Themes anlegen, bearbeiten (Monaco-CSS-
   Editor mit Live-Vorschau), clonen (auch von Built-ins), löschen — statt
   des heutigen „CSS-Datei von Hand in `<config>/folio/themes/` legen“.
2. **Erweitertes Paketformat** für Export-Features, die CSS allein nicht
   kann: Deckblatt, Kopf-/Fußzeile mit Logo, eingebettete Assets
   (data-URI), Frontmatter-Metadaten als Template-Variablen.
3. **8 neue Built-in-Vorlagen** in verschiedenen Farbschemas.
4. **KI-Theme-Autor** (Stufe 1): erzeugt/verfeinert deterministische
   Theme-Pakete über die bestehende KI-Infrastruktur (`ai/client.rs`).
   Ein dynamischer KI-Lauf pro Export ist bewusst NICHT Teil dieser Spec
   (Stufe 2, siehe „Bewusst verschoben“).

## Ausgangslage (Stand 2026-07-06)

- Themes sind Flat-Dateien: `<id>.css` (Pflicht, `.markdown-body`-gescopt)
  + optional `<id>.dark.css` / `<id>.page.css` in `persist::themes_dir()`
  (= `<config>/folio/themes/`, wird nicht auto-angelegt). Metadaten in den
  ersten 10 Zeilen: `/* name: … */`, `/* description: … */`,
  `/* code: dark|light */` (`parse_theme_metadata`, export.rs).
- Built-ins `standard`/`classic`/`clean`/`github` via `include_str!` aus
  `src-tauri/src/layouts/`. `valid_theme_id()` (export.rs) ist der
  Traversal-Guard. Alle Backend-Theme-Funktionen sind heute **read-only**
  — es gibt keine Schreib-Commands.
- Export: `render_document_in` → `wrap_html(title, css, body)`
  (export.rs) = reiner `format!`-Bau, **kein Template-Layer**. CSS-Ordnung
  page_css → content_css → `layouts/base.css`. Kein Deckblatt, keine
  Kopf-/Fußzeilen, keine Assets, kein Zugriff auf Frontmatter-Werte
  (Frontmatter wird nur inline als `<aside>` in den Body gerendert).
- PDF: `pdf_export.rs` ruft headless Chromium
  (`--headless=new --no-pdf-header-footer --print-to-pdf`), Temp-HTML im
  Dokument-Source-Dir (wegen relativer Bildpfade).
- Settings: `view_theme` + `theme_favorites` in `settings.json`, validiert
  gegen `export::view_themes()`. Verwaltungs-UI existiert nur als Hinweis-
  Text („CSS-Dateien in <pfad> ablegen“) in `settings-dialog.ts`.
- KI: generischer OpenAI-kompatibler Client (`ai/client.rs::chat` /
  `chat_stream_cancellable`), Provider-/Key-Auflösung liegt inline in
  `commands/ai.rs::ai_translate_document` (~Zeilen 261-283, noch nicht
  extrahiert).

## Architektur-Entscheidungen (verbindlich, mit User beschlossen)

1. **KI stufenweise**: erst KI-als-Autor (erzeugt normale, deterministische
   Theme-Dateien), der dynamische Per-Export-KI-Modus später als eigene
   Stufe. Der Draft→Review→Save-Pfad (E6) hält Stufe 2 offen.
2. **Alle vier Corporate-Design-Fähigkeiten**: Deckblatt, Kopf-/Fußzeile
   (ohne Live-Seitenzahl, s. u.), Logo/Assets als data-URI,
   Frontmatter-Metadaten als Template-Variablen.
3. **Theme-Editor als eigener virtueller Tab** (wie der Settings-Tab:
   Vollflächen-Region + Frontend-only-Tab in der Leiste), nicht im
   Settings-Bereich eingequetscht — Monaco + Vorschau brauchen Platz.
4. **Breites Vorlagen-Set**: 8 neue Built-ins (business, report, minimal,
   brand, warm, tech, contrast, pastel), alle mit Dark-Variante.
5. **Seitenzahlen im PDF vorerst raus** (User-Entscheid 2026-07-06,
   „nicht so wichtig“) — Befund und Lösungsweg unter „Bewusst verschoben“
   dokumentiert, damit nichts verloren geht.

## Paketformat: Verzeichnis-pro-Theme, Legacy bleibt lesbar

```
<config>/folio/themes/
  altes-theme.css / .dark.css / .page.css   # LEGACY flat — weiterhin discovered
  meincorp/                                 # NEU: Verzeichnis-Theme
    theme.json        # Manifest (Pflicht → markiert Dir-Theme)
    content.css       # Pflicht, .markdown-body-gescopt (== <id>.css)
    content.dark.css  # optional (Dark-Override, wird ans Light-CSS angehängt)
    page.css          # optional (Export-only Seitenrahmen)
    cover.html        # optional (Export-only Deckblatt)
    header.html       # optional (Export-only Kopfzeile)
    footer.html       # optional (Export-only Fußzeile)
    assets/           # optional (logo.png, watermark.svg, …)
```

`theme.json` (serde, camelCase): `name`, `description`,
`code` (`"light"|"dark"`, Export-syntect-Palette wie heute),
`logo` (Default-Asset-Dateiname für `{{logo}}`), `cover`/`header`/`footer`
(bool-Feature-Flags), `hideInlineFrontmatter` (bool, Default false),
`formatVersion` (Zahl, startet bei 1).

Regeln:

- **Discovery liest beide Formen**; CRUD und KI-Autor schreiben
  ausschließlich das Verzeichnisformat. `parse_theme_metadata` bleibt für
  Legacy-Flat unverändert.
- **Präzedenz**: Built-in-ID > Dir-Theme > Legacy-Flat. Kollision →
  `tracing::warn!` + skip des Verlierers. Dir ohne `content.css` = kein
  gültiges Theme (skip + warn).
- `valid_theme_id()` bleibt der Traversal-Guard für IDs; Asset-Dateinamen
  werden zusätzlich validiert (kein `/`, `\`, `..`, kein absoluter Pfad).
- **Atomares Schreiben**: kompletter Theme-Write in Temp-Verzeichnis +
  `fs::rename` (Analogon zu `persist::save_json_atomic` bzw.
  `tempfile.persist` in `commands/file/image.rs`).
- Clone-from-Builtin materialisiert die eingebetteten CSS-Strings (und ggf.
  Templates) in ein neues Dir-Theme.

## Template-Mechanismus

- Minimaler `{{key}}`-Ersatz, **keine Engine-Dependency**. Ein einziger
  Regex-Pass (`\{\{\s*([a-zA-Z]+)\s*\}\}`), **kein rekursives
  Re-Substituieren** (verhindert Injection über substituierte Werte).
- Platzhalter-Whitelist: `title`, `subtitle`, `author`, `company`, `date`,
  `logo`. (`pageNumber`/`totalPages` bewusst NICHT — siehe „Bewusst
  verschoben“.) Unbekannte/nicht gesetzte Platzhalter → leerer String.
- Werte werden **immer HTML-escaped** (bestehendes `escape_html`
  wiederverwenden). `{{logo}}` expandiert zu `<img src="data:…">` aus dem
  Manifest-`logo`-Asset; ohne Logo → leer.
- **`TemplateContext`** aus `frontmatter::extract(markdown).entries` mit
  case-insensitivem Alias-Lookup: `title`/`titel`, `author`/`autor`,
  `company`/`firma`/`organisation`, `date`/`datum`,
  `subtitle`/`untertitel`. Fallbacks: title ← Frontmatter, sonst
  `derive_title(path)`; date ← Frontmatter, sonst heutiges Datum
  (`%d.%m.%Y`). Für deterministische Tests ist das „heute“ injizierbar
  (Parameter der `_in`-Variante, Tests setzen alternativ Frontmatter-date).
- **Trust-Modell**: User-authored `cover/header/footer.html` haben dieselbe
  Trust-Stufe wie Custom-CSS heute — sie werden NICHT saniert, nur die
  eingesetzten Variablenwerte werden escaped. **KI-generierte Templates**
  MÜSSEN durch das Validierungs-Gate (siehe E6): Tag-/Attribut-Allowlist,
  kein `<script>`, keine `on*`-Handler, `src`/`href` nur `data:`/`asset:`.

## Assets → data-URI

- Einbettung ist **Pflicht**, nicht optional: der PDF-Pfad schreibt das
  Temp-HTML ins Dokument-Source-Dir (`pdf_export.rs`) — relative Pfade ins
  Theme-Verzeichnis lösen dort nicht auf. data-URI = selbstenthaltender
  Export, konsistent mit den syntect-Inline-Styles.
- MIME per Extension-Map (cross-platform, KEIN xdg-mime): png/jpg/jpeg/
  gif/webp/avif/svg/bmp/ico. Unbekannte Endung → abgelehnt.
- Größen-Limits: ~5 MB pro Asset, ~15 MB gesamt pro Export — Überschreitung
  ist ein **harter Fehler** (verhindert MB-HTML/PDF-Explosion).
- SVG-Sicherheit: Assets ausschließlich via
  `<img src="data:image/svg+xml;base64,…">` (Bild-Kontext führt kein
  Script aus), nie inline ins DOM.
- CSS-Rewrite: `url(asset:logo.png)` → `url(data:…)` (Regex
  `url\(\s*asset:([^)]+)\)`, nur eigener Theme-Ordner) — für
  Hintergrund-Logos/Wasserzeichen in `content.css`/`page.css`.

## Export-HTML-Struktur

`wrap_html` bekommt statt Arg-Explosion einen `WrapContext`-Struct
(`{ title, css, body_html, cover_html?, header_html?, footer_html? }`):

```html
<body>
  <div class="folio-running-header">…</div>   <!-- position:fixed → wiederholt pro Druckseite -->
  <div class="folio-running-footer">…</div>
  <section class="folio-cover">…</section>    <!-- break-after: page -->
  <article class="markdown-body">…</article>
</body>
```

- Deckblatt-Umbruch via `.folio-cover { break-after: page; }`; Voll-Bleed
  über `@page :first { margin: 0; }` (Chromium unterstützt `:first`).
- Header/Footer-DIVs nur einfügen, wenn das jeweilige Template existiert.
- CSS-Reihenfolge unverändert (page → content → BASE_CSS); die
  Print-Regeln für `.folio-cover`/`.folio-running-*` kommen in
  `layouts/base.css`, damit alle Themes profitieren.
- `hideInlineFrontmatter`-Manifest-Flag: rendert den Body ohne das
  Frontmatter-`<aside>` (vermeidet Doppelung mit Deckblatt-Metadaten).
  Default false = abwärtskompatibel.
- **View-Mode**: `view_theme_css` liefert weiterhin NUR content_css
  (+dark). cover/header/footer/page sind Export-only und werden in der
  App-View ignoriert — exakt die bestehende page.css-Trennung, kein neuer
  Command nötig. `export_render` (iframe-Preview im Export-Dialog) läuft
  über `render_document` und zeigt Deckblatt/Kopfzeile automatisch mit.
- Chromium-Verifikation (2026-07-06): Deckblatt und
  `position:fixed`-Header/Footer inkl. Logo funktionieren mit dem
  aktuellen `--print-to-pdf`-CLI-Pfad; Chromium wiederholt fixe Elemente
  pro Druckseite.

## Backend-Modul + Commands

Neues Modul `src-tauri/src/theme/` — `export.rs` bleibt
Render-Orchestrator, `export::{LayoutInfo, view_themes, view_theme_css,
layouts}` bleiben als **stabile Oberfläche** bestehen (settings.rs und
lib.rs hängen daran) und delegieren intern:

```
theme/mod.rs       # Re-Exports, LayoutInfo, Discovery (Flat + Dir vereint)
theme/package.rs   # ThemePackage-Modell, Manifest, load_package(id, dir)
theme/builtin.rs   # eingebettete Builtins (include_str!) inkl. Templates
theme/template.rs  # Platzhalter-Engine + Escaping, TemplateContext
theme/assets.rs    # Asset→data-URI, MIME-Map, Limits, asset:-URL-Rewrite
theme/store.rs     # CRUD: create/write/delete/clone (atomar), Asset add/rm
theme/author.rs    # KI-Autor: Prompt-Contract, JSON-Parse, Validierungs-Gate
```

`ThemePackage` (intern): id, content_css, dark_css?, page_css?,
cover_html?, header_html?, footer_html?, manifest,
source (`Builtin|LegacyFlat|Directory`), dir? (für Asset-Auflösung).

Neue Tauri-Commands in `src-tauri/src/commands/theme.rs` (alle
`#[tauri::command] pub async`, `Result<_, String>`, Registrierung in
`lib.rs` neben `commands::export::*`):

```
theme_read(id) -> ThemeFiles            # { manifest, contentCss, darkCss?, pageCss?,
                                        #   coverHtml?, headerHtml?, footerHtml?,
                                        #   assets: Vec<AssetInfo>, source }
theme_write(id, files) -> LayoutInfo    # atomar; legt auch neu an
theme_delete(id) -> ()                  # nur Custom, Traversal-Guard
theme_clone(source_id, new_id) -> LayoutInfo   # auch von Built-ins
theme_asset_add(id, filename, bytes_base64) -> AssetInfo
theme_asset_remove(id, filename) -> ()
theme_preview_render(markdown?, parts, dark) -> String
                                        # Export-HTML aus UNGESPEICHERTEN Parts,
                                        # für iframe-srcdoc im Theme-Editor
ai_theme_author(prompt, base_id?, provider_id, model_id) -> ThemeDraft
ai_theme_author_cancel() -> ()
```

- `theme_asset_add` nimmt Base64 (kein Quellpfad), analog
  `save_clipboard_image`: Backend validiert MIME/Größe und schreibt atomar
  nach `themes/<id>/assets/<filename>`.
- Nach jedem erfolgreichen Write/Delete/Clone/Asset: Event
  **`themes:changed`** → Frontend liest `view_themes` neu (Discovery ist
  stateless, kein Cache zu invalidieren).
- **State** (`state.rs`): `theme_write: Mutex<()>` gegen konkurrierende
  CRUD-Writes; KI-Autor spiegelt das Translate-Muster:
  `theme_author_active: Mutex<bool>` + `theme_author_cancel:
  Arc<AtomicBool>` + Drop-Guard (wie `ActiveTranslation`). `ai_http` /
  `ai_auth` / `ai_config` werden wiederverwendet. Kein In-Memory-Theme-
  Cache — das Dateisystem bleibt Source of Truth.

## Frontend-Design

### Virtual-Tab-Registry (`web/app/state/tabs.ts`)

Heute ist genau EIN virtueller Tab hartkodiert (`settingsTabOpen` +
`settingsTabHooks`). Generalisierung mit minimaler Churn:

```ts
interface VirtualTab {
    slug: string;                 // 'settings' | 'theme-editor'
    label: () => string;          // '⚙ Einstellungen' bzw. '🎨 <Theme-Name>'
    dirty?: () => boolean;        // Dirty-Punkt am Leisten-Tab
    onActivate: () => void;
    onClose: () => void;
}
// Map<slug, VirtualTab> + activeVirtualSlug: string | null
```

- `configureSettingsTab` / `setSettingsTabOpen` bleiben als dünne
  Kompat-Wrapper — kein Aufruferbruch.
- Settings + Theme-Editor können **gleichzeitig offen** sein (beide in der
  Leiste), aber höchstens einer ist **aktiv**. Die aktive Region setzt die
  Body-Klasse: `settings-open` XOR `theme-editor-open`; die inaktive-aber-
  offene Region ist nur als Leisten-Tab präsent.
- Klick auf einen Dokument-Tab deaktiviert die virtuelle Region
  (bestehendes Settings-Verhalten).

### Dritte Monaco-Surface `window.FolioThemeEditor`

- Neu `web/editor/theme-editor.ts`, komponiert in `web/editor/index.ts`
  (analog `FolioCodeView`). Gleicher AMD-Loader via `whenMonacoLoaded()`
  aus `mount.ts` — Monaco wird NIE erneut geladen.
- **Model-pro-Part** (content/dark/page → `css`; cover/header/footer →
  `html`): erhält Undo-Stack und Cursor pro Datei beim Umschalten
  (`editor.setModel`), niemals `setValue` (CLAUDE.md-Konvention —
  `setValue` cleart den Undo-Stack).
- API: `mount`, `setParts`, `showPart`, `getPart`, `getAllParts`,
  `isDirty`, `onChange`, `setTheme`, `dispose`, `layout`.
- `web/app/editor/shell.ts::setEditorTheme` bekommt den **dritten
  Fan-out** (`FolioThemeEditor?.setTheme(...)`) — sonst hängt der Editor
  beim App-Theme-Wechsel auf dem alten Monaco-Theme. `globals.d.ts`
  erweitern.
- Dispose-Disziplin wie `mount.ts::disposeTabModel` (`setModel(null)` vor
  Model-Dispose, keine toten Referenzen im Part-Cache).

### Theme-Editor-Region

- Markup `#theme-editor-dialog` in `src-tauri/dist/index.html` als
  Geschwister von `#settings-dialog` in der `.content-region`:
  Toolbar (File-Switcher über die Parts, Dark-Preview-Toggle,
  „Mit KI anpassen…“, „Speichern“ (disabled bis dirty), „Schließen“),
  Body = Monaco-Mount links + `<iframe sandbox="allow-same-origin">`
  rechts. Der File-Switcher wird dynamisch aus dem Manifest gefüllt;
  Logo-Upload über `<input type=file>` + `theme_asset_add`.
- Neues `web/styles/theme-editor.css`, in `styles/index.css` einhängen.
  Body-Klassen-Regeln: `settings-open`/`theme-editor-open` blenden
  `.content-panes` und die jeweils andere Region aus.
- Controller `web/app/ui/theme-editor.ts`: `openThemeEditor(id)`
  (`theme_read` → `setParts` → Registry-Registrierung → Preview),
  `saveThemeEditor()` (`theme_write` mit allen Parts → `themes:changed`
  → Dirty-Reset), `guardedClose()` mit Dirty-Guard über das bestehende
  `#unsaved-dialog`-Muster. **Alle drei Schließpfade** (Leisten-X,
  Dokument-Tab-Klick, Escape) laufen durch `guardedClose`; der
  Escape-Handler greift nur, wenn die Theme-Editor-Region aktiv ist.

### Live-Preview

- **Strikt iframe + srcdoc** via `theme_preview_render` — NIEMALS über
  `#view-theme-style`: die echte App-View wird erst nach dem Speichern
  über `themes:changed` → `reapplyCurrentViewTheme()` aktualisiert.
- Debounce 150 ms + monotone Generation-Token gegen verspätete Antworten
  — Muster aus `view/preview.ts` **nachbauen, nicht importieren**
  (preview.ts ist an die View-Region gekoppelt).
- Markdown-Quelle: aktuelles Dokument (Store-Text), sonst gebündeltes
  Sample-Markdown (zeigt Headings/Code/Tabelle/Blockquote/Frontmatter).
- Dark/Light-Toggle rendert nur die Preview neu, nie die App.

### Verwaltungs-UI (Settings → Markdown-Themes)

- `settings-dialog.ts::renderViewThemes`: Karten bekommen eine
  Aktionsgruppe — Custom: „Bearbeiten“ / „Duplizieren“ / „Löschen“;
  Built-in: nur „Duplizieren“ (`standard` gar keine). `stopPropagation`
  wie beim bestehenden Favoriten-Stern (Karte = Radio-Select).
- „Neues Theme“-Button + Create/Clone-Overlay nach dem
  `#ai-custom-dialog`-Muster (`settings-ai.ts::openCustomDialog`): Felder
  ID (Slug), Anzeigename, Basis-Theme-`<select>`. Nach Erfolg öffnet
  direkt der Theme-Editor (nahtloser Flow anlegen → bearbeiten).
- `themes:changed`-Listener: settings-dialog.ts (Liste neu),
  `view/theme.ts` (`reapplyCurrentViewTheme`), Export-Dialog braucht
  nichts (liest `export_layouts` bei jedem Open frisch).

### KI-Dialog (`web/app/ui/theme-ai-dialog.ts`)

- Overlay im Theme-Editor: Prompt-Textarea + Modell-Picker +
  Streaming-Status + Abbrechen (Events `ai:theme_stream` /
  `ai:theme_done`, Cancel-Command).
- Vorab **`web/app/ui/ai-model-picker.ts` extrahieren**: die
  Picker-Logik existiert dupliziert in `translate-dialog.ts::renderModels`
  und `settings-ai.ts::renderDefaultModels` (enabled Provider ×
  Whitelist, Option-value = `JSON.stringify([providerId, modelId])`,
  defaultModel-Preselect). Translate-Dialog auf das Modul umstellen.
- Ergebnis (`ThemeDraft`) wird in die **Editor-Buffer** geschrieben
  (dirty, NICHT auto-gespeichert) — der User reviewt und speichert selbst.

## KI-Autor (Stufe 1)

1. **Vorab-Refactor**: `resolve_provider(state, provider_id, model_id) ->
   (base_url, api_key)` aus `ai_translate_document`
   (`commands/ai.rs:261-283`) extrahieren — Translate und Autor teilen den
   Pfad. Reiner Refactor, durch E2E-Szenario 34 abgesichert.
2. Muster `ai_translate_document`: Active-Guard (Drop-Struct),
   `chat_stream_cancellable`, AtomicBool-Cancel (Poll alle 250 ms),
   Event-Throttle 150 ms.
3. **System-Prompt = Format-Contract**: Ausgabe als striktes JSON
   (`manifest`, `contentCss`, `darkCss`, `pageCss`, `coverHtml`,
   `headerHtml`, `footerHtml` — fehlende/leere erlaubt). Regeln im Prompt:
   CSS nur auf `.markdown-body` scopen; Custom-Property-Konvention
   (`--fg/--muted/--rule/--rule-soft/--accent/--code-bg/--quote-bar`);
   nur Whitelist-Platzhalter; kein `<script>`, keine externen URLs, kein
   `@import`. Bei `base_id`: aktuelle Theme-Dateien als Kontext
   (Verfeinerungs-Modus).
4. **Validierungs-Gate** vor jeder Übernahme (Fehler statt stiller
   Übernahme — analog zum `mask::unmask`-Gate der Übersetzung):
   - ID (bei Neuanlage) via `valid_theme_id`, keine Built-in-Kollision.
   - CSS: nicht leer, ausgewogene `{}`, kein `@import` / `url(http…)` /
     `expression(` / `javascript:`; Warnung, wenn der Scope
     `.markdown-body` verlassen wird.
   - Templates: nur Whitelist-Platzhalter; HTML-Allowlist-Sanitizer
     (Tags: div/section/header/footer/h1-h3/p/span/img/table/tr/td/br/
     strong/em; Attrs: class, eingeschränktes style, src nur
     `data:`/`asset:`, alt; kein `on*`). Kleiner eigener Sanitizer in
     `theme/author.rs`, keine neue Dependency.
   - Assets: der Autor erzeugt KEINE Binärassets, referenziert nur
     `{{logo}}` bzw. `asset:`-URLs auf vorhandene Dateien.
5. Rückgabe als **`ThemeDraft`** (NICHT persistiert) → Frontend schreibt
   in die Editor-Buffer → Preview via `theme_preview_render` → User
   bestätigt → `theme_write`. Dieser Draft/Preview/Confirm-Pfad ist die
   Andockstelle für die spätere dynamische Per-Export-Stufe.

## Neue Built-in-Themes (8)

Eingebettete CSS via `include_str!` in `src-tauri/src/layouts/`, deutsche
Beschreibungen wie die bestehenden. Alle nutzen die
Custom-Property-Konvention → Dark-Variante ist ein kleines Override:

| id | Richtung |
|---|---|
| `business` | seriös, Sans, Akzent-Blau · +dark +page |
| `report` | Serifen, formelle A4-Report-Optik · +dark +page |
| `minimal` | maximal reduziert, viel Weißraum · +dark |
| `brand` | kräftiger Markenakzent, Cover-tauglich, Clone-Basis · +dark +page |
| `warm` | warme Sepia-/Erdtöne · +dark |
| `tech` | Mono-Headings, dichter Code-Look · +dark |
| `contrast` | hoher Kontrast / barrierearm · +dark |
| `pastel` | weiche Pastelltöne · +dark |

`business` und `brand` shippen zusätzlich eingebettete
`cover/header/footer`-Templates (auch `include_str!`) — belegt den
Extended-Pfad end-to-end und dient als Clone-Basis fürs Corporate Design.
Das Builtin-Modell muss dafür optionale Template-Strings tragen.
Registrierung: `BUILTIN_IDS`, `builtin_layouts()`, `layout_css_in`-/
`page_css_in`-Match erweitern. Binärgröße unkritisch (< 100 KB gesamt).

## Etappen

### E1 — Theme-Paketmodell + Discovery ✅

`theme/`-Modul (mod/package/builtin), Dir+Legacy-Discovery mit
Präzedenzregeln, Manifest-Parse + Fallbacks, `export::*`-Oberfläche als
Delegation. **Kein Render-Verhalten geändert.** Unit-Tests im
tempdir-Stil (Vorlage: bestehende Tests in `export.rs`).

### E2 — CRUD-Commands + Verwaltungs-UI ✅

`commands/theme.rs` (`theme_read/write/delete/clone`), `theme_write`-Lock,
`themes:changed`-Event, lib.rs-Registrierung. Frontend: Karten-Aktionen +
„Neues Theme“ + Create/Clone-Overlay in `settings-dialog.ts`,
`themes:changed`-Listener. jsdom-Tests (settings-dialog), E2E-Szenario
`35_theme_crud.py` (via `__folioInvoke`; Custom-Themes sind echte Dateien
unter `<config>/folio/themes/` → **finally-Cleanup** zwingend).

### E3 — Theme-Editor als virtueller Tab ✅

Virtual-Tab-Registry in `state/tabs.ts` (+ Kompat-Wrapper + jsdom-Tests),
`FolioThemeEditor`-Surface (Model-pro-Part, Dirty-Tracking, shell.ts-
Fan-out, globals.d.ts), Region `#theme-editor-dialog` + `theme-editor.css`,
Controller mit guardedClose (drei Schließpfade), `theme_preview_render`-
Command, debounced iframe-Preview + Dark-Toggle, Sample-Markdown.
Frontend-Bundles neu bauen (`cd src-tauri/web && npm run build`), danach
`cargo build` (frontendDist-Embed, sonst läuft die EXE mit altem Bundle).

### E4 — Neue Built-ins (8) ✅

Reine CSS-Addition + Registrierung + `business`/`brand`-Templates.
Unabhängig von E2/E3, parallelisierbar.

### E5 — Template + Cover + Assets ✅

Platzhalter-Engine + `TemplateContext` (Frontmatter-Aliasse, injizierbares
Datum), data-URI-Assets + `theme_asset_add/remove` + Logo-Upload-UI,
`wrap_html` → `WrapContext`, `@page :first` + `break-after`,
Fixed-Header/Footer (ohne Live-Seitenzahl), `hideInlineFrontmatter`,
base.css-Print-Regeln, File-Switcher dynamisch (HTML-Parts).
Inklusive Vorab-Refactor `resolve_provider` (E2E 34 als Gate).

### E6 — KI-Theme-Autor ✅

`theme/author.rs`, `ai_theme_author(_cancel)` + State-Guards, Streaming-
Events, Validierungs-Gate, `ai-model-picker.ts`-Extraktion (Translate-
Dialog umstellen), `theme-ai-dialog.ts`, Draft→Buffer→Review→Save.
E2E-Szenario `36_ai_theme_author.py` mit Mock-Provider
(ThreadingHTTPServer + SSE, Muster `34_ai_translate.py` inkl.
Provider-Setup/-Cleanup-Helpern).

### E7 — Theme-Import/Export als `.mdtheme` ⬜ (nachbeauftragt 2026-07-07)

**Format**: ein `.mdtheme` ist ein gewöhnliches ZIP mit dem
Verzeichnis-Paketformat **1:1 an der Archiv-Wurzel** (`theme.json`
Pflicht, `content.css` Pflicht, optional `content.dark.css`, `page.css`,
`cover.html`, `header.html`, `footer.html`, `assets/<datei>`), kein
Unterordner, kein neues Schema — `formatVersion` im Manifest trägt die
Kompatibilität. Umbenennen in `.zip` macht es manuell inspizierbar.

- **Export**: `theme_export(id, path?) -> Option<String>` — ohne `path`
  Save-Dialog (`blocking_save_file`-Muster aus `commands/export.rs`,
  Filter `*.mdtheme`, Default `<id>.mdtheme`), mit `path` direkt
  (Automation/E2E — native Dialoge sind in Xvfb unerreichbar);
  schreibt das ZIP atomar (tempfile + persist). Auch Built-ins sind
  exportierbar (materialisiert wie `theme_clone`) — als Weitergabe-Basis.
- **Import**: `theme_import(path?) -> Option<LayoutInfo>` — ohne `path`
  Open-Dialog, mit `path` direkt (Automation/E2E); danach das
  **Import-Gate** (Grenzübertritt, analog KI-Gate):
  - Eintrags-Whitelist: exakt die bekannten Dateinamen +
    `assets/<name>` mit `validate_asset_filename`; alles andere →
    Fehler. Keine Verzeichnis-Traversal-Namen (Zip-Slip), keine
    absoluten Pfade, nur reguläre Dateien (keine Symlink-Einträge).
  - Zip-Bomb-Schutz: entpackte Gesamtgröße hart gedeckelt (32 MB),
    pro Asset das bestehende 5-MB-Limit; Text-Parts je max 2 MB.
  - Manifest wird geparst + `normalize`d; `formatVersion` > aktuell →
    Fehler mit klarer Meldung.
  - Ziel-ID: Slug aus Dateinamen (`valid_theme_id`-bereinigt);
    Kollision → `-2`/`-3`-Suffix statt Überschreiben.
  - Schreiben ausschließlich über den bestehenden atomaren
    `store::write_parts_in`-Pfad + Assets einzeln validiert —
    danach `themes:changed`.
- **UI** (Settings → Markdown-Themes): Karten-Aktion „Exportieren…“
  (alle außer `standard`), Button „Theme importieren…“ neben
  „Neues Theme“. Erfolg → Liste refresht via `themes:changed`;
  Import-Fehler in bestehender Fehlerdarstellung.
- **Dependency**: `zip`-Crate (ohne Default-Features, `deflate`).
- **Tests**: Rust-Unit (Roundtrip Export→Import inkl. Assets,
  Zip-Slip-Eintrag, überlange Einträge, unbekannte Datei, Symlink-
  Eintrag, formatVersion-Zukunft, Kollisions-Suffix), jsdom
  (Buttons/Refresh), E2E `37_theme_import_export.py` (Roundtrip über
  Temp-Datei, finally-Cleanup).

## Bewusst verschoben

- **Live-Seitenzahlen im PDF** (User-Entscheid 2026-07-06): Chromiums
  CLI-Pfad (`--print-to-pdf`) rendert `counter(page)` nur in
  `@page`-Margin-Boxen, deren Content Blink nicht implementiert; der
  CLI-Schalter exponiert auch kein header/footerTemplate. Lösung wäre
  eine CDP-Migration: Chromium mit `--remote-debugging-port=0` starten,
  Port aus `DevToolsActivePort` lesen, per WebSocket `Page.navigate` +
  `Page.printToPDF { headerTemplate, footerTemplate,
  displayHeaderFooter }` — nur dort funktionieren
  `<span class="pageNumber"/>` / `totalPages`. Die Platzhalter
  `pageNumber`/`totalPages` kommen erst mit dieser Etappe in die
  Whitelist. Kopf-/Fußzeilen selbst (Logo, statischer Text) funktionieren
  schon über den `position:fixed`-Pfad (E5).
- **Dynamischer KI-Export (Stufe 2)**: KI-Lauf pro Export (LLM erzeugt
  HTML/CSS dokumentspezifisch). Andockstelle ist der
  Draft/Preview/Confirm-Pfad aus E6; nichts in dieser Spec blockiert das.

## Risiken

1. **Template-XSS** → Variablenwerte immer escapen; KI-HTML durch
   Allowlist-Sanitizer; User-HTML = Custom-CSS-Trust-Stufe. Achtung:
   `assetProtocol`-Scope `["**"]` + HTML-View (siehe CLAUDE.md) — die
   Templates betreffen nur Export-HTML, nicht die sandboxed Live-View;
   Sanitizer für KI-Output trotzdem Pflicht.
2. **SVG-Logo-Script** → nur via `<img src="data:…">`, nie inline.
3. **data-URI-Explosion** → harte Limits + Fehler.
4. **Preview klobbert App-View** → strikt iframe-srcdoc + Generation-Token
   + iframe-Existenzcheck nach Editor-Close.
5. **Monaco-Model-Leaks** → Dispose-Disziplin wie
   `mount.ts::disposeTabModel`; ein AMD-Loader für drei Surfaces.
6. **`resolve_provider`-Refactor bricht Translate** → E2E 34 als Gate.
7. **Legacy/Dir-ID-Kollision** → definierte Präzedenz (Dir gewinnt) + warn.
8. **Deterministische Tests vs. Datum** → Datum injizierbar / Tests setzen
   Frontmatter-date.
9. **E2E-Zustandslecks** → Theme-Dateien im `finally` löschen; Szenarien
   setzen ihren View-Mode explizit (Fixture-Isolations-Regeln in
   CLAUDE.md).

## Verifikation pro Etappe

- `cargo test` · `cargo clippy --all-targets -- -D warnings` ·
  `cargo fmt --check` (aus `src-tauri/`).
- `cd src-tauri/web && npm test` (jsdom) · `npm run build` (Bundles sind
  eingecheckt) · danach `cargo build` wegen frontendDist-Embed.
- E2E (Linux+Xvfb, `bash scripts/run-e2e.sh`): bestehende Suite grün —
  besonders 25/26/27 (View-Theme/Custom-Theme/Favoriten) und 34
  (Translate, sichert den Provider-Refactor); neue Szenarien 35 + 36.
  Xvfb-Caveats beachten (`docs/e2e-headless-caveats.md`): Interaktion mit
  Monaco/iframe über die Automation-API (`POST /eval`) statt synthetischer
  Tastatur; `POST /sync/render` vor Screenshots.
- Manueller Smoke (Windows): Theme anlegen → von `brand` clonen → CSS im
  Editor ändern → Live-Preview reagiert → speichern → View + Export-Dialog
  zeigen das Theme → Export HTML + PDF mit Deckblatt/Logo/Kopfzeile
  prüfen → KI-Autor mit echtem Provider gegen einen
  Markenfarben-Prompt testen.
