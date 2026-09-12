//! amos System UI binary entrypoint (desktop).

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    amos_tauri_lib::run();
}
