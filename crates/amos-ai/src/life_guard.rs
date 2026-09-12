//! `life_guard.rs` — LMK self-protection guard for the `amos-ai` daemon.
//!
//! On the **no-UI Android base (base A)**, the daemon is kept un-reclaimable by
//! Android's Low Memory Killer via `deploy/android/amos.rc`: `user root` +
//! `oom_score_adj -1000`. But that write happens **once, at spawn, by init** —
//! nothing in the daemon ever *verifies* it took effect, *reports* it, or
//! *recovers* it if the value drifts or never applied. If protection silently
//! fails, the very failure it was meant to prevent (Android reclaiming the AI
//! core under memory pressure) can happen with no observable signal.
//!
//! This module is that missing runtime half, mirroring `amos-monitor`'s idiom: a
//! pure, deterministic decision core over an **injectable procfs seam**, so every
//! branch is unit-testable on any host with no root / Android / `/proc`.
//!
//! * [`ProcFs`] — the seam (read + write `oom_score_adj`).
//! * [`LifeGuard`] — [`check`](LifeGuard::check) reads + classifies protection;
//!   [`ensure`](LifeGuard::ensure) additionally *self-heals* (writes the target
//!   when privileged) and **re-verifies** the write landed.
//! * [`PlatformProcFs`] — the real impl over `/proc/self/oom_score_adj` on
//!   Linux/Android; honest `Unsupported` on hosts with no oom control.
//!
//! Honest boundaries (aerospace-grade baseline):
//! * `oom_score_adj == -1000` means *LMK will not reclaim by OOM tier*. It is
//!   **not** absolute immunity: an explicit `am force-stop`, a user "force stop",
//!   or a platform action bypassing the OOM tier can still end the process.
//! * Only a **privileged** process (root, as base A's `user root`) can raise its
//!   own `oom_score_adj`; an unprivileged one gets [`EnsureError::Unprivileged`],
//!   never a fabricated "healed".
//! * A host without oom control is [`Verdict::NotApplicable`] — never a lie.
//! * Fail-safe: an unreadable value is [`Protection::Unverifiable`], and a heal
//!   that cannot be confirmed is an error, never a silent assumption.
//!
//! Wiring: `serve()` spawns a low-frequency periodic re-verify so protection is
//! *continuously assured*, not assumed at boot.

#![forbid(unsafe_code)]

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

/// `oom_score_adj` that places a process in the "never reclaim by OOM tier" bucket
/// (the same value `deploy/android/amos.rc` writes for `amos-ai`).
pub const TARGET_OOM_SCORE_ADJ: i32 = -1000;

/// Default procfs path for the current process's OOM adjustment.
pub fn default_oom_path() -> &'static str {
    "/proc/self/oom_score_adj"
}

/// Why reading the current OOM adjustment failed (or was not attempted).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    /// The host exposes no oom control (non-Linux desktop dev, etc.).
    Unsupported,
    /// The oom file could not be read (procfs absent, permissions).
    Unreadable,
    /// The oom file existed but held an unparseable value.
    Malformed,
}

/// Why writing a new OOM adjustment failed (or was not attempted).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteError {
    /// The host exposes no oom control.
    Unsupported,
    /// Write denied: not privileged (non-root / no cap). Expected & honest on a
    /// normal retail app — never a lie.
    Unprivileged,
    /// Write failed for another reason.
    Failed,
}

/// The procfs seam for the current process's OOM adjustment.
///
/// Writes are side effects on the backing fs, but the *decision logic* that
/// consumes them lives in [`LifeGuard`] and is fully testable with a fake
/// implementation (no `/proc`, no root, no Android).
pub trait ProcFs {
    /// Whether this host exposes `/proc/<pid>/oom_score_adj` (Linux/Android).
    fn supported(&self) -> bool;

    /// Read the current `oom_score_adj` of this process.
    fn read_oom_score_adj(&self) -> Result<i32, ReadError>;

    /// Write a new `oom_score_adj` for this process.
    fn write_oom_score_adj(&self, value: i32) -> Result<(), WriteError>;
}

/// Observed protection state (a pure classification of one read).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protection {
    /// `oom_score_adj` equals the target → LMK will not reclaim by OOM tier.
    Protected,
    /// A valid value was read but it is *not* the target.
    Unprotected { observed: i32 },
    /// A supported host but the value could not be read/parsed → cannot verify.
    Unverifiable,
    /// The host has no oom control (not the protected daemon context).
    Unsupported,
}

impl Protection {
    /// Stable key for logging / diagnostics.
    pub fn key(self) -> &'static str {
        match self {
            Protection::Protected => "protected",
            Protection::Unprotected { .. } => "unprotected",
            Protection::Unverifiable => "unverifiable",
            Protection::Unsupported => "unsupported",
        }
    }
}

/// Result of [`LifeGuard::ensure`] — what this (possibly healing) pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Verified protected; nothing to do.
    Protected,
    /// Was not protected; wrote the target and **re-verified** it landed.
    Healed { from: i32, to: i32 },
    /// Host has no oom control (desktop dev / retail without root). No action.
    NotApplicable,
}

impl Verdict {
    /// Stable key for logging.
    pub fn key(self) -> &'static str {
        match self {
            Verdict::Protected => "protected",
            Verdict::Healed { .. } => "healed",
            Verdict::NotApplicable => "not_applicable",
        }
    }
}

/// Why [`LifeGuard::ensure`] could not guarantee protection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureError {
    /// A valid, non-target value was read but the write was denied because the
    /// process is not privileged. Honest: we did *not* heal.
    Unprivileged { observed: i32 },
    /// A valid, non-target value was read but the write failed for another reason.
    WriteFailed { observed: i32 },
    /// On a supported host the value could not be read → cannot act.
    Unverifiable,
    /// The target was written but the follow-up read did not confirm it.
    RecheckFailed { observed: i32 },
}

impl fmt::Display for EnsureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            EnsureError::Unprivileged { observed } => write!(
                f,
                "oom_score_adj={observed} but write denied (not privileged); run as root (base-A init.rc `user root`) to self-heal"
            ),
            EnsureError::WriteFailed { observed } => {
                write!(f, "oom_score_adj={observed}; write to raise protection failed")
            }
            EnsureError::Unverifiable => {
                write!(f, "could not read oom_score_adj on this host; cannot verify")
            }
            EnsureError::RecheckFailed { observed } => write!(
                f,
                "wrote protection but re-read oom_score_adj={observed} (target {TARGET_OOM_SCORE_ADJ})"
            ),
        }
    }
}

/// The guard: reads the daemon's OOM adjustment over a [`ProcFs`], classifies
/// protection, and — when privileged — self-heals and re-verifies.
///
/// Deterministic in its inputs: given the same [`ProcFs`] state it always reaches
/// the same decision, so it is trivially testable and safe to tick periodically.
#[derive(Clone, Debug)]
pub struct LifeGuard<F: ProcFs> {
    fs: F,
    target: i32,
}

impl<F: ProcFs> LifeGuard<F> {
    /// A guard that verifies the daemon sits at [`TARGET_OOM_SCORE_ADJ`].
    pub fn new(fs: F) -> Self {
        Self {
            fs,
            target: TARGET_OOM_SCORE_ADJ,
        }
    }

    /// The `oom_score_adj` this guard treats as "protected" (diagnostics).
    pub fn target(&self) -> i32 {
        self.target
    }

    /// The underlying procfs seam (inspection / tests).
    pub fn fs(&self) -> &F {
        &self.fs
    }

    /// Read and classify the current protection state. **No side effects.**
    pub fn check(&self) -> Protection {
        if !self.fs.supported() {
            return Protection::Unsupported;
        }
        match self.fs.read_oom_score_adj() {
            Ok(v) if v == self.target => Protection::Protected,
            Ok(v) => Protection::Unprotected { observed: v },
            Err(_) => Protection::Unverifiable,
        }
    }

    /// Ensure protection: classify, self-heal when needed, and re-verify.
    ///
    /// Fail-safe and honest: it only reports [`Verdict::Healed`] after a
    /// successful write is *confirmed by a follow-up read*; an unprivileged write
    /// is [`EnsureError::Unprivileged`] (no fabricated success); an unverifiable
    /// read is an error rather than an assumption.
    pub fn ensure(&self) -> Result<Verdict, EnsureError> {
        if !self.fs.supported() {
            return Ok(Verdict::NotApplicable);
        }
        let observed = self
            .fs
            .read_oom_score_adj()
            .map_err(|_| EnsureError::Unverifiable)?;
        if observed == self.target {
            return Ok(Verdict::Protected);
        }
        match self.fs.write_oom_score_adj(self.target) {
            Err(WriteError::Unprivileged) => {
                return Err(EnsureError::Unprivileged { observed });
            }
            Err(WriteError::Failed) | Err(WriteError::Unsupported) => {
                return Err(EnsureError::WriteFailed { observed });
            }
            Ok(()) => {}
        }
        // Re-verify the write actually landed before claiming a heal.
        match self.fs.read_oom_score_adj() {
            Ok(after) if after == self.target => Ok(Verdict::Healed {
                from: observed,
                to: self.target,
            }),
            Ok(after) => Err(EnsureError::RecheckFailed { observed: after }),
            Err(_) => Err(EnsureError::Unverifiable),
        }
    }

    /// Spawn a periodic self-protection pass that logs each verdict at a level
    /// reflecting the state (default `info` filter stays quiet when all is well,
    /// but surfaces a heal or any degraded/error state). The first tick fires
    /// immediately, so a boot-time verify + self-heal happens right away; a zero
    /// interval is clamped to a tiny floor to avoid a tokio panic.
    pub fn spawn_periodic(self: &Arc<Self>, interval: Duration) -> JoinHandle<()>
    where
        F: Send + Sync + 'static,
    {
        let interval = interval.max(Duration::from_millis(1));
        let guard = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Runs until the daemon shuts down: no exit here; the task is aborted
            // with the runtime. `tick()` is the wait (never a spin).
            loop {
                ticker.tick().await;
                Self::log_one(&guard);
            }
        })
    }

    /// Log one self-protection pass, choosing the level by outcome.
    fn log_one(guard: &LifeGuard<F>) {
        match guard.ensure() {
            Ok(Verdict::Protected) => {
                tracing::trace!(
                    target_oom_score_adj = guard.target,
                    "amos-ai oom_score_adj verified protected"
                )
            }
            Ok(Verdict::Healed { from, to }) => {
                tracing::info!(from, to, "amos-ai oom_score_adj self-healed to {to}")
            }
            Ok(Verdict::NotApplicable) => {
                tracing::trace!("amos-ai oom control not available on this host")
            }
            Err(e) => {
                tracing::warn!(error = %e, "amos-ai oom self-protection degraded")
            }
        }
    }
}

/// The real procfs implementation.
///
/// The procfs path is injectable (default `/proc/self/oom_score_adj`) so the
/// parser is testable over a tempdir on Linux; `supported()` is `false` on any
/// non-Linux host, where every operation reports [`ReadError::Unsupported`] /
/// [`WriteError::Unsupported`] honestly.
#[derive(Debug, Clone)]
pub struct PlatformProcFs {
    oom_path: PathBuf,
}

impl Default for PlatformProcFs {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformProcFs {
    /// A real procfs guard over the current process's OOM adjustment.
    pub fn new() -> Self {
        Self {
            oom_path: PathBuf::from(default_oom_path()),
        }
    }

    /// A real procfs guard over an explicit path (tests inject a tempdir).
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        Self {
            oom_path: path.into(),
        }
    }

    /// The procfs path this guard reads/writes.
    pub fn oom_path(&self) -> &Path {
        &self.oom_path
    }

    /// Whether this build targets a host with `/proc` oom control.
    #[cfg(target_os = "linux")]
    fn proc_supported() -> bool {
        true
    }

    #[cfg(not(target_os = "linux"))]
    fn proc_supported() -> bool {
        false
    }
}

impl ProcFs for PlatformProcFs {
    fn supported(&self) -> bool {
        Self::proc_supported()
    }

    fn read_oom_score_adj(&self) -> Result<i32, ReadError> {
        if !self.supported() {
            return Err(ReadError::Unsupported);
        }
        let raw = std::fs::read_to_string(&self.oom_path).map_err(|_| ReadError::Unreadable)?;
        raw.trim().parse::<i32>().map_err(|_| ReadError::Malformed)
    }

    fn write_oom_score_adj(&self, value: i32) -> Result<(), WriteError> {
        if !self.supported() {
            return Err(WriteError::Unsupported);
        }
        std::fs::write(&self.oom_path, value.to_string()).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => WriteError::Unprivileged,
            _ => WriteError::Failed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// In-memory [`ProcFs`] covering every branch without `/proc`/root.
    #[derive(Debug)]
    struct FakeFs {
        supported: bool,
        value: Cell<i32>,
        /// false → writes are denied (unprivileged).
        writable: Cell<bool>,
        /// true → reads report an error (procfs absent).
        read_broken: Cell<bool>,
        /// true → writes report a generic failure.
        write_fails: Cell<bool>,
        /// true → writes are "accepted" but do not change the value (simulates a
        /// kernel/policy that refuses to actually lower the adj).
        stubborn: bool,
    }

    impl FakeFs {
        fn protected() -> Self {
            Self {
                supported: true,
                value: Cell::new(TARGET_OOM_SCORE_ADJ),
                writable: Cell::new(true),
                read_broken: Cell::new(false),
                write_fails: Cell::new(false),
                stubborn: false,
            }
        }
        fn unprotected_at(v: i32) -> Self {
            Self {
                supported: true,
                value: Cell::new(v),
                writable: Cell::new(true),
                read_broken: Cell::new(false),
                write_fails: Cell::new(false),
                stubborn: false,
            }
        }
        fn unprivileged_at(v: i32) -> Self {
            Self {
                supported: true,
                value: Cell::new(v),
                writable: Cell::new(false),
                read_broken: Cell::new(false),
                write_fails: Cell::new(false),
                stubborn: false,
            }
        }
    }

    impl ProcFs for FakeFs {
        fn supported(&self) -> bool {
            self.supported
        }
        fn read_oom_score_adj(&self) -> Result<i32, ReadError> {
            if self.read_broken.get() {
                return Err(ReadError::Unreadable);
            }
            Ok(self.value.get())
        }
        fn write_oom_score_adj(&self, value: i32) -> Result<(), WriteError> {
            if self.write_fails.get() {
                return Err(WriteError::Failed);
            }
            if !self.writable.get() {
                return Err(WriteError::Unprivileged);
            }
            if !self.stubborn {
                self.value.set(value);
            }
            Ok(())
        }
    }

    #[test]
    fn already_protected_is_protected_and_does_not_write() {
        let g = LifeGuard::new(FakeFs::protected());
        assert_eq!(g.check(), Protection::Protected);
        assert_eq!(g.ensure(), Ok(Verdict::Protected));
        // No spurious write: the value is untouched.
        assert_eq!(g.fs().value.get(), TARGET_OOM_SCORE_ADJ);
    }

    #[test]
    fn other_negative_is_unprotected_but_healable() {
        // A "normal service" adj like -900 is NOT our never-reclaim bucket.
        let g = LifeGuard::new(FakeFs::unprotected_at(-900));
        assert_eq!(g.check(), Protection::Unprotected { observed: -900 });
        assert_eq!(
            g.ensure(),
            Ok(Verdict::Healed {
                from: -900,
                to: TARGET_OOM_SCORE_ADJ
            })
        );
        assert_eq!(g.fs().value.get(), TARGET_OOM_SCORE_ADJ);
    }

    #[test]
    fn zero_is_unprotected_and_healable() {
        // A brand-new, un-tuned daemon sits at 0 (default) on a supported host.
        let g = LifeGuard::new(FakeFs::unprotected_at(0));
        assert_eq!(g.check(), Protection::Unprotected { observed: 0 });
        assert!(matches!(g.ensure(), Ok(Verdict::Healed { from: 0, .. })));
        assert_eq!(g.fs().value.get(), TARGET_OOM_SCORE_ADJ);
    }

    #[test]
    fn unprivileged_write_is_an_honest_error_not_a_fake_heal() {
        let g = LifeGuard::new(FakeFs::unprivileged_at(0));
        assert_eq!(g.ensure(), Err(EnsureError::Unprivileged { observed: 0 }));
        // Value unchanged — we never claim success.
        assert_eq!(g.fs().value.get(), 0);
    }

    #[test]
    fn generic_write_failure_is_reported() {
        let fs = FakeFs::unprotected_at(5);
        fs.write_fails.set(true);
        let g = LifeGuard::new(fs);
        assert_eq!(g.ensure(), Err(EnsureError::WriteFailed { observed: 5 }));
    }

    #[test]
    fn accepted_but_unapplied_write_is_recheck_failed_not_healed() {
        let fs = FakeFs {
            supported: true,
            value: Cell::new(3),
            writable: Cell::new(true),
            read_broken: Cell::new(false),
            write_fails: Cell::new(false),
            stubborn: true, // write "accepted" but value stays 3
        };
        let g = LifeGuard::new(fs);
        assert_eq!(g.ensure(), Err(EnsureError::RecheckFailed { observed: 3 }));
    }

    #[test]
    fn unreadable_on_supported_host_is_unverifiable_not_a_panic() {
        let fs = FakeFs::protected();
        fs.read_broken.set(true);
        let g = LifeGuard::new(fs);
        assert_eq!(g.check(), Protection::Unverifiable);
        assert_eq!(g.ensure(), Err(EnsureError::Unverifiable));
    }

    #[test]
    fn unsupported_host_is_not_applicable_not_an_error() {
        let fs = FakeFs {
            supported: false,
            value: Cell::new(0),
            writable: Cell::new(true),
            read_broken: Cell::new(false),
            write_fails: Cell::new(false),
            stubborn: false,
        };
        let g = LifeGuard::new(fs);
        assert_eq!(g.check(), Protection::Unsupported);
        assert_eq!(g.ensure(), Ok(Verdict::NotApplicable));
    }

    #[test]
    fn target_is_the_stable_constant() {
        assert_eq!(TARGET_OOM_SCORE_ADJ, -1000);
        assert_eq!(
            LifeGuard::new(PlatformProcFs::new()).target(),
            TARGET_OOM_SCORE_ADJ
        );
    }

    #[test]
    fn keys_are_stable() {
        assert_eq!(Protection::Protected.key(), "protected");
        assert_eq!(Protection::Unprotected { observed: 0 }.key(), "unprotected");
        assert_eq!(Protection::Unverifiable.key(), "unverifiable");
        assert_eq!(Protection::Unsupported.key(), "unsupported");
        assert_eq!(Verdict::Protected.key(), "protected");
        assert_eq!(Verdict::Healed { from: 0, to: -1000 }.key(), "healed");
        assert_eq!(Verdict::NotApplicable.key(), "not_applicable");
    }

    #[test]
    fn error_messages_are_self_explanatory() {
        assert!(EnsureError::Unprivileged { observed: 0 }
            .to_string()
            .contains("not privileged"));
        assert!(EnsureError::RecheckFailed { observed: -500 }
            .to_string()
            .contains("re-read"));
        assert!(EnsureError::Unverifiable
            .to_string()
            .contains("cannot verify"));
    }

    #[test]
    fn platform_default_points_at_self_oom_path() {
        let fs = PlatformProcFs::new();
        assert_eq!(fs.oom_path(), Path::new(default_oom_path()));
    }

    // The real `/proc` read is Linux-only and environment-dependent (a sandbox
    // may lack /proc or the file may be unreadable), so we assert only the
    // *shape*: either a verified value or an honest Unverifiable/Unsupported —
    // never a panic, never a fabricated claim.
    #[cfg(target_os = "linux")]
    #[test]
    fn real_read_on_linux_is_honest() {
        let g = LifeGuard::new(PlatformProcFs::new());
        match g.check() {
            Protection::Protected | Protection::Unprotected { .. } => {
                // verified against the real kernel value
            }
            Protection::Unverifiable | Protection::Unsupported => {
                // /proc absent or unreadable here — honest, no panic
            }
        }
    }
}
