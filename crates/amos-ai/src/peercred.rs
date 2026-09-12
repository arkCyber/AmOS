//! Peer-credential check for the daemon's Unix socket (gap #28 / REQ-A141).
//!
//! The socket file is created `0700`, which keeps *other* users out — but that is a
//! **filesystem property, not an authentication step**: it does not help when the path
//! is reached through a copied or replaced socket file, a shared parent directory, or a
//! root-owned parent, and it cannot tell the shell's UI apart from any other process
//! running as the same user. This module asks the kernel instead: *who is on the other
//! end of this connection?* — `SO_PEERCRED` on Linux/Android, `getpeereid` on
//! macOS/BSD, both of which the kernel fills in and the peer cannot forge.
//!
//! Honest boundaries (gap #28 stays partly open, on purpose):
//!  - this is **authentication of the peer's user id**. It is **not** authorization
//!    (there is still no per-client capability check), **not** encryption, and it does
//!    **not** verify the pid (pids are racy and unnecessary for the user check);
//!  - when the platform cannot answer (`Unverifiable`), the policy decides — the
//!    default admits and logs, `AMOS_UDS_PEER=require` refuses. Never silent.

use std::os::fd::AsRawFd;

/// What the kernel said about the process on the other end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerVerdict {
    /// Both user ids are known and equal — the shell's own user.
    SameUser,
    /// The peer runs as a different user (uid given for the log line).
    Foreign(u32),
    /// The platform could not answer (or we could not determine our own uid).
    Unverifiable,
}

/// What to do about an unverifiable peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Refuse a *different* user; admit when the answer is unknown (default).
    Enforce,
    /// Log only — never refuse (for diagnosing a platform without peer creds).
    WarnOnly,
    /// Refuse anything that is not provably the same user (`AMOS_UDS_PEER=require`).
    Require,
}

impl Policy {
    /// `AMOS_UDS_PEER` = `warn` | `enforce` (default) | `require`. An unknown value is
    /// reported and treated as the default rather than silently changing the level.
    pub fn from_env() -> Self {
        match std::env::var("AMOS_UDS_PEER").ok().as_deref() {
            Some("warn") => Policy::WarnOnly,
            Some("require") => Policy::Require,
            Some("enforce") | None => Policy::Enforce,
            Some(other) => {
                tracing::warn!(
                    value = other,
                    "unknown AMOS_UDS_PEER (expected warn|enforce|require); using enforce"
                );
                Policy::Enforce
            }
        }
    }
}

/// Classify a peer from the two uid readings (pure — the whole policy is testable).
pub fn verdict(our_uid: Option<u32>, peer_uid: Option<u32>) -> PeerVerdict {
    match (our_uid, peer_uid) {
        (Some(ours), Some(theirs)) if ours == theirs => PeerVerdict::SameUser,
        (Some(_), Some(theirs)) => PeerVerdict::Foreign(theirs),
        _ => PeerVerdict::Unverifiable,
    }
}

/// May this connection be served?
pub fn admits(v: PeerVerdict, policy: Policy) -> bool {
    match (v, policy) {
        (PeerVerdict::SameUser, _) => true,
        (PeerVerdict::Foreign(_), Policy::WarnOnly) => true,
        (PeerVerdict::Foreign(_), _) => false,
        (PeerVerdict::Unverifiable, Policy::Require) => false,
        (PeerVerdict::Unverifiable, _) => true,
    }
}

/// Our effective uid, or `None` if the platform cannot report it.
pub fn our_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        // SAFETY: `geteuid` takes no arguments and cannot fail.
        Some(unsafe { libc::geteuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// The peer's uid as reported by the kernel, or `None` when it cannot be determined
/// (unsupported platform, or the query failed).
pub fn peer_uid(stream: &tokio::net::UnixStream) -> Option<u32> {
    peer_uid_fd(stream.as_raw_fd())
}

/// The platform half of [`peer_uid`], split out so a test can pass its own socket fd.
pub fn peer_uid_fd(fd: std::os::fd::RawFd) -> Option<u32> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        // SAFETY: `getsockopt` writes a `ucred` through a pointer whose length we pass
        // correctly; the fd is borrowed from a live socket for the duration of the call.
        unsafe {
            let mut cred: libc::ucred = std::mem::zeroed();
            let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            let rc = libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut _ as *mut libc::c_void,
                &mut len,
            );
            if rc == 0 && len as usize == std::mem::size_of::<libc::ucred>() {
                Some(cred.uid)
            } else {
                None
            }
        }
    }
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    {
        // SAFETY: `getpeereid` writes uid/gid through valid out-pointers; the fd is
        // borrowed from a live socket for the duration of the call.
        unsafe {
            let mut uid: libc::uid_t = 0;
            let mut gid: libc::gid_t = 0;
            if libc::getpeereid(fd, &mut uid, &mut gid) == 0 {
                Some(uid)
            } else {
                None
            }
        }
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd"
    )))]
    {
        let _ = fd;
        None
    }
}

/// The check as the server uses it: our uid + the policy, applied to a live socket.
#[derive(Debug, Clone, Copy)]
pub struct PeerGuard {
    ours: Option<u32>,
    policy: Policy,
}

impl PeerGuard {
    /// Build from the process environment (`AMOS_UDS_PEER`).
    pub fn from_env() -> Self {
        Self {
            ours: our_uid(),
            policy: Policy::from_env(),
        }
    }

    /// The verdict for this connection (exposed for the log line and tests).
    pub fn verdict_for(&self, stream: &tokio::net::UnixStream) -> PeerVerdict {
        verdict(self.ours, peer_uid(stream))
    }

    /// Should this connection be served? Every refusal is logged, and so is the
    /// unverifiable case — "we could not check" must never be silent.
    pub fn admits(&self, stream: &tokio::net::UnixStream) -> bool {
        let v = self.verdict_for(stream);
        let ok = admits(v, self.policy);
        match (v, ok) {
            (PeerVerdict::Foreign(uid), _) => tracing::warn!(
                peer_uid = uid,
                our_uid = self.ours.unwrap_or(0),
                policy = ?self.policy,
                "refusing a unix-socket connection from a different user"
            ),
            (PeerVerdict::Unverifiable, false) => tracing::warn!(
                "refusing a unix-socket connection: peer credentials unavailable and AMOS_UDS_PEER=require"
            ),
            (PeerVerdict::Unverifiable, true) => tracing::warn!(
                "serving a unix-socket connection without verifying the peer's user (peer credentials unavailable here)"
            ),
            _ => {}
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_user_is_admitted_under_every_policy() {
        let v = verdict(Some(1000), Some(1000));
        assert_eq!(v, PeerVerdict::SameUser);
        for p in [Policy::Enforce, Policy::WarnOnly, Policy::Require] {
            assert!(admits(v, p), "{p:?} must admit the same user");
        }
    }

    #[test]
    fn a_different_user_is_refused_except_in_warn_only_mode() {
        let v = verdict(Some(1000), Some(0));
        assert_eq!(v, PeerVerdict::Foreign(0));
        assert!(!admits(v, Policy::Enforce));
        assert!(!admits(v, Policy::Require));
        // Warn-only is the documented diagnostic mode (it logs the mismatch; the server
        // does that) — never the default.
        assert!(admits(v, Policy::WarnOnly));
    }

    #[test]
    fn an_unverifiable_peer_follows_the_policy_and_is_never_assumed_same() {
        assert_eq!(verdict(None, Some(1000)), PeerVerdict::Unverifiable);
        assert_eq!(verdict(Some(1000), None), PeerVerdict::Unverifiable);
        assert_eq!(verdict(None, None), PeerVerdict::Unverifiable);
        assert!(
            admits(PeerVerdict::Unverifiable, Policy::Enforce),
            "default admits + logs"
        );
        assert!(
            !admits(PeerVerdict::Unverifiable, Policy::Require),
            "require refuses"
        );
        assert!(admits(PeerVerdict::Unverifiable, Policy::WarnOnly));
    }

    #[test]
    fn policy_defaults_to_enforce_and_never_guesses_an_unknown_value() {
        std::env::remove_var("AMOS_UDS_PEER");
        assert_eq!(Policy::from_env(), Policy::Enforce);
        std::env::set_var("AMOS_UDS_PEER", "require");
        assert_eq!(Policy::from_env(), Policy::Require);
        std::env::set_var("AMOS_UDS_PEER", "warn");
        assert_eq!(Policy::from_env(), Policy::WarnOnly);
        std::env::set_var("AMOS_UDS_PEER", "yes-please");
        assert_eq!(
            Policy::from_env(),
            Policy::Enforce,
            "an unknown value keeps the default instead of inventing a level"
        );
        std::env::remove_var("AMOS_UDS_PEER");
    }

    /// The real thing: the kernel must report **our own** uid for a socket this process
    /// created — that is what makes the check meaningful on the host (`SO_PEERCRED` on
    /// Linux/Android, `getpeereid` on macOS/BSD).
    #[test]
    fn the_kernel_reports_our_own_uid_for_a_local_socketpair() {
        let (a, b) = std::os::unix::net::UnixStream::pair().expect("socketpair");
        let ours = our_uid().expect("a unix platform reports the effective uid");
        assert_eq!(peer_uid_fd(a.as_raw_fd()), Some(ours));
        assert_eq!(peer_uid_fd(b.as_raw_fd()), Some(ours));
        assert_eq!(
            verdict(our_uid(), peer_uid_fd(a.as_raw_fd())),
            PeerVerdict::SameUser
        );
    }

    /// A guard built from the environment admits a same-process connection.
    #[tokio::test]
    async fn the_guard_admits_a_same_process_connection() {
        use tokio::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("amos-peercred-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("s.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        let client = tokio::net::UnixStream::connect(&path)
            .await
            .expect("connect");
        let (server, _) = listener.accept().await.expect("accept");
        let guard = PeerGuard::from_env();
        assert_eq!(guard.verdict_for(&server), PeerVerdict::SameUser);
        assert!(guard.admits(&server));
        assert!(guard.admits(&client));
        drop(client);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}
