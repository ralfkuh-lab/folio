//! Markdown-Editier-Befehle für den Monaco-Editor.
//!
//! Die `pub fn`-Befehle liefern jeweils einen [`EditResult`] mit neuem Text
//! und neuer Selektion — der Aufrufer (`commands/editor.rs`) reicht das ans
//! Frontend weiter, dort wird per `applyReplace` ersetzt.
//!
//! Aufgeteilt nach Kategorie:
//! - [`inline`] — Wrap-/Inline-Befehle (Bold, Italic, Code, Strike,
//!   Link, Bild)
//! - [`lines`] — Zeilen-Präfixe (Bullet, Numbered, Heading-Cycle)
//! - [`blocks`] — Block-Befehle (Tabelle, Codeblock)
//! - [`util`] — gemeinsame Range-/UTF-8-/Newline-Helper

mod blocks;
mod inline;
mod lines;
mod util;

pub use blocks::{insert_code_block, insert_table};
pub use inline::{insert_image, insert_link, toggle_wrap};
pub use lines::{cycle_heading, toggle_line_prefix, toggle_numbered_list_prefix};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditResult {
    pub new_text: String,
    pub new_selection_start: usize,
    pub new_selection_length: usize,
}
