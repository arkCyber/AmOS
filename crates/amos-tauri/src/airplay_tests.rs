#[cfg(test)]
mod tests {
    use super::super::airplay::*;

    #[test]
    fn test_device_kind_serialization() {
        let kinds = vec![
            DeviceKind::AppleTv,
            DeviceKind::Tv,
            DeviceKind::Audio,
            DeviceKind::Generic,
        ];
        
        for kind in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            let deserialized: DeviceKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, deserialized);
        }
    }

    #[test]
    fn test_stream_kind_serialization() {
        let kinds = vec![
            StreamKind::Audio,
            StreamKind::Video,
            StreamKind::Mirroring,
        ];
        
        for kind in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            let deserialized: StreamKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, deserialized);
        }
    }

    #[test]
    fn test_airplay_device_creation() {
        let device = AirPlayDevice {
            id: "test-device-001".to_string(),
            name: "Test Apple TV".to_string(),
            kind: DeviceKind::AppleTv,
            supports_video: true,
            supports_audio: true,
            supports_mirroring: true,
            signal_strength: 85,
            connected: false,
        };

        assert_eq!(device.id, "test-device-001");
        assert_eq!(device.kind, DeviceKind::AppleTv);
        assert!(device.supports_video);
        assert!(!device.connected);
    }

    #[test]
    fn test_airplay_status_default() {
        let status = AirPlayStatus {
            active: false,
            device: None,
            stream_kind: None,
            playing: false,
            volume: 0.7,
        };

        assert!(!status.active);
        assert!(status.device.is_none());
        assert!(status.stream_kind.is_none());
        assert_eq!(status.volume, 0.7);
    }

    #[test]
    fn test_airplay_manager_new() {
        let manager = AirPlayManager::new();
        assert!(!manager.is_discovering());
        
        let status = manager.get_status();
        assert!(!status.active);
        assert!(status.device.is_none());
    }

    #[test]
    fn test_airplay_result_serialization() {
        let results = vec![
            AirPlayResult::Ok,
            AirPlayResult::Unavailable {
                reason: "Platform not supported".to_string(),
            },
            AirPlayResult::PermissionDenied {
                reason: "Network access denied".to_string(),
            },
            AirPlayResult::DeviceNotFound,
            AirPlayResult::Failed {
                reason: "Connection timeout".to_string(),
            },
        ];

        for result in results {
            let json = serde_json::to_string(&result).unwrap();
            let deserialized: AirPlayResult = serde_json::from_str(&json).unwrap();
            // Compare discriminants since the exact strings may differ
            match (&result, &deserialized) {
                (AirPlayResult::Ok, AirPlayResult::Ok) => (),
                (AirPlayResult::Unavailable { .. }, AirPlayResult::Unavailable { .. }) => (),
                (AirPlayResult::PermissionDenied { .. }, AirPlayResult::PermissionDenied { .. }) => (),
                (AirPlayResult::DeviceNotFound, AirPlayResult::DeviceNotFound) => (),
                (AirPlayResult::Failed { .. }, AirPlayResult::Failed { .. }) => (),
                _ => panic!("Mismatched AirPlayResult variants"),
            }
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn test_demo_devices() {
        let devices = AirPlayManager::demo_devices();
        assert_eq!(devices.len(), 3);

        let apple_tv = &devices[0];
        assert_eq!(apple_tv.name, "Living Room Apple TV");
        assert_eq!(apple_tv.kind, DeviceKind::AppleTv);
        assert!(apple_tv.supports_video);
        assert!(apple_tv.supports_audio);
        assert!(apple_tv.supports_mirroring);

        let samsung = &devices[1];
        assert_eq!(samsung.name, "Samsung Smart TV");
        assert_eq!(samsung.kind, DeviceKind::Tv);

        let speaker = &devices[2];
        assert_eq!(speaker.name, "HomePod Mini");
        assert_eq!(speaker.kind, DeviceKind::Audio);
        assert!(!speaker.supports_video);
        assert!(speaker.supports_audio);
    }

    #[test]
    fn test_manager_start_discovery() {
        let mut manager = AirPlayManager::new();
        let result = manager.start_discovery();
        
        match result {
            AirPlayResult::Ok => {
                assert!(manager.is_discovering());
            }
            AirPlayResult::Unavailable { .. } => {
                // Platform doesn't support AirPlay
                assert!(!manager.is_discovering());
            }
            _ => panic!("Unexpected result from start_discovery"),
        }
    }

    #[test]
    fn test_manager_stop_discovery() {
        let mut manager = AirPlayManager::new();
        let _ = manager.start_discovery();
        manager.stop_discovery();
        assert!(!manager.is_discovering());
    }

    #[test]
    fn test_manager_connect_device_not_found() {
        let mut manager = AirPlayManager::new();
        let result = manager.connect("nonexistent-device");
        
        match result {
            AirPlayResult::DeviceNotFound => (),
            AirPlayResult::Unavailable { .. } => {
                // Platform doesn't support AirPlay
            }
            _ => panic!("Expected DeviceNotFound or Unavailable"),
        }
    }

    #[test]
    fn test_manager_disconnect_not_connected() {
        let mut manager = AirPlayManager::new();
        let result = manager.disconnect();
        
        match result {
            AirPlayResult::Ok => {
                // Disconnect succeeded even when not connected (idempotent)
            }
            AirPlayResult::Unavailable { .. } => {
                // Platform doesn't support AirPlay
            }
            _ => panic!("Unexpected result from disconnect"),
        }
    }

    #[test]
    fn test_manager_volume_bounds() {
        let mut manager = AirPlayManager::new();
        
        // Test valid volumes
        assert!(matches!(manager.set_volume(0.0), AirPlayResult::Ok | AirPlayResult::Unavailable { .. }));
        assert!(matches!(manager.set_volume(0.5), AirPlayResult::Ok | AirPlayResult::Unavailable { .. }));
        assert!(matches!(manager.set_volume(1.0), AirPlayResult::Ok | AirPlayResult::Unavailable { .. }));
        
        // Test invalid volumes
        match manager.set_volume(-0.1) {
            AirPlayResult::Failed { reason } => {
                assert!(reason.contains("0.0") && reason.contains("1.0"));
            }
            AirPlayResult::Unavailable { .. } => {
                // Platform doesn't support AirPlay
            }
            _ => panic!("Expected Failed or Unavailable for negative volume"),
        }
        
        match manager.set_volume(1.5) {
            AirPlayResult::Failed { reason } => {
                assert!(reason.contains("0.0") && reason.contains("1.0"));
            }
            AirPlayResult::Unavailable { .. } => {
                // Platform doesn't support AirPlay
            }
            _ => panic!("Expected Failed or Unavailable for volume > 1.0"),
        }
    }

    #[test]
    fn test_airplay_state_new() {
        let state = AirPlayState::new();
        let manager = state.0.lock().unwrap();
        assert!(!manager.is_discovering());
    }

    #[test]
    fn test_platform_availability() {
        let available = AirPlayManager::is_available();
        
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        assert!(available);
        
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            // On other platforms, it may or may not be available
            // depending on platform-specific implementations
            let _ = available; // Just check it compiles
        }
    }

    #[test]
    fn test_unavailable_reason() {
        let reason = AirPlayManager::unavailable_reason();
        
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        assert!(reason.is_none(), "Should be available on macOS/iOS");
        
        #[cfg(all(not(target_os = "macos"), not(target_os = "ios"), target_os = "android"))]
        assert!(reason.is_some(), "Should have a reason on Android");
        
        #[cfg(all(not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android"), target_os = "linux"))]
        assert!(reason.is_some(), "Should have a reason on Linux");
    }
}
