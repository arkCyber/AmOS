//! In-memory full-duplex end-to-end test for the cross-boundary clipboard sync
//! (P2a capstone / P3 precursor). Runs the **real host transport**
//! (`amos_tauri_lib::clipboard_guest`) and the **real guest agent**
//! (`amos_clipboard::agent::GuestAgent` over a `MockClipboardProvider`) in one
//! process, connected by in-memory byte wires, and verifies the whole link works:
//!
//! * host copy  ──► `PushText` frame ──► guest `ClipboardManager` applied (no loop);
//! * container copy ──► `ClipboardChanged` frame ──► host shared clipboard ingested;
//! * the host's `EchoGuard` drops a (would-be) echo of its own push.
//!
//! No Tauri app, no Waydroid, no GUI — the two halves are wired exactly as the
//! device channel would carry them, proving the single-source protocol
//! interoperates and the echo guard kills the copy loop end to end.

use std::sync::{Arc, Mutex};

use amos_clipboard::agent::GuestAgent;
use amos_clipboard::proto::{encode, EchoGuard, FrameDecoder, GuestToHost, HostToGuest};
use amos_clipboard::provider::{ClipboardProvider, MockClipboardProvider};
use amos_tauri_lib::clipboard::{ClipboardNative, GlobalClipboard};
use amos_tauri_lib::clipboard_guest::{handle_guest_msg, GuestSink};

/// An in-memory, append-only byte wire shared by two handles via `Arc<Mutex>`.
/// One side `Write`s / `send`s; the reader `take`s the accumulated bytes.
#[derive(Clone)]
struct Wire {
    buf: Arc<Mutex<Vec<u8>>>,
}

impl Wire {
    fn new() -> Self {
        Self {
            buf: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn send(&self, data: &[u8]) {
        self.buf.lock().unwrap().extend_from_slice(data);
    }
    fn take(&self) -> Vec<u8> {
        let mut b = self.buf.lock().unwrap();
        std::mem::take(&mut *b)
    }
    fn is_empty(&self) -> bool {
        self.buf.lock().unwrap().is_empty()
    }
}

impl std::io::Write for Wire {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.send(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// End-to-end rig: real host transport + real guest agent over two wires.
struct Rig {
    host_guard: Arc<Mutex<EchoGuard>>,
    /// Host ──► guest: host `GuestSink` writes `PushText` frames here.
    to_guest: Wire,
    /// Guest ──► host: guest agent's listener writes `ClipboardChanged` frames here.
    to_host: Wire,
    /// The host shared clipboard (what a Webview app pastes from).
    host_clip: GlobalClipboard,
    /// The guest's clipboard provider (drive "a copy in the container" via this).
    guest_clip: MockClipboardProvider,
    sink: GuestSink<Wire>,
    agent: GuestAgent<MockClipboardProvider>,
}

fn rig() -> Rig {
    let host_guard = Arc::new(Mutex::new(EchoGuard::new()));
    let to_guest = Wire::new();
    let to_host = Wire::new();

    // Host side: mirror AmOS copies out to the guest wire.
    let sink = GuestSink::over(to_guest.clone(), host_guard.clone());

    // Guest side: agent over a mock ClipboardManager.
    let guest_clip = MockClipboardProvider::new();
    let agent = GuestAgent::new(guest_clip.clone());
    let to_host_out = to_host.clone();
    agent
        .attach(move |m: GuestToHost| {
            let frame = encode(&m).expect("guest outbound frame encodes");
            to_host_out.send(&frame);
        })
        .expect("agent listener attaches");

    Rig {
        host_guard,
        to_guest,
        to_host,
        host_clip: GlobalClipboard::new(),
        guest_clip,
        sink,
        agent,
    }
}

impl Rig {
    /// Host copies `text` (like `clipboard_write`): stored + mirrored out.
    fn host_copy(&self, text: &str) {
        self.host_clip.write_plain("notes", "notes", text).unwrap();
        let entry = self.host_clip.latest().unwrap();
        self.sink.push_out(&entry).unwrap();
    }

    /// Deliver any pending `PushText` frames on the wire to the guest agent.
    fn deliver_to_guest(&self) -> usize {
        let bytes = self.to_guest.take();
        let mut dec = FrameDecoder::<HostToGuest>::new();
        let frames = dec.push(&bytes).expect("host->guest frames decode");
        frames
            .iter()
            .map(|f| self.agent.apply(f).expect("guest applies push"))
            .filter(|applied| *applied)
            .count()
    }

    /// Deliver any pending `ClipboardChanged` frames back into the host clipboard.
    fn deliver_to_host(&self) -> usize {
        let bytes = self.to_host.take();
        let mut dec = FrameDecoder::<GuestToHost>::new();
        let frames = dec.push(&bytes).expect("guest->host frames decode");
        let guard = self.host_guard.lock().unwrap();
        let mut ingested = 0usize;
        let mut ingest = |src: &str, text: &str| {
            assert_eq!(src, "android:container");
            self.host_clip
                .write_plain("android:container", "", text.to_string())
                .is_ok()
        };
        for msg in frames {
            if handle_guest_msg(&guard, msg, &mut ingest) {
                ingested += 1;
            }
        }
        ingested
    }
}

#[test]
fn host_copy_reaches_guest_clipboard_without_a_copy_loop() {
    let r = rig();
    r.host_copy("from-AI-notes");

    // Frame reached the guest agent and was applied to its ClipboardManager.
    assert_eq!(r.deliver_to_guest(), 1, "exactly one host copy applied");
    assert_eq!(
        r.guest_clip.text().as_deref(),
        Some("from-AI-notes"),
        "guest clipboard holds the host text"
    );
    // No echo: applying our own push must not generate an outbound frame.
    assert!(
        r.to_host.is_empty(),
        "guest must not echo the host's own push"
    );
}

#[test]
fn container_copy_flows_back_and_lands_in_host_clipboard() {
    let r = rig();
    // A real user copy inside the container (e.g. in WeChat).
    r.guest_clip.set_primary_text("copied-in-wechat").unwrap();

    // The agent's listener fired -> a ClipboardChanged frame sits on the wire.
    assert!(
        !r.to_host.is_empty(),
        "genuine copy must be reported to the host"
    );

    // Host ingests it into its shared clipboard for a foreground Webview app.
    assert_eq!(
        r.deliver_to_host(),
        1,
        "exactly one copy ingested by the host"
    );
    assert_eq!(
        r.host_clip.latest_text().as_deref(),
        Some("copied-in-wechat"),
        "host shared clipboard now holds the container copy"
    );
}

#[test]
fn host_guard_drops_a_would_be_echo_of_its_own_push() {
    let r = rig();
    r.host_copy("secret"); // arms the host EchoGuard with "secret"

    // Belt-and-suspenders: even if the guest echoed our own text back as a
    // ClipboardChanged, the host guard must NOT ingest it (no copy loop).
    let frame = GuestToHost::ClipboardChanged {
        ts_ms: 0,
        text: "secret".into(),
    };
    let bytes = encode(&frame).unwrap();
    r.to_host.send(&bytes);
    assert_eq!(
        r.deliver_to_host(),
        0,
        "the host must drop its own echo rather than re-ingest it"
    );
    // The echo must not have grown the history: only the original host copy exists.
    assert_eq!(
        r.host_clip.history(None).len(),
        1,
        "an echo must never add a second shared-clipboard entry"
    );
}

#[test]
fn two_way_round_trip_is_clean_and_lossless() {
    let r = rig();

    // Host → guest.
    r.host_copy("from-host-A");
    assert_eq!(r.deliver_to_guest(), 1);
    assert_eq!(r.guest_clip.text().as_deref(), Some("from-host-A"));

    // Guest → host (a real container copy after the host push).
    r.guest_clip.set_primary_text("from-guest-B").unwrap();
    assert_eq!(
        r.deliver_to_host(),
        1,
        "guest copy ingested, no echo counted"
    );

    // Both directions landed with no cross-contamination.
    assert_eq!(r.guest_clip.text().as_deref(), Some("from-guest-B"));
    assert_eq!(r.host_clip.latest_text().as_deref(), Some("from-guest-B"));
    assert!(
        r.to_host.is_empty(),
        "nothing left pending after both directions"
    );
    assert!(r.to_guest.is_empty());
}
