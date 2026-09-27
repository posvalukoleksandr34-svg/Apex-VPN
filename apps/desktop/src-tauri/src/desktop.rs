//! Window, tray, notifications, autostart, files and the global shortcut:
//! everything the UI needs from the desktop, each input checked here.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::error::{CoreError, CoreResult};
use crate::tray::{self, TrayView};

pub const MAIN_WINDOW: &str = "main";
pub const ACTION_EVENT: &str = "app://action";

pub struct DesktopState {
    close_to_tray: AtomicBool,
    shortcut: Mutex<Option<Shortcut>>,
    /// Files the user chose in the picker; the only ones a ticket may attach.
    picked: Mutex<HashSet<PathBuf>>,
}

impl Default for DesktopState {
    fn default() -> Self {
        // Matches the UI's default; the UI sends its saved preference at start.
        Self { close_to_tray: AtomicBool::new(true), shortcut: Mutex::new(None), picked: Mutex::new(HashSet::new()) }
    }
}

impl DesktopState {
    pub fn was_picked(&self, path: &Path) -> bool {
        self.picked.lock().expect("picked").contains(path)
    }
}

pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let frontmost = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false);
        if frontmost {
            let _ = w.hide();
        } else {
            show_window(app);
        }
    }
}

/// Closing the window keeps the app (and its tray) running when the user
/// chose that; the VPN itself runs in the service either way.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN_WINDOW && window.state::<DesktopState>().close_to_tray.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[derive(Serialize)]
pub struct AppInfo {
    platform: &'static str,
    version: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let platform = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    };
    AppInfo { platform, version: app.package_info().version.to_string() }
}

#[derive(Serialize)]
pub struct InstalledApp {
    name: String,
    path: String,
}

#[tauri::command]
pub async fn app_installed_apps() -> CoreResult<Vec<InstalledApp>> {
    let apps = tokio::task::spawn_blocking(vpn_platform::apps::installed).await.map_err(|e| CoreError::internal(e.to_string()))?;
    Ok(apps.into_iter().map(|a| InstalledApp { name: a.name, path: a.path }).collect())
}

#[tauri::command]
pub fn app_notify(app: AppHandle, title: String, body: String) -> CoreResult<()> {
    app.notification().builder().title(title).body(body).show().map_err(|e| CoreError::internal(e.to_string()))
}

#[tauri::command]
pub fn app_get_autostart(app: AppHandle) -> CoreResult<bool> {
    app.autolaunch().is_enabled().map_err(|e| CoreError::internal(e.to_string()))
}

#[tauri::command]
pub fn app_set_autostart(app: AppHandle, on: bool) -> CoreResult<()> {
    let launcher = app.autolaunch();
    if on { launcher.enable() } else { launcher.disable() }.map_err(|e| CoreError::internal(e.to_string()))
}

/// Links from the UI (help pages, checkout) open in the user's browser.
#[tauri::command]
pub fn app_open_external(app: AppHandle, url: String) -> CoreResult<()> {
    if !external_url_allowed(&url) {
        return Err(CoreError::rejected("only https and mailto links can be opened"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| CoreError::internal(e.to_string()))
}

fn external_url_allowed(url: &str) -> bool {
    match reqwest::Url::parse(url) {
        Ok(u) => (u.scheme() == "https" && u.host_str().is_some()) || u.scheme() == "mailto",
        Err(_) => false,
    }
}

/// Asks where to save, then writes. `false` when the user cancelled.
#[tauri::command]
pub async fn app_save_text_file(app: AppHandle, default_name: String, contents: String) -> CoreResult<bool> {
    let (tx, rx) = oneshot::channel();
    let name: String = default_name.chars().filter(|c| !r#"\/:*?"<>|"#.contains(*c)).take(120).collect();
    app.dialog().file().set_file_name(if name.is_empty() { "apexy.txt".into() } else { name }).save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.ok().flatten() else { return Ok(false) };
    let path = path.into_path().map_err(|e| CoreError::internal(e.to_string()))?;
    tokio::fs::write(&path, contents).await.map_err(|e| CoreError::internal(format!("could not save {}: {e}", path.display())))?;
    Ok(true)
}

#[derive(Serialize)]
pub struct PickedFile {
    name: String,
    path: String,
    size: u64,
}

#[tauri::command]
pub async fn app_pick_files(app: AppHandle, desktop: State<'_, DesktopState>) -> CoreResult<Vec<PickedFile>> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().add_filter("Attachments", &["png", "jpg", "jpeg", "txt", "log", "json", "zip", "pdf"]).pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let Some(paths) = rx.await.ok().flatten() else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for p in paths {
        let Ok(path) = p.into_path() else { continue };
        let Ok(meta) = tokio::fs::metadata(&path).await else { continue };
        if !meta.is_file() {
            continue;
        }
        desktop.picked.lock().expect("picked").insert(path.clone());
        out.push(PickedFile {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn app_set_tray(app: AppHandle, view: TrayView) -> CoreResult<()> {
    tray::update(&app, &view).map_err(|e| CoreError::internal(e.to_string()))
}

#[tauri::command]
pub fn app_set_close_to_tray(desktop: State<'_, DesktopState>, on: bool) {
    desktop.close_to_tray.store(on, Ordering::Relaxed);
}

#[tauri::command]
pub fn app_hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// Registers the system-wide show/hide shortcut. `false` when it can't be
/// parsed or another application already owns it.
#[tauri::command]
pub fn app_set_global_shortcut(app: AppHandle, desktop: State<'_, DesktopState>, accelerator: Option<String>) -> bool {
    let shortcuts = app.global_shortcut();
    let mut current = desktop.shortcut.lock().expect("shortcut");
    if let Some(previous) = current.take() {
        let _ = shortcuts.unregister(previous);
    }
    let Some(accelerator) = accelerator.filter(|a| !a.trim().is_empty()) else { return true };
    let Ok(shortcut) = accelerator.parse::<Shortcut>() else {
        tracing::warn!("not a valid shortcut: {accelerator}");
        return false;
    };
    match shortcuts.on_shortcut(shortcut, |app, _, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_window(app);
        }
    }) {
        Ok(()) => {
            *current = Some(shortcut);
            true
        }
        Err(e) => {
            tracing::info!("shortcut {accelerator} is unavailable: {e}");
            false
        }
    }
}

/// Tray menu actions the UI performs ("connect", "disconnect").
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppAction {
    Connect,
    Disconnect,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links() {
        assert!(external_url_allowed("https://apexy.example/help"));
        assert!(external_url_allowed("mailto:support@apexy.example"));
        for bad in ["http://apexy.example", "file:///C:/Windows/system32/calc.exe", "javascript:alert(1)", "ms-settings:network", "https://", "not a url"] {
            assert!(!external_url_allowed(bad), "{bad}");
        }
    }
}
