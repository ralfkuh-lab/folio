use super::types::Catalog;
use crate::persist;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

const CATALOG_URL: &str = "https://models.dev/api.json";
const SNAPSHOT_JSON: &str = include_str!("models-dev-snapshot.json");

/// Stand des eingebetteten Snapshots. Beim Aktualisieren von
/// `models-dev-snapshot.json` muss dieses Datum manuell mitgezogen werden.
pub const SNAPSHOT_DATE: &str = "2026-07-04";
const SNAPSHOT_UNIX_TIMESTAMP: u64 = date_to_unix_timestamp(SNAPSHOT_DATE);

static SNAPSHOT: OnceLock<Catalog> = OnceLock::new();

const fn date_to_unix_timestamp(date: &str) -> u64 {
    let bytes = date.as_bytes();
    let year =
        digit(bytes[0]) * 1000 + digit(bytes[1]) * 100 + digit(bytes[2]) * 10 + digit(bytes[3]);
    let month = digit(bytes[5]) * 10 + digit(bytes[6]);
    let day = digit(bytes[8]) * 10 + digit(bytes[9]);

    let mut days = 0;
    let mut current_year = 1970;
    while current_year < year {
        days += if is_leap_year(current_year) { 366 } else { 365 };
        current_year += 1;
    }
    let mut current_month = 1;
    while current_month < month {
        days += days_in_month(year, current_month);
        current_month += 1;
    }
    (days + day - 1) as u64 * 86_400
}

const fn digit(byte: u8) -> i32 {
    (byte - b'0') as i32
}

const fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

const fn days_in_month(year: i32, month: i32) -> i32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Snapshot,
    Cache,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResult {
    pub catalog: Catalog,
    pub source: CatalogSource,
    /// Snapshot-Datum (`YYYY-MM-DD`) oder Unix-Zeitstempel des Refreshs.
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCache {
    fetched_at: u64,
    catalog: Catalog,
}

#[derive(Debug, Error)]
pub enum CatalogError {
    #[error("could not load models.dev catalog: {0}")]
    Request(#[source] reqwest::Error),
    #[error("models.dev responded with HTTP status {0}")]
    HttpStatus(reqwest::StatusCode),
    #[error("models.dev catalog contains invalid JSON: {0}")]
    Parse(#[source] reqwest::Error),
    #[error("could not write catalog cache: {0}")]
    Persist(#[source] io::Error),
    #[error("system time is before the Unix epoch")]
    InvalidSystemTime,
}

pub fn load() -> CatalogResult {
    load_from(persist::config_file("ai-catalog.json"))
}

fn snapshot() -> &'static Catalog {
    SNAPSHOT.get_or_init(|| {
        serde_json::from_str(SNAPSHOT_JSON)
            .expect("embedded models.dev snapshot must contain valid catalog JSON")
    })
}

fn snapshot_result() -> CatalogResult {
    CatalogResult {
        catalog: snapshot().clone(),
        source: CatalogSource::Snapshot,
        updated_at: SNAPSHOT_DATE.to_string(),
    }
}

fn load_from(path: PathBuf) -> CatalogResult {
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<CatalogCache>(&text) {
            Ok(cache) if cache.fetched_at > SNAPSHOT_UNIX_TIMESTAMP => CatalogResult {
                catalog: cache.catalog,
                source: CatalogSource::Cache,
                updated_at: cache.fetched_at.to_string(),
            },
            Ok(_) => snapshot_result(),
            Err(error) => {
                tracing::warn!(
                    target: "folio::ai",
                    path = %path.display(),
                    %error,
                    "invalid AI catalog cache; using embedded snapshot"
                );
                snapshot_result()
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => snapshot_result(),
        Err(error) => {
            tracing::warn!(
                target: "folio::ai",
                path = %path.display(),
                %error,
                "AI catalog cache could not be read; using embedded snapshot"
            );
            snapshot_result()
        }
    }
}

pub async fn refresh(client: &Client) -> Result<CatalogResult, CatalogError> {
    refresh_to(client, &persist::config_file("ai-catalog.json")).await
}

async fn refresh_to(client: &Client, path: &Path) -> Result<CatalogResult, CatalogError> {
    let response = client
        .get(CATALOG_URL)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(CatalogError::Request)?;
    let status = response.status();
    if !status.is_success() {
        return Err(CatalogError::HttpStatus(status));
    }
    // Deserialisieren in die reduzierten Typen verwirft unbekannte Felder;
    // der anschliessende Write enthaelt damit nur den folio-relevanten Stand.
    let catalog = response
        .json::<Catalog>()
        .await
        .map_err(CatalogError::Parse)?;
    let fetched_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CatalogError::InvalidSystemTime)?
        .as_secs();
    let cache = CatalogCache {
        fetched_at,
        catalog: catalog.clone(),
    };
    persist::save_json_atomic(path, &cache).map_err(CatalogError::Persist)?;
    Ok(CatalogResult {
        catalog,
        source: CatalogSource::Cache,
        updated_at: fetched_at.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::types::CatalogProvider;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn minimal_catalog() -> Catalog {
        BTreeMap::from([(
            "test".to_string(),
            CatalogProvider {
                id: "test".to_string(),
                name: None,
                env: None,
                api: None,
                doc: None,
                models: BTreeMap::new(),
            },
        )])
    }

    #[test]
    fn embedded_snapshot_parses_and_contains_known_providers() {
        let catalog: Catalog = serde_json::from_str(SNAPSHOT_JSON).unwrap();
        assert!(catalog.len() > 100);
        assert!(catalog.contains_key("anthropic"));
        assert!(catalog.contains_key("openai"));
    }

    #[test]
    fn snapshot_date_drives_cache_comparison_timestamp() {
        assert_eq!(1_783_123_200, SNAPSHOT_UNIX_TIMESTAMP);
    }

    #[test]
    fn newer_cache_wins_over_snapshot() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("ai-catalog.json");
        persist::save_json_atomic(
            &path,
            &CatalogCache {
                fetched_at: SNAPSHOT_UNIX_TIMESTAMP + 1,
                catalog: minimal_catalog(),
            },
        )
        .unwrap();

        let loaded = load_from(path);
        assert_eq!(CatalogSource::Cache, loaded.source);
        assert_eq!(
            vec!["test"],
            loaded
                .catalog
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn broken_cache_falls_back_to_snapshot() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("ai-catalog.json");
        fs::write(&path, "{broken").unwrap();

        let loaded = load_from(path);
        assert_eq!(CatalogSource::Snapshot, loaded.source);
        assert!(loaded.catalog.len() > 100);
    }
}
