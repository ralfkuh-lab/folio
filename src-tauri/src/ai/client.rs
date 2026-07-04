//! OpenAI-kompatibler, nicht-streamender Chat-Client.

use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use thiserror::Error;

const CHAT_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_PROVIDER_ERROR_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".to_string(),
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".to_string(),
            content: content.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ChatError {
    #[error("Ungültige Provider-Basis-URL: {0}")]
    InvalidBaseUrl(String),
    #[error("Provider-Basis-URL muss eine HTTP(S)-URL sein")]
    UnsupportedUrl,
    #[error("KI-Anfrage fehlgeschlagen: {0}")]
    Request(String),
    #[error("KI-Antwort konnte nicht gelesen werden: {0}")]
    ResponseRead(String),
    #[error("KI-Provider antwortete mit HTTP-Status {status}: {message}")]
    Http { status: StatusCode, message: String },
    #[error("KI-Antwort enthält ungültiges JSON: {0}")]
    InvalidJson(String),
    #[error("KI-Antwort enthält keine Text-Antwort in choices[0]")]
    MissingChoice,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: String,
}

pub async fn chat(
    http: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[ChatMessage],
) -> Result<String, ChatError> {
    let endpoint = chat_url(base_url)?;
    let api_key = api_key.map(str::trim).filter(|key| !key.is_empty());
    let mut request = http
        .post(endpoint)
        .timeout(CHAT_TIMEOUT)
        .json(&ChatRequest { model, messages });
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|error| ChatError::Request(error.to_string()))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| ChatError::ResponseRead(error.to_string()))?;
    if !status.is_success() {
        return Err(ChatError::Http {
            status,
            message: provider_error_message(&body, api_key),
        });
    }
    parse_chat_response(&body)
}

pub(crate) fn chat_url(base_url: &str) -> Result<Url, ChatError> {
    let mut url = Url::parse(base_url.trim())
        .map_err(|error| ChatError::InvalidBaseUrl(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(ChatError::UnsupportedUrl);
    }
    let path = url.path().trim_end_matches('/').to_string();
    if !path.ends_with("/chat/completions") {
        url.set_path(&format!("{path}/chat/completions"));
    } else {
        url.set_path(&path);
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn parse_chat_response(body: &str) -> Result<String, ChatError> {
    let response = serde_json::from_str::<ChatResponse>(body)
        .map_err(|error| ChatError::InvalidJson(error.to_string()))?;
    response
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
        .filter(|content| !content.trim().is_empty())
        .ok_or(ChatError::MissingChoice)
}

fn provider_error_message(body: &str, api_key: Option<&str>) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/message").and_then(Value::as_str))
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|value| value.get("message").and_then(Value::as_str))
        })
        .unwrap_or(body);
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = match api_key.filter(|key| !key.is_empty()) {
        Some(key) => compact.replace(key, "[REDACTED]"),
        None => compact,
    };
    let shortened = redacted
        .chars()
        .take(MAX_PROVIDER_ERROR_CHARS)
        .collect::<String>();
    if shortened.is_empty() {
        "keine Fehlermeldung".to_string()
    } else {
        shortened
    }
}

pub fn translation_system_prompt(language: &str) -> String {
    let normalized = language.trim().to_ascii_lowercase();
    let name = match normalized.as_str() {
        "en" => "English",
        "de" => "German",
        "fr" => "French",
        "es" => "Spanish",
        "it" => "Italian",
        "pt" => "Portuguese",
        "nl" => "Dutch",
        "pl" => "Polish",
        "ja" => "Japanese",
        "zh" => "Chinese",
        _ => language.trim(),
    };
    format!(
        "Translate the complete Markdown document into the target language \
{language} ({name}). Preserve the exact Markdown structure and formatting. \
Keep all frontmatter including its delimiters and contents, fenced code blocks \
including their fences and contents, \
inline code, URLs, image paths, and HTML tags unchanged. Do not omit or summarize \
any content. Return only the translated Markdown document, with no explanation \
and without wrapping the document in an additional code fence.",
        language = language.trim(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_url_appends_path_once_and_strips_url_extras() {
        assert_eq!(
            "http://localhost:11434/v1/chat/completions",
            chat_url("http://localhost:11434/v1").unwrap().as_str()
        );
        assert_eq!(
            "https://example.test/v1/chat/completions",
            chat_url("https://example.test/v1/chat/completions/?token=ignored#fragment")
                .unwrap()
                .as_str()
        );
        assert!(chat_url("file:///tmp/provider").is_err());
    }

    #[test]
    fn request_payload_uses_openai_shape() {
        let messages = vec![ChatMessage::system("rules"), ChatMessage::user("document")];
        let value = serde_json::to_value(ChatRequest {
            model: "test-model",
            messages: &messages,
        })
        .unwrap();
        assert_eq!("test-model", value["model"]);
        assert_eq!("system", value["messages"][0]["role"]);
        assert_eq!("document", value["messages"][1]["content"]);
        assert!(value.get("stream").is_none());
    }

    #[test]
    fn response_parser_reads_first_choice() {
        let body = r##"{"choices":[{"message":{"role":"assistant","content":"# Übersetzt"}},{"message":{"content":"ignored"}}]}"##;
        assert_eq!("# Übersetzt", parse_chat_response(body).unwrap());
    }

    #[test]
    fn response_parser_rejects_broken_json_and_empty_choices() {
        assert!(matches!(
            parse_chat_response("{broken"),
            Err(ChatError::InvalidJson(_))
        ));
        assert!(matches!(
            parse_chat_response(r#"{"choices":[]}"#),
            Err(ChatError::MissingChoice)
        ));
        assert!(matches!(
            parse_chat_response(r#"{"choices":[{"message":{"content":"  "}}]}"#),
            Err(ChatError::MissingChoice)
        ));
    }

    #[test]
    fn provider_errors_are_compact_bounded_and_redact_keys() {
        let key = "top-secret";
        let body = format!(
            r#"{{"error":{{"message":"failed with {key} {}"}}}}"#,
            "x".repeat(400)
        );
        let message = provider_error_message(&body, Some(key));
        assert!(!message.contains(key));
        assert!(message.contains("[REDACTED]"));
        assert!(message.chars().count() <= MAX_PROVIDER_ERROR_CHARS);
        assert!(!message.contains('\n'));
    }

    #[test]
    fn translation_prompt_contains_all_preservation_rules() {
        let prompt = translation_system_prompt("de");
        for required in [
            "de (German)",
            "complete Markdown document",
            "Markdown structure",
            "frontmatter",
            "fenced code blocks",
            "inline code",
            "URLs",
            "image paths",
            "HTML tags",
            "only the translated Markdown document",
            "without wrapping",
        ] {
            assert!(prompt.contains(required), "missing {required}: {prompt}");
        }
        assert!(translation_system_prompt("x-test").contains("x-test (x-test)"));
    }
}
