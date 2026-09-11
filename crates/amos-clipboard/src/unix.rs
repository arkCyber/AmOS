//! Real host↔guest byte channel over a **Unix domain socket** (P2b, see
//! `docs/clipboard-container-sync.md` §5/§7).
//!
//! [`crate::link::supervise`] owns the transport-independent reconnect/lifecycle
//! discipline; this module supplies the transport it was designed to sit on — the
//! piece that was previously *only* a doc comment ("on-device you supply a real
//! `connect`"). Unix sockets exist on the host too, so everything here is exercised
//! over **real** sockets in tests (a tempdir path), and only the Waydroid
//! *namespace bridging* (host and guest do not share the default UNIX namespace)
//! remains device work.
//!
//! * [`bind`] / [`dial`] — the guest listens on a socket path, the host dials it.
//! * [`split`] — a connection is full-duplex, so `try_clone` yields an independent
//!   reader and writer over the same socket; the ingest loop and the mirror sink
//!   each own one.
//! * [`accept_one`] / [`serve`] — the guest accept side.
//! * [`drain`] — the read half of a session in the same bounded shape as
//!   [`crate::link::supervise`].
//! * [`ReconnectingSink`] — a [`Write`] that lazily re-dials when the peer goes
//!   away, so a host `GuestSink` survives a guest restart (bounded by
//!   [`Backoff`]; it never sleeps, because it runs on the UI copy path).
//!
//! **Reconnect model (be explicit about it).** A session is one duplex socket: both
//! directions of that session ride the same connection, so when it breaks both
//! sides observe it and re-establish. [`serve`] therefore runs **one session at a
//! time** — the honest shape for "one host, one guest": a second connection is only
//! accepted once the previous session has ended. Callers who deliberately want
//! overlapping connections should drive [`accept_one`] in their own loop rather than
//! use [`serve`].

use std::io::{self, Read, Write};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use crate::link::Backoff;

/// Dial a host/guest socket path (the **client** side).
pub fn dial(path: &Path) -> io::Result<UnixStream> {
    UnixStream::connect(path)
}

/// Bind a listening socket at `path` (the **server** side).
///
/// A **stale** socket file left behind by a crashed peer is removed first (a
/// crashed listener does not unlink its path). A path that exists and is *not* a
/// socket is refused — this must never silently delete a real file.
pub fn bind(path: &Path) -> io::Result<UnixListener> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            if !meta.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("refusing to replace non-socket path {}", path.display()),
                ));
            }
            std::fs::remove_file(path)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    UnixListener::bind(path)
}

/// Split a full-duplex connection into an independent reader and writer (two
/// handles onto the same socket), so the ingest loop and the mirror sink can each
/// own one without sharing a lock.
pub fn split(stream: UnixStream) -> io::Result<(UnixStream, UnixStream)> {
    let writer = stream.try_clone()?;
    Ok((stream, writer))
}

/// Accept exactly one connection (blocking). Use this to build a custom accept
/// policy; [`serve`] is the built-in one.
pub fn accept_one(listener: &UnixListener) -> io::Result<UnixStream> {
    let (conn, _addr) = listener.accept()?;
    Ok(conn)
}

/// Accept-loop: run `session` for every connection, **one at a time** (see the
/// module note on the reconnect model). A session returning `Err` ends that
/// connection only — the loop keeps listening, so the guest stays up and the host
/// can reconnect. A fatal `accept` error ends the loop with `Err`.
pub fn serve<F>(listener: &UnixListener, mut session: F) -> io::Result<()>
where
    F: FnMut(UnixStream) -> io::Result<()>,
{
    for conn in listener.incoming() {
        let conn = conn?;
        let _ = session(conn); // a broken session must not kill the listener
    }
    Ok(())
}

/// Read until EOF/error, handing each chunk to `consume` — the read half of a
/// session, with the same "bounded loop, no hidden allocation" shape as
/// [`crate::link::supervise`]. Returns `Ok(bytes)` on a clean EOF.
pub fn drain<R: Read>(
    reader: &mut R,
    consume: &mut dyn FnMut(&[u8]) -> Result<(), String>,
) -> Result<u64, String> {
    let mut chunk = [0u8; 4096];
    let mut total: u64 = 0;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return Ok(total), // clean EOF: peer closed
            Ok(n) => {
                total += n as u64;
                consume(&chunk[..n])?;
            }
            Err(e) => return Err(format!("read error: {e}")),
        }
    }
}

/// Whether `e` means "the peer/socket is gone" and a re-dial is warranted.
fn is_disconnect(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::NotConnected
            | io::ErrorKind::UnexpectedEof
    )
}

/// A [`Write`] over a **(re)dialable** connection.
///
/// Use this when the writer **owns its own connection** (a one-way producer/mirror
/// that dials for itself). When both directions must ride **one** socket — as in the
/// coordinated host↔guest link — the reconnect has to be shared, so the read loop is
/// the single authority and the sink follows it instead (see
/// `clipboard_guest_link::SharedWriter` in `amos-tauri`); reconnecting separately here
/// would open a second connection the peer never serves.
///
/// It reuses the connection while healthy; on a disconnect it drops it and re-dials
/// **inline, at most once per write** — so a guest restart does not permanently
/// break the host mirror sink (the next copy re-establishes the link). Re-dials are
/// bounded by a [`Backoff`] budget: once `max_retries` consecutive dials have
/// failed, `write` returns an error **without** dialing again (a permanently absent
/// peer stops being retried), and the first successful dial restores the budget.
///
/// It never sleeps: this is the UI copy path, and blocking it on a reconnect would
/// freeze a paste. Reconnection is therefore lazy (attempted at the next write).
pub struct ReconnectingSink<C> {
    dial: C,
    conn: Option<UnixStream>,
    backoff: Backoff,
    connects: u64,
}

impl<C: FnMut() -> io::Result<UnixStream>> ReconnectingSink<C> {
    /// Wrap a dialer (typically `|| unix::dial(&path)`) with a retry budget.
    pub fn new(dial: C, backoff: Backoff) -> Self {
        Self {
            dial,
            conn: None,
            backoff,
            connects: 0,
        }
    }

    /// How many successful (re)connects have happened (diagnostics / assertions).
    pub fn connects(&self) -> u64 {
        self.connects
    }

    /// Is a live connection currently held?
    pub fn is_connected(&self) -> bool {
        self.conn.is_some()
    }

    /// Ensure a connection exists, dialing if needed.
    fn ensure(&mut self) -> io::Result<()> {
        if self.conn.is_some() {
            return Ok(());
        }
        if self.backoff.failures() >= self.backoff.max_retries() {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "clipboard-guest link gave up reconnecting",
            ));
        }
        match (self.dial)() {
            Ok(stream) => {
                self.backoff.reset();
                self.conn = Some(stream);
                self.connects += 1;
                Ok(())
            }
            Err(e) => {
                // Count this failed attempt against the budget (and stop once it is
                // exhausted) so a permanently-absent peer is not dialed forever.
                let _ = self.backoff.retry_delay();
                Err(e)
            }
        }
    }
}

impl<C: FnMut() -> io::Result<UnixStream>> Write for ReconnectingSink<C> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.ensure()?;
        let first = match self.conn.as_mut() {
            Some(c) => c.write(buf),
            None => return Err(io::Error::new(io::ErrorKind::NotConnected, "no connection")),
        };
        match first {
            Ok(n) => {
                self.backoff.reset();
                Ok(n)
            }
            Err(e) if is_disconnect(&e) => {
                // The peer went away: drop the dead handle, re-dial once, retry.
                self.conn = None;
                self.ensure()?;
                match self.conn.as_mut() {
                    Some(c) => c.write(buf),
                    None => Err(e),
                }
            }
            Err(e) => Err(e),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.conn.as_mut() {
            Some(c) => c.flush(),
            None => Ok(()),
        }
    }
}

/// Default reconnect schedule for a host mirror sink: start at 50 ms, cap at 2 s,
/// give up after 5 consecutive failed dials.
pub fn default_backoff() -> Backoff {
    Backoff::new(50, 2_000, 5)
}

/// The sleep a production [`crate::link::supervise`] caller passes for `sleep`
/// (tests inject a recorder instead).
pub fn thread_sleep(d: Duration) {
    std::thread::sleep(d);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A unique socket path under the system temp dir (no `tempfile` dependency).
    fn temp_socket_path(tag: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "amos-clip-{}-{}-{}-{}.sock",
            std::process::id(),
            tag,
            n,
            nanos
        ))
    }

    #[test]
    fn bind_then_dial_round_trips_bytes() {
        let path = temp_socket_path("rt");
        let listener = bind(&path).expect("bind");

        let server = std::thread::spawn(move || {
            let mut conn = accept_one(&listener).expect("accept");
            let mut got = Vec::new();
            let mut buf = [0u8; 64];
            let n = conn.read(&mut buf).expect("read");
            got.extend_from_slice(&buf[..n]);
            conn.write_all(b"pong").expect("write back");
            got
        });

        let mut client = dial(&path).expect("dial");
        client.write_all(b"ping").expect("write");
        let mut back = [0u8; 4];
        client.read_exact(&mut back).expect("read back");
        assert_eq!(&back, b"pong");
        assert_eq!(server.join().expect("join"), b"ping");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn split_gives_two_handles_over_one_socket() {
        let (a, mut b) = UnixStream::pair().expect("pair");
        let (mut a_read, mut a_write) = split(a).expect("split");

        a_write.write_all(b"one").expect("write via writer half");
        let mut got = [0u8; 3];
        b.read_exact(&mut got).expect("peer reads writer half");
        assert_eq!(&got, b"one");

        b.write_all(b"two").expect("peer writes");
        let mut back = [0u8; 3];
        a_read.read_exact(&mut back).expect("read via reader half");
        assert_eq!(&back, b"two");
    }

    #[test]
    fn bind_replaces_a_stale_socket_but_refuses_a_regular_file() {
        let path = temp_socket_path("stale");
        // Leave a socket file behind (a crashed listener does not unlink it).
        drop(bind(&path).expect("first bind"));
        assert!(path.exists(), "the socket path survives a dropped listener");
        bind(&path).expect("re-bind over the stale socket must succeed");
        let _ = std::fs::remove_file(&path);

        let file = temp_socket_path("realfile");
        std::fs::write(&file, b"not a socket").expect("write file");
        let err = bind(&file).expect_err("must refuse a non-socket path");
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(file.exists(), "the real file must be untouched");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn reconnecting_sink_redials_after_the_peer_drops() {
        let path = temp_socket_path("redial");
        let listener = bind(&path).expect("bind");
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();

        // Accept, read the first payload, then drop the connection (a guest
        // restart). Accept again on the *same* listener and read the second.
        let server = std::thread::spawn(move || {
            let mut buf = [0u8; 32];
            let mut first = accept_one(&listener).expect("accept #1");
            let n = first.read(&mut buf).expect("read #1");
            tx.send(buf[..n].to_vec()).expect("send #1");
            drop(first); // peer goes away -> the sink's next write must re-dial

            let mut second = accept_one(&listener).expect("accept #2");
            let n = second.read(&mut buf).expect("read #2");
            tx.send(buf[..n].to_vec()).expect("send #2");
        });

        let mut sink = ReconnectingSink::new(|| dial(&path), default_backoff());
        sink.write_all(b"before").expect("first write dials");
        assert_eq!(sink.connects(), 1);
        assert_eq!(rx.recv().expect("first payload"), b"before");

        // Let the server actually drop the first connection so the retry sees a real
        // disconnect rather than a still-open socket.
        std::thread::sleep(Duration::from_millis(50));
        sink.write_all(b"after").expect("second write re-dials");
        assert_eq!(sink.connects(), 2, "the sink re-dialed exactly once");
        assert_eq!(rx.recv().expect("second payload"), b"after");

        server.join().expect("join");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reconnecting_sink_gives_up_after_the_retry_budget() {
        let missing = temp_socket_path("absent");
        let dialed = std::sync::Arc::new(AtomicUsize::new(0));
        let counted = dialed.clone();
        let mut sink = ReconnectingSink::new(
            move || {
                counted.fetch_add(1, Ordering::Relaxed);
                dial(&missing)
            },
            Backoff::new(1, 1, 3),
        );

        // Three attempts are allowed; the fourth must short-circuit without dialing.
        for i in 0..3 {
            assert!(sink.write_all(b"x").is_err(), "attempt {i} fails");
        }
        assert_eq!(dialed.load(Ordering::Relaxed), 3, "the budget was used up");
        let err = sink.write_all(b"x").expect_err("budget exhausted");
        assert_eq!(err.kind(), io::ErrorKind::NotConnected);
        assert_eq!(
            dialed.load(Ordering::Relaxed),
            3,
            "an exhausted budget must not dial again"
        );
    }

    #[test]
    fn serve_runs_one_session_then_keeps_listening() {
        let path = temp_socket_path("serve");
        let listener = bind(&path).expect("bind");
        let sessions = std::sync::Arc::new(AtomicUsize::new(0));

        let seen = sessions.clone();
        std::thread::spawn(move || {
            let _ = serve(&listener, move |mut conn| {
                seen.fetch_add(1, Ordering::Relaxed);
                let mut buf = [0u8; 8];
                let _ = conn.read(&mut buf);
                Ok(())
            });
        });

        for payload in [b"a".as_slice(), b"b".as_slice()] {
            let mut c = loop {
                match dial(&path) {
                    Ok(c) => break c,
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            };
            c.write_all(payload).expect("write");
            drop(c); // session ends -> the listener accepts the next one
            std::thread::sleep(Duration::from_millis(30));
        }
        assert_eq!(
            sessions.load(Ordering::Relaxed),
            2,
            "serve handled both sessions one after another"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drain_feeds_every_chunk_and_reports_clean_eof() {
        let mut reader = std::io::Cursor::new(b"hello world".to_vec());
        let mut got = Vec::new();
        let total = drain(&mut reader, &mut |chunk| {
            got.extend_from_slice(chunk);
            Ok(())
        })
        .expect("clean drain");
        assert_eq!(total, 11);
        assert_eq!(got, b"hello world");
    }

    #[test]
    fn drain_propagates_a_consumer_error() {
        let mut reader = std::io::Cursor::new(b"bad".to_vec());
        let err = drain(&mut reader, &mut |_| Err("codec fatal".to_string())).unwrap_err();
        assert!(err.contains("codec fatal"));
    }
}
