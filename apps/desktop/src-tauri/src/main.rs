//! Meridian desktop app. The UI is a WebView; this is its Rust core:
//!
//! * `service`: the IPC connection to `meridiand` (the privileged service
//!   that owns the tunnel, kill switch and DNS);
//! * `account`: the account session, tokens in the OS credential store;
//! * `desktop` / `tray`: window, tray, notifications, autostart, files.
//!
//! The app itself runs unprivileged and holds no VPN state: closing it never
//! changes the connection.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod account;
mod desktop;
mod error;
mod service;
mod tray;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

use crate::account::AccountManager;
use crate::desktop::{DesktopState, MAIN_WINDOW};
use crate::service::ServiceBridge;

/// Passed by the autostart entry: start in the tray, window hidden.
const MINIMIZED_FLAG: &str = "--minimized";

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let start_minimized = std::env::args().any(|a| a == MINIMIZED_FLAG);

    tauri::Builder::default()
        // First, so a second launch just brings this window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_FLAG])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            let endpoint_file = app.path().app_local_data_dir().ok().map(|d| d.join("api-endpoint"));
            let bridge = Arc::new(ServiceBridge::new(endpoint_file));
            app.manage(bridge.clone());
            app.manage(Arc::new(AccountManager::new(app.handle().clone(), bridge.clone())));
            app.manage(DesktopState::default());
            tray::create(app.handle())?;
            tauri::async_runtime::spawn(bridge.run(app.handle().clone()));
            if !start_minimized {
                if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                    w.show()?;
                }
            }
            Ok(())
        })
        .on_window_event(desktop::on_window_event)
        .invoke_handler(tauri::generate_handler![
            service::service_request,
            service::service_status,
            service::service_reconnect,
            account::account_session,
            account::account_register,
            account::account_verify_email,
            account::account_resend_verification,
            account::account_login,
            account::account_login_mfa,
            account::account_logout,
            account::account_forgot_password,
            account::account_reset_password,
            account::account_request,
            account::account_enroll_device,
            account::support_create_ticket,
            desktop::app_info,
            desktop::app_installed_apps,
            desktop::app_notify,
            desktop::app_get_autostart,
            desktop::app_set_autostart,
            desktop::app_open_external,
            desktop::app_save_text_file,
            desktop::app_pick_files,
            desktop::app_set_tray,
            desktop::app_set_close_to_tray,
            desktop::app_hide_window,
            desktop::app_quit,
            desktop::app_set_global_shortcut,
        ])
        .run(tauri::generate_context!())
        .expect("Meridian failed to start");
}
