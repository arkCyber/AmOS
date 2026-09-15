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

/// Upper bound on the number of identifier hits one [`SpyHitPayload`] carries.
///
/// Real hits carry 1–4 hits; 64 is a generous ceiling that still refuses a
/// runaway producer (the daemon is the producer today, but the watch stream is
/// a one-way pipe and an upstream bug could otherwise emit a payload with
/// thousands of `IdentifierHit` rows that we then `app.emit` to every window).
pub const MAX_HITS_PER_EVENT: usize = 64;

/// Largest single wire field (bytes) one emitted payload may contain.
///
/// Real IP/iface strings are < 64 B; 4 KiB is a small-known cap that pins the
/// contract — a megabyte-class payload is refused before the JSON serialiser
/// allocates a megabyte-class `String`.
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024;

/// Wire vocabulary for the telemetry-spy module. The UI i18n layer branches
/// on these; renaming a variant is a wire break.
pub mod codes {
    /// `TelemetrySpyService.Watch` could not be opened (daemon down / RPC error).
    pub const WATCH_OPEN_FAILED: &str = "amos.telemetry_spy.watch_open_failed";
    /// The watch stream returned an error mid-flight.
    pub const STREAM_ERROR: &str = "amos.telemetry_spy.stream_error";
    /// A spy hit could not be delivered to the UI.
    pub const EMIT_FAILED: &str = "amos.telemetry_spy.emit_failed";
}

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

async fn build_spy_client(
) -> Result<TelemetrySpyServiceClient<crate::daemon::DaemonChannel>, String> {
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
///
/// The mapping enforces the boundary contracts: identifier-hit list is capped
/// at [`MAX_HITS_PER_EVENT`] (defence against a runaway producer) and any
/// oversized wire field is rejected silently (a megabyte-class IP/iface
/// string is a bug somewhere up the chain).
pub fn spy_payload(evt: &EgressHit) -> SpyHitPayload {
    // Pre-flight check: refuse to even build a payload whose wire fields are
    // larger than the contract permits. The downstream `app.emit` does not
    // refuse JSON for us; a 10 MB iface string would just sit in the IPC queue.
    let field_too_big = |name: &str, len: usize| {
        if len > MAX_PAYLOAD_BYTES {
            tracing::warn!(
                target: "amos::spy",
                field = name,
                bytes = len,
                limit = MAX_PAYLOAD_BYTES,
                code = codes::STREAM_ERROR,
                "dropping an egress hit with an over-sized wire field"
            );
            true
        } else {
            false
        }
    };
    if field_too_big("iface", evt.iface.len())
        || field_too_big("src_ip", evt.src_ip.len())
        || field_too_big("dst_ip", evt.dst_ip.len())
        || field_too_big("severity", evt.severity.len())
    {
        return SpyHitPayload {
            ts_ms: evt.ts_ms,
            iface: String::new(),
            src_ip: String::new(),
            src_port: None,
            dst_ip: String::new(),
            dst_port: None,
            protocol: "unknown".to_string(),
            hits: Vec::new(),
            payload_bytes: evt.payload_bytes,
            severity: "unknown".to_string(),
            confidence: "unknown".to_string(),
        };
    }

    let hits: Vec<SpyIdentifierHit> = evt
        .hits
        .iter()
        .take(MAX_HITS_PER_EVENT)
        .map(identifier_payload)
        .collect();
    SpyHitPayload {
        ts_ms: evt.ts_ms,
        iface: evt.iface.clone(),
        src_ip: evt.src_ip.clone(),
        src_port: evt.src_port.map(|p| p as u16),
        dst_ip: evt.dst_ip.clone(),
        dst_port: evt.dst_port.map(|p| p as u16),
        protocol: protocol_str(evt.protocol),
        hits,
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
        .map_err(|e| {
            // Stable code on the *log* line — the function still returns a
            // String for backoff-loop compat; the code is documented at the
            // module's `codes` re-export.
            tracing::warn!(
                target: "amos::spy",
                code = codes::WATCH_OPEN_FAILED,
                error = %e,
                "telemetry-spy watch open failed"
            );
            format!("telemetry-spy watch open failed: {e}")
        })?
        .into_inner();
    while let Some(evt) = stream.message().await.map_err(|e| {
        tracing::warn!(
            target: "amos::spy",
            code = codes::STREAM_ERROR,
            error = %e,
            "telemetry-spy watch stream error"
        );
        format!("telemetry-spy watch stream error: {e}")
    })? {
        // A failed delivery means a registered spy listener missed this hit (no listener is
        // `Ok` in Tauri) — the privacy surface would silently stay quiet.
        if let Err(e) = app.emit(SPY_HIT_EVENT, spy_payload(&evt)) {
            tracing::warn!(
                target: "amos::spy",
                event = SPY_HIT_EVENT,
                code = codes::EMIT_FAILED,
                error = %e,
                "telemetry-spy hit could not be delivered to the UI"
            );
        }
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
        // Runs for the lifetime of the app: the loop has no exit and is aborted with
        // the Tauri runtime when the app stops. `sleep()` is the wait (never a spin).
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

    #[test]
    fn payload_caps_hits_at_the_documented_bound() {
        // A runaway producer with thousands of identifier hits would otherwise
        // emit a megabyte-class JSON payload. The cap is here so the
        // privacy UI receives a small known shape.
        let mut h = hit();
        h.hits = (0..MAX_HITS_PER_EVENT + 50)
            .map(|_| IdentifierHit {
                kind: IdentifierKind::KindSerial as i32,
                occurrences: 1,
                confidence: Confidence::Low as i32,
            })
            .collect();
        let p = spy_payload(&h);
        assert_eq!(p.hits.len(), MAX_HITS_PER_EVENT);
    }

    #[test]
    fn payload_refuses_an_oversized_wire_field_instead_of_emit_blasting_it() {
        // A 10 MiB `iface` string is a bug up the chain; the bridge drops the
        // hit's fields rather than pass a megabyte-class payload through to
        // `app.emit` (which would just queue it in the IPC pipe).
        let mut h = hit();
        h.iface = "x".repeat(MAX_PAYLOAD_BYTES + 1);
        let p = spy_payload(&h);
        assert_eq!(p.iface, "", "the bad field is dropped");
        assert_eq!(p.src_ip, "", "the rest of the hit is also dropped");
        assert_eq!(p.severity, "unknown");
        assert!(p.hits.is_empty());
    }

    #[test]
    fn telemetry_spy_codes_are_stable_string_keys() {
        assert_eq!(
            codes::WATCH_OPEN_FAILED,
            "amos.telemetry_spy.watch_open_failed"
        );
        assert_eq!(codes::STREAM_ERROR, "amos.telemetry_spy.stream_error");
        assert_eq!(codes::EMIT_FAILED, "amos.telemetry_spy.emit_failed");
    }
}
