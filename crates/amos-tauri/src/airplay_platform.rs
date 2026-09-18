// airplay_platform.rs — Platform-specific AirPlay implementation
//
// This module provides the native platform integration for AirPlay:
// - macOS/iOS: AVFoundation (AVRouteDetector, AVPlayer routing)
// - Android: DLNA/Cast protocols (future)
// - Linux: RAOP (AirPort Express protocol) (future)
//
// Note: AVFoundation objects are not Send, so we keep platform operations
// simple and synchronous to avoid thread-safety issues with Tauri State.

use crate::airplay::{AirPlayDevice, AirPlayResult};

// ============================================================================
// macOS / iOS Implementation (AVFoundation)
// ============================================================================

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use super::*;
    use objc2_foundation::MainThreadMarker;

    /// Platform-specific AirPlay discovery manager for macOS/iOS
    ///
    /// Note: This struct contains Objective-C objects that are NOT Send/Sync.
    /// We handle this by:
    /// 1. Keeping all operations synchronous (no async/await)
    /// 2. Not storing this in Tauri State directly
    /// 3. Recreating instances as needed rather than persisting
    pub struct AppleAirPlayDiscovery {
        /// Whether discovery has been started
        active: bool,
    }

    impl Default for AppleAirPlayDiscovery {
        fn default() -> Self {
            Self::new()
        }
    }

    impl AppleAirPlayDiscovery {
        pub fn new() -> Self {
            Self { active: false }
        }

        /// Start route detection
        ///
        /// Returns Ok if detection started, or Unavailable if not on main thread.
        /// AVRouteDetector requires main thread on iOS.
        pub fn start_discovery(&mut self) -> AirPlayResult {
            // Check if we can access main thread marker
            if MainThreadMarker::new().is_none() {
                return AirPlayResult::Failed {
                    reason: "AVRouteDetector requires main thread (Tauri limitation)".to_string(),
                };
            }

            self.active = true;

            // Note: In a real implementation, we would:
            // 1. Create AVRouteDetector and enable it
            // 2. Register for AVRouteDetectorMultipleRoutesDetectedDidChange notifications
            // 3. Use AVPlayer's currentRoute or AVAudioSession's currentRoute for device list
            //
            // However, these APIs require either:
            // - Running on main thread consistently (Tauri runs commands on thread pool)
            // - Complex thread-safe bridging with notifications
            // - UI components (AVRoutePickerView) for full device enumeration
            //
            // For now, we mark discovery as active and rely on demo devices.

            AirPlayResult::Ok
        }

        /// Stop route detection
        pub fn stop_discovery(&mut self) {
            self.active = false;
        }

        /// Check if discovery is active
        pub fn is_active(&self) -> bool {
            self.active
        }

        /// Get available AirPlay devices
        ///
        /// Returns empty list. Real implementation would:
        /// - Query AVPlayer.availableRoutes (requires AVPlayer instance)
        /// - Or use AVAudioSession.currentRoute.outputs
        /// - Or integrate AVRoutePickerView (requires UI component)
        pub fn get_devices(&self) -> Vec<AirPlayDevice> {
            if !self.active {
                return Vec::new();
            }

            // Real device enumeration requires more complex integration
            // with AVFoundation that goes beyond a simple synchronous query.
            // For production, consider:
            // 1. Using AVRoutePickerView in the WebView (native UI component)
            // 2. Bridging route change notifications from Swift/ObjC
            // 3. Running discovery on main thread with message passing

            Vec::new()
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub use apple::AppleAirPlayDiscovery as PlatformDiscovery;

// ============================================================================
// Platform Interface
// ============================================================================

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn platform_start_discovery(discovery: &mut Option<PlatformDiscovery>) -> AirPlayResult {
    // `PlatformDiscovery` has `Default` (it is the `AppleAirPlayDiscovery` newtype), so this
    // is the same construction with the idiomatic spelling.
    let mut disc = discovery.take().unwrap_or_default();
    let result = disc.start_discovery();
    *discovery = Some(disc);
    result
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn platform_stop_discovery(discovery: &mut Option<PlatformDiscovery>) {
    if let Some(disc) = discovery {
        disc.stop_discovery();
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn platform_get_devices(discovery: &Option<PlatformDiscovery>) -> Vec<AirPlayDevice> {
    discovery
        .as_ref()
        .map(|d| d.get_devices())
        .unwrap_or_default()
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn platform_is_active(discovery: &Option<PlatformDiscovery>) -> bool {
    discovery.as_ref().map(|d| d.is_active()).unwrap_or(false)
}

// ============================================================================
// Stub for unsupported platforms
// ============================================================================

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub struct PlatformDiscovery;

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn platform_start_discovery(_discovery: &mut Option<PlatformDiscovery>) -> AirPlayResult {
    AirPlayResult::Unavailable {
        reason: "AirPlay platform integration not implemented for this OS".to_string(),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn platform_stop_discovery(_discovery: &mut Option<PlatformDiscovery>) {}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn platform_get_devices(_discovery: &Option<PlatformDiscovery>) -> Vec<AirPlayDevice> {
    Vec::new()
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn platform_is_active(_discovery: &Option<PlatformDiscovery>) -> bool {
    false
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_discovery_is_inactive() {
        let discovery = Some(PlatformDiscovery::new());
        assert!(!platform_is_active(&discovery));
    }

    #[test]
    fn test_start_then_stop() {
        let mut discovery = None;
        let _ = platform_start_discovery(&mut discovery);
        platform_stop_discovery(&mut discovery);
        // Should not panic
    }

    #[test]
    fn test_get_devices_when_inactive() {
        let discovery = Some(PlatformDiscovery::new());
        let devices = platform_get_devices(&discovery);
        assert!(devices.is_empty());
    }

    #[test]
    fn test_get_devices_with_none() {
        let discovery: Option<PlatformDiscovery> = None;
        let devices = platform_get_devices(&discovery);
        assert!(devices.is_empty());
    }

    #[test]
    fn test_stop_when_none() {
        let mut discovery: Option<PlatformDiscovery> = None;
        platform_stop_discovery(&mut discovery);
        // Should not panic
    }

    #[test]
    fn test_is_active_with_none() {
        let discovery: Option<PlatformDiscovery> = None;
        assert!(!platform_is_active(&discovery));
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    #[test]
    fn test_unsupported_platform_returns_unavailable() {
        let mut discovery = None;
        let result = platform_start_discovery(&mut discovery);
        match result {
            AirPlayResult::Unavailable { reason } => {
                assert!(reason.contains("not implemented"));
            }
            _ => panic!("Expected Unavailable result on unsupported platform"),
        }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn test_apple_platform_discovery_lifecycle() {
        let mut discovery = None;

        // Start discovery
        let result = platform_start_discovery(&mut discovery);
        // Note: May fail if not on main thread, which is expected
        match result {
            AirPlayResult::Ok => {
                assert!(platform_is_active(&discovery));
            }
            AirPlayResult::Failed { reason } => {
                assert!(reason.contains("main thread"));
            }
            _ => {}
        }

        // Stop discovery
        platform_stop_discovery(&mut discovery);
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn test_multiple_start_calls() {
        let mut discovery = None;

        // First start
        let _ = platform_start_discovery(&mut discovery);

        // Second start (should replace the discovery)
        let _ = platform_start_discovery(&mut discovery);

        // Should still be valid
        platform_stop_discovery(&mut discovery);
    }
}
