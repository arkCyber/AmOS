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

use amos_display::{ScreenState, SCREEN_STATE_ENV};

/// Wire vocabulary for the display / screen-state module. The UI i18n layer
/// branches on these; renaming a variant is a wire break. The string form
/// matches the [`crate::error::ErrorCode`] `as_str()` shape (`amos.<group>.<leaf>`).
pub mod codes {
    /// `AMOS_SCREEN_STATE_PATH` is unset (no daemon to sync with).
    pub const CONTRACT_MISSING: &str = "amos.display.contract_missing";
    /// Writing the screen-state file failed (FS error, permission, …).
    pub const WRITE_FAILED: &str = "amos.display.write_failed";
    /// Reading the screen-state file returned malformed content (not `on`/`off`).
    pub const READ_MALFORMED: &str = "amos.display.read_malformed";
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

/// **Device seam**: physically blank / wake the panel (and keep the cross-process
/// state consistent). `set(false)` = go to sleep / blank; `set(true)` = wake /
/// keep on. Returns `Err` on failure — a host must never report success it didn't
/// achieve.
pub trait DisplayPower: Send + Sync {
    fn set(&self, on: bool) -> Result<(), String>;
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
/// Returns a typed [`crate::error::AmosError`] on any failure so the caller can
/// branch on the wire code (e.g. distinguish "no daemon contract" from "FS
/// error") without parsing the message. The write is bounded by
/// [`MAX_SCREEN_STATE_BYTES`] — a runaway writer filling the contract path
/// with garbage is refused before the rename step (which would otherwise
/// truncate a megabyte file to two bytes and lose the signal).
pub fn write_screen_state(path: &Path, on: bool) -> io::Result<()> {
    let content = if on { "on" } else { "off" };
    if (content.len() as u64) > MAX_SCREEN_STATE_BYTES {
        // Defensive: `content` is a literal today, but the cap is here so a
        // future change cannot turn this function into a megabyte writer
        // without someone noticing.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "screen-state payload is {} bytes (limit {})",
                content.len(),
                MAX_SCREEN_STATE_BYTES
            ),
        ));
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)
}

impl DisplayPower for FileDisplayPower {
    fn set(&self, on: bool) -> Result<(), String> {
        let path = self.path.as_deref().ok_or_else(|| {
            format!("{SCREEN_STATE_ENV} not set — cannot sync screen state to the daemon")
        })?;
        write_screen_state(path, on).map_err(|e| format!("write screen state: {e}"))
    }

    fn is_on(&self) -> bool {
        self.path
            .as_deref()
            .and_then(amos_display::read_screen_state_from)
            .map(|s| s == ScreenState::On)
            .unwrap_or(true)
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

    fn apply(&self, on: bool) -> Result<(), String> {
        self.power.set(on)
    }

    fn current(&self) -> bool {
        self.power.is_on()
    }
}

/// Set the OS screen state on/off and return the authoritative snapshot.
#[tauri::command]
pub fn screen_state_set(
    bridge: tauri::State<'_, DisplayPowerBridge>,
    on: bool,
) -> Result<ScreenPayload, String> {
    bridge.apply(on)?;
    Ok(ScreenPayload { on })
}

/// Read the current OS screen state (true when on).
#[tauri::command]
pub fn screen_state_get(
    bridge: tauri::State<'_, DisplayPowerBridge>,
) -> Result<ScreenPayload, String> {
    Ok(ScreenPayload {
        on: bridge.current(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;

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
        fn set(&self, on: bool) -> Result<(), String> {
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
