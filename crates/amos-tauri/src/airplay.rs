// airplay.rs — AirPlay / screen mirroring / media casting service.
//
// Provides device discovery and playback **control** for AirPlay receivers (Apple TV, HomePod,
// smart TVs with AirPlay 2, etc.). Follows the same honest-boundary pattern as radio.rs and
// media.rs: an operation with no implementation returns a well-typed refusal that explains
// itself, rather than flipping local state and reporting success (REQ-A467).
//
// Honest boundary (REQ-A467): **receiver control is not implemented on any platform.** There is
// no public API by which a third-party app may enumerate or select an AirPlay receiver — the
// Apple surfaces are either UI-level (`AVRoutePickerView`, which presents *system* UI) or need a
// live `AVPlayer` session on the main thread — and there is no in-tree RAOP/Cast client for
// Android/Linux. So `connect` / `start_stream` / `set_volume` refuse with a reason instead of
// returning `Ok`; `is_available()` answers the narrower question "does this platform have
// AirPlay at all", which is why the panel can still offer the feature and then explain itself.
//
// On unsupported hosts: returns "unavailable" (no fake success)

use serde::{Deserialize, Serialize};

use crate::airplay_platform::{
    platform_get_devices, platform_start_discovery, platform_stop_discovery, PlatformDiscovery,
};

/// AirPlay device type classification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    /// Apple TV or HomePod (native AirPlay 2)
    AppleTv,
    /// Smart TV with AirPlay 2 support
    Tv,
    /// Mac, iPad, or AirPlay-enabled speaker
    Audio,
    /// Generic DLNA/Cast receiver
    Generic,
}

/// AirPlay receiver device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AirPlayDevice {
    /// Unique identifier (MAC address or service ID)
    pub id: String,
    /// Human-readable device name
    pub name: String,
    /// Device type
    pub kind: DeviceKind,
    /// Whether device supports video streaming
    pub supports_video: bool,
    /// Whether device supports audio streaming
    pub supports_audio: bool,
    /// Whether device supports screen mirroring
    pub supports_mirroring: bool,
    /// Signal strength (0-100, 0 = unknown)
    pub signal_strength: u8,
    /// Whether device is currently connected
    pub connected: bool,
}

/// Current AirPlay streaming status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AirPlayStatus {
    /// Whether AirPlay is currently active
    pub active: bool,
    /// Connected device (if any)
    pub device: Option<AirPlayDevice>,
    /// Type of active stream
    pub stream_kind: Option<StreamKind>,
    /// Playback state
    pub playing: bool,
    /// Volume level (0.0-1.0)
    pub volume: f32,
}

/// Type of AirPlay stream
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamKind {
    /// Audio-only streaming
    Audio,
    /// Video streaming
    Video,
    /// Full screen mirroring
    Mirroring,
}

/// AirPlay command result.
///
/// The `kind` strings are part of the frontend contract (`lib/airplay.ts`), so they are pinned by
/// `test_airplay_result_wire_form` (REQ-A467). They are `snake_case` on purpose: with the previous
/// `rename_all = "lowercase"` a two-word variant became one word (`PermissionDenied` →
/// `"permissiondenied"`), which is **not** what the declared TypeScript union said
/// (`permission_denied`) — a mismatch no code compared, because the panel only ever tested
/// `kind === "ok"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AirPlayResult {
    /// Command succeeded
    Ok,
    /// Feature unavailable on this platform
    Unavailable { reason: String },
    /// Permission denied
    PermissionDenied { reason: String },
    /// Device not found or disconnected
    DeviceNotFound,
    /// Operation failed
    Failed { reason: String },
    /// The surface exists but nothing implements it here (REQ-A467) — distinct from
    /// `Unavailable`, which means "this platform has no AirPlay at all": the two need different
    /// sentences in front of the user.
    NotImplemented { reason: String },
}

/// Why the three **mutating** operations refuse instead of reporting success (REQ-A467).
///
/// There is no platform call behind them. Reporting `Ok` while flipping local state put
/// "connected" / "streaming" in front of the user for a receiver nothing had talked to — the one
/// thing this module's header promises not to do. The reason names the constraint so a reader can
/// tell "we cannot do this" apart from "it broke".
const NOT_IMPLEMENTED: &str = "AirPlay receiver control is not implemented: no platform API lets \
     an app select or drive a receiver, so nothing was sent to any device";

/// Manager state
pub struct AirPlayManager {
    /// Last known device list
    devices: Vec<AirPlayDevice>,
    /// Current active connection
    status: AirPlayStatus,
    /// Whether discovery is running
    discovering: bool,
    /// Platform-specific discovery handler
    platform_discovery: Option<PlatformDiscovery>,
}

impl Default for AirPlayManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AirPlayManager {
    pub fn new() -> Self {
        Self {
            devices: Vec::new(),
            status: AirPlayStatus {
                active: false,
                device: None,
                stream_kind: None,
                playing: false,
                volume: 0.7,
            },
            discovering: false,
            platform_discovery: None,
        }
    }

    /// Check if AirPlay is available on this platform
    pub fn is_available(&self) -> bool {
        // Platform detection
        #[cfg(target_os = "macos")]
        return true;

        #[cfg(target_os = "ios")]
        return true;

        // Android can use DLNA/Cast
        #[cfg(target_os = "android")]
        return true;

        // Linux desktop can use RAOP or Cast
        #[cfg(all(target_os = "linux", not(target_os = "android")))]
        return true;

        #[cfg(not(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "android",
            target_os = "linux"
        )))]
        return false;
    }

    /// Get unavailability reason
    fn unavailable_reason(&self) -> String {
        if !self.is_available() {
            return "AirPlay is not supported on this platform".to_string();
        }
        "AirPlay service not initialized".to_string()
    }

    /// Start device discovery
    pub fn start_discovery(&mut self) -> AirPlayResult {
        if !self.is_available() {
            return AirPlayResult::Unavailable {
                reason: self.unavailable_reason(),
            };
        }

        self.discovering = true;

        // Platform-specific discovery implementation
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            let result = platform_start_discovery(&mut self.platform_discovery);
            if !matches!(result, AirPlayResult::Ok) {
                return result;
            }

            // Also load platform devices
            let platform_devices = platform_get_devices(&self.platform_discovery);
            if !platform_devices.is_empty() {
                self.devices = platform_devices;
                return AirPlayResult::Ok;
            }

            // Fall back to demo devices in debug mode if no real devices found
            #[cfg(debug_assertions)]
            {
                self.devices = Self::demo_devices();
            }

            AirPlayResult::Ok
        }

        // For other platforms, use demo devices in development
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            #[cfg(debug_assertions)]
            {
                self.devices = Self::demo_devices();
            }

            AirPlayResult::Ok
        }
    }

    /// Stop device discovery
    pub fn stop_discovery(&mut self) {
        self.discovering = false;

        // Stop platform-specific discovery
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            platform_stop_discovery(&mut self.platform_discovery);
        }
    }

    /// Get list of discovered devices
    pub fn get_devices(&self) -> Vec<AirPlayDevice> {
        // Return platform devices if available
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            let platform_devices = platform_get_devices(&self.platform_discovery);
            if !platform_devices.is_empty() {
                return platform_devices;
            }
        }

        // Otherwise return cached devices (including demo devices in debug mode)
        self.devices.clone()
    }

    /// Get current streaming status
    pub fn get_status(&self) -> AirPlayStatus {
        self.status.clone()
    }

    /// Connect to a device.
    ///
    /// Refuses with a reason (REQ-A467). The body used to hold no platform call at all: it
    /// flipped `device.connected` / `status.active` and returned `Ok`, so the panel showed
    /// "connected" for a receiver nothing had talked to. `DeviceNotFound` still means *that* — the
    /// caller named a device this manager is not tracking.
    pub fn connect(&mut self, device_id: &str) -> AirPlayResult {
        if !self.is_available() {
            return AirPlayResult::Unavailable {
                reason: self.unavailable_reason(),
            };
        }

        if !self.devices.iter().any(|d| d.id == device_id) {
            return AirPlayResult::DeviceNotFound;
        }

        AirPlayResult::NotImplemented {
            reason: NOT_IMPLEMENTED.to_string(),
        }
    }

    /// Disconnect from current device
    pub fn disconnect(&mut self) -> AirPlayResult {
        if !self.is_available() {
            return AirPlayResult::Unavailable {
                reason: self.unavailable_reason(),
            };
        }

        if let Some(device) = &self.status.device {
            // Update device list
            if let Some(d) = self.devices.iter_mut().find(|d| d.id == device.id) {
                d.connected = false;
            }
        }

        self.status.active = false;
        self.status.device = None;
        self.status.stream_kind = None;
        self.status.playing = false;

        AirPlayResult::Ok
    }

    /// Start streaming media
    pub fn start_stream(&mut self, kind: StreamKind, url: Option<String>) -> AirPlayResult {
        if !self.is_available() {
            return AirPlayResult::Unavailable {
                reason: self.unavailable_reason(),
            };
        }

        let device = match self.status.device.as_ref() {
            Some(device) => device,
            None => {
                return AirPlayResult::Failed {
                    reason: "No device connected".to_string(),
                }
            }
        };

        // Validate the device **before** touching `status`: the old order set
        // `playing = true` first and then returned `Failed`, so a refused stream left the
        // status claiming a stream that never started.
        match kind {
            StreamKind::Video if !device.supports_video => {
                return AirPlayResult::Failed {
                    reason: "Device does not support video streaming".to_string(),
                };
            }
            StreamKind::Audio if !device.supports_audio => {
                return AirPlayResult::Failed {
                    reason: "Device does not support audio streaming".to_string(),
                };
            }
            StreamKind::Mirroring if !device.supports_mirroring => {
                return AirPlayResult::Failed {
                    reason: "Device does not support screen mirroring".to_string(),
                };
            }
            _ => {}
        }

        // Refuse rather than pretend (REQ-A467): the old body flipped `stream_kind` / `playing`
        // and returned `Ok` while dropping `url` on the floor, so the status claimed a stream no
        // receiver had been told about.
        //
        // `url` stays in the signature because it is part of the command's argument contract
        // (`lib/airplay.ts::startStream(kind, url)`); it is deliberately not delivered anywhere —
        // the operation refuses, so there is no receiver to deliver it to.
        let _ = url;

        AirPlayResult::NotImplemented {
            reason: NOT_IMPLEMENTED.to_string(),
        }
    }

    /// Stop current stream
    pub fn stop_stream(&mut self) -> AirPlayResult {
        if !self.is_available() {
            return AirPlayResult::Unavailable {
                reason: self.unavailable_reason(),
            };
        }

        self.status.stream_kind = None;
        self.status.playing = false;

        AirPlayResult::Ok
    }

    /// Set playback volume.
    ///
    /// Refuses with a reason (REQ-A467). It used to clamp the value into `status.volume` and
    /// return `Ok` with a `TODO: Send volume command to device` beneath it, so the status reported
    /// a device volume nobody had set. The clamp went with it: it only had an effect through that
    /// write, and `status.volume` now keeps the value the last **real** answer reported.
    pub fn set_volume(&mut self, volume: f32) -> AirPlayResult {
        if !self.is_available() {
            return AirPlayResult::Unavailable {
                reason: self.unavailable_reason(),
            };
        }

        // Part of the command's argument contract too; nothing is sent anywhere.
        let _ = volume;

        AirPlayResult::NotImplemented {
            reason: NOT_IMPLEMENTED.to_string(),
        }
    }

    /// Generate demo devices for development
    #[cfg(debug_assertions)]
    fn demo_devices() -> Vec<AirPlayDevice> {
        vec![
            AirPlayDevice {
                id: "demo-appletv".to_string(),
                name: "Living Room Apple TV".to_string(),
                kind: DeviceKind::AppleTv,
                supports_video: true,
                supports_audio: true,
                supports_mirroring: true,
                signal_strength: 85,
                connected: false,
            },
            AirPlayDevice {
                id: "demo-homepod".to_string(),
                name: "Bedroom HomePod".to_string(),
                kind: DeviceKind::Audio,
                supports_video: false,
                supports_audio: true,
                supports_mirroring: false,
                signal_strength: 70,
                connected: false,
            },
            AirPlayDevice {
                id: "demo-tv".to_string(),
                name: "Samsung Smart TV".to_string(),
                kind: DeviceKind::Tv,
                supports_video: true,
                supports_audio: true,
                supports_mirroring: true,
                signal_strength: 60,
                connected: false,
            },
        ]
    }
}

// Global manager instance (single-threaded Tauri)
use std::sync::Mutex;
use tauri::State;

pub struct AirPlayState(pub Mutex<AirPlayManager>);

impl Default for AirPlayState {
    fn default() -> Self {
        Self(Mutex::new(AirPlayManager::new()))
    }
}

impl AirPlayState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Tauri command: Check if AirPlay is available
#[tauri::command]
pub async fn airplay_available(state: State<'_, AirPlayState>) -> Result<bool, String> {
    let mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.is_available())
}

/// Tauri command: Start device discovery
#[tauri::command]
pub async fn airplay_discover(state: State<'_, AirPlayState>) -> Result<AirPlayResult, String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.start_discovery())
}

/// Tauri command: Stop device discovery
#[tauri::command]
pub async fn airplay_stop_discovery(state: State<'_, AirPlayState>) -> Result<(), String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    mgr.stop_discovery();
    Ok(())
}

/// Tauri command: Get discovered devices
#[tauri::command]
pub async fn airplay_get_devices(
    state: State<'_, AirPlayState>,
) -> Result<Vec<AirPlayDevice>, String> {
    let mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.get_devices())
}

/// Tauri command: Get current status
#[tauri::command]
pub async fn airplay_get_status(state: State<'_, AirPlayState>) -> Result<AirPlayStatus, String> {
    let mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.get_status())
}

/// Tauri command: Connect to device
#[tauri::command]
pub async fn airplay_connect(
    device_id: String,
    state: State<'_, AirPlayState>,
) -> Result<AirPlayResult, String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.connect(&device_id))
}

/// Tauri command: Disconnect
#[tauri::command]
pub async fn airplay_disconnect(state: State<'_, AirPlayState>) -> Result<AirPlayResult, String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.disconnect())
}

/// Tauri command: Start streaming
#[tauri::command]
pub async fn airplay_start_stream(
    kind: StreamKind,
    url: Option<String>,
    state: State<'_, AirPlayState>,
) -> Result<AirPlayResult, String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.start_stream(kind, url))
}

/// Tauri command: Stop streaming
#[tauri::command]
pub async fn airplay_stop_stream(state: State<'_, AirPlayState>) -> Result<AirPlayResult, String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.stop_stream())
}

/// Tauri command: Set volume
#[tauri::command]
pub async fn airplay_set_volume(
    volume: f32,
    state: State<'_, AirPlayState>,
) -> Result<AirPlayResult, String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    Ok(mgr.set_volume(volume))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manager_creation() {
        let mgr = AirPlayManager::new();
        assert!(!mgr.status.active);
        assert!(mgr.status.device.is_none());
    }

    #[test]
    fn test_discovery() {
        let mut mgr = AirPlayManager::new();
        if mgr.is_available() {
            let result = mgr.start_discovery();
            match result {
                AirPlayResult::Ok => {
                    #[cfg(debug_assertions)]
                    assert!(!mgr.get_devices().is_empty());
                }
                // Every other outcome is a refusal, and all three refusal variants that can
                // carry a reason must carry one: "it did not work" with no sentence is the
                // defect worth failing on. Before REQ-A388 this was a single-pattern `match`
                // with a `_ => {}` arm, so *every* outcome passed silently.
                AirPlayResult::Unavailable { reason }
                | AirPlayResult::PermissionDenied { reason }
                | AirPlayResult::Failed { reason }
                | AirPlayResult::NotImplemented { reason } => {
                    assert!(!reason.is_empty(), "a refusal must explain itself");
                }
                AirPlayResult::DeviceNotFound => {}
            }
        }
    }

    /// REQ-A467: `connect` used to flip `device.connected` / `status.active` and answer `Ok` with
    /// no platform call behind it. This pins the opposite: a refusal that explains itself, and a
    /// state that did not move. "It worked" is not something this operation may say while nothing
    /// was contacted.
    ///
    /// The device is put into the manager's own list instead of going through `start_discovery()`:
    /// on macOS/iOS discovery legitimately fails in a test thread (AVRouteDetector needs the main
    /// thread), which is exactly how the previous version of this test became a no-op — it read an
    /// empty list and asserted nothing at all.
    #[test]
    fn test_connect_refuses_and_does_not_fake_a_connection() {
        let mut mgr = AirPlayManager::new();
        if !mgr.is_available() {
            return;
        }

        let device = AirPlayDevice {
            id: "probe-device".to_string(),
            name: "A receiver the manager believes in".to_string(),
            kind: DeviceKind::AppleTv,
            supports_video: true,
            supports_audio: true,
            supports_mirroring: true,
            signal_strength: 50,
            connected: false,
        };
        mgr.devices.push(device);

        match mgr.connect("probe-device") {
            AirPlayResult::NotImplemented { reason } => {
                assert!(!reason.is_empty(), "a refusal must explain itself");
            }
            other => panic!("connect must refuse, got {other:?}"),
        }

        let status = mgr.get_status();
        assert!(
            !status.active,
            "a refused connect must not report an active session"
        );
        assert!(
            status.device.is_none(),
            "a refused connect must not name a device"
        );
        assert!(
            !mgr.get_devices().iter().any(|d| d.connected),
            "a refused connect must not mark the device connected"
        );
    }
}
