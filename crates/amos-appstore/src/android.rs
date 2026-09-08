//! AmOS store's **Android PackageManager (PMS) / `PackageInstaller` integration
//! layer** — a *capability model*, a *silent-install precondition checklist*, and
//! a *bridge trait + FFI placeholder surface* for driving the on-device APK
//! install pipeline.
//!
//! # Why this module exists (and what it deliberately does **not** do)
//!
//! The store engine ([`crate::client::AppStore`]) today installs *web bundles*
//! (a verified `tar.gz` unpacked to disk). Shipping real Android apps means
//! handing an APK to the platform package manager. That hand-off is **not** pure
//! Rust and **not** part of this crate's transport-agnostic core — it lives on
//! the device side (a Tauri/JNI bridge). What this crate *can* own is the honest
//! model of what the device allows, because everything else flows from that:
//!
//! ```text
//! [ AppStore<P> ]  downloads + sha256-verifies an APK
//!        │  install(apk)                      (this crate)
//!        ▼
//! [ PackageInstallerBridge ]   <- trait seam, impl is a JNI/priv-app bridge
//!        │  open_session / write_apk / commit / abandon
//!        ▼
//! [ PackageManagerService ]  session staged on device (PMS, the real gate)
//! ```
//!
//! **Reality check kept honest (no pretending):** Android surfaces a public,
//! user-confirmation dialog for any `PackageInstaller` session unless the
//! committing caller is privileged — i.e. a preinstalled **priv-app** that
//! (a) is signed with the **platform key**, (b) holds the `signature|privileged`
//! **`android.permission.INSTALL_PACKAGES`**, and (c) is allow-listed in
//! **`privapp-permissions.xml`** (enforced since Android 9 via
//! `PrivappPermsViolation`). A normal sideloaded app holding only
//! `REQUEST_INSTALL_PACKAGES` can never commit silently — it always ends in a
//! `STATUS_PENDING_USER_ACTION` UI step.
//!
//! So "无感安装 with no pop-up" is a **privilege property of the store process
//! on a given device**, not something code can conjure. This module encodes that
//! property as data so the engine can (1) refuse to pretend, and (2) tell a
//! caller *exactly which OEM preinstall step is missing*. No AOSP source is
//! modified and no private/hidden interface is invoked — the public
//! `PackageInstaller` API is sufficient **once** the privilege precondition is
//! satisfied at the partition/signing level.

use crate::error::{Result, StoreError};

/// The Android permission that makes an app a legitimate installer. A
/// `signature|privileged` permission: only a system/priv-app signed with the
/// matching key (or allow-listed as a privileged app) is granted it.
pub const INSTALL_PACKAGES_PERMISSION: &str = "android.permission.INSTALL_PACKAGES";

/// The runtime permission a *sideloaded* store app can request. It only opens
/// the user-facing install confirmation — it never enables a silent commit.
pub const REQUEST_INSTALL_PACKAGES_PERMISSION: &str = "android.permission.REQUEST_INSTALL_PACKAGES";

/// Directory where the OEM preinstalls the store so it is a *priv-app*.
pub const PRIV_APP_DIR: &str = "/system/priv-app/AmosStore";

/// `privapp-permissions.xml` allow-list file that must carry the store package.
pub const PRIVAPP_PERMISSIONS_XML: &str =
    "/system/etc/permissions/privapp-permissions-amos.xml";

// ---------------------------------------------------------------------------
// PackageInstaller constants we mirror from the *public* Android SDK
// (android.content.pm.PackageInstaller). Kept as plain ints so a JNI bridge
// (which can't see Rust types) and the Rust model agree on the wire format.
// ---------------------------------------------------------------------------

/// `SessionParams.MODE_FULL_INSTALL` — install a brand-new application.
pub const INSTALL_MODE_FULL: i32 = 1;
/// `SessionParams.MODE_INHERIT_EXISTING` — update an existing app in place.
pub const INSTALL_MODE_INHERIT_EXISTING: i32 = 2;

/// `PackageInstaller.STATUS_PENDING_USER_ACTION` — commit needs the UI; not
/// silent. Surfaced to the engine so a store falls back to a consent flow
/// instead of pretending the install is invisible.
pub const STATUS_PENDING_USER_ACTION: i32 = -1;
pub const STATUS_SUCCESS: i32 = 0;
pub const STATUS_FAILURE: i32 = 1;
pub const STATUS_FAILURE_ABORTED: i32 = 2;
pub const STATUS_FAILURE_BLOCKED: i32 = 3;
pub const STATUS_FAILURE_CONFLICT: i32 = 4;
pub const STATUS_FAILURE_INCOMPATIBLE: i32 = 5;
pub const STATUS_FAILURE_INVALID: i32 = 6;
pub const STATUS_FAILURE_STORAGE: i32 = 7;

/// Human name for a `PackageInstaller.STATUS_*` code (for logs / diagnostics).
pub fn status_name(code: i32) -> &'static str {
    match code {
        STATUS_PENDING_USER_ACTION => "pending user action",
        STATUS_SUCCESS => "success",
        STATUS_FAILURE => "generic failure",
        STATUS_FAILURE_ABORTED => "aborted",
        STATUS_FAILURE_BLOCKED => "blocked",
        STATUS_FAILURE_CONFLICT => "conflict (already installed)",
        STATUS_FAILURE_INCOMPATIBLE => "incompatible",
        STATUS_FAILURE_INVALID => "invalid request",
        STATUS_FAILURE_STORAGE => "insufficient storage",
        _ => "unknown status",
    }
}

/// `SessionParams` install mode: a fresh install vs. an in-place upgrade.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallMode {
    /// A brand-new application install (`MODE_FULL_INSTALL`).
    Full,
    /// Updating an existing application, inheriting its data (`MODE_INHERIT_EXISTING`).
    InheritExisting,
}

impl InstallMode {
    pub const fn code(self) -> i32 {
        match self {
            InstallMode::Full => INSTALL_MODE_FULL,
            InstallMode::InheritExisting => INSTALL_MODE_INHERIT_EXISTING,
        }
    }

    pub fn from_code(code: i32) -> Option<InstallMode> {
        match code {
            INSTALL_MODE_FULL => Some(InstallMode::Full),
            INSTALL_MODE_INHERIT_EXISTING => Some(InstallMode::InheritExisting),
            _ => None,
        }
    }
}

/// A single APK install/update request handed to a `PackageInstaller` session.
///
/// `package` must be a valid Android application id (e.g. `com.amos.mail`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallRequest {
    /// Target Android application id, e.g. `com.amos.mail`.
    pub package: String,
    /// APK file name staged inside the session (`base.apk`, or the ABI split name).
    pub apk_name: String,
    /// Fresh install vs. in-place upgrade.
    pub mode: InstallMode,
    /// `versionCode` of the APK (used for upgrade bookkeeping).
    pub version_code: u64,
    /// Whether this caller *expects* the commit to be silent (`false`). The
    /// request itself does not grant silence — the caller's [`Posture`] does.
    pub expect_silent: bool,
    /// Label shown if PMS *does* surface a confirmation dialog.
    pub label: Option<String>,
}

impl InstallRequest {
    /// The only real validation this model owns: the package id is well formed
    /// enough to be a safe install key (an id with `/`, spaces etc. is garbage).
    pub fn validate(&self) -> Result<()> {
        if !valid_android_package(&self.package) {
            return Err(StoreError::Provider(format!(
                "invalid android package id {:?} for install",
                self.package
            )));
        }
        if self.apk_name.is_empty() {
            return Err(StoreError::Provider("apk_name must not be empty".into()));
        }
        Ok(())
    }
}

/// True when `pkg` is a plausible Android package id: dot-separated segments of
/// `[a-zA-Z0-9_]`, each non-empty. (Loose on purpose — PMS is the authoritative
/// validator; this only stops obviously-unsafe ids reaching a session.)
pub fn valid_android_package(pkg: &str) -> bool {
    if pkg.is_empty() {
        return false;
    }
    pkg.split('.').all(|seg| {
        !seg.is_empty()
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// Outcome of a session [`PackageInstallerBridge::commit`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommitOutcome {
    /// Fresh install succeeded (`STATUS_SUCCESS`, mode `Full`).
    Installed,
    /// In-place upgrade succeeded.
    Updated,
    /// PMS wants a confirmation dialog. The engine must route to the UI flow —
    /// this is the honest "not silent" signal for an under-privileged store.
    PendingUserAction,
    /// Commit failed with a `PackageInstaller.STATUS_*` code.
    Failed { code: i32, message: String },
}

// ---------------------------------------------------------------------------
// Capability model: what kind of device posture a store process has.
// ---------------------------------------------------------------------------

/// How privileged the AmOS store process is on the current device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Privilege {
    /// Shell/root: can drive PMS directly (`pm install`), fully silent.
    Root,
    /// Preinstalled priv-app signed with the **platform key** and allow-listed
    /// in `privapp-permissions.xml` (holds `INSTALL_PACKAGES`) — the OEM path.
    PlatformPrivileged,
    /// A privileged app that is signature-matched to a preinstalled app (e.g. a
    /// device-owner / carrier preload) sharing the install permission.
    DeviceOwnerPrivileged,
    /// Ordinary sideloaded store holding only `REQUEST_INSTALL_PACKAGES` —
    /// installs always end in a visible confirmation dialog.
    Sideload,
}

impl Privilege {
    /// Best-case API the store can use from this posture (see module doc for the
    /// Android semantics behind each level).
    pub const fn api_level(self) -> ApiLevel {
        match self {
            Privilege::Root => ApiLevel::SystemShell,
            Privilege::PlatformPrivileged | Privilege::DeviceOwnerPrivileged => {
                ApiLevel::PrivilegedSession
            }
            Privilege::Sideload => ApiLevel::PublicApi,
        }
    }
}

/// The install API surface realistically reachable from a [`Privilege`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiLevel {
    /// Direct system-server control (root shell / `pm`). Fully silent.
    SystemShell,
    /// Public `PackageInstaller` sessions that commit **without** a confirmation
    /// dialog because the caller is a priv-app holding `INSTALL_PACKAGES`.
    PrivilegedSession,
    /// Public `PackageInstaller`; every commit surfaces
    /// `STATUS_PENDING_USER_ACTION` and needs a consent UI.
    PublicApi,
}

impl ApiLevel {
    /// True if a commit from this API level can be invisible to the user.
    pub const fn allows_silent_commit(self) -> bool {
        matches!(self, ApiLevel::SystemShell | ApiLevel::PrivilegedSession)
    }
}

/// A snapshot of the store's install capability on the current device, plus the
/// facts that justify it. This is the single source of truth the engine queries
/// before deciding whether a silent install is possible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Posture {
    pub privilege: Privilege,
    /// `android.permission.INSTALL_PACKAGES` actually granted to this uid.
    pub has_install_packages: bool,
    /// The store APK is signed with the platform (framework) key.
    pub platform_signed: bool,
    /// The store is allow-listed in `privapp-permissions.xml` (Android 9+).
    pub privapp_allowlisted: bool,
}

impl Posture {
    /// The default for a normal sideloaded store: never silent.
    pub const fn sideload() -> Posture {
        Posture {
            privilege: Privilege::Sideload,
            has_install_packages: false,
            platform_signed: false,
            privapp_allowlisted: false,
        }
    }

    /// The posture an OEM preinstall should yield (see [`preconditions`]).
    pub const fn oem_platform() -> Posture {
        Posture {
            privilege: Privilege::PlatformPrivileged,
            has_install_packages: true,
            platform_signed: true,
            privapp_allowlisted: true,
        }
    }

    /// True when a commit from this posture can be truly silent (no pop-up).
    ///
    /// Root is always silent. Otherwise we require the *whole* privileged chain:
    /// the permission is granted **and** the priv-app allow-list (Android 9
    /// `PrivappPermsViolation` enforcement) is in place **and** the signature
    /// matches the platform key. A `DeviceOwnerPrivileged` store is treated as
    /// silent only when it genuinely holds the permission.
    pub fn can_silent_commit(&self) -> bool {
        match self.privilege {
            Privilege::Root => true,
            Privilege::PlatformPrivileged => {
                self.has_install_packages && self.platform_signed && self.privapp_allowlisted
            }
            Privilege::DeviceOwnerPrivileged => self.has_install_packages,
            Privilege::Sideload => false,
        }
    }

    /// If not silent, the *first* missing silent gate as a human-readable reason
    /// (so a CLI/Tauri bridge can tell an integrator what to fix).
    pub fn silent_gap(&self) -> Option<&'static str> {
        if self.can_silent_commit() {
            return None;
        }
        match self.privilege {
            Privilege::Sideload => Some(
                "store is sideloaded: preinstall it under /system/priv-app signed with \
                 the platform key (see android::preconditions)",
            ),
            Privilege::PlatformPrivileged if !self.has_install_packages => Some(
                "priv-app lacks INSTALL_PACKAGES: add it to privapp-permissions.xml",
            ),
            Privilege::PlatformPrivileged if !self.platform_signed => {
                Some("priv-app is not signed with the platform key")
            }
            Privilege::PlatformPrivileged => Some(
                "priv-app not allow-listed in privapp-permissions.xml (Android 9+)",
            ),
            Privilege::DeviceOwnerPrivileged => {
                Some("device-owner store does not hold INSTALL_PACKAGES")
            }
            Privilege::Root => None, // unreachable: Root is always silent
        }
    }
}

// ---------------------------------------------------------------------------
// OEM preinstall precondition checklist.
// ---------------------------------------------------------------------------

/// Which part of the system a [`Precondition`] touches, for grouping in reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreconditionArea {
    /// The APK *being installed* (target app) — signing / version rules.
    TargetPackage,
    /// How the store APK itself is signed and placed on the partition.
    StoreSigning,
    /// Where the store APK lives on the system image.
    StorePlacement,
    /// Runtime permission / policy allow-lists (PMS enforcement).
    DevicePolicy,
    /// Session-API usage rules on the bridge side.
    ApiUsage,
}

/// One documented precondition for a silent ("无感") privileged install path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Precondition {
    /// Stable short id, e.g. `sign.platform-key`.
    pub id: &'static str,
    pub area: PreconditionArea,
    /// What must be true.
    pub what: &'static str,
    /// Where / which artifact it applies to.
    pub where_: &'static str,
    /// Whether this precondition is what actually gates *silence* (vs. just a
    /// best-practice for updates / ownership).
    pub silent_gate: bool,
}

/// The full, documented precondition list an OEM integration must satisfy.
/// See also [`Posture`] for the runtime half of these.
pub fn preconditions() -> &'static [Precondition] {
    &[
        Precondition {
            id: "target.v2-signed",
            area: PreconditionArea::TargetPackage,
            what: "APK is signed with APK Signature Scheme v2/v3 using a stable cert",
            where_: "target APK before publishing",
            silent_gate: true,
        },
        Precondition {
            id: "target.versioncode",
            area: PreconditionArea::TargetPackage,
            what: "versionCode is monotonic so an upgrade replaces the old package",
            where_: "target APK versioning",
            silent_gate: false,
        },
        Precondition {
            id: "store.platform-key",
            area: PreconditionArea::StoreSigning,
            what: "store APK is signed with the platform (framework) key so it can be a priv-app with signature|privileged perms",
            where_: "AmosStore APK signing cert == framework/platform cert",
            silent_gate: true,
        },
        Precondition {
            id: "store.priv-app",
            area: PreconditionArea::StorePlacement,
            what: "store APK is preinstalled under /system/priv-app (not /system/app)",
            where_: PRIV_APP_DIR,
            silent_gate: true,
        },
        Precondition {
            id: "store.privapp-permissions",
            area: PreconditionArea::DevicePolicy,
            what: "store is allow-listed with INSTALL_PACKAGES in privapp-permissions.xml (Android 9+ PrivappPermsViolation)",
            where_: PRIVAPP_PERMISSIONS_XML,
            silent_gate: true,
        },
        Precondition {
            id: "store.extra-perms",
            area: PreconditionArea::DevicePolicy,
            what: "optionally also grant DELETE_PACKAGES / INSTALL_GRANT_RUNTIME_PERMISSIONS for silent update + permission flows",
            where_: PRIVAPP_PERMISSIONS_XML,
            silent_gate: false,
        },
        Precondition {
            id: "bridge.installer-of-record",
            area: PreconditionArea::ApiUsage,
            what: "store sets itself as the installer-of-record (setInstallerPackageName) to own updates",
            where_: "PackageInstaller.SessionParams",
            silent_gate: false,
        },
        Precondition {
            id: "bridge.no-user-action",
            area: PreconditionArea::ApiUsage,
            what: "silent commits are issued with requireUserAction disabled and session mode set correctly",
            where_: "PackageInstaller.SessionParams",
            silent_gate: true,
        },
        Precondition {
            id: "bridge.reason",
            area: PreconditionArea::ApiUsage,
            what: "install reason is set (USER/DEVICE_SETUP/POLICY) so the device classifies the install",
            where_: "PackageInstaller.SessionParams",
            silent_gate: false,
        },
    ]
}

/// The subset of [`preconditions`] that directly gate *silence* (no pop-up), as
/// opposed to merely best-practice update hygiene. Handy for an integrator
/// report that says "these are the load-bearing requirements."
pub fn silent_gating_preconditions() -> impl Iterator<Item = &'static Precondition> {
    preconditions().iter().filter(|p| p.silent_gate)
}

// ---------------------------------------------------------------------------
// Bridge seam + FFI placeholder surface.
// ---------------------------------------------------------------------------

/// The Rust seam between the store engine and the on-device `PackageInstaller`.
///
/// This is deliberately shaped like the crate's `StoreProvider` seam: the
/// engine depends on the *trait*, and a real implementation is provided by the
/// device side (a Tauri/JNI priv-app plugin that talks to
/// `android.content.pm.PackageInstaller`). Keeping the trait here lets the
/// whole download→verify→install lifecycle be modelled and unit-tested without
/// an emulator.
pub trait PackageInstallerBridge: Send + Sync {
    /// Current device posture this bridge can rely on.
    fn posture(&self) -> Posture;

    /// Open a new install/update session for `req`. Returns an opaque handle.
    ///
    /// A sideloaded store (no silent capability) refuses a *silent* request here
    /// with a clear message — it can never deliver a silent install, so it must
    /// not pretend otherwise.
    fn open_session(&self, req: &InstallRequest) -> Result<Session>;

    /// Stream `apk` bytes into the already-open session.
    fn write_apk(&self, session: &mut Session, apk: &[u8]) -> Result<()>;

    /// Commit the staged session. Returns the real outcome; a sideload bridge
    /// reports [`CommitOutcome::PendingUserAction`] so the UI flow can take over.
    fn commit(&self, session: Session) -> Result<CommitOutcome>;

    /// Abandon a session that should not be committed (frees staged data).
    fn abandon(&self, session: Session) -> Result<()>;
}

/// Opaque handle to an open, staged install session. Real bridge impls back
/// this with a `PackageInstallerSession` id on the JNI side.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub session_id: i32,
    pub package: String,
    pub mode: InstallMode,
}

impl Session {
    pub fn new(session_id: i32, req: &InstallRequest) -> Session {
        Session {
            session_id,
            package: req.package.clone(),
            mode: req.mode,
        }
    }
}

/// Default, always-compiling bridge used when no real JNI backend is linked
/// (headless/tests). It models a **sideloaded** store honestly: silent commits
/// are refused and user-visible installs are reported as pending user action.
pub struct SideloadOnlyBridge {
    posture: Posture,
}

impl SideloadOnlyBridge {
    pub const fn new(posture: Posture) -> SideloadOnlyBridge {
        SideloadOnlyBridge { posture }
    }
}

impl PackageInstallerBridge for SideloadOnlyBridge {
    fn posture(&self) -> Posture {
        self.posture
    }

    fn open_session(&self, req: &InstallRequest) -> Result<Session> {
        req.validate()?;
        if req.expect_silent && !self.posture.can_silent_commit() {
            // Honest refusal: a store that cannot meet a silent expectation.
            let gap = self
                .posture
                .silent_gap()
                .unwrap_or("posture is not silent-capable");
            return Err(StoreError::Provider(format!(
                "cannot open silent install session for {}: {gap}",
                req.package
            )));
        }
        // Deterministic placeholder id: the engine treats it as opaque.
        Ok(Session::new(1, req))
    }

    fn write_apk(&self, _session: &mut Session, _apk: &[u8]) -> Result<()> {
        // No on-device staging exists in this placeholder; the trait contract is
        // exercised identically to a real bridge so callers don't change.
        Ok(())
    }

    fn commit(&self, session: Session) -> Result<CommitOutcome> {
        if self.posture.can_silent_commit() {
            return Ok(match session.mode {
                InstallMode::Full => CommitOutcome::Installed,
                InstallMode::InheritExisting => CommitOutcome::Updated,
            });
        }
        // Sideloaded: PMS would demand a confirmation dialog. Be honest.
        Ok(CommitOutcome::PendingUserAction)
    }

    fn abandon(&self, _session: Session) -> Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// FFI placeholder surface (what the JNI bridge ABI must look like).
// ---------------------------------------------------------------------------

/// FFI placeholder: the C ABI shape a JNI/priv-app bridge will marshal between
/// Rust and the Java `PackageInstaller` layer.
///
/// This is **documentation-as-types**: pure-`repr(C)` values that always compile
/// and pin down the wire contract (session id, mode, status codes) so a native
/// bridge and the Rust engine can't drift. Real JNI method binding happens in
/// the Tauri/`amos-android` plugin, out of this crate.
pub mod ffi {
    /// `repr(C)` marshalled install request crossing the FFI boundary. Mirrors
    /// [`crate::android::InstallRequest`] but plain-int/owned-byte so both sides
    /// (Rust and JNI) can serialize it without sharing types.
    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct CInstallRequest {
        /// `PackageInstaller.SessionParams` mode (1 = full, 2 = inherit existing).
        pub mode_code: i32,
        /// `versionCode` of the APK being installed.
        pub version_code: i64,
        /// 1 when the caller expects silence (0 otherwise).
        pub expect_silent: i32,
        /// Reserved for future flags; must be zero.
        pub flags: i32,
    }

    /// `repr(C)` commit result mirroring a `PackageInstaller.STATUS_*` code plus
    /// a UTF-8 message. `code` matches the public constants in the parent module.
    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct CCommitResult {
        /// `STATUS_SUCCESS`(0), `STATUS_FAILURE`(+), `STATUS_PENDING_USER_ACTION`(-1).
        pub status: i32,
        /// 1 = fresh install, 2 = in-place update, 0 = unknown (on failure).
        pub outcome_kind: i32,
        /// First byte of an optional NUL-terminated UTF-8 message (see `message_len`).
        pub message: [i8; 256],
        pub message_len: usize,
    }

    impl CInstallRequest {
        pub const fn silent() -> CInstallRequest {
            CInstallRequest {
                mode_code: super::INSTALL_MODE_FULL,
                version_code: 0,
                expect_silent: 1,
                flags: 0,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_mode_code_roundtrips() {
        assert_eq!(InstallMode::Full.code(), INSTALL_MODE_FULL);
        assert_eq!(InstallMode::InheritExisting.code(), INSTALL_MODE_INHERIT_EXISTING);
        assert_eq!(InstallMode::from_code(INSTALL_MODE_FULL), Some(InstallMode::Full));
        assert_eq!(InstallMode::from_code(2), Some(InstallMode::InheritExisting));
        assert_eq!(InstallMode::from_code(99), None);
    }

    #[test]
    fn status_codes_map_to_names() {
        assert_eq!(status_name(STATUS_PENDING_USER_ACTION), "pending user action");
        assert_eq!(status_name(STATUS_SUCCESS), "success");
        assert_eq!(status_name(-1234), "unknown status");
    }

    #[test]
    fn package_id_validation_is_sane() {
        for good in ["com.amos.mail", "org.foo.bar_2", "a", "com.Amos"] {
            assert!(valid_android_package(good), "{good:?} should be valid");
        }
        for bad in ["", "..", "has space", "a/..", "com.", ".com", "a.b..c"] {
            assert!(!valid_android_package(bad), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn request_validation_rejects_bad_package() {
        let req = InstallRequest {
            package: "com.foo".into(),
            apk_name: "base.apk".into(),
            mode: InstallMode::Full,
            version_code: 1,
            expect_silent: false,
            label: None,
        };
        assert!(req.validate().is_ok());
        let mut bad = req.clone();
        bad.package = "has space".into();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn posture_gating_reflects_the_privileged_chain() {
        // Sideloaded store: never silent, with a useful gap message.
        let s = Posture::sideload();
        assert!(!s.can_silent_commit());
        assert!(s.silent_gap().is_some());

        // Full OEM platform posture: silent.
        assert!(Posture::oem_platform().can_silent_commit());
        assert!(Privilege::PlatformPrivileged.api_level().allows_silent_commit());

        // Priv-app placed but missing the allow-list / platform signature -> not silent.
        let incomplete = Posture {
            privilege: Privilege::PlatformPrivileged,
            has_install_packages: true,
            platform_signed: false,
            privapp_allowlisted: false,
        };
        assert!(!incomplete.can_silent_commit());
        assert!(incomplete.silent_gap().is_some());

        // Sideload API level must never allow a silent commit.
        assert!(!Privilege::Sideload.api_level().allows_silent_commit());

        // Root is always silent.
        let root = Posture {
            privilege: Privilege::Root,
            has_install_packages: true,
            platform_signed: true,
            privapp_allowlisted: true,
        };
        assert!(root.can_silent_commit());
        assert_eq!(root.silent_gap(), None);
    }

    #[test]
    fn precondition_list_is_populated_and_ids_unique() {
        let list = preconditions();
        assert!(!list.is_empty());
        let mut ids = std::collections::BTreeSet::new();
        for p in list {
            assert!(ids.insert(p.id), "duplicate precondition id {}", p.id);
        }
        assert!(
            silent_gating_preconditions().count() > 0,
            "must document at least one load-bearing silent gate"
        );
    }

    #[test]
    fn sideload_bridge_refuses_silent_but_commits_pending_user_action() {
        let bridge = SideloadOnlyBridge::new(Posture::sideload());
        let silent = InstallRequest {
            package: "com.amos.mail".into(),
            apk_name: "base.apk".into(),
            mode: InstallMode::InheritExisting,
            version_code: 2,
            expect_silent: true,
            label: Some("Amos Mail".into()),
        };
        // A sideloaded store that *expects silence* must be refused up front.
        assert!(bridge.open_session(&silent).is_err());

        // A normal (user-visible) install is accepted but reports the UI step.
        let visible = InstallRequest {
            expect_silent: false,
            ..silent.clone()
        };
        let mut s = bridge.open_session(&visible).unwrap();
        bridge.write_apk(&mut s, b"PK\x03\x04fake").unwrap();
        assert_eq!(bridge.commit(s).unwrap(), CommitOutcome::PendingUserAction);
    }

    #[test]
    fn oem_platform_bridge_commits_silently() {
        let bridge = SideloadOnlyBridge::new(Posture::oem_platform());
        let req = InstallRequest {
            package: "com.amos.mail".into(),
            apk_name: "base.apk".into(),
            mode: InstallMode::Full,
            version_code: 3,
            expect_silent: true,
            label: None,
        };
        let mut s = bridge.open_session(&req).unwrap();
        bridge.write_apk(&mut s, b"PK\x03\x04real").unwrap();
        assert_eq!(bridge.commit(s).unwrap(), CommitOutcome::Installed);
    }

    #[test]
    fn ffi_placeholder_compiles_and_keeps_contract() {
        let c = ffi::CInstallRequest::silent();
        assert_eq!(c.mode_code, INSTALL_MODE_FULL);
        assert_eq!(c.expect_silent, 1);
        assert_eq!(c.flags, 0);
        assert_eq!(super::status_name(-1), "pending user action");
    }
}







