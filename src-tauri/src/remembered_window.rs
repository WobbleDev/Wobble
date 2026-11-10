//! Immutable launch geometry. The plugin's live cache changes on boot-window events,
//! so it cannot be the source of a restoration deferred until database unlock.
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use tauri::{Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_window_state::AppHandleExt;

#[derive(Clone, Deserialize)]
pub struct RememberedWindow {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    fullscreen: bool,
}

impl RememberedWindow {
    pub fn snapshot(app: &tauri::AppHandle) -> Option<Self> {
        let file = app.path().app_config_dir().ok()?.join(app.filename());
        Self::from_file(&file)
    }

    fn from_file(path: &Path) -> Option<Self> {
        let file = std::fs::File::open(path).ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(65_537).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 65_536 {
            return None;
        }
        let states: HashMap<String, Self> = serde_json::from_slice(&bytes).ok()?;
        states
            .get("main")
            .filter(|state| {
                (1..=100_000).contains(&state.width) && (1..=100_000).contains(&state.height)
            })
            .cloned()
    }

    // Match the pinned plugin's saved-corner monitor visibility rule, using wide
    // arithmetic so malformed/off-screen positions cannot overflow.
    fn visible_on(&self, x: i32, y: i32, width: u32, height: u32) -> bool {
        let left = i64::from(x);
        let right = left + i64::from(width);
        let top = i64::from(y);
        let bottom = top + i64::from(height);
        [
            (i64::from(self.x), i64::from(self.y)),
            (i64::from(self.x) + i64::from(self.width), i64::from(self.y)),
            (
                i64::from(self.x),
                i64::from(self.y) + i64::from(self.height),
            ),
            (
                i64::from(self.x) + i64::from(self.width),
                i64::from(self.y) + i64::from(self.height),
            ),
        ]
        .iter()
        .any(|(x, y)| (left..right).contains(x) && (top..bottom).contains(y))
    }

    pub fn restore(&self, window: &tauri::WebviewWindow) -> tauri::Result<()> {
        // A person may have changed the boot frame before unlocking. Establish the
        // remembered normal frame before applying remembered maximized/fullscreen state.
        window.set_fullscreen(false)?;
        window.unmaximize()?;
        if window.available_monitors()?.iter().any(|monitor| {
            self.visible_on(
                monitor.position().x,
                monitor.position().y,
                monitor.size().width,
                monitor.size().height,
            )
        }) {
            window.set_position(PhysicalPosition::new(
                if self.maximized { self.prev_x } else { self.x },
                if self.maximized { self.prev_y } else { self.y },
            ))?;
        }
        window.set_size(PhysicalSize::new(self.width, self.height))?;
        if self.maximized {
            window.maximize()?;
        }
        window.set_fullscreen(self.fullscreen)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(x: i32, y: i32) -> RememberedWindow {
        RememberedWindow {
            width: 1280,
            height: 832,
            x,
            y,
            prev_x: x,
            prev_y: y,
            maximized: false,
            fullscreen: false,
        }
    }
    #[test]
    fn accepts_visible_negative_monitor_coordinates_and_rejects_detached_monitors() {
        assert!(state(-1800, 20).visible_on(-1920, 0, 1920, 1080));
        assert!(!state(-4000, 20).visible_on(0, 0, 1920, 1080));
        assert!(!state(i32::MAX, i32::MAX).visible_on(0, 0, 1920, 1080));
    }
    #[test]
    fn missing_malformed_or_zero_geometry_has_no_snapshot() {
        let path = std::env::temp_dir().join(format!("wobble-window-{}.json", std::process::id()));
        std::fs::write(&path, b"not json").unwrap();
        assert!(RememberedWindow::from_file(&path).is_none());
        std::fs::write(&path, br#"{"main":{"width":0,"height":832,"x":0,"y":0,"prev_x":0,"prev_y":0,"maximized":false,"fullscreen":false}}"#).unwrap();
        assert!(RememberedWindow::from_file(&path).is_none());
        std::fs::remove_file(path).unwrap();
    }
}
