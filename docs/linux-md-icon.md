# Folio-Icon für `.md` im Linux-Datei-Manager

Auf Windows zeigt der Explorer für `.md`-Dateien automatisch das Folio-Icon,
sobald folio als Default-Handler registriert ist (kommt vom
`AssocQueryString`-Mechanismus). Auf Linux ist das **nicht** so einfach —
die Wege Datei → MIME → Icon sind entkoppelt, mehrere Caches mischen mit,
und das aktive Icon-Theme hat letzte Stimme.

Diese Notiz hält fest, was wir bereits durchgespielt haben, damit wir's
nicht jedes Mal neu auseinandernehmen müssen.

## TL;DR

- Skript für lokalen Quick-Fix: [`scripts/install-folio-icons.sh`](../scripts/install-folio-icons.sh)
- Ins `.deb`-Bundle ist es **noch nicht** integriert (siehe Punkt unten).

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

## Offen / TODO

Im `.deb` steckt das alles noch nicht. Probleme bei der Integration:

- **Theme-Override gehört strenggenommen nicht in ein system-weites
  Paket** — Mint-Y selbst zu patchen würde bei jedem Mint-Y-Update
  überschrieben und betrifft alle User auf der Maschine.
- **Eigener MIME-Subtyp** (z. B. `application/x-folio-md`) wäre ein
  Workaround, hätte aber Nebenwirkungen: Default-Handler-Logik müsste
  daran hängen, andere Tools würden den Subtyp nicht kennen.
- **Symbolic-Icon-Variante** (`folio-symbolic.svg`) wäre für
  monochrome/Dark-Themes sinnvoll — aktuell nicht vorhanden.

Weitere Stoßrichtungen, falls man's reproduzierbar haben will:

- `postinst`-Hook im `.deb`, der einen analogen Schritt für *alle*
  vorhandenen User macht (riskant — User-Dateien anfassen).
- Ein optionales `Folio: Icon-Integration einrichten`-Menüitem in der
  App, das `install-folio-icons.sh` aufruft.
- Ein gepflegtes Icon-Set inkl. SVG-Mastern in `src-tauri/icons/`,
  damit die Größen aus dem Master gerendert werden statt aus dem
  512×512-PNG hochskaliert.
