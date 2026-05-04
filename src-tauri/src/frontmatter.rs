pub struct Entry {
    pub key: String,
    pub value: String,
}

pub struct Result {
    pub entries: Vec<Entry>,
    pub body: String,
}

pub fn extract(markdown: &str) -> Result {
    Result {
        entries: vec![],
        body: markdown.to_string(),
    }
}

pub fn render_html(_entries: &[Entry]) -> String {
    String::new()
}
