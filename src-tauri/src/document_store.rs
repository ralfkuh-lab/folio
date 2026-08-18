use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    thread,
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    /// Frontend-/Payload-Label (`lf` | `crlf`).
    pub fn label(self) -> &'static str {
        match self {
            LineEnding::Lf => "lf",
            LineEnding::Crlf => "crlf",
        }
    }

    /// Parse `lf` / `crlf` (case-insensitive). Andere Werte → `None`.
    pub fn from_label(label: &str) -> Option<Self> {
        match label.to_ascii_lowercase().as_str() {
            "lf" => Some(LineEnding::Lf),
            "crlf" => Some(LineEnding::Crlf),
            _ => None,
        }
    }
}

/// Erkanntes Text-Encoding einer geladenen Datei. Wird zusammen mit
/// `had_bom` gehalten und beim Speichern exakt wiederhergestellt (analog
/// zur bestehenden BOM/CRLF-Philosophie). Bei `Utf16Le`/`Utf16Be` ist
/// `had_bom` durch die Erkennung immer `true`, bei `Windows1252` immer
/// `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextEncoding {
    #[default]
    Utf8,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

impl TextEncoding {
    /// Frontend-/Payload-Label. Kombiniert mit `had_bom`, weil UTF-8 mit
    /// und ohne BOM dasselbe Enum teilt.
    pub fn label(self, had_bom: bool) -> &'static str {
        match self {
            TextEncoding::Utf8 => {
                if had_bom {
                    "utf8-bom"
                } else {
                    "utf8"
                }
            }
            TextEncoding::Utf16Le => "utf16le",
            TextEncoding::Utf16Be => "utf16be",
            TextEncoding::Windows1252 => "windows1252",
        }
    }
}

/// Fehler beim Speichern. Trennt gewoehnliche IO-Fehler von dem Fall, dass
/// der Text Zeichen enthaelt, die sich nicht ins Original-Encoding
/// (Windows-1252) kodieren lassen — die Datei wird dann NICHT geschrieben,
/// statt Zeichen still durch HTML-Entities zu ersetzen (was encoding_rs
/// sonst tun wuerde). `Opaque` ist die Store-Grenze gegen Datenverlust:
/// ein Bild/Binary darf nie als Text auf Disk landen.
#[derive(Debug)]
pub enum SaveError {
    Io(io::Error),
    /// Zeichen, die sich nicht in Windows-1252 darstellen lassen
    /// (dedupliziert, in Reihenfolge des ersten Auftretens).
    Unmappable(Vec<char>),
    /// Opaque-Dokument (Image/Binary) — kein Text-Save.
    Opaque,
}

/// Textmutation an einem Store, der kein Textdokument hält.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreWriteError {
    Opaque,
}

impl std::fmt::Display for StoreWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreWriteError::Opaque => write!(f, "opaque document is read-only"),
        }
    }
}

impl std::error::Error for StoreWriteError {}

impl From<io::Error> for SaveError {
    fn from(error: io::Error) -> Self {
        SaveError::Io(error)
    }
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Io(error) => write!(f, "{error}"),
            SaveError::Unmappable(chars) => {
                let list = chars
                    .iter()
                    .map(|c| c.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                write!(f, "characters not representable in windows-1252: {list}")
            }
            SaveError::Opaque => write!(f, "opaque document is read-only"),
        }
    }
}

impl std::error::Error for SaveError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoadedDocument {
    pub path: String,
    pub text: String,
    /// Encoding-Label (`utf8` | `utf8-bom` | `utf16le` | `utf16be` |
    /// `windows1252`), additiv fuer die Statusleiste.
    pub encoding: String,
    /// Zeilenenden-Label (`lf` | `crlf`), additiv fuer die Statusleiste.
    pub line_ending: String,
}

#[derive(Clone, Default)]
pub struct DocumentEvents {
    pub loaded: Option<Arc<dyn Fn(LoadedDocument) + Send + Sync>>,
    pub dirty_changed: Option<Arc<dyn Fn(bool) + Send + Sync>>,
    pub saved: Option<Arc<dyn Fn(String, String) + Send + Sync>>,
    pub text_changed: Option<Arc<dyn Fn(String) + Send + Sync>>,
    pub external_changed: Option<Arc<dyn Fn(String) + Send + Sync>>,
    /// Feuert, wenn ein Reload NUR Metadaten (BOM/Encoding) aendert, der
    /// Text aber identisch bleibt — traegt das neue Encoding-Label. Kein
    /// voller `loaded`-Pfad (der waere fuer Metadaten-only zu schwer), nur
    /// die Statusleisten-Zelle wird aktualisiert.
    pub encoding_changed: Option<Arc<dyn Fn(String) + Send + Sync>>,
    /// Feuert bei EOL-Aenderung (`lf` | `crlf`): Toggle via `set_line_ending`
    /// und Format-only-Reload. Vor `dirty_changed`, damit das Frontend
    /// `currentEol` aktualisieren kann, bevor clean-Sync laeuft.
    pub eol_changed: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

pub struct DocumentStore {
    pub path: Option<String>,
    pub text: String,
    /// Referenzstand von Load/Save/Reload — `update_text` vergleicht
    /// dagegen, damit ein Undo zurueck zum Ausgangstext den Store
    /// wieder clean macht (Tab-Dirty-Punkt und Close-Prompt haengen
    /// am Backend-Flag, nicht am Frontend-Vergleich).
    clean_text: String,
    pub is_dirty: bool,
    pub line_ending: LineEnding,
    /// Referenz-Zeilenende von Load/Save/Reload — Dirty beruecksichtigt
    /// auch `line_ending != clean_line_ending` (EOL-Toggle ohne Textaenderung).
    clean_line_ending: LineEnding,
    pub had_bom: bool,
    pub encoding: TextEncoding,
    /// true nach `load_opaque` (Image/Binary-Pfad ohne Textinhalt).
    /// Bleibt ueber Rename erhalten — verhindert EOL-Toggle auf umbenannten
    /// Opaque-Docs (z. B. Bild → .txt).
    opaque: bool,
    watcher: Option<RecommendedWatcher>,
    watcher_tx: Option<mpsc::Sender<PathBuf>>,
    events: DocumentEvents,
}

impl Default for DocumentStore {
    fn default() -> Self {
        Self {
            path: None,
            clean_text: String::new(),
            text: String::new(),
            is_dirty: false,
            line_ending: LineEnding::Lf,
            clean_line_ending: LineEnding::Lf,
            had_bom: false,
            encoding: TextEncoding::Utf8,
            opaque: false,
            watcher: None,
            watcher_tx: None,
            events: DocumentEvents::default(),
        }
    }
}

impl DocumentStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_events(&mut self, events: DocumentEvents) {
        self.events = events;
    }

    /// Encoding-Label fuer die Frontend-Payload (Statusleiste). Kombiniert
    /// `encoding` und `had_bom`.
    pub fn encoding_label(&self) -> &'static str {
        self.encoding.label(self.had_bom)
    }

    /// Zeilenenden-Label fuer die Frontend-Payload (`lf` | `crlf`).
    pub fn line_ending_label(&self) -> &'static str {
        self.line_ending.label()
    }

    /// true, wenn das Dokument per `load_opaque` geoeffnet wurde (kein Text).
    pub fn is_opaque(&self) -> bool {
        self.opaque
    }

    /// Dirty aus Text- und EOL-Referenzstand. Beide muessen matchen.
    fn is_content_dirty(&self) -> bool {
        self.text != self.clean_text || self.line_ending != self.clean_line_ending
    }

    pub fn load(&mut self, path: &str) -> io::Result<LoadedDocument> {
        self.load_inner(path, true)
    }

    /// Reloads an inactive tab without publishing an active-document event.
    pub(crate) fn load_silent(&mut self, path: &str) -> io::Result<LoadedDocument> {
        self.load_inner(path, false)
    }

    fn load_inner(&mut self, path: &str, emit_loaded: bool) -> io::Result<LoadedDocument> {
        let (text, line_ending, had_bom, encoding) = read_and_decode(path)?;

        self.path = Some(path.to_string());
        self.text = text.clone();
        self.clean_text = text.clone();
        self.is_dirty = false;
        self.line_ending = line_ending;
        self.clean_line_ending = line_ending;
        self.had_bom = had_bom;
        self.encoding = encoding;
        self.opaque = false;
        self.watch_non_fatal(path);

        let loaded = LoadedDocument {
            path: path.to_string(),
            text,
            encoding: self.encoding_label().to_string(),
            line_ending: self.line_ending_label().to_string(),
        };
        if emit_loaded {
            if let Some(callback) = &self.events.loaded {
                callback(loaded.clone());
            }
            if let Some(callback) = &self.events.dirty_changed {
                callback(false);
            }
        }
        Ok(loaded)
    }

    /// "Open" fuer nicht-textuelle Dateien (Bilder o.ae.). Setzt den
    /// Store auf den Pfad, ohne den Inhalt zu lesen — das Frontend
    /// rendert das Bild ueber `convertFileSrc` direkt von Disk.
    /// Aequivalent zu `load`, aber ohne `read_and_decode`. Ruft
    /// watch_non_fatal, damit die bestehende external_changed-Kette
    /// (DocumentStore + state.rs + Frontend document:external_changed)
    /// auch fuer Image-View Live-Reload bei externen Aenderungen
    /// funktioniert.
    pub fn load_opaque(&mut self, path: &str) -> io::Result<LoadedDocument> {
        self.path = Some(path.to_string());
        self.text = String::new();
        self.clean_text = String::new();
        self.is_dirty = false;
        // line_ending/had_bom/encoding unveraendert — sie betreffen nur
        // Text-Saves; das Frontend zeigt fuer Bilder keine Encoding-/EOL-Zelle.
        self.clean_line_ending = self.line_ending;
        self.opaque = true;
        self.watch_non_fatal(path);
        let loaded = LoadedDocument {
            path: path.to_string(),
            text: String::new(),
            encoding: self.encoding_label().to_string(),
            line_ending: self.line_ending_label().to_string(),
        };
        if let Some(callback) = &self.events.loaded {
            callback(loaded.clone());
        }
        if let Some(callback) = &self.events.dirty_changed {
            callback(false);
        }
        Ok(loaded)
    }

    /// Lädt den aktuell offenen Pfad neu von Disk, wenn sich der Inhalt
    /// gegenüber `self.text` geändert hat. Ohne offene Datei oder bei
    /// identischem Inhalt ein No-Op (`Ok(false)`) — letzteres unterdrückt
    /// das Phantom-`document:loaded` nach einem eigenen `save()`, das den
    /// notify-Watcher ja auch triggert. Den Watcher hängen wir nicht um;
    /// der bestehende beobachtet ohnehin denselben Pfad.
    pub fn reload_if_changed(&mut self) -> io::Result<bool> {
        let Some(path) = self.path.clone() else {
            return Ok(false);
        };
        // Bewusster No-op für Opaque: `Ok(false)` bedeutet hier NICHT
        // „unverändert gegenüber Disk", sondern „dieser Pfad ist nicht
        // zuständig". `read_and_decode` würde ein Bild/Binary über den
        // 1252-Fallback in den Store ziehen und `opaque` löschen.
        // Zuständig ist der Image-Watcher: `document:external_changed`
        // → Frontend `reloadImageView`. Ein späterer Binary-/Hex-Watcher
        // muss denselben Event-Pfad nutzen, nicht diesen Reload.
        if self.opaque {
            return Ok(false);
        }
        let (text, line_ending, had_bom, encoding) = read_and_decode(&path)?;
        if text == self.text {
            // Inhalt unveraendert. Falls extern ausschliesslich BOM,
            // Line-Ending oder Encoding umgestellt wurde, hier die Metadaten
            // nachziehen — sonst wuerde der naechste Self-Save die externe
            // Format-Entscheidung zurueckdrehen. Kein voller loaded-Pfad,
            // aber bei Encoding-/EOL-Label-Aenderung leichtgewichtige Events,
            // damit die Statusleisten-Zellen nachziehen.
            //
            // Bewusste Semantik (wie Encoding): externe Format-Aenderung
            // gewinnt — ein vorheriger In-App-EOL-Toggle wird verworfen
            // (`clean_line_ending` folgt Disk).
            let old_encoding = self.encoding_label();
            let old_eol = self.line_ending_label();
            self.had_bom = had_bom;
            self.line_ending = line_ending;
            self.clean_line_ending = line_ending;
            self.encoding = encoding;
            // Events VOR dirty_changed, damit Frontend currentEol/encoding
            // aktualisiert, bevor cleanEol-Sync auf dirty_changed(false) laeuft.
            let new_encoding = self.encoding_label();
            if new_encoding != old_encoding {
                if let Some(callback) = &self.events.encoding_changed {
                    callback(new_encoding.to_string());
                }
            }
            let new_eol = self.line_ending_label();
            if new_eol != old_eol {
                if let Some(callback) = &self.events.eol_changed {
                    callback(new_eol.to_string());
                }
            }
            // EOL-Dirty entfaellt, Text-Dirty bleibt.
            self.set_dirty(self.text != self.clean_text);
            return Ok(false);
        }
        self.text = text.clone();
        self.clean_text = text.clone();
        self.is_dirty = false;
        self.line_ending = line_ending;
        self.clean_line_ending = line_ending;
        self.had_bom = had_bom;
        self.encoding = encoding;
        self.opaque = false;
        let loaded = LoadedDocument {
            path: path.clone(),
            text,
            encoding: self.encoding_label().to_string(),
            line_ending: self.line_ending_label().to_string(),
        };
        if let Some(callback) = &self.events.loaded {
            callback(loaded);
        }
        if let Some(callback) = &self.events.dirty_changed {
            callback(false);
        }
        Ok(true)
    }

    /// Setzt den Store auf "kein Dokument geladen" zurück. Der Watcher
    /// wird beim Drop des `RecommendedWatcher`-Felds automatisch
    /// abgemeldet. Feuert `dirty_changed(false)`, damit das Frontend den
    /// Dirty-Indikator zurücksetzt.
    pub fn close(&mut self) {
        self.path = None;
        self.text = String::new();
        self.clean_text = String::new();
        self.is_dirty = false;
        self.line_ending = LineEnding::Lf;
        self.clean_line_ending = LineEnding::Lf;
        self.had_bom = false;
        self.encoding = TextEncoding::Utf8;
        self.opaque = false;
        self.watcher = None;
        self.watcher_tx = None;
        if let Some(callback) = &self.events.dirty_changed {
            callback(false);
        }
    }

    fn reject_opaque(&self) -> Result<(), StoreWriteError> {
        if self.opaque {
            Err(StoreWriteError::Opaque)
        } else {
            Ok(())
        }
    }

    /// Schreibt den Editor-Text in den Store. Opaque-Dokumente lehnen
    /// ab, ohne State oder Events anzufassen — das ist die
    /// Datenintegritätsgrenze (kein Frontend-Gating).
    pub fn update_text(&mut self, text: String) -> Result<(), StoreWriteError> {
        self.reject_opaque()?;
        if self.text == text {
            return Ok(());
        }
        self.text = text.clone();
        if self.path.is_some() {
            // Vergleich gegen Text- UND EOL-Referenzstand: ein Tipp-Revert
            // darf ein EOL-Dirty nicht fälschlich auf clean setzen.
            self.set_dirty(self.is_content_dirty());
        }
        if let Some(callback) = &self.events.text_changed {
            callback(text);
        }
        Ok(())
    }

    /// Setzt die Zeilenenden des aktiven Dokuments. No-op bei gleichem Wert.
    /// Opaque-Docs liefern [`StoreWriteError::Opaque`] statt eines
    /// stillen `false`. Dirty wird analog zu `update_text` aus Text- und
    /// EOL-Referenzstand abgeleitet. Feuert `eol_changed` vor
    /// `dirty_changed`. Liefert `Ok(true)`, wenn sich der Wert geaendert hat.
    pub fn set_line_ending(&mut self, eol: LineEnding) -> Result<bool, StoreWriteError> {
        self.reject_opaque()?;
        if self.line_ending == eol {
            return Ok(false);
        }
        self.line_ending = eol;
        if let Some(callback) = &self.events.eol_changed {
            callback(self.line_ending_label().to_string());
        }
        if self.path.is_some() {
            self.set_dirty(self.is_content_dirty());
        }
        Ok(true)
    }

    /// Restauriert Line-Endings (LF→Original) und kodiert in das
    /// Original-Encoding inkl. BOM. Gemeinsame Basis von `save`/`save_as`.
    fn encode_for_disk(&self) -> Result<Vec<u8>, SaveError> {
        let disk_text = match self.line_ending {
            LineEnding::Lf => self.text.clone(),
            LineEnding::Crlf => self.text.replace('\n', "\r\n"),
        };
        encode_disk_text(&disk_text, self.encoding, self.had_bom)
    }

    pub fn save(&mut self) -> Result<bool, SaveError> {
        if self.opaque {
            return Err(SaveError::Opaque);
        }
        let Some(path) = self.path.clone() else {
            return Ok(false);
        };
        let bytes = self.encode_for_disk()?;
        fs::write(&path, bytes)?;
        self.clean_text = self.text.clone();
        self.clean_line_ending = self.line_ending;
        self.set_dirty(false);
        if let Some(callback) = &self.events.saved {
            callback(path, self.text.clone());
        }
        Ok(true)
    }

    /// Speichert den aktuellen Inhalt unter einem neuen Pfad. Behält
    /// `line_ending`/`had_bom` des Originals (User-Intent: „selbe Datei,
    /// nur woanders/anders benannt"). Hängt den Watcher um, ruft den
    /// `loaded`-Callback (damit das Frontend mit neuem Pfad/Kind/
    /// Sprache re-rendert) und triggert `dirty_changed(false)`.
    pub fn save_as(&mut self, new_path: &str) -> Result<LoadedDocument, SaveError> {
        if self.opaque {
            return Err(SaveError::Opaque);
        }
        let bytes = self.encode_for_disk()?;
        fs::write(new_path, bytes)?;

        self.path = Some(new_path.to_string());
        self.clean_text = self.text.clone();
        self.clean_line_ending = self.line_ending;
        // save_as schreibt Text → kein Opaque-Doc mehr.
        self.opaque = false;
        self.set_dirty(false);
        self.watch_non_fatal(new_path);

        let loaded = LoadedDocument {
            path: new_path.to_string(),
            text: self.text.clone(),
            encoding: self.encoding_label().to_string(),
            line_ending: self.line_ending_label().to_string(),
        };
        if let Some(callback) = &self.events.loaded {
            callback(loaded.clone());
        }
        Ok(loaded)
    }

    /// Aktualisiert den Pfad, ohne den Inhalt neu zu lesen — die Datei
    /// liegt bereits unter `new_path` (per `fs::rename` durch den
    /// Aufrufer). Ersetzt den Watcher und feuert den `loaded`-Callback,
    /// damit das Frontend `kind`/`language` für die ggf. neue Endung
    /// nachzieht. `is_dirty` bleibt erhalten — der ungespeicherte
    /// Editor-Inhalt wandert mit der Datei mit.
    pub fn rename_to(&mut self, new_path: &str) -> io::Result<LoadedDocument> {
        self.rename_to_inner(new_path, true)
    }

    /// Variante fuer einen offenen, aber inaktiven Tab. Der Watcher und
    /// Store-Pfad muessen der umbenannten Datei folgen, ein
    /// `document:loaded`-Event darf jedoch nur den aktiven Tab betreffen.
    pub(crate) fn rename_to_silent(&mut self, new_path: &str) -> io::Result<LoadedDocument> {
        self.rename_to_inner(new_path, false)
    }

    fn rename_to_inner(&mut self, new_path: &str, emit_loaded: bool) -> io::Result<LoadedDocument> {
        self.path = Some(new_path.to_string());
        self.watch_non_fatal(new_path);

        let loaded = LoadedDocument {
            path: new_path.to_string(),
            text: self.text.clone(),
            encoding: self.encoding_label().to_string(),
            line_ending: self.line_ending_label().to_string(),
        };
        if emit_loaded {
            if let Some(callback) = &self.events.loaded {
                callback(loaded.clone());
            }
        }
        Ok(loaded)
    }

    pub(crate) fn set_dirty(&mut self, dirty: bool) {
        if self.is_dirty == dirty {
            return;
        }
        self.is_dirty = dirty;
        if let Some(callback) = &self.events.dirty_changed {
            callback(dirty);
        }
    }

    /// Watch-Fehler sind nicht-fatal (wie beim VaultWatcher): Load/
    /// Save-As/Rename haben den Store-State zu diesem Zeitpunkt bereits
    /// mutiert — ein `Err` hier wuerde den `loaded`-Callback (und damit
    /// das Frontend-Update) unterschlagen, obwohl das Dokument korrekt
    /// geladen/geschrieben ist. Folge eines Fehlschlags ist nur, dass
    /// externe Aenderungen fuer dieses Dokument nicht erkannt werden.
    fn watch_non_fatal(&mut self, path: &str) {
        if let Err(error) = self.watch(path) {
            tracing::warn!(
                target: "folio::document",
                %error,
                path,
                "file watch failed; external-change detection disabled for this document"
            );
        }
    }

    /// Interner Watcher-Setup (notify non-recursive auf exact path).
    /// Wird von load/load_inner, save_as, rename und jetzt auch
    /// load_opaque (fuer Image-View Live-Reload) aufgerufen.
    fn watch(&mut self, path: &str) -> io::Result<()> {
        // Stop any previous watcher thread by dropping its sender.
        self.watcher = None;
        self.watcher_tx = None;

        let path_buf = PathBuf::from(path);
        let watched_path = path_buf.clone();
        let callback = self.events.external_changed.clone();
        let (tx, rx) = mpsc::channel::<PathBuf>();
        self.watcher_tx = Some(tx.clone());

        thread::spawn(move || {
            while let Ok(changed) = rx.recv() {
                while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
                if let Some(callback) = &callback {
                    callback(changed.to_string_lossy().into_owned());
                }
            }
        });

        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                if let Ok(event) = result {
                    if is_write_event(&event)
                        && event
                            .paths
                            .iter()
                            .any(|path| same_path(path, &watched_path))
                    {
                        let _ = tx.send(watched_path.clone());
                    }
                }
            },
            Config::default(),
        )
        .map_err(io::Error::other)?;

        watcher
            .watch(Path::new(path), RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;
        self.watcher = Some(watcher);
        Ok(())
    }
}

fn is_write_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
    )
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || fs::canonicalize(a).ok() == fs::canonicalize(b).ok()
}

/// Liest `path` und liefert (LF-normalisierter Text, originales
/// Line-Ending, BOM-Vorhandensein, erkanntes Encoding). Wird von `load`
/// und `reload_if_changed` genutzt.
///
/// Erkennungsreihenfolge:
/// 1. BOM-Sniffing: `EF BB BF` → UTF-8 mit BOM; `FF FE` → UTF-16 LE;
///    `FE FF` → UTF-16 BE.
/// 2. Kein BOM: striktes UTF-8 (Fehlschlag ist InvalidData nur nicht mehr —
///    siehe 3).
/// 3. UTF-8-Fehlschlag: deterministischer Windows-1252-Fallback — jede
///    Bytefolge ist gueltiges 1252, das kann nie fehlschlagen. Keine
///    Rate-Heuristik (kein chardet).
///
/// **BOM-loses UTF-16 wird bewusst NICHT erkannt** (keine Heuristik) und
/// landet daher im Windows-1252-Fallback — solche Dateien fallen zudem im
/// Volltext-Such-NUL-Sniff (`search.rs`) als binaer heraus.
///
/// Bewusste Vereinfachung bei gemischten Endings: enthaelt die Datei
/// auch nur ein CRLF, gilt sie als CRLF — ein Save vereinheitlicht
/// dann ALLE Zeilen auf CRLF (getestet in
/// `mixed_line_endings_are_classified_crlf_and_unified_on_save`).
/// Lone-`\r` (Alt-Mac) wird nicht normalisiert und bleibt im Text.
fn read_and_decode(path: &str) -> io::Result<(String, LineEnding, bool, TextEncoding)> {
    let bytes = fs::read(path)?;

    // 1. BOM-Sniffing.
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // UTF-8 mit BOM: Rest weiterhin strikt (wie bisher) — ein defektes
        // UTF-8-mit-BOM ist ein echter Fehler, kein 1252-Kandidat.
        let raw = String::from_utf8(bytes[3..].to_vec())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let (text, line_ending) = normalize_line_endings(&raw);
        return Ok((text, line_ending, true, TextEncoding::Utf8));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let raw = decode_utf16_checked(encoding_rs::UTF_16LE, &bytes[2..])?;
        let (text, line_ending) = normalize_line_endings(&raw);
        return Ok((text, line_ending, true, TextEncoding::Utf16Le));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let raw = decode_utf16_checked(encoding_rs::UTF_16BE, &bytes[2..])?;
        let (text, line_ending) = normalize_line_endings(&raw);
        return Ok((text, line_ending, true, TextEncoding::Utf16Be));
    }

    // 2. Kein BOM: striktes UTF-8.
    match std::str::from_utf8(&bytes) {
        Ok(raw) => {
            let (text, line_ending) = normalize_line_endings(raw);
            Ok((text, line_ending, false, TextEncoding::Utf8))
        }
        Err(_) => {
            // 3. Windows-1252-Fallback (total, unmoeglich fehlzuschlagen).
            let raw = encoding_rs::WINDOWS_1252
                .decode_without_bom_handling(&bytes)
                .0
                .into_owned();
            let (text, line_ending) = normalize_line_endings(&raw);
            Ok((text, line_ending, false, TextEncoding::Windows1252))
        }
    }
}

/// Dekodiert Bytes wie [`read_and_decode`], aber fail-open fuer die
/// reine Anzeige (Git-HEAD-Diff). Ungueltiges UTF-8-mit-BOM und kaputtes
/// UTF-16 werden lossy ersetzt statt den Diff zu verweigern. Niemals
/// zurueckschreiben — der Roundtrip-Vertrag von `read_and_decode` gilt hier
/// nicht.
pub fn decode_bytes_for_display(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let raw = String::from_utf8_lossy(&bytes[3..]).into_owned();
        return normalize_line_endings(&raw).0;
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let raw = encoding_rs::UTF_16LE
            .decode_without_bom_handling(&bytes[2..])
            .0
            .into_owned();
        return normalize_line_endings(&raw).0;
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let raw = encoding_rs::UTF_16BE
            .decode_without_bom_handling(&bytes[2..])
            .0
            .into_owned();
        return normalize_line_endings(&raw).0;
    }
    match std::str::from_utf8(bytes) {
        Ok(raw) => normalize_line_endings(raw).0,
        Err(_) => {
            let raw = encoding_rs::WINDOWS_1252
                .decode_without_bom_handling(bytes)
                .0
                .into_owned();
            normalize_line_endings(&raw).0
        }
    }
}

/// Decodiert UTF-16 (LE/BE, ohne fuehrenden BOM) **strikt**: meldet
/// `decode_without_bom_handling` einen Fehler (ungerade Nutzdatenlaenge,
/// unpaarige Surrogate), bricht der Load mit `InvalidData` ab — encoding_rs
/// wuerde die kaputten Einheiten sonst still durch `U+FFFD` ersetzen, und
/// ein spaeterer Save schriebe die Ersatzzeichen auf Platte (Roundtrip-
/// Bruch). Verhalten damit identisch zum defekten UTF-8-mit-BOM: Datei
/// oeffnet nicht und bleibt unangetastet.
fn decode_utf16_checked(
    encoding: &'static encoding_rs::Encoding,
    bytes: &[u8],
) -> io::Result<String> {
    let (decoded, had_errors) = encoding.decode_without_bom_handling(bytes);
    if had_errors {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "malformed UTF-16 sequence",
        ));
    }
    Ok(decoded.into_owned())
}

/// Erkennt das Line-Ending (ein einziges CRLF genuegt) und normalisiert
/// auf LF.
fn normalize_line_endings(raw: &str) -> (String, LineEnding) {
    let line_ending = if raw.contains("\r\n") {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };
    (raw.replace("\r\n", "\n"), line_ending)
}

/// Kodiert den bereits Line-Ending-restaurierten `disk_text` in Bytes des
/// Ziel-Encodings inkl. BOM.
///
/// - **UTF-8**: Bytes direkt, optionaler BOM `EF BB BF`.
/// - **UTF-16 LE/BE**: BOM + `str::encode_utf16` (std, weil encoding_rs
///   keinen UTF-16-Encoder hat). Kann jede gueltige Rust-`String` kodieren.
/// - **Windows-1252**: `encoding_rs`-Encode; unmappbare Zeichen (z. B.
///   Emoji) setzen `had_errors` → Fehler statt HTML-Entity-Ersatz, damit
///   nie zerstoerter Text auf Platte landet.
fn encode_disk_text(
    disk_text: &str,
    encoding: TextEncoding,
    had_bom: bool,
) -> Result<Vec<u8>, SaveError> {
    match encoding {
        TextEncoding::Utf8 => {
            let mut bytes = Vec::with_capacity(disk_text.len() + 3);
            if had_bom {
                bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            bytes.extend_from_slice(disk_text.as_bytes());
            Ok(bytes)
        }
        TextEncoding::Utf16Le => Ok(encode_utf16(disk_text, false)),
        TextEncoding::Utf16Be => Ok(encode_utf16(disk_text, true)),
        TextEncoding::Windows1252 => {
            let (encoded, _, had_errors) = encoding_rs::WINDOWS_1252.encode(disk_text);
            if had_errors {
                return Err(SaveError::Unmappable(unmappable_windows1252(disk_text)));
            }
            Ok(encoded.into_owned())
        }
    }
}

fn encode_utf16(text: &str, big_endian: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 2 + 2);
    // BOM.
    bytes.extend_from_slice(if big_endian {
        &[0xFE, 0xFF]
    } else {
        &[0xFF, 0xFE]
    });
    for unit in text.encode_utf16() {
        if big_endian {
            bytes.extend_from_slice(&unit.to_be_bytes());
        } else {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    bytes
}

/// Sammelt die Zeichen, die sich nicht in Windows-1252 kodieren lassen
/// (dedupliziert, Reihenfolge des ersten Auftretens) — nur im Fehlerpfad
/// aufgerufen.
fn unmappable_windows1252(text: &str) -> Vec<char> {
    let mut seen = Vec::new();
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        let (_, _, had_errors) = encoding_rs::WINDOWS_1252.encode(ch.encode_utf8(&mut buf));
        if had_errors && !seen.contains(&ch) {
            seen.push(ch);
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_detects_bom_and_normalizes_crlf() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"\xEF\xBB\xBFone\r\ntwo\r\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!("one\ntwo\n", store.text);
        assert_eq!(LineEnding::Crlf, store.line_ending);
        assert!(store.had_bom);
        assert_eq!(TextEncoding::Utf8, store.encoding);
        assert_eq!("utf8-bom", store.encoding_label());
    }

    #[test]
    fn save_roundtrip_preserves_all_bom_eol_combinations() {
        // BOM x EOL Matrix: Save muss das Original-Encoding exakt
        // restaurieren — insbesondere KEIN BOM hinzufuegen, wenn keins
        // da war. Bisher war nur BOM+CRLF unit-getestet; die uebrigen
        // Kombis liefen nur im Linux-only-E2E (08_save_roundtrip).
        let bom: &[u8] = &[0xEF, 0xBB, 0xBF];
        for (with_bom, crlf) in [(true, true), (true, false), (false, true), (false, false)] {
            let eol: &[u8] = if crlf { b"\r\n" } else { b"\n" };
            let mut input = Vec::new();
            if with_bom {
                input.extend_from_slice(bom);
            }
            input.extend_from_slice(b"one");
            input.extend_from_slice(eol);
            input.extend_from_slice(b"two");
            input.extend_from_slice(eol);

            let temp = TempDir::new().unwrap();
            let path = temp.path().join("doc.md");
            fs::write(&path, &input).unwrap();
            let mut store = DocumentStore::new();
            store.load(path.to_str().unwrap()).unwrap();
            store.update_text("one\nzwei\n".into()).unwrap();
            assert!(store.save().unwrap());

            let mut expected = Vec::new();
            if with_bom {
                expected.extend_from_slice(bom);
            }
            expected.extend_from_slice(b"one");
            expected.extend_from_slice(eol);
            expected.extend_from_slice(b"zwei");
            expected.extend_from_slice(eol);
            assert_eq!(
                expected,
                fs::read(&path).unwrap(),
                "combo bom={with_bom} crlf={crlf}"
            );
        }
    }

    #[test]
    fn mixed_line_endings_are_classified_crlf_and_unified_on_save() {
        // Verhaltens-Pin (bewusste Vereinfachung, siehe read_and_decode):
        // gemischte Endings gelten als CRLF, ein Save vereinheitlicht
        // alle Zeilen auf CRLF.
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"a\r\nb\nc\r\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!(LineEnding::Crlf, store.line_ending);
        assert_eq!("a\nb\nc\n", store.text);

        store.update_text("a\nb\nc\nd\n".into()).unwrap();
        assert!(store.save().unwrap());
        assert_eq!(b"a\r\nb\r\nc\r\nd\r\n".to_vec(), fs::read(&path).unwrap());
    }

    #[test]
    fn update_text_sets_dirty_when_file_loaded() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, "one").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        store.update_text("two".into()).unwrap();
        assert!(store.is_dirty);
    }

    #[test]
    fn update_text_clears_dirty_when_reverted_to_clean_text() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, "one").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();

        store.update_text("two".into()).unwrap();
        assert!(store.is_dirty);
        // Undo zurueck zum geladenen Stand -> Store wieder clean.
        store.update_text("one".into()).unwrap();
        assert!(!store.is_dirty);

        // Nach einem Save ist der gespeicherte Text die neue Referenz.
        store.update_text("three".into()).unwrap();
        store.save().unwrap();
        assert!(!store.is_dirty);
        store.update_text("one".into()).unwrap();
        assert!(store.is_dirty);
        store.update_text("three".into()).unwrap();
        assert!(!store.is_dirty);
    }

    #[test]
    fn save_as_writes_target_and_updates_path() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("alt.md");
        let dst = temp.path().join("neu.md");
        fs::write(&src, b"hello\r\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(src.to_str().unwrap()).unwrap();
        store.update_text("world\n".into()).unwrap();
        assert!(store.is_dirty);
        let loaded = store.save_as(dst.to_str().unwrap()).unwrap();
        assert_eq!(dst.to_string_lossy().to_string(), loaded.path);
        // Pfad umgehängt, dirty zurückgesetzt
        assert_eq!(Some(dst.to_string_lossy().to_string()), store.path);
        assert!(!store.is_dirty);
        // Inhalt am neuen Pfad mit Original-Line-Endings (CRLF)
        assert_eq!(b"world\r\n".to_vec(), fs::read(&dst).unwrap());
        // Original bleibt unangetastet
        assert_eq!(b"hello\r\n".to_vec(), fs::read(&src).unwrap());
    }

    #[test]
    fn reload_if_changed_picks_up_disk_changes_and_skips_unchanged() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, "one\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();

        // unverändert -> No-Op
        assert!(!store.reload_if_changed().unwrap());

        // externer Schreibvorgang -> reload zieht den neuen Inhalt nach
        fs::write(&path, "two\n").unwrap();
        assert!(store.reload_if_changed().unwrap());
        assert_eq!("two\n", store.text);
        assert!(!store.is_dirty);
    }

    #[test]
    fn reload_if_changed_updates_metadata_on_format_only_change() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        // Start: LF, kein BOM.
        fs::write(&path, b"one\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!(LineEnding::Lf, store.line_ending);
        assert!(!store.had_bom);

        // Extern auf CRLF + BOM umgestellt, Inhalt identisch.
        fs::write(&path, b"\xEF\xBB\xBFone\r\n").unwrap();
        // Kein loaded-Callback (Inhalt gleich) → reload_if_changed gibt false.
        assert!(!store.reload_if_changed().unwrap());
        // Metadaten muessen aber nachgezogen sein, sonst rollt der naechste
        // save() die externe Format-Entscheidung zurueck.
        assert_eq!(LineEnding::Crlf, store.line_ending);
        assert!(store.had_bom);

        // Verify: ein anschliessender Save respektiert die neuen Metadaten.
        assert!(store.save().unwrap());
        assert_eq!(b"\xEF\xBB\xBFone\r\n".to_vec(), fs::read(&path).unwrap());
    }

    #[test]
    fn save_restores_original_line_endings_and_bom() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"\xEF\xBB\xBFone\r\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        store.update_text("a\nb\n".into()).unwrap();
        assert!(store.save().unwrap());
        assert_eq!(b"\xEF\xBB\xBFa\r\nb\r\n".to_vec(), fs::read(path).unwrap());
        assert!(!store.is_dirty);
    }

    #[test]
    fn plain_utf8_reports_utf8_label_without_bom() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"hello\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!(TextEncoding::Utf8, store.encoding);
        assert!(!store.had_bom);
        assert_eq!("utf8", store.encoding_label());
    }

    #[test]
    fn windows1252_file_loads_and_saves_roundtrip() {
        // Alt-SSMS-Skript-Szenario: ä/ö/ü als Windows-1252-Einzelbytes
        // (kein gueltiges UTF-8) → Fallback greift, Save schreibt wieder 1252.
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("legacy.sql");
        // "Käse" mit ä = 0xE4, CRLF.
        fs::write(&path, b"K\xE4se\r\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!(TextEncoding::Windows1252, store.encoding);
        assert!(!store.had_bom);
        assert_eq!(LineEnding::Crlf, store.line_ending);
        assert_eq!("Käse\n", store.text);
        assert_eq!("windows1252", store.encoding_label());

        // Weiteres Umlaut einfuegen + speichern → Umlaute als 1252-Bytes.
        store.update_text("Käse ö\n".into()).unwrap();
        assert!(store.save().unwrap());
        assert_eq!(b"K\xE4se \xF6\r\n".to_vec(), fs::read(&path).unwrap());
    }

    #[test]
    fn utf16_le_and_be_roundtrip_byte_exact_and_reload() {
        for big_endian in [false, true] {
            let temp = TempDir::new().unwrap();
            let path = temp.path().join("doc.txt");
            // BOM + "Hi\r\nÄ" (enthaelt CRLF).
            let mut input = Vec::new();
            input.extend_from_slice(if big_endian {
                &[0xFE, 0xFF]
            } else {
                &[0xFF, 0xFE]
            });
            for unit in "Hi\r\nÄ".encode_utf16() {
                if big_endian {
                    input.extend_from_slice(&unit.to_be_bytes());
                } else {
                    input.extend_from_slice(&unit.to_le_bytes());
                }
            }
            fs::write(&path, &input).unwrap();

            let mut store = DocumentStore::new();
            store.load(path.to_str().unwrap()).unwrap();
            let expected_enc = if big_endian {
                TextEncoding::Utf16Be
            } else {
                TextEncoding::Utf16Le
            };
            assert_eq!(expected_enc, store.encoding);
            assert!(store.had_bom);
            assert_eq!(LineEnding::Crlf, store.line_ending);
            assert_eq!("Hi\nÄ", store.text);

            // Save ohne Aenderung → byte-exakter Roundtrip inkl. BOM.
            assert!(store.save().unwrap());
            assert_eq!(input, fs::read(&path).unwrap());

            // Editieren + speichern + neu laden → Encoding/Text erhalten.
            store.update_text("Hi\nÄ!".into()).unwrap();
            assert!(store.save().unwrap());
            let mut reloaded = DocumentStore::new();
            reloaded.load(path.to_str().unwrap()).unwrap();
            assert_eq!("Hi\nÄ!", reloaded.text);
            assert_eq!(expected_enc, reloaded.encoding);
            assert!(reloaded.had_bom);
        }
    }

    #[test]
    fn windows1252_save_rejects_unmappable_char_and_leaves_file() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("legacy.txt");
        let original = b"K\xE4se\n".to_vec(); // "Käse" in 1252, LF
        fs::write(&path, &original).unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!(TextEncoding::Windows1252, store.encoding);

        // Emoji einfuegen → nicht in Windows-1252 darstellbar.
        store.update_text("Käse 😀\n".into()).unwrap();
        match store.save() {
            Err(SaveError::Unmappable(chars)) => assert!(chars.contains(&'😀')),
            other => panic!("expected Unmappable, got {other:?}"),
        }
        // Datei liegt unveraendert auf Platte (kein HTML-Entity-Ersatz).
        assert_eq!(original, fs::read(&path).unwrap());
        // clean_text/is_dirty duerfen NICHT auf gespeichert gewechselt sein.
        assert!(store.is_dirty);
    }

    #[test]
    fn utf16_malformed_load_fails_and_leaves_file_unchanged() {
        // encoding_rs ersetzt kaputte UTF-16-Einheiten still durch U+FFFD und
        // meldet had_errors — der Load muss VOR jeder Store-Mutation abbrechen,
        // sonst schriebe ein spaeterer Save die Ersatzzeichen auf Platte.
        for input in [
            vec![0xFF, 0xFE, 0x41],       // ungerade Nutzdatenlaenge nach LE-BOM
            vec![0xFF, 0xFE, 0x00, 0xD8], // lone high surrogate (D800) nach LE-BOM
            vec![0xFE, 0xFF, 0xDC, 0x00], // lone low surrogate (DC00) nach BE-BOM
        ] {
            let temp = TempDir::new().unwrap();
            let path = temp.path().join("bad.txt");
            fs::write(&path, &input).unwrap();
            let mut store = DocumentStore::new();
            let err = store.load(path.to_str().unwrap()).unwrap_err();
            assert_eq!(io::ErrorKind::InvalidData, err.kind());
            // Store unberuehrt (kein Pfad gesetzt) + Datei byte-identisch.
            assert!(store.path.is_none());
            assert_eq!(input, fs::read(&path).unwrap(), "input={input:?}");
        }
    }

    #[test]
    fn reload_metadata_only_encoding_change_fires_callback() {
        use std::sync::Mutex;
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"one\n").unwrap(); // UTF-8 ohne BOM
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_cb = seen.clone();
        let mut store = DocumentStore::new();
        store.set_events(DocumentEvents {
            encoding_changed: Some(Arc::new(move |label| {
                seen_cb.lock().unwrap().push(label);
            })),
            ..DocumentEvents::default()
        });
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!("utf8", store.encoding_label());

        // Extern NUR BOM ergaenzt (Text identisch) → reload gibt false zurueck
        // (kein loaded), feuert aber encoding_changed mit dem neuen Label.
        fs::write(&path, b"\xEF\xBB\xBFone\n").unwrap();
        assert!(!store.reload_if_changed().unwrap());
        assert_eq!("utf8-bom", store.encoding_label());
        assert_eq!(vec!["utf8-bom".to_string()], *seen.lock().unwrap());

        // Erneuter Reload ohne Aenderung → kein weiterer Callback.
        assert!(!store.reload_if_changed().unwrap());
        assert_eq!(1, seen.lock().unwrap().len());
    }

    #[test]
    fn set_line_ending_toggle_marks_dirty() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"hello\n").unwrap(); // LF
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!(LineEnding::Lf, store.line_ending);
        assert!(!store.is_dirty);

        assert!(store.set_line_ending(LineEnding::Crlf).unwrap());
        assert_eq!(LineEnding::Crlf, store.line_ending);
        assert!(store.is_dirty);

        // Gleicher Wert → No-op, bleibt dirty.
        assert!(!store.set_line_ending(LineEnding::Crlf).unwrap());
        assert!(store.is_dirty);
    }

    #[test]
    fn set_line_ending_save_writes_new_eol_and_clears_dirty() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"a\r\nb\r\n").unwrap(); // CRLF
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!(LineEnding::Crlf, store.line_ending);

        assert!(store.set_line_ending(LineEnding::Lf).unwrap());
        assert!(store.is_dirty);
        assert!(store.save().unwrap());
        assert!(!store.is_dirty);
        assert_eq!(LineEnding::Lf, store.line_ending);
        // Datei enthaelt nur LF (kein CR).
        assert_eq!(b"a\nb\n".to_vec(), fs::read(&path).unwrap());
    }

    #[test]
    fn set_line_ending_plus_text_revert_stays_dirty() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"one\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();

        // EOL umschalten → dirty.
        assert!(store.set_line_ending(LineEnding::Crlf).unwrap());
        assert!(store.is_dirty);

        // Text aendern und wieder zum clean_text reverten — EOL bleibt
        // abweichend, also dirty (nicht fälschlich clean).
        store.update_text("two\n".into()).unwrap();
        assert!(store.is_dirty);
        store.update_text("one\n".into()).unwrap();
        assert!(store.is_dirty);
        assert_eq!(LineEnding::Crlf, store.line_ending);
    }

    #[test]
    fn set_line_ending_double_toggle_back_is_clean() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"hello\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();

        assert!(store.set_line_ending(LineEnding::Crlf).unwrap());
        assert!(store.is_dirty);
        assert!(store.set_line_ending(LineEnding::Lf).unwrap());
        assert!(!store.is_dirty);
        assert_eq!(LineEnding::Lf, store.line_ending);
    }

    #[test]
    fn set_line_ending_on_opaque_is_error_and_stays_clean() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("photo.png");
        fs::write(&path, b"\x89PNG").unwrap();
        let mut store = DocumentStore::new();
        store.load_opaque(path.to_str().unwrap()).unwrap();
        assert!(store.is_opaque());
        assert!(!store.is_dirty);
        assert_eq!(LineEnding::Lf, store.line_ending);

        assert_eq!(
            Err(StoreWriteError::Opaque),
            store.set_line_ending(LineEnding::Crlf)
        );
        assert!(!store.is_dirty);
        assert_eq!(LineEnding::Lf, store.line_ending);
        assert!(store.is_opaque());
        assert_eq!(b"\x89PNG".as_slice(), fs::read(&path).unwrap());
    }

    #[test]
    fn format_only_reload_eol_change_fires_eol_changed_callback() {
        use std::sync::Mutex;
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        // Start: CRLF.
        fs::write(&path, b"one\r\n").unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_cb = seen.clone();
        let mut store = DocumentStore::new();
        store.set_events(DocumentEvents {
            eol_changed: Some(Arc::new(move |label| {
                seen_cb.lock().unwrap().push(label);
            })),
            ..DocumentEvents::default()
        });
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!(LineEnding::Crlf, store.line_ending);

        // Extern nur EOL auf LF (normalisierter Text identisch).
        fs::write(&path, b"one\n").unwrap();
        assert!(!store.reload_if_changed().unwrap());
        assert_eq!(LineEnding::Lf, store.line_ending);
        assert_eq!(vec!["lf".to_string()], *seen.lock().unwrap());

        // Erneuter Reload ohne Aenderung → kein weiterer Callback.
        assert!(!store.reload_if_changed().unwrap());
        assert_eq!(1, seen.lock().unwrap().len());
    }

    fn opaque_probe(temp: &TempDir) -> (DocumentStore, std::path::PathBuf, Vec<u8>) {
        let path = temp.path().join("probe.png");
        let bytes = b"\x89PNG\r\n\x1a\nOPAQUE-PROBE".to_vec();
        fs::write(&path, &bytes).unwrap();
        let mut store = DocumentStore::new();
        store.load_opaque(path.to_str().unwrap()).unwrap();
        (store, path, bytes)
    }

    #[test]
    fn update_text_on_opaque_errors_without_mutating_store_or_disk() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let temp = TempDir::new().unwrap();
        let (mut store, path, before) = opaque_probe(&temp);
        let text_changed = Arc::new(AtomicUsize::new(0));
        let dirty_changed = Arc::new(AtomicUsize::new(0));
        let eol_changed = Arc::new(AtomicUsize::new(0));
        let saved = Arc::new(AtomicUsize::new(0));
        let text_cb = text_changed.clone();
        let dirty_cb = dirty_changed.clone();
        let eol_cb = eol_changed.clone();
        let saved_cb = saved.clone();
        store.set_events(DocumentEvents {
            text_changed: Some(Arc::new(move |_| {
                text_cb.fetch_add(1, Ordering::SeqCst);
            })),
            dirty_changed: Some(Arc::new(move |_| {
                dirty_cb.fetch_add(1, Ordering::SeqCst);
            })),
            eol_changed: Some(Arc::new(move |_| {
                eol_cb.fetch_add(1, Ordering::SeqCst);
            })),
            saved: Some(Arc::new(move |_, _| {
                saved_cb.fetch_add(1, Ordering::SeqCst);
            })),
            ..DocumentEvents::default()
        });

        assert_eq!(
            Err(StoreWriteError::Opaque),
            store.update_text("KAPUTT".into())
        );
        assert_eq!(
            Err(StoreWriteError::Opaque),
            store.set_line_ending(LineEnding::Crlf)
        );
        assert!(matches!(store.save(), Err(SaveError::Opaque)));
        assert!(store.is_opaque());
        assert_eq!("", store.text);
        assert!(!store.is_dirty);
        assert_eq!(0, text_changed.load(Ordering::SeqCst));
        assert_eq!(0, dirty_changed.load(Ordering::SeqCst));
        assert_eq!(0, eol_changed.load(Ordering::SeqCst));
        assert_eq!(0, saved.load(Ordering::SeqCst));
        assert_eq!(before, fs::read(&path).unwrap());
    }

    #[test]
    fn save_on_opaque_errors_and_leaves_disk_byte_identical() {
        let temp = TempDir::new().unwrap();
        let (mut store, path, before) = opaque_probe(&temp);
        assert!(matches!(store.save(), Err(SaveError::Opaque)));
        assert!(store.is_opaque());
        assert_eq!(before, fs::read(&path).unwrap());
    }

    #[test]
    fn save_as_on_opaque_errors_and_writes_nothing() {
        let temp = TempDir::new().unwrap();
        let (mut store, path, before) = opaque_probe(&temp);
        let target = temp.path().join("out.txt");
        assert!(matches!(
            store.save_as(target.to_str().unwrap()),
            Err(SaveError::Opaque)
        ));
        assert!(!target.exists());
        assert!(store.is_opaque());
        assert_eq!(before, fs::read(&path).unwrap());
    }

    #[test]
    fn opaque_update_then_save_replays_reported_overwrite() {
        let temp = TempDir::new().unwrap();
        let (mut store, path, before) = opaque_probe(&temp);
        assert!(store.update_text("KAPUTT".into()).is_err());
        assert!(store.save().is_err());
        assert_eq!(before, fs::read(&path).unwrap());
        assert_eq!("", store.text);
        assert!(store.is_opaque());
    }

    #[test]
    fn text_document_mutations_remain_allowed() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("note.md");
        fs::write(&path, b"hello\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();

        store.update_text("world\n".into()).unwrap();
        assert!(store.is_dirty);
        assert!(store.set_line_ending(LineEnding::Crlf).unwrap());
        assert!(store.save().unwrap());
        assert_eq!(b"world\r\n".as_slice(), fs::read(&path).unwrap());

        let target = temp.path().join("copy.md");
        store.save_as(target.to_str().unwrap()).unwrap();
        assert_eq!(b"world\r\n".as_slice(), fs::read(&target).unwrap());
        assert!(!store.is_opaque());
    }

    #[test]
    fn reload_if_changed_on_opaque_is_noop_and_stays_opaque() {
        let temp = TempDir::new().unwrap();
        let (mut store, path, before) = opaque_probe(&temp);
        assert!(!store.reload_if_changed().unwrap());
        assert!(store.is_opaque());
        assert_eq!("", store.text);
        assert_eq!(before, fs::read(&path).unwrap());
    }
}
