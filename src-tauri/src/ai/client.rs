//! OpenAI-kompatibler Chat-Client mit SSE-Streaming und JSON-Fallback.

use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use thiserror::Error;

const CHAT_TIMEOUT: Duration = Duration::from_secs(300);
const STREAM_CHUNK_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);
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
    #[error("invalid provider base URL: {0}")]
    InvalidBaseUrl(String),
    #[error("provider base URL must be an HTTP(S) URL")]
    UnsupportedUrl,
    #[error("{0}")]
    Request(String),
    #[error("could not read provider response: {0}")]
    ResponseRead(String),
    #[error("provider returned HTTP {status}: {message}")]
    Http { status: StatusCode, message: String },
    #[error("provider response contains invalid JSON: {0}")]
    InvalidJson(String),
    #[error("provider response has no text in choices[0]")]
    MissingChoice,
    #[error("request cancelled")]
    Cancelled,
    #[error(
        "provider response was truncated at the model output limit \
         (finish_reason=length)"
    )]
    TruncatedOutput,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatStreamResponse {
    choices: Vec<ChatStreamChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatStreamChoice {
    delta: ChatStreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatStreamDelta {
    content: Option<String>,
}

#[derive(Debug, Default)]
struct SseDecoder {
    buffer: Vec<u8>,
    data_lines: Vec<String>,
}

impl SseDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, ChatError> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();

        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = std::str::from_utf8(&line)
                .map_err(|error| ChatError::InvalidJson(error.to_string()))?;
            if line.is_empty() {
                if !self.data_lines.is_empty() {
                    events.push(self.data_lines.join("\n"));
                    self.data_lines.clear();
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data_lines
                    .push(data.strip_prefix(' ').unwrap_or(data).to_string());
            }
        }

        Ok(events)
    }
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
        .json(&ChatRequest {
            model,
            messages,
            stream: false,
        });
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

pub async fn chat_stream(
    http: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[ChatMessage],
    on_delta: impl FnMut(&str),
) -> Result<String, ChatError> {
    chat_stream_cancellable(http, base_url, api_key, model, messages, on_delta, || false).await
}

pub async fn chat_stream_cancellable(
    http: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[ChatMessage],
    mut on_delta: impl FnMut(&str),
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<String, ChatError> {
    let endpoint = chat_url(base_url)?;
    let api_key = api_key.map(str::trim).filter(|key| !key.is_empty());
    let mut request = http.post(endpoint).json(&ChatRequest {
        model,
        messages,
        stream: true,
    });
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|error| ChatError::Request(error.to_string()))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|error| ChatError::ResponseRead(error.to_string()))?;
        return Err(ChatError::Http {
            status,
            message: provider_error_message(&body, api_key),
        });
    }

    if !content_type.starts_with("text/event-stream") {
        let body = response
            .text()
            .await
            .map_err(|error| ChatError::ResponseRead(error.to_string()))?;
        let translated = parse_chat_response(&body)?;
        on_delta(&translated);
        return Ok(translated);
    }

    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut accumulated = String::new();
    let mut chunk_wait_started = Instant::now();
    loop {
        if is_cancelled() {
            return Err(ChatError::Cancelled);
        }
        let elapsed = chunk_wait_started.elapsed();
        if elapsed >= STREAM_CHUNK_TIMEOUT {
            return Err(ChatError::ResponseRead(
                "Zeitüberschreitung beim Warten auf den nächsten Stream-Chunk".to_string(),
            ));
        }
        let wait = CANCEL_POLL_INTERVAL.min(STREAM_CHUNK_TIMEOUT - elapsed);
        let next = match tokio::time::timeout(wait, stream.next()).await {
            Ok(next) => next,
            Err(_) => continue,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|error| ChatError::ResponseRead(error.to_string()))?;
        chunk_wait_started = Instant::now();
        for event in decoder.push(&chunk)? {
            if is_cancelled() {
                return Err(ChatError::Cancelled);
            }
            if event.trim() == "[DONE]" {
                return finish_stream(accumulated);
            }
            if let Some(message) = stream_error_message(&event, api_key) {
                return Err(ChatError::Http {
                    status: StatusCode::BAD_GATEWAY,
                    message,
                });
            }
            let response = serde_json::from_str::<ChatStreamResponse>(&event)
                .map_err(|error| ChatError::InvalidJson(error.to_string()))?;
            if let Some(choice) = response.choices.into_iter().next() {
                if let Some(content) = choice.delta.content {
                    accumulated.push_str(&content);
                    on_delta(&accumulated);
                }
                // Provider melden ein abgeschnittenes Output-Limit nicht als
                // Fehler, sondern nur über finish_reason — ohne diesen Check
                // landete eine still gekürzte Übersetzung als Datei, sofern im
                // fehlenden Teil kein Masking-Token lag.
                if choice.finish_reason.as_deref() == Some("length") {
                    return Err(ChatError::TruncatedOutput);
                }
            }
        }
    }
    finish_stream(accumulated)
}

fn finish_stream(accumulated: String) -> Result<String, ChatError> {
    if accumulated.trim().is_empty() {
        Err(ChatError::MissingChoice)
    } else {
        Ok(accumulated)
    }
}

fn stream_error_message(body: &str, api_key: Option<&str>) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()
        .filter(|value| value.get("error").is_some())
        .map(|_| provider_error_message(body, api_key))
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
    let choice = response
        .choices
        .into_iter()
        .next()
        .ok_or(ChatError::MissingChoice)?;
    if choice.finish_reason.as_deref() == Some("length") {
        return Err(ChatError::TruncatedOutput);
    }
    Some(choice.message.content)
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
any content. The document contains opaque placeholder tokens of the form \
`⟦F…:N⟧`. Copy every such token verbatim into the output at the same position. \
Never translate, modify, reorder, remove, or add whitespace inside these tokens. \
Return only the translated Markdown document, with no explanation and without \
wrapping the document in an additional code fence.",
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
            stream: false,
        })
        .unwrap();
        assert_eq!("test-model", value["model"]);
        assert_eq!("system", value["messages"][0]["role"]);
        assert_eq!("document", value["messages"][1]["content"]);
        assert!(value.get("stream").is_none());
    }

    #[test]
    fn request_payload_serializes_stream_only_when_enabled() {
        let messages = vec![ChatMessage::user("document")];
        let value = serde_json::to_value(ChatRequest {
            model: "test-model",
            messages: &messages,
            stream: true,
        })
        .unwrap();
        assert_eq!(Some(true), value["stream"].as_bool());
    }

    #[test]
    fn sse_decoder_handles_chunk_boundaries_crlf_and_done() {
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();
        for chunk in [
            &b"data: {\"choices\":[{\"delta\":{\"content\":\"Bon"[..],
            &b"jour\"}}]}\r"[..],
            &b"\n\r\ndata: [DO"[..],
            &b"NE]\n\n"[..],
        ] {
            events.extend(decoder.push(chunk).unwrap());
        }
        assert_eq!(
            vec![r#"{"choices":[{"delta":{"content":"Bonjour"}}]}"#, "[DONE]"],
            events
        );
    }

    #[test]
    fn sse_error_event_becomes_redacted_provider_error() {
        let event = r#"{"error":{"message":"bad secret"}}"#;
        assert_eq!(
            Some("bad [REDACTED]".to_string()),
            stream_error_message(event, Some("secret"))
        );
    }

    #[tokio::test]
    async fn streaming_client_falls_back_to_json_response() {
        use axum::{routing::post, Json, Router};

        let app = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                Json(serde_json::json!({
                    "choices": [{"message": {"content": "Fallback"}}]
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut deltas = Vec::new();
        let result = chat_stream(
            &Client::new(),
            &format!("http://{address}/v1"),
            None,
            "test-model",
            &[ChatMessage::user("document")],
            |delta| deltas.push(delta.to_string()),
        )
        .await
        .unwrap();
        server.abort();

        assert_eq!("Fallback", result);
        assert_eq!(vec!["Fallback"], deltas);
    }

    #[tokio::test]
    async fn streaming_client_rejects_length_truncated_stream() {
        use axum::{http::header, routing::post, Router};

        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Anfang\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || async move { ([(header::CONTENT_TYPE, "text/event-stream")], body) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let result = chat_stream(
            &Client::new(),
            &format!("http://{address}/v1"),
            None,
            "test-model",
            &[ChatMessage::user("document")],
            |_| {},
        )
        .await;
        server.abort();

        assert!(matches!(result, Err(ChatError::TruncatedOutput)));
    }

    #[test]
    fn response_parser_rejects_length_truncated_output() {
        assert!(matches!(
            parse_chat_response(
                r#"{"choices":[{"message":{"content":"Halb"},"finish_reason":"length"}]}"#
            ),
            Err(ChatError::TruncatedOutput)
        ));
        assert_eq!(
            "Ganz",
            parse_chat_response(
                r#"{"choices":[{"message":{"content":"Ganz"},"finish_reason":"stop"}]}"#
            )
            .unwrap()
        );
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
            "⟦F…:N⟧",
            "Copy every such token verbatim",
            "only the translated Markdown document",
            "without wrapping",
        ] {
            assert!(prompt.contains(required), "missing {required}: {prompt}");
        }
        assert!(translation_system_prompt("x-test").contains("x-test (x-test)"));
    }
}
