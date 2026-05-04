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

        if file_resolver::is_markdown(&path) {
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
    use std::fs;
    use tempfile::TempDir;

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
                path: fs::canonicalize(target)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                anchor: Some("a".into())
            },
            LinkInterceptor::new().handle("target.md#a", current.to_str())
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
