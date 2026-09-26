//! The **guest-side agent core** — the headless component that lives inside the
//! Android container and keeps the container's `ClipboardManager` in sync with the
//! host over the shared [`crate::proto`] wire contract (see
//! `docs/clipboard-container-sync.md` §4 / P1).
//!
//! Responsibilities, driven entirely through the [`ClipboardProvider`] seam so the
//! whole agent is headless-testable against [`MockClipboardProvider`]:
//!
//! * **Host ─► guest**: [`GuestAgent::apply`] takes an inbound
//!   [`HostToGuest::PushText`] and mirrors it onto the platform clipboard. It first
//!   records the text on the shared [`EchoGuard`] so the resulting change event is
//!   not mistaken for a user copy.
//! * **Guest ─► host**: [`GuestAgent::attach`] installs the provider's change
//!   listener; genuine container copies (a change that is *not* our own echo) are
//!   turned into a [`GuestToHost::ClipboardChanged`] and handed to the outbound
//!   callback (which a thin transport encodes + sends to the host). A push that
//!   [`GuestAgent::apply`] actually **applies** is confirmed on that same callback
//!   as [`GuestToHost::PushAcked`] — one guest→host channel, not two.
//!
//! The agent never talks bytes itself — it returns/consumes protocol messages, so
//! the framing and I/O stay in the embedding transport.

use std::sync::{Arc, Mutex};

use crate::proto::{now_ms, EchoGuard, GuestToHost, HostToGuest};
use crate::provider::ClipboardProvider;

/// Single source of the "is this inbound change our own echo?" decision, shared by
/// [`GuestAgent::should_report`] and the change listener [`GuestAgent::attach`]
/// installs. Fail-safe: on a poisoned guard, assume it *is* our own echo and
/// suppress — never fabricate a container copy.
fn is_own_echo(guard: &Mutex<EchoGuard>, text: &str) -> bool {
    guard
        .lock()
        .map(|g| g.is_self_echo_now(text))
        .unwrap_or(true)
}

/// The guest→host outbound channel: the one closure a transport hands over, shared
/// by the change listener ([`GuestToHost::ClipboardChanged`]) and the ack path
/// ([`GuestToHost::PushAcked`]).
type Outbound = Arc<dyn Fn(GuestToHost) + Send + Sync>;

/// The guest-side clipboard agent. Generic over the [`ClipboardProvider`] so it is
/// constructed with a [`MockClipboardProvider`] in tests/CI and an
/// `AndroidClipboardProvider` on-device.
pub struct GuestAgent<P: ClipboardProvider> {
    provider: P,
    /// Shared so both the apply path (records our own set) and the change listener
    /// (checks "is this our own echo?") see one consistent view.
    guard: Arc<Mutex<EchoGuard>>,
    /// The guest→host outbound channel, installed by [`Self::attach`]. `apply`'s
    /// `PushAcked` confirmation rides the same channel as the change reports — the
    /// guest has one wire to the host, not one per message kind. No channel
    /// installed ⇒ no ack is fabricated.
    outbound: Mutex<Option<Outbound>>,
}

impl<P: ClipboardProvider> GuestAgent<P> {
    /// Wrap a provider with a fresh echo guard.
    pub fn new(provider: P) -> Self {
        Self {
            provider,
            guard: Arc::new(Mutex::new(EchoGuard::new())),
            outbound: Mutex::new(None),
        }
    }

    /// Borrow the underlying provider (diagnostics / inspection).
    pub fn provider(&self) -> &P {
        &self.provider
    }

    /// Apply an inbound host [`HostToGuest::PushText`] to the platform clipboard.
    ///
    /// Returns `Ok(true)` when the clipboard was changed, `Ok(false)` when it was
    /// already equal (no-op, no re-fire) or the text was blank. Records the push on
    /// the echo guard *before* writing so the synchronous (and later async)
    /// listener does not report our own write back to the host as a user copy; if
    /// the write **fails**, the note is rolled back so a later genuine copy of the
    /// same text is not wrongly suppressed.
    ///
    /// A push that actually changed the clipboard is confirmed to the host with a
    /// [`GuestToHost::PushAcked`] carrying the push's `seq` ([`Self::ack`]). A
    /// no-op (already equal, blank) or a failed write is **not** acked: the ack
    /// claims the guest clipboard now holds the pushed text, and that claim may
    /// only be made when it is true.
    pub fn apply(&self, push: &HostToGuest) -> Result<bool, String> {
        let HostToGuest::PushText { seq, text, .. } = push;
        if text.trim().is_empty() {
            return Ok(false);
        }
        if self.provider.primary_text().as_deref() == Some(text.as_str()) {
            return Ok(false); // already present — nothing to change
        }
        let snap = self.guard.lock().map_err(|e| e.to_string())?.snap();
        {
            let mut g = self.guard.lock().map_err(|e| e.to_string())?;
            g.note_set_now(text);
        }
        match self.provider.set_primary_text(text) {
            Ok(()) => {
                self.ack(*seq);
                Ok(true)
            }
            Err(e) => {
                // Nothing was written, so no echo will arrive: undo the note so a
                // later *genuine* copy of this text isn't suppressed.
                if let Ok(mut g) = self.guard.lock() {
                    g.restore(snap);
                }
                Err(e)
            }
        }
    }

    /// Confirm to the host that the push with this `seq` was applied, on the
    /// outbound channel [`Self::attach`] installed. The channel is cloned out of the
    /// slot *before* it is called, so a callback that re-enters the agent cannot
    /// deadlock on the slot's lock. A poisoned slot drops the ack rather than
    /// panicking — an unconfirmed push is honest; a crash on the copy path is not.
    fn ack(&self, seq: u64) {
        let out = self.outbound.lock().ok().and_then(|slot| slot.clone());
        if let Some(out) = out {
            out(GuestToHost::PushAcked { seq });
        }
    }

    /// Whether an inbound platform change `text` should be reported to the host
    /// (i.e. it is **not** our own echo). See [`is_own_echo`] for the fail-safe.
    pub fn should_report(&self, text: &str) -> bool {
        !is_own_echo(&self.guard, text)
    }

    /// Install the provider's change listener so genuine container copies reach
    /// `out` as [`GuestToHost::ClipboardChanged`], **and** record `out` as the
    /// agent's outbound channel so an applied push reaches it as
    /// [`GuestToHost::PushAcked`]. Idempotent re-`attach` just replaces both.
    /// Echoes of our own [`Self::apply`] are suppressed.
    pub fn attach<F>(&self, out: F) -> Result<(), String>
    where
        F: Fn(GuestToHost) + Send + Sync + 'static,
    {
        let out: Outbound = Arc::new(out);
        if let Ok(mut slot) = self.outbound.lock() {
            *slot = Some(out.clone());
        }
        let guard = self.guard.clone();
        let listener = move |text: &str| {
            if !is_own_echo(&guard, text) {
                out(GuestToHost::ClipboardChanged {
                    ts_ms: now_ms(),
                    text: text.to_string(),
                });
            }
        };
        self.provider.set_change_listener(Some(Arc::new(listener)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MockClipboardProvider;

    /// Collects outbound messages so tests can assert what would be sent to host.
    fn collector() -> (
        Arc<Mutex<Vec<GuestToHost>>>,
        impl Fn(GuestToHost) + Send + Sync + 'static,
    ) {
        let store: Arc<Mutex<Vec<GuestToHost>>> = Arc::new(Mutex::new(Vec::new()));
        let out = {
            let store = store.clone();
            move |m: GuestToHost| store.lock().unwrap().push(m)
        };
        (store, out)
    }

    fn push_text(text: &str) -> HostToGuest {
        HostToGuest::PushText {
            seq: 1,
            ts_ms: 0,
            text: text.to_string(),
        }
    }

    #[test]
    fn apply_mirrors_push_onto_clipboard() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        assert!(agent.apply(&push_text("from-host")).unwrap());
        assert_eq!(mock.text().as_deref(), Some("from-host"));
    }

    #[test]
    fn apply_is_a_no_op_when_text_already_equal() {
        let mock = MockClipboardProvider::new();
        mock.set_primary_text("already").unwrap();
        let agent = GuestAgent::new(mock.clone());
        assert!(
            !agent.apply(&push_text("already")).unwrap(),
            "no change needed"
        );
        assert_eq!(mock.set_calls(), 1, "must not re-set an identical value");
    }

    #[test]
    fn apply_rejects_blank_text_without_change() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        assert!(!agent.apply(&push_text("   ")).unwrap());
        assert_eq!(mock.primary_text(), None);
    }

    #[test]
    fn own_push_is_not_reported_back_as_a_copy() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        let (store, out) = collector();
        agent.attach(out).unwrap();

        // Host push -> agent applies -> provider fires listener synchronously.
        agent.apply(&push_text("from-host")).unwrap();
        let msgs = store.lock().unwrap();
        assert!(
            !msgs
                .iter()
                .any(|m| matches!(m, GuestToHost::ClipboardChanged { .. })),
            "the echo of our own apply must not be reported to the host as a copy"
        );
    }

    /// The outbound channel **is** the guest→host wire: an applied push must be
    /// confirmed with its own `seq`, so the host can tell "the guest applied this"
    /// apart from "we sent it and heard nothing".
    #[test]
    fn an_applied_push_is_acked_on_the_outbound_channel() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        let (store, out) = collector();
        agent.attach(out).unwrap();

        let push = HostToGuest::PushText {
            seq: 7,
            ts_ms: 0,
            text: "from-host".into(),
        };
        assert!(agent.apply(&push).unwrap());
        assert_eq!(
            *store.lock().unwrap(),
            vec![GuestToHost::PushAcked { seq: 7 }],
            "an applied push is acked exactly once, carrying the push's own seq"
        );
    }

    /// A push the guest did **not** apply must not be acked: an ack states that the
    /// guest clipboard now holds the pushed text.
    #[test]
    fn a_push_the_guest_did_not_apply_is_not_acked() {
        let mock = MockClipboardProvider::new();
        mock.set_primary_text("already").unwrap(); // -> the push is a no-op
        let agent = GuestAgent::new(mock.clone());
        let (store, out) = collector();
        agent.attach(out).unwrap();

        assert!(!agent.apply(&push_text("already")).unwrap());
        assert!(!agent.apply(&push_text("   ")).unwrap()); // blank: never applied
        assert!(
            store.lock().unwrap().is_empty(),
            "an ack would claim an application that never happened"
        );
    }

    #[test]
    fn a_failed_push_is_not_acked() {
        let agent = GuestAgent::new(RejectingClipboard);
        let (store, out) = collector();
        agent.attach(out).unwrap();
        assert!(agent.apply(&push_text("boom")).is_err());
        assert!(
            store.lock().unwrap().is_empty(),
            "nothing was written, so nothing may be acked"
        );
    }

    /// Honest boundary: with no outbound channel installed there is nowhere to send
    /// an ack — `apply` must still work (and must not panic).
    #[test]
    fn apply_without_an_outbound_channel_still_works() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        assert!(agent.apply(&push_text("from-host")).unwrap());
        assert_eq!(mock.text().as_deref(), Some("from-host"));
    }

    #[test]
    fn genuine_guest_copy_is_reported_as_clipboard_changed() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        let (store, out) = collector();
        agent.attach(out).unwrap();

        // A user copy inside the container (not caused by the agent).
        mock.set_primary_text("copied-in-wechat").unwrap();
        let msgs = store.lock().unwrap();
        assert_eq!(msgs.len(), 1);
        match &msgs[0] {
            GuestToHost::ClipboardChanged { text, .. } => {
                assert_eq!(text, "copied-in-wechat");
            }
            other => panic!("expected ClipboardChanged, got {other:?}"),
        }
    }

    #[test]
    fn host_then_guest_sequence_is_clean() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        let (store, out) = collector();
        agent.attach(out).unwrap();

        // Host push "A" (no copy report), then a user copy "B" (reported).
        agent.apply(&push_text("A")).unwrap();
        mock.set_primary_text("B").unwrap();
        let msgs = store.lock().unwrap();
        let copies: Vec<&GuestToHost> = msgs
            .iter()
            .filter(|m| matches!(m, GuestToHost::ClipboardChanged { .. }))
            .collect();
        assert_eq!(copies.len(), 1, "only the genuine copy is reported");
        match copies[0] {
            GuestToHost::ClipboardChanged { text, .. } => assert_eq!(text, "B"),
            _ => panic!("expected ClipboardChanged"),
        }
    }

    #[test]
    fn apply_after_a_real_user_copy_of_same_text_does_not_echo() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        let (store, out) = collector();
        agent.attach(out).unwrap();

        // A user first copies "hello" (reported), then the host pushes the same
        // text — a no-op apply must not produce a duplicate report.
        mock.set_primary_text("hello").unwrap();
        agent.apply(&push_text("hello")).unwrap(); // equal -> no-op
        let msgs = store.lock().unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn should_report_is_true_only_for_non_echo_changes() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        assert!(agent.should_report("anything"), "no prior set -> report");
        agent.apply(&push_text("mine")).unwrap();
        assert!(!agent.should_report("mine"), "own echo suppressed");
        assert!(agent.should_report("other"), "different text reported");
    }

    /// A provider whose writes always fail (exercises `apply`'s error path).
    struct RejectingClipboard;

    impl ClipboardProvider for RejectingClipboard {
        fn name(&self) -> &'static str {
            "rejecting"
        }
        fn primary_text(&self) -> Option<String> {
            None
        }
        fn set_primary_text(&self, _text: &str) -> Result<(), String> {
            Err("no writable clipboard".to_string())
        }
        fn set_change_listener(
            &self,
            _listener: Option<crate::provider::ChangeSink>,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn failed_apply_propagates_the_error() {
        let agent = GuestAgent::new(RejectingClipboard);
        assert!(agent.apply(&push_text("boom")).is_err());
    }

    #[test]
    fn failed_apply_does_not_leave_a_stale_echo_note() {
        let agent = GuestAgent::new(RejectingClipboard);
        assert!(agent.apply(&push_text("secret")).is_err());
        // Nothing was written, so no echo will arrive: a later *genuine* copy of
        // the same text must still be reported (not suppressed by a stale note).
        assert!(
            agent.should_report("secret"),
            "no stale echo note may survive a failed apply"
        );
    }

    #[test]
    fn successful_apply_arms_the_echo_note() {
        let mock = MockClipboardProvider::new();
        let agent = GuestAgent::new(mock.clone());
        agent.apply(&push_text("armed")).unwrap();
        assert!(
            !agent.should_report("armed"),
            "successful apply arms the guard"
        );
    }
}
