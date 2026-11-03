#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

struct Sidecar(Mutex<Option<Child>>);

// Env: SF_REPO (required), SF_PORT (default 4317), SF_SERVER (override entrypoint).
// Mirrors desktop/sidecar.mjs; the window URL in tauri.conf.json must match SF_PORT.
fn spawn_sidecar() -> Option<Child> {
    let repo = std::env::var("SF_REPO").ok()?;
    let port = std::env::var("SF_PORT").unwrap_or_else(|_| "4317".into());
    let server = std::env::var("SF_SERVER").unwrap_or_else(|_| {
        "../../com.github.copilot/extensions/software-factory/runner/server.mjs".into()
    });
    Command::new("node")
        .args([&server, "--repo", &repo, "--port", &port, "--allow-repo", &repo])
        .spawn()
        .ok()
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Sidecar(Mutex::new(spawn_sidecar())))
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut c) = handle.state::<Sidecar>().0.lock().unwrap().take() {
                let _ = c.kill();
            }
        }
    });
}