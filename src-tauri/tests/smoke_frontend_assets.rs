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

#[test]
fn app_css_bundle_is_packaged_with_dist() {
    assert!(
        dist_path("app.css").is_file(),
        "app.css bundle (built from src-tauri/web/styles/) must be present in src-tauri/dist"
    );
}

#[test]
fn app_bundle_carries_the_cross_bundle_bridges() {
    let bundle =
        fs::read_to_string(dist_path("app.bundle.js")).expect("app.bundle.js should be readable");
    assert!(
        bundle.contains("__folioInvoke"),
        "app.bundle.js must publish the Tauri invoke wrapper as window.__folioInvoke"
    );
    assert!(
        bundle.contains("openDocument"),
        "app.bundle.js must publish openDocument on window (Link-Klick aus editor.bundle.js)"
    );
}

#[test]
fn index_html_does_not_inline_styles() {
    let html = fs::read_to_string(dist_path("index.html")).expect("index.html should be readable");
    assert!(
        !html.contains("<style>"),
        "index.html must not inline <style> blocks anymore; CSS lives in app.css"
    );
    assert!(
        html.contains("href=\"app.css\""),
        "index.html must link the app.css bundle"
    );
}
