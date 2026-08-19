use crate::file_resolver;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkAction {
    OpenExternal(String),
    Navigate {
        path: String,
        anchor: Option<String>,
    },
    Missing,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct LinkInterceptor;

impl LinkInterceptor {
    pub fn new() -> Self {
        Self
    }

    pub fn handle(&self, href: &str, current_file: Option<&str>) -> LinkAction {
        if is_external(href) {
            return LinkAction::OpenExternal(href.to_string());
        }

        let (target, anchor) = file_resolver::split_anchor(href);
        if target.is_empty() {
            if let Some(current_file) = current_file {
                return LinkAction::Navigate {
                    path: current_file.to_string(),
                    anchor: anchor.map(ToOwned::to_owned),
                };
            }
        }

        let Some(current_file) = current_file else {
            return LinkAction::Missing;
        };
        let Some(path) = file_resolver::resolve(current_file, href) else {
            return LinkAction::Missing;
        };

        if file_resolver::is_markdown(&path) || file_resolver::is_html(&path) {
            LinkAction::Navigate {
                path,
                anchor: anchor.map(ToOwned::to_owned),
            }
        } else {
            LinkAction::OpenExternal(path)
        }
    }
}

fn is_external(href: &str) -> bool {
    href.starts_with("http://") || href.starts_with("https://") || href.starts_with("mailto:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_identity::lexical_normalize;
    use std::fs;
    use tempfile::TempDir;

    /// Erwartungswert fuer `LinkAction::Navigate`: der Eingabepfad,
    /// lexikalisch normalisiert — **nicht** `fs::canonicalize`. Der
    /// Link-Klick war frueher die einzige Stelle der App, die physisch
    /// aufloeste; genau daraus entstanden zwei Tabs auf einer Datei.
    fn expected_path(path: &std::path::Path) -> String {
        lexical_normalize(&path.to_string_lossy())
    }

    #[test]
    fn external_urls_open_in_shell() {
        assert_eq!(
            LinkAction::OpenExternal("https://example.test".into()),
            LinkInterceptor::new().handle("https://example.test", None)
        );
    }

    #[test]
    fn markdown_file_resolves_to_navigation() {
        let temp = TempDir::new().unwrap();
        let current = temp.path().join("current.md");
        let target = temp.path().join("target.md");
        fs::write(&current, "").unwrap();
        fs::write(&target, "").unwrap();
        assert_eq!(
            LinkAction::Navigate {
                path: expected_path(&target),
                anchor: Some("a".into())
            },
            LinkInterceptor::new().handle("target.md#a", current.to_str())
        );
    }

    #[test]
    fn html_file_resolves_to_navigation() {
        let temp = TempDir::new().unwrap();
        let current = temp.path().join("current.html");
        let target = temp.path().join("target.html");
        fs::write(&current, "").unwrap();
        fs::write(&target, "").unwrap();
        assert_eq!(
            LinkAction::Navigate {
                path: expected_path(&target),
                anchor: None
            },
            LinkInterceptor::new().handle("target.html", current.to_str())
        );
    }

    /// Regressionsfall des Pfad-Identitaets-Fixes: die Datei ist ueber ein
    /// Symlink-Verzeichnis erreichbar; der Link-Klick muss den Pfad MIT
    /// Symlink liefern, sonst oeffnet sich ein zweiter Tab neben dem, den
    /// der Vault-Klick auf dieselbe Datei erzeugt hat.
    #[cfg(unix)]
    #[test]
    fn navigation_keeps_the_symlinked_directory_path() {
        let temp = TempDir::new().unwrap();
        let real = temp.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("current.md"), "").unwrap();
        fs::write(real.join("target.md"), "").unwrap();
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let current = link.join("current.md");
        assert_eq!(
            LinkAction::Navigate {
                path: expected_path(&link.join("target.md")),
                anchor: None
            },
            LinkInterceptor::new().handle("target.md", current.to_str())
        );
    }

    #[test]
    fn non_markdown_file_opens_externally() {
        let temp = TempDir::new().unwrap();
        let current = temp.path().join("current.md");
        let target = temp.path().join("image.png");
        fs::write(&current, "").unwrap();
        fs::write(&target, "").unwrap();
        assert!(matches!(
            LinkInterceptor::new().handle("image.png", current.to_str()),
            LinkAction::OpenExternal(_)
        ));
    }
}
