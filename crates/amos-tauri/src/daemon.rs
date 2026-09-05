//! Shared gRPC channel factory for the AmOS AI daemon bridge.
//!
//! Every System-UI client of `amos-ai` (status / chat / sensors / telephony /
//! task-manager / LMK / privacy audit) builds its channel here so the transport can
//! be switched in one place:
//!
//! * **UDS** (default) — the product transport: the daemon listens on a Unix socket
//!   (`AMOS_SOCKET`, else the platform default).
//! * **Loopback TCP** — the on-device / host-target "retail Android" bring-up
//!   transport. Selected when the `tcp` cargo feature is on (the on-device APK is
//!   built with `-f android,tcp`) *or* `AMOS_TCP_ADDR` is set (any build, e.g. a
//!   desktop host talking to a phone daemon over `adb forward`).
//!
//! The daemon side is `crates/amos-ai/src/server.rs::serve` (`resolve_tcp_addr`),
//! which serves the identical gRPC stack over TCP when `AMOS_TCP_ADDR` is set.

use amos_proto::socket::default_socket_path;
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;

/// Default loopback TCP address the on-device UI connects to.
pub const DEFAULT_TCP_ADDR: &str = "127.0.0.1:8787";

/// True when the `tcp` cargo feature is enabled for this build (the on-device APK).
#[cfg(feature = "tcp")]
fn tcp_default() -> bool {
    true
}

#[cfg(not(feature = "tcp"))]
fn tcp_default() -> bool {
    false
}

/// Open a gRPC channel to the amos-ai daemon over the configured transport.
///
/// Precedence: `AMOS_TCP_ADDR` env (any build) → `tcp` feature default → Unix socket.
pub async fn channel() -> Result<Channel, String> {
    if let Ok(addr) = std::env::var("AMOS_TCP_ADDR") {
        if !addr.trim().is_empty() {
            return tcp_channel(addr.trim()).await;
        }
    }
    if tcp_default() {
        return tcp_channel(DEFAULT_TCP_ADDR).await;
    }
    uds_channel(default_socket_path()).await
}

/// Connect over loopback TCP (`AMOS_TCP_ADDR` may point at a phone port forwarded
/// to the host via `adb forward`, or directly at the on-device daemon).
async fn tcp_channel(addr: &str) -> Result<Channel, String> {
    let endpoint = Endpoint::try_from(format!("http://{addr}"))
        .map_err(|e| format!("bad tcp endpoint {addr}: {e}"))?
        .connect_timeout(std::time::Duration::from_secs(3));
    endpoint
        .connect()
        .await
        .map_err(|e| format!("amos-ai daemon not reachable over tcp {addr}: {e}"))
}

/// Connect over the daemon's Unix domain socket.
async fn uds_channel(path: std::path::PathBuf) -> Result<Channel, String> {
    let display = path.display().to_string();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = path.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| format!("amos-ai daemon not reachable at socket {display}: {e}"))
}
