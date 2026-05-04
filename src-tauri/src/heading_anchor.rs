use regex::Regex;
use std::sync::OnceLock;

pub fn convert_inline_anchors_in_headings(markdown: &str) -> String {
    if markdown.is_empty() || !markdown.to_ascii_lowercase().contains("<a") {
        return markdown.to_string();
    }

    heading_line_regex()
        .replace_all(markdown, |captures: &regex::Captures<'_>| {
            let rest = captures.name("rest").expect("rest capture").as_str();
            let mut last_id = None;
            let stripped = inline_anchor_regex()
                .replace_all(rest, |anchor: &regex::Captures<'_>| {
                    last_id = Some(anchor[1].to_string());
                    ""
                })
                .trim_end()
                .to_string();

            match last_id {
                Some(id) => format!("{} {} {{#{}}}", &captures["hashes"], stripped, id),
                None => captures[0].to_string(),
            }
        })
        .to_string()
}

fn inline_anchor_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"<a\s+id\s*=\s*["']([^"']+)["']\s*>\s*</a>"#)
            .expect("inline anchor regex must compile")
    })
}

fn heading_line_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?m)^(?P<hashes>#{1,6})[ \t]+(?P<rest>.+?)[ \t]*$")
            .expect("heading line regex must compile")
    })
}
