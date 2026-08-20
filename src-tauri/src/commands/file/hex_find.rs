//! Nächster-Treffer-Suche für die Hex-Ansicht.
//!
//! Autorisierung wie [`super::chunk`]: Tab, binärer Deskriptor, Revision
//! unter dem Tabs-Lock, danach I/O ohne Lock. Jeder neue Aufruf cancelt
//! zuerst den Vorgänger über dessen Token in [`AppState`]; der abgebrochene
//! Scan endet mit `stale:` — auch dann, wenn er den Treffer schon gefunden
//! hatte (Abschlussprüfung vor jeder Rückgabe).

use super::chunk::{authorize_chunk_read, open_regular_file, STALE_PREFIX};
use crate::i18n;
use crate::state::AppState;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;

/// Frisch gelesene Bytes je Runde. Der Arbeitspuffer ist zusätzlich
/// `pattern.len() - 1` groß (Overlap), damit die Fenstergröße das Muster
/// immer übersteigt — sonst fände ein Scan nichts, was länger als ein Block
/// ist, und Muster knapp darunter kämen nur ein Byte pro Read voran.
pub(crate) const FIND_BLOCK_BYTES: usize = 64 * 1024;

fn find_error(detail: &str) -> String {
    i18n::t_args("errors.file.readChunk", &[("detail", detail)])
}

fn stale_cancelled() -> String {
    format!("{STALE_PREFIX}cancelled")
}

#[cfg(test)]
pub(crate) fn stale_cancelled_for_tests() -> String {
    stale_cancelled()
}

#[inline]
fn fold_ascii(byte: u8) -> u8 {
    byte.to_ascii_lowercase()
}

fn slice_eq(hay: &[u8], pat: &[u8], case_insensitive: bool) -> bool {
    if hay.len() != pat.len() {
        return false;
    }
    if case_insensitive {
        hay.iter()
            .zip(pat)
            .all(|(left, right)| fold_ascii(*left) == fold_ascii(*right))
    } else {
        hay == pat
    }
}

fn find_in_slice(hay: &[u8], pat: &[u8], case_insensitive: bool) -> Option<usize> {
    if pat.is_empty() || hay.len() < pat.len() {
        return None;
    }
    hay.windows(pat.len())
        .position(|window| slice_eq(window, pat, case_insensitive))
}

fn rfind_in_slice(hay: &[u8], pat: &[u8], case_insensitive: bool) -> Option<usize> {
    if pat.is_empty() || hay.len() < pat.len() {
        return None;
    }
    hay.windows(pat.len())
        .rposition(|window| slice_eq(window, pat, case_insensitive))
}

/// Liest bis `buf` voll ist oder EOF. Einzelne `read`-Aufrufe dürfen kurz sein.
fn read_upto<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize, String> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(find_error(&error.to_string())),
        }
    }
    Ok(filled)
}

fn check_cancelled<F: Fn() -> bool>(is_cancelled: &F) -> Result<(), String> {
    if is_cancelled() {
        Err(stale_cancelled())
    } else {
        Ok(())
    }
}

/// Abschlussprüfung: ein Ergebnis darf nur heraus, wenn der Lauf bis zuletzt
/// der aktuelle ist. Ohne das lieferte ein Scan, der seinen Treffer im schon
/// gelesenen Block findet, nachdem ein neuer Lauf gestartet wurde, weiterhin
/// `Some(offset)` — und die UI spränge auf ein überholtes Ergebnis.
fn finish<F: Fn() -> bool>(hit: Option<u64>, is_cancelled: &F) -> Result<Option<u64>, String> {
    check_cancelled(is_cancelled)?;
    Ok(hit)
}

/// Sucht den nächsten Treffer in einem beliebigen `Read + Seek`.
pub(crate) fn find_in_reader<R: Read + Seek, F: Fn() -> bool>(
    reader: &mut R,
    file_len: u64,
    pattern: &[u8],
    from: u64,
    backwards: bool,
    case_insensitive: bool,
    is_cancelled: F,
) -> Result<Option<u64>, String> {
    if pattern.is_empty() {
        return Ok(None);
    }
    if pattern.len() as u64 > file_len {
        return Ok(None);
    }
    check_cancelled(&is_cancelled)?;
    if backwards {
        find_backward(
            reader,
            file_len,
            pattern,
            from,
            case_insensitive,
            &is_cancelled,
        )
    } else {
        find_forward(
            reader,
            file_len,
            pattern,
            from,
            case_insensitive,
            &is_cancelled,
        )
    }
}

/// Vorwärtsscan. Der Puffer hält den Overlap des Vorgängerblocks plus einen
/// frisch gelesenen Block; gelesen wird ausschließlich sequenziell, jedes
/// Byte also genau einmal — unabhängig davon, wie lang das Muster ist.
fn find_forward<R: Read + Seek, F: Fn() -> bool>(
    reader: &mut R,
    file_len: u64,
    pattern: &[u8],
    from: u64,
    case_insensitive: bool,
    is_cancelled: &F,
) -> Result<Option<u64>, String> {
    let pat_len = pattern.len();
    let last_start = file_len - pat_len as u64;
    if from > last_start {
        return finish(None, is_cancelled);
    }
    let overlap = pat_len - 1;
    let mut buf = vec![0u8; overlap + FIND_BLOCK_BYTES];
    // `buf[..carry]` ist der übernommene Schwanz des Vorgängerblocks,
    // `window_start` die absolute Position von `buf[0]`.
    let mut window_start = from;
    let mut carry = 0usize;
    reader
        .seek(SeekFrom::Start(from))
        .map_err(|error| find_error(&error.to_string()))?;
    loop {
        check_cancelled(is_cancelled)?;
        let read_from = window_start + carry as u64;
        // Bis der Puffer voll ist: in der ersten Runde ist das Overlap +
        // Block (der Puffer muss das Muster fassen), danach genau ein Block.
        let want = file_len
            .saturating_sub(read_from)
            .min((buf.len() - carry) as u64) as usize;
        let n = read_upto(reader, &mut buf[carry..carry + want])?;
        check_cancelled(is_cancelled)?;
        let filled = carry + n;
        if filled < pat_len {
            return finish(None, is_cancelled);
        }
        if let Some(local) = find_in_slice(&buf[..filled], pattern, case_insensitive) {
            return finish(Some(window_start + local as u64), is_cancelled);
        }
        if n < want {
            // `read_upto` looped über kurze Reads — weniger als gewünscht
            // heißt EOF: die Datei ist unter uns geschrumpft.
            return finish(None, is_cancelled);
        }
        buf.copy_within(filled - overlap..filled, 0);
        window_start += (filled - overlap) as u64;
        carry = overlap;
        if window_start > last_start {
            return finish(None, is_cancelled);
        }
    }
}

/// Rückwärtsscan, Fenster für Fenster von hinten. Das erste Fenster endet
/// genau dort, wo ein bei `from - 1` beginnender Treffer endet; damit liegt
/// jeder gefundene Start garantiert unter `from`, und die Folgefenster
/// enden noch früher.
fn find_backward<R: Read + Seek, F: Fn() -> bool>(
    reader: &mut R,
    file_len: u64,
    pattern: &[u8],
    from: u64,
    case_insensitive: bool,
    is_cancelled: &F,
) -> Result<Option<u64>, String> {
    let pat_len = pattern.len();
    let from = from.min(file_len);
    if from == 0 {
        return finish(None, is_cancelled);
    }
    let overlap = pat_len - 1;
    let span = (overlap + FIND_BLOCK_BYTES) as u64;
    let mut window_end = file_len.min((from - 1).saturating_add(pat_len as u64));
    let mut buf = vec![0u8; span as usize];
    loop {
        check_cancelled(is_cancelled)?;
        if window_end < pat_len as u64 {
            return finish(None, is_cancelled);
        }
        let window_start = window_end.saturating_sub(span);
        let want = (window_end - window_start) as usize;
        reader
            .seek(SeekFrom::Start(window_start))
            .map_err(|error| find_error(&error.to_string()))?;
        let n = read_upto(reader, &mut buf[..want])?;
        check_cancelled(is_cancelled)?;
        if n < pat_len {
            return finish(None, is_cancelled);
        }
        if let Some(local) = rfind_in_slice(&buf[..n], pattern, case_insensitive) {
            return finish(Some(window_start + local as u64), is_cancelled);
        }
        if window_start == 0 {
            return finish(None, is_cancelled);
        }
        window_end = window_start + overlap as u64;
    }
}

/// Öffnet über [`open_regular_file`] (FIFO-sicher) und scannt. Die
/// Abschlussprüfung liegt bewusst hier, also im Blocking-Task.
pub(crate) fn find_in_file<F: Fn() -> bool>(
    path: &str,
    pattern: &[u8],
    from: u64,
    backwards: bool,
    case_insensitive: bool,
    is_cancelled: F,
) -> Result<Option<u64>, String> {
    if pattern.is_empty() {
        return Ok(None);
    }
    check_cancelled(&is_cancelled)?;
    let (mut file, file_len) = open_regular_file(path)?;
    let hit = find_in_reader(
        &mut file,
        file_len,
        pattern,
        from,
        backwards,
        case_insensitive,
        &is_cancelled,
    )?;
    finish(hit, &is_cancelled)
}

/// Cancelt den Vorgängerlauf und legt — sofern gesucht werden soll — ein
/// frisches Token ab. Ein Token pro Lauf statt eines Zählers: `fetch_add`
/// auf `u64::MAX` würde im Debug-Build panicken und im Release die 0
/// wiederverwenden, und ein reines Cancel (leeres Pattern) hat gar keinen
/// Nachfolger, gegen den ein Zähler verglichen werden könnte.
fn cancel_running_find(
    state: &AppState,
    start_new: bool,
) -> Result<Option<Arc<AtomicBool>>, String> {
    let mut slot = state
        .hex_find_cancel
        .lock()
        .map_err(|_| find_error("hex find lock poisoned"))?;
    if let Some(previous) = slot.take() {
        previous.store(true, Ordering::SeqCst);
    }
    if !start_new {
        return Ok(None);
    }
    let token = Arc::new(AtomicBool::new(false));
    *slot = Some(Arc::clone(&token));
    Ok(Some(token))
}

/// Linearisiert den Aufruf: erst cancelt er den Vorgänger, dann autorisiert
/// er. Leeres Pattern: kein I/O, `None`. Scheitert die Autorisierung, bleibt
/// das frische Token ungenutzt im State liegen — es cancelt niemanden und
/// wird vom nächsten Aufruf ersetzt.
fn begin_hex_find(
    state: &AppState,
    tab_id: u64,
    revision: u64,
    pattern: &[u8],
) -> Result<Option<(String, Arc<AtomicBool>)>, String> {
    let Some(cancel) = cancel_running_find(state, !pattern.is_empty())? else {
        return Ok(None);
    };
    let path = authorize_chunk_read(state, tab_id, revision)?;
    Ok(Some((path, cancel)))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn hex_find(
    tab_id: u64,
    revision: u64,
    pattern: Vec<u8>,
    from: u64,
    backwards: bool,
    case_insensitive: bool,
    state: State<'_, AppState>,
) -> Result<Option<u64>, String> {
    let Some((path, cancel)) = begin_hex_find(&state, tab_id, revision, &pattern)? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        find_in_file(&path, &pattern, from, backwards, case_insensitive, || {
            cancel.load(Ordering::SeqCst)
        })
    })
    .await
    .map_err(|error| find_error(&error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_kind::FileKind;
    use crate::state::AppState;
    use std::fs;
    use std::io::{Read, Seek, SeekFrom};
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use tempfile::TempDir;

    /// Muster mit früh divergierenden Bytes (nie `0`), damit die naive
    /// Fenstersuche in den Großmuster-Tests nicht über die Füllung läuft.
    fn pattern_of(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8 + 1).collect()
    }

    /// Datei aus Nullen mit genau einem eingebetteten Muster.
    fn data_with_pattern(total: usize, at: usize, pattern: &[u8]) -> Vec<u8> {
        let mut data = vec![0u8; total];
        data[at..at + pattern.len()].copy_from_slice(pattern);
        data
    }

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

    fn never_cancel() -> bool {
        false
    }

    fn find_bytes(data: &[u8], pattern: &[u8], from: u64, backwards: bool) -> Option<u64> {
        find_bytes_ex(data, pattern, from, backwards, false)
    }

    fn find_bytes_ex(
        data: &[u8],
        pattern: &[u8],
        from: u64,
        backwards: bool,
        case_insensitive: bool,
    ) -> Option<u64> {
        let mut reader = std::io::Cursor::new(data.to_vec());
        find_in_reader(
            &mut reader,
            data.len() as u64,
            pattern,
            from,
            backwards,
            case_insensitive,
            never_cancel,
        )
        .unwrap()
    }

    #[test]
    fn hit_at_file_start() {
        install_translator();
        assert_eq!(Some(0), find_bytes(b"HELLO world", b"HELLO", 0, false));
    }

    #[test]
    fn hit_at_file_end() {
        install_translator();
        let data = b"xxxxEND";
        assert_eq!(Some(4), find_bytes(data, b"END", 0, false));
        assert_eq!(Some(4), find_bytes(data, b"END", 4, false));
        assert_eq!(None, find_bytes(data, b"END", 5, false));
    }

    #[test]
    fn hit_exactly_across_block_boundary() {
        install_translator();
        let pat = b"XY";
        // Zwei volle Blöcke: vorwärts startet die zweite Fensterkante bei 64 KiB,
        // rückwärts die erste. Ohne Overlap fehlt der Treffer in beiden Richtungen.
        let mut data = vec![0u8; FIND_BLOCK_BYTES * 2];
        let offset = FIND_BLOCK_BYTES - 1;
        data[offset] = b'X';
        data[offset + 1] = b'Y';
        assert_eq!(
            Some(offset as u64),
            find_bytes(&data, pat, 0, false),
            "pattern straddling the 64 KiB block boundary must be found"
        );
        assert_eq!(
            Some(offset as u64),
            find_bytes(&data, pat, data.len() as u64, true),
            "backward search must also see the straddling match"
        );
    }

    #[test]
    fn pattern_exactly_block_size_is_found() {
        install_translator();
        let pattern = pattern_of(FIND_BLOCK_BYTES);
        // Treffer läuft über die erste Blockgrenze.
        let at = FIND_BLOCK_BYTES / 2 + 7;
        let data = data_with_pattern(FIND_BLOCK_BYTES * 3, at, &pattern);
        assert_eq!(
            Some(at as u64),
            find_bytes(&data, &pattern, 0, false),
            "pattern of exactly one block must not fall through the scan"
        );
        assert_eq!(
            Some(at as u64),
            find_bytes(&data, &pattern, data.len() as u64, true),
            "backward search must find the block-sized pattern too"
        );
    }

    #[test]
    fn pattern_larger_than_block_is_found() {
        install_translator();
        for pat_len in [FIND_BLOCK_BYTES + 1, FIND_BLOCK_BYTES * 2 + 5] {
            let pattern = pattern_of(pat_len);
            let at = FIND_BLOCK_BYTES - 3;
            let data = data_with_pattern(pat_len + FIND_BLOCK_BYTES * 2, at, &pattern);
            assert_eq!(
                Some(at as u64),
                find_bytes(&data, &pattern, 0, false),
                "forward scan must span more than one block for len {pat_len}"
            );
            assert_eq!(
                Some(at as u64),
                find_bytes(&data, &pattern, data.len() as u64, true),
                "backward scan must span more than one block for len {pat_len}"
            );
            assert_eq!(
                None,
                find_bytes(&data, &pattern, at as u64 + 1, false),
                "no wrap-around for oversized patterns either"
            );
        }
    }

    #[test]
    fn oversized_pattern_without_hit_terminates_with_none() {
        install_translator();
        let pattern = pattern_of(FIND_BLOCK_BYTES + 9);
        let data = vec![0u8; FIND_BLOCK_BYTES * 3];
        assert_eq!(None, find_bytes(&data, &pattern, 0, false));
        assert_eq!(None, find_bytes(&data, &pattern, data.len() as u64, true));
    }

    #[test]
    fn backward_finds_previous_hit() {
        install_translator();
        let data = b"abc--abc--abc";
        assert_eq!(Some(10), find_bytes(data, b"abc", 13, true));
        assert_eq!(Some(5), find_bytes(data, b"abc", 10, true));
        assert_eq!(Some(0), find_bytes(data, b"abc", 5, true));
        assert_eq!(None, find_bytes(data, b"abc", 0, true));
    }

    #[test]
    fn ascii_case_insensitive_folds_only_letters() {
        install_translator();
        let data = b"xxAbCyy";
        assert_eq!(Some(2), find_bytes_ex(data, b"abc", 0, false, true));
        assert_eq!(None, find_bytes_ex(data, b"abc", 0, false, false));
        assert_eq!(Some(2), find_bytes_ex(data, b"ABC", 7, true, true));

        // Nicht-ASCII darf nicht geraten werden: 0xC1 / 0xE1 sind keine A-Z.
        let latin1 = [0xC1, 0x00, 0xE1];
        assert_eq!(Some(2), find_bytes_ex(&latin1, &[0xE1], 0, false, true));
    }

    #[test]
    fn empty_pattern_is_none() {
        install_translator();
        let state = AppState::new();
        assert!(
            begin_hex_find(&state, 1, 1, b"").unwrap().is_none(),
            "empty pattern skips authorize and I/O"
        );
        assert_eq!(None, find_bytes(b"abc", b"", 0, false));
        assert_eq!(
            None,
            find_in_file("/nope", b"", 0, false, false, never_cancel).unwrap()
        );
    }

    #[test]
    fn pattern_longer_than_file_is_none() {
        install_translator();
        assert_eq!(None, find_bytes(b"ab", b"abcd", 0, false));
        assert_eq!(None, find_bytes(b"ab", b"abcd", 2, true));
    }

    #[test]
    fn revision_mismatch_uses_stale_prefix() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("blob.bin");
        fs::write(&path, b"xyz").unwrap();
        let state = AppState::new();
        let (tab_id, revision) = load_binary(&state, path.to_str().unwrap());
        let err = begin_hex_find(&state, tab_id, revision + 1, b"xy").unwrap_err();
        assert!(
            err.starts_with(STALE_PREFIX),
            "expected stale: prefix, got {err}"
        );
    }

    #[test]
    fn directory_is_localized_error() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let err = find_in_file(
            temp.path().to_str().unwrap(),
            b"ab",
            0,
            false,
            false,
            never_cancel,
        )
        .unwrap_err();
        assert!(
            err.contains("not a regular file") || err.contains("Is a directory"),
            "expected localized reject for a directory, got {err}"
        );
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
            let _ = tx.send(find_in_file(&path, b"ab", 0, false, false, never_cancel));
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
    fn cancelled_run_returns_stale_prefix() {
        install_translator();
        let mut data = vec![0u8; FIND_BLOCK_BYTES * 2 + 32];
        data[FIND_BLOCK_BYTES + 8] = 0xFF;
        let checks = AtomicUsize::new(0);
        let mut reader = std::io::Cursor::new(data);
        let err = find_in_reader(
            &mut reader,
            (FIND_BLOCK_BYTES * 2 + 32) as u64,
            &[0xFF],
            0,
            false,
            false,
            || checks.fetch_add(1, AtomicOrdering::Relaxed) >= 2,
        )
        .expect_err("in-flight cancel must abort the scan");
        assert!(
            err.starts_with(STALE_PREFIX),
            "expected stale: prefix, got {err}"
        );
    }

    #[test]
    fn new_run_cancels_the_previous_token() {
        install_translator();
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("blob.bin");
        fs::write(&path, vec![0u8; FIND_BLOCK_BYTES + 8]).unwrap();
        let state = AppState::new();
        let (tab_id, revision) = load_binary(&state, path.to_str().unwrap());

        let (authorized, first) = begin_hex_find(&state, tab_id, revision, b"\x01")
            .unwrap()
            .expect("non-empty pattern should start a scan");
        let (_, second) = begin_hex_find(&state, tab_id, revision, b"\x01")
            .unwrap()
            .expect("second call starts its own run");
        assert!(
            first.load(Ordering::SeqCst),
            "starting a run must cancel its predecessor"
        );
        assert!(!second.load(Ordering::SeqCst), "the new run stays alive");

        let err = find_in_file(&authorized, b"\x01", 0, false, false, || {
            first.load(Ordering::SeqCst)
        })
        .unwrap_err();
        assert!(
            err.starts_with(STALE_PREFIX),
            "expected stale: prefix for the cancelled run, got {err}"
        );

        // Leeres Pattern ist ein reines Cancel: kein Nachfolger, aber der
        // laufende Scan muss trotzdem enden.
        assert!(begin_hex_find(&state, tab_id, revision, b"")
            .unwrap()
            .is_none());
        assert!(
            second.load(Ordering::SeqCst),
            "an empty pattern must cancel the running scan"
        );
    }

    #[test]
    fn cancel_during_read_aborts_before_returning_a_hit() {
        install_translator();
        // Der Treffer steht im ersten Block; das Token kippt, WÄHREND dieser
        // Block gelesen wird. Ohne Prüfung nach dem Read käme `Some(8)` zurück.
        let mut data = vec![0u8; FIND_BLOCK_BYTES * 2];
        data[8] = 0xFF;
        let flag = Arc::new(AtomicBool::new(false));
        let mut reader = CancelOnRead {
            inner: std::io::Cursor::new(data.clone()),
            flag: Arc::clone(&flag),
        };
        let watched = Arc::clone(&flag);
        let err = find_in_reader(
            &mut reader,
            data.len() as u64,
            &[0xFF],
            0,
            false,
            false,
            move || watched.load(Ordering::SeqCst),
        )
        .expect_err("a run cancelled mid-read must not deliver its hit");
        assert!(
            err.starts_with(STALE_PREFIX),
            "expected stale: prefix, got {err}"
        );
    }

    #[test]
    fn hit_found_before_cancel_is_still_stale() {
        install_translator();
        // Aufrufsequenz bis zum Treffer im ersten Block: Eingangsprüfung,
        // Rundenbeginn, nach dem Read — erst die Abschlussprüfung in `finish`
        // sieht das Token gesetzt. Ohne sie käme `Some(8)` heraus.
        let mut data = vec![0u8; 64];
        data[8] = 0xFF;
        let checks = AtomicUsize::new(0);
        let mut reader = std::io::Cursor::new(data);
        let err = find_in_reader(&mut reader, 64, &[0xFF], 0, false, false, || {
            checks.fetch_add(1, AtomicOrdering::SeqCst) >= 3
        })
        .expect_err("the final check must swallow a hit from a stale run");
        assert!(
            err.starts_with(STALE_PREFIX),
            "expected stale: prefix, got {err}"
        );
        assert_eq!(
            4,
            checks.load(AtomicOrdering::SeqCst),
            "entry, round start, post-read and final check"
        );
    }

    #[test]
    fn no_wrap_around() {
        install_translator();
        let data = b"needle----";
        assert_eq!(None, find_bytes(data, b"needle", 1, false));
        assert_eq!(None, find_bytes(data, b"----", 6, true));
    }

    #[test]
    fn short_reads_still_find_boundary_hit() {
        install_translator();
        let pat = b"XY";
        let mut data = vec![0u8; FIND_BLOCK_BYTES + 2];
        let offset = FIND_BLOCK_BYTES - 1;
        data[offset] = b'X';
        data[offset + 1] = b'Y';
        let mut reader = ShortReader {
            inner: std::io::Cursor::new(data.clone()),
        };
        let found = find_in_reader(
            &mut reader,
            data.len() as u64,
            pat,
            0,
            false,
            false,
            never_cancel,
        )
        .unwrap();
        assert_eq!(Some(offset as u64), found);
    }

    /// Setzt das Cancel-Token, während der Block gelesen wird.
    struct CancelOnRead {
        inner: std::io::Cursor<Vec<u8>>,
        flag: Arc<AtomicBool>,
    }

    impl Read for CancelOnRead {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.flag.store(true, Ordering::SeqCst);
            self.inner.read(buf)
        }
    }

    impl Seek for CancelOnRead {
        fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(pos)
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
}
