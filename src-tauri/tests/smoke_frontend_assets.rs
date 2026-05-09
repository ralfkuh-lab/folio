use std::{fs, path::PathBuf};

fn dist_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("dist")
        .join(relative)
}

#[test]
fn monaco_runtime_assets_are_packaged_with_dist() {
    assert!(
        dist_path("monaco/loader.js").is_file(),
        "Monaco AMD loader must be present in src-tauri/dist for fresh checkouts"
    );
    assert!(
        dist_path("monaco/vs/editor/editor.main.js").is_file(),
        "Monaco editor runtime must be present in src-tauri/dist for Tauri packaging"
    );
}

#[test]
fn editor_bundle_leaves_folio_editor_on_window() {
    let bundle = fs::read_to_string(dist_path("editor.bundle.js"))
        .expect("editor.bundle.js should be readable");

    assert!(
        bundle.contains("window.FolioEditor="),
        "editor bundle must publish the shell API on window.FolioEditor"
    );
    assert!(
        !bundle.trim_start().starts_with("var FolioEditor="),
        "esbuild --global-name overwrites window.FolioEditor with undefined for this bundle"
    );
}
