use tauri::AppHandle;

#[derive(Clone)]
pub(super) struct AutomationContext {
    pub(super) app_handle: AppHandle,
}
