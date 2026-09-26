/// Every command the WebView may invoke. Listing them makes Tauri generate
/// an `allow-*` permission per command, so the capability file
/// (`capabilities/default.json`) is the complete, reviewable surface.
const COMMANDS: &[&str] = &[
    "service_request",
    "service_status",
    "service_reconnect",
    "account_session",
    "account_register",
    "account_verify_email",
    "account_resend_verification",
    "account_login",
    "account_login_mfa",
    "account_logout",
    "account_forgot_password",
    "account_reset_password",
    "account_request",
    "account_enroll_device",
    "support_create_ticket",
    "app_info",
    "app_installed_apps",
    "app_notify",
    "app_get_autostart",
    "app_set_autostart",
    "app_open_external",
    "app_save_text_file",
    "app_pick_files",
    "app_set_tray",
    "app_set_close_to_tray",
    "app_hide_window",
    "app_quit",
    "app_set_global_shortcut",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build step");
}
