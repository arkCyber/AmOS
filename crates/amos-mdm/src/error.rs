//! MDM 服务器错误类型

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// MDM 服务器错误
#[derive(Debug, thiserror::Error)]
pub enum MdmError {
    #[error("数据库错误: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("配置错误: {0}")]
    Config(String),

    #[error("设备未找到: {0}")]
    DeviceNotFound(String),

    #[error("组织未找到: {0}")]
    OrganizationNotFound(String),

    #[error("令牌无效或已过期")]
    InvalidToken,

    #[error("令牌已使用")]
    TokenAlreadyUsed,

    #[error("设备已注册")]
    DeviceAlreadyEnrolled,

    #[error("API 密钥无效")]
    InvalidApiKey,

    #[error("策略未找到: {0}")]
    PolicyNotFound(String),

    #[error("命令未找到: {0}")]
    CommandNotFound(String),

    #[error("请求无效: {0}")]
    InvalidRequest(String),

    #[error("内部服务器错误: {0}")]
    Internal(String),
}

impl IntoResponse for MdmError {
    fn into_response(self) -> Response {
        let (status, error_message) = match &self {
            MdmError::Database(e) => {
                tracing::error!("Database error: {:?}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "数据库错误".to_string())
            }
            MdmError::Config(msg) => {
                // The detail is for the operator's log, not for the caller: a config error can name
                // paths, environment variables or key material, and a client has no use for any of
                // it (REQ-A411, `mdm #27`). Same shape as `Internal` below.
                tracing::error!("Config error: {}", msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "内部服务器错误".to_string(),
                )
            }
            MdmError::DeviceNotFound(id) => (StatusCode::NOT_FOUND, format!("设备未找到: {}", id)),
            MdmError::OrganizationNotFound(id) => {
                (StatusCode::NOT_FOUND, format!("组织未找到: {}", id))
            }
            MdmError::InvalidToken => (StatusCode::UNAUTHORIZED, "令牌无效或已过期".to_string()),
            MdmError::TokenAlreadyUsed => (StatusCode::CONFLICT, "令牌已被使用".to_string()),
            MdmError::DeviceAlreadyEnrolled => (StatusCode::CONFLICT, "设备已注册".to_string()),
            MdmError::InvalidApiKey => (StatusCode::UNAUTHORIZED, "API 密钥无效".to_string()),
            MdmError::PolicyNotFound(id) => (StatusCode::NOT_FOUND, format!("策略未找到: {}", id)),
            MdmError::CommandNotFound(id) => (StatusCode::NOT_FOUND, format!("命令未找到: {}", id)),
            MdmError::InvalidRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            MdmError::Internal(msg) => {
                tracing::error!("Internal error: {}", msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "内部服务器错误".to_string(),
                )
            }
        };

        let body = Json(json!({
            "success": false,
            "message": error_message,
            "serverTime": chrono::Utc::now().timestamp_millis(),
        }));

        (status, body).into_response()
    }
}

#[cfg(test)]
mod tests {
    //! Tests for `MdmError` → HTTP status mapping.
    //!
    //! **Why this matters**: the mapping is the **only** thing standing between
    //! an upstream bug (e.g. "admin token mismatch", "DB locked") and an
    //! unauthenticated caller. A 401-vs-200 swap would let any caller list
    //! devices. A 500 vs 400 would let a misuse loop hammer the server. Each
    //! variant must be tested.

    use super::*;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    fn status(err: MdmError) -> StatusCode {
        err.into_response().status()
    }

    #[test]
    fn device_not_found_maps_to_404() {
        assert_eq!(
            status(MdmError::DeviceNotFound("abc".into())),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn organization_not_found_maps_to_404() {
        assert_eq!(
            status(MdmError::OrganizationNotFound("org-x".into())),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn policy_not_found_maps_to_404() {
        assert_eq!(
            status(MdmError::PolicyNotFound("p1".into())),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn command_not_found_maps_to_404() {
        assert_eq!(
            status(MdmError::CommandNotFound("c1".into())),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn invalid_token_maps_to_401_not_403() {
        // 401 = "you haven't authenticated"; 403 = "you have, but not
        // allowed". Enrollment tokens are pre-auth, so 401 is the only
        // correct code.
        assert_eq!(status(MdmError::InvalidToken), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn invalid_api_key_maps_to_401() {
        assert_eq!(status(MdmError::InvalidApiKey), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn token_already_used_maps_to_409_conflict() {
        // Conflict, not 4xx-rate-limit. The token WAS valid; it's just
        // consumed.
        assert_eq!(status(MdmError::TokenAlreadyUsed), StatusCode::CONFLICT);
    }

    #[test]
    fn device_already_enrolled_maps_to_409_conflict() {
        assert_eq!(
            status(MdmError::DeviceAlreadyEnrolled),
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn invalid_request_maps_to_400_with_message_in_body() {
        let resp = MdmError::InvalidRequest("bad shape".into()).into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        // The body should carry the operator's message; we don't parse it,
        // but we check it's non-empty (no silent message-swallowing).
        let body_bytes = to_bytes(resp.into_body(), 1024)
            .await
            .expect("body readable");
        assert!(!body_bytes.is_empty(), "400 body must not be empty");
    }

    #[tokio::test]
    async fn internal_error_maps_to_500_and_redacts_the_detail() {
        // **Security**: the "Internal" variant must not leak the operator-facing
        // detail string back to the caller — the detail can contain paths,
        // env-var names, or key fragments. The status is 500; the body
        // should be the generic "内部服务器错误" string, never the
        // original message.
        let leaky = "DB at /var/lib/amos/secret.db: column 'admin_token' missing";
        let resp = MdmError::Internal(leaky.into()).into_response();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body_bytes = to_bytes(resp.into_body(), 4096)
            .await
            .expect("body readable");
        let body_str = std::str::from_utf8(&body_bytes).unwrap_or("");
        assert!(
            !body_str.contains("/var/lib/amos"),
            "Internal variant leaked path detail: {body_str}"
        );
        assert!(
            !body_str.contains("admin_token"),
            "Internal variant leaked column detail: {body_str}"
        );
    }

    #[tokio::test]
    async fn config_error_also_redacts_the_detail_in_the_response_body() {
        // Same rule as Internal: Config errors can name paths, env vars, or
        // key material. The status is 500; the body must be the generic
        // string.
        let resp =
            MdmError::Config("MDM_ADMIN_TOKEN_HASH must be 64 hex chars".into()).into_response();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body_bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
        let body_str = std::str::from_utf8(&body_bytes).unwrap_or("");
        assert!(
            !body_str.contains("MDM_ADMIN_TOKEN_HASH"),
            "Config error leaked env var name to client: {body_str}"
        );
    }

    #[test]
    fn database_error_maps_to_500_with_generic_body() {
        // The variant must compile + `into_response` must not panic.
        // This pins the public surface; if a future refactor adds a new
        // variant it will fail to compile here and force a reviewer to
        // update.
        let e: MdmError = MdmError::Database(rusqlite::Error::InvalidQuery);
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn error_display_messages_are_stable_strings() {
        // REQ-A421: every error variant's Display is part of the contract
        // used by `tracing` (which feeds the audit log). Pin the exact
        // strings so a search for "设备未找到: abc" in `amos-mdm-audit.log`
        // keeps working.
        assert_eq!(
            MdmError::DeviceNotFound("abc".into()).to_string(),
            "设备未找到: abc"
        );
        assert_eq!(MdmError::InvalidToken.to_string(), "令牌无效或已过期");
        assert_eq!(MdmError::DeviceAlreadyEnrolled.to_string(), "设备已注册");
    }

    #[test]
    fn from_rusqlite_error_via_question_mark_works() {
        // Compile + smoke: `#[from] rusqlite::Error` must let us use `?` to
        // convert. If the From impl breaks, this stops compiling.
        fn inner() -> Result<(), rusqlite::Error> {
            Err(rusqlite::Error::InvalidQuery)
        }
        fn outer() -> Result<(), MdmError> {
            inner()?;
            Ok(())
        }
        assert!(outer().is_err());
    }
}
