//! Tauri ⇄ daemon `TelemetrySpyService.Watch` bridge (high-severity egress hits).
//!
//! The daemon fans out telemetry-spy audit hits on `Watch` (server-streaming);
//! this module opens a **long-lived** watch stream and forwards each hit to the
//! WebView as a `telemetry-spy-hit` event carrying a serializable
//! [`SpyHitPayload`], so the System UI can surface an exfiltration warning live
//! without polling. Mirrors `android_lmk.rs::spawn_lmk_watch` (same socket, same
//! bounded backoff-reconnect) and `telephony.rs::spawn_telephony_watch`.
//!
//! Honest boundaries (see `proto/telemetry_spy.proto`): the payload it forwards
//! is a **low-confidence heuristic** (a plaintext device-bound identifier
//! substring found in an outbound payload), never a claimed confirmed leak. On
//! the default host build the daemon has no capture producer, so this stream is
//! quiet until a real `audit`-feature pnet capture is wired — no fabricated hits.

use amos_proto::amos_telemetry_spy::{
    telemetry_spy_service_client::TelemetrySpyServiceClient, Confidence, EgressHit, Empty,
    IdentifierHit, IdentifierKind, Protocol,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration};

use crate::daemon;

/// Tauri event name carrying one [`SpyHitPayload`] per daemon `Watch` hit.
pub const SPY_HIT_EVENT: &str = "telemetry-spy-hit";

/// One graded identifier hit, serializable for the WebView.
#[derive(Clone, Debug, Serialize)]
pub struct SpyIdentifierHit {
    /// `"serial"` | `"imei"` | `"cell_id"` | `"unknown"`.
    pub kind: String,
    /// How many (non-overlapping) occurrences were seen.
    pub occurrences: u32,
    /// `"low"` | `"medium"` | `"high"` | `"unknown"`.
    pub confidence: String,
}

/// Serializable mirror of one high-severity `EgressHit` (prost structs are not
/// `Serialize`).
#[derive(Clone, Debug, Serialize)]
pub struct SpyHitPayload {
    /// Wall-clock milliseconds (UTC) when the frame was observed.
    pub ts_ms: u64,
    /// The interface the frame was captured on (e.g. `rmnet_data0`).
    pub iface: String,
    /// Source IP text form.
    pub src_ip: String,
    /// Source port, when the transport carried one.
    pub src_port: Option<u16>,
    /// Destination IP text form.
    pub dst_ip: String,
    /// Destination port, when the transport carried one.
    pub dst_port: Option<u16>,
    /// `"tcp"` | `"udp"` | `"icmp"` | `"other"` | `"unknown"`.
    pub protocol: String,
    /// The graded identifier hits.
    pub hits: Vec<SpyIdentifierHit>,
    /// Payload window size that was scanned.
    pub payload_bytes: u64,
    /// Severity (`"high"` for any hit) and strongest evidence grade.
    pub severity: String,
    pub confidence: String,
}

async fn build_spy_client() -> Result<TelemetrySpyServiceClient<tonic::transport::Channel>, String>
{
    Ok(TelemetrySpyServiceClient::new(daemon::channel().await?))
}

fn protocol_str(p: i32) -> String {
    match p {
        p if p == Protocol::Tcp as i32 => "tcp",
        p if p == Protocol::Udp as i32 => "udp",
        p if p == Protocol::Icmp as i32 => "icmp",
        p if p == Protocol::Other as i32 => "other",
        _ => "unknown",
    }
    .to_string()
}

fn confidence_str(c: i32) -> String {
    match c {
        c if c == Confidence::Low as i32 => "low",
        c if c == Confidence::Medium as i32 => "medium",
        c if c == Confidence::High as i32 => "high",
        _ => "unknown",
    }
    .to_string()
}

fn kind_str(k: i32) -> String {
    match k {
        k if k == IdentifierKind::KindSerial as i32 => "serial",
        k if k == IdentifierKind::KindImei as i32 => "imei",
        k if k == IdentifierKind::KindCellId as i32 => "cell_id",
        _ => "unknown",
    }
    .to_string()
}

fn identifier_payload(h: &IdentifierHit) -> SpyIdentifierHit {
    SpyIdentifierHit {
        kind: kind_str(h.kind),
        occurrences: h.occurrences,
        confidence: confidence_str(h.confidence),
    }
}

/// Map a daemon `EgressHit` to the shell-facing payload.
pub fn spy_payload(evt: &EgressHit) -> SpyHitPayload {
    SpyHitPayload {
        ts_ms: evt.ts_ms,
        iface: evt.iface.clone(),
        src_ip: evt.src_ip.clone(),
        src_port: evt.src_port.map(|p| p as u16),
        dst_ip: evt.dst_ip.clone(),
        dst_port: evt.dst_port.map(|p| p as u16),
        protocol: protocol_str(evt.protocol),
        hits: evt.hits.iter().map(identifier_payload).collect(),
        payload_bytes: evt.payload_bytes,
        severity: evt.severity.clone(),
        confidence: confidence_str(evt.confidence),
    }
}

/// Drive one continuous `Watch` round: open the stream and forward each hit to
/// the WebView as `telemetry-spy-hit`. Ends `Ok(())` when the daemon closes the
/// stream (caller reconnects) or `Err` if the daemon is down/errors.
async fn spy_round(app: AppHandle) -> Result<(), String> {
    let mut client = build_spy_client().await?;
    let mut stream = client
        .watch(Empty {})
        .await
        .map_err(|e| format!("telemetry-spy watch open failed: {e}"))?
        .into_inner();
    while let Some(evt) = stream
        .message()
        .await
        .map_err(|e| format!("telemetry-spy watch stream error: {e}"))?
    {
        let _ = app.emit(SPY_HIT_EVENT, spy_payload(&evt));
    }
    Ok(())
}

/// Background task forwarding the daemon `Watch` stream to the WebView for the
/// lifetime of the app. Reconnects with the shared bounded backoff
/// ([`crate::watch_backoff`]) so a late-starting (or restarted) daemon — and a
/// newly wired capture producer — is picked up without a full UI reload.
pub fn spawn_telemetry_spy_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use crate::watch_backoff::{next_backoff_ms, WATCH_BACKOFF_BASE_MS};
        let mut backoff_ms: u64 = WATCH_BACKOFF_BASE_MS;
        loop {
            // `Ok` means the round opened a live stream (daemon reachable) before
            // it ended — reset the backoff so the next reconnect is immediate.
            let connected = spy_round(app.clone()).await.is_ok();
            backoff_ms = next_backoff_ms(backoff_ms, connected);
            sleep(Duration::from_millis(backoff_ms)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit() -> EgressHit {
        EgressHit {
            ts_ms: 123,
            iface: "rmnet_data0".into(),
            src_ip: "10.0.0.2".into(),
            src_port: Some(53000),
            dst_ip: "203.0.113.9".into(),
            dst_port: Some(53),
            protocol: Protocol::Udp as i32,
            hits: vec![IdentifierHit {
                kind: IdentifierKind::KindImei as i32,
                occurrences: 1,
                confidence: Confidence::High as i32,
            }],
            payload_bytes: 40,
            severity: "high".into(),
            confidence: Confidence::High as i32,
        }
    }

    #[test]
    fn maps_a_hit_to_serializable_payload() {
        let p = spy_payload(&hit());
        assert_eq!(p.ts_ms, 123);
        assert_eq!(p.iface, "rmnet_data0");
        assert_eq!(p.src_port, Some(53000));
        assert_eq!(p.dst_port, Some(53));
        assert_eq!(p.protocol, "udp");
        assert_eq!(p.severity, "high");
        assert_eq!(p.confidence, "high");
        assert_eq!(p.hits.len(), 1);
        assert_eq!(p.hits[0].kind, "imei");
        assert_eq!(p.hits[0].confidence, "high");
    }

    #[test]
    fn handles_absent_optional_ports_and_unknown_enum_bits() {
        let mut h = hit();
        h.src_port = None;
        h.dst_port = None;
        h.protocol = 99; // unknown
        h.confidence = 99; // unknown
        h.hits[0].kind = 99; // unknown
        let p = spy_payload(&h);
        assert_eq!(p.src_port, None);
        assert_eq!(p.dst_port, None);
        assert_eq!(p.protocol, "unknown");
        assert_eq!(p.confidence, "unknown");
        assert_eq!(p.hits[0].kind, "unknown");
    }
}
