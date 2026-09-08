//! gRPC `TelemetrySpyService` exposing the passive telemetry-spy audit stream
//! over the shared UDS (proto `amos_telemetry_spy`, `proto/telemetry_spy.proto`).
//!
//! Follows the `netguard_service` / `privacy_service` / `WatchLmk` pattern: the
//! service holds a small shared [`tokio::sync::broadcast`] fan-out of
//! [`EgressHit`]s. A daemon capture feed (a future bridge wired to
//! `amos-telemetry-spy`'s `audit` pnet seam) calls [`TelemetrySpySvc::emit`];
//! the System UI subscribes via the `Watch` server-streaming RPC.
//!
//! Honest boundaries (see `proto/telemetry_spy.proto`): a hit means a
//! device-bound identifier appeared as a **plaintext substring** in an outbound
//! payload — a brittle, low-confidence heuristic. Every [`EgressHit`] therefore
//! carries a graded `confidence`; no code here claims a confirmed leak. On the
//! default host build nothing feeds `emit`, so `Watch` yields nothing until a
//! capture producer is wired — never a fabricated hit.

use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use amos_proto::amos_telemetry_spy::{
    telemetry_spy_service_server::{TelemetrySpyService, TelemetrySpyServiceServer},
    EgressHit, Empty,
};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status};

/// How many buffered hits a subscriber may lag behind before it is dropped.
const CHANNEL_CAP: usize = 256;

/// The tonic `TelemetrySpyService` implementation wrapping the broadcast fan-out.
///
/// `Clone` shares the same hit bus: the System UI's `Watch` subscribers and (on a
/// device, `telemetry-spy-audit`) the pnet capture producer each hold a clone of
/// the same service, so a real NIC hit reaches every `Watch` stream. Cloning is
/// cheap — it only clones the `broadcast::Sender` and an `Arc` counter.
#[derive(Clone)]
pub struct TelemetrySpySvc {
    tx: broadcast::Sender<EgressHit>,
    /// Total hits emitted since start (for observability / tests).
    emitted: Arc<AtomicU64>,
    /// Whether the test/demo `SimulateHit` injection RPC is enabled. Off by
    /// default; only a process that explicitly opts in (env `AMOS_SPY_ALLOW_INJECT`)
    /// can publish a synthetic hit — every production boot stays read-only.
    allow_inject: bool,
}

impl TelemetrySpySvc {
    /// A fresh, read-only service (injection disabled) with an empty hit bus.
    pub fn new() -> Self {
        Self::new_with_inject(false)
    }

    /// A fresh service, optionally enabling the test/demo injection RPC.
    pub fn new_with_inject(allow_inject: bool) -> Self {
        let (tx, _rx) = broadcast::channel(CHANNEL_CAP);
        Self {
            tx,
            emitted: Arc::new(AtomicU64::new(0)),
            allow_inject,
        }
    }

    /// Whether the test/demo injection RPC is enabled on this instance.
    pub fn allow_inject(&self) -> bool {
        self.allow_inject
    }

    /// Publish one hit to every live `Watch` subscriber. Best-effort: with no
    /// subscribers (or a full lagging bus) the hit is dropped, never blocking.
    pub fn emit(&self, hit: EgressHit) {
        let _ = self.tx.send(hit);
        self.emitted.fetch_add(1, Ordering::Relaxed);
    }

    /// Number of hits published since start.
    pub fn emitted(&self) -> u64 {
        self.emitted.load(Ordering::Relaxed)
    }
}

impl Default for TelemetrySpySvc {
    fn default() -> Self {
        Self::new()
    }
}

#[tonic::async_trait]
impl TelemetrySpyService for TelemetrySpySvc {
    type WatchStream = Pin<Box<dyn Stream<Item = Result<EgressHit, Status>> + Send + 'static>>;

    async fn watch(&self, _req: Request<Empty>) -> Result<Response<Self::WatchStream>, Status> {
        // Fan-out over the shared broadcast. A lagging/closed subscriber ends the
        // stream with a terminal status so the client reconnects (mirrors WatchLmk).
        let rx = self.tx.subscribe();
        let stream = BroadcastStream::new(rx).map(|res| match res {
            Ok(hit) => Ok(hit),
            Err(_) => Err(Status::cancelled("telemetry-spy watch lagged or closed")),
        });
        Ok(Response::new(Box::pin(stream)))
    }

    async fn simulate_hit(&self, req: Request<EgressHit>) -> Result<Response<Empty>, Status> {
        if !self.allow_inject {
            return Err(Status::permission_denied(
                "telemetry-spy hit injection disabled (set AMOS_SPY_ALLOW_INJECT=1)",
            ));
        }
        let hit = req.into_inner();
        self.emit(hit);
        Ok(Response::new(Empty {}))
    }
}

/// Parse an opt-in injection env flag (`AMOS_SPY_ALLOW_INJECT`). Only `"1"` or
/// `"true"` enables it; anything else (including unset) keeps the bus read-only.
pub(crate) fn injection_env_allowed() -> bool {
    matches!(
        std::env::var("AMOS_SPY_ALLOW_INJECT").as_deref(),
        Ok("1") | Ok("true")
    )
}

/// Build the tonic server wrapper around a fresh service (empty hit bus). The
/// test/demo injection RPC is off unless `AMOS_SPY_ALLOW_INJECT` is set.
pub fn server() -> TelemetrySpyServiceServer<TelemetrySpySvc> {
    TelemetrySpyServiceServer::new(TelemetrySpySvc::new_with_inject(injection_env_allowed()))
}

/// Wrap a **caller-owned** shared service. The daemon's `serve()` uses this so it
/// keeps a handle on the same bus it mounts — letting a capture producer feed
/// `ingest_match` while `Watch` subscribers consume the identical broadcast.
pub fn server_for(svc: TelemetrySpySvc) -> TelemetrySpyServiceServer<TelemetrySpySvc> {
    TelemetrySpyServiceServer::new(svc)
}

// ---- Domain feed seam (`telemetry-spy` feature) ----------------------------
// Maps an `EgressMatch` from the amos-telemetry-spy domain core to the wire
// `EgressHit` and publishes it through the same broadcast a real capture
// producer (pnet NIC reader) will use. Host-testable with no native deps; only
// opening the NIC itself is a device/AOSP step.

/// Wire `IdentifierKind` for a domain identifier kind.
#[cfg(feature = "telemetry-spy")]
fn id_kind_to_wire(k: amos_telemetry_spy::identifier::IdentifierKind) -> i32 {
    use amos_proto::amos_telemetry_spy::IdentifierKind as WireKind;
    use amos_telemetry_spy::identifier::IdentifierKind;
    match k {
        IdentifierKind::Serial => WireKind::KindSerial as i32,
        IdentifierKind::Imei => WireKind::KindImei as i32,
        IdentifierKind::CellId => WireKind::KindCellId as i32,
    }
}

/// Wire `Protocol` for a domain transport protocol.
#[cfg(feature = "telemetry-spy")]
fn proto_to_wire(p: amos_telemetry_spy::signal::Protocol) -> i32 {
    use amos_proto::amos_telemetry_spy::Protocol as WireProto;
    use amos_telemetry_spy::signal::Protocol;
    match p {
        Protocol::Tcp => WireProto::Tcp as i32,
        Protocol::Udp => WireProto::Udp as i32,
        Protocol::Icmp => WireProto::Icmp as i32,
        Protocol::Other => WireProto::Other as i32,
    }
}

/// Wire `Confidence` for a domain evidence grade.
#[cfg(feature = "telemetry-spy")]
fn conf_to_wire(c: amos_telemetry_spy::scanner::Confidence) -> i32 {
    use amos_proto::amos_telemetry_spy::Confidence as WireConf;
    use amos_telemetry_spy::scanner::Confidence;
    match c {
        Confidence::Low => WireConf::Low as i32,
        Confidence::Medium => WireConf::Medium as i32,
        Confidence::High => WireConf::High as i32,
    }
}

/// Map one domain `EgressMatch` to its wire `EgressHit`.
#[cfg(feature = "telemetry-spy")]
pub fn egress_match_to_hit(m: &amos_telemetry_spy::signal::EgressMatch) -> EgressHit {
    use amos_proto::amos_telemetry_spy::IdentifierHit;
    EgressHit {
        ts_ms: m.ts_ms,
        iface: m.iface.clone(),
        src_ip: m.src_ip.clone(),
        src_port: m.src_port.map(u32::from),
        dst_ip: m.dst_ip.clone(),
        dst_port: m.dst_port.map(u32::from),
        protocol: proto_to_wire(m.protocol),
        hits: m
            .hits
            .iter()
            .map(|h| IdentifierHit {
                kind: id_kind_to_wire(h.kind),
                occurrences: h.occurrences as u32,
                confidence: conf_to_wire(h.confidence),
            })
            .collect(),
        payload_bytes: m.payload_bytes as u64,
        severity: "high".to_string(),
        confidence: conf_to_wire(m.confidence),
    }
}

#[cfg(feature = "telemetry-spy")]
impl TelemetrySpySvc {
    /// Publish one domain `EgressMatch` onto the Watch fan-out (the seam a real
    /// pnet capture producer calls for every decoded+scanned frame).
    pub fn ingest_match(&self, m: &amos_telemetry_spy::signal::EgressMatch) {
        self.emit(egress_match_to_hit(m));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_proto::amos_telemetry_spy::{Confidence, IdentifierHit, IdentifierKind, Protocol};
    use tokio_stream::StreamExt;

    fn hit(ts_ms: u64) -> EgressHit {
        EgressHit {
            ts_ms,
            iface: "rmnet_data0".to_string(),
            src_ip: "10.0.0.2".to_string(),
            src_port: Some(53000),
            dst_ip: "203.0.113.9".to_string(),
            dst_port: Some(53),
            protocol: Protocol::Udp as i32,
            hits: vec![IdentifierHit {
                kind: IdentifierKind::KindImei as i32,
                occurrences: 1,
                confidence: Confidence::High as i32,
            }],
            payload_bytes: 40,
            severity: "high".to_string(),
            confidence: Confidence::High as i32,
        }
    }

    #[tokio::test]
    async fn fresh_service_emits_nothing() {
        let s = TelemetrySpySvc::new();
        assert_eq!(s.emitted(), 0);
        let mut stream = s.watch(Request::new(Empty {})).await.unwrap().into_inner();
        // No producer yet -> no events in a short window.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), stream.next())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn watch_streams_an_emitted_hit() {
        let s = TelemetrySpySvc::new();
        // Subscribe before emitting so the event is delivered to this stream.
        let mut stream = s.watch(Request::new(Empty {})).await.unwrap().into_inner();
        s.emit(hit(1));
        let got = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .expect("should deliver a hit")
            .expect("stream should not end")
            .expect("hit should be Ok");
        assert_eq!(got.ts_ms, 1);
        assert_eq!(got.iface, "rmnet_data0");
        assert_eq!(got.severity, "high");
        assert_eq!(got.hits.len(), 1);
        assert_eq!(s.emitted(), 1);
    }

    #[tokio::test]
    async fn multiple_subscribers_all_receive() {
        let s = TelemetrySpySvc::new();
        let mut a = s.watch(Request::new(Empty {})).await.unwrap().into_inner();
        let mut b = s.watch(Request::new(Empty {})).await.unwrap().into_inner();
        s.emit(hit(7));
        for stream in [&mut a, &mut b] {
            let got = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
                .await
                .expect("deliver")
                .expect("open")
                .expect("ok");
            assert_eq!(got.ts_ms, 7);
        }
    }

    #[tokio::test]
    async fn simulate_hit_is_denied_when_injection_off() {
        let s = TelemetrySpySvc::new(); // read-only default
        assert!(!s.allow_inject());
        let err = s.simulate_hit(Request::new(hit(1))).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::PermissionDenied);
        assert_eq!(s.emitted(), 0, "denied injection must not publish a hit");
    }

    #[tokio::test]
    async fn simulate_hit_publishes_when_injection_on() {
        let s = TelemetrySpySvc::new_with_inject(true);
        assert!(s.allow_inject());
        let mut stream = s.watch(Request::new(Empty {})).await.unwrap().into_inner();
        s.simulate_hit(Request::new(hit(42))).await.unwrap();
        let got = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .expect("deliver")
            .expect("open")
            .expect("ok");
        assert_eq!(got.ts_ms, 42);
        assert_eq!(s.emitted(), 1);
    }

    #[cfg(feature = "telemetry-spy")]
    #[tokio::test]
    async fn ingest_match_maps_a_domain_match_to_the_watch_stream() {
        use amos_telemetry_spy::identifier::IdentifierKind as DomainKind;
        use amos_telemetry_spy::scanner::ScanHit;
        use amos_telemetry_spy::signal::{
            Direction as Dir, EgressMatch as DomainMatch, Protocol as DProto,
        };

        let m = DomainMatch::from_hits(
            7,
            "rmnet_data0",
            Dir::Unknown,
            "10.0.0.2",
            Some(53000),
            "203.0.113.9",
            Some(53),
            DProto::Udp,
            vec![ScanHit {
                kind: DomainKind::Imei,
                occurrences: 1,
                needle_len: 15,
            }],
            40,
        );

        let s = TelemetrySpySvc::new();
        let mut stream = s.watch(Request::new(Empty {})).await.unwrap().into_inner();
        s.ingest_match(&m);
        let got = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .expect("deliver")
            .expect("open")
            .expect("ok");
        assert_eq!(got.ts_ms, 7);
        assert_eq!(got.iface, "rmnet_data0");
        assert_eq!(got.dst_ip, "203.0.113.9");
        assert_eq!(got.hits[0].kind, IdentifierKind::KindImei as i32);
        assert_eq!(s.emitted(), 1);
    }
}
