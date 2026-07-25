use crate::{editor_commands, i18n, renderer, state::AppState, toc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EditResult {
    pub new_text: String,
    pub new_selection_start: usize,
    pub new_selection_length: usize,
}

impl From<editor_commands::EditResult> for EditResult {
    fn from(value: editor_commands::EditResult) -> Self {
        Self {
            new_text: value.new_text,
            new_selection_start: value.new_selection_start,
            new_selection_length: value.new_selection_length,
        }
    }
}

/// `tab_id` ist der tab-gebundene Sync-Pfad der KI-Aktionen (Spec
/// docs/spec-ki-actions.md): schreibt gezielt in diesen Tab statt in den
/// gerade aktiven — ein Tab-Wechsel zwischen Frontend-Check und IPC-
/// Eintreffen kann den Text damit keinem fremden Store zuordnen. Der
/// Lone-CR-Wächter prüft den BISHERIGEN Store-Text, bevor Monacos
/// EOL-normalisierter Text ihn überschreibt und die Evidenz zerstört.
/// Aufrufer ohne `tab_id` behalten das bestehende aktiv-Tab-Verhalten.
#[tauri::command]
pub async fn editor_text_changed(
    text: String,
    tab_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut tabs = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?;
    match tab_id {
        Some(tab_id) => {
            let tab = tabs
                .tab_mut(tab_id)
                .ok_or_else(|| i18n::t("errors.editor.sourceTabMissing"))?;
            if crate::ai::mask::has_lone_carriage_return(&tab.document_store.text) {
                return Err(i18n::t("errors.editor.unsupportedLineEndings"));
            }
            tab.document_store.update_text(text);
        }
        None => tabs.active_mut().document_store.update_text(text),
    }
    Ok(())
}

#[tauri::command]
pub async fn editor_save_requested(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?
        .active_mut()
        .document_store
        .save()
        .map_err(localize_save_error)
}

/// Uebersetzt einen `SaveError` fuer die Editor-Save-Pfade (Command +
/// Monaco-`editorSaveRequested`): unmappbare Zeichen (Windows-1252) → eigener
/// Key mit Zeichenliste als `{detail}`, IO-Fehler → `errors.editor.saveFailed`.
/// Save-As nutzt bewusst einen eigenen Match mit `errors.file.saveFailed`.
/// Die Katalog-Keys stehen als String-Literale im Match (Referenz-Gate).
pub(crate) fn localize_save_error(error: crate::document_store::SaveError) -> String {
    match error {
        crate::document_store::SaveError::Unmappable(chars) => i18n::t_args(
            "errors.file.encodingUnmappable",
            &[("detail", &unmappable_detail(&chars))],
        ),
        crate::document_store::SaveError::Io(error) => i18n::t_args(
            "errors.editor.saveFailed",
            &[("detail", &error.to_string())],
        ),
    }
}

/// Kommagetrennte Liste der nicht kodierbaren Zeichen fuer die
/// `{detail}`-Platzhalter der `errors.file.encodingUnmappable`-Meldung.
/// Gemeinsam genutzt von Save (hier) und Save-As.
pub(crate) fn unmappable_detail(chars: &[char]) -> String {
    chars
        .iter()
        .map(|c| c.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[tauri::command]
pub async fn discard_editor_changes(state: State<'_, AppState>) -> Result<bool, String> {
    let mut tabs = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?;
    let store = &mut tabs.active_mut().document_store;
    let Some(path) = store.path.clone() else {
        return Ok(false);
    };
    store.load(&path).map_err(|error| {
        let detail = error.to_string();
        i18n::t_args("errors.editor.discardFailed", &[("detail", &detail)])
    })?;
    Ok(true)
}

/// Setzt die Zeilenenden des aktiven Dokuments (`lf` | `crlf`).
/// No-op bei gleichem Wert. Lehnt Opaque-Docs (Image/Binary + Store-Flag)
/// und fehlende Dokumente ab. `document:eol_changed` / `dirty_changed`
/// kommen ausschliesslich aus den Store-Callbacks (ein Pfad).
#[tauri::command]
pub async fn set_line_ending(eol: String, state: State<'_, AppState>) -> Result<(), String> {
    use crate::document_store::LineEnding;
    use crate::file_kind::{classify, FileKind};

    let wanted = LineEnding::from_label(&eol)
        .ok_or_else(|| i18n::t_args("errors.document.invalidLineEnding", &[("detail", &eol)]))?;

    let mut tabs = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?;
    let tab = tabs.active_mut();
    let store = &mut tab.document_store;
    let Some(path) = store.path.clone() else {
        return Err(i18n::t("errors.document.noneLoaded"));
    };
    // Zweite Verteidigung neben store.opaque (Rename kann Endung aendern).
    let kind = classify(&path);
    if matches!(kind, FileKind::Image | FileKind::Binary) || store.is_opaque() {
        return Err(i18n::t("errors.document.imageReadOnly"));
    }
    // Events laufen ueber DocumentEvents::eol_changed / dirty_changed.
    let _ = store.set_line_ending(wanted);
    Ok(())
}

#[tauri::command]
pub async fn apply_editor_command(
    command: String,
    text: String,
    start: usize,
    length: usize,
    _state: State<'_, AppState>,
) -> Result<EditResult, String> {
    apply_command_utf16(&command, &text, start, length)
}

pub fn apply_command_utf16(
    command: &str,
    text: &str,
    start_utf16: usize,
    length_utf16: usize,
) -> Result<EditResult, String> {
    let start = utf16_offset_to_byte_offset(text, start_utf16);
    let end = utf16_offset_to_byte_offset(text, start_utf16.saturating_add(length_utf16));
    let result = apply_command(command, text, start, end.saturating_sub(start))?;
    Ok(EditResult {
        new_selection_start: byte_offset_to_utf16_offset(
            &result.new_text,
            result.new_selection_start,
        ),
        new_selection_length: byte_range_utf16_len(
            &result.new_text,
            result.new_selection_start,
            result.new_selection_start + result.new_selection_length,
        ),
        ..result
    })
}

/// Live-Preview: rendert reinen Markdown-Text zu HTML + TOC, ohne
/// State zu mutieren. Wird vom Frontend im Split-/View-Mode mit dem
/// aktuellen Editor-Text aufgerufen, um die Vorschau ohne Save zu
/// aktualisieren.
///
/// **Bewusste Abweichung von der CLAUDE.md-Konvention "gerendertes HTML
/// geht ueber Events, nicht ueber Command-Returns"**: fuer den Preview-
/// Pfad ist Request/Response sauberer als Push, weil das Frontend den
/// Roundtrip aktiv treibt (Debounce + Generation-Token-Invalidation).
/// Die kanonischen `document:loaded`/`document:saved`-Renders laufen
/// weiterhin ueber Events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPreview {
    pub content: String,
    pub toc_html: String,
    pub heading_map: Vec<HeadingMapEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingMapEntry {
    pub slug: String,
    pub line: usize,
}

#[tauri::command]
pub async fn render_markdown_preview(text: String) -> Result<RenderPreview, String> {
    let toc_entries = toc::extract(&text);
    Ok(RenderPreview {
        content: renderer::render_body(&text),
        toc_html: toc::render_html(&toc_entries),
        heading_map: heading_map(&toc_entries),
    })
}

pub(crate) fn heading_map(entries: &[toc::TocEntry]) -> Vec<HeadingMapEntry> {
    entries
        .iter()
        .map(|entry| HeadingMapEntry {
            slug: entry.slug.clone(),
            line: entry.line,
        })
        .collect()
}

#[tauri::command]
pub async fn editor_ready(handle: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state
        .automation
        .lock()
        .map_err(|_| "automation state lock poisoned".to_string())?
        .editor_ready = true;
    // Loesen aller `POST /wait { event: "editor.ready" }`-Wartenden.
    crate::automation::wait::signal_editor_ready(state.inner());
    handle
        .emit("editor:ready", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

fn utf16_offset_to_byte_offset(text: &str, utf16_offset: usize) -> usize {
    let mut units = 0usize;
    for (byte_index, ch) in text.char_indices() {
        let next_units = units + ch.len_utf16();
        if next_units > utf16_offset {
            return byte_index;
        }
        units = next_units;
    }
    text.len()
}

fn byte_offset_to_utf16_offset(text: &str, byte_offset: usize) -> usize {
    let byte_offset = byte_offset.min(text.len());
    text.char_indices()
        .take_while(|(byte_index, _)| *byte_index < byte_offset)
        .map(|(_, ch)| ch.len_utf16())
        .sum()
}

fn byte_range_utf16_len(text: &str, start: usize, end: usize) -> usize {
    byte_offset_to_utf16_offset(text, end) - byte_offset_to_utf16_offset(text, start)
}

#[tauri::command]
pub async fn editor_selection(
    start: usize,
    length: usize,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut automation = state
            .automation
            .lock()
            .map_err(|_| "automation state lock poisoned".to_string())?;
        automation.selection_start = start;
        automation.selection_length = length;
    }
    handle
        .emit(
            "editor:selection",
            serde_json::json!({ "start": start, "length": length }),
        )
        .map_err(|error| error.to_string())
}

pub fn apply_command(
    command: &str,
    text: &str,
    start: usize,
    length: usize,
) -> Result<EditResult, String> {
    let result = match command {
        "bold" => editor_commands::toggle_wrap(text, start, length, "**"),
        "italic" => editor_commands::toggle_wrap(text, start, length, "*"),
        "bullet" => editor_commands::toggle_line_prefix(text, start, length, "- "),
        "numbered" => editor_commands::toggle_numbered_list_prefix(text, start, length),
        "heading" => editor_commands::cycle_heading(text, start, length),
        "link" => editor_commands::insert_link(text, start, length),
        "image" => editor_commands::insert_image(text, start, length),
        "table" => editor_commands::insert_table(text, start, length),
        "code" => editor_commands::toggle_wrap(text, start, length, "`"),
        "strike" => editor_commands::toggle_wrap(text, start, length, "~~"),
        "codeblock" => editor_commands::insert_code_block(text, start, length),
        _ => return Err(format!("unknown editor command: {command}")),
    };
    Ok(result.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{CatalogRegistry, ResolvedLanguage, Translator};

    fn translator(tag: &str) -> Translator {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("locales");
        let registry = CatalogRegistry::load_from_dir(&dir).expect("load locales");
        Translator::new(
            registry,
            ResolvedLanguage {
                catalog_tag: tag.to_string(),
                format_locale: "en-US".to_string(),
            },
        )
    }

    #[test]
    fn editor_error_frame_is_localized_and_keeps_detail() {
        let message = translator("en").t_args(
            "errors.editor.saveFailed",
            &[("detail", "technical-io-detail")],
        );
        assert!(message.contains("Could not save document"));
        assert!(message.contains("technical-io-detail"));
    }

    #[test]
    fn applies_bold_command() {
        assert_eq!(
            "**hi**",
            apply_command("bold", "hi", 0, 2).unwrap().new_text
        );
    }

    #[test]
    fn applies_heading_command() {
        assert_eq!(
            "# Title",
            apply_command("heading", "Title", 0, 0).unwrap().new_text
        );
    }

    #[test]
    fn unknown_command_returns_error() {
        assert!(apply_command("missing", "", 0, 0).is_err());
    }

    #[test]
    fn edit_result_converts_from_core_type() {
        let result: EditResult = editor_commands::EditResult {
            new_text: "x".into(),
            new_selection_start: 1,
            new_selection_length: 0,
        }
        .into();
        assert_eq!("x", result.new_text);
    }

    #[test]
    fn apply_command_translates_codemirror_utf16_offsets_to_rust_bytes() {
        let text = "Ä\nTitle";
        let result = apply_command_utf16("heading", text, 2, 0).unwrap();

        assert_eq!("Ä\n# Title", result.new_text);
        assert_eq!(4, result.new_selection_start);
        assert_eq!(0, result.new_selection_length);
    }

    #[test]
    fn apply_command_returns_utf16_selection_offsets() {
        let result = apply_command_utf16("bold", "😀x", 2, 1).unwrap();

        assert_eq!("😀**x**", result.new_text);
        assert_eq!(4, result.new_selection_start);
        assert_eq!(1, result.new_selection_length);
    }

    #[test]
    fn render_preview_produces_content_and_toc() {
        let toc_entries = toc::extract("# Title\n\nBody");
        let preview = RenderPreview {
            content: renderer::render_body("# Title\n\nBody"),
            toc_html: toc::render_html(&toc_entries),
            heading_map: heading_map(&toc_entries),
        };
        assert!(preview.content.contains("<h1"));
        assert!(preview.content.contains("Title"));
        assert!(preview.toc_html.contains("Title"));
        assert_eq!(
            vec![HeadingMapEntry {
                slug: "title".into(),
                line: 1,
            }],
            preview.heading_map,
        );
    }

    #[test]
    fn render_preview_empty_text() {
        let toc_entries = toc::extract("");
        let preview = RenderPreview {
            content: renderer::render_body(""),
            toc_html: toc::render_html(&toc_entries),
            heading_map: heading_map(&toc_entries),
        };
        // Render fuer leeren Text darf nicht panicken — kein <h*>-Anchor noetig.
        assert!(!preview.content.contains("<h1"));
        assert!(preview.heading_map.is_empty());
    }

    #[test]
    fn render_preview_serializes_to_camel_case() {
        let preview = RenderPreview {
            content: "<p>x</p>".to_string(),
            toc_html: "<ul></ul>".to_string(),
            heading_map: vec![HeadingMapEntry {
                slug: "title".into(),
                line: 1,
            }],
        };
        let json = serde_json::to_string(&preview).unwrap();
        assert!(json.contains("\"tocHtml\""), "json={json}");
        assert!(json.contains("\"headingMap\""), "json={json}");
        assert!(!json.contains("toc_html"), "json={json}");
        assert!(!json.contains("heading_map"), "json={json}");
    }
}
