//! Blocking console demo of the live capture (`audit` feature).
//!
//! Lists capturable interfaces, then sniffs the chosen one (default: the first
//! enumerated, or pass one as the first argument, e.g. `rmnet_data0`) for the
//! synthetic [`MockIdentity`] sample identifiers and prints every hit.
//!
//! ```text
//! cargo run -p amos-telemetry-spy --example live_spy --features audit -- [iface]
//! ```
//!
//! This needs a raw-socket slot (rooted / AmOS-AOSP); on a stock host opening a
//! NIC will fail explicitly rather than pretend. Compiling != device-validated.

use amos_telemetry_spy::capture::{list_interfaces, run_blocking, CaptureCfg};
use amos_telemetry_spy::{DeviceIdentity, EgressMatch, MockIdentity, Result};
use std::sync::atomic::AtomicBool;

fn main() -> Result<()> {
    let interfaces = list_interfaces()?;
    println!("capturable interfaces: {interfaces:?}");

    let args: Vec<String> = std::env::args().skip(1).collect();
    let iface = args
        .first()
        .cloned()
        .or_else(|| interfaces.first().cloned())
        .unwrap_or_default();
    if iface.is_empty() {
        eprintln!("no interfaces to sniff; try: live_spy rmnet_data0");
        return Ok(());
    }

    let ids = MockIdentity.identifiers();
    println!(
        "sniffing {iface} for {} synthetic identifier(s); Ctrl+C to stop",
        ids.len()
    );

    let stop = AtomicBool::new(false);
    let cfg = CaptureCfg::new(iface)?;
    let mut sink = |m: EgressMatch| print_match(&m);
    run_blocking(&cfg, &stop, &ids, &mut sink)
}

fn print_match(m: &EgressMatch) {
    println!(
        "[{}] t={} {protocol} {src}:{sp} -> {dst}:{dp} hits={hits} conf={conf}",
        m.iface,
        m.ts_ms,
        protocol = m.protocol.as_str(),
        src = m.src_ip,
        sp = port_str(m.src_port),
        dst = m.dst_ip,
        dp = port_str(m.dst_port),
        hits = m
            .hits
            .iter()
            .map(|h| format!("{}x{}", h.kind.as_str(), h.occurrences))
            .collect::<Vec<_>>()
            .join(","),
        conf = m.confidence.as_str(),
    );
}

fn port_str(p: Option<u16>) -> String {
    p.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string())
}
