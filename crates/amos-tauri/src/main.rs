//! amos System UI binary entrypoint (desktop).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    amos_tauri_lib::run();
}
