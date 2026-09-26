//! End-to-end HTTP integration tests for `amos-mdm`.
//!
//! These tests stand up the **full** router via `amos_mdm::build_router` —
//! the same factory `main.rs` uses — and walk through the device lifecycle
//! with `tower::ServiceExt::oneshot`, no socket binding, no real listener.
//!
//! **Compiles only when `test-helpers` is enabled** — the file uses
//! `Database::open_in_memory_for_tests` and `seed_enrollment_token_for_test`,
//! both of which are gated on that feature. `make lint` runs without
//! `--features test-helpers`, so we `#[cfg]` the entire file out in that
//! mode rather than failing the production-gate build.
//!
//! Coverage targets (REQ-A411, `mdm #12–#14`, `mdm #22`, `mdm #27`):
//!
//! 1. **Happy path**: health → enroll → sync → admin list → admin lock →
//!    device gets command → device acks → sync shows locked.
//! 2. **Auth boundary**: every `/api/admin/*` route returns 401 without a
//!    valid `Authorization: Bearer <admin-token>`. The fail-closed posture
//!    of `admin_auth::require_admin_token` is the only thing standing
//!    between an unauthenticated socket and `wipe_all_devices`.
//! 3. **Per-device auth**: device endpoints require the API key returned
//!    at enrollment. A second device must not be able to ack a command
//!    that belongs to a different device (this was a real CVE shape that
//!    the unit tests in `admin_auth.rs` already pinned at the middleware
//!    level; this test pins it at the public API).
//! 4. **Wire format**: every response is camelCase JSON with a numeric
//!    `serverTime`. The previous `ApiResponse::server_time` snake_case
//!    drift is no longer reachable because `build_router` is the only
//!    router the server ships.
//!
//! ## Test isolation
//!
//! Each test gets a fresh `Database::open_in_memory_for_tests()` and a
//! freshly-generated admin token. Two tests cannot see each other's
//! devices because they do not share a database file. (SQLite
//! `:memory:` handles are per-connection, and each test opens its own.)

#![cfg(feature = "test-helpers")]

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use amos_mdm::{build_router, AppState, Database, MdmConfig, DEFAULT_MAX_BODY_BYTES};

/// Hash the admin token the same way `admin_auth::digest` does. The
/// function is `pub(crate)` in the lib so we re-derive the digest here
/// instead of importing a private function.
fn admin_digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Build a router for one test: in-memory DB, default org already
/// created, the supplied admin-token hash set, fresh device-side
/// defaults.
async fn fresh_router(admin_token: &str) -> axum::Router {
    let cfg = MdmConfig {
        admin_token_hash: admin_digest(admin_token),
        ..MdmConfig::default()
    };
    let db = Database::open_in_memory_for_tests().await;
    db.ensure_default_organization().await.expect("default org");
    // Create two enrollment tokens so two devices can enroll in the
    // same test (the token is single-use — REQ-A411, `mdm #12–#14`).
    let org_id = db
        .get_default_organization()
        .await
        .expect("default org exists")
        .id;
    let now = chrono::Utc::now().timestamp_millis();
    let far_future = now + 7 * 24 * 60 * 60 * 1000;
    db.seed_enrollment_token_for_test("AMOS-ENROLL-TOKEN-TEST", &org_id, far_future)
        .await
        .expect("token A");
    db.seed_enrollment_token_for_test("AMOS-ENROLL-TOKEN-B", &org_id, far_future)
        .await
        .expect("token B");
    let state = AppState::new(db, cfg);
    build_router(state, DEFAULT_MAX_BODY_BYTES)
}

async fn body_json(resp: axum::response::Response) -> (StatusCode, Value) {
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 64 * 1024)
        .await
        .expect("body readable");
    let v: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, v)
}

// ========================================================================
// Happy path: enroll → sync → admin list → lock → ack → sync shows locked
// ========================================================================

#[tokio::test]
async fn full_device_lifecycle_enroll_sync_lock_ack() {
    let admin = "test-admin-token";
    let app = fresh_router(admin).await;

    // 1. Health check is anonymous and returns 200 OK.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = to_bytes(resp.into_body(), 64).await.unwrap();
    assert_eq!(body.as_ref(), b"OK");

    // 2. Enroll the device. The server creates the device, generates an
    // API key (prefixed `amos_`), and returns the org identity.
    let (status, enroll) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/enroll")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "enrollmentToken": "AMOS-ENROLL-TOKEN-TEST",
                            "deviceId": "dev-e2e-1",
                            "deviceName": "Pixel Test",
                            "platform": "android",
                            "userAgent": "amos-e2e/1.0"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "enroll failed: {enroll}");
    assert_eq!(enroll["success"], true);
    // The API key must be present and use the configured prefix.
    let api_key = enroll["data"]["apiKey"]
        .as_str()
        .expect("apiKey present")
        .to_string();
    assert!(
        api_key.starts_with("amos_"),
        "API key must use the configured prefix, got {api_key:?}"
    );

    // 3. Sync — first sync after enroll returns the full config (no
    // `lastSyncAt`, so the server treats this as the baseline).
    let (status, sync) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/sync")
                    .header("authorization", format!("Bearer {api_key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "deviceId": "dev-e2e-1",
                            "lastSyncAt": 0,
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "sync failed: {sync}");
    assert_eq!(sync["success"], true);
    // Config shape: the camelCase fields the frontend depends on.
    assert!(sync["config"].is_object());
    assert_eq!(sync["config"]["deviceStatus"], "active");
    assert_eq!(sync["config"]["deviceId"], "dev-e2e-1");
    // The enroller is the fact stored at enroll (`org.admin_email`), not the
    // literal `"admin"`. The client merges this config over its own state, so a
    // constant here would overwrite the real enroller it captured at enroll.
    assert_eq!(
        sync["config"]["enrolledBy"], "admin@amos.local",
        "sync must return the stored enroller, not a hardcoded literal: {sync}"
    );
    // `serverTime` must be present and numeric.
    assert!(
        sync["serverTime"].is_number(),
        "sync response missing serverTime: {sync}"
    );

    // 4. Admin lists devices. Without the admin token: 401.
    let (status, _) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/admin/devices")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // With the admin token: 200, and our device is in the list.
    let (status, list) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/admin/devices")
                    .header("authorization", format!("Bearer {admin}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "list failed: {list}");
    let devices = list["data"].as_array().expect("data array");
    assert!(
        devices.iter().any(|d| d["deviceId"] == "dev-e2e-1"),
        "device not in admin list: {devices:?}"
    );

    // 5. Admin locks the device.
    let (status, lock) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/admin/devices/dev-e2e-1/lock")
                    .header("authorization", format!("Bearer {admin}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "message": "lost device" })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "lock failed: {lock}");

    // 6. Device polls `/api/mdm/commands` — should see the lock command.
    // The query parameter is `device_id` (snake_case, no alias).
    let (status, cmds) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/mdm/commands?device_id=dev-e2e-1")
                    .header("authorization", format!("Bearer {api_key}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "get_commands failed: {cmds}");
    let commands = cmds["commands"].as_array().expect("commands array");
    assert_eq!(
        commands.len(),
        1,
        "expected 1 pending command: {commands:?}"
    );
    assert_eq!(commands[0]["type"], "lock");
    let cmd_id = commands[0]["id"].as_str().expect("cmd id").to_string();

    // 7. Device acks the lock command. `deviceId` in the body is the
    // auth-bearing field (see `AckCommandRequest`).
    let (status, ack) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/mdm/commands/{cmd_id}/ack"))
                    .header("authorization", format!("Bearer {api_key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "deviceId": "dev-e2e-1",
                            "result": "locked-screen-shown"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "ack failed: {ack}");

    // 8. Sync again — `deviceStatus` should now be `locked` and
    // `lockMessage` should be `lost device`.
    let (status, sync2) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/sync")
                    .header("authorization", format!("Bearer {api_key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "deviceId": "dev-e2e-1",
                            "lastSyncAt": 0
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "second sync failed: {sync2}");
    assert_eq!(sync2["config"]["deviceStatus"], "locked");
    assert_eq!(sync2["config"]["lockMessage"], "lost device");
}

// ========================================================================
// Auth boundary: every admin endpoint is fail-closed
// ========================================================================

#[tokio::test]
async fn admin_endpoints_require_admin_token_and_fail_closed() {
    let admin = "real-admin";
    let app = fresh_router(admin).await;

    // Each admin endpoint must return 401 without `Authorization`.
    let admin_paths = [
        ("GET", "/api/admin/devices"),
        ("GET", "/api/admin/policies"),
        ("GET", "/api/admin/tokens"),
    ];
    for (method, path) in admin_paths {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path} must be 401 without auth"
        );
    }

    // A wrong token is also 401 (and NOT 403 — 403 would leak
    // "almost right" timing).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/devices")
                .header("authorization", "Bearer wrong")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // The right token works.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/devices")
                .header("authorization", format!("Bearer {admin}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

// ========================================================================
// Per-device auth: a second device cannot ack a command belonging to device A
// ========================================================================

#[tokio::test]
async fn device_b_cannot_ack_device_a_command() {
    let admin = "admin";
    let app = fresh_router(admin).await;

    // Enroll device A.
    let (_, enroll_a) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/enroll")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "enrollmentToken": "AMOS-ENROLL-TOKEN-TEST",
                            "deviceId": "dev-A",
                            "deviceName": "A",
                            "platform": "android",
                            "userAgent": "ua"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let key_a = enroll_a["data"]["apiKey"].as_str().unwrap().to_string();

    // Admin locks device A.
    let _ = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/admin/devices/dev-A/lock")
                .header("authorization", format!("Bearer {admin}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&json!({})).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    // Device A polls its commands.
    let (_, cmds_a) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/mdm/commands?device_id=dev-A")
                    .header("authorization", format!("Bearer {key_a}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let cmd_id_a = cmds_a["commands"][0]["id"].as_str().unwrap().to_string();

    // Enroll device B (different deviceId, fresh API key).
    let (_, enroll_b) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/enroll")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "enrollmentToken": "AMOS-ENROLL-TOKEN-B",
                            "deviceId": "dev-B",
                            "deviceName": "B",
                            "platform": "android",
                            "userAgent": "ua"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let key_b = enroll_b["data"]["apiKey"].as_str().unwrap().to_string();

    // Device B tries to ack device A's command using its own key + A's
    // `deviceId` in the body. The server must refuse:
    //   * If B sends A's id in the body but B's key, `validate_api_key`
    //     fails (B's key isn't tied to dev-A) → 401.
    //   * Even if it were possible, the row update is conditioned on
    //     the device id and would return 0 rows → 404.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/mdm/commands/{cmd_id_a}/ack"))
                .header("authorization", format!("Bearer {key_b}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "deviceId": "dev-A",
                        "result": "tampered"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // The first gate (`validate_api_key`) trips — key B doesn't match
    // device A. 401 is the correct outcome.
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // And as a sanity check: device A still has its command pending,
    // because the failed ack did NOT mark it executed.
    let (_, cmds_after) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/mdm/commands?device_id=dev-A")
                    .header("authorization", format!("Bearer {key_a}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        cmds_after["commands"].as_array().unwrap().len(),
        1,
        "device A's command must still be pending after B's failed ack"
    );
}

// ========================================================================
// Wire format: every response is camelCase JSON with numeric serverTime
// ========================================================================

#[tokio::test]
async fn every_response_carries_camel_case_server_time() {
    let admin = "admin";
    let app = fresh_router(admin).await;

    // Enroll a device so we have something to sync.
    let (_s, enroll) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/enroll")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "enrollmentToken": "AMOS-ENROLL-TOKEN-TEST",
                            "deviceId": "dev-wire",
                            "deviceName": "W",
                            "platform": "ios",
                            "userAgent": "ua"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let api_key = enroll["data"]["apiKey"].as_str().unwrap().to_string();

    // Sample one endpoint from each "kind" of handler:
    //   * Device error path (no auth) — exercises `MdmError::into_response`.
    //   * Device success path — exercises a typed JSON body.
    //   * Admin success path — exercises the admin middleware.

    // Device error path: `sync_device` with no `Authorization` → 401.
    let (_, err) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/sync")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "deviceId": "dev-wire",
                            "lastSyncAt": 0
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert!(
        err["serverTime"].is_number(),
        "device error path must include numeric serverTime: {err}"
    );
    assert!(
        err["message"].is_string(),
        "device error path must include message"
    );
    assert_eq!(err["success"], false);

    // Device success path: sync with the right key.
    let (_, ok) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/sync")
                    .header("authorization", format!("Bearer {api_key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "deviceId": "dev-wire",
                            "lastSyncAt": 0
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert!(
        ok["serverTime"].is_number(),
        "sync must include numeric serverTime"
    );
    assert_eq!(ok["success"], true);

    // Admin success path: list devices.
    let (_, admin_resp) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/admin/devices")
                    .header("authorization", format!("Bearer {admin}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert!(
        admin_resp["serverTime"].is_number(),
        "admin response must include numeric serverTime: {admin_resp}"
    );
    // The Devices inside `data` use `#[serde(rename_all = "camelCase")]`
    // — pin the field shape so a snake_case regression in the model
    // catches the frontend.
    let device = &admin_resp["data"][0];
    assert!(device["deviceId"].is_string(), "deviceId must be camelCase");
    assert!(
        device["lastSyncAt"].is_i64(),
        "lastSyncAt must be camelCase"
    );
    assert!(
        device.get("device_id").is_none(),
        "snake_case device_id leaked: {device}"
    );
}

// ========================================================================
// Body-size limit (REQ-A411, `mdm #31`)
// ========================================================================

#[tokio::test]
async fn oversize_enroll_is_refused_with_413() {
    let admin = "admin";
    let app = fresh_router(admin).await;

    // Construct a payload comfortably larger than the
    // `DEFAULT_MAX_BODY_BYTES` (256 KiB) ceiling.
    let big_string = "x".repeat(DEFAULT_MAX_BODY_BYTES + 1024);
    let payload = serde_json::to_vec(&json!({
        "enrollmentToken": "AMOS-ENROLL-TOKEN-TEST",
        "deviceId": "dev-big",
        "deviceName": big_string,
        "platform": "android",
        "userAgent": "ua"
    }))
    .unwrap();

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/mdm/enroll")
                .header("content-type", "application/json")
                .body(Body::from(payload))
                .unwrap(),
        )
        .await
        .unwrap();
    // axum returns 413 Payload Too Large when the body-limit layer
    // rejects the request before the handler runs.
    assert_eq!(
        resp.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "oversized enroll must be 413"
    );
}

// ========================================================================
// A device that reports FAILURE is recorded as failed, not acknowledged (REQ-A410)
// ========================================================================

/// The ack contract had no way to say "I could not do it": a device that answered
/// `{"result": "lock refused: …"}` was recorded as **acknowledged**, so the operator's console
/// showed a completed lock while the device was still unlocked. `ok: false` fixes that — and it
/// has to be **additive**, because the device agents live outside this repository.
#[tokio::test]
async fn a_device_that_reports_failure_is_not_recorded_as_acknowledged() {
    let admin = "test-admin-token";
    let app = fresh_router(admin).await;

    // Enroll one device.
    let (_, enroll) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/enroll")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "enrollmentToken": "AMOS-ENROLL-TOKEN-TEST",
                            "deviceId": "dev-fail",
                            "deviceName": "Failer",
                            "platform": "android",
                            "userAgent": "ua"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let key = enroll["data"]["apiKey"].as_str().unwrap().to_string();

    // Helper: the admin locks the device, then the device polls its own commands and answers the
    // single pending one. `lock` cancels nothing here because each round is acked before the next.
    let issue_lock = || async {
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/admin/devices/dev-fail/lock")
                    .header("authorization", format!("Bearer {admin}"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&json!({})).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (_, cmds) = body_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/mdm/commands?device_id=dev-fail")
                        .header("authorization", format!("Bearer {key}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        let pending = cmds["commands"].as_array().expect("commands array");
        assert_eq!(pending.len(), 1, "one pending command: {cmds}");
        pending[0]["id"].as_str().expect("cmd id").to_string()
    };

    // (1) The device reports **failure**. The server must record `failed`; before this field the
    //     only outcome the protocol could express was "acknowledged".
    let refused_cmd = issue_lock().await;
    let (status, failed) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/mdm/commands/{refused_cmd}/ack"))
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "deviceId": "dev-fail",
                            "ok": false,
                            "result": "lock refused: device policy forbids it"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "failed ack refused: {failed}");
    assert_eq!(
        failed["status"], "failed",
        "a reported failure must not be recorded as an acknowledgement: {failed}"
    );

    // (2) The legacy ack — **no `ok` field at all** — keeps its old meaning, because the device
    //     agents are not in this repository and must not break on the new field.
    let done_cmd = issue_lock().await;
    let (status, acked) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/mdm/commands/{done_cmd}/ack"))
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "deviceId": "dev-fail",
                            "result": "locked-screen-shown"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "legacy ack refused: {acked}");
    assert_eq!(
        acked["status"], "acknowledged",
        "the legacy ack must keep its meaning: {acked}"
    );

    // Both outcomes are terminal: the device is not asked to run either command again.
    let (_, after) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/mdm/commands?device_id=dev-fail")
                    .header("authorization", format!("Bearer {key}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        after["commands"].as_array().expect("commands array").len(),
        0,
        "nothing may stay pending after either outcome: {after}"
    );
}

// ========================================================================
// REQ-A1809 — the documented raw `<prefix><token>` auth form must authenticate
// ========================================================================

/// `state::extract_api_key`'s own doc (and `admin_auth.rs`) lists **two**
/// accepted device header forms: `Authorization: Bearer <key>` and the raw
/// `Authorization: <prefix><key>`. `enroll_device` stores the SHA-256 of the
/// **prefixed** key (`hash_key(prefix + token)`) and `validate_api_key` hashes
/// whatever string it is handed — so the raw branch must hand over the full
/// `<prefix><key>`, not the prefix-stripped remainder. Otherwise the documented
/// form can never authenticate. This walks the real router end-to-end.
#[tokio::test]
async fn the_documented_raw_prefix_header_form_authenticates() {
    let admin = "test-admin-token";
    let app = fresh_router(admin).await;

    // Enroll a device; the returned key is the full `<prefix><token>`.
    let (status, enroll) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/enroll")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "enrollmentToken": "AMOS-ENROLL-TOKEN-TEST",
                            "deviceId": "dev-raw-1",
                            "deviceName": "Raw Header Device",
                            "platform": "android",
                            "userAgent": "amos-e2e/1.0"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "enroll failed: {enroll}");
    let api_key = enroll["data"]["apiKey"]
        .as_str()
        .expect("apiKey present")
        .to_string();
    assert!(
        api_key.starts_with("amos_"),
        "the enrolled key carries the configured prefix, got {api_key:?}"
    );

    let sync_body = |app: axum::Router, auth: String| {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/mdm/sync")
                .header("authorization", auth)
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({ "deviceId": "dev-raw-1", "lastSyncAt": 0 }))
                        .unwrap(),
                ))
                .unwrap(),
        )
    };

    // The documented raw form: the header IS the full `<prefix><token>`.
    let (status, sync) = body_json(sync_body(app.clone(), api_key.clone()).await.unwrap()).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the documented raw <prefix><token> header must authenticate, got {status}: {sync}"
    );

    // Positive control: the `Bearer` form keeps working on the same device (so a
    // fix that broke `Bearer`, or one that merely accepted everything, is caught).
    let (status, sync) = body_json(
        sync_body(app.clone(), format!("Bearer {api_key}"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the Bearer form must keep working: {sync}"
    );

    // Negative control: a raw header with a wrong token must still 401 — the raw
    // branch checks the prefix, it does not blanket-accept any header.
    let (status, _) = body_json(sync_body(app, "amos_deadbeef".to_string()).await.unwrap()).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a raw header with a bad token must still be refused"
    );
}

// ========================================================================
// A `forced_shortcuts` policy is actually delivered to the device (REQ-A1808)
// ========================================================================

/// Enroll `device_id` and return its API key. Shared by the policy tests below.
async fn enroll(app: &axum::Router, device_id: &str) -> String {
    let (_, enroll) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/enroll")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "enrollmentToken": "AMOS-ENROLL-TOKEN-TEST",
                            "deviceId": device_id,
                            "deviceName": device_id,
                            "platform": "android",
                            "userAgent": "ua"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    enroll["data"]["apiKey"]
        .as_str()
        .expect("apiKey present")
        .to_string()
}

/// The admin creates one policy and returns the raw response.
async fn create_policy(app: &axum::Router, admin: &str, body: Value) -> (StatusCode, Value) {
    body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/admin/policies")
                    .header("authorization", format!("Bearer {admin}"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await
}

/// POST a sync for `device_id` with `api_key` and return its `config` object.
async fn sync_for(app: &axum::Router, device_id: &str, api_key: &str) -> Value {
    let (status, sync) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mdm/sync")
                    .header("authorization", format!("Bearer {api_key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "deviceId": device_id,
                            "lastSyncAt": 0
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "sync failed: {sync}");
    sync["config"].clone()
}

/// The operator pins two shortcuts with a `forced_shortcuts` policy; the device must
/// **receive** them. `create_policy` accepts and stores the policy type, and the client
/// gates its edit/delete affordances on `config.enforcedShortcuts.includes(id)` — but the
/// sync response hardcoded `enforcedShortcuts: []`, so that list was structurally empty
/// and every enforced shortcut stayed editable on the device.
#[tokio::test]
async fn a_forced_shortcuts_policy_reaches_the_device() {
    let admin = "test-admin-token";
    let app = fresh_router(admin).await;
    let key = enroll(&app, "dev-mdm-policy").await;

    let (status, created) = create_policy(
        &app,
        admin,
        json!({
            "type": "forced_shortcuts",
            "name": "Pin the payment shortcuts",
            "config": { "shortcuts": ["sc-pin-pay", "sc-pin-lock"] },
            "priority": 10
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "policy create failed: {created}");

    let config = sync_for(&app, "dev-mdm-policy", &key).await;
    assert_eq!(
        config["enforcedShortcuts"],
        json!(["sc-pin-pay", "sc-pin-lock"]),
        "the device must be told which shortcuts its organization pinned: {config}"
    );
    // The policy itself still rides along whole, so the device has the name/priority too.
    // (The default org seeds two unrelated policies, so filter rather than index.)
    let policies = config["policies"].as_array().expect("policies array");
    let pinned_policy = policies
        .iter()
        .find(|p| p["type"] == "forced_shortcuts")
        .expect("the pinned policy must still be delivered whole");
    assert_eq!(pinned_policy["name"], "Pin the payment shortcuts");
    assert_eq!(pinned_policy["priority"], 10);
}

/// Negative controls for the same derivation: only an **enabled** `forced_shortcuts`
/// policy contributes, and a policy of any other type contributes nothing. A union that
/// refused to distinguish these would pass the positive test above while enforcing
/// policies the organization turned off.
#[tokio::test]
async fn only_enabled_forced_shortcut_policies_are_enforced() {
    let admin = "test-admin-token";
    let app = fresh_router(admin).await;
    let key = enroll(&app, "dev-mdm-policy-nc").await;

    // (1) A *disabled* forced_shortcuts policy: created enabled, then switched off.
    let (_, pinned) = create_policy(
        &app,
        admin,
        json!({
            "type": "forced_shortcuts",
            "name": "off again",
            "config": { "shortcuts": ["sc-nope"] }
        }),
    )
    .await;
    let pinned_id = pinned["data"]["id"]
        .as_str()
        .expect("policy id")
        .to_string();
    assert_eq!(
        sync_for(&app, "dev-mdm-policy-nc", &key).await["enforcedShortcuts"],
        json!(["sc-nope"]),
        "an enabled policy must be enforced before we switch it off"
    );
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/admin/policies/{pinned_id}"))
                .header("authorization", format!("Bearer {admin}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({ "enabled": false })).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "disable failed");

    // (2) A policy of a *different* type, whose config happens to carry a `shortcuts` key.
    let (status, other) = create_policy(
        &app,
        admin,
        json!({
            "type": "data_retention",
            "name": "not a pin policy",
            "config": { "shortcuts": ["sc-impostor"] }
        }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "other policy create failed: {other}"
    );

    assert_eq!(
        sync_for(&app, "dev-mdm-policy-nc", &key).await["enforcedShortcuts"],
        json!([]),
        "a disabled policy and an unrelated policy type must both contribute nothing"
    );
}

/// A `forced_shortcuts` policy whose config cannot be read as a shortcut list is
/// **refused at creation** — never stored and then silently dropped from the sync,
/// which is the failure the device cannot distinguish from "nothing is pinned".
#[tokio::test]
async fn an_unusable_forced_shortcuts_config_is_refused_at_creation() {
    let admin = "test-admin-token";
    let app = fresh_router(admin).await;

    for bad in [
        json!({}),
        json!({ "shortcuts": "sc-pin-pay" }),
        json!({ "shortcuts": [1, 2] }),
        json!({ "shortcuts": ["  "] }),
    ] {
        let (status, resp) = create_policy(
            &app,
            admin,
            json!({ "type": "forced_shortcuts", "name": "broken", "config": bad }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "an unusable forced_shortcuts config must be refused, got {resp} for {bad}"
        );
        assert_eq!(resp["success"], false);
    }

    // Nothing was stored: the org has the two policies it was seeded with and no
    // `forced_shortcuts` policy among them.
    let (_, list) = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/admin/policies")
                    .header("authorization", format!("Bearer {admin}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert!(
        !list["data"]
            .as_array()
            .expect("data array")
            .iter()
            .any(|p| p["type"] == "forced_shortcuts"),
        "a refused policy must not be persisted: {list}"
    );
}
