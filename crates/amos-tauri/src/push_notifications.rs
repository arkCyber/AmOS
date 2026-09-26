// push_notifications.rs — APNs-compatible push notification service.
//
// Provides device token registration, remote notification receiving, local
// notification display, and notification history management. Follows the same
// honest-boundary pattern as airplay.rs and radio.rs: unavailable platforms
// return well-typed failures rather than silently pretending to work.
//
// On iOS/macOS: uses system APNs (UserNotifications framework)
// On Android: supports FCM (Firebase Cloud Messaging) with APNs-compatible payload
// On desktop: supports REST/WebSocket APNs endpoint simulation
// On unsupported hosts: returns "unavailable" (no fake success)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use tauri::State;

use crate::error::{AmosError, AmosResult, ErrorCode};

/// Maximum device token length (production: 64 hex chars, sandbox: 32-63)
const MAX_DEVICE_TOKEN_LEN: usize = 64;

/// Maximum payload size (APNs limit: 4KB for regular, 5KB for VoIP)
const MAX_PAYLOAD_SIZE: usize = 4096;

/// Maximum notification history size
const MAX_HISTORY_SIZE: usize = 100;

/// APNs notification priority
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationPriority {
    /// Send immediately (10)
    High,
    /// Send when device wakes (5)
    Normal,
}

/// Notification presentation options
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresentationOptions {
    /// Show alert/banner
    pub alert: bool,
    /// Play sound
    pub sound: bool,
    /// Update badge
    pub badge: bool,
}

/// APNs notification payload (simplified)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushPayload {
    /// APNs standard payload
    pub aps: ApsPayload,
    /// Custom data
    #[serde(flatten)]
    pub custom: HashMap<String, serde_json::Value>,
}

/// APNs standard payload structure
///
/// The wire keys are the **APNs-standard kebab-case names** (`content-available`,
/// `mutable-content`, `thread-id`) — which is also what `pushNotifications.ts`
/// declares on the TypeScript side. Without the renames serde published
/// `content_available` / `mutable_content` / `thread_id`, so a real APNs payload
/// arriving with `content-available` fell through to the flattened `custom` map and
/// `isSilentPush()` could never see it (`PUSH_PHASE3_DAY3_RESEARCH_AND_DESIGN.md` §8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApsPayload {
    /// Alert content (string or object)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alert: Option<String>,
    /// Badge number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<i32>,
    /// Sound file name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
    /// Content available flag (silent push)
    #[serde(rename = "content-available", skip_serializing_if = "Option::is_none")]
    pub content_available: Option<i32>,
    /// Mutable content flag (media attachments)
    #[serde(rename = "mutable-content", skip_serializing_if = "Option::is_none")]
    pub mutable_content: Option<i32>,
    /// Thread ID (notification grouping)
    #[serde(rename = "thread-id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Category identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// Device token registration info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceToken {
    /// Device token (hex string)
    pub token: String,
    /// Environment (sandbox/production)
    pub environment: String,
    /// Registration timestamp (ISO 8601)
    pub registered_at: String,
}

/// Notification record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationRecord {
    /// Unique notification ID
    pub id: String,
    /// Payload
    pub payload: PushPayload,
    /// Received timestamp (ISO 8601)
    pub received_at: String,
    /// Whether notification was read/dismissed
    pub read: bool,
}

/// Push notification statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushStatistics {
    /// Total notifications received
    pub total_received: u64,
    /// Notifications with badge
    pub with_badge: u64,
    /// Notifications with sound
    pub with_sound: u64,
    /// Silent pushes
    pub silent: u64,
    /// Last received timestamp
    pub last_received: Option<String>,
}

/// Push notification status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushStatus {
    /// Whether push is available on this platform
    pub available: bool,
    /// The OS API this build would ask for a push permission — `None` when no target
    /// binds one (REQ-A865).
    ///
    /// **A second field, not a second meaning for `available`.** The two facts were
    /// one `bool`, and that is the whole defect: `available` says "this device has a
    /// push subsystem", which is true — the manager really does hold a token, a
    /// history and statistics — while the panel's *button* needs the other fact,
    /// "the OS can be asked". With one `bool` the UI could not tell them apart, so it
    /// drew an "Allow Notifications" button whose only possible answer was the grant
    /// `push_request_permission` wrote by hand, and rendered
    /// 「你现在可以接收推送通知了」 from it. Same split as `mic_permission`'s
    /// `native` vs `granted`.
    pub permission_backend: Option<String>,
    /// Current device token (if registered)
    pub device_token: Option<DeviceToken>,
    /// Permission status
    pub permission: PermissionStatus,
    /// Current badge count
    pub badge_count: i32,
    /// Statistics
    pub statistics: PushStatistics,
}

/// Permission status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionStatus {
    /// Not yet requested
    NotDetermined,
    /// User denied
    Denied,
    /// User authorized
    Authorized,
    /// Provisionally authorized (quiet notifications)
    Provisional,
}

/// Push command result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PushResult {
    /// Command succeeded
    Ok,
    /// Feature unavailable on this platform
    Unavailable { reason: String },
    /// Permission denied
    PermissionDenied { reason: String },
    /// Invalid device token
    InvalidToken { reason: String },
    /// Operation failed
    Failed { reason: String },
}

/// Push notification manager state
pub struct PushNotificationManager {
    /// Current device token
    device_token: Option<DeviceToken>,
    /// Permission status
    permission: PermissionStatus,
    /// Current badge count
    badge_count: i32,
    /// Notification history
    history: Vec<NotificationRecord>,
    /// Statistics
    statistics: PushStatistics,
}

impl PushNotificationManager {
    /// Create new push manager
    pub fn new() -> Self {
        Self {
            device_token: None,
            permission: PermissionStatus::NotDetermined,
            badge_count: 0,
            history: Vec::new(),
            statistics: PushStatistics {
                total_received: 0,
                with_badge: 0,
                with_sound: 0,
                silent: 0,
                last_received: None,
            },
        }
    }

    /// Validate device token
    fn validate_token(&self, token: &str) -> AmosResult<()> {
        if token.is_empty() || token.len() > MAX_DEVICE_TOKEN_LEN {
            return Err(AmosError::new(
                ErrorCode::PushTokenInvalid,
                format!("invalid token length: {}", token.len()),
            ));
        }
        if token.len() < 32 {
            return Err(AmosError::new(
                ErrorCode::PushTokenInvalid,
                "token too short (minimum 32 characters)",
            ));
        }
        // Check hex format
        if !token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AmosError::new(
                ErrorCode::PushTokenInvalid,
                "token must contain only hexadecimal characters",
            ));
        }
        Ok(())
    }

    /// Register device token
    pub fn register_token(&mut self, token: String, environment: String) -> PushResult {
        if let Err(e) = self.validate_token(&token) {
            return PushResult::InvalidToken { reason: e.message };
        }

        let now = chrono::Utc::now().to_rfc3339();
        self.device_token = Some(DeviceToken {
            token,
            environment,
            registered_at: now,
        });
        PushResult::Ok
    }

    /// Get current device token
    pub fn get_token(&self) -> Option<DeviceToken> {
        self.device_token.clone()
    }

    /// Set permission status.
    ///
    /// **One caller is allowed: a platform glue that has just been told an answer by the
    /// OS.** `push_request_permission` is not one — it used to be, which is exactly how
    /// the panel came to announce a grant nobody made (REQ-A865). If you are reaching for
    /// this to make a UI branch render, the branch is describing a state this build cannot
    /// reach, and the fix belongs in the branch, not here.
    pub fn set_permission(&mut self, status: PermissionStatus) {
        self.permission = status;
    }

    /// Get permission status
    pub fn get_permission(&self) -> PermissionStatus {
        self.permission
    }

    /// Handle incoming push notification
    pub fn receive_notification(&mut self, payload: PushPayload) -> AmosResult<String> {
        // Validate payload size
        let payload_json = serde_json::to_string(&payload).map_err(|e| {
            AmosError::with_cause(
                ErrorCode::PushReceiveFailed,
                "failed to serialize push payload",
                e,
            )
        })?;
        if payload_json.len() > MAX_PAYLOAD_SIZE {
            return Err(AmosError::new(
                ErrorCode::PushPayloadTooLong,
                format!("payload too large: {} bytes", payload_json.len()),
            ));
        }

        // Generate unique ID
        let id = format!("notif_{}", chrono::Utc::now().timestamp_millis());
        let now = chrono::Utc::now().to_rfc3339();

        // Update statistics
        self.statistics.total_received += 1;
        if payload.aps.badge.is_some() {
            self.statistics.with_badge += 1;
        }
        if payload.aps.sound.is_some() {
            self.statistics.with_sound += 1;
        }
        if payload.aps.content_available == Some(1) && payload.aps.alert.is_none() {
            self.statistics.silent += 1;
        }
        self.statistics.last_received = Some(now.clone());

        // Update badge if present
        if let Some(badge) = payload.aps.badge {
            self.badge_count = badge;
        }

        // Add to history
        let record = NotificationRecord {
            id: id.clone(),
            payload,
            received_at: now,
            read: false,
        };
        self.history.push(record);

        // Trim history if needed
        if self.history.len() > MAX_HISTORY_SIZE {
            self.history.drain(0..self.history.len() - MAX_HISTORY_SIZE);
        }

        Ok(id)
    }

    /// Get badge count
    pub fn get_badge(&self) -> i32 {
        self.badge_count
    }

    /// Set badge count
    pub fn set_badge(&mut self, count: i32) {
        self.badge_count = count.max(0);
    }

    /// Get notification history
    pub fn get_history(&self, limit: Option<usize>) -> Vec<NotificationRecord> {
        let limit = limit.unwrap_or(MAX_HISTORY_SIZE).min(MAX_HISTORY_SIZE);
        self.history.iter().rev().take(limit).cloned().collect()
    }

    /// Mark notification as read
    pub fn mark_read(&mut self, id: &str) -> bool {
        if let Some(notif) = self.history.iter_mut().find(|n| n.id == id) {
            notif.read = true;
            true
        } else {
            false
        }
    }

    /// Delete one notification from the history.
    ///
    /// `push_get_history` answers this history on every poll, so a row the shell removed
    /// from its list is re-projected unless the device forgets it too — the delivery would
    /// come back a few seconds later. `true` when a record was actually removed, so the
    /// answer is a verdict rather than a claim.
    pub fn delete_notification(&mut self, id: &str) -> bool {
        let before = self.history.len();
        self.history.retain(|n| n.id != id);
        self.history.len() != before
    }

    /// Clear notification history
    pub fn clear_history(&mut self) {
        self.history.clear();
    }

    /// Get statistics
    pub fn get_statistics(&self) -> PushStatistics {
        self.statistics.clone()
    }

    /// Get current status
    pub fn get_status(&self) -> PushStatus {
        PushStatus {
            available: is_platform_available(),
            permission_backend: permission_backend().map(str::to_string),
            device_token: self.device_token.clone(),
            permission: self.permission,
            badge_count: self.badge_count,
            statistics: self.statistics.clone(),
        }
    }
}

impl Default for PushNotificationManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Platform-specific: Check if push notifications are available
#[allow(unreachable_code)]
fn is_platform_available() -> bool {
    // iOS/macOS: always available (system APNs)
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        return true;
    }

    // Android: available if FCM configured
    #[cfg(target_os = "android")]
    {
        return true; // FCM glue will be added in future
    }

    // Desktop: available (REST/WebSocket simulation)
    #[cfg(desktop)]
    {
        return true;
    }

    // Other platforms: unavailable (this branch is only compiled on non-supported platforms)
    false
}

/// The OS API this build would call to obtain a push permission, or `None`.
///
/// **No target returns `Some`, and that is a statement about this tree, not about the
/// platforms.** Verified 2026-09-21 by grep over every `.rs`/`.kt`/`.java`/`.swift`/
/// `.ts`/`.svelte` in the workspace: there is no `UNUserNotificationCenter`, no
/// `requestAuthorization`, no `registerForRemoteNotifications`, no `FirebaseMessaging`
/// and no JS `Notification.requestPermission` on the push path. So on *every* target
/// this build can produce, the honest answer to "can we ask the system?" is no — and
/// `push_request_permission` used to answer yes anyway, by writing
/// `PermissionStatus::Authorized` itself under a `// For now, simulate authorization`
/// comment. `mic_permission.rs` states the rule this broke, verbatim: *"`granted == true`
/// only when the OS itself answered 'yes' — never a fabricated 'granted'"*.
///
/// When a real glue lands, this returns `Some("UNUserNotificationCenter")` (etc.) and
/// `push_request_permission` asks it — one place to change, and the UI's button starts
/// appearing on its own because it is drawn from this value.
fn permission_backend() -> Option<&'static str> {
    None
}

/// Why `push_request_permission` refuses. Named so the test and the command cannot drift.
///
/// Spelling out *what is missing* matters more than usual here: the panel is reachable,
/// looks healthy, and its other blocks (token, statistics, history) really do work, so a
/// bare "unavailable" would read as a bug in a working page rather than as the one
/// capability this build does not have.
const NO_PERMISSION_BACKEND: &str =
    "no system notification-permission API is bound in this build (no UNUserNotificationCenter \
     / POST_NOTIFICATIONS glue) — a push permission cannot be requested, so none is granted";

/// Shared state wrapper
pub struct PushNotificationState {
    manager: Mutex<PushNotificationManager>,
}

impl PushNotificationState {
    pub fn new() -> Self {
        Self {
            manager: Mutex::new(PushNotificationManager::new()),
        }
    }

    /// Take the manager lock, reporting a poisoned mutex as a typed refusal
    /// rather than dropping the request. Every command goes through here so the
    /// "poisoned → `amos.push.lock_failed`" contract is stated once.
    fn lock(&self) -> AmosResult<MutexGuard<'_, PushNotificationManager>> {
        self.manager.lock().map_err(|e| {
            AmosError::with_cause(ErrorCode::PushLockFailed, "push state lock poisoned", e)
        })
    }
}

impl Default for PushNotificationState {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tauri Commands
// ═══════════════════════════════════════════════════════════════════════════

/// Register device token for push notifications
#[tauri::command]
pub fn push_register_token(
    token: String,
    environment: String,
    state: State<PushNotificationState>,
) -> AmosResult<PushResult> {
    if !is_platform_available() {
        return Ok(PushResult::Unavailable {
            reason: "Push notifications not available on this platform".to_string(),
        });
    }

    let mut manager = state.lock()?;
    Ok(manager.register_token(token, environment))
}

/// Get current device token
#[tauri::command]
pub fn push_get_token(state: State<PushNotificationState>) -> AmosResult<Option<DeviceToken>> {
    let manager = state.lock()?;
    Ok(manager.get_token())
}

/// Request push notification permission
///
/// **This build cannot obtain one, so it says so instead of answering yes (REQ-A865).**
///
/// What this used to do: check the platform, then write `PermissionStatus::Authorized`
/// into its own state under the comment `// For now, simulate authorization`, and return
/// `Ok`. Nobody was asked. The frontend then dropped that `Ok` on the floor
/// (`await requestPushPermission();` — no binding), re-read `push_get_status`, saw the
/// `authorized` the Rust side had just written into itself, and rendered
/// 「你现在可以接收推送通知了」 / "You can now receive push notifications" — a sentence
/// that was true of nothing. Three halves hid each other: the fabrication, the discarded
/// verdict, and a success sentence derived from the fabricated state.
///
/// The refusal is `Unavailable` rather than `PermissionDenied` on purpose: nobody denied
/// anything, and a denial would send the user to system settings to change a setting that
/// does not exist. It is not `Failed` either — nothing was attempted and nothing broke.
/// `PermissionStatus` is deliberately left untouched: `NotDetermined` is the truth, and
/// writing anything else here would be the same fabrication in a different costume.
#[tauri::command]
pub fn push_request_permission(state: State<PushNotificationState>) -> AmosResult<PushResult> {
    request_permission(&state)
}

/// The body of [`push_request_permission`], split out so a test can reach it.
///
/// `tauri::State` has no public constructor, so as long as the refusal lived in the
/// command itself it was unreachable from a unit test — which is how the fabrication it
/// replaces survived: nothing could assert what the command wrote. `PushNotificationState`
/// *does* have `new()`, so the honest half is testable the moment it takes a plain
/// reference.
fn request_permission(state: &PushNotificationState) -> AmosResult<PushResult> {
    if !is_platform_available() {
        return Ok(PushResult::Unavailable {
            reason: "Push notifications not available on this platform".to_string(),
        });
    }

    if permission_backend().is_none() {
        // The lock is taken but the manager is only *read*: the command must not report a
        // permission that a concurrent call is in the middle of changing, and it must not
        // write one either. `NotDetermined` is the truth here and it stays the truth.
        let manager = state.lock()?;
        debug_assert_eq!(
            manager.get_permission(),
            PermissionStatus::NotDetermined,
            "a build with no permission backend must never have moved the permission"
        );
        return Ok(PushResult::Unavailable {
            reason: NO_PERMISSION_BACKEND.to_string(),
        });
    }

    // Unreachable today — `permission_backend()` is `None` on every target. Kept as the
    // single call site a real glue lands in, so `set_permission` has exactly one
    // legitimate doorway and the fabrication cannot come back as the path of least
    // resistance. Refusing by name beats returning `Ok`: a declared-but-unimplemented
    // backend is a defect, and it should read like one.
    Ok(PushResult::Failed {
        reason: format!(
            "permission backend `{}` is declared but has no implementation in this tree",
            permission_backend().unwrap_or("?")
        ),
    })
}

/// Get current permission status
#[tauri::command]
pub fn push_get_permission(state: State<PushNotificationState>) -> AmosResult<PermissionStatus> {
    let manager = state.lock()?;
    Ok(manager.get_permission())
}

/// Simulate receiving a push notification (for testing)
#[tauri::command]
pub fn push_simulate_receive(
    payload: PushPayload,
    state: State<PushNotificationState>,
) -> AmosResult<String> {
    let mut manager = state.lock()?;
    manager.receive_notification(payload)
}

/// Get badge count
#[tauri::command]
pub fn push_get_badge(state: State<PushNotificationState>) -> AmosResult<i32> {
    let manager = state.lock()?;
    Ok(manager.get_badge())
}

/// Set badge count
#[tauri::command]
pub fn push_set_badge(count: i32, state: State<PushNotificationState>) -> AmosResult<()> {
    let mut manager = state.lock()?;
    manager.set_badge(count);
    Ok(())
}

/// Get notification history
#[tauri::command]
pub fn push_get_history(
    limit: Option<usize>,
    state: State<PushNotificationState>,
) -> AmosResult<Vec<NotificationRecord>> {
    let manager = state.lock()?;
    Ok(manager.get_history(limit))
}

/// Mark notification as read
#[tauri::command]
pub fn push_mark_read(id: String, state: State<PushNotificationState>) -> AmosResult<bool> {
    let mut manager = state.lock()?;
    Ok(manager.mark_read(&id))
}

/// Delete one notification from the history
#[tauri::command]
pub fn push_delete_notification(
    id: String,
    state: State<PushNotificationState>,
) -> AmosResult<bool> {
    let mut manager = state.lock()?;
    Ok(manager.delete_notification(&id))
}

/// Clear notification history
#[tauri::command]
pub fn push_clear_history(state: State<PushNotificationState>) -> AmosResult<()> {
    let mut manager = state.lock()?;
    manager.clear_history();
    Ok(())
}

/// Get push statistics
#[tauri::command]
pub fn push_get_statistics(state: State<PushNotificationState>) -> AmosResult<PushStatistics> {
    let manager = state.lock()?;
    Ok(manager.get_statistics())
}

/// Get push notification status
#[tauri::command]
pub fn push_get_status(state: State<PushNotificationState>) -> AmosResult<PushStatus> {
    let manager = state.lock()?;
    Ok(manager.get_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire names are a contract with `pushNotifications.ts` (`PushPayload`):
    /// a real APNs payload spells these three keys kebab-case, so a rename that
    /// silently went back to snake_case would drop a silent push on the floor
    /// (`isSilentPush()` would never see `content-available`).
    #[test]
    fn aps_payload_uses_the_apns_standard_wire_keys() {
        let json = r#"{"alert":"hi","badge":3,"sound":"default","content-available":1,"mutable-content":1,"thread-id":"news-1"}"#;
        let aps: ApsPayload = serde_json::from_str(json).expect("an APNs payload must parse");
        assert_eq!(aps.content_available, Some(1));
        assert_eq!(aps.mutable_content, Some(1));
        assert_eq!(aps.thread_id.as_deref(), Some("news-1"));

        let out = serde_json::to_value(&aps).expect("must serialize");
        assert!(out.get("content-available").is_some());
        assert!(out.get("mutable-content").is_some());
        assert!(out.get("thread-id").is_some());
        assert!(
            out.get("content_available").is_none(),
            "the pre-rename snake_case key must not come back on the wire"
        );
    }

    /// A silent push is a *recorded* delivery with no alert — which is exactly how
    /// the frontend bridge decides to keep it off the screen (history only).
    #[test]
    fn a_silent_push_is_counted_as_silent_and_keeps_its_custom_data() {
        let payload: PushPayload =
            serde_json::from_str(r#"{"aps":{"content-available":1},"kind":"sync"}"#)
                .expect("a silent payload must parse");
        assert!(payload.aps.alert.is_none());
        assert_eq!(payload.aps.content_available, Some(1));
        // Custom data survives the flatten, so the app can still route the update.
        assert_eq!(
            payload.custom.get("kind").and_then(|v| v.as_str()),
            Some("sync")
        );

        let mut manager = PushNotificationManager::new();
        let id = manager
            .receive_notification(payload)
            .expect("a silent delivery is still a delivery");
        let stats = manager.get_statistics();
        assert_eq!(stats.total_received, 1);
        assert_eq!(stats.silent, 1);
        assert_eq!(stats.with_badge, 0);
        assert!(manager.get_history(None).iter().any(|r| r.id == id));
    }

    /// Delivery → history is unread, and `mark_read` is the only thing that flips
    /// it — the flag the notification centre reflects must come from here.
    #[test]
    fn a_delivery_enters_the_history_unread_until_it_is_marked_read() {
        let payload: PushPayload =
            serde_json::from_str(r#"{"aps":{"alert":"ping","badge":2}}"#).expect("must parse");
        let mut manager = PushNotificationManager::new();
        let id = manager.receive_notification(payload).expect("must record");

        let record = manager
            .get_history(None)
            .into_iter()
            .find(|r| r.id == id)
            .expect("the delivery must be in the history");
        assert!(!record.read, "a fresh delivery is unread");
        assert_eq!(
            manager.get_badge(),
            2,
            "the badge is the payload's absolute value"
        );

        assert!(manager.mark_read(&id), "an existing id is marked");
        assert!(
            !manager.mark_read("notif_does_not_exist"),
            "an unknown id is not"
        );
    }

    /// Removing one delivery must actually leave the history — `push_get_history` answers
    /// this list on every poll, so a record that survives here comes back to the shell a
    /// few seconds after the user dismissed it.
    #[test]
    fn a_deleted_delivery_leaves_the_history_and_an_unknown_id_is_not_a_deletion() {
        let payload: PushPayload =
            serde_json::from_str(r#"{"aps":{"alert":"ping"}}"#).expect("must parse");
        let mut manager = PushNotificationManager::new();
        let id = manager.receive_notification(payload).expect("must record");

        assert!(
            manager.delete_notification(&id),
            "an existing id is removed"
        );
        assert!(
            manager.get_history(None).is_empty(),
            "the poller must not be able to re-read it"
        );
        assert!(
            !manager.delete_notification(&id),
            "removing it twice removes nothing the second time"
        );
        assert!(
            !manager.delete_notification("notif_does_not_exist"),
            "an unknown id is not a deletion"
        );
    }

    /// The 4 KB APNs bound is enforced at the seam, not trusted from the caller.
    #[test]
    fn an_oversized_payload_is_refused_rather_than_stored() {
        let filler = "x".repeat(MAX_PAYLOAD_SIZE + 1);
        let payload: PushPayload = serde_json::from_value(serde_json::json!({
            "aps": { "alert": "hi" },
            "filler": filler,
        }))
        .expect("must parse");
        let mut manager = PushNotificationManager::new();
        let err = manager
            .receive_notification(payload)
            .expect_err("must refuse");
        assert_eq!(
            err.code,
            ErrorCode::PushPayloadTooLong,
            "the refusal must be the stable code, not a bare message"
        );
        assert!(manager.get_history(None).is_empty(), "nothing was stored");
        assert_eq!(manager.get_statistics().total_received, 0);
    }

    /// A malformed token is refused by **name** (`amos.push.token_invalid`) — the
    /// UI branches on the code, so "empty", "too short" and "non-hex" must all
    /// collapse to the same stable key rather than three off-the-cuff strings.
    #[test]
    fn a_malformed_device_token_is_a_named_refusal() {
        let manager = PushNotificationManager::new();
        for bad in ["", "abc", &"z".repeat(MAX_DEVICE_TOKEN_LEN)] {
            let err = manager
                .validate_token(bad)
                .expect_err("a malformed token must be refused");
            assert_eq!(err.code, ErrorCode::PushTokenInvalid);
        }
    }

    /// Registration refuses a bad token **without** storing it — the manager's
    /// `device_token` stays `None`, so a later `push_get_token` cannot hand back
    /// a token the host never validated.
    #[test]
    fn register_token_refuses_a_bad_token_and_stores_nothing() {
        let mut manager = PushNotificationManager::new();
        let refused = manager.register_token("not-hex".to_string(), "sandbox".to_string());
        assert!(
            matches!(refused, PushResult::InvalidToken { .. }),
            "a malformed token is an InvalidToken result, not Ok"
        );
        assert!(manager.get_token().is_none(), "nothing was stored");

        let good = "a".repeat(MAX_DEVICE_TOKEN_LEN);
        assert!(matches!(
            manager.register_token(good.clone(), "sandbox".to_string()),
            PushResult::Ok
        ));
        assert_eq!(manager.get_token().map(|t| t.token), Some(good));
    }

    /// REQ-A865 / F-DEV-116. Asking for a push permission must not *grant* one.
    ///
    /// The assertion that matters is the second one, and it is deliberately written
    /// against the state rather than against the returned kind: the old code returned
    /// `Ok` and wrote `Authorized`, so a test that only checked the reply would have been
    /// satisfied by it. What the panel rendered came from `get_status().permission`, which
    /// is why the false sentence appeared in a UI nobody had touched.
    #[test]
    fn requesting_a_push_permission_never_writes_one_it_was_not_given() {
        let state = PushNotificationState::new();
        let reply = request_permission(&state).expect("a refusal is still a reply");

        assert!(
            matches!(reply, PushResult::Unavailable { .. }),
            "with no permission backend the honest answer is Unavailable, got {reply:?}"
        );
        assert_eq!(
            state.lock().expect("lock").get_permission(),
            PermissionStatus::NotDetermined,
            "the request command must not move the permission — only a real OS answer may"
        );
    }

    /// The panel's button is drawn from `permission_backend`, so the field must actually
    /// carry the predicate and reach the wire under the name TS reads.
    ///
    /// The name is the contract with `RustPushStatus.permission_backend` in
    /// `pushNotifications.ts`; a snake_case/camelCase slip here would leave the panel
    /// reading `undefined` — which is falsy, so the button would vanish silently rather
    /// than loudly, and the "no backend" sentence would be unreachable again.
    #[test]
    fn status_reports_no_permission_backend_under_the_wire_name_the_panel_reads() {
        let state = PushNotificationState::new();
        let status = state.lock().expect("lock").get_status();

        assert_eq!(
            status.permission_backend, None,
            "no target in this tree binds a permission API; see `permission_backend()`"
        );

        let wire = serde_json::to_value(&status).expect("status must serialize");
        assert!(
            wire.get("permission_backend").is_some(),
            "the panel reads `permission_backend`; it must be on the wire, present-and-null \
             rather than absent"
        );
        assert_eq!(wire["permission_backend"], serde_json::Value::Null);
        // And `available` is still its own key — the two facts must not be folded into one.
        assert!(
            wire.get("available").is_some(),
            "availability must survive as a separate field; conflating it with the \
             permission backend is the defect REQ-A865 fixes"
        );
    }
}
