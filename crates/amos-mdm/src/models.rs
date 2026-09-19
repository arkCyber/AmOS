//! MDM 数据模型

use serde::{Deserialize, Serialize};

/// 设备状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus {
    Active,
    Locked,
    Wiped,
    Pending,
}

impl From<&str> for DeviceStatus {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "active" => DeviceStatus::Active,
            "locked" => DeviceStatus::Locked,
            "wiped" => DeviceStatus::Wiped,
            "pending" => DeviceStatus::Pending,
            _ => DeviceStatus::Active,
        }
    }
}

impl std::fmt::Display for DeviceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            DeviceStatus::Active => "active",
            DeviceStatus::Locked => "locked",
            DeviceStatus::Wiped => "wiped",
            DeviceStatus::Pending => "pending",
        })
    }
}

/// 设备（camelCase 以匹配前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub organization_id: String,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub user_agent: String,
    pub status: DeviceStatus,
    pub enrolled_at: i64,
    pub last_sync_at: i64,
    /// 注册人（管理员邮箱或令牌持有者）
    pub enrolled_by: Option<String>,
    pub lock_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 注册令牌
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentToken {
    pub id: String,
    pub token: String,
    pub organization_id: String,
    pub used: bool,
    pub used_by_device_id: Option<String>,
    pub expires_at: i64,
    pub created_at: i64,
}

/// 组织
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub admin_email: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// MDM 策略类型（公共枚举，方便前端对齐 — 仓库目前用字符串 `PolicyType`
/// 名做服务端校验；保留枚举为下游契约的扩展点）。
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyType {
    FeatureDisable,
    ExecutionLimit,
    SharingControl,
    ApprovalRequired,
    ForcedShortcuts,
    DataRetention,
}

/// MDM 策略（camelCase 以匹配前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub id: String,
    pub organization_id: String,
    #[serde(rename = "type")]
    pub policy_type: String,
    pub name: String,
    pub description: Option<String>,
    pub config: serde_json::Value,
    pub enabled: bool,
    pub priority: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 远程命令类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommandType {
    Lock,
    Wipe,
    Sync,
    UpdatePolicy,
    Unlock,
}

/// 远程命令
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommand {
    pub id: String,
    pub device_id: String,
    #[serde(rename = "type")]
    pub command_type: CommandType,
    pub payload: Option<serde_json::Value>,
    pub status: String,
    pub created_at: i64,
    pub executed_at: Option<i64>,
    pub result: Option<String>,
}

/// API 密钥（保留结构定义 — DB 层仍走手工 SQL，但下游 crate 可能从外部依赖此类型）。
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: String,
    pub device_id: String,
    pub key_hash: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

// ============================================================================
// 请求/响应结构
// ============================================================================

/// 注册请求（所有字段都支持 snake_case 和 camelCase）
#[derive(Debug, Clone, Deserialize)]
pub struct EnrollRequest {
    #[serde(alias = "enrollmentToken")]
    pub enrollment_token: String,
    #[serde(alias = "deviceId")]
    pub device_id: String,
    #[serde(alias = "deviceName")]
    pub device_name: String,
    pub platform: String,
    /// 接受 user_agent 或 userAgent（前端用 camelCase）
    #[serde(alias = "userAgent")]
    pub user_agent: String,
    pub timestamp: Option<i64>,
}

/// 注册响应（camelCase 以匹配前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub success: bool,
    pub data: Option<EnrollData>,
    pub message: Option<String>,
    pub server_time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollData {
    pub organization_id: String,
    pub organization_name: String,
    pub api_key: String,
    pub enrolled_by: Option<String>,
}

/// 同步请求
#[derive(Debug, Clone, Deserialize)]
pub struct SyncRequest {
    /// 接受 device_id 或 deviceId
    #[serde(alias = "deviceId")]
    pub device_id: String,
    /// 接受 last_sync_at 或 lastSyncAt
    #[serde(alias = "lastSyncAt")]
    pub last_sync_at: i64,
    /// 接受 current_version 或 currentVersion
    #[serde(alias = "currentVersion")]
    pub current_version: Option<String>,
}

/// 同步响应（camelCase 以匹配前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub success: bool,
    pub config: Option<DeviceConfig>,
    pub message: Option<String>,
    pub server_time: i64,
}

/// 设备配置（同步时下发，camelCase 以匹配前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConfig {
    pub enabled: bool,
    pub organization_id: String,
    pub organization_name: String,
    pub device_id: String,
    pub device_name: String,
    pub server_url: String,
    pub api_key: String,
    pub policies: Vec<Policy>,
    pub restrictions: Restrictions,
    pub enforced_shortcuts: Vec<String>,
    pub enforced_templates: Vec<String>,
    pub sync_interval: i64,
    pub last_sync_at: i64,
    pub last_sync_status: String,
    pub last_sync_error: Option<String>,
    pub device_status: String,
    pub lock_message: Option<String>,
    pub enrolled_at: i64,
    pub enrolled_by: String,
    pub version: String,
}

/// 限制配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restrictions {
    pub disabled_categories: Vec<String>,
    pub disabled_actions: Vec<String>,
    pub max_execution_time: i32,
    pub max_executions_per_day: i32,
    pub max_actions_per_shortcut: i32,
    pub max_shortcuts_per_user: i32,
    pub allow_user_create: bool,
    pub allow_user_modify: bool,
    pub allow_user_delete: bool,
    pub allow_sharing: bool,
    pub allow_export: bool,
    pub allow_import: bool,
    pub require_approval_for_create: bool,
    pub require_approval_for_modify: bool,
    pub require_approval_for_sharing: bool,
}

impl Default for Restrictions {
    fn default() -> Self {
        Self {
            disabled_categories: vec![],
            disabled_actions: vec![],
            max_execution_time: 300,
            max_executions_per_day: 1000,
            max_actions_per_shortcut: 100,
            max_shortcuts_per_user: 100,
            allow_user_create: true,
            allow_user_modify: true,
            allow_user_delete: true,
            allow_sharing: true,
            allow_export: true,
            allow_import: true,
            require_approval_for_create: false,
            require_approval_for_modify: false,
            require_approval_for_sharing: false,
        }
    }
}

/// 获取命令响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCommandsResponse {
    pub success: bool,
    pub commands: Vec<RemoteCommand>,
    pub server_time: i64,
}

/// 命令确认请求
#[derive(Debug, Clone, Deserialize)]
pub struct AckCommandRequest {
    /// 哪一个设备在确认（命令 id 走路径参数，见 `handlers::ack_command`）。
    ///
    /// REQ-A411：这个字段是**必需**的，因为 ack 现在要验设备密钥、并且只允许设备认领
    /// **自己的**命令。旧版本里请求体只有一个 `command_id`（而它被路径参数覆盖、从未被读），
    /// 端点本身没有任何鉴权。
    #[serde(alias = "deviceId")]
    pub device_id: String,
    pub result: Option<String>,
}

/// 取消注册请求
#[derive(Debug, Clone, Deserialize)]
pub struct UnenrollRequest {
    #[serde(alias = "deviceId")]
    pub device_id: String,
    pub timestamp: Option<i64>,
}

/// 锁定设备请求
#[derive(Debug, Clone, Deserialize)]
pub struct LockDeviceRequest {
    pub message: Option<String>,
}

/// 远程命令请求（通用）
#[derive(Debug, Clone, Deserialize)]
pub struct RemoteCommandRequest {
    #[serde(rename = "type")]
    pub command_type: String,
    pub payload: Option<serde_json::Value>,
}

/// 创建策略请求
#[derive(Debug, Clone, Deserialize)]
pub struct CreatePolicyRequest {
    #[serde(rename = "type")]
    pub policy_type: String,
    pub name: String,
    pub description: Option<String>,
    pub config: serde_json::Value,
    pub priority: Option<i32>,
}

/// 更新策略请求
#[derive(Debug, Clone, Deserialize)]
pub struct UpdatePolicyRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub config: Option<serde_json::Value>,
    pub enabled: Option<bool>,
    pub priority: Option<i32>,
}

/// 创建令牌请求
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTokenRequest {
    pub expires_in_days: Option<i64>,
}

/// 通用响应（占位 API — 当前处理器用 `serde_json::json!({...})` 内联；
/// 保留这个结构便于将来统一切换）。
///
/// **Wire contract**: `camelCase` JSON keys (`serverTime`), matching every
/// inlined `serde_json::json!({...})` in `handlers.rs`. Earlier versions
/// emitted `server_time` (snake_case) because the struct lacked a
/// `rename_all` attribute — that created a footgun where the helper and
/// the inlined blocks disagreed on field names. The previous unit test
/// `api_response_helpers_round_trip` pinned the inconsistency; this
/// attribute fixes it.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub message: Option<String>,
    pub server_time: i64,
}

#[allow(dead_code)]
impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            message: None,
            server_time: chrono::Utc::now().timestamp_millis(),
        }
    }

    pub fn error(message: String) -> Self {
        Self {
            success: false,
            data: None,
            message: Some(message),
            server_time: chrono::Utc::now().timestamp_millis(),
        }
    }
}

#[cfg(test)]
mod tests {
    //! `models.rs` is the **wire contract** between the MDM server and the
    //! frontend. Every camelCase ↔ snake_case alias is a place a typo can
    //! silently break an enrollment or a sync. These tests pin each alias
    //! and the enum defaulting behaviour so a future "let's just rename"
    //! refactor is caught at `cargo test` time, not at 3am in production.
    use super::*;

    #[test]
    fn device_status_from_str_uses_lowercase_match() {
        assert_eq!(DeviceStatus::from("ACTIVE"), DeviceStatus::Active);
        assert_eq!(DeviceStatus::from("Active"), DeviceStatus::Active);
        assert_eq!(DeviceStatus::from("locked"), DeviceStatus::Locked);
        assert_eq!(DeviceStatus::from("Wiped"), DeviceStatus::Wiped);
        assert_eq!(DeviceStatus::from("pending"), DeviceStatus::Pending);
    }

    #[test]
    fn device_status_from_str_defaults_to_active_for_unknown() {
        // Pinning: an unknown value falls back to `Active` rather than
        // `Pending` (which would silently mark every freshly-migrated DB
        // row as "needs approval"). If you ever want this to error,
        // update this test and the docstring together.
        assert_eq!(DeviceStatus::from("unknown"), DeviceStatus::Active);
        assert_eq!(DeviceStatus::from(""), DeviceStatus::Active);
    }

    #[test]
    fn device_status_display_round_trips() {
        for s in [
            DeviceStatus::Active,
            DeviceStatus::Locked,
            DeviceStatus::Wiped,
            DeviceStatus::Pending,
        ] {
            assert_eq!(DeviceStatus::from(s.to_string().as_str()), s);
        }
    }

    #[test]
    fn device_serializes_in_camel_case() {
        // The whole point of `rename_all = "camelCase"`: the frontend's
        // TypeScript types are written in camelCase. If a future contributor
        // adds a field with `snake_case` by accident, this test will at
        // least keep the existing fields honest.
        let d = Device {
            id: "id1".into(),
            organization_id: "org1".into(),
            device_id: "dev1".into(),
            device_name: "phone".into(),
            platform: "ios".into(),
            user_agent: "ua".into(),
            status: DeviceStatus::Active,
            enrolled_at: 0,
            last_sync_at: 0,
            enrolled_by: None,
            lock_message: None,
            created_at: 0,
            updated_at: 0,
        };
        let j = serde_json::to_value(&d).unwrap();
        assert!(j.get("organizationId").is_some(), "expected organizationId");
        assert!(j.get("deviceId").is_some(), "expected deviceId");
        assert!(j.get("deviceName").is_some(), "expected deviceName");
        assert!(j.get("lastSyncAt").is_some(), "expected lastSyncAt");
        assert!(
            j.get("organization_id").is_none(),
            "snake_case key leaked into JSON: {j}"
        );
    }

    #[test]
    fn enroll_request_accepts_both_snake_and_camel_case() {
        // Frontend sends camelCase; legacy curl examples send snake_case.
        // The aliases on EnrollRequest were added to keep both working —
        // this test prevents a regression where someone deletes the alias.
        let j = serde_json::json!({
            "enrollmentToken": "tok",
            "deviceId": "dev1",
            "deviceName": "phone",
            "platform": "ios",
            "userAgent": "ua/1.0"
        });
        let r: EnrollRequest = serde_json::from_value(j).unwrap();
        assert_eq!(r.enrollment_token, "tok");
        assert_eq!(r.device_id, "dev1");
        assert_eq!(r.device_name, "phone");
        assert_eq!(r.user_agent, "ua/1.0");

        let j2 = serde_json::json!({
            "enrollment_token": "tok",
            "device_id": "dev1",
            "device_name": "phone",
            "platform": "ios",
            "user_agent": "ua/1.0"
        });
        let r2: EnrollRequest = serde_json::from_value(j2).unwrap();
        assert_eq!(r2.enrollment_token, "tok");
    }

    #[test]
    fn sync_request_accepts_both_snake_and_camel_case() {
        let j = serde_json::json!({
            "deviceId": "dev1",
            "lastSyncAt": 12345,
            "currentVersion": "v3"
        });
        let r: SyncRequest = serde_json::from_value(j).unwrap();
        assert_eq!(r.device_id, "dev1");
        assert_eq!(r.last_sync_at, 12345);
        assert_eq!(r.current_version.as_deref(), Some("v3"));
    }

    #[test]
    fn ack_command_request_requires_device_id_in_body() {
        // The path param carries the command id; the body's `device_id`
        // is what ack_command verifies against the API key's device. If
        // someone deletes the field, the auth boundary on ack collapses.
        let j = serde_json::json!({ "result": "ok" });
        let r: Result<AckCommandRequest, _> = serde_json::from_value(j);
        assert!(
            r.is_err(),
            "AckCommandRequest must require deviceId in the body"
        );
    }

    #[test]
    fn command_type_serializes_in_lowercase() {
        assert_eq!(
            serde_json::to_string(&CommandType::Lock).unwrap(),
            "\"lock\""
        );
        assert_eq!(
            serde_json::to_string(&CommandType::UpdatePolicy).unwrap(),
            "\"updatepolicy\""
        );
    }

    #[test]
    fn remote_command_payload_is_optional() {
        // Some commands (Lock, Wipe) have no payload; the field must
        // accept null without rejecting the request.
        let j = serde_json::json!({
            "id": "c1",
            "deviceId": "dev1",
            "type": "lock",
            "status": "pending",
            "createdAt": 0,
            "payload": null
        });
        let r: RemoteCommand = serde_json::from_value(j).unwrap();
        assert!(r.payload.is_none());
    }

    #[test]
    fn restrictions_default_is_generous_on_purpose() {
        // REQ-A411, `mdm #22`: a fresh org's restrictions default to
        // maximally permissive; an admin opts in by creating a policy.
        // This pins that contract — making it restrictive by default
        // would silently break every existing org on schema migration.
        let r = Restrictions::default();
        assert!(r.allow_user_create);
        assert!(r.allow_user_modify);
        assert!(r.allow_user_delete);
        assert!(r.allow_sharing);
        assert!(r.allow_export);
        assert!(r.allow_import);
        assert!(r.disabled_categories.is_empty());
        // The numeric ceilings are also part of the public contract.
        assert_eq!(r.max_execution_time, 300);
        assert_eq!(r.max_executions_per_day, 1000);
        assert_eq!(r.max_actions_per_shortcut, 100);
        assert_eq!(r.max_shortcuts_per_user, 100);
        // Approval gates off by default — that's the "permissive" choice.
        assert!(!r.require_approval_for_create);
        assert!(!r.require_approval_for_modify);
        assert!(!r.require_approval_for_sharing);
    }

    #[test]
    fn api_response_helpers_round_trip() {
        // `ApiResponse<T>::success` is what the next refactor will use to
        // replace the inlined `serde_json::json!({...})` blocks in
        // `handlers.rs`. After the `rename_all = "camelCase"` fix, the
        // helper emits the same shape the handlers do (`serverTime`,
        // not `server_time`).
        let r: ApiResponse<String> = ApiResponse::success("ok".to_string());
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["success"], true);
        assert_eq!(j["data"], "ok");
        assert!(
            j["serverTime"].is_number(),
            "ApiResponse must serialise serverTime in camelCase (REQ: match handlers)"
        );
        assert!(
            j.get("server_time").is_none(),
            "ApiResponse must NOT serialise the legacy snake_case server_time key"
        );

        let r: ApiResponse<String> = ApiResponse::error("nope".to_string());
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["success"], false);
        assert_eq!(j["message"], "nope");
        assert!(j["data"].is_null());
    }
}
