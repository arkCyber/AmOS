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
use crate::number::{EmergencyMap, Number, NumberKind};
use crate::session::{
    Call, CallDirection, CallId, CallSession, CallState, EndReason, RecordingState,
};

/// Signalling events a provider pushes to subscribers (the daemon drives its
/// `CallSession`s from these). Carries just enough to build a wire snapshot
/// without a state round-trip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderEvent {
    /// A new incoming call is ringing.
    Incoming { id: CallId, peer: Number },
    /// The far side picked up / an outgoing call connected.
    Connected { id: CallId, peer: Number },
    /// The remote party hung up.
    RemoteEnded(CallId),
    /// The local user hung up / rejected a call.
    LocalEnded(CallId),
    /// The call failed (network / no answer).
    Failed(CallId),
    /// Recording on a live call changed (started / stopped / failed). Carries enough
    /// snapshot fields (peer + state + new recording state) for a Watch subscriber to
    /// rebuild the call without a state round-trip — recording is a first-class,
    /// broadcast call-state, not just a private RPC response.
    RecordingChanged {
        id: CallId,
        peer: Number,
        state: CallState,
        direction: CallDirection,
        recording: RecordingState,
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
        });
    }

    /// Simulate a ringing incoming call arriving from the network.
    pub async fn simulate_incoming(&self, peer: Number) -> CallId {
        let id = {
            let mut st = self.inner.lock().await;
            let id = Self::next_id(&mut st);
            let sess = CallSession::start_incoming(id.clone(), peer.clone());
            st.calls.insert(id.clone(), sess);
            id
        };
        self.broadcast(ProviderEvent::Incoming {
            id: id.clone(),
            peer,
        });
        id
    }

    /// Simulate "the far side connected" for an outgoing call.
    pub async fn simulate_connected(&self, id: &CallId) -> Result<()> {
        let peer = {
            let mut st = self.inner.lock().await;
            let sess = st
                .calls
                .get_mut(id)
                .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
            let peer = sess.snapshot().peer.clone();
            sess.connect()?;
            peer
        };
        self.broadcast(ProviderEvent::Connected {
            id: id.clone(),
            peer,
        });
        Ok(())
    }

    /// Simulate the remote party hanging up.
    pub async fn simulate_remote_ended(&self, id: &CallId) -> Result<()> {
        {
            let mut st = self.inner.lock().await;
            {
                let sess = st
                    .calls
                    .get_mut(id)
                    .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
                sess.end(EndReason::Remote)?;
            }
            st.calls.remove(id);
        }
        self.broadcast(ProviderEvent::RemoteEnded(id.clone()));
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
        if number.kind(&self.emergency) == NumberKind::Emergency {
            // Enforce the separation: emergency numbers must use the emergency path.
            return Err(TelephonyError::NotEmergency(number.digits()));
        }
        let mut st = self.inner.lock().await;
        let id = Self::next_id(&mut st);
        let sess = CallSession::start_outgoing(id.clone(), number.clone(), false);
        st.calls.insert(id.clone(), sess);
        Ok(id)
    }

    async fn answer(&self, id: &CallId) -> Result<()> {
        let peer = {
            let mut st = self.inner.lock().await;
            let sess = st
                .calls
                .get_mut(id)
                .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
            let peer = sess.snapshot().peer.clone();
            sess.answer()?;
            peer
        };
        // Answering is the incoming analogue of `simulate_connected`: the call goes
        // Ringing → Active, so every Watch subscriber must observe it (the UI turns
        // the incoming surface into an active/recordable call from this event).
        self.broadcast(ProviderEvent::Connected {
            id: id.clone(),
            peer,
        });
        Ok(())
    }

    async fn end(&self, id: &CallId) -> Result<()> {
        {
            let mut st = self.inner.lock().await;
            {
                let sess = st
                    .calls
                    .get_mut(id)
                    .ok_or_else(|| TelephonyError::UnknownCall(id.to_string()))?;
                sess.end(EndReason::Local)?;
            }
            st.calls.remove(id);
        }
        // Local hang-up is a state change every Watch subscriber must observe
        // (symmetric with `answer` → `Connected` and `simulate_remote_ended`).
        self.broadcast(ProviderEvent::LocalEnded(id.clone()));
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
        if number.kind(&self.emergency) != NumberKind::Emergency {
            return Err(TelephonyError::NotEmergency(number.digits()));
        }
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
            Err(TelephonyError::NotEmergency(_))
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
            Some(ProviderEvent::Incoming { id, peer }),
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
        // subscribers (like `simulate_connected` does for outgoing calls).
        p.answer(&id).await.unwrap();
        let evt = rx.recv().await;
        assert_eq!(
            evt,
            Some(ProviderEvent::Connected {
                id: id.clone(),
                peer
            }),
            "answer broadcasts the Active/Connected transition"
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
    async fn local_hangup_broadcasts_local_ended() {
        let p = MockTelephonyProvider::with_common_emergency();
        let mut rx = p.subscribe();
        let id = p.dial(&regular()).await.unwrap();

        p.end(&id).await.unwrap();
        let evt = rx.recv().await;
        assert!(
            matches!(evt, Some(ProviderEvent::LocalEnded(ref cid)) if *cid == id),
            "a local hang-up broadcasts a LocalEnded event to Watch subscribers"
        );
        assert!(
            p.status().await.unwrap().is_empty(),
            "ended call is released"
        );
    }
}
