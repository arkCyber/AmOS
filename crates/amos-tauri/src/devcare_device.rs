//! Android device-care backend (cargo feature `android`).
//!
//! On the System UI APK the device-care kernel's three platform seams are filled
//! by the Kotlin `DevCareGlue` (see
//! `android-glue/com/amos/ai/glue/DevCareGlue.kt`), because Rust cannot reach
//! `PackageManager`, `ContentResolver` or a scoped-storage path here:
//!
//! ```text
//!   DevCareBridge  ── CareScanner   ──► scanJunk()      (app-private junk + Download APKs)
//!                  ── CleanProvider ──► removeJunk(uri)
//!                  ── PackageSource ──► installedApps() / uninstallApp(id)  (ACTION_DELETE)
//!                  ── CareScanner   ──► storage()       (StatFs totals)
//!                  ── CareScanner   ──► battery()       (BatteryManager level/scale/status)
//! ```
//!
//! Every round-trip is **String ↔ String JSON**, and the glue reports failures as
//! `{"error":…}` which becomes an honest [`DevCareError`] — never a silent empty
//! scan. Real behaviour needs an Android VM; on host this only has to **compile**
//! (`cargo check -p amos-tauri --features android`).
//!
//! # Why the attach does not scan
//!
//! `DevCareGlue.bind` runs in the Activity's `onStart` (the main thread), so
//! [`Java_com_amos_ai_glue_DevCareGlue_attach`] only installs the backend. The
//! actual scan/query runs from the Tauri commands, which offload the blocking
//! JNI call to `spawn_blocking` (see `crate::devcare`), so a slow MediaStore
//! query can never stall the UI thread.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};
use serde_json::Value as Json;
use tauri::{AppHandle, Manager};

use amos_devocare::{CleanProvider, DevCareError, HostScan, JunkItem, JunkKind, SCAN_ITEM_CAP};

use crate::appstore::InstalledEntry;
use crate::devcare::{
    BatteryReading, CareScanner, DevCareBridge, PackageSource, Removal, StorageTotals,
    BACKEND_ANDROID,
};

/// Installed at boot so the Kotlin glue's JNI upcall can reach the managed bridge.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// The Kotlin glue handle, installed by its JNI attach.
///
/// Kept separate from [`APP`] because **the two arrive in either order**: the
/// Activity's `onStart` (which calls `DevCareGlue.bind` → the JNI attach) is
/// observed to run *before* Tauri's `setup` hook on a device, so an attach that
/// required the `AppHandle` would silently do nothing (device-verified: the
/// `probeAttached` diagnostic reported `{"app_handle":false}` at bind time).
/// Whichever side arrives second performs the one-time backend install.
static GLUE: OnceLock<Arc<GlueRef>> = OnceLock::new();

/// Guards the one-time backend install (see [`install_backend_if_ready`]).
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// On-device only: hand the seam an `AppHandle`. Called once from
/// `lib.rs::setup` (android feature); a second call keeps the first.
///
/// Also performs the one-time backend install when the Kotlin glue has already
/// announced itself (see [`GLUE`]) — the two sides arrive in either order.
pub fn install_android_app(app: AppHandle) {
    let _ = APP.set(app);
    install_backend_if_ready();
}

/// Install the Android device-care backend exactly once, as soon as **both** the
/// `AppHandle` (boot hook) and the Kotlin glue (JNI attach) are known.
///
/// Idempotent and order-agnostic: called from both arrival points, and whichever
/// runs second does the work. A no-op before either side exists.
fn install_backend_if_ready() {
    let (Some(app), Some(glue)) = (APP.get(), GLUE.get()) else {
        return; // the other side has not arrived yet; it will call us again
    };
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return; // already installed (or being installed) by the other side
    }
    let bridge = app.state::<DevCareBridge>();
    bridge.attach_device(
        Box::new(AndroidScanner {
            glue: Arc::clone(glue),
        }),
        Box::new(AndroidCleaner {
            glue: Arc::clone(glue),
        }),
        Arc::new(AndroidPackages {
            glue: Arc::clone(glue),
        }),
    );
    // Opt-in, off-thread bring-up self-check (no-op unless the marker file
    // exists) — see `spawn_bringup_selfcheck`.
    spawn_bringup_selfcheck(Arc::clone(glue));
}

/// `Send + Sync` handle to the Kotlin `DevCareGlue` singleton.
struct GlueRef {
    vm: JavaVM,
    glue: GlobalRef,
}

// SAFETY: a JNI global ref is VM-global and outlives the creating env; every
// method re-attaches the calling thread before touching it.
unsafe impl Send for GlueRef {}
// SAFETY: access always happens on a thread attached to the VM.
unsafe impl Sync for GlueRef {}

impl GlueRef {
    /// Call a `()Ljava/lang/String;` glue method.
    fn call0(&self, method: &str) -> Result<String, String> {
        let mut env = self.attach()?;
        let glue = self.glue.as_obj();
        let out = env
            .call_method(glue, method, "()Ljava/lang/String;", &[])
            .map_err(jerr)?;
        read_string(&mut env, out)
    }

    /// Call a `(Ljava/lang/String;)Ljava/lang/String;` glue method.
    fn call1(&self, method: &str, arg: &str) -> Result<String, String> {
        let mut env = self.attach()?;
        let glue = self.glue.as_obj();
        let jarg: JObject = env.new_string(arg).map_err(jerr)?.into();
        let out = env
            .call_method(
                glue,
                method,
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&jarg)],
            )
            .map_err(jerr)?;
        read_string(&mut env, out)
    }

    /// Attach the current thread to the VM for one call.
    fn attach(&self) -> Result<JNIEnv<'_>, String> {
        self.vm
            .attach_current_thread_permanently()
            .map_err(|e| format!("devcare attach failed: {e}"))
    }
}

fn jerr(e: jni::errors::Error) -> String {
    format!("android devcare glue error: {e}")
}

/// Read a returned `java.lang.String` into an owned Rust `String`.
fn read_string(env: &mut JNIEnv<'_>, out: jni::objects::JValueOwned<'_>) -> Result<String, String> {
    let obj = out.l().map_err(jerr)?;
    let jstr = JString::from(obj);
    let s: String = env.get_string(&jstr).map_err(jerr)?.into();
    Ok(s)
}

/// Parse a glue reply, mapping `{"error":…}` into an honest `Err`.
fn parse_reply(raw: &str) -> Result<Json, String> {
    let v: Json = serde_json::from_str(raw).map_err(|e| format!("glue reply unparseable: {e}"))?;
    if let Some(msg) = v.get("error").and_then(Json::as_str) {
        return Err(msg.to_string());
    }
    Ok(v)
}

/// A backend error attributed to the glue (never a silent success).
fn provider_err(uri: &str, message: impl Into<String>) -> DevCareError {
    DevCareError::Provider {
        uri: uri.to_string(),
        message: message.into(),
    }
}

/// One scanned item from the glue's JSON, or `None` when the row is not usable.
///
/// Two things make a row unusable: an **unknown `kind`** (skipped rather than
/// guessed) and an **absent/unusable `size_bytes`**. The latter matters for the
/// aerospace P0-3 rule ("never fill `0` in as if it were a valid value"):
/// [`JunkItem::size_bytes`] is a plain `u64` and cannot express "unknown", so
/// defaulting to `0` would present a fabricated measurement, understate both
/// `reclaimable_bytes` and the bytes a clean reports as freed. The row is skipped
/// and the caller counts it as a partial scan, so the gap stays visible.
fn parse_item(v: &Json) -> Option<JunkItem> {
    let uri = v.get("uri")?.as_str()?.to_string();
    let kind = JunkKind::from_key(v.get("kind")?.as_str()?)?;
    // A genuine `0` (an empty file / empty dir) still parses: only a *missing*
    // size is unusable.
    let size = v.get("size_bytes").and_then(Json::as_u64)?;
    Some(JunkItem::new(uri, kind, size))
}

/// Decode a `scanJunk()` reply into the shared [`HostScan`] shape.
///
/// Pure and host-testable (the JNI round-trip stays in [`AndroidScanner::scan`]).
/// Beyond JSON decoding it enforces the crate's "never silently trim a destructive
/// input" rule (`docs/devcare.md` §5.3): a reply carrying the scan cap worth of
/// items is **refused**, never accepted as a complete list. The glue already
/// returns `{"error":…}` itself when it hits the cap; this is defence in depth
/// for a glue that truncates without saying so — a partial scan must never look
/// finished to the analyzer that plans deletions from it.
fn parse_scan_reply(raw: &str) -> Result<HostScan, DevCareError> {
    let v = parse_reply(raw).map_err(|m| provider_err("android-scan", m))?;
    let arr = v
        .as_array()
        .ok_or_else(|| provider_err("android-scan", "scan reply is not an array"))?;
    if arr.len() >= SCAN_ITEM_CAP {
        return Err(DevCareError::TooManyItems {
            found: arr.len(),
            cap: SCAN_ITEM_CAP,
        });
    }
    let mut items = Vec::with_capacity(arr.len());
    let mut skipped = 0usize;
    for entry in arr {
        match parse_item(entry) {
            Some(item) => items.push(item),
            None => skipped += 1,
        }
    }
    // A skipped row is a partial scan, not a clean one (honest reporting).
    Ok(HostScan {
        items,
        unreadable_dirs: skipped,
    })
}

/// Decode a `battery()` reply into the bridge's [`BatteryReading`].
///
/// Pure and host-testable (the JNI round-trip stays in [`AndroidScanner::battery`]).
/// A missing / unreadable field stays `None` — an unobserved fact is reported as
/// unknown, never defaulted — and a glue failure (`{"error":…}`) yields an
/// all-unknown reading rather than a fabricated charge, so the bridge falls back to
/// the host reader and leaves the battery area unassessed.
fn parse_battery_reply(raw: &str) -> BatteryReading {
    let Ok(v) = parse_reply(raw) else {
        return BatteryReading::unknown();
    };
    BatteryReading {
        level_pct: v.get("level_pct").and_then(Json::as_f64),
        charging: v.get("charging").and_then(Json::as_bool),
        thermal_throttled: v.get("thermal_throttled").and_then(Json::as_bool),
    }
}

/// One inventory row from the glue's JSON.
fn parse_entry(v: &Json) -> Option<InstalledEntry> {
    let id = v.get("id")?.as_str()?.to_string();
    if id.is_empty() {
        return None;
    }
    let name = v
        .get("name")
        .and_then(Json::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| id.clone());
    Some(InstalledEntry {
        id,
        name,
        // An absent size stays unknown — never a fabricated `0 B`.
        size_bytes: v.get("size_bytes").and_then(Json::as_u64),
        system: v.get("system").and_then(Json::as_bool).unwrap_or(false),
    })
}

/// The Android scan/storage half of [`CareScanner`].
struct AndroidScanner {
    glue: Arc<GlueRef>,
}

impl CareScanner for AndroidScanner {
    fn name(&self) -> &'static str {
        BACKEND_ANDROID
    }

    fn scan(&mut self) -> Result<HostScan, DevCareError> {
        let raw = self
            .glue
            .call0("scanJunk")
            .map_err(|m| provider_err("android-scan", m))?;
        parse_scan_reply(&raw)
    }

    fn storage(&mut self) -> StorageTotals {
        // A missing reading stays `None` (unknown), never a fabricated zero.
        let Ok(raw) = self.glue.call0("storage") else {
            return StorageTotals::default();
        };
        match parse_reply(&raw) {
            Ok(v) => StorageTotals {
                total_bytes: v.get("total_bytes").and_then(Json::as_u64),
                used_bytes: v.get("used_bytes").and_then(Json::as_u64),
                free_bytes: v.get("free_bytes").and_then(Json::as_u64),
            },
            Err(_) => StorageTotals::default(),
        }
    }

    fn battery(&mut self) -> BatteryReading {
        // The device reading comes from `BatteryManager` (the same sticky
        // `ACTION_BATTERY_CHANGED` broadcast `amos-power` reads). A failed round
        // trip stays all-unknown — never a fabricated charge.
        match self.glue.call0("battery") {
            Ok(raw) => parse_battery_reply(&raw),
            Err(_) => BatteryReading::unknown(),
        }
    }
}

/// The Android clean half of [`CleanProvider`].
struct AndroidCleaner {
    glue: Arc<GlueRef>,
}

impl CleanProvider for AndroidCleaner {
    fn remove(&mut self, item: &JunkItem) -> amos_devocare::Result<()> {
        let raw = self
            .glue
            .call1("removeJunk", &item.uri)
            .map_err(|m| provider_err(&item.uri, m))?;
        let v = parse_reply(&raw).map_err(|m| provider_err(&item.uri, m))?;
        if v.get("removed").and_then(Json::as_bool).unwrap_or(false) {
            Ok(())
        } else {
            Err(provider_err(
                &item.uri,
                "the glue did not confirm the removal",
            ))
        }
    }
}

/// The Android package half of [`PackageSource`] (`PackageManager` + `ACTION_DELETE`).
struct AndroidPackages {
    glue: Arc<GlueRef>,
}

impl PackageSource for AndroidPackages {
    fn inventory(&self) -> Result<Vec<InstalledEntry>, String> {
        let raw = self.glue.call0("installedApps")?;
        let v = parse_reply(&raw)?;
        let arr = v
            .as_array()
            .ok_or_else(|| "inventory reply is not an array".to_string())?;
        let mut out: Vec<InstalledEntry> = arr.iter().filter_map(parse_entry).collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    fn uninstall(&self, id: &str) -> Result<Removal, String> {
        let raw = self.glue.call1("uninstallApp", id)?;
        let v = parse_reply(&raw)?;
        if v.get("launched").and_then(Json::as_bool).unwrap_or(false) {
            // Android confirms the removal asynchronously: the request was handed
            // to the platform, the app is not known to be gone.
            Ok(Removal::Launched)
        } else {
            Err("the platform did not launch an uninstall request".to_string())
        }
    }
}

/// Opt-in on-device bring-up self-check (marker file `<dataDir>/files/devcare-selfcheck`).
const SELFCHECK_MARKER: &str = "devcare-selfcheck";
/// Where the bring-up self-check writes its JSON report (readable via `run-as`).
const SELFCHECK_OUT: &str = "devcare-selfcheck.out";

/// Drive the **real** Rust → Kotlin contract once, if the operator asked for it.
///
/// This closes a gap the Kotlin-side self-check (in `DevCareGlue.bind`) cannot:
/// that one calls the platform APIs directly, so it proves `StatFs`/
/// `PackageManager` work but **not** that the JNI method contracts Rust depends on
/// (`scanJunk` / `installedApps` / `storage` / `removeJunk`) are actually callable.
/// When `<dataDir>/files/devcare-selfcheck` exists, one worker thread runs every
/// seam and writes a JSON report to `<dataDir>/files/devcare-selfcheck.out`:
///
/// ```bash
/// adb shell run-as com.amos.ai touch files/devcare-selfcheck
/// adb shell am force-stop com.amos.ai && adb shell am start -n com.amos.ai/.MainActivity
/// adb shell run-as com.amos.ai cat files/devcare-selfcheck.out
/// ```
///
/// Absent the marker **nothing runs**, so production behaviour is unchanged; the
/// work happens on a plain `std::thread` (never the main thread). The check is
/// read-mostly: it plants one temp file in the app's **own cache** and removes it
/// again through the real `AndroidCleaner` — decisive evidence that a Rust
/// instruction reaches Kotlin and the file is actually gone.
fn spawn_bringup_selfcheck(glue: Arc<GlueRef>) {
    let Some(app) = APP.get() else {
        return;
    };
    // Android path resolution is worth being defensive about: `app_data_dir()` is
    // `Context.getDataDir()` there (see `lib.rs`), but the marker the operator
    // creates with `run-as` may land in the data dir, its `files/` child, or the
    // cache dir. Accept any of them, and write the report into **every** candidate
    // that exists so the host can read it wherever it landed.
    let data = app.path().app_data_dir().ok();
    let files = data.as_ref().map(|d| d.join("files"));
    let cache = app.path().app_cache_dir().ok();
    let candidates: Vec<PathBuf> = [files, data, cache].into_iter().flatten().collect();
    if !candidates.iter().any(|d| d.join(SELFCHECK_MARKER).exists()) {
        return; // not requested → production behaviour is unchanged
    }
    let plant_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("files")))
        .unwrap_or_default();
    let _ = std::thread::Builder::new()
        .name("devcare-selfcheck".to_string())
        .spawn(move || {
            let report = run_bringup_selfcheck(&glue, &plant_dir, &candidates);
            for dir in candidates {
                let _ = std::fs::write(dir.join(SELFCHECK_OUT), &report);
            }
        });
}

/// Run every device-care seam once and render a JSON report (see
/// [`spawn_bringup_selfcheck`]).
fn run_bringup_selfcheck(glue: &Arc<GlueRef>, cache: &Path, candidates: &[PathBuf]) -> String {
    let mut scanner = AndroidScanner {
        glue: Arc::clone(glue),
    };
    let totals = scanner.storage();
    let storage = serde_json::json!({
        "total_bytes": totals.total_bytes,
        "used_bytes": totals.used_bytes,
        "free_bytes": totals.free_bytes,
        "measured": totals.total_bytes.is_some(),
    });

    // Plant a temp file in the app's own cache so the scan *must* see it and the
    // cleaner has something real to remove.
    let planted = cache.join("devcare-selfcheck.tmp");
    let planted_uri = planted.to_string_lossy().into_owned();
    let planted_len = b"amos-devcare-selfcheck".len() as u64;
    let written = std::fs::write(&planted, b"amos-devcare-selfcheck").is_ok();
    let planted_report = serde_json::json!({
        "path": planted_uri,
        "written": written,
    });

    let scan_report = match scanner.scan() {
        Ok(scan) => {
            let mut kinds: Vec<&str> = scan.items.iter().map(|i| i.kind.key()).collect();
            kinds.sort_unstable();
            kinds.dedup();
            serde_json::json!({
                "items": scan.items.len(),
                "unreadable_dirs": scan.unreadable_dirs,
                "saw_planted_temp_file": scan.items.iter().any(|i| i.uri == planted_uri),
                "kinds": kinds,
            })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    };

    let packages = AndroidPackages {
        glue: Arc::clone(glue),
    };
    let inventory_report = match packages.inventory() {
        Ok(rows) => serde_json::json!({
            "apps": rows.len(),
            "system_apps": rows.iter().filter(|r| r.system).count(),
            "with_size": rows.iter().filter(|r| r.size_bytes.is_some()).count(),
            "sample": rows.iter().take(3).map(|r| r.id.clone()).collect::<Vec<_>>(),
        }),
        Err(e) => serde_json::json!({ "error": e }),
    };

    // The decisive step: instruct Kotlin (through JNI) to delete the file Rust
    // just created, then confirm it is gone.
    let mut cleaner = AndroidCleaner {
        glue: Arc::clone(glue),
    };
    let item = JunkItem::new(planted_uri.clone(), JunkKind::TempFile, planted_len);
    let removed = cleaner.remove(&item);
    let remove_report = serde_json::json!({
        "ok": removed.is_ok(),
        "error": removed.err().map(|e| e.to_string()),
        "file_gone": !planted.exists(),
    });

    // A path outside the app's own directories must be refused by the glue.
    let outside = JunkItem::new(
        "/data/local/tmp/amos-devocare-selfcheck".to_string(),
        JunkKind::TempFile,
        0,
    );
    let refused = cleaner.remove(&outside);
    let refuse_report = serde_json::json!({
        "refused": refused.is_err(),
        "error": refused.err().map(|e| e.to_string()),
    });

    serde_json::json!({
        "resolved_dirs": candidates
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        "plant_dir": cache.to_string_lossy(),
        "storage": storage,
        "planted_temp_file": planted_report,
        "scan": scan_report,
        "inventory": inventory_report,
        "remove_planted": remove_report,
        "refuse_outside_path": refuse_report,
        "note": "uninstallApp is deliberately NOT exercised: ACTION_DELETE opens a system dialog",
    })
    .to_string()
}

/// `DevCareGlue.probeAttached()` → a one-line diagnostic of the Rust half.
///
/// Lets the Kotlin glue (which *can* log to logcat) report what Rust actually
/// sees: whether the boot-time `AppHandle` is installed, which backend the
/// managed bridge holds, and how the platform paths resolve. Purely diagnostic —
/// it changes no state and does no work beyond building a short string.
///
/// # Safety
/// `env`/`this` are the standard JNI instance-method arguments of
/// `DevCareGlue.probeAttached()`.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_DevCareGlue_probeAttached(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
) -> jni::sys::jstring {
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
    let Ok(env) = (unsafe { JNIEnv::from_raw(env) }) else {
        return std::ptr::null_mut();
    };
    let report = match APP.get() {
        None => serde_json::json!({ "app_handle": false }),
        Some(app) => {
            // Never block, and **never touch `app.path()` here**: on Android the
            // path resolver is a round-trip into the WebView's JS
            // (`plugin:path|resolve_directory`), so calling it on the main thread
            // deadlocks (device-verified: this probe hung the first time it ran
            // with an `AppHandle` present, i.e. as soon as it reached the path
            // calls). The resolved directories are reported by the off-thread
            // bring-up self-check instead (`resolved_dirs` in its report).
            let status = app.state::<DevCareBridge>().try_status();
            let (backend, available, can_clean, scanned_items, lock) = match status {
                Some(s) => (s.backend, s.available, s.can_clean, s.scanned_items, "free"),
                None => (
                    "?".to_string(),
                    false,
                    false,
                    0,
                    "CONTENDED (another thread holds the bridge lock)",
                ),
            };
            serde_json::json!({
                "app_handle": true,
                "glue": GLUE.get().is_some(),
                "installed": INSTALLED.load(Ordering::SeqCst),
                "bridge_lock": lock,
                "backend": backend,
                "available": available,
                "can_clean": can_clean,
                "scanned_items": scanned_items,
            })
        }
    };
    match env.new_string(report.to_string()) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

///
/// Idempotent: a re-attach replaces the backend and leaves the snapshot empty
/// until a `devcare_scan` command runs — **no scan happens here** (see the
/// module docs). It must not, because this runs on the Activity's main thread.
///
/// # Safety
/// `env`/`this` are the standard JNI instance-method arguments of
/// `DevCareGlue.attach(glue)`; `glue` is a live local ref to the Kotlin singleton
/// and is promoted to a global ref here.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_DevCareGlue_attach(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    glue: jni::sys::jobject,
) {
    if env.is_null() || glue.is_null() {
        return; // nothing valid yet → honest no-op, no backend is installed
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
    let Ok(env) = (unsafe { JNIEnv::from_raw(env) }) else {
        return;
    };
    let Ok(vm) = env.get_java_vm() else {
        return;
    };
    // SAFETY: `glue` is a live local ref for the duration of this call.
    let obj = unsafe { JObject::from_raw(glue) };
    let Ok(global) = env.new_global_ref(obj) else {
        return;
    };
    let handle = Arc::new(GlueRef { vm, glue: global });
    // Announce the glue and install the backend if the boot hook has already run.
    // On a device the opposite order is the common one (this runs in the
    // Activity's `onStart`, before Tauri's `setup`), so `install_android_app`
    // completes the install later — see `GLUE`.
    let _ = GLUE.set(Arc::clone(&handle));
    install_backend_if_ready();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scan_reply_maps_rows_and_counts_unknown_kinds_as_partial() {
        let raw = r#"[
            {"uri":"/a/cache.bin","kind":"app_cache","size_bytes":10},
            {"uri":"/a/old.apk","kind":"apk_installer","size_bytes":20},
            {"uri":"/a/mystery","kind":"telepathy","size_bytes":30}
        ]"#;
        let scan = parse_scan_reply(raw).expect("a normal reply parses");
        assert_eq!(scan.items.len(), 2);
        assert_eq!(scan.items[0].size_bytes, 10);
        assert_eq!(scan.items[0].kind, JunkKind::AppCache);
        // An unmodelled kind is a PARTIAL scan (observable), never a silent drop.
        assert_eq!(scan.unreadable_dirs, 1);
    }

    #[test]
    fn a_glue_error_is_an_honest_error_not_an_empty_scan() {
        // The glue reports its own failures as `{"error":…}`; that must become an
        // honest `Err`, never an empty (and therefore "healthy-looking") scan.
        let err = parse_scan_reply(r#"{"error":"DevCareGlue not bound"}"#).unwrap_err();
        assert_eq!(err.key(), "provider");
        assert!(err.to_string().contains("not bound"), "got {err}");

        let not_array = parse_scan_reply(r#"{"items":[]}"#).unwrap_err();
        assert_eq!(not_array.key(), "provider");

        let malformed = parse_scan_reply("{not json").unwrap_err();
        assert_eq!(malformed.key(), "provider");
    }

    #[test]
    fn a_scan_at_the_cap_is_refused_instead_of_silently_truncated() {
        // A reply carrying the cap worth of rows cannot be proven complete, so it
        // must be refused (docs/devcare.md §5.3) — never accepted as a full list
        // that the cleaner then plans deletions from. Defence in depth for a glue
        // that truncates without signalling.
        let row = r#"{"uri":"/a/x","kind":"app_cache","size_bytes":1}"#;
        let raw = format!("[{}]", vec![row; SCAN_ITEM_CAP].join(","));
        let err = parse_scan_reply(&raw).unwrap_err();
        assert_eq!(
            err,
            DevCareError::TooManyItems {
                found: SCAN_ITEM_CAP,
                cap: SCAN_ITEM_CAP
            }
        );
        // One below the cap is still a complete-enough scan and parses.
        let ok_raw = format!("[{}]", vec![row; SCAN_ITEM_CAP - 1].join(","));
        assert_eq!(
            parse_scan_reply(&ok_raw)
                .expect("just under the cap is fine")
                .items
                .len(),
            SCAN_ITEM_CAP - 1
        );
    }

    #[test]
    fn a_row_without_a_usable_size_is_left_out_instead_of_sized_zero() {
        // `JunkItem::size_bytes` cannot express "unknown", so a row with no usable
        // size must not be modelled at all — reporting `0 B` would be a fabricated
        // measurement (aerospace P0-3) that also understates what a clean frees. The
        // omission is counted as a partial scan so it stays visible.
        let raw = r#"[
            {"uri":"/a/ok.apk","kind":"apk_installer","size_bytes":30},
            {"uri":"/a/no-size.apk","kind":"apk_installer"},
            {"uri":"/a/null-size.apk","kind":"apk_installer","size_bytes":null},
            {"uri":"/a/text-size.apk","kind":"apk_installer","size_bytes":"40"}
        ]"#;
        let scan = parse_scan_reply(raw).expect("a well-formed array parses");
        assert_eq!(scan.items.len(), 1, "only the sized row is modelled");
        assert_eq!(scan.items[0].uri, "/a/ok.apk");
        assert_eq!(
            scan.unreadable_dirs, 3,
            "every unusable row is reported as partial, not silently dropped"
        );

        // A genuine `0` (an empty file / an empty directory) is a real measurement
        // and must survive.
        let zero = parse_scan_reply(r#"[{"uri":"/a/empty","kind":"empty_dir","size_bytes":0}]"#)
            .expect("parses");
        assert_eq!(zero.items.len(), 1);
        assert_eq!(zero.items[0].size_bytes, 0);
        assert_eq!(zero.unreadable_dirs, 0);
    }

    #[test]
    fn a_battery_reply_maps_every_field_and_keeps_unknowns_unknown() {
        let full =
            parse_battery_reply(r#"{"level_pct":42,"charging":true,"thermal_throttled":true}"#);
        assert_eq!(full.level_pct, Some(42.0));
        assert_eq!(full.charging, Some(true));
        assert_eq!(full.thermal_throttled, Some(true));

        // A level-only reply keeps the other facts unknown — the bridge must never
        // read a missing charging flag as "not charging" (that would fabricate a
        // low-battery penalty out of a partial platform answer).
        let partial = parse_battery_reply(r#"{"level_pct":12}"#);
        assert_eq!(partial.level_pct, Some(12.0));
        assert_eq!(partial.charging, None);
        assert_eq!(partial.thermal_throttled, None);

        // Below API 29 the glue omits `thermal_throttled` (no `PowerManager`
        // verdict): unknown, not `false`.
        let old_api = parse_battery_reply(r#"{"level_pct":80,"charging":false}"#);
        assert_eq!(old_api.thermal_throttled, None);

        // The glue omits `charging` when the platform never reported a status
        // (`BATTERY_STATUS_UNKNOWN` / absent extra): the charger state stays
        // unknown so the bridge cannot fabricate a low-battery penalty, and a
        // wrong-typed field is treated as absent rather than coerced.
        let no_status = parse_battery_reply(r#"{"level_pct":4}"#);
        assert_eq!(no_status.charging, None);
        assert_eq!(
            parse_battery_reply(r#"{"level_pct":"4","charging":"true","thermal_throttled":1}"#),
            BatteryReading::unknown()
        );

        // A glue error / non-JSON is an honest all-unknown reading, never a
        // fabricated `0%`.
        assert_eq!(
            parse_battery_reply(r#"{"error":"no battery broadcast"}"#),
            BatteryReading::unknown()
        );
        assert_eq!(parse_battery_reply("{not json"), BatteryReading::unknown());
    }
}
