//! The install state machine.
//!
//! ```text
//!   Idle ─begin─▶ Downloading ─finish│received==total─▶ Downloaded ─begin_verify─▶ Verifying
//!                     │                                     │                        │
//!                fail │                             fail    │   complete_verify(Verified, signature)
//!                     ▼                                     ▼                        ▼
//!                  Failed ◀──── complete_verify(not Verified / bad signature) ──  Staged
//!                     │                                                              │
//!                     │                                                       await_reboot
//!                     ▼                                                              ▼
//!                RolledBack ◀───────── rollback ────────────────  Applied ◀─apply─  AwaitingReboot
//! ```
//!
//! The one invariant everything else protects: **`Staged` is reachable only from
//! `complete_verify` with an `IntegrityVerdict::Verified` AND a signature that is
//! `Trusted` (or `Missing`, which the manifest policy already vetted) — or an
//! `Untrusted` one when the caller explicitly passed
//! [`UntrustedSignaturePolicy::Allow`]**. There is no `stage()` shortcut, so no
//! caller can put a phone into "reboot to apply this verified image" without both
//! gates having been evaluated. Likewise a truncated download becomes `Failed`,
//! never `Downloaded`, so a half image can never be handed to verification as if
//! it were whole.
//!
//! Every method that changes state returns `Result` and refuses illegal moves
//! with the `from`/`to` named — a state machine that silently resets on misuse
//! would hide the misuse.

use crate::error::{OtaError, Result};
use crate::spec::UpdatePackage;
use crate::verify::{IntegrityVerdict, SignatureVerdict};
use crate::version::Version;

/// How [`InstallMachine::complete_verify`] treats an **untrusted** signature over
/// an otherwise-verified image. Passed explicitly so no caller inherits a silent
/// default — an untrusted signature that is only logged is precisely the shape
/// this crate refuses to ship.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UntrustedSignaturePolicy {
    /// Fail the install. The safe default for a deployment with keys
    /// provisioned: a signature that is present but cannot be verified is a
    /// tampering signal, not a formality.
    Fail,
    /// Stage anyway, leaving the verdict for the caller to report. For a
    /// deployment whose trusted-key set is not yet provisioned, where failing
    /// would make [`InstallState::Staged`] unreachable (see
    /// `crates/amos-tauri/src/ota.rs`, which records the verdict on its result
    /// and qualifies the on-screen line rather than asserting authenticity).
    Allow,
}

/// Why an install failed. Every variant keeps enough detail to be shown to a
/// user or attached to a support ticket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FailReason {
    /// The download ended before `total` bytes arrived.
    Truncated { received: u64, total: u64 },
    /// The bytes did not hash to the published digest.
    Integrity { expected: String, actual: String },
    /// The published digest was not a well-formed SHA-256.
    MalformedDigest { reason: String },
    /// The signature was present and well-formed as hex, but the verifier could
    /// not evaluate it as a signature at all (e.g. it was not 64 bytes).
    ///
    /// This is the *unevaluable* case, distinct from
    /// [`FailReason::UntrustedSignature`] (evaluable, and refused). It mirrors
    /// [`FailReason::MalformedDigest`]: the input could not be read, so the
    /// install is reported as a finding naming the input rather than surfacing an
    /// opaque error from whichever verifier ran.
    MalformedSignature { reason: String },
    /// The signature was present but not trusted.
    UntrustedSignature { key_id: String },
    /// A provider/runtime error (message carried verbatim).
    Provider { message: String },
}

impl std::fmt::Display for FailReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FailReason::Truncated { received, total } => {
                write!(f, "download truncated at {received}/{total} bytes")
            }
            FailReason::Integrity { .. } => f.write_str("integrity check failed"),
            FailReason::MalformedDigest { reason } => write!(f, "malformed digest: {reason}"),
            FailReason::MalformedSignature { reason } => {
                write!(f, "malformed signature: {reason}")
            }
            FailReason::UntrustedSignature { key_id } => {
                write!(f, "signature from key {key_id} is not trusted")
            }
            FailReason::Provider { message } => write!(f, "provider error: {message}"),
        }
    }
}

/// The install state, carrying the version in flight where one exists.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum InstallState {
    /// Nothing in flight (the default / resting state).
    #[default]
    Idle,
    /// Receiving bytes (`received` ≤ `total`).
    Downloading {
        version: Version,
        received: u64,
        total: u64,
    },
    /// All `total` bytes arrived.
    Downloaded { version: Version, total: u64 },
    /// Hashing / signature-checking the downloaded bytes.
    Verifying { version: Version },
    /// Verified and staged; a reboot would apply it.
    Staged { version: Version },
    /// The device is rebooting into the staged image.
    AwaitingReboot { version: Version },
    /// The image is running.
    Applied { version: Version },
    /// The install failed for `reason`.
    Failed {
        version: Version,
        reason: FailReason,
    },
    /// The update was rolled back; `version` is the one abandoned.
    RolledBack { version: Version },
}

impl InstallState {
    /// Stable wire/UI key.
    pub fn key(&self) -> &'static str {
        match self {
            InstallState::Idle => "idle",
            InstallState::Downloading { .. } => "downloading",
            InstallState::Downloaded { .. } => "downloaded",
            InstallState::Verifying { .. } => "verifying",
            InstallState::Staged { .. } => "staged",
            InstallState::AwaitingReboot { .. } => "awaiting_reboot",
            InstallState::Applied { .. } => "applied",
            InstallState::Failed { .. } => "failed",
            InstallState::RolledBack { .. } => "rolled_back",
        }
    }

    /// The version this state is about, if any.
    pub fn version(&self) -> Option<&Version> {
        match self {
            InstallState::Idle => None,
            InstallState::Downloading { version, .. }
            | InstallState::Downloaded { version, .. }
            | InstallState::Verifying { version }
            | InstallState::Staged { version }
            | InstallState::AwaitingReboot { version }
            | InstallState::Applied { version }
            | InstallState::Failed { version, .. }
            | InstallState::RolledBack { version } => Some(version),
        }
    }

    /// Whether the machine has settled into a terminal state (a new
    /// [`InstallMachine::begin`] is allowed).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            InstallState::Idle
                | InstallState::Applied { .. }
                | InstallState::Failed { .. }
                | InstallState::RolledBack { .. }
        )
    }

    /// Whether a reboot would apply a verified, staged image.
    pub fn is_staged(&self) -> bool {
        matches!(self, InstallState::Staged { .. })
    }
}

/// Drives one install at a time. The runtime (provider + package installer +
/// reboot) is the caller's; this only owns the legal order of transitions.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct InstallMachine {
    state: InstallState,
}

impl InstallMachine {
    /// A fresh machine in [`InstallState::Idle`].
    pub fn new() -> InstallMachine {
        InstallMachine {
            state: InstallState::Idle,
        }
    }

    pub fn state(&self) -> &InstallState {
        &self.state
    }

    fn illegal(&self, to: &str, reason: impl Into<String>) -> OtaError {
        OtaError::Transition {
            from: self.state.key().to_string(),
            to: to.to_string(),
            reason: reason.into(),
        }
    }

    /// Begin downloading `package`. Allowed from any terminal state.
    pub fn begin(&mut self, package: &UpdatePackage) -> Result<()> {
        if !self.state.is_terminal() {
            return Err(self.illegal(
                "downloading",
                "an install is already in flight; finish or fail it first",
            ));
        }
        self.state = InstallState::Downloading {
            version: package.version().clone(),
            received: 0,
            total: package.size_bytes(),
        };
        Ok(())
    }

    /// Report progress (`received` total bytes so far). Must be monotonic and
    /// never exceed the announced total — an over-report is refused rather than
    /// clamped, because clamping would hide a provider that is lying.
    pub fn progress(&mut self, received: u64) -> Result<()> {
        let (prev, total) = match &self.state {
            InstallState::Downloading {
                received: prev,
                total,
                ..
            } => (*prev, *total),
            _ => return Err(self.illegal("downloading", "not downloading")),
        };
        if received > total {
            return Err(self.illegal(
                "downloading",
                format!("reported {received} bytes but the package is {total}"),
            ));
        }
        if received < prev {
            return Err(self.illegal(
                "downloading",
                format!("progress went backwards: {prev} -> {received}"),
            ));
        }
        if let InstallState::Downloading {
            received: ref mut r,
            ..
        } = self.state
        {
            *r = received;
        }
        Ok(())
    }

    /// Finish the download. A short download (`received < total`) becomes
    /// [`FailReason::Truncated`] — never [`InstallState::Downloaded`].
    pub fn finish_download(&mut self) -> Result<()> {
        match &self.state {
            InstallState::Downloading {
                version,
                received,
                total,
            } => {
                let (version, received, total) = (version.clone(), *received, *total);
                if received == total {
                    self.state = InstallState::Downloaded { version, total };
                } else {
                    self.state = InstallState::Failed {
                        version,
                        reason: FailReason::Truncated { received, total },
                    };
                }
                Ok(())
            }
            _ => Err(self.illegal("downloaded", "not downloading")),
        }
    }

    /// Start verifying a fully-downloaded image.
    pub fn begin_verify(&mut self) -> Result<()> {
        match &self.state {
            InstallState::Downloaded { version, .. } => {
                self.state = InstallState::Verifying {
                    version: version.clone(),
                };
                Ok(())
            }
            _ => Err(self.illegal("verifying", "no fully downloaded image to verify")),
        }
    }

    /// Record the verification outcome — **both** gates. A `Verified` integrity
    /// with a trusted-or-absent signature stages the image; any failure fails it.
    /// This is the **only** path to [`InstallState::Staged`].
    ///
    /// The two verdicts are one call on purpose: an integrity check that stages
    /// while a present-but-unverifiable signature is merely *printed* is the
    /// "verdict computed, gate absent" shape this crate refuses, and a separate
    /// `complete_verify` + optional signature step leaves exactly that hole open.
    /// The signature's `Missing` case stages because the manifest policy already
    /// refused an unsigned package when one was required (`policy::evaluate`
    /// checks *presence*; this call checks *authenticity* over the bytes).
    ///
    /// `untrusted` is passed explicitly rather than defaulted: a deployment with
    /// keys provisioned wants a present-but-unverifiable signature to fail, while
    /// one with an empty trusted set would otherwise never reach `Staged` — and
    /// which of those applies is the caller's to state, not this machine's to
    /// guess.
    pub fn complete_verify(
        &mut self,
        integrity: IntegrityVerdict,
        signature: SignatureVerdict,
        untrusted: UntrustedSignaturePolicy,
    ) -> Result<()> {
        match &self.state {
            InstallState::Verifying { version } => {
                let version = version.clone();
                self.state = match integrity {
                    IntegrityVerdict::Mismatch { expected, actual } => InstallState::Failed {
                        version,
                        reason: FailReason::Integrity { expected, actual },
                    },
                    IntegrityVerdict::Malformed { reason } => InstallState::Failed {
                        version,
                        reason: FailReason::MalformedDigest { reason },
                    },
                    IntegrityVerdict::Verified => match signature {
                        SignatureVerdict::Untrusted { key_id, .. }
                            if untrusted == UntrustedSignaturePolicy::Fail =>
                        {
                            InstallState::Failed {
                                version,
                                reason: FailReason::UntrustedSignature { key_id },
                            }
                        }
                        _ => InstallState::Staged { version },
                    },
                };
                Ok(())
            }
            _ => Err(self.illegal("staged/failed", "not verifying")),
        }
    }

    /// Mark the staged image as being applied (device rebooting).
    pub fn await_reboot(&mut self) -> Result<()> {
        match &self.state {
            InstallState::Staged { version } => {
                self.state = InstallState::AwaitingReboot {
                    version: version.clone(),
                };
                Ok(())
            }
            _ => Err(self.illegal("awaiting_reboot", "no verified image is staged")),
        }
    }

    /// Record that the rebooted image is now running.
    pub fn apply(&mut self) -> Result<()> {
        match &self.state {
            InstallState::AwaitingReboot { version } => {
                self.state = InstallState::Applied {
                    version: version.clone(),
                };
                Ok(())
            }
            _ => Err(self.illegal("applied", "not awaiting a reboot")),
        }
    }

    /// Fail the in-flight install. Any non-terminal state may fail.
    pub fn fail(&mut self, reason: FailReason) -> Result<()> {
        if self.state.is_terminal() {
            return Err(self.illegal("failed", "already in a terminal state"));
        }
        let version = self
            .state
            .version()
            .cloned()
            .ok_or_else(|| self.illegal("failed", "no version in flight"))?;
        self.state = InstallState::Failed { version, reason };
        Ok(())
    }

    /// Roll back an install that has a version in flight (staged, awaiting,
    /// applied or failed) to [`InstallState::RolledBack`].
    pub fn rollback(&mut self) -> Result<()> {
        match &self.state {
            InstallState::Staged { version }
            | InstallState::AwaitingReboot { version }
            | InstallState::Applied { version }
            | InstallState::Failed { version, .. } => {
                self.state = InstallState::RolledBack {
                    version: version.clone(),
                };
                Ok(())
            }
            _ => Err(self.illegal(
                "rolled_back",
                "nothing is installed to roll back from this state",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{Channel, UpdatePackage};

    fn pkg(size: u64) -> UpdatePackage {
        UpdatePackage::new(
            Version::parse("1.1.0").unwrap(),
            Channel::Stable,
            "u",
            "a".repeat(64),
            size,
        )
        .unwrap()
    }

    #[test]
    fn happy_path_reaches_applied() {
        let mut m = InstallMachine::new();
        assert_eq!(m.state(), &InstallState::Idle);
        m.begin(&pkg(100)).unwrap();
        m.progress(40).unwrap();
        m.progress(100).unwrap();
        m.finish_download().unwrap();
        assert!(matches!(
            m.state(),
            InstallState::Downloaded { total: 100, .. }
        ));
        m.begin_verify().unwrap();
        m.complete_verify(
            IntegrityVerdict::Verified,
            SignatureVerdict::Trusted,
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
        assert!(m.state().is_staged());
        m.await_reboot().unwrap();
        m.apply().unwrap();
        assert!(matches!(m.state(), InstallState::Applied { .. }));
        assert!(m.state().is_terminal());
    }

    #[test]
    fn truncated_download_never_becomes_downloaded() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(100)).unwrap();
        m.progress(60).unwrap();
        m.finish_download().unwrap();
        match m.state() {
            InstallState::Failed {
                reason:
                    FailReason::Truncated {
                        received: 60,
                        total: 100,
                    },
                ..
            } => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
        // And a failed image can never be verified/staged.
        assert!(m.begin_verify().is_err());
        assert!(!m.state().is_staged());
    }

    #[test]
    fn integrity_mismatch_fails_not_stages() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(10)).unwrap();
        m.progress(10).unwrap();
        m.finish_download().unwrap();
        m.begin_verify().unwrap();
        m.complete_verify(
            IntegrityVerdict::Mismatch {
                expected: "a".repeat(64),
                actual: "b".repeat(64),
            },
            SignatureVerdict::Trusted,
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
        assert!(matches!(
            m.state(),
            InstallState::Failed {
                reason: FailReason::Integrity { .. },
                ..
            }
        ));
        assert!(!m.state().is_staged());
    }

    #[test]
    fn malformed_digest_fails_distinctly() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(10)).unwrap();
        m.progress(10).unwrap();
        m.finish_download().unwrap();
        m.begin_verify().unwrap();
        m.complete_verify(
            IntegrityVerdict::Malformed {
                reason: "short".into(),
            },
            SignatureVerdict::Trusted,
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
        assert!(matches!(
            m.state(),
            InstallState::Failed {
                reason: FailReason::MalformedDigest { .. },
                ..
            }
        ));
    }

    #[test]
    fn progress_is_monotonic_and_bounded() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(100)).unwrap();
        m.progress(50).unwrap();
        assert!(
            m.progress(40).is_err(),
            "backwards progress must be refused"
        );
        assert!(m.progress(101).is_err(), "over-report must be refused");
        // Refusals left the state usable.
        m.progress(60).unwrap();
        m.progress(100).unwrap();
        m.finish_download().unwrap();
        assert!(matches!(m.state(), InstallState::Downloaded { .. }));
    }

    #[test]
    fn illegal_transitions_are_refused() {
        let mut m = InstallMachine::new();
        // Cannot verify before downloading.
        assert!(m.begin_verify().is_err());
        assert!(m.await_reboot().is_err());
        assert!(m.apply().is_err());
        assert!(m.rollback().is_err(), "nothing to roll back from Idle");
        m.begin(&pkg(10)).unwrap();
        // Cannot start a second install while one is in flight.
        assert!(m.begin(&pkg(10)).is_err());
        // Cannot complete a verify that never began.
        assert!(m
            .complete_verify(
                IntegrityVerdict::Verified,
                SignatureVerdict::Trusted,
                UntrustedSignaturePolicy::Fail,
            )
            .is_err());
        assert!(!m.state().is_staged());
    }

    #[test]
    fn fail_from_any_in_flight_state_then_rerun() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(10)).unwrap();
        m.fail(FailReason::Provider {
            message: "tls".into(),
        })
        .unwrap();
        assert!(matches!(m.state(), InstallState::Failed { .. }));
        // Terminal ⇒ a fresh install may begin.
        m.begin(&pkg(10)).unwrap();
        assert!(matches!(m.state(), InstallState::Downloading { .. }));
    }

    #[test]
    fn rollback_paths() {
        // From Applied.
        let mut m = InstallMachine::new();
        m.begin(&pkg(10)).unwrap();
        m.progress(10).unwrap();
        m.finish_download().unwrap();
        m.begin_verify().unwrap();
        m.complete_verify(
            IntegrityVerdict::Verified,
            SignatureVerdict::Trusted,
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
        m.await_reboot().unwrap();
        m.apply().unwrap();
        m.rollback().unwrap();
        assert!(matches!(m.state(), InstallState::RolledBack { .. }));

        // From a Failed verify.
        let mut f = InstallMachine::new();
        f.begin(&pkg(10)).unwrap();
        f.progress(10).unwrap();
        f.finish_download().unwrap();
        f.begin_verify().unwrap();
        f.complete_verify(
            IntegrityVerdict::Malformed { reason: "x".into() },
            SignatureVerdict::Trusted,
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
        f.rollback().unwrap();
        assert!(matches!(f.state(), InstallState::RolledBack { .. }));
    }

    #[test]
    fn state_keys_are_stable() {
        let mut m = InstallMachine::new();
        assert_eq!(m.state().key(), "idle");
        m.begin(&pkg(10)).unwrap();
        assert_eq!(m.state().key(), "downloading");
        m.progress(10).unwrap();
        m.finish_download().unwrap();
        assert_eq!(m.state().key(), "downloaded");
        m.begin_verify().unwrap();
        assert_eq!(m.state().key(), "verifying");
        m.complete_verify(
            IntegrityVerdict::Verified,
            SignatureVerdict::Trusted,
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
        assert_eq!(m.state().key(), "staged");
        m.await_reboot().unwrap();
        assert_eq!(m.state().key(), "awaiting_reboot");
        m.apply().unwrap();
        assert_eq!(m.state().key(), "applied");
    }

    /// The signature gate is real: a verified digest with an **untrusted**
    /// signature fails the install under the default policy. Before this was a
    /// parameter of `complete_verify`, the verdict could only be printed — the
    /// machine had no way to express this failure and `UntrustedSignature` had no
    /// constructor.
    #[test]
    fn an_untrusted_signature_fails_the_install_under_the_default_policy() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(10)).unwrap();
        m.progress(10).unwrap();
        m.finish_download().unwrap();
        m.begin_verify().unwrap();
        m.complete_verify(
            IntegrityVerdict::Verified,
            SignatureVerdict::Untrusted {
                key_id: "rel".into(),
                reason: "forged".into(),
            },
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
        match m.state() {
            InstallState::Failed {
                reason: FailReason::UntrustedSignature { key_id },
                ..
            } => assert_eq!(key_id, "rel"),
            other => panic!("expected Failed(UntrustedSignature), got {other:?}"),
        }
        assert!(!m.state().is_staged());
    }

    /// …and `Allow` is the escape hatch for a deployment whose trusted-key set is
    /// not provisioned: the same untrusted verdict stages.
    #[test]
    fn an_untrusted_signature_stages_under_the_allow_policy() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(10)).unwrap();
        m.progress(10).unwrap();
        m.finish_download().unwrap();
        m.begin_verify().unwrap();
        m.complete_verify(
            IntegrityVerdict::Verified,
            SignatureVerdict::Untrusted {
                key_id: "rel".into(),
                reason: "no keys provisioned".into(),
            },
            UntrustedSignaturePolicy::Allow,
        )
        .unwrap();
        assert!(m.state().is_staged());
    }

    /// A `Missing` signature stages: the manifest policy is the gate that requires
    /// one (`policy::evaluate`), and this call is the authenticity check over the
    /// bytes — "unsigned" is not "untrusted".
    #[test]
    fn a_missing_signature_stages_because_policy_is_the_presence_gate() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(10)).unwrap();
        m.progress(10).unwrap();
        m.finish_download().unwrap();
        m.begin_verify().unwrap();
        m.complete_verify(
            IntegrityVerdict::Verified,
            SignatureVerdict::Missing,
            UntrustedSignaturePolicy::Fail,
        )
        .unwrap();
        assert!(m.state().is_staged());
    }

    /// Integrity is checked first: a bad digest fails even if the signature is
    /// `Allow`-treated, so `Allow` can never be used to bypass the hash gate.
    #[test]
    fn an_integrity_failure_is_not_rescued_by_the_allow_policy() {
        let mut m = InstallMachine::new();
        m.begin(&pkg(10)).unwrap();
        m.progress(10).unwrap();
        m.finish_download().unwrap();
        m.begin_verify().unwrap();
        m.complete_verify(
            IntegrityVerdict::Mismatch {
                expected: "a".repeat(64),
                actual: "b".repeat(64),
            },
            SignatureVerdict::Trusted,
            UntrustedSignaturePolicy::Allow,
        )
        .unwrap();
        assert!(matches!(
            m.state(),
            InstallState::Failed {
                reason: FailReason::Integrity { .. },
                ..
            }
        ));
        assert!(!m.state().is_staged());
    }
}
