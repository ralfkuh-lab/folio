use std::fs;
use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
enum ScanState {
    Normal,
    StringLiteral { escaped: bool },
    RawStringLiteral { hash_count: usize },
    LineComment,
    BlockComment,
}

pub fn find_german_errors(content: &str) -> Vec<(usize, String)> {
    let german_words = [
        "nicht",
        "kann",
        "keine",
        "kein",
        "ungültig",
        "fehlgeschlagen",
        "müssen",
        "dürfen",
        "bereits",
        "wurde",
        "fehler",
        "konnte",
        "existiert",
        "datei",
        "verzeichnis",
        "löschen",
        "speichern",
        "ungueltig",
        "koennen",
        "fuer",
        "loeschen",
        "aendern",
        "ueber",
        "ueberschreitet",
        "anlegen",
        "gueltiges",
        "ungueltiges",
        "fehlgeschlagen",
    ];

    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    let mut line_num = 1;
    let mut current_depth = 0;
    let mut test_block_start_depth: Option<usize> = None;
    let mut pending_test_block = false;

    let mut state = ScanState::Normal;
    let mut failures = Vec::new();

    let mut current_line_has_test_trigger = false;

    while i < chars.len() {
        let c = chars[i];

        if c == '\n' {
            line_num += 1;
            current_line_has_test_trigger = false;
        }

        match state {
            ScanState::Normal => {
                if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
                    state = ScanState::LineComment;
                    i += 2;
                    continue;
                }
                if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
                    state = ScanState::BlockComment;
                    i += 2;
                    continue;
                }

                if c == '"' {
                    state = ScanState::StringLiteral { escaped: false };
                    i += 1;
                    continue;
                }

                if c == 'r' && i + 1 < chars.len() && (chars[i + 1] == '"' || chars[i + 1] == '#') {
                    let mut hash_count = 0;
                    let mut j = i + 1;
                    while j < chars.len() && chars[j] == '#' {
                        hash_count += 1;
                        j += 1;
                    }
                    if j < chars.len() && chars[j] == '"' {
                        state = ScanState::RawStringLiteral { hash_count };
                        i = j + 1;
                        continue;
                    }
                }

                if c == '{' {
                    current_depth += 1;
                    if pending_test_block {
                        test_block_start_depth = Some(current_depth);
                        pending_test_block = false;
                    }
                } else if c == '}' {
                    if test_block_start_depth == Some(current_depth) {
                        test_block_start_depth = None;
                    }
                    current_depth = current_depth.saturating_sub(1);
                }

                if !current_line_has_test_trigger {
                    if i + 9 <= chars.len()
                        && chars[i..i + 9] == ['m', 'o', 'd', ' ', 't', 'e', 's', 't', 's']
                    {
                        current_line_has_test_trigger = true;
                        pending_test_block = true;
                    }
                    if i + 9 <= chars.len()
                        && chars[i..i + 9] == ['c', 'f', 'g', '(', 't', 'e', 's', 't', ')']
                    {
                        current_line_has_test_trigger = true;
                        pending_test_block = true;
                    }
                }

                if test_block_start_depth.is_none()
                    && i + 8 <= chars.len()
                    && chars[i..i + 8] == ['#', '[', 'e', 'r', 'r', 'o', 'r', '(']
                {
                    let error_start_line = line_num;
                    let mut paren_depth = 1;
                    let mut j = i + 8;
                    let mut captured = String::new();

                    let mut attr_state = ScanState::Normal;

                    while j < chars.len() && paren_depth > 0 {
                        let ac = chars[j];
                        if ac == '\n' {
                            line_num += 1;
                        }

                        match attr_state {
                            ScanState::Normal => {
                                if ac == '"' {
                                    attr_state = ScanState::StringLiteral { escaped: false };
                                    captured.push(ac);
                                } else if ac == '(' {
                                    paren_depth += 1;
                                    captured.push(ac);
                                } else if ac == ')' {
                                    paren_depth -= 1;
                                    if paren_depth > 0 {
                                        captured.push(ac);
                                    }
                                } else {
                                    captured.push(ac);
                                }
                            }
                            ScanState::StringLiteral { escaped } => {
                                captured.push(ac);
                                if escaped {
                                    attr_state = ScanState::StringLiteral { escaped: false };
                                } else if ac == '\\' {
                                    attr_state = ScanState::StringLiteral { escaped: true };
                                } else if ac == '"' {
                                    attr_state = ScanState::Normal;
                                }
                            }
                            _ => {}
                        }
                        j += 1;
                    }

                    let captured_chars: Vec<char> = captured.chars().collect();
                    let mut k = 0;
                    let mut in_str = false;
                    let mut str_escaped = false;
                    let mut current_literal = String::new();

                    while k < captured_chars.len() {
                        let kc = captured_chars[k];
                        if in_str {
                            if str_escaped {
                                current_literal.push(kc);
                                str_escaped = false;
                            } else if kc == '\\' {
                                str_escaped = true;
                            } else if kc == '"' {
                                in_str = false;
                                let text_lower = current_literal.to_lowercase();
                                let has_umlaut = text_lower.contains('ä')
                                    || text_lower.contains('ö')
                                    || text_lower.contains('ü')
                                    || text_lower.contains('ß');
                                let has_german_word =
                                    german_words.iter().any(|&word| text_lower.contains(word));
                                if has_umlaut || has_german_word {
                                    failures.push((error_start_line, current_literal.clone()));
                                }
                                current_literal.clear();
                            } else {
                                current_literal.push(kc);
                            }
                        } else if kc == '"' {
                            in_str = true;
                            str_escaped = false;
                        }
                        k += 1;
                    }

                    i = j;
                    continue;
                }
            }
            ScanState::StringLiteral { escaped } => {
                if escaped {
                    state = ScanState::StringLiteral { escaped: false };
                } else if c == '\\' {
                    state = ScanState::StringLiteral { escaped: true };
                } else if c == '"' {
                    state = ScanState::Normal;
                }
            }
            ScanState::RawStringLiteral { hash_count } => {
                if c == '"' {
                    let mut matching = true;
                    for offset in 1..=hash_count {
                        if i + offset >= chars.len() || chars[i + offset] != '#' {
                            matching = false;
                            break;
                        }
                    }
                    if matching {
                        state = ScanState::Normal;
                        i += hash_count + 1;
                        continue;
                    }
                }
            }
            ScanState::LineComment => {
                if c == '\n' {
                    state = ScanState::Normal;
                }
            }
            ScanState::BlockComment => {
                if c == '*' && i + 1 < chars.len() && chars[i + 1] == '/' {
                    state = ScanState::Normal;
                    i += 2;
                    continue;
                }
            }
        }

        i += 1;
    }

    failures
}

#[test]
fn error_attribute_german_regression_gate() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let src_dir = manifest_dir.join("src");
    let mut failures = Vec::new();

    let mut dirs_to_visit = vec![src_dir];
    while let Some(dir) = dirs_to_visit.pop() {
        let entries = fs::read_dir(&dir)
            .unwrap_or_else(|err| panic!("Failed to read directory {}: {err}", dir.display()));
        for entry in entries {
            let entry = entry.unwrap_or_else(|err| {
                panic!("Failed to read directory entry in {}: {err}", dir.display())
            });
            let path = entry.path();
            if path.is_dir() {
                dirs_to_visit.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let content = fs::read_to_string(&path)
                    .unwrap_or_else(|err| panic!("Failed to read file {}: {err}", path.display()));
                let file_failures = find_german_errors(&content);
                if !file_failures.is_empty() {
                    let rel_path = path.strip_prefix(manifest_dir).unwrap_or(&path);
                    for (line, text) in file_failures {
                        failures.push(format!(
                            "{}:{} -> #[error(\"{}\")]",
                            rel_path.display(),
                            line,
                            text
                        ));
                    }
                }
            }
        }
    }

    if !failures.is_empty() {
        panic!(
            "German regression gate failed! Found German words or umlauts in error attributes:\n{}",
            failures.join("\n")
        );
    }
}

#[test]
fn test_detector_self_tests() {
    // 1. deutscher Einzeiler -> rot
    let fixture_single_de = r#"
        #[derive(Debug, thiserror::Error)]
        pub enum MyError {
            #[error("Fehler beim Speichern der Datei")]
            SaveFailed,
        }
    "#;
    let res = find_german_errors(fixture_single_de);
    assert!(!res.is_empty(), "Should detect German single line error");
    assert_eq!(res[0].1, "Fehler beim Speichern der Datei");

    // 2. deutscher Mehrzeiler -> rot
    let fixture_multi_de = r#"
        #[derive(Debug, thiserror::Error)]
        pub enum MyError {
            #[error(
                "Es ist ein ungueltiger Fehler aufgetreten: {0}"
            )]
            Complex(String),
        }
    "#;
    let res = find_german_errors(fixture_multi_de);
    assert!(!res.is_empty(), "Should detect German multi line error");
    assert!(res[0].1.contains("ungueltiger"));

    // 3. Text in mod tests -> ignoriert
    let fixture_in_tests = r#"
        pub enum MyError {
            #[error("Successful error")]
            Success,
        }

        #[cfg(test)]
        mod tests {
            #[test]
            fn test_dummy() {
                // Hier darf ein Fehlerattribut Deutsch enthalten
                #[derive(Debug, thiserror::Error)]
                enum TestError {
                    #[error("Fehler beim Speichern")]
                    Dummy,
                }
            }
        }
    "#;
    let res = find_german_errors(fixture_in_tests);
    assert!(
        res.is_empty(),
        "Should ignore German error inside mod tests block"
    );

    // 4. Produktionscode NACH einem geschlossenen mod tests -> wieder gescannt
    let fixture_after_tests = r#"
        #[cfg(test)]
        mod tests {
            #[test]
            fn test_dummy() {
                #[derive(Debug, thiserror::Error)]
                enum TestError {
                    #[error("Fehler beim Speichern")]
                    Dummy,
                }
            }
        }

        pub enum AnotherError {
            #[error("Ungueltige Konfiguration")]
            BadConfig,
        }
    "#;
    let res = find_german_errors(fixture_after_tests);
    assert!(
        !res.is_empty(),
        "Should detect German error in production code after closed mod tests"
    );
    assert_eq!(res[0].1, "Ungueltige Konfiguration");
}
