//! Shared amos RPC contract.
//!
//! Exposes the tonic-generated gRPC types for the `ai_agent` service plus a
//! small transport helper that decides where the Unix Domain Socket lives.
//! Both the daemon (`amos-ai`) and the System UI (`amos-tauri`) depend on
//! this crate so the wire contract can never drift between the two sides.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod ai_agent {
    //! Generated types: `ai_agent_client` (client), `ai_agent_server` (server),
    //! and all message structs (`AgentRequest`, `AgentChunk`, ...).
    tonic::include_proto!("ai_agent");
}

pub mod android_compat {
    //! Generated types: `android_manager_client` (client),
    //! `android_manager_server` (server), and message structs
    //! (`AppLaunchRequest`, `AndroidApp`, ...).
    tonic::include_proto!("android_compat");
}

pub mod translate {
    //! Generated types for the simultaneous-interpretation daemon:
    //! `translator_client` (client), `translator_server` (server), and messages
    //! (`TranslateRequest`, `TranslateIn`, `TranslateOut`, ...).
    tonic::include_proto!("translate");
}

pub mod amos_telephony {
    //! Generated types for the telephony service:
    //! `amos_telephony_client` (client), `amos_telephony_server` (server), and
    //! messages/enums (`DialRequest`, `CallSnapshot`, `CallState`, ...).
    tonic::include_proto!("amos_telephony");
}

pub mod amos_sensor {
    //! Generated types for the device-sensor service:
    //! `sensor_client` (client), `sensor_server` (server), and messages/enums
    //! (`CameraList`, `GnssReply`, `ImuReply`, `AcquireReply`, `SensorMode`, ...).
    tonic::include_proto!("amos_sensor");
}

pub mod amos_governor {
    //! Generated types for the resource-governor service:
    //! `governor_client` (client), `governor_server` (server), and messages/enums
    //! (`AppInfo`, `JobInfo`, `GovernorState`, `AppState`, `JobType`, ...).
    tonic::include_proto!("amos_governor");
}

pub mod amos_privacy {
    //! Generated types for the OS-permissions (PrivacyManager) service:
    //! `privacy_service_client` (client), `privacy_service_server` (server), and
    //! messages (`GrantRequest`, `ResourceRef`, `DecisionReply`, ...). Resources
    //! are addressed by their stable wire key, see `proto/privacy.proto`.
    tonic::include_proto!("amos_privacy");
}

pub mod amos_netguard {
    //! Generated types for the egress network-guard service:
    //! `net_guard_service_client` (client), `net_guard_service_server` (server),
    //! and messages (`ToggleRequest`, `StatusReply`, `EgressSample`, ...). Honest
    //! enforcement caveats live in `proto/netguard.proto` and
    //! `docs/anti-telemetry-egress-guard.md`.
    tonic::include_proto!("amos_netguard");
}

pub mod amos_telemetry_spy {
    //! Generated types for the passive telemetry-spy service:
    //! `telemetry_spy_service_client` (client),
    //! `telemetry_spy_service_server` (server), and messages (`EgressHit`,
    //! `IdentifierHit`, enums `Confidence`/`IdentifierKind`/`Protocol`). A hit
    //! is a **low-confidence heuristic** (plaintext substring), never a claimed
    //! confirmed leak — see `proto/telemetry_spy.proto`.
    tonic::include_proto!("amos_telemetry_spy");
}

pub mod amos_link {
    //! Generated types for the AmOS-Link control plane (the robot middleware):
    //! `robot_link_client` (client), `robot_link_server` (server), and messages
    //! (`LinkStatus`, `TopicList`, `PublishRequest`/`PublishReply`, `Heartbeat`,
    //! `Metrics`, `Peer`). Data-plane frames do **not** travel here — they are
    //! `Envelope`-framed payloads over an AmOS-Link transport; see
    //! `proto/robot_link.proto` and `docs/amos-link.md`.
    tonic::include_proto!("amos_link");
}

/// gRPC metadata header carrying the caller's client id.
///
/// The System UI (Tauri core) sends this on every RPC so the daemon's security
/// layer can apply per-client rate limits and attribute each audit entry to a
/// concrete caller instead of an anonymous "default".
pub const CLIENT_ID_HEADER: &str = "x-amos-client";

/// Default client id used when a caller does not send [`CLIENT_ID_HEADER`]
/// (legacy clients, the boot readiness probe, or third-party tools).
///
/// The daemon grants this identity `Standard` access by default so existing
/// callers keep working once security is enabled.
pub const DEFAULT_CLIENT_ID: &str = "system-ui";

/// Resolution of the Unix Domain Socket used for inter-process RPC.
pub mod socket {
    use std::path::PathBuf;

    /// The environment variable that overrides the socket path. Kept as a
    /// const so the seam and the environment can never drift.
    pub const SOCKET_ENV: &str = "AMOS_SOCKET";

    /// Default location of the amos AI daemon socket.
    ///
    /// Override at runtime with the `AMOS_SOCKET` environment variable. This
    /// matters on mobile, where the sandbox forces the socket into app-private
    /// storage rather than the global `/var/run` path.
    ///
    /// The knob is read as **three** facts, not two: **unset** (or blank) ⇒ the
    /// platform default, silently; a **usable** path ⇒ that path; a value the
    /// operator set but which cannot be read as UTF-8 ⇒ reported once, then the
    /// default — so an unreadable override is never silently mistaken for
    /// "unset". Every sibling reader of this same variable already reports it
    /// (`amos-ai::resolve_socket`, `amos-translate::socket_env`); this one, the
    /// authority both the daemon and the System UI depend on, did not.
    /// (REQ-A2008 / F-PROTO-001)
    pub fn default_socket_path() -> PathBuf {
        socket_path_from(SOCKET_ENV, std::env::var_os(SOCKET_ENV))
    }

    /// Pure three-state read of the socket override (the raw `OsString` is
    /// injected so every arm is reachable in a test).
    pub(crate) fn socket_path_from(key: &str, raw: Option<std::ffi::OsString>) -> PathBuf {
        if let Some(raw) = raw {
            match raw.into_string() {
                Ok(path) if !path.is_empty() => return PathBuf::from(path),
                // Blank is a legitimate "unset": silent.
                Ok(_) => {}
                Err(_) => report_bad_socket_env(key),
            }
        }
        platform_default_socket_path()
    }

    /// The platform's fallback socket path, used when the knob is unset (or
    /// unreadable).
    pub(crate) fn platform_default_socket_path() -> PathBuf {
        #[cfg(target_os = "android")]
        {
            // App-private storage on Android (must match the daemon's runtime dir).
            PathBuf::from("/data/local/tmp/amos-ai.sock")
        }
        #[cfg(all(unix, not(target_os = "android")))]
        {
            PathBuf::from("/tmp/amos-ai.sock")
        }
        #[cfg(not(unix))]
        {
            PathBuf::from("amos-ai.sock")
        }
    }

    fn bad_socket_env_seen(
    ) -> &'static std::sync::Mutex<std::collections::BTreeSet<(String, String)>> {
        static SEEN: std::sync::OnceLock<
            std::sync::Mutex<std::collections::BTreeSet<(String, String)>>,
        > = std::sync::OnceLock::new();
        SEEN.get_or_init(Default::default)
    }

    #[cfg(test)]
    pub(crate) fn bad_socket_env_reports_for(key: &str) -> usize {
        bad_socket_env_seen()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(k, _)| k == key)
            .count()
    }

    fn report_bad_socket_env(key: &str) {
        let first = bad_socket_env_seen()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert((key.to_owned(), "<non-Unicode>".to_owned()));
        if first {
            tracing::warn!(
                env = key,
                "amos-proto: the socket override is set but is not valid Unicode; falling back \
                 to the platform default socket — fix or unset the variable"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn socket_path_is_derivable() {
        let _ = crate::socket::default_socket_path();
    }

    #[cfg(unix)]
    fn non_unicode(raw: &[u8]) -> std::ffi::OsString {
        use std::os::unix::ffi::OsStringExt;
        std::ffi::OsString::from_vec(raw.to_vec())
    }

    #[test]
    fn an_unset_socket_override_is_the_platform_default_and_silent() {
        let path = crate::socket::socket_path_from("TEST_PROTO_SOCK_UNSET", None);
        assert_eq!(path, crate::socket::platform_default_socket_path());
        assert_eq!(
            crate::socket::bad_socket_env_reports_for("TEST_PROTO_SOCK_UNSET"),
            0
        );
    }

    #[test]
    fn a_blank_socket_override_is_the_platform_default_and_silent() {
        let path = crate::socket::socket_path_from("TEST_PROTO_SOCK_BLANK", Some("".into()));
        assert_eq!(path, crate::socket::platform_default_socket_path());
        assert_eq!(
            crate::socket::bad_socket_env_reports_for("TEST_PROTO_SOCK_BLANK"),
            0
        );
    }

    #[test]
    fn a_usable_socket_override_is_read_as_given() {
        let raw: std::ffi::OsString = "/run/amos/translate.sock".into();
        let path = crate::socket::socket_path_from("TEST_PROTO_SOCK_OK", Some(raw));
        assert_eq!(path, std::path::PathBuf::from("/run/amos/translate.sock"));
        assert_eq!(
            crate::socket::bad_socket_env_reports_for("TEST_PROTO_SOCK_OK"),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_non_unicode_socket_override_is_reported_not_read_as_unset() {
        let key = "TEST_PROTO_SOCK_MOJIBAKE";
        let path = crate::socket::socket_path_from(key, Some(non_unicode(b"/run/amos/\xff.sock")));
        assert_eq!(path, crate::socket::platform_default_socket_path());
        assert_eq!(
            crate::socket::bad_socket_env_reports_for(key),
            1,
            "a set-but-unreadable AMOS_SOCKET must be reported, not silently folded into the default"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_repeated_bad_socket_override_is_reported_once() {
        let key = "TEST_PROTO_SOCK_DEDUP";
        let _ = crate::socket::socket_path_from(key, Some(non_unicode(b"\xfe\xff")));
        let _ = crate::socket::socket_path_from(key, Some(non_unicode(b"\xfe\xff")));
        assert_eq!(crate::socket::bad_socket_env_reports_for(key), 1);
    }

    #[test]
    fn the_authority_reads_the_override_via_var_os_not_var() {
        let src = include_str!("lib.rs");
        assert!(src.contains("std::env::var_os(SOCKET_ENV)"));
        // The needle is assembled at run time so this test's *own* literal does
        // not satisfy the `include_str!` scan it performs (a self-referential
        // corpus).
        let folded_twin = format!("std::env::var({}{})", "\"AMOS_SOC", "KET\"");
        assert!(
            !src.contains(&folded_twin),
            "default_socket_path must read the override with var_os, so a set-but-non-Unicode \
             path is reported rather than silently treated as unset"
        );
    }
}
