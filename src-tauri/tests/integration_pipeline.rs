use folio_lib::{renderer, toc};

#[test]
fn render_pipeline_extracts_toc_and_html_for_rich_markdown() {
    let markdown = concat!(
        "---\n",
        "title: \"Pipeline\"\n",
        "tags: [one, two]\n",
        "---\n",
        "# Overview <a id=\"overview-anchor\"></a>\n",
        "\n",
        "## Tasks\n",
        "- [x] done\n",
        "- [ ] next\n",
        "\n",
        "## Data {#custom-data}\n",
        "| Name | Value |\n",
        "|---|---|\n",
        "| A | 1 |\n",
    );

    let entries = toc::extract(markdown);
    let html = renderer::render_body(markdown);

    assert_eq!(3, entries.len());
    assert_eq!("Overview", entries[0].text);
    assert_eq!("overview-anchor", entries[0].slug);
    assert_eq!("Tasks", entries[1].text);
    assert_eq!("tasks", entries[1].slug);
    assert_eq!("Data", entries[2].text);
    assert_eq!("custom-data", entries[2].slug);

    assert!(html.contains(r#"<aside class="frontmatter"><dl>"#));
    assert!(html.contains("<dt>title</dt><dd>Pipeline</dd>"));
    assert!(html.contains(r#"<h1 id="overview-anchor" data-sourcepos=""#));
    assert!(html.contains(r#"data-line="5">Overview</h1>"#));
    assert!(html.contains(r#"<h2 id="tasks" data-sourcepos="3:1-3:8" data-line="7">Tasks</h2>"#));
    assert!(html.contains(r#"<h2 id="custom-data" data-sourcepos=""#));
    assert!(html.contains(r#"data-line="11">Data</h2>"#));
    assert!(html.contains(r#"<ul class="contains-task-list" data-sourcepos=""#));
    assert!(html.contains(r#"<input disabled="disabled" type="checkbox" checked="checked" />"#));
    assert!(html.contains(r#"<table data-sourcepos=""#));
    assert!(html.contains(r#"data-line="12">"#));
}

#[test]
fn toc_html_matches_extracted_heading_entries() {
    let entries = toc::extract("# A\n## B\n### C\n");
    let html = toc::render_html(&entries);

    assert!(html.contains(r#"data-level="1" data-slug="a""#));
    assert!(html.contains(r#"<span class="text">A</span>"#));
    assert!(html.contains(r#"data-level="2" data-slug="b""#));
    assert!(html.contains(r#"<span class="num">1</span>"#));
    assert!(html.contains(r#"data-level="3" data-slug="c""#));
    assert!(html.contains(r#"<span class="num">1.1</span>"#));
}

#[test]
fn repeated_headings_get_consistent_unique_slugs_in_toc_and_html() {
    let markdown = "# Same\n# Same\n";
    let entries = toc::extract(markdown);
    let html = renderer::render_body(markdown);

    assert_eq!("same", entries[0].slug);
    assert_eq!("same-1", entries[1].slug);
    assert!(html.contains(r#"<h1 id="same" data-sourcepos="1:1-1:6" data-line="1">Same</h1>"#));
    assert!(html.contains(r#"<h1 id="same-1" data-sourcepos="2:1-2:6" data-line="2">Same</h1>"#));
}
