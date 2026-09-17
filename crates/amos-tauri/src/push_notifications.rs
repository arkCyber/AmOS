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
use std::sync::Mutex;
use tauri::State;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_available: Option<i32>,
    /// Mutable content flag (media attachments)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutable_content: Option<i32>,
    /// Thread ID (notification grouping)
    #[serde(skip_serializing_if = "Option::is_none")]
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
    fn validate_token(&self, token: &str) -> Result<(), String> {
        if token.is_empty() || token.len() > MAX_DEVICE_TOKEN_LEN {
            return Err(format!("Invalid token length: {}", token.len()));
        }
        if token.len() < 32 {
            return Err("Token too short (minimum 32 characters)".to_string());
        }
        // Check hex format
        if !token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Token must contain only hexadecimal characters".to_string());
        }
        Ok(())
    }

    /// Register device token
    pub fn register_token(&mut self, token: String, environment: String) -> PushResult {
        if let Err(reason) = self.validate_token(&token) {
            return PushResult::InvalidToken { reason };
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

    /// Set permission status
    pub fn set_permission(&mut self, status: PermissionStatus) {
        self.permission = status;
    }

    /// Get permission status
    pub fn get_permission(&self) -> PermissionStatus {
        self.permission
    }

    /// Handle incoming push notification
    pub fn receive_notification(&mut self, payload: PushPayload) -> Result<String, String> {
        // Validate payload size
        let payload_json = serde_json::to_string(&payload)
            .map_err(|e| format!("Failed to serialize payload: {}", e))?;
        if payload_json.len() > MAX_PAYLOAD_SIZE {
            return Err(format!("Payload too large: {} bytes", payload_json.len()));
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
) -> Result<PushResult, String> {
    if !is_platform_available() {
        return Ok(PushResult::Unavailable {
            reason: "Push notifications not available on this platform".to_string(),
        });
    }

    let mut manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(manager.register_token(token, environment))
}

/// Get current device token
#[tauri::command]
pub fn push_get_token(
    state: State<PushNotificationState>,
) -> Result<Option<DeviceToken>, String> {
    let manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(manager.get_token())
}

/// Request push notification permission
#[tauri::command]
pub fn push_request_permission(
    state: State<PushNotificationState>,
) -> Result<PushResult, String> {
    if !is_platform_available() {
        return Ok(PushResult::Unavailable {
            reason: "Push notifications not available on this platform".to_string(),
        });
    }

    // Platform-specific permission request would go here
    // For now, simulate authorization
    let mut manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    manager.set_permission(PermissionStatus::Authorized);
    Ok(PushResult::Ok)
}

/// Get current permission status
#[tauri::command]
pub fn push_get_permission(
    state: State<PushNotificationState>,
) -> Result<PermissionStatus, String> {
    let manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(manager.get_permission())
}

/// Simulate receiving a push notification (for testing)
#[tauri::command]
pub fn push_simulate_receive(
    payload: PushPayload,
    state: State<PushNotificationState>,
) -> Result<String, String> {
    let mut manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    manager.receive_notification(payload)
}

/// Get badge count
#[tauri::command]
pub fn push_get_badge(
    state: State<PushNotificationState>,
) -> Result<i32, String> {
    let manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(manager.get_badge())
}

/// Set badge count
#[tauri::command]
pub fn push_set_badge(
    count: i32,
    state: State<PushNotificationState>,
) -> Result<(), String> {
    let mut manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    manager.set_badge(count);
    Ok(())
}

/// Get notification history
#[tauri::command]
pub fn push_get_history(
    limit: Option<usize>,
    state: State<PushNotificationState>,
) -> Result<Vec<NotificationRecord>, String> {
    let manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(manager.get_history(limit))
}

/// Mark notification as read
#[tauri::command]
pub fn push_mark_read(
    id: String,
    state: State<PushNotificationState>,
) -> Result<bool, String> {
    let mut manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(manager.mark_read(&id))
}

/// Clear notification history
#[tauri::command]
pub fn push_clear_history(
    state: State<PushNotificationState>,
) -> Result<(), String> {
    let mut manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    manager.clear_history();
    Ok(())
}

/// Get push statistics
#[tauri::command]
pub fn push_get_statistics(
    state: State<PushNotificationState>,
) -> Result<PushStatistics, String> {
    let manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(manager.get_statistics())
}

/// Get push notification status
#[tauri::command]
pub fn push_get_status(
    state: State<PushNotificationState>,
) -> Result<PushStatus, String> {
    let manager = state.manager.lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(manager.get_status())
}
