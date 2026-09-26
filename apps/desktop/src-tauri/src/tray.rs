//! The tray icon: the same status the window shows (the UI sends it, from
//! the one `describe()` model), plus connect/disconnect/show/quit.
//!
//! The icon is in colour only while protected and grey otherwise, so the
//! tray never looks "on" when traffic isn't going through the tunnel.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::desktop::{self, AppAction, ACTION_EVENT};

const TRAY_ID: &str = "main";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayView {
    tone: String,
    label: String,
    can_connect: bool,
    can_disconnect: bool,
    menu: TrayMenuLabels,
}

#[derive(Debug, Deserialize)]
pub struct TrayMenuLabels {
    show: String,
    connect: String,
    disconnect: String,
    quit: String,
}

struct TrayItems {
    show: MenuItem<Wry>,
    connect: MenuItem<Wry>,
    disconnect: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    colour: Image<'static>,
    grey: Image<'static>,
    protected: Mutex<Option<bool>>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Meridian", true, None::<&str>)?;
    let connect = MenuItem::with_id(app, "connect", "Connect", false, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect", "Disconnect", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Meridian", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &PredefinedMenuItem::separator(app)?, &connect, &disconnect, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let colour = app.default_window_icon().cloned().map(Image::to_owned).ok_or_else(|| tauri::Error::AssetNotFound("app icon".into()))?;
    let grey = greyscale(&colour);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(grey.clone())
        .tooltip("Meridian")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(|tray: &TrayIcon, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                desktop::show_window(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayItems { show, connect, disconnect, quit, colour, grey, protected: Mutex::new(None) });
    Ok(())
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "show" => desktop::show_window(app),
        "connect" => {
            let _ = app.emit(ACTION_EVENT, AppAction::Connect);
        }
        "disconnect" => {
            let _ = app.emit(ACTION_EVENT, AppAction::Disconnect);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn update(app: &AppHandle, view: &TrayView) -> tauri::Result<()> {
    let items = app.state::<TrayItems>();
    items.show.set_text(&view.menu.show)?;
    items.connect.set_text(&view.menu.connect)?;
    items.disconnect.set_text(&view.menu.disconnect)?;
    items.quit.set_text(&view.menu.quit)?;
    items.connect.set_enabled(view.can_connect)?;
    items.disconnect.set_enabled(view.can_disconnect)?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(format!("Meridian: {}", view.label)))?;
        // "success" is the one tone describe() gives a verified tunnel.
        let protected = view.tone == "success";
        let mut last = items.protected.lock().expect("tray");
        if *last != Some(protected) {
            tray.set_icon(Some(if protected { items.colour.clone() } else { items.grey.clone() }))?;
            *last = Some(protected);
        }
    }
    Ok(())
}

fn greyscale(icon: &Image<'_>) -> Image<'static> {
    let mut rgba = icon.rgba().to_vec();
    for px in rgba.chunks_exact_mut(4) {
        let luma = (0.299 * f32::from(px[0]) + 0.587 * f32::from(px[1]) + 0.114 * f32::from(px[2])) as u8;
        // Lifted a little so it stays legible on dark taskbars.
        let v = luma / 2 + 96;
        px[0] = v;
        px[1] = v;
        px[2] = v;
    }
    Image::new_owned(rgba, icon.width(), icon.height())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greyscale_keeps_alpha_and_size() {
        let icon = Image::new_owned(vec![255, 0, 0, 200, 0, 0, 255, 0], 2, 1);
        let grey = greyscale(&icon);
        assert_eq!((grey.width(), grey.height()), (2, 1));
        let px = grey.rgba();
        assert_eq!(px[3], 200);
        assert_eq!(px[7], 0);
        assert!(px[0] == px[1] && px[1] == px[2]);
    }
}
