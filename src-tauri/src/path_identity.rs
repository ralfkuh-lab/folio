//! Tauri-freie Pfad-Identität: „ist das dieselbe Datei auf der Platte?"
//!
//! In Folio gibt es genau zwei Vergleichs-Semantiken, und jede Aufrufstelle
//! wählt bewusst:
//!
//! * [`same_file`] / [`identity_key`] — **mit** Datei-IO (`fs::canonicalize`).
//!   Löst Symlinks, `.`/`..` und die Schreibweise case-insensitiver Volumes
//!   auf. Nur für seltene, ohnehin IO-behaftete Vorgänge (Öffnen, Pin,
//!   Recent, Watcher-Event) — **niemals** in einem Render- oder Walk-Pfad.
//! * [`lexical_paths_equal`] — **ohne** Datei-IO, rein auf den Strings nach
//!   den Case-Regeln des Dateisystems. Für Pfade, die aus demselben Walk
//!   stammen und deshalb schon konsistent sind (Wikilink-Index, Backlinks).
//!
//! Davon getrennt bleibt `path_migration` (Präfix-Rewrite auf Segmentgrenze,
//! ebenfalls rein lexikalisch).
//!
//! Der Identitäts-Schlüssel ist **nur** ein Vergleichswert: er wird nirgends
//! persistiert, angezeigt oder ans Frontend gegeben. Gespeichert und
//! dargestellt bleibt immer die Schreibweise, mit der der Nutzer navigiert
//! hat — sonst stünde auf macOS `/private/tmp/…` in der Statusleiste und auf
//! Windows ein `\\?\`-Präfix in `data-path`.

use std::cell::OnceCell;
use std::fs;

/// Schlüssel für „ist das dieselbe Datei?". Kanonisiert physisch (Symlinks,
/// `.`/`..`, Windows-Case) und strippt den Windows-UNC-Präfix.
///
/// Existiert der Pfad nicht (oder ist er gerade nicht erreichbar), fällt der
/// Schlüssel auf den lexikalisch normalisierten Eingabepfad zurück — das ist
/// exakt das heutige String-Verhalten und hält `pending_path`/Restore-Pfade
/// funktionsfähig. Der UNC-Präfix wird in **beiden** Zweigen entfernt, sonst
/// wären `\\?\C:\missing\a.md` und `C:\missing\a.md` zwei Schlüssel für
/// dieselbe (noch) fehlende Datei.
///
/// Bewusst **ohne Cache**: Öffnen ist selten und ohnehin IO-behaftet, ein
/// Cache bräuchte Invalidierung bei jedem Rename/Delete/Watcher-Event.
pub fn identity_key(path: &str) -> String {
    match fs::canonicalize(path) {
        Ok(resolved) => strip_unc_prefix(&resolved.to_string_lossy().replace('\\', "/")),
        // `lexical_normalize` strippt den Präfix selbst.
        Err(_) => lexical_normalize(path),
    }
}

/// Zeigen `a` und `b` auf dieselbe Datei?
///
/// Fast-Path ohne Syscall: identische Strings sind trivialerweise dieselbe
/// Datei — `identity_key` ist für gleiche Eingaben ohnehin gleich. Erst bei
/// abweichender Schreibweise wird kanonisiert.
pub fn same_file(a: &str, b: &str) -> bool {
    a == b || identity_key(a) == identity_key(b)
}

/// Vergleichsziel für Schleifen: hält den gesuchten Pfad und bildet dessen
/// Identitäts-Schlüssel **erst**, wenn ein Kandidat per String nicht passt —
/// danach bleibt er gecacht.
///
/// Ohne das kanonisiert jede Dedup-Schleife (Tabs, Pins, Recents) beide
/// Seiten für jeden Kandidaten, obwohl der häufigste Fall — gleiche
/// Schreibweise — ganz ohne Datei-IO entschieden ist. `reorder_pinned` war
/// so bei jedem Pin-Drag O(n·m) `canonicalize`.
pub struct FileMatcher<'a> {
    path: &'a str,
    key: OnceCell<String>,
}

impl<'a> FileMatcher<'a> {
    pub fn new(path: &'a str) -> Self {
        Self {
            path,
            key: OnceCell::new(),
        }
    }

    /// Ist `candidate` dieselbe Datei wie der gesuchte Pfad?
    pub fn matches(&self, candidate: &str) -> bool {
        candidate == self.path || *self.key() == identity_key(candidate)
    }

    fn key(&self) -> &String {
        self.key.get_or_init(|| identity_key(self.path))
    }
}

/// Lexikalische Normalform ohne jedes Datei-IO: Backslashes → `/`,
/// Windows-UNC-Präfix entfernt, doppelte Trennzeichen und `.`-Segmente weg,
/// `..` gegen das Vorgängersegment gekürzt, Trailing-Slash weg.
///
/// Die Wurzel ist dabei **unteilbar** und wird von `..` nie unterschritten:
/// `/`, ein Laufwerk (`C:/`) und die UNC-Freigabe (`//server/share/`). Sonst
/// würde aus dem absoluten `C:/a/../../b.md` der relative `b.md` — und das
/// nicht nur im Fallback-Schlüssel, sondern über
/// `file_resolver::resolve_existing_path` im Produktionspfad jedes
/// Link-Klicks.
///
/// **Laufwerksrelative Pfade** (`C:a/b`, „relativ zum aktuellen Verzeichnis
/// auf C:") behalten ihren Laufwerks-Präfix und bleiben relativ — ein
/// führendes `..` bleibt also stehen, statt still zu `C:/…` zu werden.
///
/// Kein Case-Folding: auf case-insensitiven Systemen ist die Datei entweder
/// da (dann greift `canonicalize`) oder es gibt nichts zu vergleichen.
pub fn lexical_normalize(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let normalized = strip_unc_prefix(&slashed);
    let (root, rest, absolute) = split_root(&normalized);

    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split('/') {
        match segment {
            "" | "." => {}
            ".." => match segments.last() {
                // Ein `..` hinter einem echten Segment kürzt es weg.
                Some(last) if *last != ".." => {
                    segments.pop();
                }
                // Über die Wurzel hinaus gibt es nichts zu kürzen; auf einem
                // relativen Pfad bleibt das `..` bedeutungstragend stehen.
                _ => {
                    if !absolute {
                        segments.push(segment);
                    }
                }
            },
            other => segments.push(other),
        }
    }

    format!("{root}{}", segments.join("/"))
}

/// Zerlegt einen Forward-Slash-Pfad in (Wurzel-Präfix, Rest, ist-absolut).
///
/// Das Präfix trägt bei absoluten Pfaden bereits das trennende `/`, sodass
/// `root + segments.join("/")` immer stimmt — auch wenn kein Segment übrig
/// bleibt (`C:/` bleibt `C:/`, nicht `C:`). Führende Trennzeichen im Rest
/// stören nicht: die Segment-Schleife überspringt leere Segmente.
fn split_root(path: &str) -> (String, &str, bool) {
    if let Some(after_slashes) = path.strip_prefix("//") {
        // UNC: die Wurzel ist `//server/share`, nicht `//` — ein `..` darf
        // die Freigabe nicht wegkürzen.
        let server_len = after_slashes.find('/').unwrap_or(after_slashes.len());
        let share_len = after_slashes[server_len..]
            .strip_prefix('/')
            .map_or(0, |tail| 1 + tail.find('/').unwrap_or(tail.len()));
        let root_len = 2 + server_len + share_len;
        return (
            with_trailing_slash(&path[..root_len]),
            &path[root_len..],
            true,
        );
    }
    if let Some(rest) = path.strip_prefix('/') {
        return ("/".to_string(), rest, true);
    }
    if is_drive_prefix(path) {
        return if path.as_bytes().get(2) == Some(&b'/') {
            // `C:/…` — absolut, `..` klemmt am Laufwerk.
            (with_trailing_slash(&path[..2]), &path[3..], true)
        } else {
            // `C:…` — laufwerksrelativ ("aktuelles Verzeichnis auf C:").
            // Bleibt relativ, damit aus `C:../a` nicht still `C:/a` wird.
            (path[..2].to_string(), &path[2..], false)
        };
    }
    (String::new(), path, false)
}

fn with_trailing_slash(prefix: &str) -> String {
    if prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    }
}

/// `C:` am Anfang (Laufwerksbuchstabe + Doppelpunkt).
fn is_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Gleichheit zweier bereits Forward-Slash-normalisierter Pfade nach den
/// Regeln des Dateisystems: case-insensitiv auf Windows/macOS, sonst exakt.
///
/// Bewusst **ohne** `canonicalize` — anders als [`same_file`]. Die Aufrufer
/// (Wikilink-Index, Backlink-Scan) vergleichen Pfade aus demselben Walk, die
/// deshalb schon konsistent sind; ein `canonicalize` pro Vergleich wäre dort
/// ein IO-Aufschlag über Tausende Dateien. Die Namensauflösung ist
/// case-insensitiv — ein exakter Vergleich am Ende liess auf
/// case-insensitiven Volumes Backlinks verschwinden, wenn die Schreibweise
/// des geöffneten Dokuments vom Walk abwich (Review kimi #6).
pub fn lexical_paths_equal(a: &str, b: &str) -> bool {
    #[cfg(any(windows, target_os = "macos"))]
    {
        a.eq_ignore_ascii_case(b) || a.to_lowercase() == b.to_lowercase()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        a == b
    }
}

/// Entfernt den Windows-Extended-Length-Präfix, den `fs::canonicalize` dort
/// voranstellt. Er darf weder in einen Vergleich mit einem Fallback-Schlüssel
/// geraten noch in persistierte Daten oder ins DOM.
fn strip_unc_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = path.strip_prefix("//?/") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use tempfile::TempDir;

    #[test]
    fn lexical_normalize_resolves_dot_segments() {
        assert_eq!("/a/b.md", lexical_normalize("/a/./b.md"));
        assert_eq!("/a/b.md", lexical_normalize("/a/x/../b.md"));
        assert_eq!("/a/b.md", lexical_normalize("/a//b.md"));
        assert_eq!("/a/b.md", lexical_normalize("/a/b.md/"));
        assert_eq!("C:/a/b.md", lexical_normalize(r"C:\a\.\b.md"));
        assert_eq!(
            "//server/share/a.md",
            lexical_normalize(r"\\server\share\a.md")
        );
    }

    #[test]
    fn lexical_normalize_keeps_leading_parent_on_relative_paths() {
        assert_eq!("../a.md", lexical_normalize("../a.md"));
        assert_eq!("../../a.md", lexical_normalize("../x/../../a.md"));
        // Über die Wurzel hinaus gibt es kein Vorgängersegment.
        assert_eq!("/a.md", lexical_normalize("/../a.md"));
    }

    /// F1: `..` darf keine Wurzel unterschreiten — sonst wird aus einem
    /// absoluten Pfad ein relativer. Betrifft nicht nur den Fallback-
    /// Schlüssel: `file_resolver::resolve_existing_path` schickt auf Windows
    /// jeden aufgelösten Link-Pfad hier durch.
    #[test]
    fn lexical_normalize_clamps_parent_segments_at_windows_roots() {
        // Laufwerkswurzel bleibt stehen.
        assert_eq!("C:/b.md", lexical_normalize("C:/a/../../b.md"));
        assert_eq!("C:/b.md", lexical_normalize(r"C:\a\..\..\..\b.md"));
        assert_eq!("C:/", lexical_normalize("C:/"));
        assert_eq!("C:/", lexical_normalize(r"C:\"));
        assert_eq!("C:/a", lexical_normalize("C:/a/"));
        assert_eq!("c:/a.md", lexical_normalize(r"c:\a.md"));

        // UNC-Freigabe bleibt stehen.
        assert_eq!(
            "//server/share/b.md",
            lexical_normalize("//server/share/a/../../../b.md")
        );
        assert_eq!("//server/share/", lexical_normalize("//server/share"));
        assert_eq!("//server/share/", lexical_normalize("//server/share/"));

        // Unix-Wurzel unverändert (Regression zur Vorfassung).
        assert_eq!("/b.md", lexical_normalize("/a/../../b.md"));
    }

    /// Laufwerksrelativ (`C:a`, „aktuelles Verzeichnis auf C:") ist KEIN
    /// absoluter Pfad — der Laufwerks-Präfix bleibt, das führende `..` auch.
    #[test]
    fn lexical_normalize_keeps_drive_relative_paths_relative() {
        assert_eq!("C:b", lexical_normalize("C:a/../b"));
        assert_eq!("C:../b", lexical_normalize(r"C:..\b"));
        assert_eq!("C:", lexical_normalize("C:"));
        assert_eq!("C:a/b", lexical_normalize("C:a/b"));
    }

    /// F2: der Extended-Length-Präfix verschwindet auch dort, wo
    /// `canonicalize` gar nicht erst laufen kann — sonst tragen
    /// Pending-/Restore-Pfade zwei Schlüssel für dieselbe fehlende Datei.
    #[test]
    fn unc_prefix_is_stripped_in_the_fallback_branch_too() {
        let missing = r"C:\missing\a.md";
        assert_eq!("C:/missing/a.md", identity_key(missing));
        assert_eq!("C:/missing/a.md", identity_key(r"\\?\C:\missing\a.md"));
        assert!(same_file(r"\\?\C:\missing\a.md", missing));

        let share = r"\\server\share\missing\a.md";
        assert_eq!("//server/share/missing/a.md", identity_key(share));
        assert_eq!(
            "//server/share/missing/a.md",
            identity_key(r"\\?\UNC\server\share\missing\a.md")
        );
        assert!(same_file(r"\\?\UNC\server\share\missing\a.md", share));
    }

    /// F4: gleiche Schreibweise wird ohne Syscall entschieden, der Schlüssel
    /// entsteht erst beim ersten abweichenden Kandidaten und bleibt gecacht.
    #[test]
    fn file_matcher_short_circuits_on_identical_strings() {
        let matcher = FileMatcher::new("/nope/x/a.md");
        assert!(matcher.matches("/nope/x/a.md"));
        assert!(matcher.matches("/nope/x/./a.md"));
        assert!(matcher.matches("/nope/x/y/../a.md"));
        assert!(!matcher.matches("/nope/x/b.md"));
    }

    #[test]
    fn same_file_matches_dot_segment_spellings() -> io::Result<()> {
        let temp = TempDir::new()?;
        let dir = temp.path().join("a");
        let sub = dir.join("x");
        fs::create_dir_all(&sub)?;
        fs::write(dir.join("b.md"), "")?;

        let dotted = dir.join(".").join("b.md");
        let parented = sub.join("..").join("b.md");
        assert!(same_file(
            dotted.to_str().unwrap(),
            parented.to_str().unwrap()
        ));
        Ok(())
    }

    // Symlinks anlegen braucht auf Windows den Developer Mode; der Testlauf
    // dort soll daran nicht scheitern. Die Windows-Seite des Problems ist
    // ohnehin die Case-Insensitivität, die `canonicalize` mit abdeckt.
    #[cfg(unix)]
    #[test]
    fn same_file_sees_through_a_symlinked_directory() -> io::Result<()> {
        let temp = TempDir::new()?;
        let real = temp.path().join("real");
        fs::create_dir(&real)?;
        fs::write(real.join("a.md"), "")?;
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&real, &link)?;

        let via_link = link.join("a.md").to_string_lossy().into_owned();
        let via_real = real.join("a.md").to_string_lossy().into_owned();

        assert_ne!(via_link, via_real, "die Strings müssen verschieden sein");
        assert!(same_file(&via_link, &via_real));
        Ok(())
    }

    #[test]
    fn missing_paths_fall_back_to_the_lexical_key() {
        // Zwei verschiedene tote Pfade bleiben verschieden — der frühere
        // `canonicalize(a).ok() == canonicalize(b).ok()` hielt sie beide für
        // `None` und damit für dieselbe Datei (Watcher-Filter-Bug).
        assert!(!same_file(
            "/nope/does-not-exist-a.md",
            "/nope/does-not-exist-b.md"
        ));
        // Zwei Schreibweisen desselben toten Pfads bleiben identisch.
        assert!(same_file("/nope//x/a.md", "/nope/x/a.md"));
        assert!(same_file("/nope/x/./a.md", "/nope/x/y/../a.md"));
    }

    #[test]
    fn identity_key_never_carries_a_unc_prefix() -> io::Result<()> {
        let temp = TempDir::new()?;
        let file = temp.path().join("a.md");
        fs::write(&file, "")?;

        let key = identity_key(file.to_str().unwrap());
        assert!(
            !key.starts_with(r"\\?\"),
            "roher UNC-Präfix im Schlüssel: {key}"
        );
        assert!(!key.starts_with("//?/"), "UNC-Präfix im Schlüssel: {key}");
        assert!(!key.contains('\\'), "Backslash im Schlüssel: {key}");
        Ok(())
    }

    #[test]
    fn strip_unc_prefix_handles_both_windows_forms() {
        assert_eq!("C:/notes/a.md", strip_unc_prefix("//?/C:/notes/a.md"));
        assert_eq!(
            "//server/share/a.md",
            strip_unc_prefix("//?/UNC/server/share/a.md")
        );
        assert_eq!("/tmp/a.md", strip_unc_prefix("/tmp/a.md"));
    }

    // Aus `wikilink.rs` mitgewandert (dort hiess die Funktion `paths_equal`).
    #[test]
    fn lexical_paths_equal_matches_platform_filesystem_semantics() {
        assert!(lexical_paths_equal(
            "/vault/Notes/Beta.md",
            "/vault/Notes/Beta.md"
        ));
        assert!(!lexical_paths_equal(
            "/vault/Notes/Beta.md",
            "/vault/Notes/Other.md"
        ));
        let mixed_case_matches =
            lexical_paths_equal("/vault/Notes/Beta.md", "/vault/notes/beta.md");
        if cfg!(any(windows, target_os = "macos")) {
            assert!(
                mixed_case_matches,
                "case-insensitive Volumes vergleichen gefaltet"
            );
        } else {
            assert!(!mixed_case_matches, "Linux vergleicht exakt");
        }
    }
}
