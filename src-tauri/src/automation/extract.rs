use axum::extract::{FromRequestParts, Query};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;

use crate::automation::error::ApiError;

/// Query-Extractor mit dem einheitlichen Automation-JSON-Fehlermodell.
pub(super) struct ApiQuery<T>(pub(super) T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Query(value) = Query::<T>::from_request_parts(parts, state)
            .await
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        Ok(Self(value))
    }
}
