//! Helpers zum strenger-typisierten Auspacken der `serde_json::Value`-
//! Payloads, die vom Frontend via `shell:event`/`editor:event` kommen.

use serde_json::Value;

pub(super) fn payload_type(payload: &Value) -> Result<&str, String> {
    payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "event payload missing string field: type".to_string())
}

pub(super) fn string_field(payload: &Value, field: &str) -> Result<String, String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("event payload missing string field: {field}"))
}

pub(super) fn number_field(payload: &Value, field: &str) -> Result<f64, String> {
    payload
        .get(field)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("event payload missing number field: {field}"))
}

pub(super) fn bool_field(payload: &Value, field: &str) -> Result<bool, String> {
    payload
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("event payload missing bool field: {field}"))
}

pub(super) fn usize_field(payload: &Value, field: &str) -> Result<usize, String> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("event payload missing unsigned integer field: {field}"))
}
