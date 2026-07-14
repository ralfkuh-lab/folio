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
    // Display name/description come from the i18n catalog
    // (`theme.builtin.<id>.*`); IDs stay stable. Custom themes are untouched.
    vec![
        package("standard", "", PackageFiles::default()),
        package(
            "classic",
            CLASSIC_CSS,
            PackageFiles {
                page_css: Some(CLASSIC_PAGE_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "clean",
            CLEAN_CSS,
            PackageFiles {
                dark_css: Some(CLEAN_DARK_CSS),
                page_css: Some(CLEAN_PAGE_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "github",
            GITHUB_CSS,
            PackageFiles {
                dark_css: Some(GITHUB_DARK_CSS),
                page_css: Some(GITHUB_PAGE_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "business",
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
            REPORT_CSS,
            PackageFiles {
                dark_css: Some(REPORT_DARK_CSS),
                page_css: Some(REPORT_PAGE_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "minimal",
            MINIMAL_CSS,
            PackageFiles {
                dark_css: Some(MINIMAL_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "brand",
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
            WARM_CSS,
            PackageFiles {
                dark_css: Some(WARM_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "tech",
            TECH_CSS,
            PackageFiles {
                dark_css: Some(TECH_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "contrast",
            CONTRAST_CSS,
            PackageFiles {
                dark_css: Some(CONTRAST_DARK_CSS),
                ..PackageFiles::default()
            },
        ),
        package(
            "pastel",
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

fn package(id: &str, content_css: &str, files: PackageFiles) -> ThemePackage {
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
            name: crate::i18n::theme_builtin_name_active(id),
            description: crate::i18n::theme_builtin_description_active(id),
            cover,
            header,
            footer,
            // Deckblatt-Themes zeigen die Metadaten auf dem Cover — das
            // Inline-Frontmatter-<aside> im Body waere eine Doppelung.
            hide_inline_frontmatter: cover,
            ..ThemeManifest::default()
        },
        source: ThemeSource::Builtin,
        dir: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{
        theme_builtin_description, theme_builtin_name, CatalogRegistry, ResolvedLanguage,
        Translator, THEME_BUILTIN_CATALOG,
    };

    fn tr(tag: &str) -> Translator {
        let reg = CatalogRegistry::load_from_dir(&crate::i18n::production_locales_dir())
            .expect("prod locales");
        let locale = reg
            .get(tag)
            .map(|c| c.meta.locale.clone())
            .unwrap_or_else(|| tag.to_string());
        Translator::new(
            reg,
            ResolvedLanguage {
                catalog_tag: tag.into(),
                format_locale: locale,
            },
        )
    }

    #[test]
    fn declarative_catalog_covers_all_ids_de_en_no_raw_keys() {
        let de = tr("de");
        let en = tr("en");
        assert_eq!(THEME_BUILTIN_CATALOG.len(), IDS.len());
        for id in IDS {
            let entry = THEME_BUILTIN_CATALOG
                .iter()
                .find(|e| e.id == *id)
                .unwrap_or_else(|| panic!("missing catalog entry for {id}"));
            assert!(
                entry.name_key.starts_with("theme.builtin."),
                "{id} name_key"
            );
            assert!(
                entry.description_key.starts_with("theme.builtin."),
                "{id} description_key"
            );
            let de_name = theme_builtin_name(&de, id);
            let en_name = theme_builtin_name(&en, id);
            let de_desc = theme_builtin_description(&de, id);
            let en_desc = theme_builtin_description(&en, id);
            assert!(
                !de_name.is_empty() && !de_name.starts_with("theme.builtin."),
                "{id} de name"
            );
            assert!(
                !en_name.is_empty() && !en_name.starts_with("theme.builtin."),
                "{id} en name"
            );
            assert!(
                !de_desc.is_empty() && !de_desc.starts_with("theme.builtin."),
                "{id} de desc"
            );
            assert!(
                !en_desc.is_empty() && !en_desc.starts_with("theme.builtin."),
                "{id} en desc"
            );
        }
        assert_ne!(
            theme_builtin_description(&de, "business"),
            theme_builtin_description(&en, "business")
        );
        assert_eq!(
            theme_builtin_description(&de, "business"),
            "Seriöses Corporate-Theme mit klarem Sans-Serif-Design und blauen Akzenten."
        );
    }
}
