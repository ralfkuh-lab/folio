use folio_lib::{
    document_store::{DocumentStore, LineEnding},
    file_resolver,
    workspace::Workspace,
};
use std::fs;
use tempfile::TempDir;

#[test]
fn document_store_file_resolver_and_workspace_work_together() {
    let temp = TempDir::new().unwrap();
    let docs = temp.path().join("Docs");
    fs::create_dir(&docs).unwrap();
    let current = docs.join("Current.md");
    let linked = docs.join("Linked File.md");
    fs::write(
        &current,
        b"\xEF\xBB\xBF# Title\r\nSee [linked](linked%20file.md)\r\n",
    )
    .unwrap();
    fs::write(&linked, "# Linked\n").unwrap();

    let resolved =
        file_resolver::resolve(current.to_str().unwrap(), "linked%20file.md#top").unwrap();
    assert!(file_resolver::paths_equal(
        &resolved,
        linked.to_str().unwrap()
    ));

    let mut store = DocumentStore::new();
    let loaded = store.load(current.to_str().unwrap()).unwrap();
    assert_eq!("# Title\nSee [linked](linked%20file.md)\n", loaded.text);
    assert_eq!(LineEnding::Crlf, store.line_ending);
    assert!(store.had_bom);
    assert!(!store.is_dirty);

    store.update_text("# Updated\nSee [linked](linked%20file.md)\n".into());
    assert!(store.is_dirty);
    assert!(store.save().unwrap());
    assert!(!store.is_dirty);
    assert_eq!(
        b"\xEF\xBB\xBF# Updated\r\nSee [linked](linked%20file.md)\r\n".to_vec(),
        fs::read(&current).unwrap()
    );

    let workspace_path = temp.path().join("workspace.json");
    let mut workspace = Workspace::load_from(workspace_path.clone());
    workspace
        .add_recent(store.path.clone().expect("loaded path"))
        .unwrap();
    let reloaded = Workspace::load_from(workspace_path);
    assert_eq!(1, reloaded.recent().len());
    assert_eq!(current.to_string_lossy(), reloaded.recent()[0].path);
}

#[test]
fn anchor_only_resolution_loads_current_document() {
    let temp = TempDir::new().unwrap();
    let current = temp.path().join("Current.md");
    fs::write(&current, "Body\n").unwrap();

    let resolved = file_resolver::resolve(current.to_str().unwrap(), "#section").unwrap();
    let mut store = DocumentStore::new();
    store.load(&resolved).unwrap();

    assert!(file_resolver::paths_equal(
        &resolved,
        current.to_str().unwrap()
    ));
    assert_eq!("Body\n", store.text);
}

#[test]
fn workspace_recent_tracks_multiple_loaded_documents() {
    let temp = TempDir::new().unwrap();
    let first = temp.path().join("first.md");
    let second = temp.path().join("second.md");
    fs::write(&first, "first").unwrap();
    fs::write(&second, "second").unwrap();
    let mut store = DocumentStore::new();
    let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));

    store.load(first.to_str().unwrap()).unwrap();
    workspace.add_recent(store.path.clone().unwrap()).unwrap();
    store.load(second.to_str().unwrap()).unwrap();
    workspace.add_recent(store.path.clone().unwrap()).unwrap();

    assert_eq!(2, workspace.recent().len());
    assert_eq!(second.to_string_lossy(), workspace.recent()[0].path);
    assert_eq!(first.to_string_lossy(), workspace.recent()[1].path);
}
