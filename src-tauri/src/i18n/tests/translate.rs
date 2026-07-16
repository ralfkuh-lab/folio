//! t / t_args / t_plural: Fallback, {count}, Merge, Komposition 0/1/2.

use super::*;
use crate::i18n::{CatalogRegistry, ResolvedLanguage, TranslateError, Translator};

fn tr_for(tag: &str) -> Translator {
    let registry = CatalogRegistry::load_from_dir(&locales_dir()).expect("load");
    let locale = registry
        .get(tag)
        .map(|c| c.meta.locale.clone())
        .unwrap_or_else(|| tag.to_string());
    Translator::new(
        registry,
        ResolvedLanguage {
            catalog_tag: tag.into(),
            format_locale: locale,
        },
    )
}

#[test]
fn t_returns_active_language_string() {
    let de = tr_for("de");
    assert_eq!(de.t("menu.file"), "Datei");
    let en = tr_for("en");
    assert_eq!(en.t("menu.file"), "File");
}

#[test]
fn t_fallback_active_then_en_then_key() {
    let de = tr_for("de");
    // existierender Key
    assert_eq!(de.t("menu.file.open"), "Öffnen…");

    // Key nur in en (simulieren wir nicht in Prod-Katalogen — beide paritätisch).
    // Fehlender Key → Key selbst
    assert_eq!(de.t("totally.missing.key"), "totally.missing.key");
}

#[test]
fn t_args_interpolates_named_placeholders() {
    let de = tr_for("de");
    // search.status.done uses hitsPart, filesPart, duration
    let hits = de.t_plural("search.status.hitsPart", 2, &[]).unwrap();
    let files = de.t_plural("search.status.filesPart", 3, &[]).unwrap();
    let out = de.t_args(
        "search.status.done",
        &[
            ("hitsPart", &hits),
            ("filesPart", &files),
            ("duration", "42"),
        ],
    );
    assert!(out.contains(&hits), "out={out}");
    assert!(out.contains(&files), "out={out}");
    assert!(out.contains("42"), "out={out}");
}

#[test]
fn t_plural_injects_count_placeholder() {
    let en = tr_for("en");
    let s = en.t_plural("search.status.hitsPart", 7, &[]).unwrap();
    assert!(s.contains('7'), "expected injected count, got {s}");
    assert!(!s.contains("{count}"), "placeholder must be replaced: {s}");
}

#[test]
fn t_plural_count_override_is_error() {
    let en = tr_for("en");
    let err = en
        .t_plural("search.status.hitsPart", 3, &[("count", "99")])
        .unwrap_err();
    assert_eq!(err, TranslateError::CountOverride);
}

#[test]
fn t_plural_one_and_other_branches() {
    let de = tr_for("de");
    let one = de.t_plural("search.status.hitsPart", 1, &[]).unwrap();
    assert_eq!(one, "1 Treffer");
    let other = de.t_plural("search.status.hitsPart", 0, &[]).unwrap();
    assert_eq!(other, "0 Treffer");
    let many = de.t_plural("search.status.hitsPart", 2, &[]).unwrap();
    assert_eq!(many, "2 Treffer");
}

#[test]
fn segment_composition_0_1_2_matrix_de_and_en() {
    // Spec: 0/1/2 in allen unabhängigen Zählvariablen (hits × files).
    for tag in ["de", "en"] {
        let tr = tr_for(tag);
        for hits in [0u64, 1, 2] {
            for files in [0u64, 1, 2] {
                let hits_part = tr
                    .t_plural("search.status.hitsPart", hits, &[])
                    .unwrap_or_else(|e| panic!("{tag} hits {hits}: {e:?}"));
                let files_part = tr
                    .t_plural("search.status.filesPart", files, &[])
                    .unwrap_or_else(|e| panic!("{tag} files {files}: {e:?}"));
                let done = tr.t_args(
                    "search.status.done",
                    &[
                        ("hitsPart", &hits_part),
                        ("filesPart", &files_part),
                        ("duration", "10"),
                    ],
                );
                assert!(
                    done.contains(&hits_part) && done.contains(&files_part),
                    "{tag} hits={hits} files={files}: {done}"
                );
                // count digits appear in parts for != 1 (and for 1 as "1 …")
                if hits != 1 {
                    assert!(
                        hits_part.contains(&hits.to_string()),
                        "hits part should contain count: {hits_part}"
                    );
                }
            }
        }
    }
}

#[test]
fn plural_merge_is_atomic_not_deep() {
    // Wenn aktiver Katalog einen Plural-Key hat, werden keine Branches aus en
    // hineingemischt. Wir prüfen: de hitsPart one-Branch ist deutsch.
    let de = tr_for("de");
    assert_eq!(
        de.t_plural("search.status.hitsPart", 1, &[]).unwrap(),
        "1 Treffer"
    );
    // en one is English
    let en = tr_for("en");
    assert_eq!(
        en.t_plural("search.status.hitsPart", 1, &[]).unwrap(),
        "1 hit"
    );
}

#[test]
fn warn_dedup_per_tag_key_failure_kind() {
    let de = tr_for("de");
    let before = de.warn_dedup_len();
    // mehrfach fehlender Key → höchstens ein Dedup-Eintrag pro (tag,key,kind)
    let _ = de.t("missing.key.alpha");
    let _ = de.t("missing.key.alpha");
    let _ = de.t("missing.key.alpha");
    let after = de.warn_dedup_len();
    assert!(
        after > before,
        "expected deduped warn growth, before={before} after={after}"
    );
    // anderer Key → weiterer Eintrag
    let _ = de.t("missing.key.beta");
    let after2 = de.warn_dedup_len();
    assert!(
        after2 > after,
        "second missing key should add another dedup slot: after={after} after2={after2}"
    );
}
