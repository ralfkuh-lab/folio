use std::fs;
use std::path::PathBuf;

fn workspace_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

#[test]
fn goldfile_diff_index() {
    diff_fixture("index");
}

#[test]
fn goldfile_diff_frontmatter_example() {
    diff_fixture("frontmatter-example");
}

#[test]
fn goldfile_diff_large_document() {
    diff_fixture("large-document");
}

fn diff_fixture(name: &str) {
    let ws = workspace_dir();
    let input_path = ws.join(format!("test-docs/{name}.md"));
    let expected_path = ws.join(format!("goldfiles/expected/{name}.html"));

    let markdown = fs::read_to_string(&input_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", input_path.display()));
    let expected = fs::read_to_string(&expected_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", expected_path.display()));

    let actual = folio_rs::renderer::render_body(&markdown);

    if actual != expected {
        let diff_path = ws.join(format!("goldfiles/actual/{name}.html"));
        let _ = fs::create_dir_all(diff_path.parent().unwrap());
        let _ = fs::write(&diff_path, &actual);
        eprintln!("\nActual output written to: {}", diff_path.display());
    }

    pretty_assertions::assert_eq!(actual, expected);
}
