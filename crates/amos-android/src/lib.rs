//! Android-compat layer: drive a Waydroid / LXC Android container from Rust.
//!
//! The Tauri System UI never runs an APK directly. This crate talks to the
//! container runtime over its CLI (or binder) and exposes the capability as a
//! gRPC service (`AndroidManager`) that the Tauri core consumes. App surfaces
//! are composited into Tauri windows via Wayland / DMA-BUF (see docs).

pub mod controller;
pub mod manager;
pub mod png;
pub mod runtime;
pub mod service;

pub use controller::{
    extract_icon_bytes, parse_app_list, AndroidController, CommandRunner, ShellRunner,
};
pub use manager::{AndroidManagerConfig, EnhancedAndroidManager, CacheStats};
pub use png::icon_png;
pub use runtime::{auto, AndroidRuntime, DemoRuntime, WaydroidRuntime};
pub use service::AndroidManagerService;
