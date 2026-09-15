//! Wire codec: typed `Message` payloads inside a self-describing `Envelope` frame.
//!
//! The ROS `.msg`/IDL registry is replaced by two Rust traits the compiler already
//! checks: any `serde` type is a [`Message`], and every frame carries enough metadata
//! for a *foreign* reader (another board, a non-Rust tool, a packet capture) to route
//! and time it without the schema:
//!
//! ```text
//!  magic "AMLK" │ ver=1 │ header_len u32 │ header (bincode) │ crc32 u32 │ payload
//!     0..4      │  4    │     5..9       │   9..9+hl        │   …       │   …
//! ```
//!
//! * `header` = [`Header`]: topic, publisher peer id, sequence number and the
//!   publisher's [`Timestamp`]. The topic travels *inside* the frame so a subscriber
//!   that matched a wildcard learns which concrete topic (and which robot) it just
//!   received — the "who is talking to me" half of a decentralized bus.
//! * `crc32` covers header + payload, so a truncated Wi-Fi frame fails at the
//!   transport boundary instead of inside an actuator.
//! * the payload is `bincode` ([`Message::encode`]) — compact and fast: this is the
//!   *data plane*, where a schema-negotiation round-trip would cost more than the frame.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use amos_timesync::SyncedClock;

use crate::discovery::PeerId;
use crate::error::{LinkError, Result};
use crate::keyexpr::Topic;

/// Frame magic ("AMos LinK").
pub const MAGIC: [u8; 4] = *b"AMLK";
/// Frame format version; a decoder refuses anything else instead of guessing.
pub const VERSION: u8 = 1;
/// Fixed part of the frame before the bincode header: magic + version + header length.
const PREFIX_LEN: usize = 4 + 1 + 4;
/// Largest accepted payload (and therefore frame), in bytes.
///
/// A robot link carries large things — a 1280×720 stereo depth pair is ~1 MB — but
/// "large" has to end somewhere: without a ceiling, one misbehaving publisher (or a
/// hostile one) makes every subscriber allocate whatever the header claims. 16 MiB
/// leaves room for a full-resolution depth frame or a point cloud with a wide margin,
/// and is enforced on **both** sides: [`Envelope::encode`] refuses to build an
/// oversized frame and [`Envelope::decode`] refuses to believe one (`payload_len` is
/// checked *before* any allocation, so a forged header cannot make a receiver
/// allocate 4 GiB).
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
/// Largest accepted header (a topic + a peer id + numbers; 4 KiB is generous).
const MAX_HEADER_BYTES: usize = 4 * 1024;

/// CRC32 over a frame's header **and** payload, computed without copying either.
///
/// This is the checksum that must cover both halves, and the obvious way to write it —
/// `crc32fast::hash(&[header, payload].concat())` — is the wrong one for a robot link:
/// it allocates and copies a *second* full frame. At the 16 MiB ceiling that doubles the
/// peak memory of one frame, and the copy happens on **every** received frame *before*
/// the checksum has proven the frame is worth keeping — so a hostile peer could make a
/// receiver allocate 32 MiB per frame while sending 16 MiB. Streaming the two slices
/// through one hasher yields the identical CRC32 of the concatenation (CRC32 is defined
/// over a byte stream, and `Hasher::update` appends) with zero extra allocation.
pub(crate) fn crc32_over(header: &[u8], payload: &[u8]) -> u32 {
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(header);
    hasher.update(payload);
    hasher.finalize()
}

/// A wall-clock instant on the publisher's (possibly calibrated) clock.
///
/// Latency is only meaningful when both ends share a clock, which is why the link
/// layer stamps with `amos-timesync`'s [`SyncedClock`] rather than a bare
/// `SystemTime::now()`: a node that ran `amos-timesync-cli sync` reports real
/// one-way latency, and an unsynced node reports a lower bound. The value carries no
/// zone and no monotonicity — exactly what a wire format should carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Timestamp {
    /// Seconds since the Unix epoch.
    pub secs: u64,
    /// Sub-second part in nanoseconds (`< 1e9`).
    pub nanos: u32,
}

impl Timestamp {
    /// Build a timestamp; a `nanos` of `1e9` or more is refused (it would make two
    /// encodings of the same instant compare differently).
    pub fn new(secs: u64, nanos: u32) -> Result<Self> {
        let stamp = Self { secs, nanos };
        if !stamp.is_valid() {
            return Err(LinkError::Codec(format!(
                "nanos {nanos} is not a sub-second value"
            )));
        }
        Ok(stamp)
    }

    /// True when this is a well-formed stamp: `nanos` is a real sub-second part (`< 1e9`).
    ///
    /// [`Timestamp::new`] refuses anything else, but a `Deserialize` cannot run a
    /// constructor — so a stamp that arrived as *bytes* (a frame header, a beacon) has to be
    /// asked the same question again, and this is that question without a `Result` in the
    /// way. The invariant is not cosmetic: the derived `Ord` compares `(secs, nanos)` while
    /// [`Timestamp::as_nanos`] compares the value, and those two orders agree only while
    /// `nanos < 1e9` — `1.5s` and `2.0s` may not sort as the same instant's two spellings.
    pub fn is_valid(&self) -> bool {
        self.nanos < 1_000_000_000
    }

    /// The host wall clock, right now.
    pub fn now() -> Self {
        Self::from_system_time(SystemTime::now())
    }

    /// Convert a [`SystemTime`] (clamping pre-epoch instants to the epoch).
    pub fn from_system_time(t: SystemTime) -> Self {
        let d = t.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
        Self {
            secs: d.as_secs(),
            nanos: d.subsec_nanos(),
        }
    }

    /// Nanoseconds since the Unix epoch (the comparison unit for latency).
    pub fn as_nanos(&self) -> u128 {
        u128::from(self.secs) * 1_000_000_000 + u128::from(self.nanos)
    }

    /// Milliseconds since the Unix epoch — the CLI/JSON rendering.
    ///
    /// Saturating, because a [`Timestamp`] is a *wire* value: a hostile or broken
    /// publisher can put `secs = u64::MAX` in a frame header, and a display helper must
    /// not overflow (a debug-build panic on untrusted input) just because the number is
    /// absurd.
    pub fn unix_ms(&self) -> u64 {
        self.secs
            .saturating_mul(1_000)
            .saturating_add(u64::from(self.nanos) / 1_000_000)
    }

    /// Elapsed time since an earlier stamp; `Duration::ZERO` if `self` is older.
    ///
    /// This is the age/latency primitive: `Timestamp::now().since(&stamp)`. A clock
    /// that jumped backwards yields a `0` age instead of a nonsense huge value.
    pub fn since(&self, earlier: &Timestamp) -> Duration {
        let delta = self.as_nanos().saturating_sub(earlier.as_nanos());
        Duration::from_nanos(u64::try_from(delta).unwrap_or(u64::MAX))
    }
}

impl std::fmt::Display for Timestamp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{:09}", self.secs, self.nanos)
    }
}

/// The node's clock: an `amos-timesync` [`SyncedClock`] behind a short-lived lock.
///
/// `SyncedClock` is deliberately not internally synchronized (its own doc says the
/// calibrating timekeeper and its readers share it behind a lock), so the link layer
/// wraps it once, here. Stamping is a *sync* method with no `await` inside, so no
/// guard is ever held across a suspension point and a `std::sync::Mutex` is the right
/// (cheapest) choice.
#[derive(Debug)]
pub struct Clock {
    inner: Mutex<SyncedClock>,
}

impl Clock {
    /// The default: the raw host wall clock (unsynced until something calibrates it).
    pub fn host() -> Self {
        Self::from_synced(SyncedClock::new())
    }

    /// Adopt an already-calibrated clock (a supervisor's `timesync` instance, or one
    /// loaded from `$AMOS_TIMESYNC_STATE`).
    pub fn from_synced(clock: SyncedClock) -> Self {
        Self {
            inner: Mutex::new(clock),
        }
    }

    /// Stamp "now" according to this clock.
    pub fn now(&self) -> Timestamp {
        let t = self
            .inner
            .lock()
            .map(|c| c.now())
            .unwrap_or_else(|_| SystemTime::now());
        Timestamp::from_system_time(t)
    }

    /// True when the clock has been calibrated against a network time source.
    pub fn synced(&self) -> bool {
        self.inner.lock().map(|c| c.synced()).unwrap_or(false)
    }

    /// True when the calibration is younger than `max_age`.
    pub fn is_fresh(&self, max_age: Duration) -> bool {
        self.inner
            .lock()
            .map(|c| c.is_fresh(max_age))
            .unwrap_or(false)
    }

    /// Re-calibrate in place from a remote wall clock.
    pub fn apply(&self, remote: SystemTime) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| LinkError::Closed("clock lock poisoned".to_string()))?;
        guard
            .apply(remote)
            .map_err(|e| LinkError::Codec(e.to_string()))?;
        Ok(())
    }
}

impl Default for Clock {
    fn default() -> Self {
        Self::host()
    }
}

/// Anything that can travel as an AmOS-Link payload.
///
/// A blanket impl covers every `serde` type, so a domain type becomes wire-ready by
/// deriving `Serialize`/`Deserialize` — that *is* the message registry: this crate's
/// own `Heartbeat`/`Beacon` derive it, and so does any `amos-*` domain type (the point
/// of keeping AmOS-Link inside the workspace instead of a separate repo, where
/// `amos-proto`/`amos-sensor` types are one `path =` away).
pub trait Message: Serialize + DeserializeOwned + Send + 'static {
    /// Encode to the compact wire form (**payload only** — framing is [`Envelope`]).
    fn encode(&self) -> Result<Vec<u8>> {
        bincode::serialize(self).map_err(|e| LinkError::Codec(e.to_string()))
    }

    /// Decode from the wire form.
    fn decode(bytes: &[u8]) -> Result<Self>
    where
        Self: Sized,
    {
        bincode::deserialize(bytes).map_err(|e| LinkError::Codec(e.to_string()))
    }
}

impl<T> Message for T where T: Serialize + DeserializeOwned + Send + 'static {}

/// Routing metadata carried by every frame.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    /// The concrete topic the frame was published on.
    pub topic: String,
    /// The publishing peer (a receiver that matched `amos/**/imu` learns *who* spoke).
    pub publisher: PeerId,
    /// Per-publisher monotonic sequence number (1-based); gaps mean dropped frames.
    pub seq: u64,
    /// The publisher's clock at publish time.
    pub stamp: Timestamp,
    /// Length of the payload that follows, so a decoder can refuse a mismatch.
    pub payload_len: u32,
}

impl Header {
    /// Re-ask, of a header that arrived **as bytes**, every question its field types ask
    /// locally.
    ///
    /// This exists because `Deserialize` cannot run a constructor: `Topic::new`,
    /// `PeerId::new` and `Timestamp::new` all validate, and every one of them is bypassed by
    /// the derive. `Envelope::decode` therefore used to hand out headers the crate's own
    /// types would refuse — a `publisher` that is not a peer id (the table keys on it and
    /// every CLI/UI prints it), a stamp whose `nanos` is not sub-second (then `Ord` and
    /// `as_nanos` disagree about which of two instants came first), or a topic no
    /// `Topic::new` would accept.
    ///
    /// Also called by [`Envelope::encode`]: a frame this side cannot re-read is a bug the
    /// far side would report as "nothing arrives", the same reason the size ceiling is
    /// checked on both sides. Non-allocating, so a refused frame costs nothing on the
    /// receive path.
    pub fn validate(&self) -> Result<()> {
        Topic::validate_str(&self.topic).map_err(|e| {
            LinkError::Frame(format!(
                "header topic `{}` is not a concrete key expression: {e}",
                self.topic
            ))
        })?;
        PeerId::validate_str(self.publisher.as_str()).map_err(|e| {
            LinkError::Frame(format!(
                "header publisher `{}` is not a peer id: {e}",
                self.publisher
            ))
        })?;
        if !self.stamp.is_valid() {
            return Err(LinkError::Frame(format!(
                "header stamp {}.{:09} is not well formed: nanos {} is not a sub-second value",
                self.stamp.secs, self.stamp.nanos, self.stamp.nanos
            )));
        }
        Ok(())
    }
}

/// A framed AmOS-Link message: header + payload + CRC32.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    /// Routing/timing metadata.
    pub header: Header,
    /// The [`Message`] payload, encoded by [`Message::encode`].
    pub payload: Vec<u8>,
}

impl Envelope {
    /// Wrap a payload, stamping it with the caller's identity/sequence/clock.
    pub fn new(
        topic: &Topic,
        publisher: &PeerId,
        seq: u64,
        stamp: Timestamp,
        payload: Vec<u8>,
    ) -> Self {
        let header = Header {
            topic: topic.as_str().to_string(),
            publisher: publisher.clone(),
            seq,
            stamp,
            payload_len: payload.len() as u32,
        };
        Self { header, payload }
    }

    /// The topic as a validated [`Topic`] (the header stores a plain string so a
    /// foreign frame is *rejected* with an error rather than panicking the receiver).
    ///
    /// This is the header's **claim**, which a subscriber cross-checks against the
    /// transport's routing key before believing it (see
    /// [`Subscriber`](crate::pubsub::Subscriber)); a gateway that re-publishes a frame on
    /// another topic must re-stamp it ([`Envelope::new`]) rather than lie here.
    pub fn topic(&self) -> Result<Topic> {
        Topic::new(self.header.topic.clone())
    }

    /// Encode the whole frame (this is what a transport puts on the wire).
    ///
    /// Refuses a payload above [`MAX_PAYLOAD_BYTES`] and a header that is not a
    /// plausible header — the size ceiling lives here as well as in `decode`, so an
    /// oversized frame cannot even be produced (and therefore cannot be debugged as a
    /// mysterious "nothing arrives" on the far side).
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.payload.len() as u64 != u64::from(self.header.payload_len) {
            return Err(LinkError::Frame(format!(
                "payload is {} bytes but the header says {}",
                self.payload.len(),
                self.header.payload_len
            )));
        }
        if self.payload.len() > MAX_PAYLOAD_BYTES {
            return Err(LinkError::Frame(format!(
                "payload of {} bytes exceeds the {MAX_PAYLOAD_BYTES}-byte frame limit",
                self.payload.len()
            )));
        }
        // The header's *shape* is checked on this side too: a topic/publisher/stamp this
        // crate's own constructors would refuse must not reach the wire, where the far side
        // can only report it as "nothing arrives" (and where a hostile peer would, of
        // course, skip this check entirely).
        self.header.validate()?;
        let header =
            bincode::serialize(&self.header).map_err(|e| LinkError::Codec(e.to_string()))?;
        if header.len() > MAX_HEADER_BYTES {
            return Err(LinkError::Frame(format!(
                "header of {} bytes exceeds the {MAX_HEADER_BYTES}-byte limit",
                header.len()
            )));
        }
        let header_len = u32::try_from(header.len())
            .map_err(|_| LinkError::Frame("header too large".to_string()))?;

        let mut frame = Vec::with_capacity(PREFIX_LEN + header.len() + 4 + self.payload.len());
        frame.extend_from_slice(&MAGIC);
        frame.push(VERSION);
        frame.extend_from_slice(&header_len.to_le_bytes());
        frame.extend_from_slice(&header);
        let crc = crc32_over(&header, &self.payload);
        frame.extend_from_slice(&crc.to_le_bytes());
        frame.extend_from_slice(&self.payload);
        Ok(frame)
    }

    /// Decode a frame, refusing a foreign magic, an unknown version, a truncated
    /// frame, an implausible length, a bad CRC, or a size beyond [`MAX_PAYLOAD_BYTES`].
    pub fn decode(frame: &[u8]) -> Result<Self> {
        let (header, payload) = Self::decode_header(frame)?;
        Ok(Self {
            header,
            payload: payload.to_vec(),
        })
    }

    /// Decode **just the header**, borrowing the payload's bytes.
    ///
    /// `decode` copies the payload (`payload.to_vec()`) because its caller wants the bytes; a
    /// consumer that only needs the envelope's routing/timing metadata — the arrival-rate
    /// instrument (`crate::rate`), a topic counter, a forwarder deciding where a frame goes —
    /// would pay a copy of the whole frame (up to 16 MiB, at whatever rate the stream runs) for a
    /// header it already has in hand. That is the same rule the checksum follows: **the receive
    /// path never builds a second copy of a frame** (`docs/amos-link.md` §3.3). The returned
    /// slice is a borrow, so a caller that discards it allocates only the header.
    ///
    /// This is the **one** parser: `decode` is written on top of it, so the magic/version/length
    /// ceiling/CRC/header-validation checks cannot drift between the two paths — they are the
    /// checks that keep a hostile frame out, and a second copy of them would be a second opinion.
    pub fn decode_header(frame: &[u8]) -> Result<(Header, &[u8])> {
        if frame.len() < PREFIX_LEN + 4 {
            return Err(LinkError::Frame(format!(
                "frame of {} bytes is shorter than the fixed header",
                frame.len()
            )));
        }
        if frame.len() > MAX_PAYLOAD_BYTES + MAX_HEADER_BYTES + PREFIX_LEN + 4 {
            return Err(LinkError::Frame(format!(
                "frame of {} bytes exceeds the maximum frame size",
                frame.len()
            )));
        }
        if frame[..4] != MAGIC {
            return Err(LinkError::Frame(
                "bad magic (not an AmOS-Link frame)".to_string(),
            ));
        }
        if frame[4] != VERSION {
            return Err(LinkError::Frame(format!(
                "frame version {} is not supported (this build speaks {VERSION})",
                frame[4]
            )));
        }
        let header_len = u32::from_le_bytes([frame[5], frame[6], frame[7], frame[8]]) as usize;
        // A header bigger than the ceiling is a forged/corrupt frame: refuse it before
        // slicing, so a 4 GiB `header_len` cannot walk us into a panic or a huge alloc.
        if header_len > MAX_HEADER_BYTES {
            return Err(LinkError::Frame(format!(
                "header of {header_len} bytes exceeds the {MAX_HEADER_BYTES}-byte limit"
            )));
        }
        let header_end = PREFIX_LEN
            .checked_add(header_len)
            .ok_or_else(|| LinkError::Frame("header length overflow".to_string()))?;
        let crc_end = header_end
            .checked_add(4)
            .ok_or_else(|| LinkError::Frame("frame length overflow".to_string()))?;
        if frame.len() < crc_end {
            return Err(LinkError::Frame(format!(
                "frame of {} bytes cannot hold a {header_len}-byte header",
                frame.len()
            )));
        }
        let header_bytes = &frame[PREFIX_LEN..header_end];
        let payload = &frame[crc_end..];
        let expect = u32::from_le_bytes([
            frame[header_end],
            frame[header_end + 1],
            frame[header_end + 2],
            frame[header_end + 3],
        ]);
        let actual = crc32_over(header_bytes, payload);
        if expect != actual {
            return Err(LinkError::Frame(format!(
                "crc32 mismatch (frame says {expect:#010x}, computed {actual:#010x})"
            )));
        }
        let header: Header =
            bincode::deserialize(header_bytes).map_err(|e| LinkError::Frame(e.to_string()))?;
        // Every field of this header is peer-chosen bytes: re-ask what the local
        // constructors ask (see `Header::validate`) before the header is handed out.
        header.validate()?;
        if header.payload_len as usize != payload.len() {
            return Err(LinkError::Frame(format!(
                "header says {} payload bytes, frame carries {}",
                header.payload_len,
                payload.len()
            )));
        }
        Ok((header, payload))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct DepthFrame {
        seq: u64,
        width: u32,
        height: u32,
        points: Vec<i16>,
    }

    fn peer() -> PeerId {
        PeerId::new("dog1").expect("valid peer id")
    }

    fn topic() -> Topic {
        Topic::new("amos/dog1/sensor/stereo_left").expect("valid topic")
    }

    fn envelope() -> Envelope {
        let frame = DepthFrame {
            seq: 7,
            width: 2,
            height: 2,
            points: vec![1, -2, 3, -4],
        };
        let payload = frame.encode().expect("encode");
        Envelope::new(
            &topic(),
            &peer(),
            7,
            Timestamp::new(1_700_000_000, 123_456_789).expect("valid stamp"),
            payload,
        )
    }

    /// A header **as an attacker writes one**: a shadow struct with [`Header`]'s bincode
    /// layout, so `publisher` is a plain `String` and `topic`/`stamp` are whatever bytes
    /// were chosen. This is the honest shape of the attack — a peer writes bytes, not Rust
    /// values, so `PeerId::new`/`Topic::new`/`Timestamp::new` are never on its path.
    #[derive(Clone, serde::Serialize)]
    struct WireHeader {
        topic: String,
        publisher: String,
        seq: u64,
        stamp: Timestamp,
        payload_len: u32,
    }

    /// Frame a hand-written header the way the transport does: same prefix, same CRC, so the
    /// header's *shape* is the only possible reason to refuse it.
    fn frame_of_wire_header(header: &WireHeader, payload: &[u8]) -> Vec<u8> {
        let header_bytes = bincode::serialize(header).expect("header");
        let mut frame = Vec::new();
        frame.extend_from_slice(&MAGIC);
        frame.push(VERSION);
        frame.extend_from_slice(
            &u32::try_from(header_bytes.len())
                .expect("header len")
                .to_le_bytes(),
        );
        frame.extend_from_slice(&header_bytes);
        frame.extend_from_slice(&crc32_over(&header_bytes, payload).to_le_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    #[test]
    fn the_header_only_reader_borrows_and_refuses_exactly_what_decode_refuses() {
        // One parser, two shapes: `decode` (payload owned) is written on top of `decode_header`
        // (payload borrowed), so the checks that keep a hostile frame out cannot drift apart.
        let frame = envelope().encode().expect("encode");
        let (header, payload) = Envelope::decode_header(&frame).expect("header-only decode");
        assert_eq!(header, envelope().header);
        // The payload is a **borrow** of the input buffer, not a copy: this is the whole reason
        // the method exists (a rate instrument must not memcpy a 16 MiB depth frame per frame).
        let offset = payload.as_ptr() as usize - frame.as_ptr() as usize;
        assert_eq!(
            offset + payload.len(),
            frame.len(),
            "the borrow is the frame's tail, not a new buffer"
        );
        assert_eq!(payload, &frame[offset..]);
        assert!(
            core::ptr::eq(payload.as_ptr(), frame[frame.len() - payload.len()..].as_ptr()),
            "the returned slice must point *into* the frame"
        );
        // Same bytes through the owning path: same header, same payload.
        let owned = Envelope::decode(&frame).expect("decode");
        assert_eq!(owned.header, header);
        assert_eq!(owned.payload, payload);

        // Every refusal `decode` makes, `decode_header` makes identically — the CRC, the magic,
        // the version, the truncation, the length ceilings.
        let mut broken: Vec<(&str, Vec<u8>)> = Vec::new();
        let mut flipped = frame.clone();
        let mid = flipped.len() / 2;
        flipped[mid] ^= 0xff;
        broken.push(("a bit flipped in the middle", flipped));
        let mut magic = frame.clone();
        magic[0] ^= 0xff;
        broken.push(("a foreign magic", magic));
        let mut version = frame.clone();
        version[4] = version[4].wrapping_add(1);
        broken.push(("an unknown version", version));
        broken.push(("a truncated frame", frame[..frame.len() - 1].to_vec()));
        broken.push(("an empty frame", Vec::new()));
        for (what, bytes) in broken {
            let owned = Envelope::decode(&bytes).expect_err(&format!("{what}: decode must refuse"));
            let only = Envelope::decode_header(&bytes)
                .expect_err(&format!("{what}: decode_header must refuse"));
            assert_eq!(
                format!("{owned}"),
                format!("{only}"),
                "{what}: the two paths must refuse with the same reason"
            );
        }
    }

    #[test]
    fn the_streamed_crc_equals_the_concatenated_one_and_is_pinned() {
        // The checksum is defined over the byte stream `header ‖ payload`, so pushing
        // both slices through one hasher must equal the (allocating) concatenation it
        // replaced: the wire format is unchanged, the extra full-frame copy is gone.
        let header = b"a-header";
        let payload = b"a-payload";
        assert_eq!(
            crc32_over(header, payload),
            crc32fast::hash(&[&header[..], &payload[..]].concat()),
            "streaming and concatenating must agree byte for byte"
        );

        // …and the CRC of a real frame is pinned, because it is part of the wire contract
        // every other board (and every captured pcap) depends on.
        let wire = envelope().encode().expect("encode");
        let header_len = u32::from_le_bytes([wire[5], wire[6], wire[7], wire[8]]) as usize;
        let at = PREFIX_LEN + header_len;
        let crc = u32::from_le_bytes([wire[at], wire[at + 1], wire[at + 2], wire[at + 3]]);
        assert_eq!(
            crc, 0xFC0E_56E6,
            "the frame CRC is part of the wire contract, not an implementation detail"
        );
    }

    #[test]
    fn a_flipped_bit_in_either_half_is_caught_before_it_is_parsed() {
        let wire = envelope().encode().expect("encode");
        let header_len = u32::from_le_bytes([wire[5], wire[6], wire[7], wire[8]]) as usize;
        let at = PREFIX_LEN + header_len;

        // A corrupted header byte: refused by the checksum, *before* bincode is handed
        // bytes a peer controls (the order matters: parse never runs on unverified data).
        let mut bad_header = wire.clone();
        bad_header[PREFIX_LEN] ^= 0x01;
        assert!(matches!(
            Envelope::decode(&bad_header),
            Err(LinkError::Frame(_))
        ));

        // A corrupted payload byte (the last byte of the frame) is caught too — which is
        // the whole point of covering both halves in one CRC.
        let mut bad_payload = wire.clone();
        let last = bad_payload.len() - 1;
        bad_payload[last] ^= 0x01;
        assert!(matches!(
            Envelope::decode(&bad_payload),
            Err(LinkError::Frame(_))
        ));
        assert!(at > PREFIX_LEN, "the frame really has a header to cover");
    }

    #[test]
    fn a_header_off_the_wire_is_re_validated_field_by_field() {
        // The defect this pins: `Header` derives `Deserialize`, so `Topic::new`,
        // `PeerId::new` and `Timestamp::new` were **never asked** about a frame that arrived
        // from a peer — `decode` handed out headers the crate's own constructors refuse, and
        // the `publisher` id keys the peer/sequence tables and is printed by every UI.
        let payload = DepthFrame {
            seq: 1,
            width: 1,
            height: 1,
            points: vec![7],
        }
        .encode()
        .expect("payload");
        let good = WireHeader {
            topic: "amos/dog1/sensor/stereo_left".to_string(),
            publisher: "dog1".to_string(),
            seq: 1,
            stamp: Timestamp {
                secs: 1_700_000_000,
                nanos: 123_456_789,
            },
            payload_len: payload.len() as u32,
        };
        // Positive control: the hand-written builder is *correct* — a well-formed header it
        // writes really does decode, so a refusal below is about the field, not the framing.
        let decoded = Envelope::decode(&frame_of_wire_header(&good, &payload)).expect("decode");
        assert_eq!(decoded.header.publisher.as_str(), "dog1");

        // (a) a publisher that is not a peer id: over-long, illegal charset, a path, empty.
        for bad in [
            "x".repeat(PeerId::MAX_LEN + 1),
            "dog 1".to_string(),
            "amos/dog1".to_string(),
            "dog1\n".to_string(),
            String::new(),
        ] {
            let hostile = WireHeader {
                publisher: bad.clone(),
                ..good.clone()
            };
            let err = Envelope::decode(&frame_of_wire_header(&hostile, &payload))
                .expect_err("a non-peer-id publisher must be refused");
            assert!(matches!(err, LinkError::Frame(_)), "{bad:?} ⇒ {err:?}");
            assert!(
                err.to_string().contains("publisher"),
                "{bad:?} must be named as the reason: {err}"
            );
        }
        // …and the boundary itself is legal (exactly `PeerId::MAX_LEN` bytes), so the check
        // cannot be an off-by-one that refuses workable ids.
        let boundary = WireHeader {
            publisher: "x".repeat(PeerId::MAX_LEN),
            ..good.clone()
        };
        assert!(Envelope::decode(&frame_of_wire_header(&boundary, &payload)).is_ok());

        // (b) a stamp whose `nanos` is not sub-second: `as_nanos`/`since` (the value) and the
        // derived `Ord` (the fields) then disagree about which instant came first.
        for nanos in [1_000_000_000u32, 4_294_967_295] {
            let hostile = WireHeader {
                stamp: Timestamp {
                    secs: 1_700_000_000,
                    nanos,
                },
                ..good.clone()
            };
            let err = Envelope::decode(&frame_of_wire_header(&hostile, &payload))
                .expect_err("a non-sub-second nanos must be refused");
            assert!(err.to_string().contains("sub-second"), "{nanos} ⇒ {err}");
        }
        let last_valid = WireHeader {
            stamp: Timestamp {
                secs: 1_700_000_000,
                nanos: 999_999_999,
            },
            ..good.clone()
        };
        assert!(Envelope::decode(&frame_of_wire_header(&last_valid, &payload)).is_ok());

        // (c) a topic no `Topic::new` accepts (empty segment, illegal characters, or a
        // *pattern* — a publisher names one topic, never a wildcard).
        for bad in ["amos//imu", "not a topic", "amos/*/sensor/imu", ""] {
            let hostile = WireHeader {
                topic: bad.to_string(),
                ..good.clone()
            };
            let err = Envelope::decode(&frame_of_wire_header(&hostile, &payload))
                .expect_err("an illegal topic must be refused");
            assert!(err.to_string().contains("topic"), "{bad:?} ⇒ {err}");
        }
    }

    #[test]
    fn a_header_this_side_would_refuse_is_never_put_on_the_wire() {
        // The other half of the same rule: "nothing arrives on the far side" is the worst way
        // to discover a bad header, exactly as the payload ceiling is checked before a frame
        // is built. Both fields here are reachable from safe Rust (they are `pub`), so this is
        // a local-bug guard, not an attack.
        let wire = envelope().encode().expect("encode");
        let mut env = Envelope::decode(&wire).expect("decode");

        env.header.topic = "amos//imu".to_string();
        assert!(matches!(env.encode(), Err(LinkError::Frame(_))));
        env.header.topic = "amos/dog1/sensor/stereo_left".to_string();
        assert!(env.encode().is_ok(), "the restored header encodes again");

        env.header.stamp = Timestamp {
            secs: 1,
            nanos: 2_000_000_000,
        };
        assert!(env.encode().is_err());
        env.header.stamp = Timestamp { secs: 1, nanos: 0 };
        assert!(env.encode().is_ok());
    }

    #[test]
    fn timestamps_validate_and_measure_age() {
        assert!(Timestamp::new(1, 999_999_999).is_ok());
        assert!(Timestamp::new(1, 1_000_000_000).is_err());
        let a = Timestamp::new(10, 0).unwrap();
        let b = Timestamp::new(11, 500_000_000).unwrap();
        assert_eq!(b.as_nanos() - a.as_nanos(), 1_500_000_000);
        assert_eq!(b.since(&a), Duration::from_millis(1500));
        // A backwards clock yields zero, never a wrapped huge age.
        assert_eq!(a.since(&b), Duration::ZERO);
        assert_eq!(a.unix_ms(), 10_000);
        assert_eq!(Timestamp::from_system_time(UNIX_EPOCH).unix_ms(), 0);
        assert_eq!(a.to_string(), "10.000000000");
        assert!(Timestamp::now().as_nanos() > 0);

        // A *well-formed* stamp is exactly a sub-second `nanos`; `new` and the wire check
        // (`is_valid`) must answer the same question.
        assert!(Timestamp::new(1, 999_999_999).expect("valid").is_valid());
        assert!(!Timestamp {
            secs: 0,
            nanos: 1_000_000_000
        }
        .is_valid());

        // …and here is *why* the boundary matters: for an out-of-range `nanos` the derived
        // `Ord` (which compares the fields) and the value (`as_nanos`, which `since` uses)
        // disagree about the same instant — two spellings of 2.5 s that sort the wrong way.
        let spelled_out = Timestamp {
            secs: 1,
            nanos: 1_500_000_000,
        };
        let carried = Timestamp {
            secs: 2,
            nanos: 500_000_000,
        };
        assert_eq!(spelled_out.as_nanos(), carried.as_nanos());
        assert!(
            spelled_out < carried,
            "the derived order compares fields, not the instant they denote"
        );
        assert!(!spelled_out.is_valid() && carried.is_valid());
        // The display helper is total either way (it saturates), which is why the value could
        // travel this far before anyone noticed it was not a timestamp.
        assert_eq!(spelled_out.to_string(), "1.1500000000");

        // A stamp is a *wire* value, so the rendering helpers must be total: an absurd
        // `secs` from a hostile header saturates instead of overflowing (a debug panic).
        let absurd = Timestamp {
            secs: u64::MAX,
            nanos: 999_999_999,
        };
        assert_eq!(absurd.unix_ms(), u64::MAX);
        assert!(absurd.since(&a) > Duration::from_secs(1));
        assert_eq!(a.since(&absurd), Duration::ZERO);
    }

    #[test]
    fn clock_reports_synced_only_after_calibration() {
        let clock = Clock::default();
        assert!(!clock.synced(), "a host clock starts unsynced");
        assert!(!clock.is_fresh(Duration::from_secs(60)));
        assert!(clock.now().as_nanos() > 0);
        // Calibrating with "now" is inside the plausibility window → accepted.
        clock.apply(SystemTime::now()).expect("apply now");
        assert!(clock.synced());
    }

    #[test]
    fn messages_round_trip_through_bincode() {
        let frame = DepthFrame {
            seq: 1,
            width: 640,
            height: 480,
            points: vec![-1, 0, 1],
        };
        let bytes = frame.encode().expect("encode");
        // Compact: 8 + 4 + 4 + 8 (len) + 3*2 bytes, no JSON punctuation.
        assert!(bytes.len() < 40, "got {} bytes", bytes.len());
        assert_eq!(DepthFrame::decode(&bytes).expect("decode"), frame);
        assert!(
            DepthFrame::decode(&[0xff, 0xff]).is_err(),
            "garbage refused"
        );
    }

    #[test]
    fn envelopes_round_trip_with_all_metadata() {
        let env = envelope();
        let wire = env.encode().expect("encode");
        assert_eq!(&wire[..4], &MAGIC);
        assert_eq!(wire[4], VERSION);
        let back = Envelope::decode(&wire).expect("decode");
        assert_eq!(back, env);
        assert_eq!(
            back.topic().expect("topic").as_str(),
            "amos/dog1/sensor/stereo_left"
        );
        assert_eq!(back.header.publisher.as_str(), "dog1");
        assert_eq!(back.header.seq, 7);
        assert_eq!(back.header.stamp.nanos, 123_456_789);
        assert_eq!(back.payload.len(), env.payload.len());
    }

    #[test]
    fn corrupt_or_truncated_frames_are_refused_with_a_reason() {
        let wire = envelope().encode().expect("encode");

        let mut bad_crc = wire.clone();
        let last = bad_crc.len() - 1;
        bad_crc[last] ^= 0xff;
        assert!(matches!(
            Envelope::decode(&bad_crc),
            Err(LinkError::Frame(_))
        ));

        let mut bad_magic = wire.clone();
        bad_magic[0] = b'X';
        assert!(Envelope::decode(&bad_magic).is_err());

        let mut bad_version = wire.clone();
        bad_version[4] = VERSION + 1;
        assert!(Envelope::decode(&bad_version).is_err());

        assert!(Envelope::decode(&wire[..6]).is_err(), "truncated prefix");
        assert!(
            Envelope::decode(&wire[..wire.len() - 2]).is_err(),
            "truncated body"
        );

        // A *consistent* lie about the payload length is caught by the length check.
        let mut env = envelope();
        env.header.payload_len = u32::try_from(env.payload.len()).unwrap();
        let mut liar = env.encode().expect("encode");
        liar.truncate(liar.len() - 1);
        assert!(Envelope::decode(&liar).is_err());

        // Encoding an envelope whose header disagrees with its payload is refused.
        let mut mismatched = envelope();
        mismatched.header.payload_len = 99;
        assert!(mismatched.encode().is_err());
    }
    #[test]
    fn oversized_frames_are_refused_on_both_sides() {
        // Producing one is refused...
        let mut big = envelope();
        big.payload = vec![0u8; MAX_PAYLOAD_BYTES + 1];
        big.header.payload_len = (MAX_PAYLOAD_BYTES + 1) as u32;
        let err = big
            .encode()
            .expect_err("oversized payload must not be encoded");
        assert!(matches!(err, LinkError::Frame(_)));

        // ...and an oversized *claim* is refused before any slicing or allocation: the
        // header length field is patched to a hostile value and the frame stays small.
        let mut wire = envelope().encode().expect("encode");
        wire[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(
            Envelope::decode(&wire).is_err(),
            "a forged header length must be refused"
        );

        // A frame larger than any legal frame is refused outright.
        let huge = vec![0u8; MAX_PAYLOAD_BYTES + MAX_HEADER_BYTES + 16];
        assert!(Envelope::decode(&huge).is_err());
    }

    /// A deterministic "does it panic?" sweep: 2 000 pseudo-random byte strings (plus
    /// the real frame with random single-byte mutations) must all come back as `Err`,
    /// never as a panic and never as a bogus `Ok`.
    ///
    /// Deliberately a small LCG instead of a fuzzing dependency: the point is to prove
    /// the *decoder* is total (no panic on hostile input), which is a property a fixed
    /// seed reproduces forever — a gate can therefore run it offline, today and in a
    /// year, with the same result.
    #[test]
    fn decoding_arbitrary_bytes_never_panics() {
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            (seed >> 33) as u32
        };

        let valid = envelope().encode().expect("encode");
        for _ in 0..2_000 {
            let len = (next() % 64) as usize;
            let bytes: Vec<u8> = (0..len).map(|_| (next() & 0xff) as u8).collect();
            // Either a clean refusal or a decoded frame — never a panic.
            if let Ok(decoded) = Envelope::decode(&bytes) {
                // If it *did* decode, it must at least round-trip consistently.
                assert_eq!(
                    decoded.encode().expect("re-encode").len(),
                    bytes.len(),
                    "a decoded frame must re-encode to the same length"
                );
            }
        }

        // Mutations of a real frame: one byte at a time, all four positions classes.
        for _ in 0..500 {
            let mut mutated = valid.clone();
            let index = (next() as usize) % mutated.len();
            mutated[index] ^= 1 << (next() % 8);
            let _ = Envelope::decode(&mutated);
        }
    }
}
