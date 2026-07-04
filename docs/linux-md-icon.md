# Folio-Icon für `.md` im Linux-Datei-Manager

Auf Windows zeigt der Explorer für `.md`-Dateien automatisch das Folio-Icon,
sobald folio als Default-Handler registriert ist (kommt vom
`AssocQueryString`-Mechanismus). Auf Linux ist das **nicht** so einfach —
die Wege Datei → MIME → Icon sind entkoppelt, mehrere Caches mischen mit,
und das aktive Icon-Theme hat letzte Stimme.

Diese Notiz hält fest, was wir bereits durchgespielt haben, damit wir's
nicht jedes Mal neu auseinandernehmen müssen.

## TL;DR

- **Schicht 1 + 2 stecken im `.deb`**: hicolor-Icons in allen Größen
  (`folio.png`) + MIME-XML (`text/markdown` / `text/x-markdown` →
  `<icon name="folio">`). Wird beim Paketinstall über die dpkg-File-
  Trigger von `hicolor-icon-theme` und `shared-mime-info` automatisch
  aktiv (kein postinst nötig, siehe unten).
- **Schicht 3 (Per-User-Theme-Override) bleibt manuell**: Skript
  [`scripts/install-folio-icons.sh`](../scripts/install-folio-icons.sh)
  liegt im Paket unter `/usr/share/folio/install-folio-icons.sh` und ist
  aus der App über **Hilfe → „Markdown-Icon-Integration einrichten…"**
  (nur Linux) auslösbar.

## Warum es kompliziert ist

1. **GIO** liefert für `.md` eine Icon-Namen-Liste:
   `[folio, text-markdown, x-office-document, …]`. Reihenfolge stammt aus
   der MIME-Definition (`<icon name="folio">`) plus Fallbacks.
2. **GTK's `IconTheme.choose_icon`** durchsucht die Liste **theme-first,
   not name-first**. Heißt: GTK schaut zuerst, ob *irgendeiner* der Namen
   im aktiven Theme existiert, bevor es zu einem Eltern-/Fallback-Theme
   weitergeht.
3. **Mint-Y / Mint-Y-Sand** (und vermutlich die meisten Cinnamon-Themes)
   **bringen ein eigenes `text-markdown.png` mit.** Damit ist beim
   ersten Theme-Lookup-Treffer Schluss — `folio` wird gar nicht erst
   probiert, der hicolor-Fallback (wo wir das App-Icon installiert haben)
   wird nie erreicht.

## Was wir machen müssen

Drei Schichten gleichzeitig, sonst greift's nicht:

1. **`hicolor/<size>/apps/folio.png`** in mehreren Größen — sonst kann
   GTK das Icon "folio" nicht in der vom Datei-Manager angeforderten
   Größe finden. Tauri liefert per Default nur 32 und 128.
2. **MIME-XML** mit `<icon name="folio">` für `text/markdown` und
   `text/x-markdown` (`update-mime-database`).
3. **Theme-Override**: das aktive Icon-Theme im User-Pfad spiegeln und
   `text-markdown.png` mit dem Folio-Icon überschreiben. Das ist der
   eigentliche Knackpunkt — ohne diesen Schritt verliert man Punkt 1+2
   gegen Mint-Y's eigenes `text-markdown.png`.

   Pfad-Layout muss zum System-Theme passen: Mint-Y benutzt
   `mimetypes/<size>/`, andere Themes evtl. `<size>x<size>/mimetypes/`.
   `index.theme` muss vorhanden sein, sonst läuft `gtk-update-icon-cache`
   leer durch (Cache-Datei hat dann nur 264 Bytes Header).

   **WICHTIG: keine eigene minimal-`index.theme` schreiben!** Das
   überschreibt `Inherits=` und `Directories=` des System-Themes und
   bricht alle Folder/App/Action-Icons des aktiven Themes (selbst erlebt).
   Stattdessen die `index.theme` aus `/usr/share/icons/<theme>/` 1:1
   kopieren — dann sind alle Suchpfade konsistent, und `gtk-update-
   icon-cache` produziert eine Cache-Datei nur über die wenigen Files,
   die wir tatsächlich angelegt haben (~264 Bytes — das ist normal,
   nicht broken).

   **HiDPI / @2x-Varianten:** Mint-Y (und andere moderne Themes) bringen
   parallel zu `mimetypes/24/` auch `mimetypes/24@2x/` mit doppelt so
   großen PNGs für Hi-DPI-Displays. Cinnamon/Nemo greifen auf
   Hi-DPI-Setups gezielt die `@2x`-Pfade an — wenn das Override nur die
   normalen Größen abdeckt, schlägt das System-Icon trotzdem durch.
   Daher in beide Pfade rendern.

## Cache-Fallen

- **`icon-theme.cache`** — geladen einmal beim Datei-Manager-Start,
  per `mmap`. Wenn das Skript die Cache-Datei ersetzt, sieht Nemo immer
  noch die alte Datei (`(deleted)`-Marker in `/proc/<pid>/maps`). Lösung:
  `pkill nemo nemo-desktop`, dann startet Cinnamon-Session den Desktop-
  Prozess neu — der lädt den frischen Cache.
- **`~/.cache/cs_themes/icons/`** — Cinnamon-eigener Theme-Cache,
  enthält Themen-Schnipsel. Bei hartnäckigen Problemen löschen.
- **`~/.cache/thumbnails/`** — für Bilder/PDFs relevant, für
  Icon-Lookup eigentlich nicht. Schadet aber nicht zu leeren.

## Diagnose

```bash
# Was bekommt GIO für eine .md-Datei?
gio info /pfad/zu/foo.md | grep standard::icon

# Welches PNG würde GTK in einer bestimmten Größe wählen?
python3 - <<'PY'
import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk
theme = Gtk.IconTheme.new(); theme.set_custom_theme("Mint-Y-Sand")
info = theme.choose_icon(['folio', 'text-markdown'], 24, 0)
print(info.get_filename() if info else None)
PY

# Welche icon-theme.cache hat Nemo gerade gemmapt?
grep "icon-theme.cache" /proc/$(pgrep -x nemo-desktop)/maps

# Welches PNG öffnet Nemo TATSÄCHLICH beim Listing? (Wichtigste Diagnose)
pkill -x nemo nemo-desktop; sleep 2
strace -e openat -f -o /tmp/nemo.log /usr/bin/nemo /pfad/mit/md-files &
sleep 5; pkill -x nemo
grep -E "text-markdown|folio" /tmp/nemo.log | grep -v ENOENT
```

Wenn `(deleted)` an einem der Pfade steht → Nemo neu starten.

Wenn `strace` einen `@2x`-Pfad zeigt, den unser Override nicht abdeckt →
HiDPI-Größen ergänzen.

## Was jetzt im `.deb` (und `.rpm`) steckt

Umgesetzt über `bundle.linux.deb.files` **und** `bundle.linux.rpm.files`
in `tauri.conf.json` — beide Pakete bekommen identische Pfade (kein
Build-Time-Rendering — die PNGs sind eingecheckt):

1. **hicolor-Icons in allen gängigen Größen** als
   `/usr/share/icons/hicolor/<W>x<H>/apps/folio.png`. Tauris deb-Bundler
   liefert aus `bundle.icon` bereits **32, 128 und 256@2**; ergänzt sind
   die eingecheckten Größen **16, 22, 24, 48, 64, 256** (aus
   `src-tauri/icons/hicolor/…`, gerendert aus dem 1254×1254-Master
   `icon-source.png`). Die `deb.files`-Einträge decken bewusst nur die
   nicht schon von Tauri gelieferten Größen ab — sonst kollidieren
   gleiche Zielpfade.
2. **MIME-XML** (`src-tauri/linux/folio-mime.xml`) →
   `/usr/share/mime/packages/folio.xml` mit `<icon name="folio">` für
   `text/markdown` und `text/x-markdown`.
3. **Das Per-User-Skript** →
   `/usr/share/folio/install-folio-icons.sh` (Schicht 3, siehe unten).

**Automatisch beim Paketinstall** (kein postinst im Paket): die
dpkg-File-Trigger `interest-noawait /usr/share/icons/hicolor`
(`hicolor-icon-theme`) und `interest-noawait /usr/share/mime/packages`
(`shared-mime-info`) rufen `gtk-update-icon-cache` bzw.
`update-mime-database` selbst auf, sobald ein Paket Dateien unter diesen
Pfaden installiert. Tauris deb-Bundler baut das Paket zwar mit eigenem
ar/tar (statt `dpkg-deb`), aber path-based File-Trigger werden von den
*empfangenden* Paketen definiert und von dpkg beim Install anhand der
enthaltenen Dateipfade aktiviert — sie funktionieren also auch bei einem
so gebauten `.deb`. Ein `deb.postInstallScript` wäre nur nötig, falls das
Trigger-Verhalten fehlt; auf Debian/Mint ist es Standard und verifiziert.

## Was Per-User bleibt (Schicht 3)

Der Theme-Override gehört **nicht** ins system-weite Paket (Mint-Y direkt
zu patchen würde bei jedem Theme-Update überschrieben und alle User auf
der Maschine treffen). Er läuft daher weiter über
`install-folio-icons.sh` im `XDG_DATA_HOME` des Users:

- **Aus der App**: Menü **Hilfe → „Markdown-Icon-Integration
  einrichten…"** (nur Linux, `menu/build.rs` +
  `commands/app/icon_integration.rs`). Der Menüpunkt findet das Skript
  sowohl im installierten Pfad (`/usr/share/folio/…`) als auch im
  Dev-Repo (`<repo>/scripts/…`), führt es in einem eigenen Thread aus und
  meldet Erfolg/Fehler über einen nativen Message-Dialog.
- **Manuell**: `bash /usr/share/folio/install-folio-icons.sh` bzw. im
  Repo `bash scripts/install-folio-icons.sh`.

Das Skript findet sein Quell-Icon in beiden Umgebungen: im Dev-Repo
`src-tauri/icons/icon.png`, im installierten Fall fällt es auf das vom
Paket gelegte `/usr/share/icons/hicolor/256x256/apps/folio.png` zurück.

Die Größen-Renderings im Skript brauchen **Pillow** (`python3-pil` auf
Debian/Mint, `python3-pillow` auf Fedora). Die Pakete deklarieren das als
`Recommends` (kein hartes `Depends` — die App läuft ohne das Feature
vollständig); fehlt es, bricht das Skript mit einer klaren
Installationsanweisung ab statt mit einem `ModuleNotFoundError`.

**AppImage-Einschränkung**: Das AppImage installiert naturgemäß nichts
nach `/usr/share`, das Skript ist dort also nicht enthalten — der
Menüpunkt meldet in dem Fall einen sauberen „Skript nicht
gefunden"-Dialog. Wer das AppImage nutzt, kann das Skript aus dem Repo
laufen lassen. Bewusst so gelassen; der Ziel-Workflow ist das `.deb`.

## Offen / TODO

- **Eigener MIME-Subtyp** (z. B. `application/x-folio-md`) wäre ein
  Workaround gegen das theme-eigene `text-markdown.png`, hätte aber
  Nebenwirkungen: Default-Handler-Logik müsste daran hängen, andere Tools
  würden den Subtyp nicht kennen.
- **Symbolic-Icon-Variante** (`folio-symbolic.svg`) wäre für
  monochrome/Dark-Themes sinnvoll — aktuell nicht vorhanden.
- **SVG-Master statt PNG-Skalierung**: die hicolor-PNGs werden aus dem
  1254×1254-`icon-source.png` gerendert; ein echtes SVG-Set würde bei
  exotischen Größen schärfer bleiben.
