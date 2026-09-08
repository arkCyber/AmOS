//! Shared amos RPC contract.
//!
//! Exposes the tonic-generated gRPC types for the `ai_agent` service plus a
//! small transport helper that decides where the Unix Domain Socket lives.
//! Both the daemon (`amos-ai`) and the System UI (`amos-tauri`) depend on
//! this crate so the wire contract can never drift between the two sides.

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

    /// Default location of the amos AI daemon socket.
    ///
    /// Override at runtime with the `AMOS_SOCKET` environment variable. This
    /// matters on mobile, where the sandbox forces the socket into app-private
    /// storage rather than the global `/var/run` path.
    pub fn default_socket_path() -> PathBuf {
        if let Ok(p) = std::env::var("AMOS_SOCKET") {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
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
}

#[cfg(test)]
mod tests {
    #[test]
    fn socket_path_is_derivable() {
        let _ = crate::socket::default_socket_path();
    }
}
