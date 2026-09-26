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
            AirPlayResult::NotImplemented {
                reason: "No platform implementation".to_string(),
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
                (AirPlayResult::NotImplemented { .. }, AirPlayResult::NotImplemented { .. }) => (),
                _ => panic!("Mismatched AirPlayResult variants"),
            }
        }
    }

    /// REQ-A467: the `kind` strings are the frontend contract (`lib/airplay.ts`). Two of them used
    /// to be *unreachable lies*: `rename_all = "lowercase"` emitted `"permissiondenied"` /
    /// `"devicenotfound"` while the declared union said `permission_denied` / `device_not_found`.
    /// Nothing compared them, so nothing noticed — and any per-kind handling (like the panel's
    /// refusal message) would have silently fallen through. This pins the wire form itself.
    #[test]
    fn test_airplay_result_wire_form() {
        let cases: [(AirPlayResult, &str); 6] = [
            (AirPlayResult::Ok, r#"{"kind":"ok"}"#),
            (
                AirPlayResult::Unavailable {
                    reason: "r".to_string(),
                },
                r#"{"kind":"unavailable","reason":"r"}"#,
            ),
            (
                AirPlayResult::PermissionDenied {
                    reason: "r".to_string(),
                },
                r#"{"kind":"permission_denied","reason":"r"}"#,
            ),
            (
                AirPlayResult::DeviceNotFound,
                r#"{"kind":"device_not_found"}"#,
            ),
            (
                AirPlayResult::Failed {
                    reason: "r".to_string(),
                },
                r#"{"kind":"failed","reason":"r"}"#,
            ),
            (
                AirPlayResult::NotImplemented {
                    reason: "r".to_string(),
                },
                r#"{"kind":"not_implemented","reason":"r"}"#,
            ),
        ];

        for (value, expected) in cases {
            assert_eq!(serde_json::to_string(&value).unwrap(), expected);
            let back: AirPlayResult = serde_json::from_str(expected).unwrap();
            assert_eq!(
                serde_json::to_string(&back).unwrap(),
                expected,
                "the wire form must survive a round trip"
            );
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

    /// REQ-A467: `set_volume` used to clamp into `status.volume` and answer `Ok` with a
    /// `TODO: Send volume command to device` under it. It now refuses with a reason and leaves the
    /// status alone — the clamp lost its meaning once that write went away.
    #[test]
    fn test_manager_volume_refuses_without_moving_the_status() {
        let mut manager = AirPlayManager::new();
        let before = manager.get_status().volume;

        for requested in [0.0_f32, 0.5, 1.0, -0.1, 1.5] {
            match manager.set_volume(requested) {
                AirPlayResult::NotImplemented { reason } => {
                    assert!(!reason.is_empty(), "a refusal must explain itself");
                }
                other => panic!("set_volume must refuse, got {other:?}"),
            }
        }

        assert_eq!(
            manager.get_status().volume,
            before,
            "a refused volume change must not edit the status"
        );
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
