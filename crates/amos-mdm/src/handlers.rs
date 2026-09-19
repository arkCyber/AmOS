//! API 路由处理函数

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;

use crate::db::{check_page, EnrollParams, DEFAULT_LIST_LIMIT};
use crate::error::MdmError;
use crate::models::*;
use crate::state::extract_api_key;
use crate::state::AppState;

// ========================================================================
// 健康检查
// ========================================================================

/// GET /health
pub async fn health_check() -> &'static str {
    "OK"
}

// ========================================================================
// 设备端点（由设备调用）
// ========================================================================

/// POST /api/mdm/enroll
/// 设备注册
pub async fn enroll_device(
    State(state): State<AppState>,
    Json(req): Json<EnrollRequest>,
) -> Result<Json<EnrollResponse>, MdmError> {
    // 先拒绝形状不对的输入（REQ-A411，`mdm #19`）：这些字段会直接落库并原样回显，
    // 不设上限等于让一个**未认证**的调用者决定服务器要存多少字节。
    validate_enroll_request(&req)?;

    // 令牌属于哪个组织，设备就落在哪个组织；管理员邮箱作为 enrolled_by 落库。
    let token = state
        .db
        .get_enrollment_token(&req.enrollment_token)
        .await?
        .ok_or(MdmError::InvalidToken)?;
    let org = state
        .db
        .get_organization(&token.organization_id)
        .await?
        .ok_or_else(|| MdmError::OrganizationNotFound(token.organization_id.clone()))?;

    // 认领令牌 + 写设备 + 签 API 密钥 = **一个事务**（REQ-A411，`mdm #12–#14`）。
    // 这里刻意**不**先读 `used` 再写：那个检查是竞态；判定的唯一依据是 claim 那条
    // 条件 UPDATE 的受影响行数（`WHERE used = 0 AND expires_at >= ?`）。
    let enrolled = state
        .db
        .enroll_device(
            EnrollParams {
                organization_id: &token.organization_id,
                enrollment_token: &req.enrollment_token,
                device_id: &req.device_id,
                device_name: &req.device_name,
                platform: &req.platform,
                user_agent: &req.user_agent,
                enrolled_by: Some(org.admin_email.as_str()),
            },
            &state.config,
            chrono::Utc::now().timestamp_millis(),
        )
        .await?;

    tracing::info!(
        "Device enrolled: {} ({}) in organization {}",
        enrolled.device.device_name,
        enrolled.device.device_id,
        org.name
    );

    Ok(Json(EnrollResponse {
        success: true,
        data: Some(EnrollData {
            organization_id: org.id,
            organization_name: org.name,
            api_key: enrolled.api_key,
            enrolled_by: enrolled.device.enrolled_by,
        }),
        message: None,
        server_time: chrono::Utc::now().timestamp_millis(),
    }))
}

/// POST /api/mdm/sync
/// 设备同步配置
pub async fn sync_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, MdmError> {
    // 验证 API 密钥
    let auth_key = extract_api_key(
        headers.get("Authorization").and_then(|v| v.to_str().ok()),
        &state.config,
    );

    let api_key = auth_key.ok_or(MdmError::InvalidApiKey)?;
    if !state.db.validate_api_key(&req.device_id, &api_key).await? {
        return Err(MdmError::InvalidApiKey);
    }

    // 获取设备
    let device = state
        .db
        .get_device(&req.device_id)
        .await?
        .ok_or_else(|| MdmError::DeviceNotFound(req.device_id.clone()))?;

    // 获取组织
    let org = state
        .db
        .get_organization(&device.organization_id)
        .await?
        .ok_or_else(|| MdmError::OrganizationNotFound(device.organization_id.clone()))?;

    // 更新设备同步时间
    state.db.update_device_sync(&req.device_id).await?;

    // 获取策略
    let policies = state
        .db
        .get_policies(&device.organization_id, DEFAULT_LIST_LIMIT, 0)
        .await?;

    // 检查是否有待处理的命令
    let commands = state
        .db
        .get_pending_commands(&req.device_id, DEFAULT_LIST_LIMIT)
        .await?;
    let has_pending_commands = !commands.is_empty();

    // 构建响应配置
    let config = DeviceConfig {
        enabled: true,
        organization_id: org.id.clone(),
        organization_name: org.name.clone(),
        device_id: device.device_id.clone(),
        device_name: device.device_name.clone(),
        server_url: format!("http://{}", state.config.listen_address),
        api_key,
        policies,
        restrictions: Restrictions::default(),
        enforced_shortcuts: vec![],
        enforced_templates: vec![],
        sync_interval: state.config.default_sync_interval as i64,
        last_sync_at: device.last_sync_at,
        last_sync_status: if has_pending_commands {
            "pending_commands"
        } else {
            "success"
        }
        .to_string(),
        last_sync_error: None,
        device_status: device.status.to_string(),
        lock_message: device.lock_message.clone(),
        enrolled_at: device.enrolled_at,
        enrolled_by: "admin".to_string(),
        version: "1.0.0".to_string(),
    };

    tracing::debug!("Device synced: {}", device.device_id);

    Ok(Json(SyncResponse {
        success: true,
        config: Some(config),
        message: None,
        server_time: chrono::Utc::now().timestamp_millis(),
    }))
}

/// GET /api/mdm/commands
/// 获取待处理命令
pub async fn get_commands(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CommandsQuery>,
) -> Result<Json<GetCommandsResponse>, MdmError> {
    // 验证 API 密钥
    let auth_key = extract_api_key(
        headers.get("Authorization").and_then(|v| v.to_str().ok()),
        &state.config,
    );

    let api_key = auth_key.ok_or(MdmError::InvalidApiKey)?;
    if !state
        .db
        .validate_api_key(&params.device_id, &api_key)
        .await?
    {
        return Err(MdmError::InvalidApiKey);
    }

    // 获取待处理命令
    let commands = state
        .db
        .get_pending_commands(&params.device_id, DEFAULT_LIST_LIMIT)
        .await?;

    Ok(Json(GetCommandsResponse {
        success: true,
        commands,
        server_time: chrono::Utc::now().timestamp_millis(),
    }))
}

#[derive(Deserialize)]
pub struct CommandsQuery {
    pub device_id: String,
}

/// POST /api/mdm/commands/:id/ack
/// 确认命令执行结果
pub async fn ack_command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(command_id): Path<String>,
    Json(req): Json<AckCommandRequest>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 与同组其它设备端点（`sync_device` / `get_commands` / `unenroll_device`）一致：先验设备密钥。
    // 旧实现**完全没有鉴权**：任何未认证的调用者都能把任意命令标成 `acknowledged`，并把任意
    // 文本写进运维看到的 `result` —— 既是越权，也是审计污染（REQ-A411）。
    let api_key = extract_api_key(
        headers.get("Authorization").and_then(|v| v.to_str().ok()),
        &state.config,
    )
    .ok_or(MdmError::InvalidApiKey)?;
    if !state.db.validate_api_key(&req.device_id, &api_key).await? {
        return Err(MdmError::InvalidApiKey);
    }

    // 只认领**这个设备自己的**命令；不是它的，就与不存在同答（404，不泄露存在性）。
    if !state
        .db
        .ack_command(&command_id, &req.device_id, req.result.as_deref())
        .await?
    {
        return Err(MdmError::CommandNotFound(command_id));
    }

    tracing::info!("Command acknowledged: {} by {}", command_id, req.device_id);

    Ok(Json(serde_json::json!({
        "success": true,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// POST /api/mdm/unenroll
/// 取消注册设备
pub async fn unenroll_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UnenrollRequest>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 验证 API 密钥
    let auth_key = extract_api_key(
        headers.get("Authorization").and_then(|v| v.to_str().ok()),
        &state.config,
    );

    let api_key = auth_key.ok_or(MdmError::InvalidApiKey)?;
    if !state.db.validate_api_key(&req.device_id, &api_key).await? {
        return Err(MdmError::InvalidApiKey);
    }

    // 删除设备
    state.db.delete_device(&req.device_id).await?;

    tracing::info!("Device unenrolled: {}", req.device_id);

    Ok(Json(serde_json::json!({
        "success": true,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

// ========================================================================
// 管理端点（由管理员调用）
// ========================================================================

/// GET /api/admin/devices
/// 列出所有设备
pub async fn list_devices(
    State(state): State<AppState>,
    Query(page): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, MdmError> {
    let (limit, offset) = check_page(page.limit, page.offset)?;
    let org = state.db.get_default_organization().await?;
    let devices = state.db.list_devices(&org.id, limit, offset).await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "data": devices,
        "limit": limit,
        "offset": offset,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// POST /api/admin/devices/:device_id/lock
/// 锁定设备
pub async fn lock_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    Json(req): Json<LockDeviceRequest>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 验证设备存在
    state
        .db
        .get_device(&device_id)
        .await?
        .ok_or_else(|| MdmError::DeviceNotFound(device_id.clone()))?;

    // 先撤销该设备的所有 pending 命令（防止一个 lock 命令被重复 ack）
    let cancelled = state.db.cancel_pending_commands(&device_id).await?;
    if cancelled > 0 {
        tracing::debug!(
            "Cancelled {} pending commands before lock for device {}",
            cancelled,
            device_id
        );
    }

    // 创建锁定命令
    let payload = serde_json::json!({ "message": req.message });
    let command = state
        .db
        .create_command(&device_id, "lock", Some(&payload))
        .await?;

    // 更新设备状态
    state
        .db
        .update_device_status(&device_id, &DeviceStatus::Locked, req.message.as_deref())
        .await?;

    tracing::info!("Device locked: {}", device_id);

    Ok(Json(serde_json::json!({
        "success": true,
        "data": command,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// POST /api/admin/devices/:device_id/unlock
/// 解锁设备（管理员撤销锁定）
pub async fn unlock_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 验证设备存在
    state
        .db
        .get_device(&device_id)
        .await?
        .ok_or_else(|| MdmError::DeviceNotFound(device_id.clone()))?;

    // 撤销该设备的所有 pending 命令
    let cancelled = state.db.cancel_pending_commands(&device_id).await?;

    // 恢复设备状态为 active
    state
        .db
        .update_device_status(&device_id, &DeviceStatus::Active, None)
        .await?;

    tracing::info!(
        "Device unlocked: {}, {} pending commands cancelled",
        device_id,
        cancelled
    );

    Ok(Json(serde_json::json!({
        "success": true,
        "cancelledCommands": cancelled,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// POST /api/admin/devices/:device_id/wipe
/// 远程擦除设备
pub async fn wipe_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 验证设备存在
    state
        .db
        .get_device(&device_id)
        .await?
        .ok_or_else(|| MdmError::DeviceNotFound(device_id.clone()))?;

    // 先撤销所有 pending 命令（wipe 不应与其他命令共存）
    let cancelled = state.db.cancel_pending_commands(&device_id).await?;

    // 创建擦除命令
    let command = state.db.create_command(&device_id, "wipe", None).await?;

    // 更新设备状态
    state
        .db
        .update_device_status(&device_id, &DeviceStatus::Wiped, None)
        .await?;

    tracing::info!(
        "Device wipe command sent: {}, {} pending commands cancelled",
        device_id,
        cancelled
    );

    Ok(Json(serde_json::json!({
        "success": true,
        "data": command,
        "cancelledCommands": cancelled,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// POST /api/admin/devices/:device_id/policy
/// 为设备设置自定义策略
pub async fn set_device_policy(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    Json(req): Json<RemoteCommandRequest>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 验证设备存在
    state
        .db
        .get_device(&device_id)
        .await?
        .ok_or_else(|| MdmError::DeviceNotFound(device_id.clone()))?;

    // 创建策略更新命令
    let command = state
        .db
        .create_command(&device_id, "update_policy", req.payload.as_ref())
        .await?;

    tracing::info!("Device policy update command sent: {}", device_id);

    Ok(Json(serde_json::json!({
        "success": true,
        "data": command,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

// ========================================================================
// 策略管理端点
// ========================================================================

/// GET /api/admin/policies
/// 列出所有策略
pub async fn list_policies(
    State(state): State<AppState>,
    Query(page): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, MdmError> {
    let (limit, offset) = check_page(page.limit, page.offset)?;
    let org = state.db.get_default_organization().await?;
    let policies = state.db.get_policies(&org.id, limit, offset).await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "data": policies,
        "limit": limit,
        "offset": offset,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// POST /api/admin/policies
/// 创建策略
pub async fn create_policy(
    State(state): State<AppState>,
    Json(req): Json<CreatePolicyRequest>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 输入校验：policy_type 必须是合法值
    let valid_types = [
        "feature_disable",
        "execution_limit",
        "sharing_control",
        "approval_required",
        "forced_shortcuts",
        "data_retention",
    ];
    if !valid_types.contains(&req.policy_type.as_str()) {
        return Err(MdmError::InvalidRequest(format!(
            "Invalid policy_type '{}'. Must be one of: {}",
            req.policy_type,
            valid_types.join(", ")
        )));
    }

    let org = state.db.get_default_organization().await?;

    let policy = state
        .db
        .create_policy(
            &org.id,
            &req.policy_type,
            &req.name,
            req.description.as_deref(),
            &req.config,
            req.priority.unwrap_or(0),
        )
        .await?;

    tracing::info!("Policy created: {} ({})", policy.name, policy.id);

    Ok(Json(serde_json::json!({
        "success": true,
        "data": policy,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// PUT /api/admin/policies/:id
/// 更新策略
pub async fn update_policy(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdatePolicyRequest>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 获取现有策略
    let existing = state
        .db
        .get_policy(&id)
        .await?
        .ok_or_else(|| MdmError::PolicyNotFound(id.clone()))?;

    // 更新
    state
        .db
        .update_policy(
            &id,
            req.name.as_deref(),
            req.description.as_deref(),
            req.config.as_ref(),
            req.enabled,
            req.priority,
        )
        .await?;

    // 获取更新后的策略
    let policy = state.db.get_policy(&id).await?.unwrap_or(existing);

    tracing::info!("Policy updated: {} ({})", policy.name, policy.id);

    Ok(Json(serde_json::json!({
        "success": true,
        "data": policy,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// DELETE /api/admin/policies/:id
/// 删除策略
pub async fn delete_policy(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, MdmError> {
    // 先检查策略是否存在（不能静默失败）
    state
        .db
        .get_policy(&id)
        .await?
        .ok_or_else(|| MdmError::PolicyNotFound(id.clone()))?;

    state.db.delete_policy(&id).await?;

    tracing::info!("Policy deleted: {}", id);

    Ok(Json(serde_json::json!({
        "success": true,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

// ========================================================================
// 令牌管理端点
// ========================================================================

/// GET /api/admin/tokens
/// 列出所有注册令牌
pub async fn list_tokens(
    State(state): State<AppState>,
    Query(page): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, MdmError> {
    let (limit, offset) = check_page(page.limit, page.offset)?;
    let tokens = state.db.list_tokens(limit, offset).await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "data": tokens,
        "limit": limit,
        "offset": offset,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

/// POST /api/admin/tokens
/// 创建新注册令牌
pub async fn create_token(
    State(state): State<AppState>,
    Json(req): Json<CreateTokenRequest>,
) -> Result<Json<serde_json::Value>, MdmError> {
    let org = state.db.get_default_organization().await?;
    // 有效期**先校验**再乘：`i64::MAX` 天在 debug 会 panic、在 release 会回绕成一个过去的
    // 时刻（一个"看起来成功但立刻过期"的令牌）——见 `token_lifetime_ms`（REQ-A411，`mdm #21`）。
    let expires_ms = token_lifetime_ms(req.expires_in_days)?;

    let token = state.db.create_token(&org.id, expires_ms).await?;

    tracing::info!("Enrollment token created: {}", token.token);

    Ok(Json(serde_json::json!({
        "success": true,
        "data": token,
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })))
}

// ========================================================================
// 输入校验（纯函数：可在没有 HTTP 的情况下测试）
// ========================================================================

/// `?limit=&offset=` —— 管理端列表的分页窗口。
///
/// 缺省时用 [`DEFAULT_LIST_LIMIT`]；越界由 [`check_page`] **拒绝**（400），不是静默裁剪，
/// 响应会把真正生效的 `limit`/`offset` 回显出来，客户端据此翻页（REQ-A411，`mdm #32`）。
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// 令牌有效期的默认值（天）。
const DEFAULT_TOKEN_DAYS: i64 = 7;

/// 令牌有效期的上限（天）：一年足够任何真实部署，更大的值只可能是调用方算错了。
pub const MAX_TOKEN_DAYS: i64 = 365;

/// `expiresInDays` → 毫秒，越界**拒绝**而不是静默纠正（REQ-A411，`mdm #21`）。
///
/// 旧写法是 `days.unwrap_or(7) * 24 * 60 * 60 * 1000`：`i64::MAX` 的入参在 debug 构建里
/// 直接 panic（overflow），在 release 里回绕成过去的时刻 —— 也就是一个“看起来成功、却立刻
/// 过期”的令牌。现在把窗口写死在 `1..=365` 天，并用 `checked_mul` 兜底。
pub fn token_lifetime_ms(expires_in_days: Option<i64>) -> Result<i64, MdmError> {
    let days = expires_in_days.unwrap_or(DEFAULT_TOKEN_DAYS);
    if !(1..=MAX_TOKEN_DAYS).contains(&days) {
        return Err(MdmError::InvalidRequest(format!(
            "expiresInDays must be 1..={MAX_TOKEN_DAYS}, got {days}"
        )));
    }
    days.checked_mul(86_400_000).ok_or_else(|| {
        // Unreachable while the window above holds (`365 * 86_400_000` is ~3.2e10): kept as the
        // arithmetic's own guard so widening the window cannot silently reintroduce #21.
        MdmError::InvalidRequest(format!("expiresInDays overflows: {days}"))
    })
}

/// 注册请求的字段上限：`deviceName` 之类会原样回显给控制台。
const MAX_FIELD_CHARS: usize = 128;
/// `userAgent` 是唯一允许长一点的字段（真实 UA 串可以很长）。
const MAX_USER_AGENT_CHARS: usize = 512;

/// 注册请求的形状校验（REQ-A411，`mdm #19`）。
///
/// 这些字段直接落库、也直接出现在管理端的 JSON 里，所以一个**未认证**的调用者能决定服务器
/// 存多少字节 —— 不设上限就是一条免费的存储放大路径。空值与超长值都拒绝（400）。
pub fn validate_enroll_request(req: &EnrollRequest) -> Result<(), MdmError> {
    let fields = [
        (
            "enrollmentToken",
            req.enrollment_token.as_str(),
            MAX_FIELD_CHARS,
        ),
        ("deviceId", req.device_id.as_str(), MAX_FIELD_CHARS),
        ("deviceName", req.device_name.as_str(), MAX_FIELD_CHARS),
        ("platform", req.platform.as_str(), MAX_FIELD_CHARS),
        ("userAgent", req.user_agent.as_str(), MAX_USER_AGENT_CHARS),
    ];
    for (name, value, max) in fields {
        if value.trim().is_empty() {
            return Err(MdmError::InvalidRequest(format!(
                "{name} must not be empty"
            )));
        }
        if value.chars().count() > max {
            return Err(MdmError::InvalidRequest(format!(
                "{name} is longer than {max} characters"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(user_agent: &str) -> EnrollRequest {
        EnrollRequest {
            enrollment_token: "TOKEN".to_string(),
            device_id: "device-1".to_string(),
            device_name: "Pixel".to_string(),
            platform: "android".to_string(),
            user_agent: user_agent.to_string(),
            timestamp: None,
        }
    }

    #[test]
    fn a_token_lifetime_is_bounded_and_never_wraps() {
        assert_eq!(token_lifetime_ms(None).expect("default"), 7 * 86_400_000);
        assert_eq!(token_lifetime_ms(Some(1)).expect("one day"), 86_400_000);
        assert_eq!(
            token_lifetime_ms(Some(MAX_TOKEN_DAYS)).expect("the ceiling"),
            MAX_TOKEN_DAYS * 86_400_000
        );
        // The four ways the old arithmetic misbehaved: a negative window, a zero window, one day
        // over the ceiling, and an overflow. All four are refusals now — and `i64::MAX` is the one
        // that used to panic in a debug build.
        for bad in [0, -1, MAX_TOKEN_DAYS + 1, i64::MAX, i64::MIN] {
            match token_lifetime_ms(Some(bad)) {
                Err(MdmError::InvalidRequest(message)) => {
                    assert!(message.contains("expiresInDays"), "{message}");
                }
                other => panic!("expiresInDays={bad} must be refused, got {other:?}"),
            }
        }
    }

    #[test]
    fn an_enroll_request_is_shape_checked_before_it_touches_the_database() {
        assert!(validate_enroll_request(&request("a normal UA")).is_ok());
        // Whitespace is not a value.
        let mut blank = request("ua");
        blank.device_name = "   ".to_string();
        assert!(matches!(
            validate_enroll_request(&blank),
            Err(MdmError::InvalidRequest(message)) if message.contains("deviceName")
        ));
        // Over-long fields are refused, and the *longer* user-agent allowance is real: 129 chars
        // fail as a device name but pass as a user agent.
        let long = "x".repeat(MAX_FIELD_CHARS + 1);
        let mut long_name = request("ua");
        long_name.device_name = long.clone();
        assert!(validate_enroll_request(&long_name).is_err());
        assert!(validate_enroll_request(&request(&long)).is_ok());
        assert!(validate_enroll_request(&request(&"x".repeat(MAX_USER_AGENT_CHARS + 1))).is_err());
    }
}
