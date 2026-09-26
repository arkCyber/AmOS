//! Provider seams and a deterministic mock.
//!
//! The [`TelephonyProvider`] is the single point where the domain core talks to
//! a real telephony stack. The emergency path is a **separate** trait
//! ([`EmergencyTelephonyProvider`]) so ordinary dial logic can never intercept an
//! emergency call (see `docs/telephony.md` §5). For P0 we ship a deterministic
//! in-memory [`MockTelephonyProvider`]; the Android/Binder backend is gated
//! behind the `android` feature and a `#[cfg(target_os)]`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use tokio::sync::{mpsc, Mutex};

use crate::error::{Result, TelephonyError};
use crate::number::{EmergencyMap, Number};
use crate::route::{guard_emergency, guard_regular};
use crate::session::{
    Call, CallDirection, CallId, CallSession, CallState, EndReason, RecordingState,
};

/// Signalling events a provider pushes to subscribers (the daemon drives its
/// `CallSession`s from these). Carries just enough to build a wire snapshot
/// without a state round-trip.
///
/// Every variant that carries a call also carries `emergency`: the flag is a
/// property of the call the *provider* holds, so an event converted to a wire
/// snapshot must report the call's real value. A constant `emergency: false`
/// here made every streamed snapshot lie about an emergency call (the
/// `status()` snapshot, which reads the model, told the truth — the two paths
/// disagreed). Rides along for the same reason `muted` does on
/// [`Self::RecordingChanged`]: an event is applied **as** the snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderEvent {
    /// A new incoming call is ringing. Direction is implied (there is no other kind of
    /// ringing call), so it is not carried.
    Incoming {
        id: CallId,
        peer: Number,
        emergency: bool,
    },
    /// The far side picked up / an outgoing call connected (or an incoming call was
    /// answered — the same Ringing → Active edge both ways). Carries `direction` so a
    /// `Watch` subscriber cannot mistake an answered incoming call for an outgoing one
    /// and drop it: the incoming overlay's guard is `direction !== "Incoming"`.
    Connected {
        id: CallId,
        peer: Number,
        direction: CallDirection,
        emergency: bool,
    },
    /// The remote party hung up. Carries the peer + direction as a final snapshot, the
    /// same way [`Self::RecordingChanged`] does: the *ended* edge is what a subscriber
    /// uses to write a call-log row (keyed on the peer) and to dismiss the surface, and
    /// the call is already gone from `status()` by the time it arrives.
    RemoteEnded {
        id: CallId,
        peer: Number,
        direction: CallDirection,
        emergency: bool,
    },
    /// The local user hung up / rejected a call. Same enrichment as
    /// [`Self::RemoteEnded`] (the reason differs, not the shape).
    LocalEnded {
        id: CallId,
        peer: Number,
        direction: CallDirection,
        emergency: bool,
    },
    /// The call failed (network / no answer). Same enrichment as
    /// [`Self::RemoteEnded`].
    Failed {
        id: CallId,
        peer: Number,
        direction: CallDirection,
        emergency: bool,
    },
    /// Recording on a live call changed (started / stopped / failed). Carries enough
    /// snapshot fields (peer + state + new recording state) for a Watch subscriber to
    /// rebuild the call without a state round-trip — recording is a first-class,
    /// broadcast call-state, not just a private RPC response.
    ///
    /// `muted` rides along because a subscriber applies these events **as a
    /// snapshot**: a call has two independent mutable flags now, so an event carrying
    /// only one of them would silently clear the other on every recording change.
    RecordingChanged {
        id: CallId,
        peer: Number,
        state: CallState,
        direction: CallDirection,
        recording: RecordingState,
        muted: bool,
        emergency: bool,
    },
    /// The call's mute flag changed. Same shape as [`Self::RecordingChanged`] (and
    /// carrying `recording` for the same reason): mute is a first-class, broadcast
    /// call-state, so every `Watch` subscriber (the lock screen, a future
    /// incoming-call overlay, the AI assistant) learns it without a state round-trip.
    MutedChanged {
        id: CallId,
        peer: Number,
        state: CallState,
        direction: CallDirection,
        muted: bool,
        recording: RecordingState,
        emergency: bool,
    },
}

/// Regular (SIM/telecom) call signalling. Only *regular* numbers may go through
/// here — an emergency number is rejected so it is forced onto the emergency path.
#[async_trait]
pub trait TelephonyProvider: Send + Sync {
    /// Place an outgoing regular call; returns the provider-scoped id.
    async fn dial(&self, number: &Number) -> Result<CallId>;

    /// Answer an incoming call.
    async fn answer(&self, id: &CallId) -> Result<()>;

    /// End (hang up / reject) a call.
    async fn end(&self, id: &CallId) -> Result<()>;

    /// Start recording a live call. The provider decides (grants) based on its own
    /// policy (consent/jurisdiction); a refusal is returned without touching the
    /// call, and the domain additionally refuses non-active / emergency / already-on
    /// calls before the provider is consulted.
    async fn start_recording(&self, id: &CallId) -> Result<()>;

    /// Stop recording a live call (no-op refusal when it is not recording).
    async fn stop_recording(&self, id: &CallId) -> Result<()>;

    /// Set whether the call's outbound audio is muted. Refused when the call is not
    /// live (there is no microphone to mute on a call that is over). Idempotent, and
    /// — unlike recording — legal on an emergency call.
    async fn set_muted(&self, id: &CallId, muted: bool) -> Result<()>;

    /// Current live calls (dialling/ringing/active).
    async fn status(&self) -> Result<Vec<Call>>;

    /// Subscribe to signalling events.
    fn subscribe(&self) -> mpsc::UnboundedReceiver<ProviderEvent>;
}

/// Privileged emergency hard path (110/112/911/999): no SIM needed, must not be
/// intercepted by rate limiting, and is audited separately. Kept apart from
/// [`TelephonyProvider`] by design.
#[async_trait]
pub trait EmergencyTelephonyProvider: Send + Sync {
    /// Place an emergency call; returns the provider-scoped id.
    async fn emergency_call(&self, number: Number) -> Result<CallId>;
}

/// Live call bookkeeping (guarded by the async lock).
struct ProviderState {
    calls: HashMap<CallId, CallSession>,
    next: u64,
}

/// Deterministic, in-memory [`TelephonyProvider`] for tests and offline demos.
///
/// Real "the network answered" transitions are driven by the `simulate_*`
/// helpers (what a device would report through a binder callback), so call flows
/// can be scripted deterministically. Subscribers live behind a plain
/// [`StdMutex`] so [`TelephonyProvider::subscribe`] needs no async lock.
pub struct MockTelephonyProvider {
    inner: Arc<Mutex<ProviderState>>,
    subscribers: Arc<StdMutex<Vec<mpsc::UnboundedSender<ProviderEvent>>>>,
    emergency: EmergencyMap,
    /// Recording policy knob (simulates the consent/jurisdiction gate a real
    /// provider enforces). Off by default `true`; when set `false` every
    /// `start_recording` is refused at the provider layer (audited separately).
    recording_allowed: Arc<AtomicBool>,
}

impl MockTelephonyProvider {
    /// Create with a specific emergency map.
    pub fn new(emergency: EmergencyMap) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ProviderState {
                calls: HashMap::new(),
                next: 0,
            })),
            subscribers: Arc::new(StdMutex::new(Vec::new())),
            emergency,
            recording_allowed: Arc::new(AtomicBool::new(true)),
        }
    }

    /// Create with the shared global emergency set (110/112/…/999).
    pub fn with_common_emergency() -> Self {
        Self::new(EmergencyMap::common_global())
    }

    /// Toggle the recording policy gate. `false` makes every `start_recording`
    /// fail with a provider-level refusal (tests the denied/audit path).
    pub fn set_recording_allowed(&self, allowed: bool) {
        self.recording_allowed.store(allowed, Ordering::Relaxed);
    }

    fn recording_granted(&self) -> bool {
        self.recording_allowed.load(Ordering::Relaxed)
    }

    fn next_id(state: &mut ProviderState) -> CallId {
        state.next += 1;
        CallId::new(format!("mock-call-{}", state.next))
    }

    fn broadcast(&self, evt: ProviderEvent) {
        let mut subs = match self.subscribers.lock() {
            Ok(g) => g,
            // A poisoned lock still exposes its inner senders; keep broadcasting.
            Err(p) => p.into_inner(),
        };
        subs.retain(|tx| tx.send(evt.clone()).is_ok());
    }

    /// Broadcast a recording-state change for a call from its current snapshot so
    /// every `Watch` subscriber learns the new recording flag.
    fn broadcast_recording(&self, snap: &Call) {
        self.broadcast(ProviderEvent::RecordingChanged {
            id: snap.id.clone(),
            peer: snap.peer.clone(),
            state: snap.state,
            direction: snap.direction,
            recording: snap.recording,
            muted: snap.muted,
            emergency: snap.emergency,
        });
    }

    /// Broadcast a mute-state change for a call from its current snapshot so every
    /// `Watch` subscriber learns the new mute flag (and re-reads the current recording
    /// flag, so applying the event cannot clear an in-progress recording).
    fn broadcast_muted(&self, snap: &Call) {
        self.broadcast(ProviderEvent::MutedChanged {
            id: snap.id.clone(),
            peer: snap.peer.clone(),
            state: snap.state,
            direction: snap.direction,
            muted: snap.muted,
            recording: snap.recording,
            emergency: snap.emergency,
        });
    }

    /// Simulate a ringing incoming call arriving from the network.
    pub async fn simulate_incoming(&self, peer: Number) -> CallId {
        let (id, emergency) = {
            let mut st = self.inner.lock().await;
            let id = Self::next_id(&mut st);
            let sess = CallSession::start_incoming(id.clone(), peer.clone());
            let emergency = sess.snapshot().emergency;
            st.calls.insert(id.clone(), sess);
            (id, emergency)
        };
        self.broadcast(ProviderEvent::Incoming {
            id: id.clone(),
            peer,
            emergency,
        });
        id
    }

    /// Simulate "the far side connected" for an outgoing call.
    pub async fn simulate_connected(&self, id: &CallId) -> Result<()> {
        let (peer, direction, emergency) = {
            let mut st = self.inner.lock().await;
            let sess = st
                .calls
                .get_mut(id)
                .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
            let snap = sess.snapshot();
            sess.connect()?;
            (snap.peer, snap.direction, snap.emergency)
        };
        self.broadcast(ProviderEvent::Connected {
            id: id.clone(),
            peer,
            direction,
            emergency,
        });
        Ok(())
    }

    /// Simulate the remote party hanging up.
    pub async fn simulate_remote_ended(&self, id: &CallId) -> Result<()> {
        let (peer, direction, emergency) = {
            let mut st = self.inner.lock().await;
            let snap = {
                let sess = st
                    .calls
                    .get_mut(id)
                    .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
                let snap = sess.snapshot();
                sess.end(EndReason::Remote)?;
                snap
            };
            st.calls.remove(id);
            (snap.peer, snap.direction, snap.emergency)
        };
        self.broadcast(ProviderEvent::RemoteEnded {
            id: id.clone(),
            peer,
            direction,
            emergency,
        });
        Ok(())
    }

    /// Simulate the device audio backend reporting a failure *while* recording, so
    /// the call lands in [`RecordingState::Failed`] (what a real provider surfaces
    /// through a binder callback). No-op error if the call isn't currently `On`.
    pub async fn simulate_recording_failure(&self, id: &CallId) -> Result<()> {
        let snap = {
            let mut st = self.inner.lock().await;
            let sess = st
                .calls
                .get_mut(id)
                .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
            sess.recording_failed()?;
            sess.snapshot()
        };
        self.broadcast_recording(&snap);
        Ok(())
    }
}

#[async_trait]
impl TelephonyProvider for MockTelephonyProvider {
    async fn dial(&self, number: &Number) -> Result<CallId> {
        // Enforce the hard separation (shared with the on-device Android provider):
        // a recognized emergency number must use the emergency path, never the
        // ordinary SIM/telecom dial.
        guard_regular(&self.emergency, number)?;
        let mut st = self.inner.lock().await;
        let id = Self::next_id(&mut st);
        let sess = CallSession::start_outgoing(id.clone(), number.clone(), false);
        st.calls.insert(id.clone(), sess);
        Ok(id)
    }

    async fn answer(&self, id: &CallId) -> Result<()> {
        let (peer, direction, emergency) = {
            let mut st = self.inner.lock().await;
            let sess = st
                .calls
                .get_mut(id)
                .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
            let snap = sess.snapshot();
            sess.answer()?;
            (snap.peer, snap.direction, snap.emergency)
        };
        // Answering is the incoming analogue of `simulate_connected`: the call goes
        // Ringing → Active, so every Watch subscriber must observe it (the UI turns
        // the incoming surface into an active/recordable call from this event). The
        // direction rides along so that subscriber can tell it is an incoming call —
        // it drops events tagged Outgoing.
        self.broadcast(ProviderEvent::Connected {
            id: id.clone(),
            peer,
            direction,
            emergency,
        });
        Ok(())
    }

    async fn end(&self, id: &CallId) -> Result<()> {
        let (peer, direction, emergency) = {
            let mut st = self.inner.lock().await;
            let snap = {
                let sess = st
                    .calls
                    .get_mut(id)
                    .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
                let snap = sess.snapshot();
                sess.end(EndReason::Local)?;
                snap
            };
            st.calls.remove(id);
            (snap.peer, snap.direction, snap.emergency)
        };
        // Local hang-up is a state change every Watch subscriber must observe
        // (symmetric with `answer` → `Connected` and `simulate_remote_ended`).
        self.broadcast(ProviderEvent::LocalEnded {
            id: id.clone(),
            peer,
            direction,
            emergency,
        });
        Ok(())
    }

    async fn start_recording(&self, id: &CallId) -> Result<()> {
        // Provider policy gate first: when recording is denied here the refusal is
        // returned *without* touching the call (so it never looks recorded).
        if !self.recording_granted() {
            return Err(TelephonyError::Provider(
                "recording refused by provider policy (consent/jurisdiction)".into(),
            ));
        }
        let snap = {
            let mut st = self.inner.lock().await;
            let sess = st
                .calls
                .get_mut(id)
                .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
            sess.start_recording()?;
            sess.snapshot()
        };
        self.broadcast_recording(&snap);
        Ok(())
    }

    async fn stop_recording(&self, id: &CallId) -> Result<()> {
        let snap = {
            let mut st = self.inner.lock().await;
            let sess = st
                .calls
                .get_mut(id)
                .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
            sess.stop_recording()?;
            sess.snapshot()
        };
        self.broadcast_recording(&snap);
        Ok(())
    }

    async fn set_muted(&self, id: &CallId, muted: bool) -> Result<()> {
        let snap = {
            let mut st = self.inner.lock().await;
            let sess = st
                .calls
                .get_mut(id)
                .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
            sess.set_muted(muted)?;
            sess.snapshot()
        };
        self.broadcast_muted(&snap);
        Ok(())
    }

    async fn status(&self) -> Result<Vec<Call>> {
        let st = self.inner.lock().await;
        Ok(st.calls.values().map(|s| s.snapshot()).collect())
    }

    fn subscribe(&self) -> mpsc::UnboundedReceiver<ProviderEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut subs = match self.subscribers.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        subs.push(tx);
        rx
    }
}

#[async_trait]
impl EmergencyTelephonyProvider for MockTelephonyProvider {
    async fn emergency_call(&self, number: Number) -> Result<CallId> {
        // Only a recognized emergency code may use the privileged path.
        guard_emergency(&self.emergency, &number)?;
        let mut st = self.inner.lock().await;
        let id = Self::next_id(&mut st);
        let sess = CallSession::start_outgoing(id.clone(), number, true);
        st.calls.insert(id.clone(), sess);
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regular() -> Number {
        Number::new("13800138000").unwrap()
    }

    #[tokio::test]
    async fn regular_dial_then_connect_then_end() {
        let p = MockTelephonyProvider::with_common_emergency();
        let id = p.dial(&regular()).await.unwrap();
        let status = p.status().await.unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].state, crate::session::CallState::Dialing);
        assert!(!status[0].emergency);

        p.simulate_connected(&id).await.unwrap();
        let status = p.status().await.unwrap();
        assert_eq!(status[0].state, crate::session::CallState::Active);

        p.end(&id).await.unwrap();
        assert!(
            p.status().await.unwrap().is_empty(),
            "ended call is released"
        );
    }

    #[tokio::test]
    async fn emergency_only_via_separate_provider() {
        let p = MockTelephonyProvider::with_common_emergency();
        let e = Number::new("112").unwrap();

        // Ordinary dial refuses an emergency number (separation enforced).
        assert!(matches!(
            p.dial(&e).await,
            Err(TelephonyError::MustUseEmergencyPath(_))
        ));

        // The emergency path places it and marks it emergency.
        let id = p.emergency_call(e).await.unwrap();
        let status = p.status().await.unwrap();
        assert_eq!(status.len(), 1);
        assert!(status[0].emergency);
        assert_eq!(status[0].id, id);
    }

    #[tokio::test]
    async fn incoming_answer_flow_through_provider() {
        let p = MockTelephonyProvider::with_common_emergency();
        let id = p
            .simulate_incoming(Number::new("02112345678").unwrap())
            .await;
        let status = p.status().await.unwrap();
        assert_eq!(status[0].state, crate::session::CallState::Ringing);
        assert_eq!(status[0].direction, crate::session::CallDirection::Incoming);

        p.answer(&id).await.unwrap();
        let status = p.status().await.unwrap();
        assert_eq!(status[0].state, crate::session::CallState::Active);
    }

    #[tokio::test]
    async fn unknown_call_operations_fail() {
        let p = MockTelephonyProvider::with_common_emergency();
        let ghost = CallId::new("nope");
        assert!(matches!(
            p.answer(&ghost).await,
            Err(TelephonyError::UnknownCall(_))
        ));
        assert!(matches!(
            p.end(&ghost).await,
            Err(TelephonyError::UnknownCall(_))
        ));
    }

    #[tokio::test]
    async fn subscriber_receives_connected_event() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let id = p.dial(&regular()).await.unwrap();
        p.simulate_connected(&id).await.unwrap();
        let evt = rx.recv().await;
        assert!(
            matches!(evt, Some(ProviderEvent::Connected { id: ref cid, .. }) if *cid == id),
            "connected event carries the call id"
        );
    }

    #[tokio::test]
    async fn simulate_incoming_broadcasts_incoming_event() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let peer = Number::new("02112345678").unwrap();
        let id = p.simulate_incoming(peer.clone()).await;
        let evt = rx.recv().await;
        assert_eq!(
            evt,
            Some(ProviderEvent::Incoming {
                id,
                peer,
                emergency: false,
            }),
            "incoming simulation reports a ringing call with its peer"
        );
    }

    async fn connect_regular(p: &MockTelephonyProvider) -> crate::session::CallId {
        let id = p.dial(&regular()).await.unwrap();
        p.simulate_connected(&id).await.unwrap();
        id
    }

    #[tokio::test]
    async fn recording_refused_until_call_is_active() {
        let p = MockTelephonyProvider::with_common_emergency();
        let id = p.dial(&regular()).await.unwrap(); // Dialing
        assert!(matches!(
            p.start_recording(&id).await,
            Err(TelephonyError::IllegalState { .. })
        ));
    }

    #[tokio::test]
    async fn start_stop_recording_flow_reflected_in_status() {
        let p = MockTelephonyProvider::with_common_emergency();
        let id = connect_regular(&p).await;

        p.start_recording(&id).await.unwrap();
        let status = p.status().await.unwrap();
        assert_eq!(
            status[0].recording,
            crate::session::RecordingState::On,
            "status carries the on-recording flag"
        );

        p.stop_recording(&id).await.unwrap();
        let status = p.status().await.unwrap();
        assert_eq!(status[0].recording, crate::session::RecordingState::Off);
    }

    #[tokio::test]
    async fn recording_policy_denial_leaves_call_unrecorded() {
        let p = MockTelephonyProvider::with_common_emergency();
        let id = connect_regular(&p).await;
        p.set_recording_allowed(false);

        let err = p.start_recording(&id).await.unwrap_err();
        assert!(matches!(err, TelephonyError::Provider(_)));

        let status = p.status().await.unwrap();
        assert_eq!(
            status[0].recording,
            crate::session::RecordingState::Off,
            "a provider-level refusal must not make the call look recorded"
        );
    }

    #[tokio::test]
    async fn emergency_call_recording_is_forbidden_at_provider() {
        let p = MockTelephonyProvider::with_common_emergency();
        let id = p.emergency_call(Number::new("110").unwrap()).await.unwrap();
        p.simulate_connected(&id).await.unwrap(); // Active, but emergency
        let err = p.start_recording(&id).await.unwrap_err();
        assert_eq!(
            err,
            TelephonyError::RecordingForbidden("emergency calls must never be recorded")
        );
    }

    #[tokio::test]
    async fn simulate_recording_failure_lands_call_in_failed() {
        let p = MockTelephonyProvider::with_common_emergency();
        let id = connect_regular(&p).await;
        p.start_recording(&id).await.unwrap();
        p.simulate_recording_failure(&id).await.unwrap();

        let status = p.status().await.unwrap();
        assert_eq!(status[0].recording, crate::session::RecordingState::Failed);

        // A recording that failed can be retried from the start.
        p.start_recording(&id).await.unwrap();
        let status = p.status().await.unwrap();
        assert_eq!(status[0].recording, crate::session::RecordingState::On);
    }

    #[tokio::test]
    async fn answering_an_incoming_call_broadcasts_connected() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let peer = Number::new("02112345678").unwrap();
        let id = p.simulate_incoming(peer.clone()).await;
        assert!(
            matches!(rx.recv().await, Some(ProviderEvent::Incoming { .. })),
            "the ringing event arrives first"
        );

        // Answering must surface the Ringing → Active transition to Watch
        // subscribers (like `simulate_connected` does for outgoing calls) — and it
        // must keep the call's true direction, or a subscriber that filters on
        // `direction == Incoming` never sees the answer.
        p.answer(&id).await.unwrap();
        let evt = rx.recv().await;
        assert_eq!(
            evt,
            Some(ProviderEvent::Connected {
                id: id.clone(),
                peer,
                direction: CallDirection::Incoming,
                emergency: false,
            }),
            "answer broadcasts the Active/Connected transition, still Incoming"
        );

        let status = p.status().await.unwrap();
        assert_eq!(status[0].state, crate::session::CallState::Active);
        assert!(
            p.start_recording(&id).await.is_ok(),
            "an answered call is Active, so it is recordable"
        );
    }

    #[tokio::test]
    async fn recording_changes_are_broadcast_to_subscribers() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let id = connect_regular(&p).await;
        // connect_regular emits a Connected event; drain it first.
        assert!(matches!(
            rx.recv().await,
            Some(ProviderEvent::Connected { .. })
        ));

        p.start_recording(&id).await.unwrap();
        let evt = rx.recv().await;
        assert!(
            matches!(
                evt,
                Some(ProviderEvent::RecordingChanged {
                    id: ref cid,
                    recording: RecordingState::On,
                    ..
                }) if *cid == id
            ),
            "starting recording broadcasts a RecordingChanged(On)"
        );

        p.stop_recording(&id).await.unwrap();
        let evt = rx.recv().await;
        assert!(
            matches!(
                evt,
                Some(ProviderEvent::RecordingChanged {
                    recording: RecordingState::Off,
                    ..
                })
            ),
            "stopping recording broadcasts a RecordingChanged(Off)"
        );
    }

    #[tokio::test]
    async fn recording_broadcast_preserves_incoming_direction() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let peer = Number::new("02112345678").unwrap();
        let id = p.simulate_incoming(peer).await;
        assert!(matches!(
            rx.recv().await,
            Some(ProviderEvent::Incoming { .. })
        ));

        // Answering an incoming call is Ringing → Active; recording then a change
        // must stay attributed as Incoming (not silently re-tagged Outgoing).
        p.answer(&id).await.unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(ProviderEvent::Connected { .. })
        ));

        p.start_recording(&id).await.unwrap();
        let evt = rx.recv().await;
        assert!(
            matches!(
                evt,
                Some(ProviderEvent::RecordingChanged {
                    id: ref cid,
                    direction: CallDirection::Incoming,
                    recording: RecordingState::On,
                    ..
                }) if *cid == id
            ),
            "recording broadcast keeps the true (Incoming) direction"
        );
    }

    #[tokio::test]
    async fn mute_flow_is_reflected_in_status() {
        let p = MockTelephonyProvider::with_common_emergency();
        let id = connect_regular(&p).await;

        assert!(
            !p.status().await.unwrap()[0].muted,
            "a live call starts unmuted"
        );

        p.set_muted(&id, true).await.unwrap();
        assert!(
            p.status().await.unwrap()[0].muted,
            "status carries the muted flag"
        );

        p.set_muted(&id, false).await.unwrap();
        assert!(!p.status().await.unwrap()[0].muted);
    }

    #[tokio::test]
    async fn mute_on_unknown_call_is_refused() {
        let p = MockTelephonyProvider::with_common_emergency();
        assert!(matches!(
            p.set_muted(&CallId::new("nope"), true).await,
            Err(TelephonyError::UnknownCall(_))
        ));
    }

    #[tokio::test]
    async fn mute_change_is_broadcast_to_subscribers() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let id = connect_regular(&p).await;
        // connect_regular emits a Connected event; drain it first.
        assert!(matches!(
            rx.recv().await,
            Some(ProviderEvent::Connected { .. })
        ));

        p.set_muted(&id, true).await.unwrap();
        let evt = rx.recv().await;
        assert_eq!(
            evt,
            Some(ProviderEvent::MutedChanged {
                id: id.clone(),
                peer: regular(),
                state: crate::session::CallState::Active,
                direction: crate::session::CallDirection::Outgoing,
                muted: true,
                recording: RecordingState::Off,
                emergency: false,
            }),
            "muting broadcasts a MutedChanged(true) carrying the call's snapshot fields"
        );

        p.set_muted(&id, false).await.unwrap();
        assert!(
            matches!(
                rx.recv().await,
                Some(ProviderEvent::MutedChanged { muted: false, .. })
            ),
            "unmuting broadcasts a MutedChanged(false)"
        );
    }

    #[tokio::test]
    async fn mute_broadcast_preserves_incoming_direction() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let peer = Number::new("02112345678").unwrap();
        let id = p.simulate_incoming(peer).await;
        assert!(matches!(
            rx.recv().await,
            Some(ProviderEvent::Incoming { .. })
        ));
        p.answer(&id).await.unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(ProviderEvent::Connected { .. })
        ));

        p.set_muted(&id, true).await.unwrap();
        assert!(
            matches!(
                rx.recv().await,
                Some(ProviderEvent::MutedChanged {
                    direction: crate::session::CallDirection::Incoming,
                    muted: true,
                    ..
                })
            ),
            "the mute broadcast keeps the true (Incoming) direction"
        );
    }

    #[tokio::test]
    async fn emergency_call_may_be_muted_at_provider() {
        // The asymmetry with recording, at the provider seam: 110 may be muted.
        let p = MockTelephonyProvider::with_common_emergency();
        let id = p.emergency_call(Number::new("110").unwrap()).await.unwrap();
        p.simulate_connected(&id).await.unwrap();
        assert!(
            p.set_muted(&id, true).await.is_ok(),
            "an emergency call can be muted"
        );
        assert!(p.status().await.unwrap()[0].muted);
    }

    #[tokio::test]
    async fn local_hangup_broadcasts_local_ended() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let id = p.dial(&regular()).await.unwrap();

        p.end(&id).await.unwrap();
        // The ended edge is a *final snapshot*: the call is already gone from
        // `status()`, so a subscriber can only learn the peer/direction from the event.
        let evt = rx.recv().await;
        assert_eq!(
            evt,
            Some(ProviderEvent::LocalEnded {
                id: id.clone(),
                peer: regular(),
                direction: CallDirection::Outgoing,
                emergency: false,
            }),
            "a local hang-up broadcasts a LocalEnded event carrying the final snapshot"
        );
        assert!(
            p.status().await.unwrap().is_empty(),
            "ended call is released"
        );
    }

    #[tokio::test]
    async fn ended_events_for_an_answered_incoming_call_stay_incoming() {
        // The mirror of the outgoing case above: an incoming call that is answered and
        // then hung up locally must report Incoming (with its peer) on the ended edge.
        // `IncomingCall.svelte` drops `direction !== "Incoming"` events and writes its
        // call-log row from this edge's peer, so getting either wrong loses the call.
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let peer = Number::new("02112345678").unwrap();
        let id = p.simulate_incoming(peer.clone()).await;
        assert!(matches!(
            rx.recv().await,
            Some(ProviderEvent::Incoming { .. })
        ));
        p.answer(&id).await.unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(ProviderEvent::Connected {
                direction: CallDirection::Incoming,
                ..
            })
        ));

        p.end(&id).await.unwrap();
        assert_eq!(
            rx.recv().await,
            Some(ProviderEvent::LocalEnded {
                id,
                peer,
                direction: CallDirection::Incoming,
                emergency: false,
            }),
            "an answered incoming call's hang-up stays Incoming and keeps its peer"
        );
    }
}
