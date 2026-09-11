//! Spec types for the AmOS device-care (手机管家) domain.
//!
//! This module is the *vocabulary* of the phone manager: what may be cleaned,
//! which app may be uninstalled, what a permission review row is, and how a
//! device-care grade is expressed. Everything is `serde`-serializable so the
//! Tauri bridge can hand the same shapes to the WebView without a second model
//! drifting from this one.
//!
//! # The safety property that matters most
//!
//! [`JunkKind`] enumerates the **only** things this domain may ever consider
//! reclaimable. User media (photos/videos/music), documents, contacts, messages
//! and app private data are *not modelled as junk at all* — so no code path, and
//! no future UI, can select them for deletion. The safety property holds **by
//! construction**, not by a runtime check that a later change could regress.

use serde::{Deserialize, Serialize};

/// Maximum number of entries a single scan may hand to the analyzer before the
/// domain refuses (rather than silently truncating a destructive input).
pub const MAX_JUNK_ITEMS: usize = 10_000;

/// Maximum number of items a single clean plan may contain. Larger work must be
/// split by the caller so no one request is unboundedly destructive.
pub const MAX_CLEAN_BATCH: usize = 5_000;

/// A category of reclaimable, re-creatable material.
///
/// Deliberately absent: user media, documents, contacts, SMS, app data. See the
/// module docs — those are never junk by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JunkKind {
    /// Re-creatable app cache (`cache/`, `code_cache/`).
    AppCache,
    /// Left-over installer payloads (`*.apk`, `*.apks`, `*.xapk`).
    ApkInstaller,
    /// Rotated / expired log files.
    LogFile,
    /// Temporary files (`*.tmp`, editor swap files).
    TempFile,
    /// Regenerable image thumbnails.
    Thumbnail,
    /// Crash dumps and tombstones (`tombstones/`, `*.dmp`).
    CrashDump,
    /// Empty directories left behind by uninstalled apps.
    EmptyDir,
    /// A download the user has **not** marked to keep. Review-only: a download
    /// may be the user's only copy, so it is never auto-selected.
    StaleDownload,
}

impl JunkKind {
    /// Every kind, in a stable order (drives deterministic report/plan output).
    pub const ALL: [JunkKind; 8] = [
        JunkKind::AppCache,
        JunkKind::ApkInstaller,
        JunkKind::LogFile,
        JunkKind::TempFile,
        JunkKind::Thumbnail,
        JunkKind::CrashDump,
        JunkKind::EmptyDir,
        JunkKind::StaleDownload,
    ];

    /// Stable lowercase tag (serde wire tag; probe/audit logs key on it).
    pub const fn key(self) -> &'static str {
        match self {
            JunkKind::AppCache => "app_cache",
            JunkKind::ApkInstaller => "apk_installer",
            JunkKind::LogFile => "log_file",
            JunkKind::TempFile => "temp_file",
            JunkKind::Thumbnail => "thumbnail",
            JunkKind::CrashDump => "crash_dump",
            JunkKind::EmptyDir => "empty_dir",
            JunkKind::StaleDownload => "stale_download",
        }
    }

    /// i18n key for this category's display label.
    pub const fn label_key(self) -> &'static str {
        match self {
            JunkKind::AppCache => "care.junk.appCache",
            JunkKind::ApkInstaller => "care.junk.apkInstaller",
            JunkKind::LogFile => "care.junk.logFile",
            JunkKind::TempFile => "care.junk.tempFile",
            JunkKind::Thumbnail => "care.junk.thumbnail",
            JunkKind::CrashDump => "care.junk.crashDump",
            JunkKind::EmptyDir => "care.junk.emptyDir",
            JunkKind::StaleDownload => "care.junk.staleDownload",
        }
    }

    /// Whether this kind may be cleaned without a second user confirmation.
    pub const fn is_auto_cleanable(self) -> bool {
        !matches!(self, JunkKind::StaleDownload)
    }

    /// Whether this kind requires explicit acknowledgement before it is planned.
    pub const fn needs_review(self) -> bool {
        !self.is_auto_cleanable()
    }

    /// Parse a stable wire tag back into a kind (`None` for unknown tags — the
    /// domain never guesses, so an unknown tag is an honest error at the edge).
    pub fn from_key(s: &str) -> Option<Self> {
        JunkKind::ALL.into_iter().find(|k| k.key() == s)
    }
}

/// One candidate entry produced by a scan (a `uri` plus what it is).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JunkItem {
    /// Opaque, provider-owned address (a `content://`/path/`mock://` string).
    pub uri: String,
    pub kind: JunkKind,
    pub size_bytes: u64,
    /// Owning package, when the backend knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

impl JunkItem {
    /// A new item with no known owner.
    pub fn new(uri: impl Into<String>, kind: JunkKind, size_bytes: u64) -> Self {
        Self {
            uri: uri.into(),
            kind,
            size_bytes,
            owner: None,
        }
    }

    /// Attach an owning package (builder style).
    pub fn with_owner(mut self, owner: impl Into<String>) -> Self {
        self.owner = Some(owner.into());
        self
    }
}

/// One aggregated row of a [`JunkReport`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JunkGroup {
    pub kind: JunkKind,
    pub count: usize,
    pub bytes: u64,
}

/// The summary a scanner produces: per-kind totals, never the raw item list.
///
/// Keeping the raw list out of the report means the report can be shown, logged
/// or persisted without carrying thousands of paths — and the cleaner is handed
/// the items the caller actually scanned, so nothing is quietly re-read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JunkReport {
    /// Only kinds that were actually present, in [`JunkKind::ALL`] order.
    pub groups: Vec<JunkGroup>,
    pub total_items: usize,
    pub total_bytes: u64,
}

impl JunkReport {
    /// Bytes cleanable without a second confirmation.
    ///
    /// Saturating (like every other sum in this crate): a self-inconsistent or
    /// hostile scan may report huge per-item sizes, and summing two groups would
    /// otherwise overflow — panicking in a debug build and silently wrapping in a
    /// release one.
    pub fn reclaimable_bytes(&self) -> u64 {
        self.groups
            .iter()
            .filter(|g| g.kind.is_auto_cleanable())
            .map(|g| g.bytes)
            .fold(0u64, u64::saturating_add)
    }

    /// Bytes that need an explicit user decision before they can be planned.
    /// Saturating for the same reason as [`JunkReport::reclaimable_bytes`].
    pub fn review_bytes(&self) -> u64 {
        self.groups
            .iter()
            .filter(|g| g.kind.needs_review())
            .map(|g| g.bytes)
            .fold(0u64, u64::saturating_add)
    }

    /// The group for one kind, if present.
    pub fn group(&self, kind: JunkKind) -> Option<&JunkGroup> {
        self.groups.iter().find(|g| g.kind == kind)
    }

    /// True when nothing reclaimable was found.
    pub fn is_empty(&self) -> bool {
        self.total_items == 0
    }
}

/// What the caller is asking to clean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanRequest {
    /// The categories the user selected.
    pub kinds: Vec<JunkKind>,
    /// Set **only** after the user has explicitly confirmed review-only kinds.
    /// Without it, planning a review-only kind is refused
    /// ([`crate::DevCareError::InvalidArguments`]).
    #[serde(default)]
    pub acknowledge_review: bool,
}

impl CleanRequest {
    /// A request for the given kinds, review unacknowledged.
    pub fn new(kinds: impl IntoIterator<Item = JunkKind>) -> Self {
        Self {
            kinds: kinds.into_iter().collect(),
            acknowledge_review: false,
        }
    }

    /// Acknowledge the review-only kinds in this request.
    pub fn acknowledging_review(mut self) -> Self {
        self.acknowledge_review = true;
        self
    }
}

/// A frozen, deterministic set of items the cleaner will act on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanPlan {
    /// Sorted by `(kind, uri)` so the same scan always yields the same plan.
    pub items: Vec<JunkItem>,
    pub total_bytes: u64,
}

impl CleanPlan {
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// An item the backend refused or failed to remove, with its reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanFailure {
    pub uri: String,
    pub kind: JunkKind,
    pub size_bytes: u64,
    pub message: String,
}

/// The honest result of a clean run, item by item.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanOutcome {
    /// Items the backend confirmed removed.
    pub removed: Vec<JunkItem>,
    /// Bytes actually freed — counts confirmed removals only, never guesses.
    pub freed_bytes: u64,
    /// Every failure, so a partial clean is never reported as a success.
    pub failures: Vec<CleanFailure>,
}

impl CleanOutcome {
    pub fn removed_count(&self) -> usize {
        self.removed.len()
    }

    pub fn failed_count(&self) -> usize {
        self.failures.len()
    }

    /// True when at least one item was planned but could not be removed.
    pub fn is_partial(&self) -> bool {
        !self.failures.is_empty()
    }

    /// Total items the clean attempted: confirmed removals **plus** reported
    /// failures.
    ///
    /// Invariant for any plan produced by [`crate::plan`]:
    /// `outcome.attempted() == plan.len()`, unless `execute` was given a provider
    /// that panicked (it never does). A caller can therefore assert that no
    /// planned item was silently skipped.
    pub fn attempted(&self) -> usize {
        self.removed.len() + self.failures.len()
    }
}

/// A third-party or system package as seen by the device-care app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppPackage {
    pub id: String,
    pub name: String,
    /// A platform-bundled package (`ApplicationInfo.FLAG_SYSTEM`).
    pub system: bool,
    pub size_bytes: u64,
}

impl AppPackage {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            system: false,
            size_bytes: 0,
        }
    }

    /// Mark this package as platform-bundled (builder style).
    pub fn system(mut self, system: bool) -> Self {
        self.system = system;
        self
    }

    pub fn with_size(mut self, size_bytes: u64) -> Self {
        self.size_bytes = size_bytes;
        self
    }
}

/// Whether a package may be uninstalled, from the device-care point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UninstallVerdict {
    /// A normal user app: removable.
    Allowed,
    /// Platform-bundled app: protected (removing it can brick the device).
    SystemApp,
    /// An app the policy pins as critical (the System UI, Settings, the phone
    /// manager itself): never removable, even if the platform would allow it.
    Protected,
}

impl UninstallVerdict {
    pub const fn is_allowed(self) -> bool {
        matches!(self, UninstallVerdict::Allowed)
    }

    pub const fn key(self) -> &'static str {
        match self {
            UninstallVerdict::Allowed => "allowed",
            UninstallVerdict::SystemApp => "system_app",
            UninstallVerdict::Protected => "protected",
        }
    }

    /// i18n key explaining a refusal (`None` when allowed).
    pub const fn reason_key(self) -> Option<&'static str> {
        match self {
            UninstallVerdict::Allowed => None,
            UninstallVerdict::SystemApp => Some("care.uninstall.systemApp"),
            UninstallVerdict::Protected => Some("care.uninstall.protected"),
        }
    }
}

/// A sensitive resource a permission review row can mention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensitiveResource {
    Microphone,
    Camera,
    Location,
    Contacts,
    Storage,
    Sms,
    Phone,
}

impl SensitiveResource {
    pub const ALL: [SensitiveResource; 7] = [
        SensitiveResource::Microphone,
        SensitiveResource::Camera,
        SensitiveResource::Location,
        SensitiveResource::Contacts,
        SensitiveResource::Storage,
        SensitiveResource::Sms,
        SensitiveResource::Phone,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            SensitiveResource::Microphone => "microphone",
            SensitiveResource::Camera => "camera",
            SensitiveResource::Location => "location",
            SensitiveResource::Contacts => "contacts",
            SensitiveResource::Storage => "storage",
            SensitiveResource::Sms => "sms",
            SensitiveResource::Phone => "phone",
        }
    }

    pub const fn label_key(self) -> &'static str {
        match self {
            SensitiveResource::Microphone => "perm.cap.microphone",
            SensitiveResource::Camera => "perm.cap.camera",
            SensitiveResource::Location => "perm.cap.location",
            SensitiveResource::Contacts => "perm.cap.contacts",
            SensitiveResource::Storage => "perm.cap.storage",
            SensitiveResource::Sms => "perm.cap.sms",
            SensitiveResource::Phone => "perm.cap.phone",
        }
    }

    /// Parse a stable wire tag back into a resource (`None` for unknown tags —
    /// the domain never guesses).
    pub fn from_key(s: &str) -> Option<Self> {
        SensitiveResource::ALL.into_iter().find(|r| r.key() == s)
    }
}

/// One grant/deny observation fed into the permission review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionGrant {
    pub app_id: String,
    pub resource: SensitiveResource,
    pub granted: bool,
}

impl PermissionGrant {
    pub fn granted(app_id: impl Into<String>, resource: SensitiveResource) -> Self {
        Self {
            app_id: app_id.into(),
            resource,
            granted: true,
        }
    }

    pub fn denied(app_id: impl Into<String>, resource: SensitiveResource) -> Self {
        Self {
            app_id: app_id.into(),
            resource,
            granted: false,
        }
    }
}

/// One app and the sensitive resources it currently holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SensitiveAppRow {
    pub app_id: String,
    /// Deduplicated, in [`SensitiveResource::ALL`] order.
    pub resources: Vec<SensitiveResource>,
}

impl SensitiveAppRow {
    pub fn count(&self) -> usize {
        self.resources.len()
    }
}

/// The four areas a care report speaks about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CareArea {
    Storage,
    Apps,
    Battery,
    Permissions,
}

impl CareArea {
    pub const fn key(self) -> &'static str {
        match self {
            CareArea::Storage => "storage",
            CareArea::Apps => "apps",
            CareArea::Battery => "battery",
            CareArea::Permissions => "permissions",
        }
    }

    pub const fn label_key(self) -> &'static str {
        match self {
            CareArea::Storage => "care.area.storage",
            CareArea::Apps => "care.area.apps",
            CareArea::Battery => "care.area.battery",
            CareArea::Permissions => "care.area.permissions",
        }
    }
}

/// How much a finding matters. Ordered `Info < Suggestion < Warning < Critical`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Suggestion,
    Warning,
    Critical,
}

impl Severity {
    pub const fn key(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Suggestion => "suggestion",
            Severity::Warning => "warning",
            Severity::Critical => "critical",
        }
    }
}

/// The overall care grade, derived from the score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum CareGrade {
    A,
    B,
    C,
    D,
}

impl CareGrade {
    /// Grade from a 0–100 score (A ≥ 90, B ≥ 75, C ≥ 60, else D).
    pub const fn from_score(score: u8) -> Self {
        if score >= 90 {
            CareGrade::A
        } else if score >= 75 {
            CareGrade::B
        } else if score >= 60 {
            CareGrade::C
        } else {
            CareGrade::D
        }
    }

    pub const fn key(self) -> &'static str {
        match self {
            CareGrade::A => "a",
            CareGrade::B => "b",
            CareGrade::C => "c",
            CareGrade::D => "d",
        }
    }
}

/// One thing the device-care report wants the user to know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CareFinding {
    pub area: CareArea,
    pub severity: Severity,
    /// Stable i18n key for the wording.
    pub key: String,
    /// Optional, non-localized detail (a number, a package id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Bytes this finding is about, when it is about storage.
    #[serde(default)]
    pub reclaimable_bytes: u64,
}

/// The folded device-care snapshot shown on the manager's home screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CareReport {
    /// 0–100, higher is healthier. Only ever reduced by real findings.
    ///
    /// **Vacuous when [`CareReport::assessed`] is empty**: a caller with no data
    /// must show "unknown", never "100 / grade A".
    pub score: u8,
    pub grade: CareGrade,
    /// Sorted most-severe first, then by area/key (deterministic).
    pub findings: Vec<CareFinding>,
    /// The areas this report actually had data for, in [`CareArea`] order.
    #[serde(default)]
    pub assessed: Vec<CareArea>,
}

impl CareReport {
    /// Findings at or above the given severity.
    pub fn at_least(&self, severity: Severity) -> impl Iterator<Item = &CareFinding> {
        self.findings.iter().filter(move |f| f.severity >= severity)
    }

    pub fn is_empty(&self) -> bool {
        self.findings.is_empty()
    }

    /// Whether any area had data. `false` ⇒ the score must not be shown.
    pub fn has_data(&self) -> bool {
        !self.assessed.is_empty()
    }

    /// Whether `area` was assessed in this report.
    pub fn assessed_area(&self, area: CareArea) -> bool {
        self.assessed.contains(&area)
    }
}
