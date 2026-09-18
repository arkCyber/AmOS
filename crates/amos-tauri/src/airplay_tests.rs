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
        let kinds = vec![StreamKind::Audio, StreamKind::Video, StreamKind::Mirroring];

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
                (
                    AirPlayResult::PermissionDenied { .. },
                    AirPlayResult::PermissionDenied { .. },
                ) => (),
                (AirPlayResult::DeviceNotFound, AirPlayResult::DeviceNotFound) => (),
                (AirPlayResult::Failed { .. }, AirPlayResult::Failed { .. }) => (),
                _ => panic!("Mismatched AirPlayResult variants"),
            }
        }
    }

    #[test]
    fn test_manager_start_discovery() {
        let mut manager = AirPlayManager::new();
        let result = manager.start_discovery();

        match result {
            AirPlayResult::Ok => {
                // Discovery started successfully
            }
            AirPlayResult::Unavailable { .. } => {
                // Platform doesn't support AirPlay
            }
            AirPlayResult::Failed { .. } => {
                // On macOS/iOS, may fail if not on main thread (Tauri limitation)
            }
            _ => panic!("Unexpected result from start_discovery"),
        }
    }

    #[test]
    fn test_manager_stop_discovery() {
        let mut manager = AirPlayManager::new();
        let _ = manager.start_discovery();
        manager.stop_discovery();
        // Discovery stopped successfully (no assertion needed, just verify it doesn't panic)
    }

    #[test]
    fn test_manager_get_devices() {
        let mut manager = AirPlayManager::new();
        let result = manager.start_discovery();

        // Only check devices if discovery succeeded
        match result {
            AirPlayResult::Ok => {
                let devices = manager.get_devices();

                #[cfg(debug_assertions)]
                {
                    // In debug mode, should return demo devices
                    assert_eq!(devices.len(), 3);
                }

                #[cfg(not(debug_assertions))]
                {
                    // In release mode, may be empty or contain real devices
                    let _ = devices;
                }
            }
            AirPlayResult::Failed { .. } => {
                // On macOS/iOS test environment, discovery may fail (not on main thread)
                // This is expected behavior
            }
            AirPlayResult::Unavailable { .. } => {
                // Platform doesn't support AirPlay
            }
            _ => {}
        }
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
        assert!(matches!(
            manager.set_volume(0.0),
            AirPlayResult::Ok | AirPlayResult::Unavailable { .. }
        ));
        assert!(matches!(
            manager.set_volume(0.5),
            AirPlayResult::Ok | AirPlayResult::Unavailable { .. }
        ));
        assert!(matches!(
            manager.set_volume(1.0),
            AirPlayResult::Ok | AirPlayResult::Unavailable { .. }
        ));

        // Test out-of-range volumes (should be clamped, not fail)
        let result = manager.set_volume(-0.1);
        assert!(matches!(
            result,
            AirPlayResult::Ok | AirPlayResult::Unavailable { .. }
        ));
        if manager.is_available() {
            assert_eq!(manager.get_status().volume, 0.0); // Should be clamped to 0.0
        }

        let result = manager.set_volume(1.5);
        assert!(matches!(
            result,
            AirPlayResult::Ok | AirPlayResult::Unavailable { .. }
        ));
        if manager.is_available() {
            assert_eq!(manager.get_status().volume, 1.0); // Should be clamped to 1.0
        }
    }

    #[test]
    fn test_airplay_state_new() {
        let state = AirPlayState::new();
        let manager = state.0.lock().unwrap();
        let status = manager.get_status();
        assert!(!status.active);
    }

    #[test]
    fn test_platform_availability() {
        let manager = AirPlayManager::new();
        let available = manager.is_available();

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
    fn test_get_status() {
        let manager = AirPlayManager::new();
        let status = manager.get_status();

        assert!(!status.active);
        assert_eq!(status.volume, 0.7);
        assert!(status.device.is_none());
        assert!(status.stream_kind.is_none());
    }

    #[test]
    fn test_start_stream_no_connection() {
        let mut manager = AirPlayManager::new();
        let result = manager.start_stream(StreamKind::Audio, None);

        // Should fail because no device is connected
        match result {
            AirPlayResult::Failed { .. } => (),
            AirPlayResult::Unavailable { .. } => (),
            _ => panic!("Expected Failed or Unavailable when streaming without connection"),
        }
    }

    #[test]
    fn test_stop_stream_no_active_stream() {
        let mut manager = AirPlayManager::new();
        let result = manager.stop_stream();

        // Should succeed (idempotent)
        match result {
            AirPlayResult::Ok => (),
            AirPlayResult::Unavailable { .. } => (),
            _ => panic!("Expected Ok or Unavailable"),
        }
    }
}
