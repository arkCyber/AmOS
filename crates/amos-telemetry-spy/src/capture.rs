//! **`audit`-feature only** — live passive capture on a data interface.
//!
//! Opens a raw datalink channel (via `pnet`) on one interface (e.g.
//! `rmnet_data0`), decodes each frame with the pure [`crate::packet`] parser,
//! runs the [`crate::scanner`] heuristic, and emits an [`EgressMatch`] for every
//! positive hit. The capture loop is **blocking** (pnet's receiver is blocking),
//! so callers drive it on a dedicated OS thread / `spawn_blocking` inside the
//! existing Tokio runtime — [`spawn_stream`] does exactly that and hands back a
//! Tokio `mpsc` receiver a daemon can turn into a gRPC server-streaming warning.
//!
//! Honest status — **device seam** (mirrors `amos-network-guard`'s vpn/nftables):
//! opening a raw datalink channel requires a rooted / AmOS-AOSP slot with raw
//! socket privilege; on a stock device this fails explicitly with
//! [`Error::NotOnDevice`]-style I/O. Compiling this module (`cargo check
//! --features audit`) is **not** proof the device gate works.

use std::io::{Error as IoError, ErrorKind as IoErrorKind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pnet::datalink::{self, Channel, Config, DataLinkReceiver, NetworkInterface};

use crate::analyze::match_frame;
use crate::error::{Error, Result};
use crate::identifier::Identifier;
use crate::signal::EgressMatch;

/// Everything the live capture loop needs.
#[derive(Clone, Debug)]
pub struct CaptureCfg {
    /// Interface name to sniff, e.g. `rmnet_data0` (or `en0` on a macOS host).
    pub iface: String,
    /// Capture IPv4 at the network layer (for Layer-3-only data interfaces).
    /// Defaults to `false` = Layer 2 (ethernet/cooked frames, both families
    /// where the backend supports it).
    pub layer3_ipv4: bool,
}

impl CaptureCfg {
    /// Build a Layer-2 capture config for one interface.
    pub fn new(iface: impl Into<String>) -> Result<CaptureCfg> {
        let name = iface.into();
        if name.is_empty() {
            return Err(Error::InvalidArgument("interface must be non-empty".into()));
        }
        Ok(CaptureCfg {
            iface: name,
            layer3_ipv4: false,
        })
    }

    /// Switch to IPv4 network-layer capture (for `rmnet`-style L3 interfaces).
    pub fn layer3_ipv4(mut self) -> Self {
        self.layer3_ipv4 = true;
        self
    }
}

/// Names of the interfaces `pnet` can enumerate on this host (device bring-up
/// probe — list them to confirm `rmnet_data0` is present and capturable).
pub fn list_interfaces() -> Result<Vec<String>> {
    Ok(datalink::interfaces().into_iter().map(|i| i.name).collect())
}

fn find_iface(name: &str) -> Result<NetworkInterface> {
    datalink::interfaces()
        .into_iter()
        .find(|i| i.name == name)
        .ok_or_else(|| Error::InterfaceNotFound(name.to_string()))
}

fn open_receiver(
    iface: &NetworkInterface,
    layer3_ipv4: bool,
) -> std::io::Result<Box<dyn DataLinkReceiver>> {
    let config = Config {
        channel_type: if layer3_ipv4 {
            // EtherType is a plain u16; 0x0800 == IPv4.
            pnet::datalink::ChannelType::Layer3(0x0800)
        } else {
            pnet::datalink::ChannelType::Layer2
        },
        ..Config::default()
    };
    match datalink::channel(iface, config)? {
        // pnet 0.35 exposes a single, non-exhaustive channel variant; the
        // backend decides the actual framing from `config.channel_type`.
        Channel::Ethernet(_tx, rx) => Ok(rx),
        _ => Err(IoError::new(
            IoErrorKind::Unsupported,
            "pnet returned an unexpected datalink channel",
        )),
    }
}

/// The blocking capture loop. Runs until `stop` is set. Every frame whose
/// payload contains a watch-list identifier is passed to `emit` as an
/// [`EgressMatch`]. Call on a dedicated thread / `spawn_blocking`.
pub fn run_blocking(
    cfg: &CaptureCfg,
    stop: &AtomicBool,
    ids: &[Identifier],
    emit: &mut dyn FnMut(EgressMatch),
) -> Result<()> {
    let iface = find_iface(&cfg.iface)?;
    let mut rx = open_receiver(&iface, cfg.layer3_ipv4).map_err(Error::Io)?;
    let iface_name = iface.name.clone();
    while !stop.load(Ordering::Relaxed) {
        let frame = match rx.next() {
            Ok(frame) => frame,
            Err(e) => return Err(Error::Io(e)),
        };
        if let Some(m) = match_frame(&iface_name, ids, frame) {
            emit(m);
        }
    }
    Ok(())
}

/// Spawn the capture loop on a dedicated blocking task of the **current** Tokio
/// runtime and return an `mpsc` receiver of matches. Call from within a Tokio
/// runtime (e.g. the daemon's existing runtime). `stop` lets a caller terminate
/// the loop; dropping all receivers also stops sends gracefully.
///
/// Fails **synchronously** (with [`Error`]) if the interface does not exist or
/// no datalink channel can be opened, so a caller never receives a stream that
/// silently produces nothing — mirroring the crate's no-fake-success rule.
pub fn spawn_stream(
    cfg: CaptureCfg,
    stop: Arc<AtomicBool>,
    ids: Vec<Identifier>,
) -> std::result::Result<tokio::sync::mpsc::Receiver<EgressMatch>, Error> {
    let rt = tokio::runtime::Handle::current();
    // Synchronously validate the interface exists and a datalink channel can be
    // opened BEFORE handing back a receiver, so a caller never gets a stream
    // that silently never produces (no fabricated success). The probe channel
    // is dropped; the real one is opened on the blocking task that owns it.
    let probe_iface = find_iface(&cfg.iface)?;
    let _probe_rx = open_receiver(&probe_iface, cfg.layer3_ipv4).map_err(Error::Io)?;

    let (tx, rx) = tokio::sync::mpsc::channel(256);
    rt.spawn_blocking(move || {
        let _ = run_blocking(&cfg, &stop, &ids, &mut |m| {
            // Best-effort: a full queue just drops; capture must never block.
            let _ = tx.blocking_send(m);
        });
    });
    Ok(rx)
}

#[cfg(all(test, feature = "audit"))]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn spawn_stream_rejects_missing_interface_synchronously() {
        // A bogus interface must surface as an error from `spawn_stream` right
        // away, not as a receiver that silently never yields (no fake success).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let cfg = CaptureCfg::new("definitely-not-an-iface-zz").unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let res = spawn_stream(cfg, stop, Vec::new());
            assert!(res.is_err(), "missing interface should error at spawn time");
        });
    }
}
