//! Host-side transport for synchronising the AmOS global clipboard with a **guest
//! Android container** (Waydroid / no-UI base — see `docs/clipboard-container-sync.md`
//! and `docs/android-compat.md`).
//!
//! The AmOS global clipboard kernel (`crate::clipboard`) exposes a
//! **transport-agnostic** seam: [`crate::clipboard::ClipboardNative`] +
//! [`crate::clipboard::mirror_to_native`] push an AmOS write out, and
//! [`crate::clipboard::ingest_native_text`] pulls a container copy back in. This
//! module is the **host half** of that seam for the guest topology.
//!
//! The wire protocol (framing, [`HostToGuest`]/[`GuestToHost`] messages, the
//! streaming [`FrameDecoder`], and the [`EchoGuard`] that stops the host from
//! re-ingesting its own push as a "container copy") lives in the shared crate
//! [`amos_clipboard::proto`] — the single source of truth both the host (here) and
//! the guest agent ([`amos_clipboard::agent`]) compile against. This module
//! re-exports it and adds the host transport:
//!
//! * [`GuestSink`] — a [`ClipboardNative`] that mirrors text copies to the guest.
//! * [`handle_guest_msg`] / [`run_ingest`] — decode inbound frames and ingest real
//!   container copies into the shared buffer, skipping our own echoes.
//!
//! Nothing is auto-wired (inert on desktop/CI) until a real host↔guest byte
//! channel is installed on-device — consistent with the crate's "honest no-op
//! until attached" convention.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub use amos_clipboard::proto::{encode, EchoGuard, FrameDecoder, GuestToHost, HostToGuest};

use crate::clipboard::{ClipboardEntry, ClipboardNative};

/// Act on one decoded guest message: ingest a real container copy, ignore echoes
/// and acks. Returns `true` only when the copy was handed to `ingest` and the
/// ingest accepted it.
pub fn handle_guest_msg(
    guard: &EchoGuard,
    msg: GuestToHost,
    ingest: &mut dyn FnMut(&str, &str) -> bool,
) -> bool {
    match msg {
        GuestToHost::ClipboardChanged { text, .. } => {
            if text.trim().is_empty() {
                return false;
            }
            if guard.is_self_echo_now(&text) {
                return false; // our own echo within the suppression window
            }
            ingest("android:container", &text)
        }
        GuestToHost::PushAcked { .. } => false, // informational; never an ingest
    }
}

/// A [`ClipboardNative`] sink that mirrors AmOS text copies to the guest over an
/// injectable byte [`Write`]. The [`EchoGuard`] is shared with the ingest side so
/// the host remembers its own pushes.
pub struct GuestSink<W> {
    writer: Mutex<W>,
    guard: Arc<Mutex<EchoGuard>>,
}

impl<W: Write + Send> GuestSink<W> {
    /// Build a sink over `writer`, sharing the caller-provided echo guard.
    pub fn over(writer: W, guard: Arc<Mutex<EchoGuard>>) -> Self {
        Self {
            writer: Mutex::new(writer),
            guard,
        }
    }
}

impl<W: Write + Send> ClipboardNative for GuestSink<W> {
    fn name(&self) -> &'static str {
        "waydroid-guest"
    }

    /// Encode `entry` as a [`HostToGuest::PushText`] and write+flush it to the
    /// guest. Arms the echo guard *before* sending so it is ready for the
    /// (near-immediate) echo. Image-only payloads cannot be mirrored to a text
    /// container clipboard and are rejected rather than silently dropped.
    fn push_out(&self, entry: &ClipboardEntry) -> Result<(), String> {
        let text = entry.plain_text().ok_or_else(|| {
            "clipboard-guest: image-only payload can't mirror to a text container clipboard"
                .to_string()
        })?;
        if text.trim().is_empty() {
            return Ok(()); // nothing text-bearing to mirror — not an error
        }
        let snap = self.guard.lock().map_err(|e| e.to_string())?.snap();
        {
            let mut g = self.guard.lock().map_err(|e| e.to_string())?;
            g.note_set_now(&text);
        }
        // Encode + write + flush as one fallible unit so a failure rolls the echo
        // note back (nothing reached the guest, so no echo will ever arrive).
        let result = (|| -> Result<(), String> {
            let frame = encode(&HostToGuest::PushText {
                seq: entry.seq,
                ts_ms: entry.timestamp_ms,
                text: text.clone(),
            })?;
            let mut w = self.writer.lock().map_err(|e| e.to_string())?;
            w.write_all(&frame)
                .map_err(|e| format!("clipboard-guest write: {e}"))?;
            w.flush()
                .map_err(|e| format!("clipboard-guest flush: {e}"))?;
            Ok(())
        })();
        if let Err(e) = result {
            // Nothing was sent — undo the note so a later genuine copy of this text
            // is not wrongly suppressed as a self-echo.
            if let Ok(mut g) = self.guard.lock() {
                g.restore(snap);
            }
            return Err(e);
        }
        Ok(())
    }
}

/// Drive the ingest side: read bytes from `reader` until EOF/error, decode frames,
/// and feed each real container copy to `ingest` (skipping our own echoes).
///
/// Returns the number of ingested copies. `Err` signals a corrupt stream (decoder
/// resets) or an I/O failure — both are fatal for this connection and the caller
/// should back off and reconnect.
pub fn run_ingest<R: Read>(
    reader: &mut R,
    guard: &EchoGuard,
    ingest: &mut dyn FnMut(&str, &str) -> bool,
) -> Result<u64, String> {
    let mut decoder = FrameDecoder::<GuestToHost>::new();
    let mut chunk = [0u8; 4096];
    let mut ingested: u64 = 0;
    loop {
        let n = reader
            .read(&mut chunk)
            .map_err(|e| format!("clipboard-guest read: {e}"))?;
        if n == 0 {
            return Ok(ingested); // clean EOF: peer closed
        }
        for msg in decoder.push(&chunk[..n])? {
            if handle_guest_msg(guard, msg, &mut *ingest) {
                ingested += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::{ClipboardPayload, GlobalClipboard};

    // ---- message handling / ingest dispatch ----

    #[test]
    fn handle_ingests_a_real_guest_copy() {
        let g = EchoGuard::new();
        let mut seen: Vec<(String, String)> = Vec::new();
        let handled = handle_guest_msg(
            &g,
            GuestToHost::ClipboardChanged {
                ts_ms: 1,
                text: "from-wechat".into(),
            },
            &mut |src, text| {
                seen.push((src.to_string(), text.to_string()));
                true
            },
        );
        assert!(handled);
        assert_eq!(
            seen,
            vec![("android:container".to_string(), "from-wechat".into())]
        );
    }

    #[test]
    fn handle_drops_own_echo() {
        let mut g = EchoGuard::new();
        g.note_set_now("host-copy");
        let mut calls = 0;
        let handled = handle_guest_msg(
            &g,
            GuestToHost::ClipboardChanged {
                ts_ms: 0,
                text: "host-copy".into(),
            },
            &mut |_, _| {
                calls += 1;
                true
            },
        );
        assert!(!handled, "echo must not be ingested");
        assert_eq!(calls, 0);
    }

    #[test]
    fn handle_ignores_ack() {
        let g = EchoGuard::new();
        let handled = handle_guest_msg(&g, GuestToHost::PushAcked { seq: 1 }, &mut |_, _| true);
        assert!(!handled, "an ack must never be ingested");
    }

    #[test]
    fn handle_rejects_blank_text() {
        let g = EchoGuard::new();
        let handled = handle_guest_msg(
            &g,
            GuestToHost::ClipboardChanged {
                ts_ms: 0,
                text: "   ".into(),
            },
            &mut |_, _| true,
        );
        assert!(!handled, "blank text must not be ingested");
    }

    #[test]
    fn handle_reports_false_when_ingest_declines() {
        let g = EchoGuard::new();
        let handled = handle_guest_msg(
            &g,
            GuestToHost::ClipboardChanged {
                ts_ms: 0,
                text: "declined".into(),
            },
            &mut |_, _| false, // e.g. ingest bus not armed
        );
        assert!(!handled);
    }

    // ---- sink (ClipboardNative) ----

    fn frame_payload(wire: &[u8]) -> serde_json::Value {
        use amos_clipboard::proto::FRAME_LEN;
        let len = u32::from_le_bytes([wire[0], wire[1], wire[2], wire[3]]) as usize;
        serde_json::from_slice(&wire[FRAME_LEN..FRAME_LEN + len]).unwrap()
    }

    #[test]
    fn sink_mirrors_text_and_arms_echo_guard() {
        let guard = Arc::new(Mutex::new(EchoGuard::new()));
        let mut wire: Vec<u8> = Vec::new();
        let sink = GuestSink::over(&mut wire, guard.clone());

        let c = GlobalClipboard::new();
        let entry = c.write_plain("notes", "notes", "mirror-me").unwrap();
        sink.push_out(&entry).unwrap();

        // The guard was armed with the mirrored text: its echo is flagged as a
        // self-echo (and therefore suppressed by handle_guest_msg/run_ingest).
        assert!(guard.lock().unwrap().is_self_echo_now("mirror-me"));

        // The wire carries exactly one well-formed PushText frame.
        let json = frame_payload(&wire);
        assert_eq!(json["PushText"]["seq"], entry.seq);
        assert_eq!(json["PushText"]["text"], "mirror-me");
        // Decoding a host frame as GuestToHost must fail (opposite direction).
        let mut d = FrameDecoder::<GuestToHost>::new();
        assert!(
            d.push(&wire).is_err(),
            "PushText is not a GuestToHost frame"
        );
    }

    #[test]
    fn sink_rejects_image_only_payload_without_writing() {
        let guard = Arc::new(Mutex::new(EchoGuard::new()));
        let mut wire: Vec<u8> = Vec::new();
        let sink = GuestSink::over(&mut wire, guard.clone());

        let c = GlobalClipboard::new();
        let entry = c
            .write(
                "a",
                "a",
                ClipboardPayload::Image {
                    mime: "image/png".into(),
                    data_b64: "aGk=".into(),
                },
            )
            .unwrap();
        assert!(
            sink.push_out(&entry).is_err(),
            "an image-only payload cannot be mirrored to a text container clipboard"
        );
        assert!(wire.is_empty(), "nothing must be written on rejection");
    }

    #[test]
    fn sink_blank_text_is_a_no_op_without_error_or_write() {
        let guard = Arc::new(Mutex::new(EchoGuard::new()));
        let mut wire: Vec<u8> = Vec::new();
        let sink = GuestSink::over(&mut wire, guard.clone());

        let c = GlobalClipboard::new();
        let entry = c
            .write(
                "a",
                "a",
                ClipboardPayload::Html {
                    html: "<b></b>".into(),
                    plain: "".into(),
                },
            )
            .unwrap();
        assert_eq!(entry.plain_text(), Some("".to_string()));
        assert!(sink.push_out(&entry).is_ok());
        assert!(wire.is_empty(), "nothing to mirror -> nothing written");
    }

    struct FailingWriter;
    impl std::io::Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("write boom"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::other("flush boom"))
        }
    }

    #[test]
    fn failed_push_out_does_not_leave_a_stale_echo_note() {
        let guard = Arc::new(Mutex::new(EchoGuard::new()));
        let sink = GuestSink::over(FailingWriter, guard.clone());
        let c = GlobalClipboard::new();
        let entry = c.write_plain("notes", "notes", "secret").unwrap();
        assert!(sink.push_out(&entry).is_err(), "the write fails");
        // Nothing reached the guest, so no echo will arrive: the note must be rolled
        // back, not left to suppress a later genuine copy of the same text.
        assert!(
            !guard.lock().unwrap().is_self_echo_now("secret"),
            "no stale echo note may survive a failed push"
        );
    }

    // ---- reader loop (end to end, in-memory) ----

    #[test]
    fn run_ingest_skips_echo_and_counts_real_ingests() {
        let mut guard = EchoGuard::new();
        guard.note_set_now("host-copy");

        let real = encode(&GuestToHost::ClipboardChanged {
            ts_ms: 1,
            text: "guest-copy".into(),
        })
        .unwrap();
        let echo = encode(&GuestToHost::ClipboardChanged {
            ts_ms: 0,
            text: "host-copy".into(),
        })
        .unwrap();
        let mut blob = real;
        blob.extend(echo);

        let mut reader = std::io::Cursor::new(blob);
        let mut ingested_texts = Vec::new();
        let mut ingest = |src: &str, text: &str| {
            assert_eq!(src, "android:container");
            ingested_texts.push(text.to_string());
            true
        };
        let count = run_ingest(&mut reader, &guard, &mut ingest).unwrap();
        assert_eq!(count, 1, "only the real guest copy is ingested");
        assert_eq!(ingested_texts, vec!["guest-copy".to_string()]);
    }

    #[test]
    fn run_ingest_clean_eof_returns_zero() {
        let guard = EchoGuard::new();
        let mut reader = std::io::Cursor::new(Vec::<u8>::new());
        let count = run_ingest(&mut reader, &guard, &mut |_, _| true).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn run_ingest_corrupt_stream_is_fatal() {
        let guard = EchoGuard::new();
        let bad: Vec<u8> = vec![0u8; 4]; // zero-length frame
        let mut reader = std::io::Cursor::new(bad);
        assert!(run_ingest(&mut reader, &guard, &mut |_, _| true).is_err());
    }
}
