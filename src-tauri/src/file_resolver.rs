use std::{
    borrow::Cow,
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
};

pub fn split_anchor(target: &str) -> (&str, Option<&str>) {
    target
        .split_once('#')
        .map_or((target, None), |(path, anchor)| (path, Some(anchor)))
}

pub fn is_markdown(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

pub fn is_html(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

pub fn resolve(current_file_path: &str, link_target: &str) -> Option<String> {
    let (path_part, _) = split_anchor(link_target);
    let decoded = percent_decode(path_part)?;
    let current_path = Path::new(current_file_path);
    let candidate = if decoded.is_empty() {
        current_path.to_path_buf()
    } else {
        let decoded_path = Path::new(decoded.as_ref());
        if decoded_path.is_absolute() {
            decoded_path.to_path_buf()
        } else {
            current_path.parent()?.join(decoded_path)
        }
    };

    resolve_existing_path(&candidate).map(|path| path.to_string_lossy().into_owned())
}

/// Erzeugt einen Pfad, der `target` relativ zu `from_dir` ausdrueckt. Die
/// Rueckgabe ist immer mit POSIX-Slashes formatiert (Markdown-Konvention,
/// rendert plattformuebergreifend gleich). Wenn `from_dir` und `target` auf
/// unterschiedlichen Volumes liegen oder keine gemeinsame Wurzel haben,
/// faellt die Funktion auf den absoluten `target`-Pfad zurueck.
///
/// Beide Pfade sollten vor dem Aufruf canonicalized sein, damit Symlinks,
/// `.`/`..`-Segmente und Case-Mismatches (Windows) konsistent behandelt
/// werden — der Aufrufer ist dafuer zustaendig.
pub fn make_relative(from_dir: &Path, target: &Path) -> String {
    match pathdiff::diff_paths(target, from_dir) {
        Some(rel) => to_posix_string(&rel),
        None => to_posix_string(target),
    }
}

fn to_posix_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Prueft die Existenz und korrigiert die Schreibweise ueber
/// [`case_insensitive_path`] (ein Link `Notiz.md` auf die Datei `notiz.md`
/// muss weiter funktionieren), loest den Pfad aber **nicht physisch** auf:
/// zurueck kommt der lexikalisch normalisierte Pfad (`.`-Segmente weg, `..`
/// gegen das Vorgaengersegment gekuerzt, Forward-Slashes).
///
/// Fruehere Fassungen riefen hier `fs::canonicalize`. Das machte den
/// Link-Klick zur einzigen Stelle der App, die kanonische Pfade lieferte —
/// Vault, Workspace, DOM und Persistenz fuehren durchgaengig die
/// Schreibweise, mit der der Nutzer navigiert hat. Fuer dieselbe Datei
/// entstanden so zwei Strings und damit zwei Tabs mit je eigenem Puffer.
///
/// Bewusst in Kauf genommen: `a/symlink/../b.md` kuerzt lexikalisch anders
/// als physisch. Das ist der Preis dafuer, dass ein Link-Klick denselben
/// Pfad liefert wie der Vault-Klick auf dieselbe Datei; was danach noch
/// auseinanderlaeuft, faengt `path_identity::same_file` an den
/// Vergleichsstellen ab.
///
/// **Reihenfolge ist Vertrag**: erst lexikalisch normalisieren, DANN die
/// Existenz genau dieses Pfads pruefen. Andersherum (Pruefung auf dem rohen
/// Pfad, Rueckgabe des gekuerzten) koennen beide auseinanderfallen: zeigt
/// `link` auf `/outside/sub`, existiert `/vault/link/../secret.md` physisch
/// als `/outside/secret.md`, waehrend die Rueckgabe `/vault/secret.md`
/// waere — ein Pfad, den es nicht gibt, und ein Link-Klick ins Leere. So
/// gilt: entweder der zurueckgegebene Pfad existiert, oder es kommt `None`.
fn resolve_existing_path(path: &Path) -> Option<PathBuf> {
    let normalized = lexically_normalized(path);
    if normalized.exists() {
        return Some(normalized);
    }

    let corrected = case_insensitive_path(&normalized)?;
    corrected.exists().then(|| lexically_normalized(&corrected))
}

fn lexically_normalized(path: &Path) -> PathBuf {
    PathBuf::from(crate::path_identity::lexical_normalize(
        &path.to_string_lossy(),
    ))
}

fn case_insensitive_path(path: &Path) -> Option<PathBuf> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                current.push("..");
            }
            Component::Normal(name) => {
                let direct = current.join(name);
                if direct.exists() {
                    current = direct;
                    continue;
                }

                let replacement = find_case_insensitive_child(&current, name)?;
                current = replacement;
            }
        }
    }
    Some(current)
}

fn find_case_insensitive_child(parent: &Path, name: &OsStr) -> Option<PathBuf> {
    let wanted = name.to_string_lossy();
    let entries = fs::read_dir(parent).ok()?;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        if file_name.to_string_lossy().eq_ignore_ascii_case(&wanted) {
            return Some(entry.path());
        }
    }
    None
}

fn percent_decode(value: &str) -> Option<Cow<'_, str>> {
    if !value.as_bytes().contains(&b'%') {
        return Some(Cow::Borrowed(value));
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            decoded.push(hex_value(high)? << 4 | hex_value(low)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(decoded).ok().map(Cow::Owned)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_identity::same_file;
    use std::io;
    use tempfile::TempDir;

    #[test]
    fn split_anchor_splits_on_first_hash() {
        assert_eq!(
            ("docs/readme.md", Some("a#b")),
            split_anchor("docs/readme.md#a#b")
        );
        assert_eq!(("docs/readme.md", None), split_anchor("docs/readme.md"));
        assert_eq!(("", Some("top")), split_anchor("#top"));
    }

    #[test]
    fn detects_markdown_extensions_case_insensitively() {
        assert!(is_markdown("README.md"));
        assert!(is_markdown("README.MarkDown"));
        assert!(!is_markdown("README.txt"));
        assert!(!is_markdown("README"));
    }

    #[test]
    fn detects_html_extensions_case_insensitively() {
        assert!(is_html("index.html"));
        assert!(is_html("INDEX.HTM"));
        assert!(!is_html("index.md"));
        assert!(!is_html("index"));
    }

    #[test]
    fn resolves_relative_decoded_path() -> io::Result<()> {
        let temp = TempDir::new()?;
        let docs = temp.path().join("docs");
        fs::create_dir(&docs)?;
        fs::write(docs.join("current.md"), "")?;
        fs::write(docs.join("linked file.md"), "")?;

        let resolved = resolve(
            docs.join("current.md").to_str().unwrap(),
            "linked%20file.md#anchor",
        )
        .unwrap();

        assert!(same_file(
            resolved.as_str(),
            docs.join("linked file.md").to_str().unwrap()
        ));
        Ok(())
    }

    #[test]
    fn resolves_anchor_only_to_current_file() -> io::Result<()> {
        let temp = TempDir::new()?;
        let current = temp.path().join("current.md");
        fs::write(&current, "")?;

        let resolved = resolve(current.to_str().unwrap(), "#anchor").unwrap();

        assert!(same_file(resolved.as_str(), current.to_str().unwrap()));
        Ok(())
    }

    #[test]
    fn resolves_absolute_path() -> io::Result<()> {
        let temp = TempDir::new()?;
        let current = temp.path().join("current.md");
        let target = temp.path().join("target.md");
        fs::write(&current, "")?;
        fs::write(&target, "")?;

        let resolved = resolve(current.to_str().unwrap(), target.to_str().unwrap()).unwrap();

        assert!(same_file(resolved.as_str(), target.to_str().unwrap()));
        Ok(())
    }

    #[test]
    fn resolve_uses_case_insensitive_fallback() -> io::Result<()> {
        let temp = TempDir::new()?;
        let docs = temp.path().join("Docs");
        fs::create_dir(&docs)?;
        let current = docs.join("Current.md");
        let target = docs.join("Target File.md");
        fs::write(&current, "")?;
        fs::write(&target, "")?;

        let resolved = resolve(current.to_str().unwrap(), "target%20file.MD").unwrap();

        assert!(same_file(resolved.as_str(), target.to_str().unwrap()));
        Ok(())
    }

    #[test]
    fn resolve_returns_none_for_missing_or_bad_percent_encoding() -> io::Result<()> {
        let temp = TempDir::new()?;
        let current = temp.path().join("current.md");
        fs::write(&current, "")?;

        assert_eq!(None, resolve(current.to_str().unwrap(), "missing.md"));
        assert_eq!(None, resolve(current.to_str().unwrap(), "bad%zz.md"));
        Ok(())
    }

    #[test]
    fn make_relative_returns_posix_subpath() {
        let from = Path::new("/docs/notes");
        let target = Path::new("/docs/notes/images/foo.png");
        assert_eq!("images/foo.png", make_relative(from, target));
    }

    #[test]
    fn make_relative_walks_up_when_target_above_from() {
        let from = Path::new("/docs/notes/sub");
        let target = Path::new("/docs/notes/images/foo.png");
        assert_eq!("../images/foo.png", make_relative(from, target));
    }

    #[test]
    fn make_relative_falls_back_to_target_when_no_common_root() {
        // Windows: unterschiedliche Drive-Letter haben keinen gemeinsamen Stamm.
        // Linux/macOS: pathdiff::diff_paths gibt fuer komplett-absolut+komplett-relativ
        // None zurueck. In beiden Faellen liefern wir den absoluten target-Pfad.
        let from = Path::new("relative/dir");
        let target = Path::new("/absolute/file.png");
        assert_eq!("/absolute/file.png", make_relative(from, target));
    }

    #[test]
    fn resolve_normalizes_lexically_without_touching_the_filesystem_layout() -> io::Result<()> {
        let temp = TempDir::new()?;
        let docs = temp.path().join("docs");
        fs::create_dir(&docs)?;
        fs::write(docs.join("current.md"), "")?;
        fs::write(docs.join("target.md"), "")?;

        let resolved = resolve(docs.join("current.md").to_str().unwrap(), "./target.md").unwrap();

        // `.`-Segment weg, Forward-Slashes — aber kein canonicalize.
        assert_eq!(
            crate::path_identity::lexical_normalize(&docs.join("target.md").to_string_lossy()),
            resolved
        );
        Ok(())
    }

    /// Der zurueckgegebene Pfad muss selbst existieren: `link` zeigt aus dem
    /// Vault heraus, `link/../secret.md` existiert deshalb NUR physisch
    /// (`/outside/secret.md`), lexikalisch waere es `/vault/secret.md`.
    /// Frueher wurde die Existenz auf dem rohen Pfad geprueft und der
    /// gekuerzte zurueckgegeben — der Link-Klick lief ins Leere.
    #[cfg(unix)]
    #[test]
    fn resolve_rejects_a_target_that_only_exists_physically() -> io::Result<()> {
        let temp = TempDir::new()?;
        let outside = temp.path().join("outside");
        let sub = outside.join("sub");
        fs::create_dir_all(&sub)?;
        fs::write(outside.join("secret.md"), "")?;
        let vault = temp.path().join("vault");
        fs::create_dir(&vault)?;
        let current = vault.join("current.md");
        fs::write(&current, "")?;
        std::os::unix::fs::symlink(&sub, vault.join("link"))?;

        // Physisch vorhanden (ueber den Symlink), lexikalisch nicht.
        assert!(vault.join("link").join("..").join("secret.md").exists());
        assert!(!vault.join("secret.md").exists());

        assert_eq!(
            None,
            resolve(current.to_str().unwrap(), "link/../secret.md")
        );

        // Gegenprobe: liegt die Datei da, wo der gekuerzte Pfad hinzeigt,
        // wird sie aufgeloest.
        fs::write(vault.join("secret.md"), "")?;
        let resolved = resolve(current.to_str().unwrap(), "link/../secret.md").unwrap();
        assert_eq!(
            crate::path_identity::lexical_normalize(&vault.join("secret.md").to_string_lossy()),
            resolved
        );
        Ok(())
    }

    /// Teil 2 des Pfad-Identitaets-Fixes: ein Link-Klick unterhalb eines
    /// Symlink-Verzeichnisses liefert den Pfad MIT Symlink — sonst zeigt der
    /// so geoeffnete Tab auf einen anderen String als der Vault-Klick.
    #[cfg(unix)]
    #[test]
    fn resolve_keeps_the_symlinked_directory_path() -> io::Result<()> {
        let temp = TempDir::new()?;
        let real = temp.path().join("real");
        fs::create_dir(&real)?;
        fs::write(real.join("current.md"), "")?;
        fs::write(real.join("target.md"), "")?;
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&real, &link)?;

        let resolved = resolve(link.join("current.md").to_str().unwrap(), "target.md").unwrap();

        assert_eq!(
            crate::path_identity::lexical_normalize(&link.join("target.md").to_string_lossy()),
            resolved
        );
        assert!(same_file(
            resolved.as_str(),
            real.join("target.md").to_str().unwrap()
        ));
        Ok(())
    }
}
