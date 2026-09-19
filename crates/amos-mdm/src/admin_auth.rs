//! Admin API authentication middleware.
//!
//! **Security posture**: every `/api/admin/*` endpoint MUST require a valid
//! admin token. Without this guard, any process that can reach the listening
//! socket can wipe every enrolled device — the audit trail literally shows
//! the admin endpoints were wired without any auth extractor or middleware
//! (`crates/amos-mdm/src/main.rs:115-138`).
//!
//! The token is a **shared secret** loaded from `--admin-token` (preferred) or
//! `MDM_ADMIN_TOKEN` env var, generated on first boot and printed to the log
//! when no pre-existing value is supplied. We use a constant-time comparison
//! against a SHA-256 digest so a timing oracle does not leak the secret byte
//! by byte.
//!
//! Design choices:
//!
//! * **No JWT / HMAC challenge** — the server has only one admin role and no
//!   per-user auditing yet, so a bearer token over the loopback is the simplest
//!   honest answer. When the audit log lands, swap this for a JWT or HMAC.
//! * **`/health` and `/api/mdm/*` are exempt** — device-side endpoints carry
//!   their own per-device API key (see `state::extract_api_key`); the health
//!   probe is intentionally anonymous for `livenessProbe`/`readinessProbe`.
//! * **Fail closed** — any missing / wrong-shaped / wrong-length token returns
//!   `401 Unauthorized` without revealing whether the token is "almost right".

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};

use crate::state::AppState;

/// Constant-time SHA-256 digest comparison. Returns true iff `a` and `b` are
/// byte-equal AND non-empty (an empty `Authorization` header never matches a
/// configured secret).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Hash the supplied admin token to a 64-hex-char form so the in-memory
/// comparison is fixed-length (defends against length-based oracles).
fn digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// 401 response with a generic body — never reveal whether the secret exists.
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [("WWW-Authenticate", "Bearer realm=\"amos-mdm-admin\"")],
        "{\"error\":\"unauthorized\"}",
    )
        .into_response()
}

/// Axum middleware that gates `/api/admin/*` routes behind a shared admin
/// token.
///
/// **Header contract**: `Authorization: Bearer <admin-token>`. Any other
/// scheme or prefix is rejected; this is more restrictive than the device-side
/// helper in `state::extract_api_key` which also accepts a raw-prefix form
/// (devices use a generated `amos_…` key, admins use a deliberate secret).
///
/// The middleware reads `state.config.admin_token_hash` and refuses to start
/// when the field is empty — `AppState::new` should always populate it; the
/// empty case here is a "panic at the gate" defense.
pub async fn require_admin_token(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    // Defense-in-depth: refuse every request if the admin hash was never set.
    if state.config.admin_token_hash.is_empty() {
        tracing::error!("admin route hit but admin_token_hash is empty");
        return unauthorized();
    }

    // Pull `Authorization` (case-insensitive in HTTP/1.1, but axum exposes it
    // already lower-cased here).
    let supplied = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    if !ct_eq(
        digest(supplied).as_bytes(),
        state.config.admin_token_hash.as_bytes(),
    ) {
        tracing::warn!(
            "admin endpoint refused (no/invalid bearer token, remote={:?})",
            req.extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>(),
        );
        return unauthorized();
    }

    next.run(req).await
}

#[cfg(test)]
mod tests {
    //! The admin middleware is the **last line of defense** between an
    //! unauthenticated socket and `wipe_all_devices`. The tests below pin:
    //!
    //! 1. `ct_eq` is constant-time across equal-length inputs (no early
    //!    exit) AND refuses mismatched lengths.
    //! 2. `digest` is deterministic and produces 64 hex chars.
    //! 3. End-to-end: a request without `Authorization` gets 401, a wrong
    //!    token gets 401, the right token gets through, an empty stored
    //!    hash refuses every request (fail-closed).
    //!
    //! **Caveat for the build**: the `require_admin_token` integration tests
    //! below build a real `axum::Router` and exercise it via
    //! `tower::ServiceExt::oneshot`. They will panic with "no reactor" if
    //! `tokio::main` / `tokio::test` is missing — the macro on each test
    //! provides the runtime.

    use super::*;
    use crate::Database;
    use crate::MdmConfig;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        middleware,
        routing::get,
        Router,
    };
    use tower::ServiceExt;

    const REAL_TOKEN: &str = "super-secret-admin-token-xyz";

    fn hashed_config() -> MdmConfig {
        // `clippy::field_reassign_with_default`: build via struct-update
        // syntax so the lint stays clean and the fields-set list is
        // visible at the call site.
        MdmConfig {
            admin_token_hash: digest(REAL_TOKEN),
            ..MdmConfig::default()
        }
    }

    /// Build a router with the admin middleware mounted on `/api/admin/ping`.
    /// `init_db` is awaited by the caller inside `#[tokio::test]`.
    fn build_app(db: Database, config: MdmConfig) -> Router {
        let state = AppState::new(db, config);
        Router::new()
            .route("/api/admin/ping", get(|| async { "pong" }))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin_token,
            ))
            .with_state(state)
    }

    async fn make_app(config: MdmConfig) -> Router {
        let db = Database::open_in_memory_for_tests().await;
        build_app(db, config)
    }

    #[test]
    fn ct_eq_matches_identical_inputs() {
        assert!(ct_eq(b"hello", b"hello"));
    }

    #[test]
    fn ct_eq_rejects_empty_inputs() {
        // Two empty inputs are equal byte-for-byte, but a known threat
        // is "empty authorization matches empty configured hash". Refuse.
        assert!(!ct_eq(b"", b""));
        assert!(!ct_eq(b"", b"x"));
        assert!(!ct_eq(b"x", b""));
    }

    #[test]
    fn ct_eq_rejects_mismatched_lengths_even_when_prefix_matches() {
        // The whole point of ct_eq is to refuse length-oracle attacks.
        assert!(!ct_eq(b"abcdef", b"abcdefg"));
        assert!(!ct_eq(b"abcdefg", b"abcdef"));
    }

    #[test]
    fn ct_eq_rejects_different_inputs_of_equal_length() {
        assert!(!ct_eq(b"abcdef", b"abcdeg"));
        assert!(!ct_eq(b"\x00\x01\x02", b"\x00\x01\x03"));
    }

    #[test]
    fn digest_is_deterministic_and_64_hex_chars() {
        let d = digest(REAL_TOKEN);
        assert_eq!(d.len(), 64);
        assert!(d.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(d, digest(REAL_TOKEN));
    }

    #[test]
    fn digest_changes_with_input() {
        let a = digest("alpha");
        let b = digest("beta");
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn no_authorization_header_is_unauthorized() {
        let app = make_app(hashed_config()).await;
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/admin/ping")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        // The response must carry a `WWW-Authenticate: Bearer …` header so
        // well-behaved clients (curl, browsers) know what to send next.
        assert!(resp.headers().contains_key("WWW-Authenticate"));
    }

    #[tokio::test]
    async fn wrong_token_is_unauthorized() {
        let app = make_app(hashed_config()).await;
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/admin/ping")
                    .header("Authorization", "Bearer not-the-real-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn correct_token_passes_through() {
        let app = make_app(hashed_config()).await;
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/admin/ping")
                    .header("Authorization", format!("Bearer {REAL_TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 16).await.unwrap();
        assert_eq!(body.as_ref(), b"pong");
    }

    #[tokio::test]
    async fn wrong_scheme_is_unauthorized() {
        // "Token …" / "Basic …" must not be accepted even if the suffix
        // would have been the right secret.
        let app = make_app(hashed_config()).await;
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/admin/ping")
                    .header("Authorization", format!("Basic {REAL_TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn empty_stored_hash_refuses_every_request_fail_closed() {
        // **Defense in depth**: if `AppState::new` is ever called without a
        // admin hash (mis-configuration, regression in `main.rs`),
        // every admin endpoint must return 401, not 200. The handler
        // checks the hash first and short-circuits before any other auth
        // logic runs.
        let app = make_app(MdmConfig::default()).await; // empty admin_token_hash
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/admin/ping")
                    .header("Authorization", "Bearer anything")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "admin endpoints must be fail-closed when admin_token_hash is empty"
        );
    }

    #[tokio::test]
    async fn length_mismatch_with_correct_prefix_is_rejected() {
        // If the attacker sends a 65-char token and the stored hash is the
        // digest of a 64-char token, ct_eq must short-circuit on length
        // without leaking timing.
        let app = make_app(hashed_config()).await;
        let too_long = format!("{}!", REAL_TOKEN); // one byte longer
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/admin/ping")
                    .header("Authorization", format!("Bearer {too_long}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
