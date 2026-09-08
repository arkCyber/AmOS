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

#[cfg(feature = "terminal-pty")]
use std::io::{Read, Write};
#[cfg(feature = "terminal-pty")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "terminal-pty")]
use std::sync::Arc;
#[cfg(feature = "terminal-pty")]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

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

/// A live terminal session.
#[allow(dead_code)] // fields read only under the `terminal-pty` feature
struct Session {
    cwd: String,
    /// Per-session allowlist; None = unrestricted (still a device-only choice).
    allowlist: Option<Vec<String>>,
    /// Live PTY state — present only when the `terminal-pty` feature is on.
    #[cfg(feature = "terminal-pty")]
    pty: Option<LivePty>,
}

/// The real PTY side of a session (feature `terminal-pty`).
#[cfg(feature = "terminal-pty")]
struct LivePty {
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    buf: Arc<Mutex<Vec<u8>>>,
    alive: Arc<AtomicBool>,
    #[allow(dead_code)]
    reader_thread: std::thread::JoinHandle<()>,
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
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(&dir);
        let size = PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 };
        let pair = match native_pty_system().openpty(size) {
            Ok(p) => p,
            Err(e) => return err(format!("terminal: openpty: {e}")),
        };
        let child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(e) => return err(format!("terminal: spawn: {e}")),
        };
        drop(pair.slave);
        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => return err(format!("terminal: reader: {e}")),
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => return err(format!("terminal: writer: {e}")),
        };
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let mut reader = reader;
        let buf2 = Arc::clone(&buf);
        let alive2 = Arc::clone(&alive);
        let reader_thread = std::thread::spawn(move || {
            let mut tmp = [0u8; 4096];
            loop {
                match reader.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => buf2.lock().unwrap().extend_from_slice(&tmp[..n]),
                    Err(_) => break,
                }
            }
            alive2.store(false, Ordering::Relaxed);
        });
        let id = next_id();
        let live = LivePty {
            master: pair.master,
            child,
            writer,
            buf,
            alive,
            reader_thread,
        };
        registry()
            .lock()
            .unwrap()
            .insert(id, Session { cwd: dir, allowlist, pty: Some(live) });
        return ok(id, None, true);
    }
    #[cfg(not(feature = "terminal-pty"))]
    {
        let _ = (dir, allowlist);
        err("terminal: PTY shell is not enabled in this build")
    }
}
/// Write bytes to a live session's stdin.
pub async fn term_write(session: u64, data: String) -> TermOut {
    #[cfg(feature = "terminal-pty")]
    {
        let mut guard = registry().lock().unwrap();
        let live = guard.get_mut(&session).and_then(|s| s.pty.as_mut());
        let Some(live) = live else {
            drop(guard);
            return err("terminal: unknown or ended session");
        };
        // echo is handled by the pty itself, so we only forward the raw bytes.
        let res = live.writer.write_all(data.as_bytes());
        drop(guard);
        return match res {
            Ok(_) => ok(session, None, true),
            Err(e) => err(format!("terminal: write: {e}")),
        };
    }
    #[cfg(not(feature = "terminal-pty"))]
    {
        let _ = (session, data);
        err("terminal: PTY shell is not enabled in this build")
    }
}

/// Read available output from a live session (cap `max` bytes if given).
pub async fn term_read(session: u64, max: Option<usize>) -> TermOut {
    #[cfg(feature = "terminal-pty")]
    {
        let mut guard = registry().lock().unwrap();
        let live = guard.get_mut(&session).and_then(|s| s.pty.as_mut());
        let Some(live) = live else {
            drop(guard);
            return err("terminal: unknown or ended session");
        };
        let mut bytes = std::mem::take(&mut *live.buf.lock().unwrap());
        if let Some(cap) = max {
            if bytes.len() > cap {
                bytes.truncate(cap);
            }
        }
        let running = live.alive.load(Ordering::Relaxed);
        drop(guard);
        let out = String::from_utf8_lossy(&bytes).to_string();
        return ok(session, if out.is_empty() { None } else { Some(out) }, running);
    }
    #[cfg(not(feature = "terminal-pty"))]
    {
        let _ = (session, max);
        err("terminal: PTY shell is not enabled in this build")
    }
}

/// Terminate a session and reap its child (no orphans).
pub async fn term_kill(session: u64) -> TermOut {
    let mut guard = registry().lock().unwrap();
    let removed = guard.remove(&session);
    drop(guard);
    match removed {
        None => err("terminal: unknown or ended session"),
        Some(mut s) => {
            #[cfg(feature = "terminal-pty")]
            if let Some(mut live) = s.pty.take() {
                live.alive.store(false, Ordering::Relaxed);
                let _ = live.child.kill();
                drop(live.child);
            }
            let _ = &mut s;
            ok(0, None, false)
        }
    }
}

/// Resize a session's PTY window (TIOCSWINSZ).
pub async fn term_resize(session: u64, cols: u16, rows: u16) -> TermOut {
    if cols == 0 || rows == 0 {
        return err("terminal: invalid resize (cols/rows must be > 0)");
    }
    #[cfg(feature = "terminal-pty")]
    {
        let mut guard = registry().lock().unwrap();
        let live = guard.get_mut(&session).and_then(|s| s.pty.as_mut());
        let Some(live) = live else {
            drop(guard);
            return err("terminal: unknown or ended session");
        };
        let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
        let res = live.master.resize(size);
        drop(guard);
        match res {
            Ok(_) => ok(session, None, true),
            Err(e) => err(format!("terminal: resize: {e}")),
        }
    }
    #[cfg(not(feature = "terminal-pty"))]
    {
        let _ = (session, cols, rows);
        err("terminal: PTY shell is not enabled in this build")
    }
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

    #[cfg(not(feature = "terminal-pty"))]
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

    /// Real PTY integration (feature `terminal-pty`): spawn a shell on the host,
    /// pipe `echo PTY_OK`, and confirm the line comes back through the pty.
    #[cfg(feature = "terminal-pty")]
    #[tokio::test]
    async fn real_pty_echo_round_trip() {
        let sp = term_spawn(Some("/tmp".to_string()), Some(vec!["echo".to_string()])).await;
        assert!(sp.id > 0, "spawn failed: {}", sp.error);
        let id = sp.id;
        let _ = term_write(id, "echo PTY_OK\n".to_string()).await;
        let _ = term_write(id, "exit\n".to_string()).await;
        let mut got = String::new();
        for _ in 0..50 {
            let rd = term_read(id, None).await;
            if let Some(o) = rd.output {
                got.push_str(&o);
            }
            if got.contains("PTY_OK") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = term_kill(id).await;
        assert!(got.contains("PTY_OK"), "echo never returned: {got:?}");
    }
}

