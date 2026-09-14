//! `call_lifecycle` — a call's whole life, and the emergency rules around it.
//!
//! Walks an outgoing call through the state machine (dialling → active → recording → ended),
//! then does the same for an **emergency** call — where recording is refused outright (there
//! is no consent to give) and where the dial-rate limiter does not apply, because a rate limit
//! must never starve an emergency. The audit log at the end is what a reviewer reads.
//!
//! Usage:
//! ```text
//! cargo run -p amos-telephony --example call_lifecycle
//! ```

use amos_telephony::audit::{AuditEntry, AuditLog, AuditOutcome};
use amos_telephony::rate::DialRateLimiter;
use amos_telephony::route::{guard_emergency, guard_regular, route, DialRoute};
use amos_telephony::{
    CallId, CallSession, CallState, EmergencyMap, EndReason, Number, NumberKind, RecordingState,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The emergency set is locale data, not a string match: this is the map every
    // classification below goes through.
    let map = EmergencyMap::common_global();
    let audit = AuditLog::new();

    // ── an ordinary outgoing call ──────────────────────────────────────────────────────
    let peer = Number::new("13800138000")?;
    println!(
        "dialled number: {} digits={} kind={:?}",
        peer.as_str(),
        peer.digits(),
        peer.kind(&map)
    );

    // Routing decides how the dial goes out; the guard decides whether it may.
    println!("route: {:?}", route(&map, &peer));
    println!("regular guard: {:?}", guard_regular(&map, &peer).is_ok());

    // The rate limiter is per client id; `allow` is false once the window is spent.
    let limiter = DialRateLimiter::per_minute(2);
    for attempt in 1..=3 {
        println!(
            "rate limiter, dial #{attempt}: allowed={}",
            limiter.allow("ui")
        );
    }

    let mut call = CallSession::start_outgoing(CallId::new("call-1"), peer.clone(), false);
    println!(
        "after dial:   {:?} recording={:?}",
        call.state(),
        call.recording()
    );
    call.connect()?;
    println!(
        "after answer: {:?} recording={:?}",
        call.state(),
        call.recording()
    );
    println!("start_recording: {:?}", call.start_recording());
    println!("snapshot: {:?}", call.snapshot());
    println!("stop_recording:  {:?}", call.stop_recording());
    call.end(EndReason::Local)?;
    println!("after hang up: {:?}", call.state());
    audit.record(AuditEntry::new(
        "dial",
        &peer.digits(),
        AuditOutcome::Accepted,
        "ended by the local party",
    ));
    let _ = CallState::Ended;
    let _ = RecordingState::Off;

    // ── an emergency call: classified, routed differently, never recorded ─────────────
    let emergency = Number::new("112")?;
    println!(
        "\nemergency number {} kind={:?}",
        emergency.as_str(),
        emergency.kind(&map)
    );
    println!("route: {:?}", route(&map, &emergency));
    println!(
        "emergency guard: {:?} (an ordinary number is refused on this path)",
        guard_emergency(&map, &emergency).is_ok()
    );
    println!(
        "ordinary number on the emergency path: {:?}",
        guard_emergency(&map, &peer).is_err()
    );
    println!(
        "ordinary number on the regular path:   {:?} (it routes to the emergency path)",
        guard_regular(&map, &emergency).is_err()
    );
    let _ = NumberKind::Emergency;
    let _ = DialRoute::Emergency;

    let mut sos = CallSession::start_outgoing(CallId::new("call-2"), emergency, true);
    sos.connect()?;
    match sos.start_recording() {
        Ok(()) => println!("UNEXPECTED: emergency recording started"),
        Err(e) => println!("emergency start_recording refused: {e}"),
    }
    println!("recording state stays {:?}", sos.recording());
    sos.end(EndReason::Emergency)?;
    audit.record(AuditEntry::new(
        "emergency_dial",
        "112",
        AuditOutcome::Accepted,
        "emergency call ended",
    ));

    println!("\naudit entries (newest first):");
    for entry in audit.entries() {
        println!(
            "  ts={} {} {} -> {:?} ({})",
            entry.ts, entry.operation, entry.detail, entry.outcome, entry.note
        );
    }
    Ok(())
}
