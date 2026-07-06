//! Template-Engine fuer Corporate-Design-Exports.
//!
//! Minimaler `{{key}}`-Ersatz mit HTML-Escaping, absichtlich ohne
//! Engine-Dependency. Ein einziger Regex-Pass substituiert die
//! Whitelist-Platzhalter; substituierte Werte werden vor dem Einsetzen
//! HTML-escaped, sodass ein Wert wie `{{author}}` nicht erneut ersetzt
//! wird (kein rekursives Re-Substituieren, keine Injection).

use crate::{export::derive_title, frontmatter};
use regex::{Captures, Regex};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

#[allow(dead_code)]
pub(crate) const WHITELIST: &[&str] = &["title", "subtitle", "author", "company", "date", "logo"];

/// HTML-Escaping mit den fuenf Standard-Entities. Identisch zu den
/// bestehenden `escape_html`-Hilfen in `export.rs`/`vault.rs`/`toc.rs`.
pub(crate) fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Kontext fuer die Template-Substitution. Werte werden vor dem Einsetzen
/// HTML-escaped; `logo` erwartet eine fertige data:-URI und wird als
/// `<img src="...">` substituiert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateContext {
    pub title: String,
    pub subtitle: String,
    pub author: String,
    pub company: String,
    pub date: String,
    pub logo: Option<String>,
}

impl TemplateContext {
    /// Kontext aus Markdown-Frontmatter + Dateipfad bauen. `logo` ist die
    /// bereits fertige data:-URI (None = kein Logo-Asset, `{{logo}}`
    /// expandiert zum leeren String).
    pub fn from_markdown(markdown: &str, path: Option<&str>, logo: Option<String>) -> Self {
        Self::from_markdown_in(markdown, path, logo, &today_ymd())
    }

    /// Testfreundliche Variante mit injizierbarem `today` (Format
    /// `DD.MM.YYYY`). `from_markdown` nutzt `today_ymd()` live.
    pub fn from_markdown_in(
        markdown: &str,
        path: Option<&str>,
        logo: Option<String>,
        today: &str,
    ) -> Self {
        let entries = frontmatter::extract(markdown).entries;
        let mut title = String::new();
        let mut subtitle = String::new();
        let mut author = String::new();
        let mut company = String::new();
        let mut date = String::new();
        for entry in entries.iter() {
            let Some(canonical) = canonical_key(&entry.key) else {
                continue;
            };
            if entry.value.trim().is_empty() {
                continue;
            }
            match canonical {
                "title" if title.is_empty() => title = entry.value.clone(),
                "subtitle" if subtitle.is_empty() => subtitle = entry.value.clone(),
                "author" if author.is_empty() => author = entry.value.clone(),
                "company" if company.is_empty() => company = entry.value.clone(),
                "date" if date.is_empty() => date = entry.value.clone(),
                _ => {}
            }
        }

        if title.trim().is_empty() {
            title = derive_title(path);
        }
        if date.trim().is_empty() {
            date = today.to_string();
        }

        Self {
            title,
            subtitle,
            author,
            company,
            date,
            logo,
        }
    }

    /// Substituiert die Whitelist-Platzhalter in einem Template. Ein
    /// einziger Regex-Pass; unbekannte Platzhalter werden zum leeren
    /// String. `{{logo}}` expandiert zu `<img src="data:..." alt="logo">`
    /// oder leer.
    pub fn render(&self, template: &str) -> String {
        let re = placeholder_regex();
        re.replace_all(template, |caps: &Captures| {
            let key = caps.get(1).unwrap().as_str().to_ascii_lowercase();
            if key == "logo" {
                // `{{logo}}` expandiert zu einem server-seitig gebauten
                // `<img>`-Snippet, dessen data:-URI wir kontrollieren —
                // KEIN Escaping, sonst wuerde das <img>-Tag zerstoert.
                match self.logo.as_deref() {
                    Some(uri) => format!("<img src=\"{uri}\" alt=\"logo\">"),
                    None => String::new(),
                }
            } else {
                escape_html(&self.lookup(&key))
            }
        })
        .into_owned()
    }

    fn lookup(&self, key: &str) -> String {
        match key {
            "title" => self.title.clone(),
            "subtitle" => self.subtitle.clone(),
            "author" => self.author.clone(),
            "company" => self.company.clone(),
            "date" => self.date.clone(),
            _ => String::new(),
        }
    }
}

/// Kanonischen Platzhalter-Namen aus einem Frontmatter-Key ableiten
/// (case-insensitive Aliasse). `None` heisst: nicht in der Whitelist.
fn canonical_key(key: &str) -> Option<&'static str> {
    match key.to_ascii_lowercase().as_str() {
        "title" | "titel" => Some("title"),
        "subtitle" | "untertitel" => Some("subtitle"),
        "author" | "autor" => Some("author"),
        "company" | "firma" | "organisation" => Some("company"),
        "date" | "datum" => Some("date"),
        _ => None,
    }
}

fn placeholder_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"\{\{\s*([a-zA-Z]+)\s*\}\}").expect("template placeholder regex")
    })
}

/// Heutiges Datum im Format `DD.MM.YYYY` aus `std::time` ohne externe
/// Crate. Algorithmus nach Howard Hinnant (civil_from_days).
fn today_ymd() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{d:02}.{m:02}.{y:04}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146_096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> TemplateContext {
        TemplateContext {
            title: "T".into(),
            subtitle: "S".into(),
            author: "A".into(),
            company: "C".into(),
            date: "01.02.2024".into(),
            logo: Some("data:image/png;base64,AAAA".into()),
        }
    }

    #[test]
    fn substitutes_whitelist_placeholders() {
        let out = ctx().render("{{title}}-{{subtitle}}-{{author}}-{{company}}-{{date}}");
        assert_eq!("T-S-A-C-01.02.2024", out);
    }

    #[test]
    fn logo_expands_to_img_tag() {
        let out = ctx().render("[{{logo}}]");
        assert_eq!(
            "[<img src=\"data:image/png;base64,AAAA\" alt=\"logo\">]",
            out
        );
    }

    #[test]
    fn logo_without_asset_is_empty() {
        let mut context = ctx();
        context.logo = None;
        assert_eq!("xy", context.render("x{{logo}}y"));
    }

    #[test]
    fn unknown_placeholder_becomes_empty() {
        let out = ctx().render("a{{unknown}}b");
        assert_eq!("ab", out);
    }

    #[test]
    fn escapes_value_html_entities() {
        let context = TemplateContext {
            title: "<b>T</b>\"x'&y".into(),
            ..ctx()
        };
        let out = context.render("{{title}}");
        assert_eq!("&lt;b&gt;T&lt;/b&gt;&quot;x&#39;&amp;y", out);
    }

    #[test]
    fn injected_author_with_placeholder_is_not_resubstituted() {
        let mut context = ctx();
        // Wert enthaelt syntaktisch einen Platzhalter — darf nicht
        // nach dem Ersatzpass erneut expandiert werden.
        context.author = "{{title}}".into();
        let out = context.render("[{{author}}]");
        assert_eq!("[{{title}}]", out);
    }

    #[test]
    fn whitespace_in_placeholder_is_tolerated() {
        let out = ctx().render("{{  title  }}|{{ title }}");
        assert_eq!("T|T", out);
    }

    #[test]
    fn placeholder_match_is_case_sensitive_key_lowercase_only() {
        // Regex erlaubt gemischte Buchstaben; Lookup lowercased den Key.
        let out = ctx().render("{{Title}}");
        assert_eq!("T", out);
    }

    #[test]
    fn from_markdown_picks_frontmatter_aliases_case_insensitive() {
        let md = "---\nTitel: FT\nAutor: FA\nFirma: FC\nUntertitel: FS\nDatum: FD\n---\nbody";
        let context =
            TemplateContext::from_markdown_in(md, Some("/p/notes.md"), None, "01.01.2024");
        assert_eq!("FT", context.title);
        assert_eq!("FA", context.author);
        assert_eq!("FC", context.company);
        assert_eq!("FS", context.subtitle);
        assert_eq!("FD", context.date);
    }

    #[test]
    fn from_markdown_falls_back_to_derive_title_and_today() {
        let md = "# Hallo";
        let context =
            TemplateContext::from_markdown_in(md, Some("/p/notes.md"), None, "07.06.2026");
        assert_eq!("notes", context.title);
        assert_eq!("07.06.2026", context.date);
    }

    #[test]
    fn from_markdown_derive_title_without_path() {
        let context = TemplateContext::from_markdown_in("# x", None, None, "03.04.2025");
        assert_eq!("Dokument", context.title);
        assert_eq!("03.04.2025", context.date);
    }

    #[test]
    fn from_markdown_first_non_empty_entry_wins() {
        let md = "---\ntitle: Erstes\ntitel: Zweites\n---\nbody";
        let context = TemplateContext::from_markdown_in(md, Some("/p/x.md"), None, "01.01.2024");
        assert_eq!("Erstes", context.title);
    }

    #[test]
    fn from_markdown_empty_value_does_not_block_later_alias() {
        let md = "---\ntitle: ''\ntitel: Echt\n---\nbody";
        let context = TemplateContext::from_markdown_in(md, Some("/p/x.md"), None, "01.01.2024");
        assert_eq!("Echt", context.title);
    }

    #[test]
    fn organisation_is_company_alias() {
        let md = "---\norganisation: Orga\n---\nbody";
        let context = TemplateContext::from_markdown_in(md, Some("/p/x.md"), None, "01.01.2024");
        assert_eq!("Orga", context.company);
    }

    #[test]
    fn whitespace_only_value_is_treated_as_empty_for_alias() {
        let md = "---\ntitle: '   '\ntitel: Echt\n---\nbody";
        let context = TemplateContext::from_markdown_in(md, Some("/p/x.md"), None, "01.01.2024");
        assert_eq!("Echt", context.title);
    }

    #[test]
    fn whitelist_is_exactly_the_six_keys() {
        assert_eq!(
            WHITELIST,
            &["title", "subtitle", "author", "company", "date", "logo"]
        );
    }

    #[test]
    fn today_ymd_is_dd_mm_yyyy_format() {
        let s = today_ymd();
        assert_eq!(10, s.len());
        assert_eq!('.', s.chars().nth(2).unwrap());
        assert_eq!('.', s.chars().nth(5).unwrap());
    }
}
