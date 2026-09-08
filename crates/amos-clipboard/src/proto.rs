//! Shared host↔guest clipboard-sync wire protocol.
//!
//! # Framing
//!
//! Length-prefixed JSON: a little-endian `u32` byte count followed by that many
//! UTF-8 JSON bytes. A frame may never be empty or exceed [`MAX_JSON_LEN`]; the
//! decoder enforces both so a misbehaving peer cannot make a side buffer
//! unboundedly or crash a parse.
//!
//! ```text
//! [ len: u32 LE ][ json: <len> bytes ]  ...  one or more per stream
//! ```
//!
//! # Messages
//!
//! * Host → Guest: [`HostToGuest::PushText`] — mirror one AmOS plain-text copy
//!   into the guest clipboard (carrying the AmOS `seq` + `ts_ms` for identity).
//! * Guest → Host: [`GuestToHost::ClipboardChanged`] — the guest clipboard changed
//!   (a real copy in an app **or** an echo of our own push) and
//!   [`GuestToHost::PushAcked`] — informational confirmation a push was applied
//!   (never treated as a copy).
//!
//! # Echo guard
//!
//! Copying a text *out* immediately makes the far side's clipboard change, and the
//! far side would (correctly) report it back. Without a guard that echo re-enters
//! the sender's clipboard as a bogus "other side" copy — a copy loop. Both sides
//! keep an [`EchoGuard`]: every push records the mirrored text + timestamp, and an
//! inbound change whose text exactly matches the last own push *within*
//! [`ECHO_WINDOW_MS`] is treated as a self-echo and dropped. Different text (or the
//! same text after the window — a genuine re-copy) is processed normally.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Number of bytes in a frame length prefix (`u32` little-endian).
pub const FRAME_LEN: usize = 4;
/// Upper bound on the JSON payload of a single frame (1 MiB). Matches the text cap.
pub const MAX_JSON_LEN: usize = 1 << 20;
/// Upper bound on a single mirrored plain-text copy.
pub const MAX_MIRROR_TEXT: usize = 1 << 20;
/// Echo-suppression window (ms). Mirrors the proven Kotlin `SUPPRESS_WINDOW_MS`
/// of 500 ms so every path shares the same instinct.
pub const ECHO_WINDOW_MS: u64 = 500;

/// Host → Guest clipboard messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostToGuest {
    /// Mirror one host plain-text copy into the guest clipboard.
    PushText {
        /// Host clipboard sequence number of the copied entry.
        seq: u64,
        /// Host clipboard wall-clock timestamp (ms) of the copy.
        ts_ms: u64,
        /// The plain text to place on the guest clipboard.
        text: String,
    },
}

/// Guest → Host clipboard messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GuestToHost {
    /// The guest clipboard changed. `text` is a real container copy or an echo of
    /// our own [`HostToGuest::PushText`] (see [`EchoGuard`]).
    ClipboardChanged {
        /// Wall-clock timestamp (ms) reported by the guest for the change.
        ts_ms: u64,
        /// The new plain text on the guest clipboard.
        text: String,
    },
    /// Informational: the guest applied a [`HostToGuest::PushText`].
    PushAcked {
        /// The `seq` of the push that was applied.
        seq: u64,
    },
}

/// Encode any serialisable message into one length-prefixed frame.
pub fn encode<M: Serialize>(msg: &M) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(msg).map_err(|e| format!("clipboard encode: {e}"))?;
    let len = json.len();
    if len > MAX_JSON_LEN {
        return Err(format!("clipboard frame exceeds {MAX_JSON_LEN} bytes"));
    }
    if len == 0 {
        return Err("clipboard refuses to encode an empty frame".to_string());
    }
    let mut out = Vec::with_capacity(FRAME_LEN + len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.extend_from_slice(&json);
    Ok(out)
}

/// Streaming, length-prefixed decoder. Decode any serialisable message type: the
/// host reads `GuestToHost`, the guest reads `HostToGuest`.
///
/// Callers push whatever bytes arrive (a fragment, a whole frame, or several
/// frames at once) via [`FrameDecoder::push`]; complete messages are returned.
/// Buffering is bounded by [`MAX_JSON_LEN`]. On a corrupt frame the decoder clears
/// its buffer and returns `Err` so the supervising loop can reset the connection
/// (fail-fast rather than guessing at a resync point).
#[derive(Debug)]
pub struct FrameDecoder<T> {
    buf: Vec<u8>,
    _msg: std::marker::PhantomData<T>,
}

impl<T> Default for FrameDecoder<T> {
    fn default() -> Self {
        Self {
            buf: Vec::new(),
            _msg: std::marker::PhantomData,
        }
    }
}

impl<T> FrameDecoder<T> {
    /// A fresh decoder with an empty buffer.
    pub fn new() -> Self {
        Self::default()
    }
}

impl<T: for<'de> Deserialize<'de>> FrameDecoder<T> {
    /// Feed newly-arrived bytes and return every complete message decoded so far.
    ///
    /// `Err` means the stream is corrupt/oversized and must be treated as fatal
    /// for this connection (the decoder is reset to an empty state).
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<T>, String> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            if self.buf.len() < FRAME_LEN {
                // Not even a length prefix yet. Every declared length is capped
                // below at MAX_JSON_LEN, so we can never be asked to hold more
                // than FRAME_LEN + MAX_JSON_LEN — memory stays bounded.
                return Ok(out);
            }
            let head = [self.buf[0], self.buf[1], self.buf[2], self.buf[3]];
            let len = u32::from_le_bytes(head) as usize;
            if len == 0 {
                self.buf.clear();
                return Err("clipboard: zero-length frame".to_string());
            }
            if len > MAX_JSON_LEN {
                self.buf.clear();
                return Err(format!("clipboard: frame exceeds {MAX_JSON_LEN} bytes"));
            }
            let total = FRAME_LEN + len;
            if self.buf.len() < total {
                // Whole frame not yet buffered; wait for more bytes.
                return Ok(out);
            }
            let msg: T = serde_json::from_slice(&self.buf[FRAME_LEN..total]).map_err(|e| {
                self.buf.clear();
                format!("clipboard: malformed frame: {e}")
            })?;
            self.buf.drain(..total);
            out.push(msg);
        }
    }
}

/// Records the most recent own "set" (a push of `text` to the far side) so its
/// (near-immediate) echo back is not re-processed as a fresh far-side copy.
#[derive(Debug, Default)]
pub struct EchoGuard {
    last_text: Option<String>,
    last_at_ms: u64,
}

impl EchoGuard {
    /// A guard with no remembered set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Remember that `text` was mirrored out at wall-clock `now_ms`.
    pub fn note_set(&mut self, text: &str, now_ms: u64) {
        self.last_text = Some(text.to_string());
        self.last_at_ms = now_ms;
    }

    /// [`Self::note_set`] at the current wall clock.
    pub fn note_set_now(&mut self, text: &str) {
        self.note_set(text, now_ms());
    }

    /// Whether an inbound `text` at `now_ms` is our own echo: `true` only when it
    /// exactly matches our last set **and** arrived inside [`ECHO_WINDOW_MS`].
    pub fn is_self_echo(&self, text: &str, now_ms: u64) -> bool {
        matches!(
            &self.last_text,
            Some(last) if last == text && now_ms.saturating_sub(self.last_at_ms) <= ECHO_WINDOW_MS
        )
    }

    /// [`Self::is_self_echo`] at the current wall clock.
    pub fn is_self_echo_now(&self, text: &str) -> bool {
        self.is_self_echo(text, now_ms())
    }

    /// Snapshot the remembered set (for a caller that arms the guard *before* an
    /// operation that may fail and wants to roll the note back if nothing was set).
    pub fn snap(&self) -> (Option<String>, u64) {
        (self.last_text.clone(), self.last_at_ms)
    }

    /// Restore a previously-taken [`Self::snap`] (rollback of a stale note).
    pub fn restore(&mut self, snap: (Option<String>, u64)) {
        self.last_text = snap.0;
        self.last_at_ms = snap.1;
    }
}

/// Wall-clock milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- frame encode ----

    #[test]
    fn encode_produces_length_prefixed_frame() {
        let msg = HostToGuest::PushText {
            seq: 7,
            ts_ms: 12,
            text: "hello".into(),
        };
        let frame = encode(&msg).unwrap();
        let len = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(
            FRAME_LEN + len,
            frame.len(),
            "frame is exactly prefix + json"
        );
        let json: serde_json::Value = serde_json::from_slice(&frame[FRAME_LEN..]).unwrap();
        assert_eq!(json["PushText"]["seq"], 7);
        assert_eq!(json["PushText"]["text"], "hello");
    }

    #[test]
    fn encode_rejects_payload_over_max_json() {
        let msg = HostToGuest::PushText {
            seq: 1,
            ts_ms: 0,
            text: "x".repeat(MAX_MIRROR_TEXT + 1),
        };
        assert!(
            encode(&msg).is_err(),
            "oversized mirror text must be rejected"
        );
    }

    #[test]
    fn both_directions_round_trip() {
        // Host→Guest and Guest→Host each survive encode→(their own decoder).
        let h = HostToGuest::PushText {
            seq: 1,
            ts_ms: 0,
            text: "hi".into(),
        };
        let mut hd = FrameDecoder::<HostToGuest>::new();
        assert_eq!(hd.push(&encode(&h).unwrap()).unwrap(), vec![h]);

        let g = GuestToHost::ClipboardChanged {
            ts_ms: 0,
            text: "yo".into(),
        };
        let mut gd = FrameDecoder::<GuestToHost>::new();
        assert_eq!(gd.push(&encode(&g).unwrap()).unwrap(), vec![g]);
    }

    #[test]
    fn directions_are_not_interchangeable() {
        // Decoding a HostToGuest frame as GuestToHost (or vice versa) must fail.
        let h = HostToGuest::PushText {
            seq: 1,
            ts_ms: 0,
            text: "x".into(),
        };
        let mut gd = FrameDecoder::<GuestToHost>::new();
        assert!(
            gd.push(&encode(&h).unwrap()).is_err(),
            "PushText is not a GuestToHost frame"
        );
    }

    // ---- streaming decoder ----

    #[test]
    fn decoder_empty_input_yields_nothing() {
        let mut d = FrameDecoder::<GuestToHost>::new();
        assert!(d.push(&[]).unwrap().is_empty());
    }

    #[test]
    fn decoder_round_trips_one_frame() {
        let msg = GuestToHost::ClipboardChanged {
            ts_ms: 5,
            text: "hi".into(),
        };
        let frame = encode(&msg).unwrap();
        let mut d = FrameDecoder::<GuestToHost>::new();
        assert_eq!(d.push(&frame).unwrap(), vec![msg]);
    }

    #[test]
    fn decoder_handles_one_byte_at_a_time() {
        let msg = GuestToHost::ClipboardChanged {
            ts_ms: 9,
            text: "streamed".into(),
        };
        let frame = encode(&msg).unwrap();
        let mut d = FrameDecoder::<GuestToHost>::new();
        let mut got = Vec::new();
        for b in frame {
            got.extend(d.push(&[b]).unwrap());
        }
        assert_eq!(got, vec![msg]);
    }

    #[test]
    fn decoder_handles_multiple_frames_in_one_push() {
        let a = GuestToHost::PushAcked { seq: 1 };
        let b = GuestToHost::ClipboardChanged {
            ts_ms: 2,
            text: "two".into(),
        };
        let mut blob = encode(&a).unwrap();
        blob.extend(encode(&b).unwrap());
        let mut d = FrameDecoder::<GuestToHost>::new();
        assert_eq!(d.push(&blob).unwrap(), vec![a, b]);
        assert!(d.push(&[]).unwrap().is_empty());
    }

    #[test]
    fn decoder_handles_partial_then_complete() {
        let msg = GuestToHost::ClipboardChanged {
            ts_ms: 3,
            text: "split-here".into(),
        };
        let frame = encode(&msg).unwrap();
        let split = frame.len() / 2;
        let mut d = FrameDecoder::<GuestToHost>::new();
        assert!(
            d.push(&frame[..split]).unwrap().is_empty(),
            "no full frame yet"
        );
        assert_eq!(d.push(&frame[split..]).unwrap(), vec![msg]);
    }

    #[test]
    fn decoder_rejects_zero_length_frame_then_recovers() {
        let mut d = FrameDecoder::<GuestToHost>::new();
        let bad = vec![0u8; FRAME_LEN];
        assert!(d.push(&bad).is_err(), "zero-length frame must be rejected");
        let msg = GuestToHost::PushAcked { seq: 1 };
        let ok = encode(&msg).unwrap();
        assert_eq!(
            d.push(&ok).unwrap(),
            vec![msg],
            "decoder resets after a bad frame"
        );
    }

    #[test]
    fn decoder_rejects_oversized_declared_length() {
        let mut d = FrameDecoder::<GuestToHost>::new();
        let len = (MAX_JSON_LEN + 1) as u32;
        let mut bad = len.to_le_bytes().to_vec();
        bad.extend_from_slice(&[0u8; 8]);
        assert!(
            d.push(&bad).is_err(),
            "oversized declared length must be rejected"
        );
    }

    #[test]
    fn decoder_rejects_garbage_json_and_resets() {
        let mut d = FrameDecoder::<GuestToHost>::new();
        let mut bad = (8u32).to_le_bytes().to_vec();
        bad.extend_from_slice(b"not json!");
        assert!(d.push(&bad).is_err(), "malformed JSON must be rejected");
        let msg = GuestToHost::ClipboardChanged {
            ts_ms: 1,
            text: "ok".into(),
        };
        let ok = encode(&msg).unwrap();
        assert_eq!(d.push(&ok).unwrap(), vec![msg], "recovers after resync");
    }

    #[test]
    fn decoder_buffer_stays_bounded_on_max_size_declaration() {
        let mut d = FrameDecoder::<GuestToHost>::new();
        let head = (MAX_JSON_LEN as u32).to_le_bytes().to_vec();
        assert!(d.push(&head).unwrap().is_empty(), "waiting on the payload");
        assert!(
            d.buf.len() <= FRAME_LEN + MAX_JSON_LEN,
            "buffer stays bounded"
        );
    }

    #[test]
    fn decoder_many_concatenated_frames_no_loss() {
        let msgs: Vec<GuestToHost> = (0..300u64)
            .map(|i| GuestToHost::PushAcked { seq: i })
            .collect();
        let mut blob = Vec::new();
        for m in &msgs {
            blob.extend(encode(m).unwrap());
        }
        let mut d = FrameDecoder::<GuestToHost>::new();
        let got = d.push(&blob).unwrap();
        assert_eq!(got.len(), 300, "every frame decoded in one push");
        assert_eq!(got, msgs, "no loss, no reorder across a long run");
    }

    #[test]
    fn decoder_round_trips_a_near_max_text_payload() {
        let text = "a".repeat(MAX_MIRROR_TEXT - 128);
        let msg = GuestToHost::ClipboardChanged { ts_ms: 0, text };
        let frame = encode(&msg).unwrap();
        let mut d = FrameDecoder::<GuestToHost>::new();
        let got = d.push(&frame).unwrap();
        assert_eq!(got.len(), 1);
        match &got[0] {
            GuestToHost::ClipboardChanged { text, .. } => {
                assert_eq!(text.len(), MAX_MIRROR_TEXT - 128);
            }
            other => panic!("expected ClipboardChanged, got {other:?}"),
        }
    }

    // ---- echo guard (neutral: used by both host & guest) ----

    #[test]
    fn echo_guard_flags_own_echo_inside_window() {
        let mut g = EchoGuard::new();
        g.note_set("same", 1000);
        assert!(
            g.is_self_echo("same", 1000 + ECHO_WINDOW_MS),
            "echo at window edge"
        );
        assert!(g.is_self_echo("same", 1000 + ECHO_WINDOW_MS - 1));
    }

    #[test]
    fn echo_guard_does_not_flag_different_text() {
        let mut g = EchoGuard::new();
        g.note_set("host-copy", 1000);
        assert!(
            !g.is_self_echo("guest-copy", 1000),
            "different text is never an echo"
        );
    }

    #[test]
    fn echo_guard_does_not_flag_same_text_after_window() {
        let mut g = EchoGuard::new();
        g.note_set("same", 1000);
        assert!(
            !g.is_self_echo("same", 1000 + ECHO_WINDOW_MS + 1),
            "a genuine re-copy after the window is not an echo"
        );
    }

    #[test]
    fn echo_guard_with_no_prior_set_flags_nothing() {
        let g = EchoGuard::new();
        assert!(!g.is_self_echo("anything", 0));
    }

    #[test]
    fn echo_guard_only_guards_the_latest_set() {
        let mut g = EchoGuard::new();
        g.note_set("old", 1000);
        g.note_set("new", 2000);
        assert!(
            !g.is_self_echo("old", 2000),
            "only the latest set is guarded"
        );
        assert!(g.is_self_echo("new", 2000 + ECHO_WINDOW_MS));
    }
}
