//! Tauri <-> device-care (手机管家) bridge.
//!
//! Exposes the `amos-devocare` kernel to the WebView. The bridge owns the scan
//! snapshot and the clean backend; the WebView only ever names **categories**,
//! never a path:
//!
//! ```text
//!   WebView: devcare_clean(["app_cache","log_file"], acknowledge_review=false)
//!        │
//!        ▼
//!   bridge: plan(own snapshot, request) ──▶ execute(plan, own provider)
//! ```
//!
//! # Why the frontend cannot name a file to delete
//!
//! `devcare_clean` re-derives the plan from the bridge's **own** scan snapshot.
//! A `uri` from the WebView is never accepted, so a compromised or buggy UI
//! cannot ask the cleaner to delete an arbitrary path — it can only ask for a
//! modelled category, which is exactly what [`amos_devocare::junk::plan`]
//! validates. The same holds for what is scanned: only the backend decides.
//!
//! # Backends (honest by default)
//!
//! * `AMOS_DEVCARE_ROOT` unset → **no backend**. The manager reports
//!   `available: false` / `backend: "none"`; it never invents a scan or a
//!   package list (P0-3: unobserved is reported as unknown, not as healthy).
//! * `AMOS_DEVCARE_ROOT` set → a [`amos_devocare::HostFsScanner`] +
//!   [`amos_devocare::HostFsCleanProvider`] confined to that root (desktop /
//!   rooted device / Waydroid). A real Android `PackageManager`/`MediaStore`
//!   backend is the next device step, not faked here.
//!
//! Business logic lives in [`DevCareBridge`] methods (directly unit-tested); the
//! `#[tauri::command]` wrappers are thin.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use amos_devocare::{
    audit, health, hostfs, junk, permissions, AppPackage, BatteryCare, CareInput, CareReport,
    CleanProvider, CleanRequest, DevCareError, HostScan, JunkGroup, JunkItem, JunkKind, JunkReport,
    PermissionGrant, SensitiveResource, UninstallGuard,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::appstore::{InstalledEntry, StoreBridge};

/// Env var that opts a host/root deployment into the real filesystem backend.
pub const ROOT_ENV: &str = "AMOS_DEVCARE_ROOT";

/// Stability key for "there is no scan/clean backend in this process".
pub const BACKEND_NONE: &str = "none";
/// Stability key for the root-confined filesystem backend.
pub const BACKEND_HOST_FS: &str = "host-fs";
/// Stability key for the on-device Android backend (Kotlin `DevCareGlue`).
pub const BACKEND_ANDROID: &str = "android";

/* --------------------------- backend seams --------------------------- */

/// The **scan + storage** half of a backend.
///
/// Kept separate from [`CleanProvider`] so a backend can expose a scanner
/// without also owning the destructive half, and so `junk::execute` keeps
/// consuming a plain `&mut dyn CleanProvider` (no trait-object upcasting, which
/// this crate's MSRV does not allow).
///
/// Implementations live at the edges: [`HostFsScan`] wraps the confined
/// filesystem scanner, the Android module wraps the Kotlin `DevCareGlue`.
pub trait CareScanner: Send {
    /// Backend stability key (`"host-fs"`, `"android"`).
    fn name(&self) -> &'static str;
    /// Scan for modelled junk.
    fn scan(&mut self) -> Result<HostScan, DevCareError>;
    /// Whole-device storage totals.
    ///
    /// The default is **unknown**, which is the honest answer for a backend that
    /// cannot measure a device's filesystem — never a fabricated zero.
    fn storage(&mut self) -> StorageTotals {
        StorageTotals::default()
    }
    /// The device battery reading.
    ///
    /// The default is **unknown**: a backend that cannot read the battery must say
    /// so rather than report a healthy charge — the bridge then falls back to the
    /// real host reader (see [`DevCareBridge::report`]).
    fn battery(&mut self) -> BatteryReading {
        BatteryReading::unknown()
    }
}

/// What a package removal actually did.
///
/// The distinction matters on a device: Android's `ACTION_DELETE` shows a system
/// confirmation and reports the result asynchronously, so the bridge can know a
/// request was **launched** without ever being able to claim the app is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    /// The app is confirmed removed.
    Removed,
    /// A removal request reached the platform, which confirms asynchronously.
    Launched,
}

/// The **package** half of a backend: the bridge-owned inventory plus the
/// removal, so the policy preview and the enforcement read the *same* source.
///
/// `Send + Sync` because it is shared (`Arc`) between the preview command and the
/// uninstall command — the two must never see different inventories.
pub trait PackageSource: Send + Sync {
    fn inventory(&self) -> Result<Vec<InstalledEntry>, String>;
    fn uninstall(&self, id: &str) -> Result<Removal, String>;
}

/// The store registry as a [`PackageSource`] (the host/desktop default).
impl PackageSource for StoreBridge {
    fn inventory(&self) -> Result<Vec<InstalledEntry>, String> {
        self.installed_inventory()
    }

    fn uninstall(&self, id: &str) -> Result<Removal, String> {
        // The store removes a web bundle synchronously: by the time this returns,
        // the app is gone from its registry.
        self.uninstall_by_id(id)?;
        Ok(Removal::Removed)
    }
}

/// Whole-device storage totals. Every field is optional: an unknown reading is
/// reported as `None` (never a fabricated zero) — see the P0-3 honesty rule.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StorageTotals {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
}

/// A backend battery reading. Every field is optional, so an unobserved fact stays
/// `None` instead of being invented (P0-3) — the same discipline as
/// [`StorageTotals`].
///
/// On a device the source is the **same** sticky `ACTION_BATTERY_CHANGED`
/// broadcast (`level`/`scale`/`status`) that `amos-power`'s energy governor reads,
/// so the care report and the governor agree on the facts.
/// `thermal_throttled` is the platform's **own** verdict
/// (`PowerManager.getCurrentThermalStatus()`), not a threshold this crate invents.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BatteryReading {
    /// State of charge, 0–100 percent.
    pub level_pct: Option<f64>,
    /// Whether a charger is attached.
    pub charging: Option<bool>,
    /// The platform's thermal-throttling verdict.
    pub thermal_throttled: Option<bool>,
}

impl BatteryReading {
    /// Nothing was observed.
    pub fn unknown() -> Self {
        Self::default()
    }

    /// Fold the reading into the domain's **coupled** [`BatteryCare`], or `None`
    /// when it cannot honestly fill it.
    ///
    /// The asymmetry is deliberate and auditable:
    ///
    /// * an unknown **charging** flag must *not* be defaulted to `false` — that
    ///   would turn a partial reading into a fabricated `care.battery.low` /
    ///   `care.battery.critical` **penalty**, i.e. invent a problem;
    /// * an unknown **thermal** flag is folded as `false` — it can only *withhold*
    ///   the thermal penalty, never manufacture one;
    /// * a level **outside 0–100** is not a reading at all (clamping a negative
    ///   would manufacture a `critical` alarm, clamping a high one would
    ///   manufacture a healthy battery) — the same rule the glue applies at the
    ///   source (`level > scale` ⇒ read failure), kept here as defence in depth
    ///   against a buggy backend.
    ///
    /// The domain refuses a partial state ([`BatteryCare`] couples its fields), so
    /// an unfillable reading is reported as **unobserved**: the battery area stays
    /// out of [`CareReport::assessed`] and the UI shows unknown instead of a
    /// fabricated low-battery warning.
    pub fn care(self) -> Option<BatteryCare> {
        let level = self.level_pct?;
        if !level.is_finite() || !(0.0..=100.0).contains(&level) {
            return None;
        }
        Some(BatteryCare {
            // Round, never truncate: a 20.6% reading must not become 20 and so trip
            // the domain's "at or below 20% is low" threshold (`health::assess`).
            level_pct: level.round() as u8,
            charging: self.charging?,
            thermal_throttled: self.thermal_throttled.unwrap_or(false),
        })
    }
}

/// Fold a real host (desktop) battery reading into a [`BatteryReading`].
///
/// Pure and host-testable. The host readers have **no** thermal-throttling
/// source, so that fact stays unknown (and is therefore folded as `false`, which
/// can only withhold a penalty). A host reading with **no charger flag** is kept
/// unknown as well: defaulting it to `false` — as the bridge used to — turned a
/// partial host observation into a fabricated `care.battery.low` /
/// `care.battery.critical` finding at a low state of charge.
fn reading_from_host(h: &crate::host_battery::HostBattery) -> BatteryReading {
    BatteryReading {
        level_pct: h.level_pct,
        charging: h.charging,
        thermal_throttled: None,
    }
}

/// The host-filesystem scanner behind [`CareScanner`] (root-confined).
struct HostFsScan {
    root: PathBuf,
}

impl CareScanner for HostFsScan {
    fn name(&self) -> &'static str {
        BACKEND_HOST_FS
    }

    fn scan(&mut self) -> Result<HostScan, DevCareError> {
        hostfs::HostFsScanner::new(self.root.clone()).scan()
    }
}

/// Whether device care can do anything here, and with which backend.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct DevCareStatus {
    /// True when a scan backend is attached (`false` ⇒ the UI must show unknown).
    pub available: bool,
    /// `"host-fs"` or `"none"`.
    pub backend: String,
    /// The confined root, when the host-fs backend is active.
    pub root: Option<String>,
    /// Whether a clean plan can actually be executed.
    pub can_clean: bool,
    pub scanned_items: u64,
    /// Directories the last scan could not read (non-zero ⇒ the scan was partial).
    pub unreadable_dirs: u64,
    /// The last backend error, if any (never a fabricated success).
    pub last_error: Option<String>,
}

/// The scan snapshot plus a summary the WebView can render.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ScanOut {
    pub status: DevCareStatus,
    pub report: JunkReport,
    /// Category keys a one-tap clean may select on its own.
    pub auto_kinds: Vec<String>,
    /// Category keys that require an explicit acknowledgement.
    pub review_kinds: Vec<String>,
}

/// The storage overview:「总 / 已用 / 可回收」plus the per-category breakdown.
///
/// `measured: false` means the backend could not read the device filesystem, so
/// the byte totals are `None` and the UI **must** render "—" rather than `0 B`.
/// The category rows always come from the bridge's own scan snapshot, so they are
/// observed even when the filesystem totals are not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StorageOut {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    /// 0–100, `None` unless both `total_bytes` and `used_bytes` are known.
    pub used_pct: Option<u32>,
    /// Whether the filesystem totals were actually read.
    pub measured: bool,
    pub backend: String,
    /// Reclaimable bytes by category (the same groups the scan report shows).
    pub groups: Vec<JunkGroup>,
    /// Bytes cleanable without a second confirmation.
    pub reclaimable_bytes: u64,
    /// Bytes that need an explicit user decision first.
    pub review_bytes: u64,
}

/// One item that could not be removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CleanFailureOut {
    pub uri: String,
    pub kind: String,
    pub message: String,
}

/// The honest result of a clean run.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CleanOut {
    pub planned_items: usize,
    pub planned_bytes: u64,
    /// Bytes actually freed — confirmed removals only.
    pub freed_bytes: u64,
    pub removed: usize,
    pub failed: usize,
    /// True when at least one planned item could not be removed.
    pub partial: bool,
    pub failures: Vec<CleanFailureOut>,
}

/// Whether an action reached the daemon's **unified audit trail**.
///
/// Auditing is best-effort (a clean that already happened cannot be un-happened)
/// but it is **never silent**: the caller always gets `recorded`/`attempted` and,
/// when they differ, a reason.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct AuditStatus {
    /// Records the daemon confirmed **persisted**.
    pub recorded: u64,
    /// Records the bridge asked the daemon to persist.
    pub attempted: u64,
    /// Why not everything was recorded (`None` when all were).
    pub reason: Option<String>,
}

/// What `devcare_clean` returns: the honest clean result, flattened, plus whether
/// the action reached the unified audit trail.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CleanReply {
    #[serde(flatten)]
    pub clean: CleanOut,
    pub audit: AuditStatus,
}

/// One entry of the device-care audit trail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TrailEntryOut {
    pub ts: u64,
    pub op: String,
    pub resource: String,
    pub outcome: String,
    pub details: String,
}

/// The device-care slice of the daemon's unified durable audit trail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TrailOut {
    pub records: Vec<TrailEntryOut>,
    /// False when the daemon has **no durable sink**: the trail cannot exist, so
    /// an empty `records` must NOT be read as "nothing ever happened".
    pub durable: bool,
}

/// The outcome of an uninstall attempt driven through the device-care policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UninstallOut {
    pub id: String,
    /// True only when the app was actually removed.
    pub removed: bool,
    /// True when a removal **request** was handed to the platform (Android
    /// `ACTION_DELETE`) but the platform confirms it asynchronously — the app is
    /// not known to be gone yet, so `removed` stays `false` and the UI must say
    /// "waiting for confirmation" instead of claiming success.
    pub launched: bool,
    /// `allowed` | `system_app` | `protected` | `unknown`.
    pub verdict: String,
    /// i18n key for the refusal reason (`None` when removed).
    pub reason_key: Option<String>,
    /// Non-localized diagnostic (refused / not installed / backend error).
    pub message: String,
    /// Whether the attempt reached the unified audit trail.
    pub audit: AuditStatus,
}

/// One reclaimable app in the memory view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MemoryAppOut {
    pub id: String,
    /// The governor lifecycle key (`cached` | `background`).
    pub state: String,
}

/// The memory snapshot a「内存加速」card needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MemoryOut {
    /// Total physical memory (`None` = the sampler could not read it).
    pub total_bytes: Option<u64>,
    /// Available memory (`None` = unknown — never a fake `0`).
    pub available_bytes: Option<u64>,
    /// Apps in the **reclaimable** tiers, cached first (domain policy).
    pub reclaimable: Vec<MemoryAppOut>,
    /// The current energy decision's sensor mode, when the governor reported one.
    pub mode: Option<String>,
    /// True when the governor answered (it owns every lifecycle transition).
    /// `false` means `reclaimable` is empty because we could not **ask** — not
    /// because there is nothing to reclaim.
    pub governor: bool,
}

/// One app a boost could not reclaim.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BoostFailureOut {
    pub id: String,
    pub message: String,
}

/// What a memory boost asked for, and the readings around it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BoostOut {
    /// Ids the manager asked the governor to reclaim (cached first).
    pub requested: Vec<String>,
    /// How many the governor accepted.
    pub reclaimed: u64,
    /// Every per-app failure, so a partial boost is never reported as complete.
    pub failures: Vec<BoostFailureOut>,
    /// Available memory reading before / after. The caller compares them; we
    /// never claim this action *caused* the delta (other things move memory).
    pub available_before: Option<u64>,
    pub available_after: Option<u64>,
    /// False when the governor was unreachable ⇒ nothing was requested.
    pub governor: bool,
    /// Whether the boost reached the daemon's unified audit trail. Forcing apps
    /// to stop is a consequential action, so it is audited like clean/uninstall;
    /// the zero status (nothing attempted) only occurs when no boost happened.
    pub audit: AuditStatus,
}

/// A package plus the device-care verdict on whether it may be uninstalled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AppOut {
    pub id: String,
    pub name: String,
    pub system: bool,
    /// Declared package size (`None` = unknown — the UI must not print `0 B`).
    pub size_bytes: Option<u64>,
    /// `allowed` | `system_app` | `protected`.
    pub verdict: String,
    /// i18n key for the refusal reason (`None` when allowed).
    pub reason_key: Option<String>,
}

/// One app and the sensitive resources it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PermRowOut {
    pub app_id: String,
    pub resources: Vec<String>,
}

/// The authority a permission review was read from.
pub const AUTHORITY_DAEMON: &str = "daemon";
/// No authority was reachable — `rows` is empty and must NOT be rendered as
/// "nothing is granted".
pub const AUTHORITY_UNAVAILABLE: &str = "unavailable";

/// The permission review the manager renders.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PermReviewOut {
    /// Sorted by app id; each resource list sorted (domain semantics).
    pub rows: Vec<PermRowOut>,
    /// `"daemon"` when the rows came from the authoritative manager, else
    /// `"unavailable"` — which is **not** the same as "no grants".
    pub authority: String,
}

struct Inner {
    scan: Vec<JunkItem>,
    unreadable_dirs: usize,
    root: Option<PathBuf>,
    /// The scan/storage half of the backend (`None` ⇒ nothing was ever observed).
    scanner: Option<Box<dyn CareScanner + Send>>,
    provider: Option<Box<dyn CleanProvider + Send>>,
    /// The bridge-owned package inventory + removal, when the backend owns one.
    /// `None` ⇒ the caller falls back to the store registry.
    packages: Option<Arc<dyn PackageSource>>,
    last_error: Option<String>,
}

/// Managed device-care bridge state.
pub struct DevCareBridge {
    inner: Mutex<Inner>,
}

impl Default for DevCareBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl DevCareBridge {
    /// Boot from the environment: a real host-fs backend when
    /// `AMOS_DEVCARE_ROOT` is set, otherwise an honest "no backend" state.
    pub fn new() -> Self {
        match std::env::var(ROOT_ENV).ok().filter(|s| !s.is_empty()) {
            Some(root) => Self::with_host_root(PathBuf::from(root)),
            None => Self::unavailable(),
        }
    }

    /// A bridge with **no** backend: nothing to scan, nothing to clean. The UI
    /// must render this as unknown rather than as a healthy, empty device.
    pub fn unavailable() -> Self {
        Self {
            inner: Mutex::new(Inner {
                scan: Vec::new(),
                unreadable_dirs: 0,
                root: None,
                scanner: None,
                provider: None,
                packages: None,
                last_error: None,
            }),
        }
    }

    /// A bridge backed by the root-confined filesystem backend.
    pub fn with_host_root(root: PathBuf) -> Self {
        let provider: Box<dyn CleanProvider + Send> =
            Box::new(hostfs::HostFsCleanProvider::new(root.clone()));
        let scanner: Box<dyn CareScanner + Send> = Box::new(HostFsScan { root: root.clone() });
        let mut inner = Inner {
            scan: Vec::new(),
            unreadable_dirs: 0,
            root: Some(root),
            scanner: Some(scanner),
            provider: Some(provider),
            packages: None,
            last_error: None,
        };
        if let Some(scanner) = inner.scanner.as_mut() {
            match scanner.scan() {
                Ok(scan) => {
                    inner.scan = scan.items;
                    inner.unreadable_dirs = scan.unreadable_dirs;
                }
                Err(e) => inner.last_error = Some(e.to_string()),
            }
        }
        Self {
            inner: Mutex::new(inner),
        }
    }

    /// Install a **device** backend (the Android `DevCareGlue`), replacing whatever
    /// this bridge booted with.
    ///
    /// Called from the Kotlin glue's JNI upcall once the app `Context` exists, so
    /// it must be idempotent and cheap to repeat: a re-attach simply re-scans with
    /// the new backend rather than stacking backends.
    pub fn attach_device(
        &self,
        scanner: Box<dyn CareScanner + Send>,
        provider: Box<dyn CleanProvider + Send>,
        packages: Arc<dyn PackageSource>,
    ) {
        let mut inner = self.lock();
        inner.scanner = Some(scanner);
        inner.provider = Some(provider);
        inner.packages = Some(packages);
        // The device backend has no confined root: it addresses `content://` /
        // app-private URIs, so the host-fs `root` label must not linger.
        inner.root = None;
        inner.last_error = None;
        // **No scan here.** This upcall arrives on the Activity's main thread
        // (`onStart` → `DevCareGlue.bind`), and a MediaStore/filesystem sweep
        // there would stall the UI — which is exactly what the device seam
        // documents ("the attach does not scan", `docs/devcare.md` §bring-up).
        // The scan runs from the `devcare_scan` command, off the UI thread.
        //
        // Drop any snapshot the *previous* backend produced: it was never
        // observed by this one, so reporting it would be a lie. An un-scanned
        // backend has `scanned_items == 0` until the caller actually scans.
        inner.scan.clear();
        inner.unreadable_dirs = 0;
    }

    /// The backend-owned package source, when the attached backend has one.
    ///
    /// The commands fall back to the store registry when this is `None`, so a
    /// host build keeps working unchanged.
    pub fn packages(&self) -> Option<Arc<dyn PackageSource>> {
        self.lock().packages.clone()
    }

    /// A locked view of the inner state. A poisoned lock is recovered rather than
    /// panicked on: one failed thread must not take the whole UI down.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The current availability/backend summary.
    pub fn status(&self) -> DevCareStatus {
        Self::status_of(&self.lock())
    }

    /// Like [`DevCareBridge::status`], but **never blocks**: `None` when another
    /// thread currently holds the bridge.
    ///
    /// Used by the on-device bring-up diagnostic, which must not be able to stall
    /// its caller — and for which "the lock is busy" is itself the interesting
    /// observation. (It also documents that no command holds the lock for long:
    /// a JNI call made *under* the bridge lock would show up here as contention.)
    pub fn try_status(&self) -> Option<DevCareStatus> {
        let inner = self.inner.try_lock().ok()?;
        Some(Self::status_of(&inner))
    }

    /// The read-only summary of an already-locked state.
    fn status_of(inner: &Inner) -> DevCareStatus {
        let backend = inner
            .scanner
            .as_ref()
            .map(|s| s.name().to_string())
            .unwrap_or_else(|| BACKEND_NONE.to_string());
        let available = inner.scanner.is_some();
        DevCareStatus {
            available,
            backend,
            root: inner
                .root
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            can_clean: inner.provider.is_some(),
            scanned_items: inner.scan.len() as u64,
            unreadable_dirs: inner.unreadable_dirs as u64,
            last_error: inner.last_error.clone(),
        }
    }

    /// Re-scan the configured backend and return the fresh summary.
    ///
    /// With no backend this is an honest error, not an empty success.
    pub fn scan(&self) -> Result<ScanOut, String> {
        let mut inner = self.lock();
        let scanned = {
            let Some(scanner) = inner.scanner.as_mut() else {
                return Err("no device-care backend is attached".to_string());
            };
            scanner.scan()
        };
        match scanned {
            Ok(scan) => {
                inner.scan = scan.items;
                inner.unreadable_dirs = scan.unreadable_dirs;
                inner.last_error = None;
            }
            Err(e) => {
                // Keep the previous snapshot; surface the failure honestly.
                inner.last_error = Some(e.to_string());
                return Err(e.to_string());
            }
        }
        let report = junk::analyze(&inner.scan).map_err(|e| e.to_string())?;
        let auto_kinds = junk::auto_cleanable_kinds(&report)
            .into_iter()
            .map(|k| k.key().to_string())
            .collect();
        let review_kinds = report
            .groups
            .iter()
            .filter(|g| g.kind.needs_review())
            .map(|g| g.kind.key().to_string())
            .collect();
        drop(inner);

        Ok(ScanOut {
            status: self.status(),
            report,
            auto_kinds,
            review_kinds,
        })
    }

    /// Plan and execute a clean for the named categories, **against the bridge's
    /// own snapshot**, returning the honest result plus the audit events to
    /// record.
    ///
    /// The caller cannot pass a path: it passes category tags (plus the review
    /// acknowledgement), and an unknown tag is refused rather than ignored.
    ///
    /// The events are returned rather than recorded here so this method stays
    /// synchronous and unit-testable; the `devcare_clean` command performs the
    /// async round-trip to the daemon's unified audit sink.
    pub fn clean(
        &self,
        kinds: &[String],
        acknowledge_review: bool,
    ) -> Result<(CleanOut, Vec<audit::CareAuditEvent>), String> {
        let mut inner = self.lock();
        if inner.provider.is_none() {
            return Err("no device-care backend is attached".to_string());
        }

        let mut selected = Vec::with_capacity(kinds.len());
        for tag in kinds {
            match JunkKind::from_key(tag) {
                Some(k) => selected.push(k),
                None => return Err(format!("unknown junk category '{tag}'")),
            }
        }
        // `selected` also becomes the audited category list, so keep a copy
        // before the request consumes it.
        let requested = selected.clone();

        let request = CleanRequest {
            kinds: selected,
            acknowledge_review,
        };
        let clean_plan = junk::plan(&inner.scan, &request).map_err(|e| e.to_string())?;

        let outcome = {
            let Some(provider) = inner.provider.as_mut() else {
                return Err("no device-care backend is attached".to_string());
            };
            junk::execute(&clean_plan, provider.as_mut())
        };

        // The plan is now consumed: re-scan so the next status/scan reflects
        // reality instead of the pre-clean snapshot.
        if let Some(scanner) = inner.scanner.as_mut() {
            if let Ok(scan) = scanner.scan() {
                inner.scan = scan.items;
                inner.unreadable_dirs = scan.unreadable_dirs;
            }
        }
        drop(inner);

        let clean_out = CleanOut {
            planned_items: clean_plan.len(),
            planned_bytes: clean_plan.total_bytes,
            freed_bytes: outcome.freed_bytes,
            removed: outcome.removed_count(),
            failed: outcome.failed_count(),
            partial: outcome.is_partial(),
            failures: outcome
                .failures
                .iter()
                .map(|f| CleanFailureOut {
                    uri: f.uri.clone(),
                    kind: f.kind.key().to_string(),
                    message: f.message.clone(),
                })
                .collect(),
        };
        let events = audit::clean_events(audit::ACTOR, &requested, &outcome);
        Ok((clean_out, events))
    }

    /// The storage overview: device totals (when the backend can measure them)
    /// plus the reclaimable breakdown from this bridge's **own** snapshot.
    ///
    /// `measured: false` when the backend cannot read the filesystem; the totals
    /// are then `None`, never a fabricated zero (P0-3).
    pub fn storage(&self) -> Result<StorageOut, String> {
        let mut inner = self.lock();
        let totals = match inner.scanner.as_mut() {
            Some(scanner) => scanner.storage(),
            None => StorageTotals::default(),
        };
        let backend = inner
            .scanner
            .as_ref()
            .map(|s| s.name().to_string())
            .unwrap_or_else(|| BACKEND_NONE.to_string());
        // The category rows always come from the scan snapshot, so they exist
        // even when the filesystem totals do not.
        let report = junk::analyze(&inner.scan).map_err(|e| e.to_string())?;
        drop(inner);

        let measured = totals.total_bytes.is_some();
        let used_pct = match (totals.total_bytes, totals.used_bytes) {
            (Some(total), Some(used)) if total > 0 => {
                // Compute in u128 so a large `total` cannot overflow.
                let pct = (u128::from(used) * 100 / u128::from(total)).min(100);
                Some(pct as u32)
            }
            _ => None,
        };

        Ok(StorageOut {
            total_bytes: totals.total_bytes,
            used_bytes: totals.used_bytes,
            free_bytes: totals.free_bytes,
            used_pct,
            measured,
            backend,
            reclaimable_bytes: report.reclaimable_bytes(),
            review_bytes: report.review_bytes(),
            groups: report.groups,
        })
    }

    /// Build a care report from what this process can actually observe.
    ///
    /// Storage comes from the bridge's own scan; battery from the **attached
    /// backend's** reading (Android `BatteryManager`), falling back to the real host
    /// battery reader on a desktop; the two counts come from the caller (permission
    /// ledger / package inventory). Anything unavailable stays `None` and is
    /// therefore **unassessed** rather than scored as healthy.
    pub fn report(
        &self,
        sensitive_grants: Option<usize>,
        reviewable_apps: Option<usize>,
    ) -> CareReport {
        let (reclaimable, device_battery) = {
            let mut inner = self.lock();
            // No backend ⇒ *nothing* was observed. Leaving this `None` is what
            // keeps an unobserved device unassessed instead of scoring its
            // storage as a healthy zero (P0-3).
            let reclaimable = if inner.provider.is_none() {
                None
            } else {
                junk::analyze(&inner.scan)
                    .ok()
                    .map(|r| r.reclaimable_bytes())
            };
            // The device reading is an observation the backend owns; the call
            // crosses JNI, which is why `devcare_report` runs off the UI thread.
            let device_battery = inner
                .scanner
                .as_mut()
                .map(|s| s.battery())
                .unwrap_or_else(BatteryReading::unknown);
            (reclaimable, device_battery)
        };
        // Device first (`BatteryManager`), then the real host reader (desktop). A
        // backend that answered with **anything** is authoritative for the battery:
        // topping a partial device reply up with a host reading would mix two
        // sources, so only an *all-unknown* backend reply falls back (a desktop
        // host-fs backend has no battery reader at all). A reading that cannot fill
        // the coupled `BatteryCare` leaves the area unassessed — never a fabricated
        // level (see `BatteryReading::care`).
        let battery = if device_battery == BatteryReading::unknown() {
            crate::host_battery::read_host_battery()
                .map(|h| reading_from_host(&h))
                .and_then(BatteryReading::care)
        } else {
            device_battery.care()
        };

        health::assess(&CareInput {
            storage_reclaimable_bytes: reclaimable,
            battery,
            sensitive_grants,
            reviewable_apps,
        })
    }
}

/// Shape the memory view from a sampler reading + a governor snapshot.
///
/// Pure, so the mapping is testable without a daemon. The reclaimable list and
/// its order come from [`amos_devocare::reclaim_plan`] — the domain decides what
/// may be touched (cached first, protected tiers never); this only joins the ids
/// back to their lifecycle keys for display.
pub fn memory_view(
    total_bytes: Option<u64>,
    available_bytes: Option<u64>,
    apps: &[crate::taskmgr::TaskApp],
    mode: Option<String>,
    governor: bool,
) -> MemoryOut {
    let mut states = std::collections::HashMap::new();
    for a in apps {
        states.insert(a.id.as_str(), a.state.as_str());
    }
    let pairs: Vec<(String, String)> = apps
        .iter()
        .map(|a| (a.id.clone(), a.state.clone()))
        .collect();
    let reclaimable = amos_devocare::reclaim_plan(&pairs)
        .into_iter()
        .map(|id| MemoryAppOut {
            state: states
                .get(id.as_str())
                .copied()
                .unwrap_or_default()
                .to_string(),
            id,
        })
        .collect();

    MemoryOut {
        total_bytes,
        available_bytes,
        reclaimable,
        mode,
        governor,
    }
}

/// The memory view for the manager's「内存加速」card.
///
/// Memory figures come from the system sampler; the reclaim target list from the
/// resource governor (the lifecycle authority). Either may be missing — both are
/// then reported as unknown / `governor:false`, never as a fake zero.
#[tauri::command]
pub async fn devcare_memory() -> Result<MemoryOut, String> {
    let health = crate::system::system_health().await.ok();
    let (total, available) = health
        .as_ref()
        .map(|h| (h.mem_total_bytes, h.mem_available_bytes))
        .unwrap_or((None, None));

    match crate::taskmgr::taskmgr_snapshot().await {
        Ok(snap) => Ok(memory_view(
            total,
            available,
            &snap.apps,
            snap.decision.map(|d| d.mode),
            true,
        )),
        Err(e) => {
            tracing::warn!("device-care memory view: governor unavailable: {e}");
            Ok(memory_view(total, available, &[], None, false))
        }
    }
}

/// Reclaim the governor's cached/background apps — the phone-manager「内存加速」.
///
/// The *policy* is the domain's ([`amos_devocare::reclaim_plan`]: cached first,
/// protected tiers never) and the *authority* is the governor, which owns every
/// lifecycle transition. Each app is reclaimed individually so a partial boost is
/// reported honestly instead of being hidden behind one aggregate result — and
/// **every** requested app gets exactly one attempt, so the trail's aggregate
/// (`requested=N attempted=N`) always accounts for the whole plan. The events go
/// to the daemon's unified audit trail (§3.6 of docs/devcare.md); when the
/// governor was unreachable, no boost happened and no events exist.
#[tauri::command]
pub async fn devcare_boost() -> Result<BoostOut, String> {
    let available_before = crate::system::system_health()
        .await
        .ok()
        .and_then(|h| h.mem_available_bytes);

    let snapshot = match crate::taskmgr::taskmgr_snapshot().await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("device-care boost: governor unavailable: {e}");
            // No boost happened ⇒ nothing to audit; the zero status says
            // "not attempted" rather than pretending a trail exists.
            return Ok(BoostOut {
                requested: Vec::new(),
                reclaimed: 0,
                failures: Vec::new(),
                available_before,
                available_after: available_before,
                governor: false,
                audit: AuditStatus::default(),
            });
        }
    };

    let pairs: Vec<(String, String)> = snapshot
        .apps
        .iter()
        .map(|a| (a.id.clone(), a.state.clone()))
        .collect();
    let requested = amos_devocare::reclaim_plan(&pairs);

    let mut reclaimed = 0u64;
    let mut failures = Vec::new();
    let mut attempts: Vec<audit::BoostReclaim> = Vec::with_capacity(requested.len());
    for id in &requested {
        match crate::taskmgr::taskmgr_app_action(id.clone(), "kill".to_string()).await {
            Ok(_) => {
                reclaimed += 1;
                attempts.push(audit::BoostReclaim {
                    id: id.clone(),
                    ok: true,
                    message: String::new(),
                });
            }
            Err(e) => {
                failures.push(BoostFailureOut {
                    id: id.clone(),
                    message: e.clone(),
                });
                attempts.push(audit::BoostReclaim {
                    id: id.clone(),
                    ok: false,
                    message: e,
                });
            }
        }
    }

    let available_after = crate::system::system_health()
        .await
        .ok()
        .and_then(|h| h.mem_available_bytes);

    // A forced stop is a consequential action: aggregate + one record per
    // failed reclaim go to the same unified trail as clean/uninstall.
    let events = audit::boost_events(audit::ACTOR, &requested, &attempts);
    let audit_status = record_audit(&events).await;

    Ok(BoostOut {
        requested,
        reclaimed,
        failures,
        available_before,
        available_after,
        governor: true,
        audit: audit_status,
    })
}

/// Persist device-care audit events to the daemon's **unified durable sink**.
///
/// Best-effort by design — an action that already happened cannot be
/// un-happened — but the outcome is always reported ([`AuditStatus`]), so the UI
/// can say "not audited" instead of implying a trail it does not have.
pub async fn record_audit(events: &[audit::CareAuditEvent]) -> AuditStatus {
    let attempted = events.len() as u64;
    if events.is_empty() {
        return AuditStatus::default();
    }
    let wire: Vec<crate::privacy_client::PermissionAudit> = events
        .iter()
        .map(|e| crate::privacy_client::PermissionAudit {
            // The daemon stamps the authoritative time; this is a placeholder.
            ts: 0,
            principal: e.principal.clone(),
            op: e.op.clone(),
            resource: e.resource.clone(),
            outcome: e.outcome.clone(),
            details: e.details.clone(),
        })
        .collect();

    match crate::privacy_client::perm_record_audit(wire).await {
        Ok(ingest) => {
            let recorded = ingest.recorded as u64;
            let attempted = ingest.total as u64;
            AuditStatus {
                recorded,
                attempted,
                reason: ingest.error.or_else(|| {
                    (recorded < attempted).then(|| {
                        "daemon has no durable audit sink (start it with AMOS_PRIVACY_PATH)"
                            .to_string()
                    })
                }),
            }
        }
        Err(e) => AuditStatus {
            recorded: 0,
            attempted,
            reason: Some(e),
        },
    }
}

/// The policy input for one inventory entry.
///
/// **Single construction point**: the preview ([`policy_preview`]) and the
/// enforcement ([`uninstall_with_policy`]) both go through here, so they cannot
/// disagree about what is removable. On the host the store registry only holds
/// user-installed apps, so `system` is `false`; a device build fills it from
/// `PackageManager`.
fn policy_package(entry: &InstalledEntry) -> AppPackage {
    AppPackage::new(entry.id.clone(), entry.name.clone())
        .system(entry.system)
        .with_size(entry.size_bytes.unwrap_or(0))
}

/// The policy verdict for one inventory entry.
fn verdict_out(entry: &InstalledEntry, guard: &UninstallGuard) -> AppOut {
    let verdict = guard.verdict(&policy_package(entry));
    AppOut {
        id: entry.id.clone(),
        name: entry.name.clone(),
        system: entry.system,
        size_bytes: entry.size_bytes,
        verdict: verdict.key().to_string(),
        reason_key: verdict.reason_key().map(str::to_string),
    }
}

/// The **bridge-owned** uninstall preview: what the manager may offer to remove.
///
/// The WebView supplies nothing, so a UI cannot influence the policy — and this
/// list is exactly what [`uninstall_with_policy`] will enforce. The inventory
/// comes from whichever [`PackageSource`] the bridge owns, so the preview and the
/// enforcement can never disagree about a package's verdict.
pub fn policy_preview(packages: &dyn PackageSource) -> Result<Vec<AppOut>, String> {
    let guard = UninstallGuard::new();
    Ok(packages
        .inventory()?
        .iter()
        .map(|e| verdict_out(e, &guard))
        .collect())
}

/// Turn the **daemon's** grant rows into review rows, keeping the *review
/// semantics* in the domain (dedup, ordering, bounded).
///
/// Data comes from the authority; the shape comes from
/// [`amos_devocare::permissions::review_grants`]. A resource key the domain does
/// not model is skipped (the daemon validates its own keys, so this is defence
/// in depth, not a guess).
pub fn permission_review_from(rows: &[crate::privacy_client::GrantRow]) -> Vec<PermRowOut> {
    let mut parsed = Vec::new();
    for row in rows {
        for key in &row.resources {
            if let Some(resource) = SensitiveResource::from_key(key) {
                parsed.push(PermissionGrant {
                    app_id: row.app_id.clone(),
                    resource,
                    granted: true,
                });
            }
        }
    }
    permissions::review_grants(&parsed)
        .into_iter()
        .map(|row| PermRowOut {
            app_id: row.app_id,
            resources: row.resources.iter().map(|r| r.key().to_string()).collect(),
        })
        .collect()
}

/// Apply the uninstall policy and perform the removal.
///
/// Returns the outcome plus the audit event to record; the caller adds the async
/// audit round-trip. Kept free of Tauri types (and of `await`) so it is
/// unit-testable.
///
/// **Policy first, twice**: a pinned critical package is refused on its *identity*
/// (so it is refused even when it is not in the inventory), and then on the full
/// inventory entry (so a platform/system package is refused too). Either refusal
/// is itself an auditable event.
pub fn uninstall_with_policy(
    packages: &dyn PackageSource,
    id: &str,
) -> Result<(UninstallOut, audit::CareAuditEvent), String> {
    let guard = UninstallGuard::new();

    let refused = |verdict_key: &str,
                   reason_key: Option<&'static str>,
                   message: &str,
                   event: audit::CareAuditEvent| {
        (
            UninstallOut {
                id: id.to_string(),
                removed: false,
                launched: false,
                verdict: verdict_key.to_string(),
                reason_key: reason_key.map(str::to_string),
                message: message.to_string(),
                audit: AuditStatus::default(),
            },
            event,
        )
    };

    // 1. Identity-only check: a pinned package is refused even when absent.
    let identity = AppPackage::new(id.to_string(), String::new());
    let identity_verdict = guard.verdict(&identity);
    if !identity_verdict.is_allowed() {
        return Ok(refused(
            identity_verdict.key(),
            identity_verdict.reason_key(),
            identity_verdict.key(),
            audit::uninstall_refused(audit::ACTOR, id, identity_verdict),
        ));
    }

    // 2. The inventory is bridge-owned; take the entry the preview used so the
    //    verdict here is the verdict the user was shown.
    let Some(entry) = packages.inventory()?.into_iter().find(|e| e.id == id) else {
        return Ok(refused(
            "unknown",
            None,
            "not installed",
            audit::uninstall_performed(audit::ACTOR, id, false, "not installed"),
        ));
    };

    let verdict = guard.verdict(&policy_package(&entry));
    if !verdict.is_allowed() {
        return Ok(refused(
            verdict.key(),
            verdict.reason_key(),
            verdict.key(),
            audit::uninstall_refused(audit::ACTOR, id, verdict),
        ));
    }

    match packages.uninstall(id) {
        Ok(removal) => {
            let (removed, launched, message) = match removal {
                Removal::Removed => (true, false, "removed"),
                // Honest: the platform took the request; it has not confirmed.
                Removal::Launched => (false, true, "uninstall intent launched"),
            };
            Ok((
                UninstallOut {
                    id: id.to_string(),
                    removed,
                    launched,
                    verdict: verdict.key().to_string(),
                    reason_key: None,
                    message: message.to_string(),
                    audit: AuditStatus::default(),
                },
                audit::uninstall_performed(audit::ACTOR, id, true, message),
            ))
        }
        Err(e) => Ok(refused(
            verdict.key(),
            None,
            &e,
            audit::uninstall_performed(audit::ACTOR, id, false, &e),
        )),
    }
}

/* ------------------------------- commands ------------------------------- */

/// Run a blocking device-care closure **off the UI thread**.
///
/// On a device these calls cross JNI into `PackageManager`, `StatFs` or
/// MediaStore; a synchronous Tauri command would run them on the main thread and
/// a slow provider would freeze the UI (same rationale as the SMS bridge). The
/// caller is released with an honest error if the worker cannot be joined.
async fn offload<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("device-care worker failed: {e}"))?
}

#[tauri::command]
pub fn devcare_status(bridge: State<'_, DevCareBridge>) -> DevCareStatus {
    bridge.status()
}

#[tauri::command]
pub async fn devcare_scan(app: AppHandle) -> Result<ScanOut, String> {
    offload(move || app.state::<DevCareBridge>().scan()).await
}

#[tauri::command]
pub async fn devcare_clean(
    app: AppHandle,
    kinds: Vec<String>,
    acknowledge_review: bool,
) -> Result<CleanReply, String> {
    // The scan/clean is blocking (and lock-scoped); only the audit round-trip to
    // the daemon is async.
    let (clean, events) = offload(move || {
        app.state::<DevCareBridge>()
            .clean(&kinds, acknowledge_review)
    })
    .await?;
    let audit = record_audit(&events).await;
    Ok(CleanReply { clean, audit })
}

/// The uninstall policy preview for the **bridge-owned** inventory.
///
/// Takes no inventory from the caller: the WebView cannot influence the policy,
/// and this list is exactly what `devcare_uninstall` enforces. On a device the
/// inventory is the real `PackageManager` one; on the host it is the store
/// registry.
#[tauri::command]
pub async fn devcare_apps(app: AppHandle) -> Result<Vec<AppOut>, String> {
    offload(move || {
        let bridge = app.state::<DevCareBridge>();
        match bridge.packages() {
            Some(packages) => policy_preview(packages.as_ref()),
            None => policy_preview(&*app.state::<StoreBridge>()),
        }
    })
    .await
}

/// Uninstall an app through the **device-care policy** (guard first) and audit
/// the attempt (including a refusal) to the daemon's unified trail.
///
/// The WebView is expected to call this rather than `appstore_uninstall`, so the
/// policy cannot be bypassed by a UI (or a bug) and every removal is auditable.
#[tauri::command]
pub async fn devcare_uninstall(app: AppHandle, id: String) -> Result<UninstallOut, String> {
    let (mut out, event) = offload(move || {
        let bridge = app.state::<DevCareBridge>();
        match bridge.packages() {
            Some(packages) => uninstall_with_policy(packages.as_ref(), &id),
            None => uninstall_with_policy(&*app.state::<StoreBridge>(), &id),
        }
    })
    .await?;
    out.audit = record_audit(&[event]).await;
    Ok(out)
}

/// The storage overview:「总 / 已用 / 可回收」+ the per-category breakdown.
///
/// The filesystem totals come from the attached backend (the Android `StatFs`
/// reader); when no backend can measure them the totals are `None` and
/// `measured` is `false`, so the UI shows "—" instead of a fabricated `0 B`.
/// The category rows come from the bridge's **own** scan snapshot.
#[tauri::command]
pub async fn devcare_storage(app: AppHandle) -> Result<StorageOut, String> {
    offload(move || app.state::<DevCareBridge>().storage()).await
}

/// The **read side** of the audit loop: what device care has actually done.
///
/// Filtered by the device-care principal **in Rust** ([`audit::ACTOR`]), so the
/// actor id is single-sourced here instead of duplicated in the UI. `Err` means
/// the daemon is unreachable; `durable: false` means it has no durable sink, in
/// which case an empty list is "no trail", not "no activity".
#[tauri::command]
pub async fn devcare_trail(limit: u32) -> Result<TrailOut, String> {
    let trail =
        crate::privacy_client::perm_recent_trail(Some(audit::ACTOR.to_string()), None, limit)
            .await?;
    Ok(TrailOut {
        records: trail
            .records
            .into_iter()
            .map(|r| TrailEntryOut {
                ts: r.ts,
                op: r.op,
                resource: r.resource,
                outcome: r.outcome,
                details: r.details,
            })
            .collect(),
        durable: trail.durable,
    })
}

/// The **daemon-authoritative** permission review.
///
/// The rows come from `PrivacyManager` (via `perm_grants_all`), not from a
/// frontend-local cache: the daemon is the authority for grants, and
/// deny-by-default means its answer is the truth. When the daemon cannot be
/// reached we return `authority: "unavailable"` with no rows — the UI must say
/// so rather than rendering "nothing is granted".
#[tauri::command]
pub async fn devcare_permissions() -> Result<PermReviewOut, String> {
    match crate::privacy_client::perm_grants_all().await {
        Ok(rows) => Ok(PermReviewOut {
            rows: permission_review_from(&rows),
            authority: AUTHORITY_DAEMON.to_string(),
        }),
        Err(e) => {
            // Keep the reason diagnosable; the UI shows the honest state.
            tracing::warn!("device-care permission review unavailable: {e}");
            Ok(PermReviewOut {
                rows: Vec::new(),
                authority: AUTHORITY_UNAVAILABLE.to_string(),
            })
        }
    }
}

/// The folded care report (score / grade / findings) for the manager.
///
/// Off the UI thread: the attached backend's battery read crosses JNI into
/// `BatteryManager` (and the desktop fallback shells out to `pmset`), so a slow
/// platform call must never freeze the screen (same rule as `devcare_storage`).
#[tauri::command]
pub async fn devcare_report(
    app: AppHandle,
    sensitive_grants: Option<usize>,
    reviewable_apps: Option<usize>,
) -> Result<CareReport, String> {
    offload(move || {
        Ok(app
            .state::<DevCareBridge>()
            .report(sensitive_grants, reviewable_apps))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_devocare::CareArea;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "amos-devcare-bridge-{}-{}",
                std::process::id(),
                n
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp root");
            TempRoot(dir)
        }

        fn file(&self, rel: &str, bytes: usize) -> PathBuf {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
            fs::write(&p, vec![0u8; bytes]).expect("write");
            p
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seeded() -> (TempRoot, DevCareBridge) {
        let t = TempRoot::new();
        t.file("old.apk", 100);
        t.file("app.log", 50);
        t.file("cache/blob.bin", 25);
        t.file("DCIM/photo.jpg", 999);
        let bridge = DevCareBridge::with_host_root(t.0.clone());
        (t, bridge)
    }

    #[test]
    fn an_unavailable_bridge_reports_unknown_rather_than_healthy() {
        let b = DevCareBridge::unavailable();
        let s = b.status();
        assert!(!s.available);
        assert_eq!(s.backend, BACKEND_NONE);
        assert!(!s.can_clean);
        assert_eq!(s.scanned_items, 0);
        assert!(s.root.is_none());

        // No backend ⇒ honest errors, never an empty "success".
        assert!(b.scan().is_err());
        assert!(b.clean(&["app_cache".to_string()], false).is_err());

        // Nothing about storage was observed ⇒ storage must NOT be assessed
        // (battery may still be, because the host reader is a real observation).
        let r = b.report(None, None);
        assert!(
            !r.assessed_area(CareArea::Storage),
            "an unobserved storage area must not be graded"
        );
        assert!(r.findings.iter().all(|f| f.area != CareArea::Storage));
    }

    #[test]
    fn a_host_root_bridge_scans_cleans_and_reports_end_to_end() {
        let (t, b) = seeded();

        let s = b.status();
        assert!(s.available);
        assert_eq!(s.backend, BACKEND_HOST_FS);
        assert!(s.can_clean);
        assert_eq!(s.unreadable_dirs, 0);
        assert!(s.scanned_items >= 3, "got {}", s.scanned_items);

        let scan = b.scan().expect("scan ok");
        assert!(scan.auto_kinds.contains(&"app_cache".to_string()));
        assert!(scan.auto_kinds.contains(&"apk_installer".to_string()));
        assert!(scan.auto_kinds.contains(&"log_file".to_string()));
        assert!(
            scan.review_kinds.is_empty(),
            "the host scanner finds no review-only kinds"
        );
        assert_eq!(scan.report.reclaimable_bytes(), 175);

        let (out, events) = b.clean(&scan.auto_kinds, false).expect("clean ok");
        assert_eq!(out.planned_items, 3);
        assert_eq!(out.freed_bytes, 175);
        assert_eq!(out.removed, 3);
        assert_eq!(out.failed, 0);
        assert!(!out.partial);
        assert!(out.failures.is_empty());

        // The clean produced exactly one aggregate audit event describing it.
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].principal, amos_devocare::audit::ACTOR);
        assert_eq!(events[0].op, amos_devocare::audit::OP_CLEAN);
        assert_eq!(events[0].outcome, "success");
        assert_eq!(events[0].resource, "app_cache,apk_installer,log_file");
        assert_eq!(
            events[0].details,
            "planned=3 freed_bytes=175 removed=3 failed=0"
        );

        assert!(!t.0.join("old.apk").exists());
        assert!(!t.0.join("app.log").exists());
        assert!(t.0.join("DCIM/photo.jpg").exists(), "user media untouched");

        // The clean emptied `cache/`, so the post-clean rescan now sees it as a
        // leftover empty directory — junk of a second kind, and a second pass
        // removes it. (This is the rescan doing its job, not a stale snapshot.)
        assert_eq!(b.status().scanned_items, 1);
        let second = b.scan().expect("scan ok");
        assert!(second.auto_kinds.contains(&"empty_dir".to_string()));
        let (out2, _events2) = b.clean(&second.auto_kinds, false).expect("clean ok");
        assert_eq!(out2.removed, 1);
        assert_eq!(out2.freed_bytes, 0);
        assert_eq!(b.status().scanned_items, 0);
        assert!(t.0.join("DCIM/photo.jpg").exists());
    }

    #[test]
    fn clean_refuses_an_unknown_category_and_an_unacknowledged_review_kind() {
        let (_t, b) = seeded();
        let err = b
            .clean(&["not_a_category".to_string()], false)
            .expect_err("unknown tag refused");
        assert_eq!(err, "unknown junk category 'not_a_category'");

        // Review-only categories need an explicit acknowledgement.
        let err = b
            .clean(&["stale_download".to_string()], false)
            .expect_err("review kind needs ack");
        assert!(err.contains("acknowledgement"), "got {err}");
    }

    #[test]
    fn the_frontend_cannot_name_a_path_to_delete() {
        let (t, b) = seeded();
        let victim = t.0.join("DCIM/photo.jpg");
        // A path is not a category: the request is refused, and the file survives.
        let err = b
            .clean(&[victim.to_string_lossy().to_string()], false)
            .expect_err("a path is not a valid category");
        assert!(err.starts_with("unknown junk category"), "got {err}");
        assert!(victim.exists());
    }

    #[test]
    fn the_preview_verdicts_come_from_the_single_package_builder() {
        let guard = UninstallGuard::new();
        let allowed = verdict_out(
            &InstalledEntry {
                id: "com.example.game".to_string(),
                name: "Game".to_string(),
                size_bytes: Some(10),
                system: false,
            },
            &guard,
        );
        assert_eq!(allowed.verdict, "allowed");
        assert!(allowed.reason_key.is_none());
        assert_eq!(allowed.size_bytes, Some(10));

        let protected = verdict_out(
            &InstalledEntry {
                id: "com.android.settings".to_string(),
                name: "Settings".to_string(),
                size_bytes: None,
                system: true,
            },
            &guard,
        );
        assert_eq!(protected.verdict, "protected");
        assert_eq!(
            protected.reason_key.as_deref(),
            Some("care.uninstall.protected")
        );
        // An unknown declared size stays unknown end-to-end.
        assert_eq!(protected.size_bytes, None);
        assert!(
            protected.system,
            "the platform's own flag is carried through"
        );
    }

    #[test]
    fn a_platform_flagged_package_is_refused_as_a_system_app() {
        // On a device the `system` flag comes from `PackageManager`; a bundled
        // vendor app that is NOT in the pinned critical set must still be refused,
        // with the `system_app` reason (not `protected`).
        let guard = UninstallGuard::new();
        let entry = InstalledEntry {
            id: "com.vendor.weather".to_string(),
            name: "Weather".to_string(),
            size_bytes: Some(4096),
            system: true,
        };
        let out = verdict_out(&entry, &guard);
        assert_eq!(out.verdict, "system_app");
        assert_eq!(out.reason_key.as_deref(), Some("care.uninstall.systemApp"));
        assert!(out.system);
    }

    #[test]
    fn the_preview_and_the_enforcement_agree_for_every_package() {
        // The defect this pins: the preview used a caller-supplied `system` flag
        // while the enforcement always assumed `false`, so they could disagree.
        // Both now go through `policy_package`, so the verdict the user is shown
        // is the verdict that is enforced.
        let guard = UninstallGuard::new();
        for (id, expected) in [
            ("com.example.game", "allowed"),
            ("com.android.settings", "protected"),
            ("com.amos.devocare", "protected"),
        ] {
            let entry = InstalledEntry {
                id: id.to_string(),
                name: "X".to_string(),
                size_bytes: None,
                system: false,
            };
            let shown = verdict_out(&entry, &guard).verdict;
            assert_eq!(shown, expected, "preview verdict for {id}");

            let enforced = guard.verdict(&policy_package(&entry));
            assert_eq!(enforced.key(), shown, "enforcement agrees for {id}");
        }
    }

    #[test]
    fn policy_preview_of_an_empty_registry_is_empty() {
        let store = StoreBridge::ephemeral();
        assert!(policy_preview(&store)
            .expect("registry is readable")
            .is_empty());
    }

    #[test]
    fn an_unknown_package_size_serializes_as_null_not_zero() {
        let v = serde_json::to_value(AppOut {
            id: "a".to_string(),
            name: "A".to_string(),
            system: false,
            size_bytes: None,
            verdict: "allowed".to_string(),
            reason_key: None,
        })
        .expect("serialize");
        assert!(
            v["size_bytes"].is_null(),
            "an unknown size must be null, never a fabricated 0: {v}"
        );
    }

    #[test]
    fn the_clean_reply_wire_shape_is_flat() {
        // The frontend normalizer reads flat fields; a nested `clean` wrapper
        // would silently render zeros. Pin the exact wire shape.
        let reply = CleanReply {
            clean: CleanOut {
                planned_items: 2,
                planned_bytes: 30,
                freed_bytes: 10,
                removed: 1,
                failed: 1,
                partial: true,
                failures: vec![CleanFailureOut {
                    uri: "/x".to_string(),
                    kind: "log_file".to_string(),
                    message: "locked".to_string(),
                }],
            },
            audit: AuditStatus {
                recorded: 1,
                attempted: 2,
                reason: Some("half".to_string()),
            },
        };
        let v = serde_json::to_value(&reply).expect("serialize");
        assert!(
            v.get("planned_items").is_some(),
            "clean fields hoisted: {v}"
        );
        assert!(v.get("freed_bytes").is_some());
        assert_eq!(v["partial"], true);
        assert_eq!(v["failures"][0]["uri"], "/x");
        assert!(v.get("clean").is_none(), "no nested `clean` wrapper");
        assert_eq!(v["audit"]["recorded"], 1);
        assert_eq!(v["audit"]["attempted"], 2);
        assert_eq!(v["audit"]["reason"], "half");
    }

    #[test]
    fn the_boost_out_reports_whether_it_was_audited() {
        // A forced stop is audited exactly like a clean/uninstall: the reply
        // carries the same `recorded/attempted/reason` status the UI renders.
        let out = BoostOut {
            requested: vec!["com.a".to_string()],
            reclaimed: 1,
            failures: Vec::new(),
            available_before: Some(100),
            available_after: Some(120),
            governor: true,
            audit: AuditStatus {
                recorded: 1,
                attempted: 1,
                reason: None,
            },
        };
        let v = serde_json::to_value(&out).expect("serialize");
        assert_eq!(v["governor"], true);
        assert_eq!(v["requested"][0], "com.a");
        assert_eq!(v["audit"]["recorded"], 1);
        assert_eq!(v["audit"]["attempted"], 1);
        // No reason when there is nothing to explain (serialized as null).
        assert!(
            v["audit"]["reason"].is_null(),
            "no reason when everything recorded: {v}"
        );

        // A boost that never happened (governor unreachable) reports the zero
        // status: "not attempted", never a fabricated trail.
        let idle = BoostOut {
            requested: Vec::new(),
            reclaimed: 0,
            failures: Vec::new(),
            available_before: None,
            available_after: None,
            governor: false,
            audit: AuditStatus::default(),
        };
        let v = serde_json::to_value(&idle).expect("serialize");
        assert_eq!(v["audit"]["recorded"], 0);
        assert_eq!(v["audit"]["attempted"], 0);
    }

    #[test]
    fn the_permission_review_is_shaped_from_daemon_rows() {
        // The daemon supplies the *data*; the domain supplies the *shape*.
        let rows = [
            crate::privacy_client::GrantRow {
                app_id: "com.b".to_string(),
                resources: vec!["microphone".to_string()],
            },
            crate::privacy_client::GrantRow {
                app_id: "com.a".to_string(),
                // Duplicated + out of order: dedup and canonical order come from
                // the domain, not from the daemon's list order.
                resources: vec![
                    "storage".to_string(),
                    "camera".to_string(),
                    "camera".to_string(),
                ],
            },
            // A key the domain does not model is skipped, never guessed.
            crate::privacy_client::GrantRow {
                app_id: "com.a".to_string(),
                resources: vec!["telepathy".to_string()],
            },
        ];
        let out = permission_review_from(&rows);
        assert_eq!(out.len(), 2, "sorted by app id");
        assert_eq!(out[0].app_id, "com.a");
        assert_eq!(
            out[0].resources,
            vec!["camera".to_string(), "storage".to_string()],
            "deduped, in canonical resource order"
        );
        assert_eq!(out[1].app_id, "com.b");
        assert_eq!(out[1].resources, vec!["microphone".to_string()]);
    }

    #[test]
    fn an_empty_grant_set_reviews_to_nothing() {
        assert!(permission_review_from(&[]).is_empty());
    }

    #[test]
    fn report_assesses_storage_only_when_a_backend_observed_it() {
        let (_t, b) = seeded();
        let r = b.report(None, None);
        assert!(r.assessed_area(CareArea::Storage));
        // 175 bytes is well under the 2 GiB warning threshold → a suggestion.
        assert!(r
            .findings
            .iter()
            .any(|f| f.key == "care.storage.reclaimable"));
        assert_eq!(r.score, 95);
    }

    #[tokio::test]
    async fn record_audit_always_reports_attempted_and_a_reason_on_shortfall() {
        // Environment-independent invariant: whatever the daemon does, the caller
        // is told how many records were *attempted* and — when fewer were
        // persisted — why. That is what stops the UI implying a trail it lacks.
        let events = vec![audit::CareAuditEvent {
            principal: audit::ACTOR.to_string(),
            op: audit::OP_CLEAN.to_string(),
            resource: "app_cache".to_string(),
            outcome: "success".to_string(),
            details: String::new(),
        }];
        let st = record_audit(&events).await;
        assert_eq!(st.attempted, 1);
        assert!(st.recorded <= st.attempted);
        assert_eq!(st.reason.is_none(), st.recorded == st.attempted);
    }

    #[tokio::test]
    async fn recording_no_events_is_a_no_op() {
        assert_eq!(record_audit(&[]).await, AuditStatus::default());
    }

    #[test]
    fn the_memory_view_keeps_protected_apps_out_and_orders_cached_first() {
        let apps = vec![
            crate::taskmgr::TaskApp {
                id: "bg".to_string(),
                state: "background".to_string(),
            },
            crate::taskmgr::TaskApp {
                id: "fg".to_string(),
                state: "foreground".to_string(),
            },
            crate::taskmgr::TaskApp {
                id: "c1".to_string(),
                state: "cached".to_string(),
            },
            crate::taskmgr::TaskApp {
                id: "svc".to_string(),
                state: "foreground_service".to_string(),
            },
            crate::taskmgr::TaskApp {
                id: "c2".to_string(),
                state: "cached".to_string(),
            },
        ];
        let v = memory_view(
            Some(8_000),
            Some(2_000),
            &apps,
            Some("balanced".to_string()),
            true,
        );
        assert_eq!(v.total_bytes, Some(8_000));
        assert_eq!(v.available_bytes, Some(2_000));
        assert_eq!(v.mode.as_deref(), Some("balanced"));
        assert!(v.governor);

        let ids: Vec<&str> = v.reclaimable.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "c2", "bg"], "cached first, protected never");
        // The lifecycle key is joined back for display.
        assert_eq!(v.reclaimable[0].state, "cached");
        assert_eq!(v.reclaimable[2].state, "background");
    }

    #[test]
    fn an_unreachable_governor_never_fakes_a_reading() {
        let v = memory_view(None, None, &[], None, false);
        assert_eq!(v.total_bytes, None);
        assert_eq!(v.available_bytes, None, "unknown, not a fabricated 0");
        assert!(v.reclaimable.is_empty());
        assert!(
            !v.governor,
            "the view states that the governor could not be asked"
        );
    }

    #[test]
    fn uninstall_refuses_a_protected_package_before_touching_the_store() {
        let store = StoreBridge::ephemeral();
        let (out, event) =
            uninstall_with_policy(&store, "com.android.settings").expect("policy runs");
        assert!(!out.removed, "a protected package is never removed");
        assert_eq!(out.verdict, "protected");
        assert_eq!(out.reason_key.as_deref(), Some("care.uninstall.protected"));
        // The refusal itself is an auditable event.
        assert_eq!(event.op, audit::OP_UNINSTALL);
        assert_eq!(event.resource, "com.android.settings");
        assert_eq!(event.outcome, "rejected");
        assert_eq!(event.details, "protected");
    }

    #[test]
    fn uninstall_policy_holds_for_a_pinned_package_not_in_the_registry() {
        // Policy runs on identity, so it holds even when the package is unknown
        // to the local inventory (nothing to look up, still refused).
        let store = StoreBridge::ephemeral();
        let (out, event) = uninstall_with_policy(&store, "com.amos.devocare").expect("policy runs");
        assert_eq!(out.verdict, "protected");
        assert_eq!(event.outcome, "rejected");
    }

    #[test]
    fn uninstall_of_an_uninstalled_app_is_audited_as_not_removed() {
        let store = StoreBridge::ephemeral();
        let (out, event) =
            uninstall_with_policy(&store, "com.example.never-installed").expect("policy runs");
        assert!(!out.removed);
        assert!(!out.launched);
        assert_eq!(out.verdict, "unknown");
        assert_eq!(event.op, audit::OP_UNINSTALL);
        assert_eq!(event.outcome, "error");
        assert_eq!(event.details, "not installed");
    }

    /* ------------------- device-backend wiring (fake backend) ------------------- */

    /// A fake device scanner: a fixed snapshot, fixed totals and a fixed battery
    /// reading, so the device-only wiring is testable without an Android VM.
    struct FakeScan {
        items: Vec<JunkItem>,
        totals: StorageTotals,
        battery: BatteryReading,
    }

    impl CareScanner for FakeScan {
        fn name(&self) -> &'static str {
            BACKEND_ANDROID
        }
        fn scan(&mut self) -> Result<HostScan, DevCareError> {
            Ok(HostScan {
                items: self.items.clone(),
                unreadable_dirs: 0,
            })
        }
        fn storage(&mut self) -> StorageTotals {
            self.totals.clone()
        }
        fn battery(&mut self) -> BatteryReading {
            self.battery
        }
    }

    /// A fake device cleaner that always succeeds (nothing on host to delete).
    struct FakeCleaner;

    impl CleanProvider for FakeCleaner {
        fn remove(&mut self, _item: &JunkItem) -> amos_devocare::Result<()> {
            Ok(())
        }
    }

    /// A fake `PackageManager`: a fixed inventory and a configurable removal kind.
    struct FakePackages {
        apps: Vec<InstalledEntry>,
        launched: bool,
    }

    impl PackageSource for FakePackages {
        fn inventory(&self) -> Result<Vec<InstalledEntry>, String> {
            Ok(self.apps.clone())
        }
        fn uninstall(&self, _id: &str) -> Result<Removal, String> {
            Ok(if self.launched {
                Removal::Launched
            } else {
                Removal::Removed
            })
        }
    }

    #[test]
    fn a_device_backend_drives_scan_inventory_and_storage() {
        let bridge = DevCareBridge::unavailable();
        assert!(
            !bridge.status().available,
            "nothing is observed before attach"
        );

        bridge.attach_device(
            Box::new(FakeScan {
                items: vec![JunkItem::new("content://cache/1", JunkKind::AppCache, 4096)],
                totals: StorageTotals {
                    total_bytes: Some(1000),
                    used_bytes: Some(250),
                    free_bytes: Some(750),
                },
                battery: BatteryReading::unknown(),
            }),
            Box::new(FakeCleaner),
            Arc::new(FakePackages {
                apps: vec![InstalledEntry {
                    id: "com.example.game".to_string(),
                    name: "Game".to_string(),
                    size_bytes: Some(10),
                    system: false,
                }],
                launched: true,
            }),
        );

        let s = bridge.status();
        assert!(s.available);
        assert_eq!(s.backend, BACKEND_ANDROID);
        // The attach must NOT scan: it runs on the Activity's main thread
        // (`DevCareGlue.bind` ← `onStart`), so nothing is observed until the
        // off-thread `devcare_scan` command actually runs.
        assert_eq!(
            s.scanned_items, 0,
            "attach installs the backend without scanning"
        );
        // A content:// backend has no confined root label to report.
        assert!(s.root.is_none());

        let scan = bridge.scan().expect("scan ok");
        assert_eq!(scan.report.total_bytes, 4096);
        assert_eq!(bridge.status().scanned_items, 1, "the command did the scan");

        let storage = bridge.storage().expect("storage ok");
        assert!(storage.measured);
        assert_eq!(storage.total_bytes, Some(1000));
        assert_eq!(storage.used_bytes, Some(250));
        assert_eq!(storage.free_bytes, Some(750));
        assert_eq!(storage.used_pct, Some(25));
        assert_eq!(storage.reclaimable_bytes, 4096);
        assert_eq!(storage.backend, BACKEND_ANDROID);

        let packages = bridge.packages().expect("the device owns the inventory");
        let preview = policy_preview(packages.as_ref()).expect("preview ok");
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].verdict, "allowed");

        let (out, _event) =
            uninstall_with_policy(packages.as_ref(), "com.example.game").expect("policy runs");
        assert!(
            !out.removed,
            "an ACTION_DELETE request is not a confirmed removal"
        );
        assert!(out.launched, "the launcher must be reported honestly");
        assert_eq!(out.message, "uninstall intent launched");
    }

    #[test]
    fn re_attaching_a_backend_drops_the_previous_snapshot() {
        // A re-attach (Kotlin `bind` can run again after an Activity restart) must
        // never keep serving the old backend's scan as if the new one observed it.
        let bridge = DevCareBridge::unavailable();
        bridge.attach_device(
            Box::new(FakeScan {
                items: vec![JunkItem::new("content://cache/1", JunkKind::AppCache, 10)],
                totals: StorageTotals::default(),
                battery: BatteryReading::unknown(),
            }),
            Box::new(FakeCleaner),
            Arc::new(FakePackages {
                apps: Vec::new(),
                launched: false,
            }),
        );
        assert_eq!(bridge.scan().expect("scan ok").report.total_items, 1);

        // Re-attach a *different* backend: the old snapshot is gone until scanned.
        bridge.attach_device(
            Box::new(FakeScan {
                items: Vec::new(),
                totals: StorageTotals::default(),
                battery: BatteryReading::unknown(),
            }),
            Box::new(FakeCleaner),
            Arc::new(FakePackages {
                apps: Vec::new(),
                launched: false,
            }),
        );
        assert_eq!(
            bridge.status().scanned_items,
            0,
            "a stale snapshot must not survive a re-attach"
        );
    }

    #[test]
    fn a_backend_that_cannot_measure_reports_unknown_storage_not_zero() {
        // The host-fs scanner has no filesystem-totals reader: the bytes must be
        // unknown (`None`), never a fabricated `0 B`, while the category rows are
        // still observed from the scan snapshot.
        let (t, b) = seeded();
        t.file("another.apk", 10);
        let _ = b.scan();
        let s = b.storage().expect("storage ok");
        assert!(!s.measured);
        assert_eq!(s.total_bytes, None);
        assert_eq!(s.used_bytes, None);
        assert_eq!(s.free_bytes, None);
        assert_eq!(s.used_pct, None);
        assert_eq!(s.backend, BACKEND_HOST_FS);
        assert!(s.reclaimable_bytes > 0, "the scan is still reported");
    }

    /* --------------------------- battery folding --------------------------- */

    #[test]
    fn a_partial_battery_reading_never_becomes_a_fabricated_finding() {
        // A complete reading folds.
        let care = BatteryReading {
            level_pct: Some(42.6),
            charging: Some(false),
            thermal_throttled: Some(true),
        }
        .care()
        .expect("a complete reading folds");
        // Rounded, never truncated: 42.6 must not become 42, and a 20.6% reading
        // must not become 20 and trip the domain's "at or below 20% is low".
        assert_eq!(care.level_pct, 43);
        assert!(
            !care.charging,
            "the reported charger state is carried through"
        );
        assert!(care.thermal_throttled);
        assert_eq!(
            BatteryReading {
                level_pct: Some(20.6),
                charging: Some(false),
                thermal_throttled: None,
            }
            .care()
            .expect("in range")
            .level_pct,
            21,
            "rounding keeps the low-battery threshold honest"
        );

        // ---- out-of-range levels are NOT readings -------------------------------
        // A negative level clamped to 0 would manufacture `care.battery.critical`
        // out of malformed data (a false "charge now!" alarm); a level above 100
        // clamped down would manufacture a healthy battery. Both stay unobserved.
        for bogus in [-1.0, -0.5, 100.5, 150.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                BatteryReading {
                    level_pct: Some(bogus),
                    charging: Some(false),
                    thermal_throttled: None,
                }
                .care(),
                None,
                "level {bogus} must not be folded into a claim"
            );
        }
        // The exact boundaries are real readings.
        assert_eq!(
            BatteryReading {
                level_pct: Some(0.0),
                charging: Some(false),
                thermal_throttled: None,
            }
            .care()
            .expect("0% is a real reading")
            .level_pct,
            0
        );
        assert_eq!(
            BatteryReading {
                level_pct: Some(100.0),
                charging: Some(true),
                thermal_throttled: None,
            }
            .care()
            .expect("100% is a real reading")
            .level_pct,
            100
        );

        // A level with NO charging flag must not be read as `not charging`: at 3%
        // that would fabricate a `care.battery.critical` penalty out of a partial
        // observation. It stays unobserved (the domain refuses partial state).
        assert_eq!(
            BatteryReading {
                level_pct: Some(3.0),
                charging: None,
                thermal_throttled: None,
            }
            .care(),
            None
        );
        // No level at all ⇒ unobserved, even when the charger flag is known.
        assert_eq!(
            BatteryReading {
                level_pct: None,
                charging: Some(true),
                thermal_throttled: None,
            }
            .care(),
            None
        );
        // An unknown thermal flag is folded as `false`: it can only WITHHOLD the
        // thermal penalty, never invent one.
        let no_thermal = BatteryReading {
            level_pct: Some(50.0),
            charging: Some(true),
            thermal_throttled: None,
        }
        .care()
        .expect("level + charging fold");
        assert!(!no_thermal.thermal_throttled);
    }

    #[test]
    fn a_host_reading_is_folded_without_inventing_a_charger_state() {
        use crate::host_battery::HostBattery;

        // A complete host reading folds as-is (the host readers clamp their own
        // levels via `clamp_level` before the bridge ever sees them; what reaches
        // `care()` is already in range).
        let complete = reading_from_host(&HostBattery {
            level_pct: Some(75.0),
            charging: Some(false),
        })
        .care()
        .expect("level + charger fold");
        assert_eq!(complete.level_pct, 75);
        assert!(!complete.charging);
        // The host readers have no thermal source ⇒ unknown ⇒ folded as `false`,
        // which can only withhold the penalty.
        assert!(!complete.thermal_throttled);

        // `care()` still refuses an out-of-range level outright, so a host reading
        // that slipped past its own clamping layer can never be folded into a claim
        // (the same defence-in-depth the device path gets).
        assert_eq!(
            reading_from_host(&HostBattery {
                level_pct: Some(150.0),
                charging: Some(false),
            })
            .care(),
            None
        );

        // The host reader may parse a level but no status (e.g. an unexpected
        // `pmset` status line). That is a PARTIAL observation, so the battery stays
        // unassessed — the old `charging.unwrap_or(false)` would have fabricated a
        // low-battery finding from it.
        assert_eq!(
            reading_from_host(&HostBattery {
                level_pct: Some(4.0),
                charging: None,
            })
            .care(),
            None
        );

        // No host reading at all (desktop without a battery / unsupported OS).
        assert_eq!(reading_from_host(&HostBattery::unknown()).care(), None);
    }

    #[test]
    fn the_device_battery_reading_drives_the_report() {
        let bridge = DevCareBridge::unavailable();
        bridge.attach_device(
            Box::new(FakeScan {
                items: Vec::new(),
                totals: StorageTotals::default(),
                battery: BatteryReading {
                    level_pct: Some(3.0),
                    charging: Some(false),
                    thermal_throttled: Some(true),
                },
            }),
            Box::new(FakeCleaner),
            Arc::new(FakePackages {
                apps: Vec::new(),
                launched: false,
            }),
        );

        // No scan ran, so the storage snapshot is empty (but observed, since a
        // backend is attached) — the battery was read by the backend
        // (`BatteryManager`) and must be graded.
        let r = bridge.report(None, None);
        assert!(r.assessed_area(CareArea::Battery));
        assert_eq!(r.findings[0].key, "care.battery.critical");
        assert!(r.findings.iter().any(|f| f.key == "care.battery.thermal"));
    }

    #[test]
    fn a_device_reading_that_cannot_fill_the_care_state_stays_unassessed() {
        // The glue answered with a level but no charging flag (a partial platform
        // reply). Grading it would invent a low-battery warning, so the battery
        // area must stay OUT of `assessed` instead.
        let bridge = DevCareBridge::unavailable();
        bridge.attach_device(
            Box::new(FakeScan {
                items: Vec::new(),
                totals: StorageTotals::default(),
                battery: BatteryReading {
                    level_pct: Some(4.0),
                    charging: None,
                    thermal_throttled: None,
                },
            }),
            Box::new(FakeCleaner),
            Arc::new(FakePackages {
                apps: Vec::new(),
                launched: false,
            }),
        );
        let r = bridge.report(None, None);
        assert!(
            !r.assessed_area(CareArea::Battery),
            "a partial read is unobserved, not a fabricated penalty"
        );
        assert!(r.findings.iter().all(|f| f.area != CareArea::Battery));
    }
}
