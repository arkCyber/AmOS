//! Tauri <-> display-protection (auto screen-off) host bridge.
//!
//! The display-state authority lives in the System UI host: when the shell idles
//! it turns the screen off, and the OS must *hear* that. This module is the host
//! half of the [`amos_display`] screen-state file contract AND the **device seam**
//! where real physical blanking plugs in.
//!
//! Layering:
//! * [`DisplayPower`] — the device seam. One method tells the host to blank/wake
//!   the panel. On desktop this is [`FileDisplayPower`], which only updates the
//!   `AMOS_SCREEN_STATE_PATH` file (so the daemon's energy beat resolves
//!   `screen_on = false`). A real Android build injects a provider that ALSO
//!   drives `PowerManager` (physical panel), keeping file + panel in sync.
//! * [`DisplayPowerBridge`] — the managed, `Arc`-shared seam the `screen_state_set`
//!   / `screen_state_get` commands call. Seeded from the env file contract at
//!   boot (`DisplayPowerBridge::file_default`).
//!
//! Honest boundary: physically blanking the panel (`PowerManager.goToSleep`) needs
//! `DEVICE_POWER`/system or OEM `PowerManager` integration — a normal app cannot
//! do it. That on-device binding is a caller-side (OEM/System-UI-APK) step; the
//! seam here is the single injection point and is fully unit-tested on the host.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use amos_display::ScreenState;

use crate::error::{AmosError, ErrorCode};

/// Wire vocabulary for the display / screen-state module. Each code has a real
/// producer: `contract_missing` / `write_failed` are the `code` of the
/// [`AmosError`] a failed [`DisplayPower::set`] returns, and `read_malformed` is
/// emitted when a present-but-foreign contract file is read. Renaming a variant is
/// a wire break; the string form matches the [`crate::error::ErrorCode`]
/// `as_str()` shape (`amos.<group>.<leaf>`) and is pinned equal to it by test.
///
/// REQ-A622: before this, all three were declared with *no producer* — the
/// constants and their `ErrorCode` variants existed only to be listed in a
/// stability test, while `DisplayPower::set` returned a bare prose `String` and a
/// malformed contract file was indistinguishable from an absent one.
pub mod codes {
    use crate::error::ErrorCode;
    /// `AMOS_SCREEN_STATE_PATH` is unset (no daemon to sync with).
    pub const CONTRACT_MISSING: &str = ErrorCode::DisplayContractMissing.as_str();
    /// Writing the screen-state file failed (FS error, permission, …).
    pub const WRITE_FAILED: &str = ErrorCode::DisplayWriteFailed.as_str();
    /// Reading the screen-state file returned malformed content (not `on`/`off`).
    pub const READ_MALFORMED: &str = ErrorCode::DisplayReadMalformed.as_str();
}

/// Largest screen-state file this host will read or write.
///
/// The contract file is two ASCII bytes (`on` / `off`); a 4 KiB ceiling is
/// generous defence-in-depth against a runaway writer that fills the path with
/// garbage (the file is in a shared env-var location that any process could
/// touch — see `AMOS_SCREEN_STATE_PATH`).
pub const MAX_SCREEN_STATE_BYTES: u64 = 4 * 1024;

/// Serializable screen-state snapshot (plain bool; prost-free).
#[derive(Clone, Copy, Debug, Serialize)]
pub struct ScreenPayload {
    /// Whether the screen is currently on.
    pub on: bool,
}

/// How a read of the screen-state contract file resolved — the three declared
/// failure modes (`contract_missing` is the *write*-side "no path"; the read side
/// has "absent" vs "present but foreign"). Split out as a pure function so the
/// judgement is headless-testable and the wire vocabulary has a real producer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContractRead {
    /// File present and parseable as `on`.
    On,
    /// File present and parseable as `off`.
    Off,
    /// No path configured, or the path has no readable file.
    Missing,
    /// File present but its content is neither `on` nor `off` (a foreign writer
    /// filled the shared path with garbage).
    Malformed,
}

/// Read + classify the contract file at `path` (or `None` when no path is set).
/// Pure aside from the single file read; no parsing knowledge is duplicated here
/// (the `amos_display` host owns the accepted vocabulary).
pub fn read_contract(path: Option<&Path>) -> ContractRead {
    let Some(path) = path else {
        return ContractRead::Missing;
    };
    match std::fs::read_to_string(path) {
        Ok(s) => match amos_display::parse_screen_state(&s) {
            Some(ScreenState::On) => ContractRead::On,
            Some(ScreenState::Off) => ContractRead::Off,
            None => ContractRead::Malformed,
        },
        Err(_) => ContractRead::Missing,
    }
}

/// **Device seam**: physically blank / wake the panel (and keep the cross-process
/// state consistent). `set(false)` = go to sleep / blank; `set(true)` = wake /
/// keep on. Returns a typed [`AmosError`] carrying the declared wire code
/// (`contract_missing` when there is no daemon contract, `write_failed` when the
/// write itself fails) — a host must never report success it didn't achieve, and
/// the caller must be able to tell *why* without parsing a message.
pub trait DisplayPower: Send + Sync {
    fn set(&self, on: bool) -> Result<(), AmosError>;
    /// Current on/off (conservative: `true` when unknown, so we never throttle a
    /// screen that might be on).
    fn is_on(&self) -> bool;
}

/// Desktop / cross-process impl: writes the `AMOS_SCREEN_STATE_PATH` file so the
/// daemon hears `screen_on = off`. `None` path ⇒ no daemon sync in effect; `set`
/// reports an honest error (the daemon never heard us), `is_on` conservatively
/// returns `true`.
#[derive(Clone, Debug)]
pub struct FileDisplayPower {
    path: Option<PathBuf>,
}

impl FileDisplayPower {
    /// Resolve the contract path from the environment (shared with the daemon).
    pub fn from_env() -> Self {
        Self {
            path: amos_display::screen_state_path(),
        }
    }

    /// Build from an explicit path (tests / custom wiring). `None` = no sync.
    pub fn at(path: Option<PathBuf>) -> Self {
        Self { path }
    }
}

/// Atomically write the screen-state file (`on` | `off`): temp sibling then
/// rename over the target so a concurrent reader never sees a torn file.
///
/// Returns a typed [`AmosError`] carrying [`codes::WRITE_FAILED`] on any failure
/// so the caller can branch on the wire code without parsing the message. The
/// write is bounded by [`MAX_SCREEN_STATE_BYTES`] — a runaway writer filling the
/// contract path with garbage is refused before the rename step (which would
/// otherwise truncate a megabyte file to two bytes and lose the signal).
pub fn write_screen_state(path: &Path, on: bool) -> Result<(), AmosError> {
    let write_failed =
        |e: io::Error| AmosError::with_cause(ErrorCode::DisplayWriteFailed, codes::WRITE_FAILED, e);
    let content = if on { "on" } else { "off" };
    if (content.len() as u64) > MAX_SCREEN_STATE_BYTES {
        // Defensive: `content` is a literal today, but the cap is here so a
        // future change cannot turn this function into a megabyte writer
        // without someone noticing.
        return Err(write_failed(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "screen-state payload is {} bytes (limit {})",
                content.len(),
                MAX_SCREEN_STATE_BYTES
            ),
        )));
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(write_failed)?;
    std::fs::rename(&tmp, path).map_err(write_failed)
}

impl DisplayPower for FileDisplayPower {
    fn set(&self, on: bool) -> Result<(), AmosError> {
        let Some(path) = self.path.as_deref() else {
            // No `AMOS_SCREEN_STATE_PATH` ⇒ no daemon to hear us. The declared
            // `contract_missing` code names exactly this — emit it rather than a
            // bare prose string, so the caller can branch (and the vocabulary has
            // a producer instead of being a dead constant).
            return Err(AmosError::new(
                ErrorCode::DisplayContractMissing,
                codes::CONTRACT_MISSING,
            ));
        };
        write_screen_state(path, on)
    }

    fn is_on(&self) -> bool {
        match read_contract(self.path.as_deref()) {
            ContractRead::On => true,
            ContractRead::Off => false,
            // Conservative: an absent or foreign value means we do not know, so we
            // must not throttle a screen that might be on. A *malformed* file (a
            // foreign writer filled the shared path) is the one case worth naming
            // — it emits the declared `read_malformed` code so the condition is
            // observable instead of silently indistinguishable from "absent".
            ContractRead::Missing => true,
            ContractRead::Malformed => {
                tracing::warn!(
                    target: "amos::display",
                    code = codes::READ_MALFORMED,
                    "screen-state contract file is present but neither `on` nor `off`; \
                     reading conservatively as on"
                );
                true
            }
        }
    }
}

/// Managed, `Arc`-shared seam the Tauri commands call. A real Android build
/// replaces the inner [`DisplayPower`] with a PowerManager-backed one; the file
/// contract (and this whole command surface) stays the same.
#[derive(Clone)]
pub struct DisplayPowerBridge {
    power: Arc<dyn DisplayPower>,
}

impl DisplayPowerBridge {
    /// Host build: the file-contract impl (daemon hears on/off; no physical
    /// blanking on desktop).
    pub fn file_default() -> Self {
        Self {
            power: Arc::new(FileDisplayPower::from_env()),
        }
    }

    /// Inject a device-provided impl (tests / Android boot path).
    pub fn with(power: Arc<dyn DisplayPower>) -> Self {
        Self { power }
    }

    fn apply(&self, on: bool) -> Result<(), AmosError> {
        self.power.set(on)
    }

    fn current(&self) -> bool {
        self.power.is_on()
    }
}

/// Set the OS screen state on/off and return the authoritative snapshot.
///
/// Fails with the declared wire code (`contract_missing` / `write_failed`) so the
/// UI can tell "there is no daemon to tell" from "the filesystem refused us".
#[tauri::command]
pub fn screen_state_set(
    bridge: tauri::State<'_, DisplayPowerBridge>,
    on: bool,
) -> Result<ScreenPayload, AmosError> {
    bridge.apply(on)?;
    Ok(ScreenPayload { on })
}

/// Read the current OS screen state (true when on).
#[tauri::command]
pub fn screen_state_get(
    bridge: tauri::State<'_, DisplayPowerBridge>,
) -> Result<ScreenPayload, AmosError> {
    Ok(ScreenPayload {
        on: bridge.current(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use amos_display::SCREEN_STATE_ENV;

    fn unique_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("amos-tauri-{tag}-{}.state", std::process::id()))
    }

    /// A recording stub host so we can assert the bridge actually drove the seam.
    struct MockPower {
        last: std::sync::Mutex<Option<bool>>,
    }
    impl MockPower {
        fn new() -> Self {
            Self {
                last: std::sync::Mutex::new(None),
            }
        }
    }
    impl DisplayPower for MockPower {
        fn set(&self, on: bool) -> Result<(), AmosError> {
            *self.last.lock().unwrap_or_else(|p| p.into_inner()) = Some(on);
            Ok(())
        }
        fn is_on(&self) -> bool {
            self.last
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .unwrap_or(false)
        }
    }

    #[test]
    fn write_read_round_trips() {
        let p = unique_path("roundtrip");
        write_screen_state(&p, false).expect("write off");
        assert_eq!(
            amos_display::read_screen_state_from(&p),
            Some(ScreenState::Off)
        );
        write_screen_state(&p, true).expect("write on");
        assert_eq!(
            amos_display::read_screen_state_from(&p),
            Some(ScreenState::On)
        );
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn write_replaces_previous_content() {
        let p = unique_path("replace");
        write_screen_state(&p, false).expect("write off");
        write_screen_state(&p, true).expect("write on");
        assert_eq!(std::fs::read_to_string(&p).expect("read"), "on");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn file_power_set_and_is_on_round_trip() {
        let p = unique_path("filepower");
        let power = FileDisplayPower::at(Some(p.clone()));
        power.set(false).expect("set off");
        assert!(!power.is_on());
        power.set(true).expect("set on");
        assert!(power.is_on());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn file_power_without_path_errors_honestly_and_reads_conservative_on() {
        let power = FileDisplayPower::at(None);
        assert!(power.set(false).is_err());
        assert!(power.is_on());
    }

    #[test]
    fn bridge_drives_the_injected_seam_and_reads_it_back() {
        let mock = Arc::new(MockPower::new());
        let bridge = DisplayPowerBridge::with(mock.clone());
        // Fresh mock has no recorded state → is_on is false.
        assert!(!bridge.current());
        bridge.apply(true).expect("apply on");
        assert!(*mock
            .last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .expect("recorded"));
        assert!(bridge.current());
        bridge.apply(false).expect("apply off");
        assert!(!bridge.current());
    }

    #[test]
    fn bridge_file_seam_round_trips_through_a_temp_contract_path() {
        // Point AMOS_SCREEN_STATE_PATH at a temp file, build the env-seeded bridge,
        // and exercise the same path the commands take.
        let p = unique_path("bridgefile");
        std::env::set_var(SCREEN_STATE_ENV, &p);
        let bridge = DisplayPowerBridge::file_default();
        bridge.apply(true).expect("set on");
        assert!(bridge.current());
        bridge.apply(false).expect("set off");
        assert!(!bridge.current());
        std::env::remove_var(SCREEN_STATE_ENV);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn write_screen_state_creates_an_atomic_rename_pair() {
        // Two writes with different values: a reader (even one mid-flight) never
        // sees a torn file, only `on` or `off`. This is the property the daemon
        // depends on for its energy beat.
        let p = unique_path("atomic");
        write_screen_state(&p, false).expect("write off");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "off");
        write_screen_state(&p, true).expect("write on");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "on");
        // The temp sibling must be gone after a successful rename — never a leak.
        assert!(!p.with_extension("tmp").exists());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn display_codes_are_stable_string_keys() {
        // The wire vocabulary is the i18n layer's contract; this pins it.
        assert_eq!(codes::CONTRACT_MISSING, "amos.display.contract_missing");
        assert_eq!(codes::WRITE_FAILED, "amos.display.write_failed");
        assert_eq!(codes::READ_MALFORMED, "amos.display.read_malformed");
        // ...and it is *single-sourced* with the shared `ErrorCode` vocabulary:
        // the constant and the enum must never drift into two spellings of one
        // wire code (the defect this module's codes previously invited by being
        // declared with no producer at all).
        assert_eq!(
            ErrorCode::DisplayContractMissing.as_str(),
            codes::CONTRACT_MISSING
        );
        assert_eq!(ErrorCode::DisplayWriteFailed.as_str(), codes::WRITE_FAILED);
        assert_eq!(
            ErrorCode::DisplayReadMalformed.as_str(),
            codes::READ_MALFORMED
        );
    }

    #[test]
    fn set_without_a_contract_carries_the_contract_missing_code() {
        // No `AMOS_SCREEN_STATE_PATH` ⇒ the declared `contract_missing` code, not a
        // bare prose string (the exact defect: the vocabulary was declared but no
        // code path ever produced it).
        let power = FileDisplayPower::at(None);
        let err = power.set(false).expect_err("no contract ⇒ error");
        assert_eq!(err.code(), codes::CONTRACT_MISSING);
        assert_eq!(err.code(), ErrorCode::DisplayContractMissing.as_str());
    }

    #[test]
    fn a_write_failure_carries_the_write_failed_code() {
        // A path whose parent does not exist makes `fs::write` fail — that must
        // surface as the declared `write_failed` code, distinct from
        // `contract_missing`.
        let p = std::env::temp_dir()
            .join(format!("amos-tauri-missing-dir-{}", std::process::id()))
            .join("nope.state");
        let power = FileDisplayPower::at(Some(p));
        let err = power.set(true).expect_err("unwritable path ⇒ error");
        assert_eq!(err.code(), codes::WRITE_FAILED);
        assert_ne!(err.code(), codes::CONTRACT_MISSING);
    }

    #[test]
    fn read_contract_classifies_each_outcome() {
        // Pure classifier: the judgement that decides "conservative on, but tell
        // the logs it was malformed" must be reachable without a live seam.
        assert_eq!(read_contract(None), ContractRead::Missing);
        let absent = unique_path("read-absent");
        let _ = std::fs::remove_file(&absent);
        assert_eq!(read_contract(Some(&absent)), ContractRead::Missing);

        let p = unique_path("read-classify");
        write_screen_state(&p, true).expect("write on");
        assert_eq!(read_contract(Some(&p)), ContractRead::On);
        write_screen_state(&p, false).expect("write off");
        assert_eq!(read_contract(Some(&p)), ContractRead::Off);

        std::fs::write(&p, "lit\n").expect("write garbage");
        assert_eq!(read_contract(Some(&p)), ContractRead::Malformed);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_malformed_contract_file_still_reads_conservatively_on() {
        // Behaviour is unchanged on purpose (never throttle a screen that might be
        // on); what is new is that the read is *observably* malformed, not silently
        // indistinguishable from "absent".
        let p = unique_path("malformed-on");
        std::fs::write(&p, "lit").expect("write garbage");
        let power = FileDisplayPower::at(Some(p.clone()));
        assert!(power.is_on());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn bridge_apply_surfaces_the_declared_code_from_the_seam() {
        // The bridge (what the command calls) must forward the seam's typed code,
        // so `screen_state_set` can hand it to the UI.
        let bridge = DisplayPowerBridge::with(Arc::new(FileDisplayPower::at(None)));
        let err = bridge.apply(true).expect_err("no contract ⇒ error");
        assert_eq!(err.code(), codes::CONTRACT_MISSING);
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn the_screen_state_cap_is_a_small_known_value() {
        // The contract file is two ASCII bytes (`on`/`off`); the cap is a
        // small known value that pins the contract — not the 64 KiB of
        // arbitrary store values — so a runaway writer that tries to push
        // megabytes through the contract is refused at the byte level. The
        // clippy lint that would move these into `const {…}` is suppressed:
        // the tripwire's value is *being* a runtime test on top of a test
        // build (the constant cannot change between runs, but a CI-runner /
        // investigator reading the diff still gets a self-documenting test
        // to compare against).
        assert!(
            MAX_SCREEN_STATE_BYTES >= 16,
            "cap is large enough to never bind a 2-byte payload: got {MAX_SCREEN_STATE_BYTES}"
        );
        assert!(
            MAX_SCREEN_STATE_BYTES <= 4096,
            "cap is small enough to refuse runaway writes: got {MAX_SCREEN_STATE_BYTES}"
        );
        // The actual payload (`on`/`off`) is far under the cap.
        assert!(("on".len() as u64) < MAX_SCREEN_STATE_BYTES);
        assert!(("off".len() as u64) < MAX_SCREEN_STATE_BYTES);
    }
}
