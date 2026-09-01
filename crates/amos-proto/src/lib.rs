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
