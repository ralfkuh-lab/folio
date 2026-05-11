use axum::response::IntoResponse;
use std::io::Cursor;

use crate::automation::error::{ApiError, ApiResult};

pub(in crate::automation) async fn get_screenshot() -> ApiResult<impl IntoResponse> {
    let bytes = tauri::async_runtime::spawn_blocking(capture_png)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))??;
    Ok(([(axum::http::header::CONTENT_TYPE, "image/png")], bytes))
}

fn capture_png() -> ApiResult<Vec<u8>> {
    let image = xcap::Window::all()
        .map_err(|error| ApiError::internal(error.to_string()))?
        .into_iter()
        .find(|window| {
            window
                .title()
                .is_ok_and(|title| title == "Folio" || title.ends_with("— Folio"))
        })
        .ok_or_else(|| ApiError::internal("Folio window not found"))?
        .capture_image()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let mut cursor = Cursor::new(Vec::new());
    xcap::image::DynamicImage::ImageRgba8(image)
        .write_to(&mut cursor, xcap::image::ImageFormat::Png)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(cursor.into_inner())
}
