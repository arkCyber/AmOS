//! Host-half **wiring** for the guest-container clipboard link (P2b + P3).
//!
//! [`crate::clipboard_guest`] owns the protocol/transport seam;
//! [`amos_clipboard::unix`] owns the real Unix-domain-socket transport. This module
//! composes them into the running System UI: an audited mirror sink
//! ([`ClipboardNative`]) over a **shared duplex connection**, plus a background
//! ingest loop that owns reconnection through [`amos_clipboard::link::supervise`]
//! (the sink follows that single connection via `SharedWriter`).
//!
//! **Inert by default.** Nothing here dials anything unless the operator names a
//! socket via `AMOS_GUEST_CLIPBOARD_SOCKET`; `lib.rs::setup` calls
//! [`activate_from_env`], a no-op on desktop/CI — the "honest no-op until attached"
//! convention the rest of the crate follows.
//!
//! **Cross-trust-domain push is explicit and audited** (`docs/clipboard-container-sync.md`
//! §6): a push lands plaintext in the guest `ClipboardManager` where any container app
//! can read it. Every push, refusal, failure, ingest and suppressed echo is counted in
//! [`crate::clipboard_guest::GuestLinkStatsView`] and visible via
//! `clipboard_guest_status` — never a silent backdoor. Note the *asymmetry* that must
//! not be "fixed" by accident: pushing happens on **write** (any window may copy, as
//! before), while reading the shared buffer stays **foreground-only**
//! ([`crate::clipboard::require_foreground`]); a background app can therefore never
//! use the guest link to drain another window's clipboard.
//!
//! The transport is a Unix domain socket, so the wiring is `#[cfg(unix)]`; on other
//! platforms [`status`] honestly reports "not armed" with the reason.

use serde::Serialize;

use crate::clipboard_guest::GuestLinkStatsView;

/// Status of the host↔guest clipboard link — what `clipboard_guest_status` returns.
#[derive(Clone, Debug, Serialize)]
pub struct GuestLinkStatus {
    /// True only when a socket was configured *and* the sink + ingest loop are live.
    pub armed: bool,
    /// True while the shared duplex connection to the guest is established. A push
    /// attempted while disconnected fails honestly (`NotConnected`) rather than
    /// dialing a second socket — the ingest loop is the single reconnect authority.
    pub connected: bool,
    /// The configured socket path, when armed.
    pub socket: Option<String>,
    /// Why the link is not armed (`""` when it is) — an honest reason, never a
    /// fabricated success.
    pub reason: String,
    /// Auditable counters (all zero when not armed).
    pub stats: GuestLinkStatsView,
}

impl GuestLinkStatus {
    fn disarmed(reason: impl Into<String>) -> Self {
        Self {
            armed: false,
            connected: false,
            socket: None,
            reason: reason.into(),
            stats: GuestLinkStatsView::default(),
        }
    }
}

/// Tauri command: report the guest clipboard link's status + audit counters.
/// Always registered; on a non-Unix build (or with no socket configured) it returns
/// an honest disarmed status.
#[tauri::command]
pub fn clipboard_guest_status() -> GuestLinkStatus {
    status()
}

/// Current status (pure read; never dials).
pub fn status() -> GuestLinkStatus {
    #[cfg(unix)]
    {
        imp::status()
    }
    #[cfg(not(unix))]
    {
        GuestLinkStatus::disarmed("guest clipboard transport is unix-only")
    }
}

/// Env-gated boot wiring. Returns the resulting [`GuestLinkStatus`]:
/// * `AMOS_GUEST_CLIPBOARD_SOCKET` unset/blank → disarmed, nothing dialed;
/// * configured → dials, installs the mirror sink (exactly once per process) and
///   starts the ingest loop, or reports the honest failure reason.
pub fn activate_from_env() -> GuestLinkStatus {
    #[cfg(unix)]
    {
        imp::activate_from_env()
    }
    #[cfg(not(unix))]
    {
        GuestLinkStatus::disarmed("guest clipboard transport is unix-only")
    }
}

/// Ask the running ingest loop to stop and join it (tests / orderly shutdown).
/// No-op when not armed.
pub fn stop() {
    #[cfg(unix)]
    imp::stop();
}

#[cfg(unix)]
mod imp {
    use std::cell::RefCell;
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::thread::JoinHandle;

    use amos_clipboard::proto::{EchoGuard, FrameDecoder, GuestToHost};
    use amos_clipboard::{link, unix};

    use super::GuestLinkStatus;
    use crate::clipboard::{self, ClipboardEntry, ClipboardNative};
    use crate::clipboard_guest::{
        guest_socket_from_env, handle_guest_msg, GuestLinkStats, GuestSink, GUEST_SOCKET_ENV,
    };

    /// The **single** duplex connection, shared by both directions.
    ///
    /// Host↔guest is one session = one socket: the ingest loop owns connection
    /// establishment (it holds the reconnect policy) and publishes the *writer* half
    /// here, so the mirror sink targets the same socket. Two independent dials would
    /// strand one direction — the guest can only serve the connection it accepted.
    #[derive(Clone, Default)]
    struct SharedConn(Arc<Mutex<Option<UnixStream>>>);

    impl SharedConn {
        /// Publish a freshly connected writer half (called by the ingest loop).
        fn publish(&self, writer: UnixStream) {
            if let Ok(mut g) = self.0.lock() {
                *g = Some(writer);
            }
        }
        /// Drop the writer half (the connection ended / is being replaced).
        fn clear(&self) {
            if let Ok(mut g) = self.0.lock() {
                *g = None;
            }
        }
        /// Is a connection currently published?
        fn is_connected(&self) -> bool {
            self.0.lock().map(|g| g.is_some()).unwrap_or(false)
        }
        /// Run `f` against the current writer half (a poisoned lock ⇒ treat as absent).
        fn with<T>(&self, f: impl FnOnce(Option<&mut UnixStream>) -> T) -> T {
            match self.0.lock() {
                Ok(mut g) => f(g.as_mut()),
                Err(_) => f(None),
            }
        }
    }

    /// A [`std::io::Write`] that always targets the **current** guest connection.
    ///
    /// Reconnection belongs to the ingest loop (a single authority); this follows it,
    /// so a copy attempted while disconnected fails honestly with `NotConnected`
    /// (audited as a push failure) instead of opening a second socket.
    struct SharedWriter {
        conn: SharedConn,
    }

    impl std::io::Write for SharedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.conn.with(|w| match w {
                Some(w) => w.write(buf),
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "guest clipboard link is not connected",
                )),
            })
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.conn.with(|w| match w {
                Some(w) => w.flush(),
                None => Ok(()),
            })
        }
    }

    /// The mirror sink: `GuestSink` over the shared connection, with audit.
    type MirrorSink = AuditedGuestSink<SharedWriter>;

    /// Process-wide armed link (set at most once, by [`activate_from_env`]).
    static LINK: OnceLock<Arc<GuestLink>> = OnceLock::new();
    /// Whether `activate_from_env` already ran (repeated calls are idempotent).
    static ACTIVATED: OnceLock<Option<Arc<GuestLink>>> = OnceLock::new();

    /// A [`ClipboardNative`] that mirrors to the guest **and audits every outcome**.
    ///
    /// Counting lives here (not in the transport) so `amos-clipboard` stays free of
    /// host-policy concerns; the classification reuses [`GuestSink`]'s decision, so
    /// the audit can never drift from what was actually sent.
    pub(super) struct AuditedGuestSink<W> {
        inner: GuestSink<W>,
        stats: Arc<GuestLinkStats>,
    }

    impl<W: std::io::Write + Send> ClipboardNative for AuditedGuestSink<W> {
        fn name(&self) -> &'static str {
            "waydroid-guest"
        }

        fn push_out(&self, entry: &ClipboardEntry) -> Result<(), String> {
            match self.inner.push_out(entry) {
                Ok(()) => {
                    self.stats.record_push();
                    Ok(())
                }
                Err(e) => {
                    // Distinguish "refused before the wire" (an image-only payload
                    // cannot map to a text container clipboard) from a transport
                    // failure — they mean very different things to an operator.
                    if entry.plain_text().is_none() {
                        self.stats.record_push_refused_unmappable();
                    } else {
                        self.stats.record_push_failure();
                    }
                    Err(e)
                }
            }
        }
    }

    /// Build the audited mirror sink over the shared connection.
    fn build_sink(
        conn: SharedConn,
        guard: Arc<Mutex<EchoGuard>>,
        stats: Arc<GuestLinkStats>,
    ) -> Arc<MirrorSink> {
        Arc::new(AuditedGuestSink {
            inner: GuestSink::over(SharedWriter { conn }, guard),
            stats,
        })
    }

    /// A live host-side guest link: audited mirror sink + ingest loop + counters.
    pub struct GuestLink {
        socket: PathBuf,
        stats: Arc<GuestLinkStats>,
        sink: Arc<MirrorSink>,
        conn: SharedConn,
        stop: Arc<AtomicBool>,
        thread: Mutex<Option<JoinHandle<()>>>,
    }

    impl GuestLink {
        /// Build the sink and start the ingest loop. Does **not** install the
        /// process-global native transport — call [`Self::install`] for that.
        pub fn start(socket: PathBuf) -> Result<Self, String> {
            let stats = Arc::new(GuestLinkStats::default());
            let guard = Arc::new(Mutex::new(EchoGuard::new()));
            let conn = SharedConn::default();
            let sink = build_sink(conn.clone(), Arc::clone(&guard), Arc::clone(&stats));
            let stop = Arc::new(AtomicBool::new(false));
            let thread = spawn_ingest(
                socket.clone(),
                conn.clone(),
                guard,
                Arc::clone(&stats),
                Arc::clone(&stop),
            )?;
            Ok(Self {
                socket,
                stats,
                sink,
                conn,
                stop,
                thread: Mutex::new(Some(thread)),
            })
        }

        /// The guest socket this link talks to.
        pub fn socket(&self) -> &Path {
            &self.socket
        }

        /// Is the shared duplex connection currently established?
        pub fn connected(&self) -> bool {
            self.conn.is_connected()
        }

        /// Install the mirror sink as the process-global native clipboard transport
        /// (exactly once). A second install is an honest error, not a silent swap.
        pub fn install(&self) -> Result<(), String> {
            clipboard::set_native_sink(self.sink.clone())
        }

        /// Status snapshot for the UI.
        pub fn status(&self) -> GuestLinkStatus {
            GuestLinkStatus {
                armed: true,
                connected: self.connected(),
                socket: Some(self.socket.display().to_string()),
                reason: String::new(),
                stats: self.stats.snapshot(),
            }
        }

        /// Ask the ingest loop to stop and join it. The `stop` predicate is polled at
        /// the top of each supervisor iteration, so this returns within one backoff.
        pub fn stop(&self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Ok(mut t) = self.thread.lock() {
                if let Some(h) = t.take() {
                    let _ = h.join();
                }
            }
        }
    }

    /// Start the guest→host ingest loop on its own thread.
    fn spawn_ingest(
        socket: PathBuf,
        conn: SharedConn,
        guard: Arc<Mutex<EchoGuard>>,
        stats: Arc<GuestLinkStats>,
        stop: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>, String> {
        std::thread::Builder::new()
            .name("amos-clipboard-guest".to_string())
            .spawn(move || ingest_loop(&socket, &conn, &guard, &stats, &stop))
            .map_err(|e| format!("failed to spawn the clipboard guest ingest loop: {e}"))
    }

    /// The reconnect-and-decode loop. `supervise` owns the backoff/reconnect policy;
    /// the decoder is rebuilt on **every** connection so a partial frame can never
    /// survive a reconnect, and the audit counts every decoded outcome.
    ///
    /// This loop is the **single connection authority**: each (re)connect dials once,
    /// splits the socket, publishes the writer half for the mirror sink, and reads the
    /// reader half. On connection end the published writer is cleared so a copy made
    /// while disconnected fails honestly instead of writing to a dead socket.
    fn ingest_loop(
        socket: &Path,
        conn: &SharedConn,
        guard: &Arc<Mutex<EchoGuard>>,
        stats: &Arc<GuestLinkStats>,
        stop: &Arc<AtomicBool>,
    ) {
        let decoder = RefCell::new(FrameDecoder::<GuestToHost>::new());
        let path = socket.to_path_buf();
        let dial_stats = Arc::clone(stats);
        let dial_conn = conn.clone();
        let mut connect = move || -> Result<UnixStream, String> {
            dial_stats.record_dial();
            // A fresh session: drop any stale writer before publishing the new one.
            dial_conn.clear();
            let stream = match unix::dial(&path) {
                Ok(s) => s,
                Err(e) => {
                    dial_stats.record_dial_failure();
                    return Err(format!("clipboard guest dial: {e}"));
                }
            };
            match unix::split(stream) {
                Ok((reader, writer)) => {
                    // A read timeout lets `supervise` observe the stop flag on an
                    // **idle** link (a silent guest would otherwise block the read
                    // forever and make `link::stop()` hang on join).
                    let _ = reader.set_read_timeout(Some(std::time::Duration::from_millis(200)));
                    dial_conn.publish(writer);
                    Ok(reader)
                }
                Err(e) => {
                    dial_stats.record_dial_failure();
                    Err(format!("clipboard guest split: {e}"))
                }
            }
        };
        let mut on_connected = || {
            *decoder.borrow_mut() = FrameDecoder::new();
        };
        let mut consume = |bytes: &[u8]| -> Result<(), String> {
            let msgs = decoder.borrow_mut().push(bytes)?;
            if msgs.is_empty() {
                return Ok(());
            }
            let g = guard.lock().map_err(|e| e.to_string())?;
            for msg in msgs {
                let outcome = handle_guest_msg(&g, msg, &mut |src, text| {
                    clipboard::ingest_native_text(src, text)
                });
                stats.record_guest_msg(outcome);
            }
            Ok(())
        };
        let mut sleep = |d| unix::thread_sleep(d);
        let report_conn = conn.clone();
        let mut report = |m: &str| {
            // The connection ended: stop the sink from writing into a dead socket.
            report_conn.clear();
            tracing::debug!("clipboard guest link: {m}");
        };
        let stop_flag = Arc::clone(stop);
        let outcome = link::supervise(
            unix::default_backoff(),
            &mut connect,
            &mut on_connected,
            &mut consume,
            &mut sleep,
            &mut report,
            &|| stop_flag.load(Ordering::Relaxed),
        );
        conn.clear();
        match outcome {
            Ok(()) => tracing::info!("clipboard guest link stopped"),
            Err(e) => tracing::warn!("clipboard guest link ended: {e}"),
        }
    }

    /// Honest status: the armed link's counters, or **why** nothing is armed.
    pub(super) fn status() -> GuestLinkStatus {
        if let Some(link) = LINK.get() {
            return link.status();
        }
        match guest_socket_from_env() {
            Some(p) => GuestLinkStatus::disarmed(format!(
                "{GUEST_SOCKET_ENV} names {} but the link is not armed (not started, or start failed)",
                p.display()
            )),
            None => GuestLinkStatus::disarmed(format!("{GUEST_SOCKET_ENV} is not set")),
        }
    }

    /// Env-gated, idempotent boot wiring.
    pub(super) fn activate_from_env() -> GuestLinkStatus {
        let activated = ACTIVATED.get_or_init(|| {
            let socket = guest_socket_from_env()?; // unset ⇒ inert, no dial
            let link = match GuestLink::start(socket) {
                Ok(l) => Arc::new(l),
                Err(e) => {
                    tracing::warn!("clipboard guest link not started: {e}");
                    return None;
                }
            };
            match link.install() {
                Ok(()) => {
                    tracing::info!("clipboard guest link armed on {}", link.socket().display())
                }
                // The ingest loop is still useful without the mirror sink; keep it and
                // say so honestly rather than pretending the sink is installed.
                Err(e) => tracing::warn!("clipboard guest mirror sink not installed: {e}"),
            }
            let _ = LINK.set(Arc::clone(&link));
            Some(link)
        });
        match activated {
            Some(l) => l.status(),
            None => status(),
        }
    }

    /// Stop the armed link, if any.
    pub(super) fn stop() {
        if let Some(link) = LINK.get() {
            link.stop();
        }
    }
}
