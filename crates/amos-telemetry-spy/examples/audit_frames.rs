//! `audit_frames` — the pure decode → scan → signal path, on crafted frames.
//!
//! No interface, no privileges, no libpcap: `match_frame` is exactly what the live
//! `audit`-feature capture loop calls per frame, so scanning synthetic Ethernet/IPv4/UDP
//! frames here pins the same rules. The last frame matches nothing, and the program says
//! "not observed" — which is *not* the same as "not present" (an encrypted flow hides it).
//!
//! Usage:
//! ```text
//! cargo run -p amos-telemetry-spy --example audit_frames
//! ```

use amos_telemetry_spy::{match_frame, Identifier, IdentifierKind};

/// Ethernet + IPv4 + UDP frame carrying `data` as the payload (pure bytes, no NIC).
fn udp_frame(src: [u8; 4], dst: [u8; 4], sport: u16, dport: u16, data: &[u8]) -> Vec<u8> {
    let mut ip = vec![0x45u8, 0];
    ip.extend_from_slice(&((20 + 8 + data.len()) as u16).to_be_bytes());
    ip.extend_from_slice(&[0, 0]);
    ip.extend_from_slice(&[0, 0]);
    ip.push(64);
    ip.push(17); // UDP
    ip.extend_from_slice(&[0, 0]);
    ip.extend_from_slice(&src);
    ip.extend_from_slice(&dst);
    ip.extend_from_slice(&sport.to_be_bytes());
    ip.extend_from_slice(&dport.to_be_bytes());
    ip.extend_from_slice(&((8 + data.len()) as u16).to_be_bytes());
    ip.extend_from_slice(&[0, 0]);
    ip.extend_from_slice(data);

    let mut frame = vec![0u8; 12]; // Ethernet dst + src
    frame.extend_from_slice(&[0x08, 0x00]); // EtherType IPv4
    frame.extend_from_slice(&ip);
    frame
}

fn main() {
    // The watch list: identifiers bound to *this* device.
    let ids = [
        Identifier::ascii(IdentifierKind::Serial, "SERIAL-12345").expect("serial token"),
        Identifier::ascii(IdentifierKind::Imei, "490154203237518").expect("imei token"),
    ];

    let frames: [(&str, Vec<u8>); 3] = [
        (
            "imei in a plaintext payload",
            udp_frame(
                [10, 0, 0, 2],
                [203, 0, 113, 9],
                53000,
                53,
                b"dev=490154203237518&build=1",
            ),
        ),
        (
            "serial in a plaintext payload",
            udp_frame(
                [10, 0, 0, 2],
                [203, 0, 113, 9],
                53001,
                80,
                b"SERIAL-12345 / heartbeat",
            ),
        ),
        (
            "clean frame",
            udp_frame(
                [10, 0, 0, 2],
                [203, 0, 113, 9],
                53002,
                443,
                b"nothing device-bound here",
            ),
        ),
    ];

    for (label, frame) in frames {
        match match_frame("rmnet_data0", &ids, &frame) {
            Some(m) => {
                println!(
                    "{label}: {} -> {}:{} ({})",
                    m.iface,
                    m.dst_ip,
                    m.dst_port
                        .map(|p| p.to_string())
                        .unwrap_or_else(|| "-".to_string()),
                    m.protocol.as_str(),
                );
                println!(
                    "  severity={} confidence={}",
                    m.severity.as_str(),
                    m.confidence.as_str()
                );
                for hit in &m.hits {
                    println!(
                        "  hit: {} x{} (confidence {})",
                        hit.kind.as_str(),
                        hit.occurrences,
                        hit.confidence.as_str(),
                    );
                }
            }
            None => println!("{label}: no identifier observed (not the same as 'not present')"),
        }
    }
}
