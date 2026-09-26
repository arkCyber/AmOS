//! gRPC `TelephonyService` exposing the telephony domain core over the shared UDS.
//!
//! Mirrors the `amos-android` service pattern: the service struct holds the
//! provider seams (as `Arc<dyn ...>`) and maps tonic RPCs onto the domain core,
//! mapping domain errors to gRPC [`Status`]. For P1 the backing providers are the
//! deterministic [`MockTelephonyProvider`]; a real Android backend swaps them in
//! later (feature `android`, P3). Contract: `docs/telephony.md` §6 + §10.

use std::pin::Pin;
use std::sync::Arc;

use amos_proto::amos_telephony::{
    telephony_server::{Telephony, TelephonyServer},
    AnswerRequest, BackendStatus as ProtoBackendStatus, CallDirection as ProtoDirection, CallIdMsg,
    CallList, CallSnapshot, CallState as ProtoState, CallStateEvent, DialRequest,
    EndReason as ProtoEndReason, EndRequest, MuteRequest, RecordingState as ProtoRecording,
    SimulateIncomingRequest, StatusRequest, WatchRequest,
};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status};

use crate::audit::{AuditEntry, AuditLog, AuditOutcome};
use crate::error::TelephonyError;
use crate::number::{EmergencyMap, Number, NumberKind};
use crate::provider::{
    EmergencyTelephonyProvider, MockTelephonyProvider, ProviderEvent, TelephonyProvider,
};
use crate::rate::DialRateLimiter;
use crate::session::{
    Call as ModelCall, CallDirection, CallId, CallState, EndReason,
    RecordingState as DomainRecording,
};

/// gRPC service wiring the telephony domain core to the wire contract.
pub struct TelephonyService {
    regular: Arc<dyn TelephonyProvider>,
    emergency: Arc<dyn EmergencyTelephonyProvider>,
    emergency_map: EmergencyMap,
    /// Bounded audit trail for calls (esp. `emergency_dial`, §5: rate-limit exempt
    /// but never un-audited). Always set by the public constructors.
    audit: Arc<AuditLog>,
    /// Emergency-exempt ordinary-dial limiter. `None` = unlimited (strict/test +
    /// mock backends); the daemon's demo backend enables it via
    /// [`TelephonyService::with_mock_demo_limited`] / [`demo_server_limited`].
    dial_limiter: Option<Arc<DialRateLimiter>>,
    /// Dev/test hook: when the backend is the in-process mock, this lets a caller
    /// (tests, a future CLI) simulate an incoming call so the `Watch` stream and
    /// the answering path can be exercised headlessly. `None` for a real backend.
    injector: Option<Arc<MockTelephonyProvider>>,
    /// Demo/driver-only: when `Some(delay)`, an outgoing *regular* call placed
    /// through this service auto-connects after `delay` (the mock stands in for the
    /// network answering), so a desktop demo can actually reach `Active` — and
    /// therefore recording — without a real carrier. Off for deterministic tests.
    demo_connect_delay: Option<tokio::time::Duration>,
    /// Which provider is actually behind the two seams above (see
    /// [`crate::backend::BackendKind`]). Carried so `GetBackend` can answer honestly:
    /// `Dial` returns a `CallIdMsg` either way, and only this field says whether a
    /// real call exists behind it.
    backend: crate::backend::BackendKind,
}

impl TelephonyService {
    /// Build around two provider seams (regular + privileged emergency).
    pub fn new(
        regular: Arc<dyn TelephonyProvider>,
        emergency: Arc<dyn EmergencyTelephonyProvider>,
        emergency_map: EmergencyMap,
    ) -> Self {
        Self::with_injector(regular, emergency, emergency_map, None)
    }

    fn with_injector(
        regular: Arc<dyn TelephonyProvider>,
        emergency: Arc<dyn EmergencyTelephonyProvider>,
        emergency_map: EmergencyMap,
        injector: Option<Arc<MockTelephonyProvider>>,
    ) -> Self {
        Self {
            regular,
            emergency,
            emergency_map,
            audit: Arc::new(AuditLog::new()),
            dial_limiter: None,
            // The injector IS the mock seam: it is `Some` exactly when the backend is
            // the in-process mock and `None` for every other provider. Deriving the
            // backend kind from it keeps the two from drifting — a future real backend
            // that left `injector` set would advertise itself as real while simulating.
            backend: if injector.is_some() {
                crate::backend::BackendKind::Mock
            } else {
                crate::backend::BackendKind::Unconfigured
            },
            injector,
            demo_connect_delay: None,
        }
    }

    /// Declare which provider is behind the seams, overriding the derived default.
    ///
    /// The derived value in [`Self::with_injector`] is exact for the mock and for
    /// "nothing wired"; a real provider (feature `android`) is `Arc<dyn ...>` with no
    /// mock injector, which the derive cannot distinguish from a bare stub — so its
    /// constructor must say so explicitly rather than inherit `Unconfigured`.
    pub fn with_backend(mut self, backend: crate::backend::BackendKind) -> Self {
        self.backend = backend;
        self
    }

    /// Which provider actually backs this service. See [`crate::backend::BackendKind`].
    pub fn backend_kind(&self) -> crate::backend::BackendKind {
        self.backend
    }

    /// Access the bounded call audit trail (for tests / future ops surfaces).
    pub fn audit_log(&self) -> Arc<AuditLog> {
        self.audit.clone()
    }

    /// Default P1 backend: a single [`MockTelephonyProvider`] behind both seams.
    pub fn with_mock() -> Self {
        let mock: Arc<MockTelephonyProvider> =
            Arc::new(MockTelephonyProvider::with_common_emergency());
        let regular: Arc<dyn TelephonyProvider> = mock.clone();
        let emergency: Arc<dyn EmergencyTelephonyProvider> = mock.clone();
        Self::with_injector(
            regular,
            emergency,
            EmergencyMap::common_global(),
            Some(mock),
        )
    }

    /// Mock service with demo auto-connect enabled (outgoing regular calls reach
    /// `Active` after a short ring), used by the `amos-ai` desktop demo. Tests that
    /// need exact Dialing semantics use [`Self::with_mock`] instead (no demo).
    pub fn with_mock_demo() -> Self {
        Self::with_demo_delay(tokio::time::Duration::from_millis(900))
    }

    /// Demo backend (auto-connect) **with ordinary-dial rate limiting enabled**:
    /// up to `cap_per_min` non-emergency dials per client id per minute; emergency
    /// calls are always exempt (see `docs/telephony.md §5`). Used by the daemon's
    /// `demo_server_limited`; strict/headless test backends stay unlimited.
    pub fn with_mock_demo_limited(cap_per_min: u32) -> Self {
        let mut s = Self::with_demo_delay(tokio::time::Duration::from_millis(900));
        s.dial_limiter = Some(std::sync::Arc::new(DialRateLimiter::per_minute(
            cap_per_min,
        )));
        s
    }

    fn with_demo_delay(delay: tokio::time::Duration) -> Self {
        let mut s = Self::with_mock();
        s.demo_connect_delay = Some(delay);
        s
    }

    /// Simulate an incoming call (dev/test; requires the mock backend). Emits a
    /// ringing `Incoming` event on every subscribed `Watch` stream.
    pub async fn inject_incoming(&self, number: &str) -> Result<CallId, Status> {
        let n = Number::new(number).map_err(into_status)?;
        match &self.injector {
            Some(m) => Ok(m.simulate_incoming(n).await),
            None => Err(Status::unavailable(
                "incoming simulation requires the mock backend",
            )),
        }
    }

    async fn live_calls(&self) -> Result<Vec<ModelCall>, Status> {
        self.regular.status().await.map_err(into_status)
    }

    fn is_emergency(&self, number: &Number, forced: bool) -> bool {
        forced || number.kind(&self.emergency_map) == NumberKind::Emergency
    }

    /// Authoritative wire snapshot of a single live call by id (for the recording
    /// RPC responses). `NotFound` when the call is unknown/ended.
    async fn snapshot_for(&self, id: &CallId) -> Result<CallSnapshot, Status> {
        self.regular
            .status()
            .await
            .map_err(into_status)?
            .into_iter()
            .find(|c| &c.id == id)
            .map(|c| snapshot_of(&c))
            .ok_or_else(|| Status::not_found(format!("call {id} not found")))
    }
}

/// Map a domain error to a gRPC [`Status`].
fn into_status(e: TelephonyError) -> Status {
    use TelephonyError::*;
    match e {
        InvalidNumber(_) | NotEmergency(_) | MustUseEmergencyPath(_) => {
            Status::invalid_argument(e.to_string())
        }
        UnknownCall(_) => Status::not_found(e.to_string()),
        IllegalState { .. } | RecordingForbidden(_) => Status::failed_precondition(e.to_string()),
        NoCarrier => Status::unavailable(e.to_string()),
        Provider(_) => Status::internal(e.to_string()),
    }
}

/// Convert the *domain* call model to its wire snapshot.
fn snapshot_of(c: &ModelCall) -> CallSnapshot {
    CallSnapshot {
        call: Some(CallIdMsg {
            id: c.id.to_string(),
        }),
        peer: c.peer.as_str().to_string(),
        direction: match c.direction {
            CallDirection::Outgoing => ProtoDirection::Outgoing,
            CallDirection::Incoming => ProtoDirection::Incoming,
        } as i32,
        state: match c.state {
            CallState::Idle => ProtoState::Idle,
            CallState::Dialing => ProtoState::Dialing,
            CallState::Ringing => ProtoState::Ringing,
            CallState::Active => ProtoState::Active,
            CallState::Ended => ProtoState::Ended,
        } as i32,
        end_reason: match c.ended_reason.unwrap_or(EndReason::Local) {
            EndReason::Local => ProtoEndReason::Local,
            EndReason::Remote => ProtoEndReason::Remote,
            EndReason::Failed => ProtoEndReason::Failed,
            EndReason::Emergency => ProtoEndReason::Emergency,
        } as i32,
        recording: match c.recording {
            DomainRecording::Off => ProtoRecording::RecordingOff,
            DomainRecording::On => ProtoRecording::RecordingOn,
            DomainRecording::Failed => ProtoRecording::RecordingFailed,
        } as i32,
        emergency: c.emergency,
        muted: c.muted,
    }
}

fn call_id_from(opt: Option<CallIdMsg>) -> Result<CallId, Status> {
    match opt {
        Some(m) if !m.id.is_empty() => Ok(CallId::new(m.id)),
        _ => Err(Status::invalid_argument("missing or empty call id")),
    }
}

/// Convert a provider signalling event into a wire `CallStateEvent`. The event
/// carries enough (id + peer + the call's mutable flags) to build the snapshot
/// without a state round-trip.
///
/// `emergency` comes off the event, not a constant: the provider holds the call
/// and stamps the flag, so a streamed snapshot can no longer claim an emergency
/// call is ordinary while `status()` (which reads the model) says otherwise.
fn event_to_state_event(evt: ProviderEvent) -> CallStateEvent {
    let (id, peer, state, direction, reason, recording, muted, emergency) = match evt {
        ProviderEvent::Incoming {
            id,
            peer,
            emergency,
        } => (
            id,
            peer.as_str().to_string(),
            ProtoState::Ringing,
            ProtoDirection::Incoming,
            ProtoEndReason::Local,
            ProtoRecording::RecordingOff,
            false,
            emergency,
        ),
        ProviderEvent::Connected {
            id,
            peer,
            direction,
            emergency,
        } => (
            id,
            peer.as_str().to_string(),
            ProtoState::Active,
            proto_direction(direction),
            ProtoEndReason::Local,
            ProtoRecording::RecordingOff,
            false,
            emergency,
        ),
        ProviderEvent::RemoteEnded {
            id,
            peer,
            direction,
            emergency,
        } => (
            id,
            peer.as_str().to_string(),
            ProtoState::Ended,
            proto_direction(direction),
            ProtoEndReason::Remote,
            ProtoRecording::RecordingOff,
            false,
            emergency,
        ),
        ProviderEvent::LocalEnded {
            id,
            peer,
            direction,
            emergency,
        } => (
            id,
            peer.as_str().to_string(),
            ProtoState::Ended,
            proto_direction(direction),
            ProtoEndReason::Local,
            ProtoRecording::RecordingOff,
            false,
            emergency,
        ),
        ProviderEvent::Failed {
            id,
            peer,
            direction,
            emergency,
        } => (
            id,
            peer.as_str().to_string(),
            ProtoState::Ended,
            proto_direction(direction),
            ProtoEndReason::Failed,
            ProtoRecording::RecordingOff,
            false,
            emergency,
        ),
        ProviderEvent::RecordingChanged {
            id,
            peer,
            state,
            direction,
            recording,
            muted,
            emergency,
        } => (
            id,
            peer.as_str().to_string(),
            proto_state(state),
            proto_direction(direction),
            ProtoEndReason::Local,
            proto_recording(recording),
            muted,
            emergency,
        ),
        ProviderEvent::MutedChanged {
            id,
            peer,
            state,
            direction,
            muted,
            recording,
            emergency,
        } => (
            id,
            peer.as_str().to_string(),
            proto_state(state),
            proto_direction(direction),
            ProtoEndReason::Local,
            proto_recording(recording),
            muted,
            emergency,
        ),
    };
    CallStateEvent {
        call: Some(CallSnapshot {
            call: Some(CallIdMsg { id: id.to_string() }),
            peer,
            direction: direction as i32,
            state: state as i32,
            end_reason: reason as i32,
            recording: recording as i32,
            emergency,
            muted,
        }),
    }
}

/// Map a domain call state onto the wire enum (used for non-signalling events such
/// as `RecordingChanged`, which carry the call's current state).
fn proto_state(s: CallState) -> ProtoState {
    match s {
        CallState::Idle => ProtoState::Idle,
        CallState::Dialing => ProtoState::Dialing,
        CallState::Ringing => ProtoState::Ringing,
        CallState::Active => ProtoState::Active,
        CallState::Ended => ProtoState::Ended,
    }
}

/// Map a domain call direction onto the wire enum.
fn proto_direction(d: CallDirection) -> ProtoDirection {
    match d {
        CallDirection::Outgoing => ProtoDirection::Outgoing,
        CallDirection::Incoming => ProtoDirection::Incoming,
    }
}

/// Map a domain recording state onto the wire enum.
fn proto_recording(r: DomainRecording) -> ProtoRecording {
    match r {
        DomainRecording::Off => ProtoRecording::RecordingOff,
        DomainRecording::On => ProtoRecording::RecordingOn,
        DomainRecording::Failed => ProtoRecording::RecordingFailed,
    }
}

/// Convenience for wiring the service into a tonic server (mock backend). This is
/// the **deterministic** default (used by the headless e2e harness); the desktop
/// demo driver should use [`demo_server`] so outgoing calls auto-connect to `Active`.
pub fn mock_server() -> TelephonyServer<TelephonyService> {
    TelephonyServer::new(TelephonyService::with_mock())
}

/// Tonic server used by the `amos-ai` daemon for the desktop demo: outgoing regular
/// calls auto-connect after a short ring so dial / talk / record is actually
/// operable end-to-end against the mock (see [`TelephonyService::with_mock_demo`]).
pub fn demo_server() -> TelephonyServer<TelephonyService> {
    TelephonyServer::new(TelephonyService::with_mock_demo())
}

/// Like [`demo_server`] but with **ordinary-dial rate limiting** enabled (emergency
/// exempt). The production daemon should mount this variant, not the unlimited one.
pub fn demo_server_limited(cap_per_min: u32) -> TelephonyServer<TelephonyService> {
    TelephonyServer::new(TelephonyService::with_mock_demo_limited(cap_per_min))
}

#[tonic::async_trait]
impl Telephony for TelephonyService {
    /// Server-streaming: yields the current live calls, then streams signalling
    /// events (incoming / connected / ended) as they arrive from the provider.
    type WatchStream = Pin<Box<dyn Stream<Item = Result<CallStateEvent, Status>> + Send + 'static>>;

    async fn dial(&self, request: Request<DialRequest>) -> Result<Response<CallIdMsg>, Status> {
        // Client id for per-client rate limiting (read before consuming the request).
        let client = request
            .metadata()
            .get("x-client-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("_default")
            .to_string();
        let req = request.into_inner();
        let number = Number::new(&req.number).map_err(into_status)?;
        let emergency = self.is_emergency(&number, req.emergency);
        // Ordinary dials are rate-limited per client; emergency calls are always
        // exempt so a throttle can never delay a 110/112 (docs/telephony.md §5).
        if !emergency {
            if let Some(limiter) = &self.dial_limiter {
                if !limiter.allow(&client) {
                    self.audit.record(AuditEntry::new(
                        "dial",
                        number.as_str(),
                        AuditOutcome::Rejected,
                        "rate limit exceeded",
                    ));
                    return Err(Status::resource_exhausted("dial rate limit exceeded"));
                }
            }
        }
        // Every *parsed* dial attempt is audited (§5: emergency is rate-limit exempt
        // but never un-audited). Unparseable/garbage input is rejected above without
        // an audit entry — we deliberately don't echo attacker-controlled huge text.
        let op = if emergency { "emergency_dial" } else { "dial" };
        let detail = number.as_str().to_string();
        let result = if emergency {
            self.emergency.emergency_call(number).await
        } else {
            self.regular.dial(&number).await
        };
        let id = match result {
            Ok(id) => {
                self.audit
                    .record(AuditEntry::new(op, &detail, AuditOutcome::Accepted, ""));
                id
            }
            Err(e) => {
                self.audit.record(AuditEntry::new(
                    op,
                    &detail,
                    AuditOutcome::Rejected,
                    e.to_string(),
                ));
                return Err(into_status(e));
            }
        };
        // Desktop-demo driver: once the mock answers the outgoing *regular* call
        // (the network stand-in), the Watch stream emits `Connected` → the call is
        // `Active` and recording becomes legal. Emergency calls are left ringing on
        // purpose (recording them is forbidden anyway). The task ignores a call that
        // was already hung up before it connected (UnknownCall).
        if !emergency {
            if let (Some(delay), Some(mock)) = (self.demo_connect_delay, self.injector.clone()) {
                let cid = id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    // The documented, ignorable case is named explicitly: the call was hung
                    // up before it connected. Anything *else* means the demo call never
                    // becomes Active — the UI would sit on "dialing" forever — and that must
                    // not be swallowed by the same discard.
                    if let Err(e) = mock.simulate_connected(&cid).await {
                        if !matches!(e, TelephonyError::UnknownCall(_)) {
                            tracing::warn!(
                                target: "amos::telephony",
                                call = %cid,
                                error = %e,
                                "demo connect failed — the call stays in Dialing"
                            );
                        }
                    }
                });
            }
        }
        Ok(Response::new(CallIdMsg { id: id.to_string() }))
    }

    async fn answer(&self, request: Request<AnswerRequest>) -> Result<Response<CallIdMsg>, Status> {
        let id = call_id_from(request.into_inner().call)?;
        self.regular.answer(&id).await.map_err(into_status)?;
        Ok(Response::new(CallIdMsg { id: id.to_string() }))
    }

    async fn end(&self, request: Request<EndRequest>) -> Result<Response<CallIdMsg>, Status> {
        let id = call_id_from(request.into_inner().call)?;
        self.regular.end(&id).await.map_err(into_status)?;
        Ok(Response::new(CallIdMsg { id: id.to_string() }))
    }

    async fn start_recording(
        &self,
        request: Request<CallIdMsg>,
    ) -> Result<Response<CallSnapshot>, Status> {
        let id = call_id_from(Some(request.into_inner()))?;
        self.regular
            .start_recording(&id)
            .await
            .map_err(into_status)?;
        Ok(Response::new(self.snapshot_for(&id).await?))
    }

    async fn stop_recording(
        &self,
        request: Request<CallIdMsg>,
    ) -> Result<Response<CallSnapshot>, Status> {
        let id = call_id_from(Some(request.into_inner()))?;
        self.regular
            .stop_recording(&id)
            .await
            .map_err(into_status)?;
        Ok(Response::new(self.snapshot_for(&id).await?))
    }

    /// Set whether the call's outbound audio is muted; returns its authoritative
    /// snapshot so the UI reflects the daemon's answer rather than its own guess.
    ///
    /// `muted` is the desired state (not a toggle), so a retried request is safe.
    /// Legal on any live call, emergency included (see [`crate::session::CallSession::set_muted`]).
    async fn set_muted(
        &self,
        request: Request<MuteRequest>,
    ) -> Result<Response<CallSnapshot>, Status> {
        let req = request.into_inner();
        let id = call_id_from(req.call)?;
        self.regular
            .set_muted(&id, req.muted)
            .await
            .map_err(into_status)?;
        Ok(Response::new(self.snapshot_for(&id).await?))
    }

    /// Dev/demo hook: make the mock "network" deliver a ringing incoming call from
    /// `number`. Only available on the in-process mock backend (used by the desktop
    /// demo to exercise the incoming-call surface); a real provider has no such
    /// client-facing signal and returns `Unavailable`.
    async fn simulate_incoming(
        &self,
        request: Request<SimulateIncomingRequest>,
    ) -> Result<Response<CallIdMsg>, Status> {
        let req = request.into_inner();
        if self.injector.is_none() {
            return Err(Status::unavailable(
                "simulating incoming calls requires the mock backend",
            ));
        }
        let id = self.inject_incoming(&req.number).await?;
        Ok(Response::new(CallIdMsg { id: id.to_string() }))
    }

    async fn status(&self, _request: Request<StatusRequest>) -> Result<Response<CallList>, Status> {
        let calls = self.live_calls().await?;
        Ok(Response::new(CallList {
            calls: calls.iter().map(snapshot_of).collect(),
        }))
    }

    /// Answer which provider backs `Dial`. Always available: this is a property of the
    /// service, not of a call, so it is answered even with no calls live and even when
    /// the backend is a mock (`Status` would just return an empty list there, which
    /// reads as "no calls" rather than "no real telephony").
    async fn get_backend(
        &self,
        _request: Request<StatusRequest>,
    ) -> Result<Response<ProtoBackendStatus>, Status> {
        let kind = self.backend_kind();
        Ok(Response::new(ProtoBackendStatus {
            kind: kind.to_proto() as i32,
            detail: kind.detail().to_string(),
        }))
    }

    async fn watch(
        &self,
        _request: Request<WatchRequest>,
    ) -> Result<Response<Self::WatchStream>, Status> {
        let live = self.live_calls().await?;
        let live_events: Vec<Result<CallStateEvent, Status>> = live
            .into_iter()
            .map(|c| {
                Ok(CallStateEvent {
                    call: Some(snapshot_of(&c)),
                })
            })
            .collect();
        // Subscribe to the provider *after* listing live calls so events arriving
        // between the two are not lost (they are delivered to this receiver).
        let rx = self.regular.subscribe();
        let recv = UnboundedReceiverStream::new(rx).map(|evt| Ok(event_to_state_event(evt)));
        let stream = tokio_stream::iter(live_events).chain(recv);
        Ok(Response::new(Box::pin(stream)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_proto::amos_telephony::BackendKind as ProtoBackendKind;
    use std::time::Duration;
    use tokio_stream::StreamExt;

    fn svc() -> TelephonyService {
        TelephonyService::with_mock()
    }

    /// The next `Watch` snapshot, failing loudly on a timeout / stream error.
    async fn next_snap(
        s: &mut Pin<Box<dyn Stream<Item = Result<CallStateEvent, Status>> + Send + 'static>>,
    ) -> CallSnapshot {
        tokio::time::timeout(Duration::from_secs(2), s.next())
            .await
            .expect("a watch event arrives within 2s")
            .expect("the stream yields an item")
            .expect("the item is not an error")
            .call
            .expect("the event carries a call snapshot")
    }

    #[tokio::test]
    async fn get_backend_reports_the_mock_as_not_real() {
        // The production daemon mounts a mock (see `demo_server_limited`). A caller
        // asking "will this dial reach the platform?" must be told no, even though
        // `Dial` answers happily.
        let s = svc();
        let reply = s
            .get_backend(Request::new(StatusRequest {}))
            .await
            .expect("get_backend is infallible")
            .into_inner();
        assert_eq!(reply.kind, ProtoBackendKind::BackendMock as i32);
        assert!(reply.detail.contains("mock"), "detail: {}", reply.detail);
        assert!(!s.backend_kind().is_real());
    }

    #[tokio::test]
    async fn get_backend_distinguishes_unconfigured_from_mock() {
        // A service built around bare stubs (no mock injector) must not claim to be a
        // mock — `Unconfigured` is the honest answer, and neither is `is_real`.
        let s = TelephonyService::new(
            Arc::new(MockTelephonyProvider::with_common_emergency()),
            Arc::new(MockTelephonyProvider::with_common_emergency()),
            EmergencyMap::common_global(),
        );
        assert_eq!(s.backend_kind(), crate::backend::BackendKind::Unconfigured);
        let reply = s
            .get_backend(Request::new(StatusRequest {}))
            .await
            .expect("get_backend is infallible")
            .into_inner();
        assert_eq!(reply.kind, ProtoBackendKind::BackendUnconfigured as i32);
    }

    #[tokio::test]
    async fn an_explicit_backend_kind_overrides_the_derived_default() {
        // The future Android provider is `Arc<dyn TelephonyProvider>` with no mock
        // injector, so the derive cannot tell it apart from a stub; its constructor
        // declares the kind and that must win.
        let s = svc().with_backend(crate::backend::BackendKind::Android);
        assert!(s.backend_kind().is_real());
        let reply = s
            .get_backend(Request::new(StatusRequest {}))
            .await
            .expect("get_backend is infallible")
            .into_inner();
        assert_eq!(reply.kind, ProtoBackendKind::BackendAndroid as i32);
    }

    #[tokio::test]
    async fn dial_regular_then_status_and_end() {
        let svc = svc();
        let id = svc
            .dial(Request::new(DialRequest {
                number: "13800138000".into(),
                emergency: false,
            }))
            .await
            .unwrap()
            .into_inner()
            .id;
        assert!(!id.is_empty());

        let calls = svc
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner()
            .calls;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].call.as_ref().unwrap().id, id);
        assert_eq!(calls[0].state, ProtoState::Dialing as i32);

        svc.end(Request::new(EndRequest {
            call: Some(CallIdMsg { id: id.clone() }),
        }))
        .await
        .unwrap();

        let calls = svc
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner()
            .calls;
        assert!(calls.is_empty(), "ended call is released");
    }

    #[tokio::test]
    async fn emergency_112_auto_routes_without_flag() {
        let svc = svc();
        // Even without emergency=true, an emergency *number* must go the emergency
        // path (number classification is a hard rule, not just a client hint).
        let id = svc
            .dial(Request::new(DialRequest {
                number: "112".into(),
                emergency: false,
            }))
            .await
            .unwrap()
            .into_inner()
            .id;
        let calls = svc
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner()
            .calls;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].call.as_ref().unwrap().id, id);
        assert!(calls[0].emergency, "112 routed to emergency provider");
    }

    /// A streamed snapshot must report the call's real emergency flag. `status()`
    /// always did (it reads the model); the *event* path built every
    /// `CallStateEvent` with a hardcoded `emergency: false`, so a subscriber
    /// watching an emergency call was told it was ordinary (P1-T3, REQ-A1776).
    #[tokio::test]
    async fn watch_events_keep_an_emergency_call_marked_emergency() {
        let svc = svc();
        let id = svc
            .dial(Request::new(DialRequest {
                number: "112".into(),
                emergency: false,
            }))
            .await
            .unwrap()
            .into_inner()
            .id;
        let mut stream = svc
            .watch(Request::new(WatchRequest {}))
            .await
            .unwrap()
            .into_inner();
        // The opening live-call snapshot already carried the flag.
        assert!(next_snap(&mut stream).await.emergency);

        // A *signalling event* (MutedChanged is one — and mute is legal on an
        // emergency call) must keep saying so rather than reverting to the constant.
        svc.set_muted(Request::new(MuteRequest {
            call: Some(CallIdMsg { id: id.to_string() }),
            muted: true,
        }))
        .await
        .unwrap();
        let evt = next_snap(&mut stream).await;
        assert!(
            evt.emergency,
            "the MutedChanged event for 112 must report emergency=true, not a constant false"
        );
        assert!(evt.muted, "the same event still carries the new mute flag");
    }

    #[tokio::test]
    async fn emergency_flag_with_regular_number_is_rejected() {
        let svc = svc();
        let err = svc
            .dial(Request::new(DialRequest {
                number: "13800138000".into(),
                emergency: true,
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn emergency_dial_is_audited_when_auto_routed() {
        let svc = svc();
        // 112 without the flag still auto-routes to the emergency provider.
        svc.dial(Request::new(DialRequest {
            number: "112".into(),
            emergency: false,
        }))
        .await
        .unwrap();
        let log = svc.audit_log();
        assert!(
            log.any(|e| {
                e.operation == "emergency_dial"
                    && e.detail == "112"
                    && e.outcome == AuditOutcome::Accepted
            }),
            "an accepted emergency dial must leave an emergency_dial audit entry"
        );
    }

    #[tokio::test]
    async fn regular_and_rejected_dials_are_audited() {
        let svc = svc();
        svc.dial(Request::new(DialRequest {
            number: "13800138000".into(),
            emergency: false,
        }))
        .await
        .unwrap();
        assert!(svc.audit_log().any(|e| {
            e.operation == "dial"
                && e.detail == "13800138000"
                && e.outcome == AuditOutcome::Accepted
        }));

        // A forced-emergency regular number is rejected — but still audited as refused.
        let _ = svc
            .dial(Request::new(DialRequest {
                number: "13800138000".into(),
                emergency: true,
            }))
            .await;
        assert!(svc.audit_log().any(|e| {
            e.operation == "emergency_dial"
                && e.detail == "13800138000"
                && e.outcome == AuditOutcome::Rejected
        }));
    }

    fn dial_req(number: &str, emergency: bool, client: Option<&str>) -> Request<DialRequest> {
        let mut r = Request::new(DialRequest {
            number: number.to_string(),
            emergency,
        });
        if let Some(id) = client {
            r.metadata_mut().insert(
                "x-client-id",
                tonic::metadata::AsciiMetadataValue::try_from(id).unwrap(),
            );
        }
        r
    }

    #[tokio::test]
    async fn ordinary_dial_is_rate_limited_but_emergency_is_exempt() {
        let svc = TelephonyService::with_mock_demo_limited(1);
        assert!(svc.dial(dial_req("13800138000", false, None)).await.is_ok());
        let err = svc
            .dial(dial_req("13800138000", false, None))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::ResourceExhausted);
        // Even after the regular budget is spent, an emergency dial is never throttled.
        assert!(svc.dial(dial_req("110", true, None)).await.is_ok());
    }

    #[tokio::test]
    async fn rate_limiter_buckets_are_per_client() {
        let svc = TelephonyService::with_mock_demo_limited(1);
        assert!(svc
            .dial(dial_req("13800138000", false, Some("a")))
            .await
            .is_ok());
        let err = svc
            .dial(dial_req("13800138000", false, Some("a")))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::ResourceExhausted);
        // A different client id has its own budget.
        assert!(svc
            .dial(dial_req("13800138000", false, Some("b")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn invalid_number_is_rejected() {
        let svc = svc();
        let err = svc
            .dial(Request::new(DialRequest {
                number: "abc".into(),
                emergency: false,
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn answer_unknown_call_returns_not_found() {
        let svc = svc();
        let err = svc
            .answer(Request::new(AnswerRequest {
                call: Some(CallIdMsg { id: "ghost".into() }),
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn watch_yields_live_call_first() {
        let svc = svc();
        svc.dial(Request::new(DialRequest {
            number: "13800138000".into(),
            emergency: false,
        }))
        .await
        .unwrap();

        let mut stream = svc
            .watch(Request::new(WatchRequest {}))
            .await
            .unwrap()
            .into_inner();
        let evt = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let snap = evt.call.unwrap();
        assert_eq!(snap.peer, "13800138000");
        assert_eq!(snap.state, ProtoState::Dialing as i32);
    }

    #[tokio::test]
    async fn watch_streams_injected_incoming_event() {
        let svc = svc();
        let mut stream = svc
            .watch(Request::new(WatchRequest {}))
            .await
            .unwrap()
            .into_inner();

        // Headlessly drive an incoming call through the mock; the open Watch
        // stream must deliver a ringing Incoming snapshot with the peer.
        let id = svc.inject_incoming("02112345678").await.unwrap();
        let evt = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let snap = evt.call.unwrap();
        assert_eq!(snap.call.unwrap().id, id.to_string());
        assert_eq!(snap.peer, "02112345678");
        assert_eq!(snap.state, ProtoState::Ringing as i32);
        assert_eq!(snap.direction, ProtoDirection::Incoming as i32);
    }

    /// A call has two independent mutable flags, and `Watch` events are applied as
    /// **snapshots** — so each change event must carry *both* flags or the subscriber
    /// silently clears the other one. This walks a real stream through both changes and
    /// asserts the surviving flag on each event (the cross-talk direction the wire
    /// contract cannot leave implicit).
    #[tokio::test]
    async fn every_change_event_carries_both_mutable_flags() {
        let svc = svc();
        let mut stream = svc
            .watch(Request::new(WatchRequest {}))
            .await
            .unwrap()
            .into_inner();
        async fn next_snap(
            s: &mut Pin<Box<dyn Stream<Item = Result<CallStateEvent, Status>> + Send + 'static>>,
        ) -> CallSnapshot {
            tokio::time::timeout(Duration::from_secs(2), s.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .call
                .unwrap()
        }
        let id = svc.inject_incoming("02112345678").await.unwrap();
        let ringing = next_snap(&mut stream).await;
        assert_eq!(ringing.state, ProtoState::Ringing as i32);
        assert!(!ringing.muted);

        svc.answer(Request::new(AnswerRequest {
            call: Some(CallIdMsg { id: id.to_string() }),
        }))
        .await
        .unwrap();
        let connected = next_snap(&mut stream).await;
        assert_eq!(connected.state, ProtoState::Active as i32);
        assert_eq!(
            connected.direction,
            ProtoDirection::Incoming as i32,
            "answering an incoming call does not make it an outgoing call"
        );

        // Mute first: the mute event says nothing new about recording (Off at this
        // point, and it must *say* Off rather than leave it to the subscriber).
        svc.set_muted(Request::new(MuteRequest {
            call: Some(CallIdMsg { id: id.to_string() }),
            muted: true,
        }))
        .await
        .unwrap();
        let muted_evt = next_snap(&mut stream).await;
        assert!(muted_evt.muted, "the mute event carries the new flag");
        assert_eq!(
            muted_evt.recording,
            ProtoRecording::RecordingOff as i32,
            "…and the current recording flag, so applying it cannot invent one"
        );

        // Now start recording. The recording event must carry the *live* mute flag —
        // this is the assertion that fails if `RecordingChanged` only knows about
        // recording, which would un-mute the user in every subscriber.
        svc.start_recording(Request::new(CallIdMsg { id: id.to_string() }))
            .await
            .unwrap();
        let rec_evt = next_snap(&mut stream).await;
        assert_eq!(rec_evt.recording, ProtoRecording::RecordingOn as i32);
        assert!(
            rec_evt.muted,
            "a recording change must not clear the call's mute flag"
        );

        // And the mirror: stopping the recording keeps the mute flag, too.
        svc.stop_recording(Request::new(CallIdMsg { id: id.to_string() }))
            .await
            .unwrap();
        let stop_evt = next_snap(&mut stream).await;
        assert_eq!(stop_evt.recording, ProtoRecording::RecordingOff as i32);
        assert!(stop_evt.muted, "stopping a recording keeps the mute flag");

        // Unmuting reports the still-Off recording honestly.
        svc.set_muted(Request::new(MuteRequest {
            call: Some(CallIdMsg { id: id.to_string() }),
            muted: false,
        }))
        .await
        .unwrap();
        let unmuted_evt = next_snap(&mut stream).await;
        assert!(!unmuted_evt.muted);
        assert_eq!(unmuted_evt.recording, ProtoRecording::RecordingOff as i32);
    }

    #[tokio::test]
    async fn start_recording_on_dialing_call_is_failed_precondition() {
        let svc = svc();
        let id = svc
            .dial(Request::new(DialRequest {
                number: "13800138000".into(),
                emergency: false,
            }))
            .await
            .unwrap()
            .into_inner()
            .id;

        // The mock call is Dialing (never connected through the unary surface), so
        // recording is domain-illegal -> FailedPrecondition.
        let err = svc
            .start_recording(Request::new(CallIdMsg { id: id.clone() }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);

        let err = svc
            .stop_recording(Request::new(CallIdMsg { id }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
    }

    #[tokio::test]
    async fn start_recording_unknown_call_is_not_found() {
        let svc = svc();
        let err = svc
            .start_recording(Request::new(CallIdMsg { id: "ghost".into() }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn status_snapshots_carry_recording_off_by_default() {
        let svc = svc();
        svc.dial(Request::new(DialRequest {
            number: "13800138000".into(),
            emergency: false,
        }))
        .await
        .unwrap();
        let calls = svc
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner()
            .calls;
        assert_eq!(
            calls[0].recording,
            amos_proto::amos_telephony::RecordingState::RecordingOff as i32
        );
    }

    #[tokio::test]
    async fn set_muted_returns_the_authoritative_snapshot() {
        let svc = svc();
        let id = svc
            .dial(Request::new(DialRequest {
                number: "13800138000".into(),
                emergency: false,
            }))
            .await
            .unwrap()
            .into_inner()
            .id;

        // A freshly dialled call is unmuted; the request asks for a state, not a toggle.
        let snap = svc
            .set_muted(Request::new(MuteRequest {
                call: Some(CallIdMsg { id: id.clone() }),
                muted: true,
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(snap.muted, "the reply is the daemon's own snapshot");

        // Idempotent: asking again for the same state is not an error.
        let again = svc
            .set_muted(Request::new(MuteRequest {
                call: Some(CallIdMsg { id: id.clone() }),
                muted: true,
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(again.muted);

        // And Status carries it, so a re-adopting UI sees the true state.
        let calls = svc
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner()
            .calls;
        assert!(calls[0].muted, "Status reports the muted flag");

        let off = svc
            .set_muted(Request::new(MuteRequest {
                call: Some(CallIdMsg { id }),
                muted: false,
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(!off.muted);
    }

    #[tokio::test]
    async fn set_muted_on_unknown_call_is_not_found() {
        let svc = svc();
        let err = svc
            .set_muted(Request::new(MuteRequest {
                call: Some(CallIdMsg { id: "ghost".into() }),
                muted: true,
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn set_muted_without_a_call_id_is_invalid() {
        let svc = svc();
        let err = svc
            .set_muted(Request::new(MuteRequest {
                call: None,
                muted: true,
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn status_snapshots_carry_muted_false_by_default() {
        let svc = svc();
        svc.dial(Request::new(DialRequest {
            number: "13800138000".into(),
            emergency: false,
        }))
        .await
        .unwrap();
        let calls = svc
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner()
            .calls;
        assert!(!calls[0].muted, "a new call is not muted");
    }

    #[tokio::test]
    async fn demo_service_auto_connects_outgoing_call_to_active() {
        // Demo mode with a short ring so the test is fast & deterministic.
        let svc = TelephonyService::with_demo_delay(std::time::Duration::from_millis(40));
        svc.dial(Request::new(DialRequest {
            number: "13800138000".into(),
            emergency: false,
        }))
        .await
        .unwrap();

        // Poll until the mock's delayed "network answers" fires (or give up).
        let mut active = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let calls = svc
                .status(Request::new(StatusRequest {}))
                .await
                .unwrap()
                .into_inner()
                .calls;
            if calls
                .first()
                .is_some_and(|c| c.state == ProtoState::Active as i32)
            {
                active = true;
                break;
            }
        }
        assert!(active, "demo outgoing call should auto-connect to Active");
    }

    #[tokio::test]
    async fn simulate_incoming_rpc_rings_on_watch() {
        let svc = svc();
        let mut stream = svc
            .watch(Request::new(WatchRequest {}))
            .await
            .unwrap()
            .into_inner();

        let id = svc
            .simulate_incoming(Request::new(SimulateIncomingRequest {
                number: "02112345678".into(),
            }))
            .await
            .unwrap()
            .into_inner()
            .id;
        assert!(!id.is_empty(), "simulated incoming returns a call id");

        let evt = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let snap = evt.call.unwrap();
        assert_eq!(snap.call.unwrap().id, id);
        assert_eq!(snap.peer, "02112345678");
        assert_eq!(snap.state, ProtoState::Ringing as i32);
        assert_eq!(snap.direction, ProtoDirection::Incoming as i32);
    }

    /// An incoming call's **whole** lifecycle must reach the `Watch` stream with its
    /// true direction and peer — not only its ringing edge.
    ///
    /// `IncomingCall.svelte` drops every event whose `direction !== "Incoming"`
    /// (outgoing calls are the Phone screen's own UI) and writes the call-log row from
    /// the *Ended* event's `peer`. When this mapper invented `Outgoing` and an empty
    /// peer for `Connected`/`RemoteEnded`/`LocalEnded`, both later edges were dropped
    /// by that guard: no incoming call ever reached `amos.calllog` — this was the log's
    /// only production writer — and a caller hanging up left the overlay on screen for
    /// good (REQ-A1095/F-SH-409).
    #[tokio::test]
    async fn incoming_call_keeps_direction_and_peer_through_to_the_end() {
        let svc = svc();
        let mut stream = svc
            .watch(Request::new(WatchRequest {}))
            .await
            .unwrap()
            .into_inner();
        let id = svc.inject_incoming("02112345678").await.unwrap();

        let ringing = next_snap(&mut stream).await;
        assert_eq!(ringing.peer, "02112345678");
        assert_eq!(ringing.state, ProtoState::Ringing as i32);
        assert_eq!(ringing.direction, ProtoDirection::Incoming as i32);

        // Answering must not re-tag the call as Outgoing — the incoming overlay reads
        // its own Ringing → Active edge from this event.
        svc.answer(Request::new(AnswerRequest {
            call: Some(CallIdMsg { id: id.to_string() }),
        }))
        .await
        .unwrap();
        let active = next_snap(&mut stream).await;
        assert_eq!(active.state, ProtoState::Active as i32);
        assert_eq!(
            active.peer, "02112345678",
            "the answered edge still names the caller"
        );
        assert_eq!(active.direction, ProtoDirection::Incoming as i32);

        // The Ended edge is the only writer of an incoming/missed call-log row, so it
        // must carry the peer the row is keyed on and the direction that gets it past
        // the overlay's `direction !== "Incoming"` guard.
        svc.end(Request::new(EndRequest {
            call: Some(CallIdMsg { id: id.to_string() }),
        }))
        .await
        .unwrap();
        let ended = next_snap(&mut stream).await;
        assert_eq!(ended.state, ProtoState::Ended as i32);
        assert_eq!(
            ended.peer, "02112345678",
            "the ended edge still names the caller"
        );
        assert_eq!(ended.direction, ProtoDirection::Incoming as i32);
        assert_eq!(ended.end_reason, ProtoEndReason::Local as i32);
    }
}
