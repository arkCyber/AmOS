//! **P3 host-half wiring**, end to end over a **real** Unix domain socket.
//!
//! This drives the actual boot path — `clipboard_guest_link::activate_from_env()`
//! (env-gated by `AMOS_GUEST_CLIPBOARD_SOCKET`) — against a real guest listener in
//! the same process, and pins the two semantics `docs/clipboard-container-sync.md`
//! calls out as must-not-drift:
//!
//! * **Audit** (§6): every cross-trust-domain push/ingest/echo is counted, and only
//!   what really happened is counted.
//! * **Foreground asymmetry** (§6): a *background* window's copy still mirrors to the
//!   guest (pushing is not front-gated), while reading the shared buffer stays
//!   foreground-only — so the guest link can never become a backdoor that drains
//!   another window's clipboard.
//!
//! The transport is a UDS, which the host has, so no device/Waydroid is involved —
//! only the namespace bridging remains device work. This file is its own process
//! (integration test), which is required: the native sink and the ingest bus are
//! `OnceLock`s installed exactly once per process.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use amos_clipboard::agent::GuestAgent;
use amos_clipboard::proto::{encode, FrameDecoder, GuestToHost, HostToGuest};
use amos_clipboard::provider::{ClipboardProvider, MockClipboardProvider};
use amos_clipboard::unix;
use amos_tauri_lib::clipboard::{self, GlobalClipboard};
use amos_tauri_lib::clipboard_guest::{parse_guest_socket, GUEST_SOCKET_ENV};
use amos_tauri_lib::clipboard_guest_link as link;
use amos_tauri_lib::wm::WmState;

/// A unique socket path under the temp dir (dependency-free).
fn unique_socket_path(tag: &str) -> std::path::PathBuf {
    use std::sync::atomic::AtomicUsize;
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "amos-clip-link-{}-{}-{}-{}.sock",
        std::process::id(),
        tag,
        n,
        nanos
    ))
}

/// The env gate is blank-insensitive: unset *and* whitespace-only stay inert, so a
/// stray/empty variable can never make the System UI dial a socket.
#[test]
fn socket_config_is_blank_insensitive() {
    assert_eq!(parse_guest_socket(None), None);
    assert_eq!(parse_guest_socket(Some("")), None);
    assert_eq!(parse_guest_socket(Some("   ")), None);
    assert_eq!(
        parse_guest_socket(Some("  /tmp/x.sock  ")),
        Some("/tmp/x.sock".into())
    );
}

/// The real thing: arm the link from the environment, then prove a **background**
/// window's copy reaches the guest, a container copy comes back, our own echo is
/// dropped, and the audit counters tell the truth.
#[test]
fn armed_link_mirrors_a_background_copy_and_ingests_the_container_reply() {
    let path = unique_socket_path("armed");
    let listener = unix::bind(&path).expect("guest binds its socket");

    // Arm the real wiring (env-gated) — the ingest loop starts dialing immediately.
    std::env::set_var(GUEST_SOCKET_ENV, path.display().to_string());
    let armed = link::activate_from_env();
    assert!(
        armed.armed,
        "must arm with a configured socket: {}",
        armed.reason
    );
    assert!(!armed.connected, "not connected until the dial lands");

    // The host ingest loop dials; accept that single connection on this thread so the
    // test owns the guest side and can inject raw frames deterministically.
    let conn = unix::accept_one(&listener).expect("guest accepts the host link");
    let (guest_read, guest_write) = unix::split(conn).expect("split guest socket");
    let guest_writer = Arc::new(Mutex::new(guest_write));

    // Guest agent: applies host pushes and reports genuine container copies back.
    let guest_clip = MockClipboardProvider::new();
    let agent = GuestAgent::new(guest_clip.clone());
    let w = Arc::clone(&guest_writer);
    agent
        .attach(move |m: GuestToHost| {
            if let Ok(frame) = encode(&m) {
                if let Ok(mut g) = w.lock() {
                    let _ = g.write_all(&frame);
                }
            }
        })
        .expect("guest change listener attaches");

    // Guest read loop: host ──► guest pushes get applied to the guest clipboard.
    let guest_stop = Arc::new(AtomicBool::new(false));
    let gs = Arc::clone(&guest_stop);
    let applier = agent;
    let guest = std::thread::spawn(move || {
        let mut r = guest_read;
        let _ = r.set_read_timeout(Some(Duration::from_millis(50)));
        let mut dec = FrameDecoder::<HostToGuest>::new();
        let mut buf = [0u8; 4096];
        loop {
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for msg in dec.push(&buf[..n]).expect("host->guest frame decodes") {
                        let _ = applier.apply(&msg);
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    if gs.load(Ordering::Relaxed) {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Host side: the shared buffer the ingest loop feeds (armed exactly once).
    let clip = Arc::new(GlobalClipboard::new());
    clipboard::arm_ingest(Arc::clone(&clip)).expect("ingest bus arms once");

    // Wait for the link to report a live connection (deterministic — `connected` is
    // published by the ingest loop itself, not guessed with a sleep).
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !link::status().connected {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        link::status().connected,
        "the ingest loop must publish a connection"
    );

    // --- Foreground asymmetry: focus the container, so `shell` is BACKGROUND ----
    let wm = WmState::new();
    wm.open_surface("shell").expect("shell surface opens");
    wm.open_surface("legacy:notes")
        .expect("container surface opens");
    assert!(
        clipboard::require_foreground(&wm, "shell").is_err(),
        "reads must stay foreground-only"
    );

    // A background window copies: it still mirrors to the guest (write is never
    // front-gated) — exactly what the `clipboard_write` command does.
    let entry = clip
        .write_plain("shell", "shell", "pushed-from-host")
        .expect("host copy");
    clipboard::mirror_to_native(&entry);

    // Our own push echoed back must be dropped by the copy-loop guard. Sent right
    // after the push so it lands inside the suppression window.
    let echo = encode(&GuestToHost::ClipboardChanged {
        ts_ms: 0,
        text: "pushed-from-host".into(),
    })
    .expect("echo encodes");
    guest_writer
        .lock()
        .expect("guest writer")
        .write_all(&echo)
        .expect("echo sent");

    // A genuine container copy.
    guest_clip
        .set_primary_text("from-container")
        .expect("container copy");

    // Wait until the guest applied the push AND the container copy reached the host.
    let wait = Instant::now() + Duration::from_secs(5);
    while Instant::now() < wait {
        if guest_clip.text().as_deref() == Some("pushed-from-host")
            && clip.latest_text().as_deref() == Some("from-container")
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        guest_clip.text().as_deref(),
        Some("pushed-from-host"),
        "a background window's copy must reach the guest clipboard"
    );
    assert_eq!(
        clip.latest_text().as_deref(),
        Some("from-container"),
        "the container copy must land in the host shared clipboard"
    );

    // --- Audit tells the truth -------------------------------------------------
    let st = link::status();
    assert!(st.armed && st.connected);
    assert_eq!(st.stats.pushes, 1, "exactly one push reached the wire");
    assert_eq!(st.stats.push_failures, 0);
    assert_eq!(
        st.stats.ingests, 1,
        "exactly one container copy was ingested"
    );
    assert_eq!(
        st.stats.echoes_dropped, 1,
        "our own echo was dropped, not re-ingested"
    );
    assert!(st.stats.dials >= 1, "the ingest loop dialed");
    // The echo never grew the buffer: the host's own copy + the container's copy.
    assert_eq!(clip.history(None).len(), 2);

    // Orderly shutdown: closing the host socket ends the guest read loop.
    link::stop();
    guest_stop.store(true, Ordering::Relaxed);
    guest.join().expect("guest thread ends");
    let _ = std::fs::remove_file(&path);
}
