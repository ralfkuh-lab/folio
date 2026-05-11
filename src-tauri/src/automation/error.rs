use axum::{
    extract::{rejection::JsonRejection, Json},
    http::StatusCode,
    response::{IntoResponse, Response},
};

use super::types::{ErrorResponse, OkResponse};

#[derive(Debug)]
pub(super) struct ApiError {
    pub(super) status: StatusCode,
    pub(super) message: String,
}

pub(super) type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub(super) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    pub(super) fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    pub(super) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    pub(super) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response()
    }
}

pub(super) fn ok() -> ApiResult<Json<OkResponse>> {
    Ok(Json(OkResponse { ok: true }))
}

pub(super) fn json_payload<T>(payload: Result<Json<T>, JsonRejection>) -> ApiResult<Json<T>> {
    payload.map_err(|error| ApiError::bad_request(error.to_string()))
}
