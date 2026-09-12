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
// `http` comes via tonic's own re-export: the request type in `GrpcService::call` is
// `http::Request<_>`, and adding a direct dependency just to name it would risk drifting
// from the version tonic actually uses.
use tonic::codegen::http;
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;

/// Default loopback TCP address the on-device UI connects to.
pub const DEFAULT_TCP_ADDR: &str = "127.0.0.1:8787";

/// The daemon's TCP shared-secret header (mirrors `amos_ai::tcp_auth::TOKEN_HEADER`; the
/// Tauri shell deliberately does not depend on the daemon crate, so the name lives here
/// as a literal and the enforcement is tested on both sides).
const TOKEN_HEADER: &str = "x-amos-token";

/// A gRPC channel wrapper that puts `x-amos-token` on **every** request.
///
/// Why it exists (REQ-A144): the daemon can require a shared secret on its TCP transport
/// (`AMOS_TCP_TOKEN`), and every client of it — status, chat, sensors, telephony, LMK,
/// privacy — must then present it. Threading a header through each of those call sites
/// would be a per-request invitation to forget one, so it is attached here, once, at the
/// channel: the same place the transport itself is chosen.
///
/// Generic over the inner service so a test can drive it with a stub instead of a live
/// socket (the enforcing half lives in `amos-ai` and is covered by its TCP e2e).
#[derive(Debug, Clone)]
pub struct TokenChannel<S> {
    inner: S,
    header: Option<(http::HeaderName, http::HeaderValue)>,
}

/// The channel type every daemon client in this crate is built from.
pub type DaemonChannel = TokenChannel<Channel>;

impl<S> TokenChannel<S> {
    /// Wrap `inner`, attaching `token` (already-read value) when it is `Some`.
    ///
    /// A value that is not a legal header is **refused at construction** (with a warning)
    /// rather than silently dropped per request: a token the client cannot send is a
    /// configuration error, and the daemon would answer `PermissionDenied` anyway.
    pub fn with_token(inner: S, token: Option<&str>) -> Self {
        let header = match token {
            Some(tok) if !tok.trim().is_empty() => match http::HeaderValue::from_str(tok) {
                Ok(v) => Some((http::HeaderName::from_static(TOKEN_HEADER), v)),
                Err(e) => {
                    tracing::warn!(error = %e, "AMOS_TCP_TOKEN is not a valid header value; sending requests without it");
                    None
                }
            },
            _ => None,
        };
        Self { inner, header }
    }

    /// Wrap `inner`, reading the token from `AMOS_TCP_TOKEN` (the same variable the daemon
    /// reads). Called only for the **TCP** transport — over the Unix socket the daemon
    /// ignores this variable, so attaching it there would be noise.
    pub fn from_env(inner: S) -> Self {
        Self::with_token(inner, std::env::var("AMOS_TCP_TOKEN").ok().as_deref())
    }
}

impl<S> tonic::client::GrpcService<tonic::body::Body> for TokenChannel<S>
where
    S: tonic::client::GrpcService<tonic::body::Body>,
{
    type ResponseBody = S::ResponseBody;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: http::Request<tonic::body::Body>) -> Self::Future {
        if let Some((name, value)) = &self.header {
            fill_token(req.headers_mut(), name, value);
        }
        self.inner.call(req)
    }
}

/// Put the shared secret on `headers` unless a caller already set one there (an explicit
/// per-request value wins: the channel only fills the gap). Returns whether it inserted.
///
/// Split out of `call` so the rule is testable without a live socket or a body type.
fn fill_token(
    headers: &mut http::HeaderMap,
    name: &http::HeaderName,
    value: &http::HeaderValue,
) -> bool {
    if headers.contains_key(name) {
        return false;
    }
    headers.insert(name.clone(), value.clone());
    true
}

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
pub async fn channel() -> Result<DaemonChannel, String> {
    if let Ok(addr) = std::env::var("AMOS_TCP_ADDR") {
        if !addr.trim().is_empty() {
            return tcp_channel(addr.trim()).await;
        }
    }
    if tcp_default() {
        return tcp_channel(DEFAULT_TCP_ADDR).await;
    }
    Ok(TokenChannel::with_token(
        uds_channel(default_socket_path()).await?,
        None, // UDS: the daemon's peer-credential check covers it, not the token.
    ))
}

/// Connect over loopback TCP (`AMOS_TCP_ADDR` may point at a phone port forwarded
/// to the host via `adb forward`, or directly at the on-device daemon).
///
/// The shared secret (`AMOS_TCP_TOKEN`) travels on **every** request from here on: a
/// daemon started with a token refuses anything without it (REQ-A142/A144), so the token
/// is attached at the channel rather than at each of the ~10 client call sites.
async fn tcp_channel(addr: &str) -> Result<DaemonChannel, String> {
    let endpoint = Endpoint::try_from(format!("http://{addr}"))
        .map_err(|e| format!("bad tcp endpoint {addr}: {e}"))?
        .connect_timeout(std::time::Duration::from_secs(3));
    endpoint
        .connect()
        .await
        .map(TokenChannel::from_env)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `TokenChannel` is generic and construction has no trait bounds, so the header rules
    /// are testable with a placeholder inner service: no socket, no runtime, no body type.
    fn header_of<S>(ch: &TokenChannel<S>) -> Option<String> {
        ch.header
            .as_ref()
            .map(|(_, v)| v.to_str().expect("ascii value").to_owned())
    }

    #[test]
    fn token_is_attached_when_configured() {
        let ch = TokenChannel::with_token((), Some("s3cret"));
        assert_eq!(header_of(&ch).as_deref(), Some("s3cret"));
    }

    #[test]
    fn absent_or_blank_token_attaches_nothing() {
        // A blank secret is not a secret: it is treated as unset (mirroring the daemon's
        // `TcpPolicy::from_env`, which reports and ignores an empty AMOS_TCP_TOKEN).
        for raw in [None, Some(""), Some("   "), Some("\t\n")] {
            let ch = TokenChannel::with_token((), raw);
            assert!(
                header_of(&ch).is_none(),
                "blank token {raw:?} must attach nothing"
            );
        }
    }

    #[test]
    fn a_value_that_is_not_a_header_is_refused_at_construction() {
        // A newline cannot travel in a header. Sending a *different* value than the
        // operator configured would be worse than sending none, so the token is dropped
        // (loudly) rather than mangled — the daemon then answers PermissionDenied.
        let ch = TokenChannel::with_token((), Some("bad\nvalue"));
        assert!(header_of(&ch).is_none());
    }

    #[test]
    fn an_explicit_per_request_token_is_not_overwritten() {
        let name = http::HeaderName::from_static(TOKEN_HEADER);
        let value = http::HeaderValue::from_static("from-env");

        let mut headers = http::HeaderMap::new();
        assert!(fill_token(&mut headers, &name, &value), "gap is filled");
        assert_eq!(headers.get(&name).unwrap(), "from-env");

        // Second call: already present ⇒ left alone (and it is still exactly one value).
        let other = http::HeaderValue::from_static("from-request");
        assert!(!fill_token(&mut headers, &name, &other));
        assert_eq!(headers.get(&name).unwrap(), "from-env");
        assert_eq!(headers.get_all(&name).iter().count(), 1);
    }
}
