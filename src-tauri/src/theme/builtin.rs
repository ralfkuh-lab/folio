use super::package::{ThemeManifest, ThemePackage, ThemeSource};

const CLASSIC_CSS: &str = include_str!("../layouts/classic.css");
const CLEAN_CSS: &str = include_str!("../layouts/clean.css");
const GITHUB_CSS: &str = include_str!("../layouts/github.css");
const CLASSIC_PAGE_CSS: &str = include_str!("../layouts/classic.page.css");
const CLEAN_PAGE_CSS: &str = include_str!("../layouts/clean.page.css");
const GITHUB_PAGE_CSS: &str = include_str!("../layouts/github.page.css");
const CLEAN_DARK_CSS: &str = include_str!("../layouts/clean.dark.css");
const GITHUB_DARK_CSS: &str = include_str!("../layouts/github.dark.css");
const BUSINESS_CSS: &str = include_str!("../layouts/business.css");
const BUSINESS_DARK_CSS: &str = include_str!("../layouts/business.dark.css");
const BUSINESS_PAGE_CSS: &str = include_str!("../layouts/business.page.css");
const BUSINESS_COVER_HTML: &str = include_str!("../layouts/business.cover.html");
const BUSINESS_HEADER_HTML: &str = include_str!("../layouts/business.header.html");
const BUSINESS_FOOTER_HTML: &str = include_str!("../layouts/business.footer.html");
const REPORT_CSS: &str = include_str!("../layouts/report.css");
const REPORT_DARK_CSS: &str = include_str!("../layouts/report.dark.css");
const REPORT_PAGE_CSS: &str = include_str!("../layouts/report.page.css");
const MINIMAL_CSS: &str = include_str!("../layouts/minimal.css");
const MINIMAL_DARK_CSS: &str = include_str!("../layouts/minimal.dark.css");
const BRAND_CSS: &str = include_str!("../layouts/brand.css");
const BRAND_DARK_CSS: &str = include_str!("../layouts/brand.dark.css");
const BRAND_PAGE_CSS: &str = include_str!("../layouts/brand.page.css");
const BRAND_COVER_HTML: &str = include_str!("../layouts/brand.cover.html");
const BRAND_HEADER_HTML: &str = include_str!("../layouts/brand.header.html");
const BRAND_FOOTER_HTML: &str = include_str!("../layouts/brand.footer.html");
const WARM_CSS: &str = include_str!("../layouts/warm.css");
const WARM_DARK_CSS: &str = include_str!("../layouts/warm.dark.css");
const TECH_CSS: &str = include_str!("../layouts/tech.css");
const TECH_DARK_CSS: &str = include_str!("../layouts/tech.dark.css");
const CONTRAST_CSS: &str = include_str!("../layouts/contrast.css");
const CONTRAST_DARK_CSS: &str = include_str!("../layouts/contrast.dark.css");
const PASTEL_CSS: &str = include_str!("../layouts/pastel.css");
const PASTEL_DARK_CSS: &str = include_str!("../layouts/pastel.dark.css");

pub const IDS: &[&str] = &[
    "standard", "classic", "clean", "github", "business", "report", "minimal", "brand", "warm",
    "tech", "contrast", "pastel",
];

pub fn packages() -> Vec<ThemePackage> {
    vec![
        package(
            "standard",
            "Standard",
            "Die eingebaute Folio-Ansicht, folgt dem App-Theme.",
            "",
            PackageFiles::default(),
        ),
        package(
            "classic",
            "Classic",
            "Article-Look mit Serifen, A4-orientiert.",
            CLASSIC_CSS,
            PackageFiles {
                page_css: Some(CLASSIC_PAGE_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "clean",
            "Clean",
            "Moderne, ruhige Sans-Serif-Optik.",
            CLEAN_CSS,
            PackageFiles {
                dark_css: Some(CLEAN_DARK_CSS),
                page_css: Some(CLEAN_PAGE_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "github",
            "GitHub",
            "Stil angelehnt an die GitHub-Markdown-Vorschau.",
            GITHUB_CSS,
            PackageFiles {
                dark_css: Some(GITHUB_DARK_CSS),
                page_css: Some(GITHUB_PAGE_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "business",
            "Business",
            "Seriöses Corporate-Theme mit klarem Sans-Serif-Design und blauen Akzenten.",
            BUSINESS_CSS,
            PackageFiles {
                dark_css: Some(BUSINESS_DARK_CSS),
                page_css: Some(BUSINESS_PAGE_CSS),
                cover_html: Some(BUSINESS_COVER_HTML),
                header_html: Some(BUSINESS_HEADER_HTML),
                footer_html: Some(BUSINESS_FOOTER_HTML),
            },
        ),
        package(
            "report",
            "Report",
            "Formelles Report-Layout mit eleganten Serifenschriften und traditioneller Struktur.",
            REPORT_CSS,
            PackageFiles {
                dark_css: Some(REPORT_DARK_CSS),
                page_css: Some(REPORT_PAGE_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "minimal",
            "Minimal",
            "Maximal reduziertes Design mit viel Weißraum und dezenter Typografie.",
            MINIMAL_CSS,
            PackageFiles {
                dark_css: Some(MINIMAL_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "brand",
            "Brand",
            "Ausdrucksstarkes Branding-Theme mit kräftigem Indigo-Akzent und moderner Ästhetik.",
            BRAND_CSS,
            PackageFiles {
                dark_css: Some(BRAND_DARK_CSS),
                page_css: Some(BRAND_PAGE_CSS),
                cover_html: Some(BRAND_COVER_HTML),
                header_html: Some(BRAND_HEADER_HTML),
                footer_html: Some(BRAND_FOOTER_HTML),
            },
        ),
        package(
            "warm",
            "Warm",
            "Einladendes Theme in warmen Sepia- und Erdtönen für entspanntes Lesen.",
            WARM_CSS,
            PackageFiles {
                dark_css: Some(WARM_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "tech",
            "Tech",
            "Kompaktes Entwickler-Theme mit Monospace-Überschriften und technischem Code-Look.",
            TECH_CSS,
            PackageFiles {
                dark_css: Some(TECH_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "contrast",
            "Contrast",
            "Kontrastreiches und barrierearmes Design für optimale Lesbarkeit.",
            CONTRAST_CSS,
            PackageFiles {
                dark_css: Some(CONTRAST_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "pastel",
            "Pastel",
            "Sanftes Pastel-Theme mit weichen Farben und verspielten, abgerundeten Formen.",
            PASTEL_CSS,
            PackageFiles {
                dark_css: Some(PASTEL_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
    ]
}

#[derive(Default)]
struct PackageFiles {
    dark_css: Option<&'static str>,
    page_css: Option<&'static str>,
    cover_html: Option<&'static str>,
    header_html: Option<&'static str>,
    footer_html: Option<&'static str>,
}

fn package(
    id: &str,
    name: &str,
    description: &str,
    content_css: &str,
    files: PackageFiles,
) -> ThemePackage {
    let cover = files.cover_html.is_some();
    let header = files.header_html.is_some();
    let footer = files.footer_html.is_some();
    ThemePackage {
        id: id.to_string(),
        content_css: content_css.to_string(),
        dark_css: files.dark_css.map(str::to_string),
        page_css: files.page_css.map(str::to_string),
        cover_html: files.cover_html.map(str::to_string),
        header_html: files.header_html.map(str::to_string),
        footer_html: files.footer_html.map(str::to_string),
        manifest: ThemeManifest {
            name: name.to_string(),
            description: description.to_string(),
            cover,
            header,
            footer,
            ..ThemeManifest::default()
        },
        source: ThemeSource::Builtin,
        dir: None,
    }
}
