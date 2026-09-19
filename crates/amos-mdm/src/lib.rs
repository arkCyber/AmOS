//! # amos-mdm: Mobile Device Management Server
//!
//! 企业级 MDM 服务器，提供设备注册、策略同步、远程命令等功能。

// P0-1 gate: production code must not panic on programmer error (tests exempt). The scan in
// `scripts/rust-panic-scan.mjs` requires this on every crate root; a new crate that skips it
// is not "not yet covered" — it is a crate where `unwrap()` can reach a device.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod admin_auth;
mod config;
mod db;
mod error;
pub mod handlers;
mod models;
mod routes;
mod state;

pub use config::MdmConfig;
pub use error::MdmError;
pub use state::AppState;

// 重新导出类型
pub use db::Database;

use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::trace::TraceLayer;

/// Maximum request body size (REQ-A411, `mdm #31`).
///
/// Every endpoint takes a small JSON object: an enrollment, a sync ping,
/// a policy config. Without a ceiling, `Content-Length` is the caller's
/// choice and an unauthenticated `POST /api/mdm/enroll` can ask the
/// server to buffer as much as it likes. 256 KiB is well above every
/// legitimate payload and still bounded.
pub const DEFAULT_MAX_BODY_BYTES: usize = 256 * 1024;

/// Build the full MDM router (device routes + admin routes guarded by
/// `require_admin_token` + the `/health` probe).
///
/// **This is the canonical router factory.** `main.rs` uses it; the
/// integration tests in `tests/` use it. Adding a new admin route
/// anywhere else is a bug — the only place that decides which routes
/// are "admin" is this function, so the auth guarantee is centralised
/// and testable.
///
/// The router does **not** include the CORS layer. CORS is a deployment
/// concern (it depends on the operator's allowlist), so `main.rs` adds
/// it after this function returns. Integration tests don't need CORS
/// because they speak HTTP/1.1 over `tower::ServiceExt::oneshot`, not
/// from a browser.
pub fn build_router(state: AppState, max_body_bytes: usize) -> Router {
    let device_routes = Router::new()
        .route("/api/mdm/enroll", post(handlers::enroll_device))
        .route("/api/mdm/sync", post(handlers::sync_device))
        .route("/api/mdm/commands", get(handlers::get_commands))
        .route("/api/mdm/commands/:id/ack", post(handlers::ack_command))
        .route("/api/mdm/unenroll", post(handlers::unenroll_device));

    let admin_routes = Router::new()
        .route("/api/admin/devices", get(handlers::list_devices))
        .route(
            "/api/admin/devices/:device_id/lock",
            post(handlers::lock_device),
        )
        .route(
            "/api/admin/devices/:device_id/wipe",
            post(handlers::wipe_device),
        )
        .route(
            "/api/admin/devices/:device_id/unlock",
            post(handlers::unlock_device),
        )
        .route(
            "/api/admin/devices/:device_id/policy",
            post(handlers::set_device_policy),
        )
        .route("/api/admin/policies", get(handlers::list_policies))
        .route("/api/admin/policies", post(handlers::create_policy))
        .route("/api/admin/policies/:id", put(handlers::update_policy))
        .route("/api/admin/policies/:id", delete(handlers::delete_policy))
        .route("/api/admin/tokens", get(handlers::list_tokens))
        .route("/api/admin/tokens", post(handlers::create_token))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            admin_auth::require_admin_token,
        ));

    Router::new()
        .route("/health", get(handlers::health_check))
        .merge(device_routes)
        .merge(admin_routes)
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    //! Public-API smoke tests.
    //!
    //! These tests don't verify behaviour (the per-module tests do that);
    //! they verify that the **re-export surface** of `amos-mdm` is what
    //! downstream crates and `main.rs` rely on. If a future refactor
    //! renames or removes any of these re-exports, the integration
    //! build fails before we ever spawn a server.
    use crate::{AppState, Database, MdmConfig, MdmError};

    #[test]
    fn public_api_re_exports_are_present() {
        // `Database` must be nameable as `amos_mdm::Database` — `main.rs`
        // uses it directly. We pin `Clone` because `AppState` requires
        // it (axum's `State` is `Clone`).
        fn assert_clone<T: Clone>() {}
        assert_clone::<Database>();

        // `AppState::new` is the only sanctioned constructor for the
        // shared state. Pin its signature.
        let _: fn(Database, MdmConfig) -> AppState = AppState::new;

        // `MdmConfig::default` is used by tests that want a "boring"
        // config to seed from.
        let _: fn() -> MdmConfig = MdmConfig::default;
    }

    #[test]
    fn mdm_error_is_nameable_and_matches_send_sync() {
        // The error must travel through axum handlers (which require
        // `Send + Sync`). If a variant ever holds a non-thread-safe
        // payload, this stops compiling.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<MdmError>();
    }
}
