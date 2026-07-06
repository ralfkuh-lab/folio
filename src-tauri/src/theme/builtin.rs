use super::package::{ThemeManifest, ThemePackage, ThemeSource};

const CLASSIC_CSS: &str = include_str!("../layouts/classic.css");
const CLEAN_CSS: &str = include_str!("../layouts/clean.css");
const GITHUB_CSS: &str = include_str!("../layouts/github.css");
const CLASSIC_PAGE_CSS: &str = include_str!("../layouts/classic.page.css");
const CLEAN_PAGE_CSS: &str = include_str!("../layouts/clean.page.css");
const GITHUB_PAGE_CSS: &str = include_str!("../layouts/github.page.css");
const CLEAN_DARK_CSS: &str = include_str!("../layouts/clean.dark.css");
const GITHUB_DARK_CSS: &str = include_str!("../layouts/github.dark.css");

pub const IDS: &[&str] = &["standard", "classic", "clean", "github"];

pub fn packages() -> Vec<ThemePackage> {
    vec![
        package(
            "standard",
            "Standard",
            "Die eingebaute Folio-Ansicht, folgt dem App-Theme.",
            "",
            None,
            None,
        ),
        package(
            "classic",
            "Classic",
            "Article-Look mit Serifen, A4-orientiert.",
            CLASSIC_CSS,
            None,
            Some(CLASSIC_PAGE_CSS),
        ),
        package(
            "clean",
            "Clean",
            "Moderne, ruhige Sans-Serif-Optik.",
            CLEAN_CSS,
            Some(CLEAN_DARK_CSS),
            Some(CLEAN_PAGE_CSS),
        ),
        package(
            "github",
            "GitHub",
            "Stil angelehnt an die GitHub-Markdown-Vorschau.",
            GITHUB_CSS,
            Some(GITHUB_DARK_CSS),
            Some(GITHUB_PAGE_CSS),
        ),
    ]
}

fn package(
    id: &str,
    name: &str,
    description: &str,
    content_css: &str,
    dark_css: Option<&str>,
    page_css: Option<&str>,
) -> ThemePackage {
    ThemePackage {
        id: id.to_string(),
        content_css: content_css.to_string(),
        dark_css: dark_css.map(str::to_string),
        page_css: page_css.map(str::to_string),
        cover_html: None,
        header_html: None,
        footer_html: None,
        manifest: ThemeManifest {
            name: name.to_string(),
            description: description.to_string(),
            ..ThemeManifest::default()
        },
        source: ThemeSource::Builtin,
        dir: None,
    }
}
