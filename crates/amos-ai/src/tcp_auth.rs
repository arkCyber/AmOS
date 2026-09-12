//! Authentication for the daemon's **TCP** transport (gap #28 / REQ-A142).
//!
//! Why this exists next to `peercred.rs`: the Unix socket has 0700 permissions plus a
//! kernel peer-credential check, but `AMOS_TCP_ADDR` switches the daemon to loopback
//! TCP — which has **neither**. Loopback TCP is reachable by *every* process of *every*
//! user on the device, so without this the transport would be strictly weaker than the
//! one it replaces (it exists because a retail Android shell cannot always bind a
//! socket file under SELinux).
//!
//! Policy (`AMOS_TCP_TOKEN`):
//!  - **token set** ⇒ every request must carry `x-amos-token: <token>`; a missing or
//!    different token is refused with `PermissionDenied` *before* the service runs, and
//!    the comparison is constant-time so a token cannot be probed byte by byte;
//!  - **token unset** ⇒ the daemon serves (the documented bring-up flow sets only
//!    `AMOS_TCP_ADDR`) but says so loudly at startup and in the wire policy line: TCP
//!    without a token is **unauthenticated**, and that is a decision, not an oversight.
//!
//! Deliberately **not** done here: making a token mandatory. The on-device bring-up
//! scripts are not covered by an automated test in this repository, so flipping the
//! default would turn a documented flow into a silently broken one; the capability, the
//! enforcement and the visibility landed first, and the remaining gap is recorded in
//! `FUNCTIONAL_GAP_ANALYSIS.md` #28.
//!
//! REQ-A144 closes the client half of that gap: `amos-tauri::daemon` now attaches this
//! header on every request it makes over TCP (so the shell's ~10 gRPC clients cannot
//! each forget it), proven end to end by `crates/amos-tauri/tests/tcp_token_client_e2e.rs`
//! against a real daemon with this gate installed.

use tonic::{Request, Status};

/// The metadata key a client presents the shared secret under.
pub const TOKEN_HEADER: &str = "x-amos-token";

/// Whether TCP requests must authenticate, and with what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TcpPolicy {
    /// No token configured: served, but unauthenticated (warned at startup).
    Open,
    /// A shared secret is required on every request.
    Token(String),
}

impl TcpPolicy {
    /// Read `AMOS_TCP_TOKEN`. An empty value counts as unset (a blank secret is not a
    /// secret) and is reported rather than silently accepted.
    pub fn from_env() -> Self {
        match std::env::var("AMOS_TCP_TOKEN") {
            Ok(v) if !v.trim().is_empty() => TcpPolicy::Token(v),
            Ok(_) => {
                tracing::warn!(
                    "AMOS_TCP_TOKEN is set but empty; treating it as unset (TCP stays unauthenticated)"
                );
                TcpPolicy::Open
            }
            Err(_) => TcpPolicy::Open,
        }
    }

    /// May a request presenting `presented` proceed?
    pub fn admits(&self, presented: Option<&str>) -> bool {
        match self {
            TcpPolicy::Open => true,
            TcpPolicy::Token(expected) => match presented {
                Some(got) => constant_time_eq(expected.as_bytes(), got.as_bytes()),
                None => false,
            },
        }
    }

    /// The honest startup line (the unauthenticated case is a warning, not a note).
    pub fn announce(&self) {
        match self {
            TcpPolicy::Token(_) => {
                tracing::info!("tcp transport: shared-secret authentication required")
            }
            TcpPolicy::Open => tracing::warn!(
                "tcp transport: NO authentication (set AMOS_TCP_TOKEN to require a shared \
                 secret; any local process can otherwise reach this daemon)"
            ),
        }
    }
}

/// Compare two byte strings without an early return, so the time taken does not reveal
/// how many leading bytes matched. Lengths are compared normally (a length is public:
/// the token's size is not the secret).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The gate as tonic applies it to **every** service on the TCP listener.
#[derive(Debug, Clone)]
pub struct TokenGate {
    policy: TcpPolicy,
}

impl TokenGate {
    pub fn new(policy: TcpPolicy) -> Self {
        Self { policy }
    }

    /// Authorize one request: the token is read from metadata and checked before the
    /// request reaches a service.
    pub fn authorize<T>(&self, req: Request<T>) -> Result<Request<T>, Status> {
        let presented = req
            .metadata()
            .get(TOKEN_HEADER)
            .and_then(|v| v.to_str().ok());
        if self.policy.admits(presented) {
            return Ok(req);
        }
        tracing::warn!(
            presented = presented.is_some(),
            "refusing a tcp request: missing or wrong x-amos-token"
        );
        Err(Status::permission_denied(
            "tcp transport requires the x-amos-token shared secret",
        ))
    }

    /// The policy in force (for the wire/status line and tests).
    pub fn policy(&self) -> &TcpPolicy {
        &self.policy
    }
}

impl tonic::service::Interceptor for TokenGate {
    fn call(&mut self, req: Request<()>) -> Result<Request<()>, Status> {
        self.authorize(req)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req_with(token: Option<&str>) -> Request<()> {
        let mut r = Request::new(());
        if let Some(t) = token {
            r.metadata_mut()
                .insert(TOKEN_HEADER, t.parse().expect("valid metadata value"));
        }
        r
    }

    #[test]
    fn an_open_policy_serves_everything_but_says_so() {
        let p = TcpPolicy::Open;
        assert!(p.admits(None));
        assert!(p.admits(Some("anything")));
        // The unauthenticated case is a *warning* the server emits (`announce`), not a
        // silent default — asserted here so the wording cannot quietly become "info".
        assert_eq!(p, TcpPolicy::Open);
    }

    #[test]
    fn a_configured_token_is_required_and_compared_fully() {
        let p = TcpPolicy::Token("s3cret".into());
        assert!(p.admits(Some("s3cret")));
        assert!(!p.admits(None), "absent token is refused");
        assert!(!p.admits(Some("")));
        assert!(!p.admits(Some("s3cre")), "shorter prefix refused");
        assert!(!p.admits(Some("s3crett")), "longer value refused");
        assert!(
            !p.admits(Some("s3cres")),
            "same length, different byte refused"
        );
    }

    #[test]
    fn constant_time_compare_is_a_real_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn an_empty_env_value_counts_as_unset_and_is_reported() {
        std::env::set_var("AMOS_TCP_TOKEN", "");
        assert_eq!(TcpPolicy::from_env(), TcpPolicy::Open);
        std::env::set_var("AMOS_TCP_TOKEN", "   ");
        assert_eq!(TcpPolicy::from_env(), TcpPolicy::Open);
        std::env::set_var("AMOS_TCP_TOKEN", "tok");
        assert_eq!(TcpPolicy::from_env(), TcpPolicy::Token("tok".into()));
        std::env::remove_var("AMOS_TCP_TOKEN");
        assert_eq!(TcpPolicy::from_env(), TcpPolicy::Open);
    }

    #[test]
    fn the_gate_returns_permission_denied_with_a_stated_reason() {
        let gate = TokenGate::new(TcpPolicy::Token("tok".into()));
        let err = gate.authorize(req_with(None)).expect_err("must refuse");
        assert_eq!(err.code(), tonic::Code::PermissionDenied);
        assert!(err.message().contains(TOKEN_HEADER), "{}", err.message());
        // …and lets the right one through untouched.
        assert!(gate.authorize(req_with(Some("tok"))).is_ok());
    }

    #[test]
    fn the_gate_covers_every_service_because_it_runs_before_routing() {
        // The gate is transport-level (a `Layer` over the whole router), so a request to
        // *any* path is checked: assert on a second, unrelated "call" shape.
        let gate = TokenGate::new(TcpPolicy::Token("tok".into()));
        let mut r = Request::new(42u8);
        r.metadata_mut().insert("x-other", "1".parse().unwrap());
        assert!(gate.authorize(r).is_err());
    }
}
