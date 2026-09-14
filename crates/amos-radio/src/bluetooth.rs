//! Bluetooth **details** beyond the on/off bit: the adapter's own name and the
//! devices it has paired with (REQ-A199).
//!
//! Why this module exists: the radio toggle ([`crate::state`], [`crate::manager`])
//! answers "is Bluetooth on?". A settings screen shows two more facts *about* the
//! adapter — what it calls itself and which devices it is paired with — and before
//! this module the screen had nowhere to get them: `lib/bluetooth.ts` kept a name in
//! the durable store and presented it in the same row shape as a real radio switch,
//! so "this device is called X" and "discoverable: on" read as device state while
//! nothing ever reached the adapter.
//!
//! What lives here is only the transport-agnostic part (the type + the pure name
//! rules), so the rules are unit-testable on the host and identical for the Mock and
//! the real backend. The platform calls are in `android.rs`.
//!
//! **Platform facts this module is shaped by** (verified with `javap` against this
//! machine's `android-34` / `android-36` `android.jar`s — see `docs/radio.md` §10):
//! * `BluetoothAdapter#getName` / `#setName` / `#getBondedDevices` and
//!   `BluetoothDevice#getBondState`/`createBond` are **public SDK**, reachable from
//!   the System UI with `BLUETOOTH_CONNECT`.
//! * `BluetoothAdapter#setScanMode` (make this device discoverable) and
//!   `BluetoothDevice#removeBond` (unpair) are **not** in the public SDK. So AmOS
//!   cannot apply discoverability or unpair, and no layer here pretends otherwise:
//!   those two are platform limits, documented in the UI and in the docs.

use crate::error::{RadioError, Result};

/// The longest Bluetooth device name the platform accepts: the name field in the
/// Bluetooth spec is 248 bytes and `BluetoothAdapter#setName` truncates to it.
pub const MAX_LOCAL_NAME_BYTES: usize = 248;

/// `BluetoothDevice#BOND_NONE` — not paired (10).
pub const BOND_NONE: i32 = 10;

/// `BluetoothDevice#BOND_BONDING` — a pairing flow is in progress (11). This is the
/// state a screen needs to show "pairing…" instead of silence: `ACTION_BOND_STATE_CHANGED`
/// goes to `BOND_BONDING` and only *then* to `BOND_BONDED` or back to `BOND_NONE`.
pub const BOND_BONDING: i32 = 11;

/// `BluetoothDevice#BOND_BONDED` — paired (12).
///
/// The previous revision of this comment claimed "11 = none, 12 = bonded, 13 =
/// bonding", which is off by one in two places (Android's real values are 10 / 11 /
/// 12). It matters now that the *raw* state crosses the JNI boundary: a screen that
/// read the comment instead of the platform would have labelled a bonding device as
/// paired. The values are pinned by a unit test against the SDK.
pub const BOND_BONDED: i32 = 12;

/// A device the adapter is paired with (`BluetoothAdapter#getBondedDevices`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtPeer {
    /// The device's MAC address — the adapter's stable identity for it, and the
    /// only field the platform always has.
    pub address: String,
    /// The name the device reports; empty when the platform has none.
    pub name: String,
}

impl BtPeer {
    /// Build a peer, trimming both fields (a `null` name from the platform reads as
    /// empty here rather than as the literal `"null"`).
    pub fn new(address: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            address: address.into().trim().to_string(),
            name: name.into().trim().to_string(),
        }
    }

    /// What to show for this peer: its name, or its address when it has none — a
    /// row with a blank label would be a device the user cannot identify.
    pub fn display_name(&self) -> &str {
        if self.name.is_empty() {
            &self.address
        } else {
            &self.name
        }
    }
}

/// Validate and normalize a new adapter name (pure, so the rules hold on the host
/// too — the same reason `RadioManager` owns the radio policy).
///
/// * A blank name is refused: `setName` would leave the adapter advertising nothing
///   a user can recognise, and this repo's rule is that an action which cannot
///   honestly succeed is refused *with a reason* instead of being reported as
///   applied (REQ-A184).
/// * The name is truncated to [`MAX_LOCAL_NAME_BYTES`] **on a char boundary**. The
///   platform truncates in bytes; doing it here keeps what the user typed, what the
///   adapter reports back, and what the store remembers identical — and never ends
///   a multi-byte name in a broken code point.
pub fn normalize_local_name(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(RadioError::Provider(
            "refusing to set a blank Bluetooth name".to_string(),
        ));
    }
    Ok(truncate_bytes(trimmed, MAX_LOCAL_NAME_BYTES))
}

/// A device seen by a Bluetooth **scan** (REQ-A200).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtScanDevice {
    /// MAC address — the platform's identity for the device (always present).
    pub address: String,
    /// The name the device advertises; empty when it has none (or when
    /// `BLUETOOTH_CONNECT` is missing, in which case the row falls back to the address).
    pub name: String,
    /// Signal strength in dBm, when the platform reported one.
    pub rssi: Option<i32>,
    /// The **raw** bond state ([`BOND_NONE`] / [`BOND_BONDING`] / [`BOND_BONDED`]).
    ///
    /// Raw, not a bool: collapsing "pairing is in progress" into "not paired" is what
    /// made a pair request look like nothing had happened (REQ-A201). A screen needs
    /// the three states apart — it offers "pair" on `NONE`, shows progress on
    /// `BONDING`, and a tag on `BONDED`.
    pub bond: i32,
    /// Seen over a **Bluetooth LE** advertisement (`BluetoothLeScanner`). Classic
    /// (BR/EDR) discovery and LE scanning are two different radios with two different
    /// result streams, and a device may well answer on both — the row says which
    /// channels saw it instead of pretending there is only one kind of scan.
    pub le: bool,
}

impl BtScanDevice {
    /// What to show for this row: its name, or its address when it has none.
    pub fn display_name(&self) -> &str {
        if self.name.is_empty() {
            &self.address
        } else {
            &self.name
        }
    }

    /// Paired (`BOND_BONDED`).
    pub fn is_bonded(&self) -> bool {
        self.bond == BOND_BONDED
    }

    /// A pairing flow is running (`BOND_BONDING`).
    pub fn is_bonding(&self) -> bool {
        self.bond == BOND_BONDING
    }
}

/// One address whose bond state changed during this scan session (REQ-A201).
///
/// Why this exists next to [`BtScanDevice::bond`]: `ACTION_BOND_STATE_CHANGED` is
/// delivered for the device the user is pairing with, and that device may not be in
/// the current result list at all — a scan was restarted, it stopped advertising, or
/// (measured on the S5) it was never there because the address came from the caller.
/// Dropping those transitions — the first version of the glue did exactly that, it
/// only updated entries already in the list — means a request that the framework
/// really did run (`BOND_STATE_BONDING` → `BOND_STATE_NONE` in `dumpsys`) left no
/// trace anywhere the screen could read. So the session keeps its own record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtBond {
    pub address: String,
    pub state: i32,
}

/// One scan's state: whether it is running, on which **transports**, whether the
/// result list was **capped**, whether the app may scan at all, what it found, and
/// the bond-state changes seen while it was running (REQ-A200).
///
/// `scan_allowed == false` is deliberately distinct from an empty `devices`: "this app
/// may not look" and "nothing is nearby" are different facts, and only the second one
/// may be shown as an empty list. `classic` / `le` carry the same distinction one level
/// down: "no devices" must not be reported on a channel that was never scanned.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BtScan {
    pub discovering: bool,
    /// Classic (BR/EDR) discovery is running (`BluetoothAdapter#isDiscovering`).
    pub classic: bool,
    /// A Bluetooth LE scan is running (`BluetoothLeScanner#startScan`).
    pub le: bool,
    /// The platform-side cap was hit, so the list is **partial** and must not be
    /// presented as complete (`DevCareGlue`'s "refuse, never trim" rule, one layer up).
    pub capped: bool,
    pub scan_allowed: bool,
    pub devices: Vec<BtScanDevice>,
    /// Bond transitions seen during this session, keyed by address (see [`BtBond`]).
    pub bonds: Vec<BtBond>,
}

impl BtScan {
    /// The bond state for `address`: the **session record** when there is one, else the
    /// device's own last-reading. The session record wins because a transition is
    /// newer than the reading a row was built from.
    pub fn bond_state(&self, address: &str) -> Option<i32> {
        self.bonds
            .iter()
            .find(|b| b.address == address)
            .map(|b| b.state)
            .or_else(|| {
                self.devices
                    .iter()
                    .find(|d| d.address == address)
                    .map(|d| d.bond)
            })
    }

    /// `true` while a pairing flow for `address` is in progress (`BOND_BONDING`).
    pub fn is_pairing(&self, address: &str) -> bool {
        self.bond_state(address) == Some(BOND_BONDING)
    }

    /// `true` when `address` is paired (`BOND_BONDED`) according to this scan.
    pub fn is_bonded(&self, address: &str) -> bool {
        self.bond_state(address) == Some(BOND_BONDED)
    }
}

/// Truncate `s` to at most `max` bytes without splitting a UTF-8 code point.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_trims_and_falls_back_to_the_address_for_display() {
        let p = BtPeer::new("  AA:BB:CC:DD:EE:FF  ", "  AirPods Pro  ");
        assert_eq!(p.address, "AA:BB:CC:DD:EE:FF");
        assert_eq!(p.name, "AirPods Pro");
        assert_eq!(p.display_name(), "AirPods Pro");

        // A device the platform never named still gets a usable row label.
        let unnamed = BtPeer::new("AA:BB:CC:DD:EE:FF", "");
        assert_eq!(unnamed.display_name(), "AA:BB:CC:DD:EE:FF");
    }

    #[test]
    fn blank_name_is_refused_not_silently_accepted() {
        for blank in ["", "   ", "\t\n"] {
            assert!(
                matches!(normalize_local_name(blank), Err(RadioError::Provider(_))),
                "a blank name must be refused ({blank:?})"
            );
        }
    }

    #[test]
    fn name_is_trimmed_and_kept_when_short_enough() {
        assert_eq!(normalize_local_name("  My Phone  ").unwrap(), "My Phone");
        let exactly = "x".repeat(MAX_LOCAL_NAME_BYTES);
        assert_eq!(normalize_local_name(&exactly).unwrap(), exactly);
    }

    #[test]
    fn over_long_name_is_truncated_on_a_char_boundary() {
        // 3-byte code points: 248 is not a multiple of 3, so a byte-wise truncation
        // would split the last one — the boundary walk must drop it instead.
        let name = "中".repeat(100); // 300 bytes
        let out = normalize_local_name(&name).unwrap();
        assert!(out.len() <= MAX_LOCAL_NAME_BYTES);
        assert_eq!(out.len(), 246, "82 whole code points fit in 248 bytes");
        assert!(out.chars().all(|c| c == '中'));
        // And a 2-byte boundary case: 247 bytes of ASCII + one 2-byte char.
        let mixed = format!("{}{}", "a".repeat(247), "é");
        let out = normalize_local_name(&mixed).unwrap();
        assert_eq!(out.len(), 247);
        assert!(out.ends_with('a'));
    }

    #[test]
    fn bond_constants_match_the_platform_values() {
        // Pinned so the Android bridge cannot drift silently: `BluetoothDevice`'s bond
        // states are BOND_NONE = 10, BOND_BONDING = 11, BOND_BONDED = 12. The comment
        // this replaced had 11/12/13 — a screen that trusted it would have shown a
        // *bonding* device as paired (REQ-A201).
        assert_eq!((BOND_NONE, BOND_BONDING, BOND_BONDED), (10, 11, 12));
    }

    #[test]
    fn scan_device_falls_back_to_the_address_and_keeps_the_rssi_optional() {
        let named = BtScanDevice {
            address: "AA:BB".into(),
            name: "Buds".into(),
            rssi: Some(-61),
            bond: BOND_BONDED,
            le: false,
        };
        assert_eq!(named.display_name(), "Buds");
        assert!(named.is_bonded() && !named.is_bonding());

        // A device with no advertised name (or a refused name read) still gets a
        // usable row label; `rssi: None` means "the platform did not report one".
        let unnamed = BtScanDevice {
            address: "AA:BB".into(),
            name: String::new(),
            rssi: None,
            bond: BOND_NONE,
            le: true,
        };
        assert_eq!(unnamed.display_name(), "AA:BB");
        assert!(!unnamed.is_bonded() && !unnamed.is_bonding());
    }

    #[test]
    fn a_bonding_device_is_not_a_paired_one() {
        // The whole point of carrying the raw state: "pairing is in progress" is a
        // third answer, and both a screen and a test must be able to tell it from
        // "paired" and from "nothing happened".
        let bonding = BtScanDevice {
            address: "AA:BB".into(),
            name: String::new(),
            rssi: None,
            bond: BOND_BONDING,
            le: false,
        };
        assert!(bonding.is_bonding() && !bonding.is_bonded());
    }

    #[test]
    fn a_session_bond_record_beats_the_stale_row_reading() {
        // A row is built when the device was heard; the transition arrives later. If
        // the row won, a completed pairing would be reported as "not paired" until the
        // device advertised again.
        let scan = BtScan {
            discovering: true,
            classic: true,
            le: true,
            capped: false,
            scan_allowed: true,
            devices: vec![BtScanDevice {
                address: "AA:BB".into(),
                name: "Buds".into(),
                rssi: Some(-60),
                bond: BOND_NONE,
                le: false,
            }],
            bonds: vec![BtBond {
                address: "AA:BB".into(),
                state: BOND_BONDED,
            }],
        };
        assert_eq!(scan.bond_state("AA:BB"), Some(BOND_BONDED));
        assert!(scan.is_bonded("AA:BB"));
        // A device with no record at all answers "unknown", never a made-up state.
        assert_eq!(scan.bond_state("CC:DD"), None);
        assert!(!scan.is_bonded("CC:DD") && !scan.is_pairing("CC:DD"));
    }

    #[test]
    fn a_default_scan_claims_nothing() {
        // The honest baseline: an empty `BtScan` claims nothing — not discovering, no
        // transport searched, not capped, and **not allowed to scan** — so a screen that
        // has not asked the device yet cannot render "nothing nearby".
        let s = BtScan::default();
        assert!(!s.discovering && !s.capped && !s.scan_allowed);
        assert!(!s.classic && !s.le);
        assert!(s.devices.is_empty() && s.bonds.is_empty());
    }
}
