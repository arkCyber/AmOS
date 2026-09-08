//! AmOS terminal backend skeleton — a PTY-backed shell session bridge.
//!
//! DESIGN (see docs/terminal-design.md):
//!   * Real shell execution is device-only and gated behind the
//!     `terminal-pty` feature (default off). With the feature OFF this module
//!     compiles to "capability not enabled": every command returns a clear error
//!     and nothing is ever spawned — so the default build carries no execution
//!     surface.
//!   * A session is an opaque `u64` token; every read/write/kill/resize must
//!     name a live session. `allowlist: Option<Vec<String>>` is per-session: when
//!     Some, only those command binaries may run (fail-closed default).
//!
//! WIRING (bring-up, with the `terminal-pty` feature on a device):
//!   1. crates/amos-tauri/Cargo.toml
//!        [features]
//!        terminal-pty = ["dep:portable-pty"]
//!        [dependencies]
//!        portable-pty = { version = "0.8", optional = true }
//!   2. crates/amos-tauri/src/lib.rs:  #[cfg(feature = "terminal-pty")]
//!                                    pub mod terminal;
//!   3. In generate_handler![] add: term_spawn, term_write, term_read,
//!      term_kill, term_resize.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// Uniform result envelope for every terminal bridge call.
#[derive(Debug, Clone, Serialize)]
pub struct TermOut {
    /// Live session token (0 when the call failed / could not spawn).
    pub id: u64,
    /// Bytes read from the PTY (None = nothing / session ended for reads).
    pub output: Option<String>,
    /// Non-empty on failure — the reason. `id` is then 0.
    pub error: String,
    /// Whether the session is still running after this call.
    pub running: bool,
}

fn ok(id: u64, output: Option<String>, running: bool) -> TermOut {
    TermOut { id, output, error: String::new(), running }
}

fn err(e: impl Into<String>) -> TermOut {
    TermOut { id: 0, output: None, error: e.into(), running: false }
}

/// A live terminal session (fields filled when `terminal-pty` is enabled).
#[allow(dead_code)] // read only under the `terminal-pty` feature
struct Session {
    cwd: String,
    /// Per-session allowlist; None = unrestricted (still a device-only choice).
    allowlist: Option<Vec<String>>,
    // TODO(bring-up): keep the portable_pty handle + child here, e.g.
    //   pty: portable_pty::PtyPair / Box<dyn MasterPty>,
    //   child: portable_pty::ChildKiller,
    #[allow(dead_code)]
    _marker: std::marker::PhantomData<()>,
}

static REGISTRY: OnceLock<Mutex<HashMap<u64, Session>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<u64, Session>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[allow(dead_code)] // used only when spawning a real PTY under `terminal-pty`
fn next_id() -> u64 {
    static NEXT: OnceLock<Mutex<u64>> = OnceLock::new();
    let mut n = NEXT.get_or_init(|| Mutex::new(1)).lock().unwrap();
    let id = *n;
    *n += 1;
    id
}

/// Fail-closed capability gate: are we compiled with real PTY execution?
fn pty_enabled() -> bool {
    cfg!(feature = "terminal-pty")
}

/// Spawn a shell session. With `terminal-pty` OFF this never spawns and returns
/// a clear "not enabled" error (the default, safe posture).
///
/// # Arguments
/// * `cwd` — working directory the shell starts in (defaults to a safe value).
/// * `allowlist` — if `Some`, only these command binaries may run (fail closed).
pub async fn term_spawn(
    cwd: Option<String>,
    allowlist: Option<Vec<String>>,
) -> TermOut {
    if !pty_enabled() {
        return err("terminal: PTY shell is not enabled in this build (feature `terminal-pty`)");
    }
    // Policy: an allowlist is strongly recommended on a shared device.
    if allowlist.is_none() {
        return err("terminal: refusing an unrestricted shell — pass an explicit allowlist");
    }
    let dir = cwd.unwrap_or_else(|| "/".to_string());
    #[cfg(feature = "terminal-pty")]
    {
        // TODO(bring-up): portable_pty::native_pty_system(); openpty, spawn the
        // allowlisted shell with cwd=dir, then store { pty, child } under a new
        // id. Return ok(id, None, true). Any failure -> err(...) and never leak
        // the child.
        let _ = dir;
        let _ = allowlist;
        return err("terminal: PTY backend not yet wired (see docs/terminal-design.md)");
    }
    #[cfg(not(feature = "terminal-pty"))]
    {
        let _ = (dir, allowlist);
        err("terminal: PTY shell is not enabled in this build")
    }
}
/// Write bytes to a live session's stdin.
pub async fn term_write(session: u64, data: String) -> TermOut {
    let guard = registry().lock().unwrap();
    let live = guard.contains_key(&session);
    drop(guard);
    if !live {
        return err("terminal: unknown or ended session");
    }
    if !pty_enabled() {
        return err("terminal: PTY shell is not enabled in this build");
    }
    // TODO(bring-up): forward `data` into the session's PTY stdin; echo is
    // handled by the pty itself, so nothing extra is needed here.
    let _ = data;
    err("terminal: PTY backend not yet wired (see docs/terminal-design.md)")
}

/// Read available output from a live session (cap `max` bytes if given).
pub async fn term_read(session: u64, max: Option<usize>) -> TermOut {
    let guard = registry().lock().unwrap();
    let live = guard.contains_key(&session);
    drop(guard);
    if !live {
        return err("terminal: unknown or ended session");
    }
    if !pty_enabled() {
        return err("terminal: PTY shell is not enabled in this build");
    }
    let _ = max;
    // TODO(bring-up): drain the PTY master read side; trim to `max`; return
    // ok(session, Some(bytes), running). None when the child has exited.
    err("terminal: PTY backend not yet wired (see docs/terminal-design.md)")
}

/// Terminate a session and reap its child (no orphans).
pub async fn term_kill(session: u64) -> TermOut {
    let mut guard = registry().lock().unwrap();
    let removed = guard.remove(&session);
    drop(guard);
    match removed {
        None => err("terminal: unknown or ended session"),
        Some(_s) => {
            // TODO(bring-up): send SIGKILL to the pty child and reap it here.
            ok(0, None, false)
        }
    }
}

/// Resize a session's PTY window (TIOCSWINSZ).
pub async fn term_resize(session: u64, cols: u16, rows: u16) -> TermOut {
    if cols == 0 || rows == 0 {
        return err("terminal: invalid resize (cols/rows must be > 0)");
    }
    let guard = registry().lock().unwrap();
    let live = guard.contains_key(&session);
    drop(guard);
    if !live {
        return err("terminal: unknown or ended session");
    }
    if !pty_enabled() {
        return err("terminal: PTY shell is not enabled in this build");
    }
    // TODO(bring-up): call resize on the session's master pty.
    let _ = (cols, rows);
    err("terminal: PTY backend not yet wired (see docs/terminal-design.md)")
}

/// (Policy helper, pure) Whether `bin` is allowed by a per-session allowlist.
/// A None allowlist is treated as unrestricted only after an explicit opt-in at
/// spawn time; this reports the decision for the test layer.
pub fn allowed(allowlist: Option<&[String]>, bin: &str) -> bool {
    match allowlist {
        None => true,
        Some(list) => list.iter().any(|a| a == bin),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_policy_is_fail_open_only_when_unrestricted() {
        let list = ["ls".to_string(), "pwd".to_string()];
        assert!(allowed(Some(&list), "ls"));
        assert!(allowed(Some(&list), "pwd"));
        assert!(!allowed(Some(&list), "rm"));
        assert!(!allowed(Some(&list), "su"));
        // No allowlist = unrestricted (only reachable after an explicit opt-in
        // at spawn time in the real backend).
        assert!(allowed(None, "anything"));
    }

    #[tokio::test]
    async fn spawn_is_refused_when_pty_feature_is_off() {
        // Default posture: no execution surface.
        let r = term_spawn(None, Some(vec!["ls".to_string()])).await;
        assert_eq!(r.id, 0);
        assert!(!r.error.is_empty());
        assert!(r.error.contains("not enabled"));
    }

    #[tokio::test]
    async fn unknown_session_ops_fail_cleanly() {
        let r = term_kill(999_999).await;
        assert_eq!(r.id, 0);
        assert!(r.error.contains("unknown or ended session"));
    }
}

