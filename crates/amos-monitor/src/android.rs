//! On-device Android [`SystemSampler`] skeleton (`android` feature).
//!
//! Mirrors the compile-gated seams in `amos-sensor`/`amos-power`/`amos-radio`:
//! this module is only built for the System UI APK (`android` feature) so
//! desktop/CI stays light, and it is honest about what is not yet wired — until
//! real `ActivityManager`/`SystemStatus` reads are bridged it reports the system
//! as "unknown" rather than fabricating numbers.
//!
//! `cargo check -p amos-monitor --features android` validates it compiles
//! (runtime needs a real Android VM / a Context).

use crate::spec::SystemLoad;
use crate::SystemSampler;

/// The Android [`SystemSampler`]. On-device reads of `/proc/stat` + `/proc/meminfo`
/// (and later `Debug.MemoryInfo` / `SystemStatus` for per-process) are the
/// bring-up step; today every read reports "unknown" — never a fake number.
pub struct AndroidSystemSampler;

impl AndroidSystemSampler {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AndroidSystemSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemSampler for AndroidSystemSampler {
    fn name(&self) -> &'static str {
        "android"
    }

    fn snapshot(&self) -> SystemLoad {
        // Bring-up: read real cumulative jiffies + meminfo (and later
        // per-process) here and fold into SystemLoad. Until then: honest unknown.
        SystemLoad::unknown()
    }
}
