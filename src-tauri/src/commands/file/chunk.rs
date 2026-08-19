//! Byte-Chunk-Lese-Command für die Hex-Ansicht.
//!
//! Der Pfad kommt ausschließlich aus dem Tab (kein Frontend-Pfad).
//! Authorize unter dem Tabs-Lock, I/O danach in `spawn_blocking`.

use crate::file_kind::FileKind;
use crate::i18n;
use crate::state::AppState;
use std::io::{Read, Seek, SeekFrom};
use tauri::{ipc::Response, State};

/// Maximales Fenster je Aufruf (Spec). Längere `len` werden gekürzt.
pub const MAX_CHUNK_BYTES: u32 = 1024 * 1024;
pub(crate) const STALE_PREFIX: &str = "stale:";

fn chunk_error(detail: &str) -> String {
    i18n::t_args("errors.file.readChunk", &[("detail", detail)])
}

/// Tab existiert, Deskriptor ist binär, Revision stimmt. Liefert den
/// kopierten Pfad; der Aufrufer gibt den Lock danach frei.
pub(crate) fn authorize_chunk_read(
    state: &AppState,
    tab_id: u64,
    revision: u64,
) -> Result<String, String> {
    let tabs = state
        .tabs
        .lock()
        .map_err(|_| chunk_error("tabs lock poisoned"))?;
    let tab = tabs.tab(tab_id).ok_or_else(|| chunk_error("unknown tab"))?;
    let Some(desc) = tab.document_store.descriptor() else {
        return Err(chunk_error("no document"));
    };
    if desc.kind != FileKind::Binary {
        return Err(chunk_error("not a binary document"));
    }
    if desc.revision != revision {
        return Err(format!(
            "{STALE_PREFIX}revision {revision} != {}",
            desc.revision
        ));
    }
    tab.document_store
        .path
        .clone()
        .ok_or_else(|| chunk_error("no path"))
}

/// Öffnet `path` zum Lesen und akzeptiert ausschließlich reguläre Dateien.
/// Gemeinsamer Einstieg für [`read_file_chunk_bytes`] und
/// [`super::hex_find::find_in_file`]; liefert Handle plus Dateilänge.
///
/// Unix öffnet mit `O_NONBLOCK`: ein FIFO ohne Writer ließe `open` sonst
/// unbegrenzt hängen, und eine `metadata`-Vorprüfung schließt das Fenster
/// zwischen `stat` und `open` nicht (die Datei kann dazwischen ersetzt
/// werden). Reguläre Dateien ignorieren das Flag; autoritativ ist danach
/// ausschließlich `fstat` **auf dem Handle**.
///
/// Windows hat kein Äquivalent: der blockierende Fall ist dort das Öffnen
/// einer Named Pipe (`\\.\pipe\…`), und weder `FILE_FLAG_OVERLAPPED` noch
/// ein `GetFileType` nach dem Open verhindern den Block *während* des
/// `CreateFile`. Das bräuchte einen eigenen Win32-Pfad
/// (`WaitNamedPipe`/Timeout-Thread) und bleibt bewusst offen — es bleibt
/// beim `metadata`-Vorcheck plus Handle-Prüfung.
pub(crate) fn open_regular_file(path: &str) -> Result<(std::fs::File, u64), String> {
    let file = open_read_only(path).map_err(|error| chunk_error(&error.to_string()))?;
    let meta = file
        .metadata()
        .map_err(|error| chunk_error(&error.to_string()))?;
    if !meta.is_file() {
        return Err(chunk_error("not a regular file"));
    }
    Ok((file, meta.len()))
}

#[cfg(unix)]
fn open_read_only(path: &str) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_read_only(path: &str) -> std::io::Result<std::fs::File> {
    let pre = std::fs::metadata(path)?;
    if !pre.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    std::fs::File::open(path)
}

/// Liest `len` Bytes ab `offset`. `len` wird auf [`MAX_CHUNK_BYTES`]
/// geklemmt. `len == 0`, Offset jenseits EOF und überlaufende
/// Offset-Rechnung liefern eine leere Antwort.
pub(crate) fn read_file_chunk_bytes(path: &str, offset: u64, len: u32) -> Result<Vec<u8>, String> {
    let len = len.min(MAX_CHUNK_BYTES);
    if len == 0 || offset.checked_add(u64::from(len)).is_none() {
        return Ok(Vec::new());
    }
    let (mut file, file_len) = open_regular_file(path)?;
    read_chunk_from(&mut file, file_len, offset, len)
}

/// Leseschleife über einen beliebigen `Read + Seek` — ein einzelnes
/// `read` darf kurz liefern (`take` + `read_to_end` looped).
fn read_chunk_from<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
    offset: u64,
    len: u32,
) -> Result<Vec<u8>, String> {
    let len = len.min(MAX_CHUNK_BYTES);
    if len == 0 || offset.checked_add(u64::from(len)).is_none() || offset >= file_len {
        return Ok(Vec::new());
    }
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|error| chunk_error(&error.to_string()))?;
    let to_read = u64::from(len).min(file_len - offset);
    let mut buf = Vec::with_capacity(to_read as usize);
    reader
        .by_ref()
        .take(to_read)
        .read_to_end(&mut buf)
        .map_err(|error| chunk_error(&error.to_string()))?;
    Ok(buf)
}

#[tauri::command]
pub async fn read_file_chunk(
    tab_id: u64,
    revision: u64,
    offset: u64,
    len: u32,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let path = authorize_chunk_read(&state, tab_id, revision)?;
    let bytes =
        tauri::async_runtime::spawn_blocking(move || read_file_chunk_bytes(&path, offset, len))
            .await
            .map_err(|error| chunk_error(&error.to_string()))??;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_kind::FileKind;
    use crate::state::AppState;
    use std::fs;
    use tempfile::TempDir;

    fn install_translator() {
        let _ = crate::i18n::set_process_translator(crate::i18n::Translator::new(
            crate::i18n::load_embedded_registry(),
            crate::i18n::ResolvedLanguage {
                catalog_tag: "en".into(),
                format_locale: "en-US".into(),
            },
        ));
    }

    fn load_binary(state: &AppState, path: &str) -> (u64, u64) {
        let size = fs::metadata(path).unwrap().len();
        let mut tabs = state.tabs.lock().unwrap();
        let tab = tabs.active_mut();
        tab.document_store
            .load_opaque_as(path, FileKind::Binary, size)
            .unwrap();
        let revision = tab.document_store.descriptor().unwrap().revision;
        (tab.id, revision)
    }

    #[test]
    fn mid_file_offset_returns_exact_bytes() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("blob.bin");
        fs::write(&path, b"abcdefghij").unwrap();
        let state = AppState::new();
        let (tab_id, revision) = load_binary(&state, path.to_str().unwrap());
        let authorized = authorize_chunk_read(&state, tab_id, revision).unwrap();
        let bytes = read_file_chunk_bytes(&authorized, 3, 4).unwrap();
        assert_eq!(b"defg", bytes.as_slice());
    }

    #[test]
    fn empty_for_zero_len_and_offset_past_eof() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("blob.bin");
        fs::write(&path, b"abcdefghij").unwrap();
        let state = AppState::new();
        let (tab_id, revision) = load_binary(&state, path.to_str().unwrap());
        let authorized = authorize_chunk_read(&state, tab_id, revision).unwrap();
        assert!(read_file_chunk_bytes(&authorized, 0, 0).unwrap().is_empty());
        assert!(read_file_chunk_bytes(&authorized, 10, 4)
            .unwrap()
            .is_empty());
        assert!(read_file_chunk_bytes(&authorized, 100, 4)
            .unwrap()
            .is_empty());
        assert!(read_file_chunk_bytes(&authorized, u64::MAX - 8, 16)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn len_over_max_is_clamped() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("big.bin");
        let mut data = vec![0u8; MAX_CHUNK_BYTES as usize + 32];
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        fs::write(&path, &data).unwrap();
        let bytes = read_file_chunk_bytes(path.to_str().unwrap(), 0, MAX_CHUNK_BYTES + 50).unwrap();
        assert_eq!(MAX_CHUNK_BYTES as usize, bytes.len());
        assert_eq!(&data[..MAX_CHUNK_BYTES as usize], bytes.as_slice());
    }

    #[test]
    fn revision_mismatch_uses_stale_prefix() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("blob.bin");
        fs::write(&path, b"xyz").unwrap();
        let state = AppState::new();
        let (tab_id, revision) = load_binary(&state, path.to_str().unwrap());
        let err = authorize_chunk_read(&state, tab_id, revision + 1).unwrap_err();
        assert!(
            err.starts_with(STALE_PREFIX),
            "expected stale: prefix, got {err}"
        );
    }

    #[test]
    fn unknown_tab_is_localized_error() {
        install_translator();
        let state = AppState::new();
        let err = authorize_chunk_read(&state, 99_999, 1).unwrap_err();
        assert!(!err.starts_with(STALE_PREFIX));
        assert!(
            err.contains("unknown tab"),
            "expected localized readChunk with detail, got {err}"
        );
    }

    #[test]
    fn directory_is_localized_error() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let err = read_file_chunk_bytes(temp.path().to_str().unwrap(), 0, 16).unwrap_err();
        assert!(
            err.contains("not a regular file") || err.contains("Is a directory"),
            "expected localized readChunk for a directory, got {err}"
        );
    }

    #[test]
    fn read_loop_covers_file_larger_than_default_buffer() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("wide.bin");
        let mut data = vec![0u8; 80_000];
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        fs::write(&path, &data).unwrap();
        let bytes = read_file_chunk_bytes(path.to_str().unwrap(), 0, 80_000).unwrap();
        assert_eq!(data, bytes);
        let mid = read_file_chunk_bytes(path.to_str().unwrap(), 40_000, 20_000).unwrap();
        assert_eq!(&data[40_000..60_000], mid.as_slice());
    }

    #[test]
    fn missing_descriptor_is_localized_error() {
        install_translator();
        let state = AppState::new();
        let tab_id = state.tabs.lock().unwrap().active().id;
        let err = authorize_chunk_read(&state, tab_id, 1).unwrap_err();
        assert!(
            err.contains("no document"),
            "expected no-descriptor reject, got {err}"
        );
    }

    #[test]
    fn non_binary_descriptor_is_localized_error() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("note.md");
        fs::write(&path, "hello").unwrap();
        let state = AppState::new();
        {
            let mut tabs = state.tabs.lock().unwrap();
            tabs.active_mut()
                .document_store
                .load(path.to_str().unwrap())
                .unwrap();
        }
        let (tab_id, revision) = {
            let tabs = state.tabs.lock().unwrap();
            let tab = tabs.active();
            (tab.id, tab.document_store.descriptor().unwrap().revision)
        };
        let err = authorize_chunk_read(&state, tab_id, revision).unwrap_err();
        assert!(
            err.contains("not a binary document"),
            "expected non-binary reject, got {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_regular_file_reads_bytes() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("blob.bin");
        fs::write(&target, b"abcdefghij").unwrap();
        let link = temp.path().join("alias.bin");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let bytes = read_file_chunk_bytes(link.to_str().unwrap(), 3, 4).unwrap();
        assert_eq!(b"defg", bytes.as_slice());
    }

    #[cfg(unix)]
    #[test]
    fn fifo_is_localized_error_without_hanging() {
        use std::sync::mpsc;
        use std::time::Duration;

        install_translator();
        let temp = TempDir::new().unwrap();
        let fifo = temp.path().join("pipe");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("spawn mkfifo");
        assert!(status.success(), "mkfifo failed: {status}");
        let path = fifo.to_string_lossy().into_owned();

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(read_file_chunk_bytes(&path, 0, 16));
        });
        let result = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("FIFO must not block File::open; pre-check is missing");
        let err = result.expect_err("FIFO must be rejected");
        assert!(
            err.contains("not a regular file"),
            "expected localized non-file error, got {err}"
        );
    }

    #[test]
    fn unseekable_reader_is_localized_error() {
        install_translator();
        let mut reader = Unseekable(std::io::Cursor::new(b"abcdefghij".to_vec()));
        let err = read_chunk_from(&mut reader, 10, 0, 4).unwrap_err();
        assert!(
            err.contains("not seekable") || err.contains("Unsupported"),
            "expected seek failure, got {err}"
        );
    }

    #[test]
    fn short_reads_are_assembled() {
        install_translator();
        let data: Vec<u8> = (0u8..=200).collect();
        let len = data.len() as u64;
        let mut reader = ShortReader {
            inner: std::io::Cursor::new(data.clone()),
        };
        let bytes = read_chunk_from(&mut reader, len, 10, 50).unwrap();
        assert_eq!(&data[10..60], bytes.as_slice());
    }

    #[test]
    fn command_response_is_raw_bytes() {
        use tauri::ipc::{InvokeResponseBody, IpcResponse};

        install_translator();
        let payload = b"raw-chunk".to_vec();
        let response = Response::new(payload.clone());
        match response.body().unwrap() {
            InvokeResponseBody::Raw(raw) => assert_eq!(payload, raw),
            InvokeResponseBody::Json(json) => {
                panic!("expected Raw body, got Json: {json}")
            }
        }
    }

    struct ShortReader {
        inner: std::io::Cursor<Vec<u8>>,
    }

    impl Read for ShortReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if buf.is_empty() {
                return Ok(0);
            }
            self.inner.read(&mut buf[..1])
        }
    }

    impl Seek for ShortReader {
        fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    struct Unseekable(std::io::Cursor<Vec<u8>>);

    impl Read for Unseekable {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Seek for Unseekable {
        fn seek(&mut self, _: SeekFrom) -> std::io::Result<u64> {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "not seekable",
            ))
        }
    }
}
