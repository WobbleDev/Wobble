//! The Tauri shell (E01): one `api_request` command that forwards a request to the Rust
//! core's `handle()`, plus the window that loads the static SPA.
//!
//! Prevents an additional console window on Windows in release, DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod quit;
mod remembered_window;

use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use quit::{QuitGate, QuitHost, ANSWER_TIMEOUT, QUIT_REQUESTED_EVENT};
use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tauri_plugin_window_state::StateFlags;
use wobble_core::handle::{App, Request, Response};
use wobble_core::id::RandomId;

struct WindowRestoration {
    applied: AtomicBool,
    snapshot: Option<remembered_window::RememberedWindow>,
}

fn remembered_window_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN
}

/// Runs one API request through the core and returns its response.
///
/// `rusqlite::Connection` is `Send` but not `Sync`, so `App` is not `Sync`; the `Mutex`
/// is what lets `tauri::State` hold it, and it is also the serialization point every
/// request goes through — the same single-connection model the Node handlers had.
#[tauri::command]
fn api_request(
    app: tauri::State<'_, Mutex<App>>,
    window: tauri::WebviewWindow,
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Response {
    let request = Request {
        method,
        path,
        query,
        headers,
        body,
    };

    let app = app
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let response = app.handle(&request, &RandomId);
    let restoration_state = window.state::<WindowRestoration>();
    let restoration = restoration_state.inner();
    if !restoration.applied.load(Ordering::Acquire) {
        if let Ok(Some(remember)) = app.unlocked_window_preference() {
            if !restoration.applied.swap(true, Ordering::AcqRel)
                && remember
                && restoration
                    .snapshot
                    .as_ref()
                    .is_some_and(|saved| saved.restore(&window).is_err())
            {
                eprintln!("Wobble could not restore the remembered window.");
            }
        }
    }
    response
}

struct TauriHost(tauri::AppHandle);

impl QuitHost for TauriHost {
    fn emit_quit_requested(&self) {
        let _ = self.0.emit(QUIT_REQUESTED_EVENT, ());
    }
    fn exit(&self) {
        self.0.exit(0);
    }
}

type Gate = QuitGate<TauriHost>;

/// The app-controlled native menu labels, supplied by the frontend from the same
/// catalogs the interface uses. Platform-provided items keep their own labels.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMenuLabels {
    edit: String,
    window: String,
    quit: String,
}

fn valid_menu_label(label: &str) -> bool {
    let trimmed = label.trim();
    !trimmed.is_empty() && trimmed.len() <= 80 && !trimmed.chars().any(char::is_control)
}

/// Rebuilds the native menu in the confirmed startup language. Called once per document
/// initialization by the shell's resolved locale; a saved preference never calls it.
#[tauri::command]
fn initialize_native_locale(
    app: tauri::AppHandle,
    locale: String,
    labels: NativeMenuLabels,
) -> Result<(), String> {
    if !matches!(locale.as_str(), "en" | "es-419") {
        return Err("The native locale must be en or es-419.".to_owned());
    }
    for (name, label) in [
        ("edit", &labels.edit),
        ("window", &labels.window),
        ("quit", &labels.quit),
    ] {
        if !valid_menu_label(label) {
            return Err(format!("The native {name} label is invalid."));
        }
    }

    let quit = MenuItemBuilder::with_id("quit", labels.quit.trim())
        .accelerator("CmdOrCtrl+Q")
        .build(&app)
        .map_err(|error| error.to_string())?;
    let app_menu = SubmenuBuilder::new(&app, "Wobble")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()
        .map_err(|error| error.to_string())?;
    let edit_menu = SubmenuBuilder::new(&app, labels.edit.trim())
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
        .map_err(|error| error.to_string())?;
    let window_menu = SubmenuBuilder::new(&app, labels.window.trim())
        .minimize()
        .maximize()
        .build()
        .map_err(|error| error.to_string())?;

    app.set_menu(
        MenuBuilder::new(&app)
            .items(&[&app_menu, &edit_menu, &window_menu])
            .build()
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// The page confirmed the quit (nothing unsaved, or the organizer chose to discard).
#[tauri::command]
fn exit_app(gate: tauri::State<'_, Gate>) {
    gate.exit();
}

/// The page received the request and owns the answer from here (a dialog may be open).
#[tauri::command]
fn quit_ack(gate: tauri::State<'_, Gate>) {
    gate.acknowledge();
}

/// Reveals a file in the operating system's file manager: the "Show in Finder" action
/// that also covers Explorer and Linux file managers. The shell deliberately runs the
/// platform's own command rather than adding a plugin dependency for one action.
#[tauri::command]
fn reveal_data_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(format!("{path} is not a file."));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(&target);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(format!("/select,{}", target.display()));
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(target.parent().unwrap_or(&target));
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not reveal {path}: {error}"))
}

/// Clears the saved window state and puts the window back at the size and place
/// tauri.conf.json starts it at. The page disables this while Remember window is off.
#[tauri::command]
fn reset_window(app: tauri::AppHandle) -> Result<(), String> {
    // A reset must not be undone by the deferred launch snapshot.
    app.state::<WindowRestoration>()
        .applied
        .store(true, Ordering::Release);
    let state_file = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join(tauri_plugin_window_state::DEFAULT_FILENAME);
    match std::fs::remove_file(&state_file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not clear the saved window state: {error}")),
    }

    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    // The window's configured size, not a second copy of it: the config may change.
    let configured = app.config().app.windows.first();
    let width = configured.map_or(1280.0, |window| window.width);
    let height = configured.map_or(832.0, |window| window.height);
    window.unmaximize().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(false)
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window.center().map_err(|error| error.to_string())?;
    Ok(())
}

fn main() {
    // The database lives under the app's data directory, resolved from the bundle
    // identifier (`~/Library/Application Support/com.wobble.desktop` on macOS) — exactly
    // what `app.path().app_data_dir()` would return, but computed before the app exists
    // so Remember window can be read before the window-state plugin is built.
    // `WOBBLE_DB_PATH` still overrides it for throwaway dev databases.
    let context = tauri::generate_context!();
    let db_path = std::env::var_os("WOBBLE_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_dir()
                .expect("the operating system data directory")
                .join(context.config().identifier.as_str())
                .join("workers.sqlite")
        });

    // Remembers size, position and maximized/fullscreen across launches. VISIBLE is
    // left out on purpose: restoring it would show the window before its first themed
    // paint, which is what `visible: false` in tauri.conf.json prevents.
    let window_state = tauri_plugin_window_state::Builder::default()
        .with_state_flags(remembered_window_flags())
        .skip_initial_state("main");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(window_state.build())
        .setup(move |app| {
            // No database open or preference read occurs before explicit authentication.
            app.manage(Mutex::new(App::locked(&db_path.to_string_lossy())));
            app.manage(WindowRestoration {
                applied: AtomicBool::new(false),
                snapshot: remembered_window::RememberedWindow::snapshot(app.handle()),
            });
            app.manage(Gate::new(TauriHost(app.handle().clone()), ANSWER_TIMEOUT));

            // A native menu whose Quit asks the page first. The Edit items keep
            // copy/paste working in the webview on macOS.
            let quit = MenuItemBuilder::with_id("quit", "Quit Wobble")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Wobble")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(&quit)
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .build()?;
            app.set_menu(
                MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?,
            )?;

            // The window starts hidden so the user never sees it blank; the frontend
            // shows it after its first themed paint. This is the net under that: if
            // the frontend never gets that far, the window still appears.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                app.state::<Gate>().request();
            }
        })
        .invoke_handler(tauri::generate_handler![
            api_request,
            initialize_native_locale,
            exit_app,
            quit_ack,
            reset_window,
            reveal_data_file
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // A quit the platform reports without our menu (the Dock, the app
            // switcher) lands here with no exit code; `exit_app` comes back with one.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
                app.state::<Gate>().request();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::valid_menu_label;

    #[test]
    fn native_menu_labels_are_non_empty_short_and_printable() {
        assert!(valid_menu_label("Editar"));
        assert!(valid_menu_label("Salir de Wobble"));
        assert!(!valid_menu_label(""));
        assert!(!valid_menu_label("   "));
        assert!(!valid_menu_label("Salir\nWobble"));
        assert!(!valid_menu_label(&"x".repeat(81)));
    }
}
