//! Datei-bezogene Tauri-Commands und Helfer.
//!
//! - [`read_file`] — Tauri-Command fürs Öffnen/Lesen über den Service-Pfad
//! - [`rename_file`] (Command) + [`run_rename_dialog`] (für Menü-Pfad) —
//!   teilen sich `perform_move` als gemeinsame State-Choreografie.
//! - [`create_directory`] — leeren Ordner anlegen (kein `create_dir_all`).
//! - [`duplicate_entry`] / [`copy_entry`] / [`move_entry`] — V2 Clipboard.
//!   `move_entry` teilt sich `perform_move`.
//! - [`trash_path`] — Datei oder Ordner in den Papierkorb.
//! - [`run_save_as`] (für Menü-Pfad) + [`save_as`] (Command-Wrapper).
//! - [`close_document`] — kapselt Store-Reset + Vault.active + `document:closed`.
//! - [`file_list`] / `list_dir` — Verzeichnis-Listing.

pub mod close;
pub mod create;
pub mod delete;
pub mod dir;
pub mod image;
pub mod list;
pub mod read;
pub mod rename;
pub mod save_as;
pub mod transfer;
mod types;
mod util;

pub use list::list_dir;
pub use rename::run_rename_dialog;
pub use save_as::run_save_as;
pub use types::{FileData, FileEntry};
