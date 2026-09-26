//! Spam blocking bridge — rule storage + enforcement for calls and SMS.
//!
//! The rules live in **one process-global state** ([`shared`]) so three very
//! different callers agree on the same list:
//!
//! * the WebView (Tauri commands, `blocklist_*`),
//! * the SMS read path (`sms_snapshot`/`sms_messages` filter blocked senders),
//! * the Android `CallScreeningService`, which reaches Rust over JNI
//!   (`Java_com_amos_ai_glue_BlocklistGlue_shouldBlockCall`) — possibly in a
//!   process cold-started *by the system* for the incoming call, which is why the
//!   glue can hand us the storage directory itself ([`BlocklistState::configure`]).
//!
//! Persistence is a small JSON file (atomic write: temp + rename) so a crash
//! cannot leave a half-written list. A corrupt file is **not** silently ignored:
//! it is logged and the list starts empty (crashing because a settings file is
//! damaged would be worse, but the failure is never hidden from the operator).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use amos_blocklist::{BlockReason, Blocklist, Channel, MatchKind, Rule, DEFAULT_CAP};
use serde::Serialize;

/// File name inside the app data dir.
pub const BLOCKLIST_FILE: &str = "blocklist.json";

/// Process-global rule state (shared by commands, the SMS path and JNI).
pub struct BlocklistState {
    inner: RwLock<Blocklist>,
    path: Mutex<Option<PathBuf>>,
}

impl BlocklistState {
    /// Empty state with no persistence yet (tests / before `configure`).
    pub fn empty() -> Self {
        Self {
            inner: RwLock::new(Blocklist::new()),
            path: Mutex::new(None),
        }
    }

    /// Point the state at a file and load it (once per path). A missing file is
    /// simply "no rules yet"; a corrupt one is logged and treated as empty.
    pub fn configure(&self, path: PathBuf) {
        let mut slot = match self.path.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        if slot.as_deref() == Some(path.as_path()) {
            return;
        }
        *slot = Some(path.clone());
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) => {
                // A *missing* file is the ordinary first-run case ("no rules yet",
                // the module header's words) and needs no line. Any **other** read
                // failure — a permissions problem, a directory in the way, an I/O
                // error — is a real fault, and this module's rule is "the failure is
                // never hidden from the operator". `if let Ok(text) = …` without this
                // arm folded the two together and said nothing (audit PH-P2-04),
                // while the sibling *parse* failure below has always logged.
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        target: "amos::blocklist",
                        path = %path.display(),
                        error = %e,
                        "blocklist file could not be read — starting empty"
                    );
                }
                return;
            }
        };
        match Blocklist::from_json(&text, DEFAULT_CAP) {
            Ok(loaded) => {
                // A malformed rule is skipped, not fatal: the valid rules load
                // and the bad ones are named here, so one hand-edited row no
                // longer empties the whole list (REQ-A1771).
                for e in &loaded.rejected {
                    tracing::warn!(
                        target: "amos::blocklist",
                        path = %path.display(),
                        kind = e.kind(),
                        "blocklist rule skipped: {e}"
                    );
                }
                // `self.write()` recovers a poisoned lock, like every sibling site
                // (`read`/`write`, the path lock). A bare `if let Ok(..) = write()`
                // dropped a poisoned lock silently, and the `info!` below then
                // reported "blocklist loaded" with a rule count over an unchanged —
                // empty — list: the blocklist stopped enforcing while the log said
                // it had loaded.
                let kept = loaded.list.len();
                *self.write() = loaded.list;
                tracing::info!(
                    target: "amos::blocklist",
                    path = %path.display(),
                    rules = kept,
                    skipped = loaded.rejected.len(),
                    "blocklist loaded"
                );
            }
            Err(e) => tracing::warn!(
                target: "amos::blocklist",
                path = %path.display(),
                kind = e.kind(),
                "blocklist file unreadable — starting empty"
            ),
        }
    }

    /// The configured file, if any.
    pub fn path(&self) -> Option<PathBuf> {
        self.path
            .lock()
            .map(|p| p.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }

    /// Serialized snapshot for the UI.
    pub fn snapshot(&self) -> BlocklistOut {
        let list = self.read();
        BlocklistOut {
            block_unknown: list.block_unknown(),
            rules: list.rules().iter().map(RuleOut::from).collect(),
        }
    }

    /// Add (or refresh) a rule and persist.
    pub fn add(
        &self,
        pattern: &str,
        kind: &str,
        channel: &str,
        label: &str,
        now_ms: i64,
    ) -> Result<RuleOut, String> {
        let kind = MatchKind::from_wire(kind).map_err(|e| e.to_string())?;
        let channel = Channel::from_wire(channel).map_err(|e| e.to_string())?;
        let rule = {
            let mut list = self.write();
            list.add(pattern, kind, channel, label, now_ms)
                .map_err(|e| e.to_string())?
        };
        self.persist();
        Ok(RuleOut::from(&rule))
    }

    /// Remove a rule by id and persist; `true` when it existed.
    pub fn remove(&self, id: &str) -> bool {
        let removed = self.write().remove(id);
        if removed {
            self.persist();
        }
        removed
    }

    /// Drop every rule and persist.
    pub fn clear(&self) {
        self.write().clear();
        self.persist();
    }

    /// Turn unknown/withheld-number blocking on/off and persist.
    pub fn set_block_unknown(&self, on: bool) {
        self.write().set_block_unknown(on);
        self.persist();
    }

    /// Why `address` is blocked for `traffic` (None = allowed).
    pub fn check(&self, address: &str, traffic: Channel) -> Option<BlockReason> {
        self.read().check(address, traffic)
    }

    /// Is this SMS sender blocked?
    pub fn blocks_sms(&self, address: &str) -> bool {
        self.read().is_blocked(address, Channel::Sms)
    }

    /// Is this caller blocked?
    pub fn blocks_call(&self, address: &str) -> bool {
        self.read().is_blocked(address, Channel::Call)
    }

    /// `true` when at least one rule covers calls (so the UI/Kotlin side knows
    /// whether requesting the system Call Screening role is worthwhile).
    pub fn has_call_rules(&self) -> bool {
        self.read().has_rules_for(Channel::Call)
    }

    /// `true` when at least one rule covers SMS.
    pub fn has_sms_rules(&self) -> bool {
        self.read().has_rules_for(Channel::Sms)
    }

    /// `true` when the SMS read path can hide a thread *at all*: either a rule
    /// covers SMS, **or** the unknown-number switch is on.
    ///
    /// The switch matters because [`Blocklist::check`] treats an unparseable
    /// address as `BlockReason::Unknown` rather than "allowed" — an alphanumeric
    /// service id like `TM-ALIPAY` is hidden from the thread list even with zero
    /// rules. Callers that derive filtered data (e.g. the folder badges in
    /// `sms_counts`) must gate on this, not on [`Self::has_sms_rules`], or the
    /// badge would count a thread the list hides.
    pub fn filters_sms(&self) -> bool {
        let list = self.read();
        list.has_rules_for(Channel::Sms) || list.block_unknown()
    }

    /// `true` when the call path can reject a call *at all*: either a rule covers
    /// calls, **or** the unknown-number switch is on.
    ///
    /// The twin of [`Self::filters_sms`], and the question both the UI's
    /// enforcement banner and the Kotlin role request are actually asking. The
    /// switch matters for the same reason [`Blocklist::check`] treats an
    /// unparseable address as `BlockReason::Unknown`: `shouldBlockCall("")`
    /// (`Java_..._BlocklistGlue_shouldBlockCall`, the withheld-number path) folds
    /// to [`Self::blocks_call`], so with the switch on and **zero** explicit call
    /// rules a withheld caller is still rejected once the Call Screening role is
    /// held. Gating on [`Self::has_call_rules`] alone therefore leaves the role
    /// un-requested and the banner hidden while rejection is possible.
    pub fn filters_calls(&self) -> bool {
        let list = self.read();
        list.has_rules_for(Channel::Call) || list.block_unknown()
    }

    /// Write the rules atomically (temp file + rename). Best-effort: failures are
    /// logged, never fatal (a full disk must not break call screening).
    pub fn persist(&self) {
        let Some(path) = self.path() else {
            return; // no file configured (tests / host before setup)
        };
        if let Some(dir) = path.parent() {
            // Name the directory failure itself: the write below will fail too, and its
            // error would not tell the operator that it was the mkdir that was refused.
            if let Err(e) = std::fs::create_dir_all(dir) {
                tracing::warn!(
                    target: "amos::blocklist",
                    dir = %dir.display(),
                    error = %e,
                    "blocklist directory could not be created"
                );
            }
        }
        let payload = self.read().to_json();
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, payload.as_bytes()) {
            tracing::warn!(target: "amos::blocklist", error = %e, "blocklist write failed");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            tracing::warn!(target: "amos::blocklist", error = %e, "blocklist rename failed");
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Blocklist> {
        self.inner.read().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Blocklist> {
        self.inner.write().unwrap_or_else(|p| p.into_inner())
    }
}

impl Default for BlocklistState {
    fn default() -> Self {
        Self::empty()
    }
}

static SHARED: OnceLock<Arc<BlocklistState>> = OnceLock::new();

/// The process-global rule state (created on first use).
pub fn shared() -> Arc<BlocklistState> {
    Arc::clone(SHARED.get_or_init(|| Arc::new(BlocklistState::empty())))
}

/// Resolve the persistence file from an app data dir.
pub fn file_in(data_dir: &Path) -> PathBuf {
    data_dir.join(BLOCKLIST_FILE)
}

/// Serializable mirror of a rule.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RuleOut {
    pub id: String,
    pub pattern: String,
    pub kind: String,
    pub channel: String,
    pub label: String,
    pub created_ms: i64,
}

impl From<&Rule> for RuleOut {
    fn from(r: &Rule) -> Self {
        Self {
            id: r.id.clone(),
            pattern: r.pattern.clone(),
            kind: r.kind.wire().to_string(),
            channel: r.channel.wire().to_string(),
            label: r.label.clone(),
            created_ms: r.created_ms,
        }
    }
}

/// Serializable mirror of the whole list.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BlocklistOut {
    pub block_unknown: bool,
    pub rules: Vec<RuleOut>,
}

/// On-device enforcement status, so the UI can be honest about whether call
/// blocking is *actually* live (rules alone are not enough — the OS role is).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BlocklistStatusOut {
    /// At least one rule covers calls.
    pub has_call_rules: bool,
    /// The call path can reject a call *at all* — a rule covers calls **or** the
    /// unknown-number switch is on (see [`BlocklistState::filters_calls`]).
    ///
    /// This, not `has_call_rules`, is what the UI's enforcement banner and the
    /// Kotlin role request gate on: with the switch on and no call rules a
    /// withheld caller is still rejected, so the role must still be asked for.
    pub filters_calls: bool,
    /// At least one rule covers SMS.
    pub has_sms_rules: bool,
    /// The platform supports the Call Screening role (Android 10 / API 29+).
    pub role_supported: bool,
    /// AmOS currently holds `ROLE_CALL_SCREENING`, i.e. rejection is live.
    ///
    /// **Read `role_requestable` first.** `false` here is only a device fact when the
    /// probe answered; when the glue is not bound, or the JNI call failed, there was
    /// no answer to fold and this is `false` for want of one. `role_requestable`
    /// distinguishes the two — rendering this boolean alone as 「AmOS 未获系统「来电筛选」
    /// 权限」 states something we never learned (see `role_status_from`).
    pub role_held: bool,
    /// The native glue is attached, so a role request can actually be delivered
    /// (host/desktop or a not-yet-bound glue cannot).
    ///
    /// This is the field that carries "we could not ask": `PhoneApp.svelte` prints the
    /// honest 「…原生桥未就绪」 sentence whenever it is `false`, instead of claiming a
    /// role verdict it does not have.
    pub role_requestable: bool,
}

// ---- Tauri commands ------------------------------------------------------------

/// Read the whole blocklist (rules newest first + the unknown-number switch).
#[tauri::command]
pub fn blocklist_snapshot(state: tauri::State<'_, Arc<BlocklistState>>) -> BlocklistOut {
    state.snapshot()
}

/// Add (or refresh) a rule. `kind` ∈ exact|prefix, `channel` ∈ call|sms|both.
#[tauri::command]
pub fn blocklist_add(
    state: tauri::State<'_, Arc<BlocklistState>>,
    pattern: String,
    kind: String,
    channel: String,
    label: String,
) -> Result<RuleOut, String> {
    let now = now_ms();
    let out = state.add(&pattern, &kind, &channel, &label, now)?;
    tracing::info!(
        target: "amos::blocklist",
        pattern = %out.pattern,
        kind = %out.kind,
        channel = %out.channel,
        "blocklist rule added"
    );
    Ok(out)
}

/// Remove a rule by id; `true` when it existed.
#[tauri::command]
pub fn blocklist_remove(state: tauri::State<'_, Arc<BlocklistState>>, id: String) -> bool {
    state.remove(&id)
}

/// Drop every rule (keeps the unknown-number switch).
#[tauri::command]
pub fn blocklist_clear(state: tauri::State<'_, Arc<BlocklistState>>) {
    state.clear();
}

/// Turn unknown/withheld-number blocking on/off.
#[tauri::command]
pub fn blocklist_set_unknown(state: tauri::State<'_, Arc<BlocklistState>>, on: bool) {
    state.set_block_unknown(on);
}

/// Why an address is blocked for a channel: `null` = allowed.
#[tauri::command]
pub fn blocklist_check(
    state: tauri::State<'_, Arc<BlocklistState>>,
    address: String,
    channel: String,
) -> Result<Option<BlockReason>, String> {
    let channel = Channel::from_wire(&channel).map_err(|e| e.to_string())?;
    Ok(state.check(&address, channel))
}

/// Whether call blocking can actually take effect right now (rules + OS role).
///
/// Deliberately I/O-free beyond a cheap JNI boolean call: the UI polls it after
/// every rule change and on mount, so it must never block the WebView.
#[tauri::command]
pub fn blocklist_status(state: tauri::State<'_, Arc<BlocklistState>>) -> BlocklistStatusOut {
    status_of(&state)
}

/// Pure status assembly (unit-testable without a Tauri app handle).
pub fn status_of(state: &BlocklistState) -> BlocklistStatusOut {
    let (role_supported, role_held, role_requestable) = role_probe();
    BlocklistStatusOut {
        has_call_rules: state.has_call_rules(),
        filters_calls: state.filters_calls(),
        has_sms_rules: state.has_sms_rules(),
        role_supported,
        role_held,
        role_requestable,
    }
}

/// Fold the three role probes into the tuple `BlocklistStatusOut` carries.
///
/// `role_requestable` is documented as "the native glue is attached, so a role request
/// can actually be delivered", and `PhoneApp.svelte` reads it as exactly that
/// (`roleAskable = role_supported && role_requestable`, with the `{:else}` branch
/// printing 「…原生桥未就绪」). So it is **the** field the "we could not ask" verdict has
/// to land in — `role_held` cannot carry it, because that field is documented as "AmOS
/// currently holds ROLE_CALL_SCREENING" and the UI renders it as a sentence about the
/// device (「AmOS 未获系统「来电筛选」权限——来电不会被拒接」). Folding "could not ask" into
/// `role_held = false` makes the UI assert a device fact it never learned, and offer a
/// grant button that `requestScreeningRoleBound()` answers `false` to without doing
/// anything.
///
/// Three ways the answer can be missing, and where each one goes:
///   * no glue at all (`supported` is `Err`) → `(false, false, false)`: the desktop /
///     JVM-never-captured case, reported as "unsupported" (unchanged behaviour);
///   * glue present but **not bound** (`appContext == null`) → `requestable` is false.
///     Both Kotlin entry points start with `appContext ?: return false`, so a request
///     cannot be delivered — this is the case `BlocklistGlue.screeningRoleHeldBound`'s
///     own doc singles out ("`false` when the glue was never bound … callers must not
///     read that as 'granted but off'");
///   * bound but the `held` probe **failed** → `held` can only be `false` on the wire,
///     so `requestable` stays true (a request *can* be delivered while bound) and the
///     caller reads the pair, not the single boolean.
///
/// `bound` is a local fact (`appContext != null`), not a remote read, so it cannot
/// itself fail — the `unwrap_or(false)` on it is a "no VM captured" default, which is
/// the same answer as "not bound" for reachability purposes.
///
/// Pure and hoisted out of the `#[cfg(feature = "android")]` module so the not-bound
/// branch is testable on the host.
fn role_status_from(
    supported: Result<bool, String>,
    held: Result<bool, String>,
    bound: Result<bool, String>,
) -> (bool, bool, bool) {
    let supported = match supported {
        Ok(supported) => supported,
        Err(_) => return (false, false, false),
    };
    // `held: Err` means the JNI call did not answer. The wire type can only carry a
    // bool, so it lands on `false` — deliberately *not* promoted to a device claim,
    // because the caller gates on `requestable` before rendering it.
    let held = held.unwrap_or(false);
    let bound = bound.unwrap_or(false);
    (supported, held, supported && bound)
}

/// Ask the system for the Call Screening role (foreground, user-initiated).
///
/// Returns `true` when the system dialog was posted **or** the role is already
/// held. The startup path also requests it, but a background app-context
/// `startActivity` is subject to Android 10+ background-start limits, so an
/// explicit button (this command, running while AmOS is foreground) is the
/// reliable way to grant it.
#[tauri::command]
pub fn blocklist_request_role() -> Result<bool, String> {
    request_screening_role()
}

/// Host default: there is no Android Call Screening role (and no glue to reach).
///
/// Reported honestly as "unsupported" rather than pretending the feature exists,
/// so the desktop UI can say so instead of showing a dead button.
///
/// Every probe fails here, which *is* the "no glue at all" arm of
/// [`role_status_from`] — spelled through the fold rather than as a literal triple,
/// so the desktop answer and the device answer cannot drift apart.
#[cfg(not(feature = "android"))]
fn role_probe() -> (bool, bool, bool) {
    let absent = Err("call screening role is only available on Android".to_string());
    role_status_from(absent.clone(), absent.clone(), absent)
}

/// Host default: refuse rather than silently do nothing.
#[cfg(not(feature = "android"))]
fn request_screening_role() -> Result<bool, String> {
    Err("call screening role is only available on Android".to_string())
}

/// Device: ask the Kotlin `BlocklistGlue` (see `mod device`).
#[cfg(feature = "android")]
fn role_probe() -> (bool, bool, bool) {
    device::role_probe()
}

/// Device: post the system role dialog (see `mod device`).
#[cfg(feature = "android")]
fn request_screening_role() -> Result<bool, String> {
    device::request_screening_role()
}

/// Milliseconds since the Unix epoch (rules are ordered by this).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- SMS enforcement helpers (pure, so they are unit-tested) -------------------

/// Drop blocked senders from a thread list. Returns the kept threads and how
/// many were hidden (the caller may surface the count; we never silently claim
/// "no messages").
pub fn filter_threads(
    threads: Vec<amos_sms::SmsThread>,
    rules: &BlocklistState,
) -> (Vec<amos_sms::SmsThread>, usize) {
    let before = threads.len();
    let kept: Vec<amos_sms::SmsThread> = threads
        .into_iter()
        .filter(|t| !rules.blocks_sms(&t.address))
        .collect();
    let hidden = before - kept.len();
    (kept, hidden)
}

// ---- On-device (JNI) ----------------------------------------------------------

/// On-device hooks for the Android `BlocklistGlue` / `CallScreeningService`.
///
/// The screening service may run in a process the system cold-started for an
/// incoming call, so it hands us its storage directory ([`configure`]) before
/// asking whether to reject the call.
#[cfg(feature = "android")]
mod device {
    use super::*;
    use jni::objects::JString;
    use jni::sys::{jboolean, jstring, JNI_FALSE, JNI_TRUE};
    use jni::JavaVM;

    /// The process `JavaVM`, captured on the first upcall so the `blocklist_status`
    /// / `blocklist_request_role` commands can attach and call the Kotlin statics
    /// (mirrors `incall`). `configure` runs at app start (unconditionally, from the
    /// Activity) and again from the screening service, so it is captured early.
    static VM: OnceLock<JavaVM> = OnceLock::new();

    /// Call a `public static` boolean method on the Kotlin `BlocklistGlue` object.
    ///
    /// Returns `Err` when the glue was never bound (no VM captured) — the caller
    /// reports that as "not requestable" instead of a fake `false`.
    fn call_static_bool(method: &str) -> Result<bool, String> {
        let vm = VM
            .get()
            .ok_or_else(|| "blocklist JVM not captured yet".to_string())?;
        // Shared helper: attach with a clean exception state (REQ-A186).
        let mut env =
            amos_jni::attached(vm).map_err(|e| format!("blocklist attach failed: {e}"))?;
        // Same boundary as `incall`: no `Context` here (only the captured `JavaVM`), so
        // the class is resolved through the calling thread's loader — correct from a
        // Java upcall, a clean error from a tokio worker — and the call is wrapped so a
        // failure cannot leave an exception pending (see scripts/jni-allowlist.json).
        let class = amos_jni::jni_call!(env, env.find_class("com/amos/ai/glue/BlocklistGlue"))
            .map_err(|e| e.to_string())?;
        let value = amos_jni::jni_call!(env, env.call_static_method(&class, method, "()Z", &[]))
            .map_err(|e| e.to_string())?;
        value.z().map_err(|e| e.to_string())
    }

    /// `BlocklistGlue.screeningRoleSupported()` — platform supports the role.
    fn role_supported() -> Result<bool, String> {
        call_static_bool("screeningRoleSupported")
    }

    /// `BlocklistGlue.screeningRoleHeldBound()` — AmOS holds the role now.
    fn role_held() -> Result<bool, String> {
        call_static_bool("screeningRoleHeldBound")
    }

    /// `BlocklistGlue.screeningRoleBoundReady()` — is the glue bound at all?
    ///
    /// `screeningRoleHeldBound` / `requestScreeningRoleBound` both open with
    /// `appContext ?: return false`, so this is exactly their reachability condition.
    fn role_bound() -> Result<bool, String> {
        call_static_bool("screeningRoleBoundReady")
    }

    /// `(role_supported, role_held, requestable)`; `requestable` is false when the
    /// glue is not bound, so the UI can tell "not granted yet" from "cannot ask".
    ///
    /// The folding rule (and why `requestable`, not `role_held`, carries the verdict)
    /// lives in `role_status_from`, which is host-testable.
    pub(super) fn role_probe() -> (bool, bool, bool) {
        super::role_status_from(role_supported(), role_held(), role_bound())
    }

    /// `BlocklistGlue.requestScreeningRoleBound()` — post the system role dialog.
    pub(super) fn request_screening_role() -> Result<bool, String> {
        call_static_bool("requestScreeningRoleBound")
    }

    /// `BlocklistGlue.configure(filesDir)` — remember where rules are persisted.
    ///
    /// # Safety
    /// Standard JNI args; `dir` is valid for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_BlocklistGlue_configure(
        env: *mut jni::sys::JNIEnv,
        _this: jni::sys::jobject,
        dir: jstring,
    ) {
        if env.is_null() || dir.is_null() {
            return;
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
            return;
        };
        // Remember the VM so the status/role commands can call back into Kotlin.
        if let Ok(vm) = env.get_java_vm() {
            // Exactly-once: a redundant re-attach keeps the first one (REQ-A187 baseline).
            let _ = VM.set(vm);
        }
        // SAFETY: `dir` is a live local ref for the duration of this call.
        let jdir = unsafe { JString::from_raw(dir) };
        let Ok(path) = env.get_string(&jdir) else {
            return;
        };
        let dir: String = path.into();
        if !dir.is_empty() {
            shared().configure(file_in(Path::new(&dir)));
        }
    }

    /// `BlocklistGlue.filtersCalls()` → `true` when the call path can reject a
    /// call *at all* (a rule covers calls **or** the unknown-number switch is on),
    /// so the UI requests the system Call Screening role exactly when it matters.
    ///
    /// Not `has_call_rules`: the withheld-number path
    /// (`BlocklistGlue_shouldBlockCall` with an empty address) rejects under the
    /// switch alone, and gating the role request on rules left that rejection
    /// un-enforceable.
    #[no_mangle]
    pub extern "system" fn Java_com_amos_ai_glue_BlocklistGlue_filtersCalls(
        _env: *mut jni::sys::JNIEnv,
        _this: jni::sys::jobject,
    ) -> jboolean {
        if shared().filters_calls() {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    /// `BlocklistGlue.shouldBlockCall(number)` → `true` when the call must be
    /// rejected. Unknown/withheld numbers follow the user's switch.
    ///
    /// # Safety
    /// Standard JNI args; `address` is valid for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_BlocklistGlue_shouldBlockCall(
        env: *mut jni::sys::JNIEnv,
        _this: jni::sys::jobject,
        address: jstring,
    ) -> jboolean {
        if env.is_null() || address.is_null() {
            // A missing argument is "unknown number": honour the switch, but
            // never crash the telephony path.
            return if shared().blocks_call("") {
                JNI_TRUE
            } else {
                JNI_FALSE
            };
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
            return JNI_FALSE;
        };
        // SAFETY: `address` is a live local ref for the duration of this call.
        let jaddr = unsafe { JString::from_raw(address) };
        let addr: String = env.get_string(&jaddr).map(|s| s.into()).unwrap_or_default();
        if shared().blocks_call(&addr) {
            tracing::info!(target: "amos::blocklist", "incoming call rejected by blocklist");
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_sms::SmsThread;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("amos-blocklist-{tag}-{}", now_ms()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn add_check_remove_round_trip_through_the_state() {
        let s = BlocklistState::empty(); // no file → memory only
        let r = s.add("1069", "prefix", "sms", "bulk", 1).unwrap();
        assert_eq!(r.pattern, "1069");
        assert!(s.blocks_sms("106942053200156"));
        assert!(!s.blocks_call("106942053200156")); // sms-only rule
        assert!(s.remove(&r.id));
        assert!(!s.blocks_sms("106942053200156"));
        assert!(!s.remove(&r.id));
    }

    #[test]
    fn bad_kind_or_channel_is_rejected() {
        let s = BlocklistState::empty();
        assert!(s.add("10086", "fuzzy", "sms", "", 1).is_err());
        assert!(s.add("10086", "exact", "pigeon", "", 1).is_err());
        assert!(s.add("abc", "exact", "sms", "", 1).is_err());
        assert!(s.snapshot().rules.is_empty());
    }

    #[test]
    fn rules_survive_a_restart_via_the_json_file() {
        let dir = tmp_dir("persist");
        let path = file_in(&dir);
        let first = BlocklistState::empty();
        first.configure(path.clone());
        first
            .add("+8613800138000", "exact", "both", "spam", 5)
            .unwrap();
        first.set_block_unknown(true);

        // A fresh state loading the same file sees the same rules.
        let second = BlocklistState::empty();
        second.configure(path.clone());
        assert!(second.blocks_call("+86 138-0013-8000"));
        assert!(second.blocks_sms("8613800138000"));
        assert!(second.snapshot().block_unknown);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_starts_empty_instead_of_crashing() {
        let dir = tmp_dir("corrupt");
        let path = file_in(&dir);
        std::fs::write(&path, "{ this is not json").unwrap();
        let s = BlocklistState::empty();
        s.configure(path.clone());
        assert!(s.snapshot().rules.is_empty());
        // …and the state stays usable (adding works after a bad load).
        s.add("10086", "exact", "both", "", 1).unwrap();
        assert!(s.blocks_sms("10086"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The read-failure arm (audit PH-P2-04): a *missing* rules file is the ordinary
    /// first-run case and is silent, but any **other** read failure is a real fault and
    /// must be reported — the module's rule is that the failure is never hidden from the
    /// operator. The former `if let Ok(text) = …` folded both into silence.
    ///
    /// The first assertion is also the positive control that the capturing subscriber is
    /// wired: if the capture were dead, the "missing file is silent" half would pass
    /// vacuously.
    #[test]
    fn an_unreadable_rules_file_is_reported_but_a_missing_one_is_not() {
        /// A `MakeWriter` sink that keeps every formatted line in memory.
        struct Captured(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Captured {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let make = |sink: Arc<Mutex<Vec<u8>>>| {
            tracing_subscriber::fmt()
                .with_writer(move || Captured(sink.clone()))
                .with_max_level(tracing::Level::WARN)
                .finish()
        };

        let dir = tmp_dir("readfail");
        // Put the rules path *inside a regular file* so the read fails with ENOTDIR — a
        // genuine I/O fault, not "no rules yet" (any kind but NotFound takes the report
        // arm). `File::create` on the intermediate is idempotent, so unlike a
        // `create_dir_all` this setup cannot lose a race with a same-tagged tmp dir.
        let not_a_dir = dir.join("a-plain-file");
        std::fs::File::create(&not_a_dir).unwrap();
        let path = not_a_dir.join(BLOCKLIST_FILE);

        let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        tracing::subscriber::with_default(make(buf.clone()), || {
            let s = BlocklistState::empty();
            s.configure(path.clone());
            assert!(s.snapshot().rules.is_empty(), "starts empty, as before");
        });
        let logged = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        assert!(
            logged.contains("blocklist file could not be read"),
            "an unreadable file must be reported, not folded into 'no rules yet'; got: {logged:?}"
        );

        // Same capture, a genuinely missing file: silent (the ordinary first-run case).
        buf.lock().unwrap().clear();
        let missing = dir.join("never-written").join(BLOCKLIST_FILE);
        tracing::subscriber::with_default(make(buf.clone()), || {
            let s = BlocklistState::empty();
            s.configure(missing.clone());
            assert!(s.snapshot().rules.is_empty());
        });
        let silent = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        assert!(
            silent.is_empty(),
            "a missing file is first-run, not a fault — it must not be reported; got: {silent:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file with one hand-edited bad rule must still enforce its good rules:
    /// the bad row is skipped and reported, not fatal to the whole list.
    #[test]
    fn one_bad_rule_keeps_the_other_rules_active() {
        let dir = tmp_dir("onebad");
        let path = file_in(&dir);
        let payload = r#"{"version":1,"rules":[
            {"pattern":"abc","digits":"abc","id":"x","kind":"exact","channel":"both","created_ms":1},
            {"pattern":"+8613800138000","digits":"8613800138000","id":"ok","kind":"exact","channel":"both","created_ms":2}
        ]}"#;
        std::fs::write(&path, payload).unwrap();
        let s = BlocklistState::empty();
        s.configure(path.clone());
        assert!(
            s.blocks_call("+8613800138000"),
            "the valid rule must survive a hand-edited bad row (REQ-A1771)"
        );
        assert_eq!(s.snapshot().rules.len(), 1, "only the bad rule is dropped");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// …and a row that cannot even be *read* (a missing field, not a bad pattern)
    /// must likewise be one skipped row, not a dead file (REQ-A1777). This is the
    /// reachable path: `BlocklistGlue.configure(filesDir)` ships a file the user
    /// can edit, and before this the whole-file `from_str::<Persisted>` ran the
    /// per-row parse first — a single row missing `created_ms` made `configure`
    /// take the `Err` arm and log "unreadable — starting empty", dropping the
    /// good rules too. The deleted `digits` here is the benign edit the loader
    /// already re-derives from `pattern`.
    #[test]
    fn a_structurally_unreadable_row_keeps_the_other_rules_active() {
        let dir = tmp_dir("unreadable");
        let path = file_in(&dir);
        let payload = r#"{"version":1,"rules":[
            {"pattern":"+8613800138000","kind":"exact","channel":"both","created_ms":1},
            {"pattern":"1069","kind":"prefix","channel":"sms","created_ms":2}
        ]}"#;
        std::fs::write(&path, payload).unwrap();
        let s = BlocklistState::empty();
        s.configure(path.clone());
        assert!(
            s.blocks_call("+8613800138000"),
            "a row missing its derived fields must not empty the file (REQ-A1777)"
        );
        assert!(
            s.blocks_sms("10690001"),
            "and every good row still enforces"
        );
        assert_eq!(s.snapshot().rules.len(), 2, "both rows load");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Loading rules must recover a poisoned lock, as every sibling site does.
    /// The load used a bare `if let Ok(..) = inner.write()`, so a poisoned lock
    /// silently skipped the assignment while the `info!` below still reported the
    /// rules as loaded — the blocklist ran empty (filtering nothing) behind a log
    /// that said it had loaded, one arm below the read-failure fix (PH-P2-04) and
    /// against the module's "the failure is never hidden" rule.
    #[test]
    fn a_poisoned_lock_still_loads_the_rules_instead_of_going_silently_empty() {
        let dir = tmp_dir("poison");
        let path = file_in(&dir);
        std::fs::write(
            &path,
            r#"{"version":1,"rules":[{"pattern":"10086","kind":"exact","channel":"both","created_ms":1}]}"#,
        )
        .unwrap();

        let s = BlocklistState::empty();
        // Poison the inner lock: a thread panics while holding the write guard.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = s.inner.write().expect("fresh lock");
            panic!("poison the blocklist lock");
        }));

        s.configure(path.clone());
        assert!(
            s.blocks_sms("10086"),
            "the rule must load even though the lock was poisoned"
        );
        assert_eq!(s.snapshot().rules.len(), 1, "the loaded rule is present");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sms_threads_from_blocked_senders_are_filtered_out() {
        let s = BlocklistState::empty();
        s.add("1069", "prefix", "sms", "bulk", 1).unwrap();
        let threads = vec![
            SmsThread::new("1", "106942053200156", "", "spam", 2, 0),
            SmsThread::new("2", "10010", "", "real", 1, 0),
        ];
        let (kept, hidden) = filter_threads(threads, &s);
        assert_eq!(hidden, 1);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].address, "10010");
    }

    #[test]
    fn a_call_only_rule_does_not_hide_sms() {
        let s = BlocklistState::empty();
        s.add("10086", "exact", "call", "", 1).unwrap();
        let threads = vec![SmsThread::new("1", "10086", "", "hi", 1, 0)];
        let (kept, hidden) = filter_threads(threads, &s);
        assert_eq!((kept.len(), hidden), (1, 0));
        assert!(s.blocks_call("10086"));
    }

    #[test]
    fn status_reports_the_channels_the_rules_cover() {
        let s = BlocklistState::empty();
        let empty = status_of(&s);
        assert!(!empty.has_call_rules);
        assert!(!empty.has_sms_rules);
        // An SMS-only rule must not claim call coverage (the banner keys off
        // `filters_calls`, which an SMS-only rule must not arm — see the twin test).
        s.add("1069", "prefix", "sms", "", 1).unwrap();
        let sms = status_of(&s);
        assert!(sms.has_sms_rules);
        assert!(!sms.has_call_rules);
        s.add("10086", "exact", "call", "", 2).unwrap();
        let both = status_of(&s);
        assert!(both.has_call_rules && both.has_sms_rules);
    }

    #[test]
    fn sms_filtering_is_armed_by_a_rule_or_the_unknown_switch() {
        // The badge guard must be "can this hide a thread?", not "are there SMS
        // rules?" — an unparseable sender id is `Unknown` (hidden), not allowed.
        let s = BlocklistState::empty();
        assert!(!s.filters_sms()); // nothing can hide a thread
        s.set_block_unknown(true);
        assert!(!s.has_sms_rules()); // still no rule…
        assert!(s.filters_sms()); // …yet the switch alone hides unparsable senders
        s.set_block_unknown(false);
        s.add("1069", "prefix", "sms", "", 1).unwrap();
        assert!(s.filters_sms());
        let calls = BlocklistState::empty();
        calls.add("10086", "exact", "call", "", 1).unwrap();
        assert!(
            !calls.filters_sms(),
            "a call-only rule must not arm SMS filtering"
        );
    }

    #[test]
    fn call_filtering_is_armed_by_a_rule_or_the_unknown_switch() {
        // The twin of `sms_filtering_is_armed_by_a_rule_or_the_unknown_switch`, and
        // the predicate the enforcement banner and the Kotlin role request must gate
        // on (`filters_calls`). `check(addr, Channel::Call)` blocks an
        // unparseable/withheld address under the switch alone — `shouldBlockCall("")`
        // folds to `blocks_call("")` — so "can the call path reject anything?" is not
        // "are there call rules?".
        let s = BlocklistState::empty();
        assert!(!s.filters_calls()); // nothing can reject a call
        s.set_block_unknown(true);
        assert!(!s.has_call_rules()); // still no rule…
        assert!(
            s.blocks_call(""),
            "the switch alone rejects a withheld caller"
        );
        assert!(s.filters_calls()); // …yet a call can be rejected
                                    // The wire field the UI keys the banner off mirrors the predicate.
        assert!(status_of(&s).filters_calls);
        assert!(!status_of(&s).has_call_rules);
        s.set_block_unknown(false);
        s.add("1069", "prefix", "sms", "", 1).unwrap();
        assert!(
            !s.filters_calls(),
            "an SMS-only rule must not arm call rejection"
        );
        s.add("10086", "exact", "call", "", 2).unwrap();
        assert!(s.filters_calls());
    }

    /// On the host there is no Android Call Screening role; the status must say
    /// so honestly (rather than reporting `held: false` as if a grant could help),
    /// and requesting must be an explicit error, never a silent no-op.
    #[cfg(not(feature = "android"))]
    #[test]
    fn host_status_is_honest_about_the_missing_call_screening_role() {
        let s = BlocklistState::empty();
        let st = status_of(&s);
        assert!(!st.role_supported);
        assert!(!st.role_held);
        assert!(!st.role_requestable);
        assert!(request_screening_role().is_err());
    }

    #[test]
    fn the_persistence_file_is_the_one_path_we_always_configure() {
        // Guards the dataDir/filesDir split: `file_in` is the single place both
        // the Rust setup and the Kotlin `configure` upcall resolve the store.
        let p = file_in(Path::new("/data/user/0/com.amos.ai/files"));
        assert_eq!(
            p,
            Path::new("/data/user/0/com.amos.ai/files/blocklist.json")
        );
    }

    /// The native library is loaded by the Tauri runtime when an Activity boots —
    /// but the system can cold-start this process **with no Activity at all**, either
    /// to screen one incoming call (`AmosCallScreeningService.onScreenCall`) or to
    /// deliver one `SMS_RECEIVED` (the manifest `SmsReceiver`). In that process every
    /// JNI declaration on the glue object is unbound, and the fail-open catches
    /// wrapped around those calls (`BlocklistGlue.mustRejectCall`, `SmsGlue`'s
    /// `onSmsReceived`) fold `UnsatisfiedLinkError` into "allow the call" / "drop the
    /// refresh" — silently. So each object reachable on that path must load the
    /// library itself, in an `init` block the first touch of the object triggers.
    ///
    /// The rule is stated **once** and enumerated over every such entry point
    /// (`REQ-A1569 / F-TEL-036`): a cold-start glue that forgets the load fails here,
    /// not on a device whose blocklist is silently inert.
    #[test]
    fn every_cold_start_reachable_glue_loads_the_native_library_in_its_init_block() {
        const ENTRY_POINTS: &[(&str, &str)] = &[
            (
                "call screening (AmosCallScreeningService.onScreenCall → BlocklistGlue)",
                include_str!("../android-glue/com/amos/ai/glue/BlocklistGlue.kt"),
            ),
            (
                "SMS delivery (SmsReceiver.onReceive → SmsGlue)",
                include_str!("../android-glue/com/amos/ai/glue/SmsGlue.kt"),
            ),
        ];
        for (via, src) in ENTRY_POINTS {
            let code = strip_kotlin_comments(src);
            let body = init_block(&code).unwrap_or_else(|| {
                panic!(
                    "{via}: the glue object must carry an `init` block that loads the native \
                     library — nothing else runs before the first JNI call in a screen-only process"
                )
            });
            assert!(
                body.contains(r#"System.loadLibrary("amos_tauri_lib")"#),
                "{via}: the `init` block must call System.loadLibrary(\"amos_tauri_lib\"); without \
                 it a cold-started process leaves every JNI declaration unbound and the fail-open \
                 catch hides it. init body: {body}"
            );
        }
    }

    /// Source pin (red-first for P1-B3 / REQ-A1817): a call AmOS **rejects** must
    /// leave no entry in the platform call log.
    ///
    /// `AmosCallScreeningService.onScreenCall` builds **one** `CallResponse` for both
    /// outcomes. `setSkipCallLog` used to be the literal `false` while its three
    /// siblings (`setDisallowCall` / `setRejectCall` / `setSkipNotification`) all
    /// followed `reject` — so a blocked call, which the comment says is "never shown",
    /// still landed in the platform's call log, contradicting the SMS side (a blocked
    /// sender's thread is hidden from the list). The flag must follow the verdict like
    /// its siblings. Comments are stripped first, so the prose that names the flag
    /// cannot satisfy a check meant for code.
    #[test]
    fn a_rejected_call_is_not_written_to_the_platform_call_log() {
        const KOTLIN: &str =
            include_str!("../android-glue/com/amos/ai/glue/AmosCallScreeningService.kt");
        let code = strip_kotlin_comments(KOTLIN);
        assert!(
            code.contains("setSkipCallLog(reject)"),
            "skipCallLog must follow the verdict — the literal `false` keeps a rejected \
             call in the platform call log (P1-B3):\n{code}"
        );
        assert!(
            !code.contains("setSkipCallLog(false)"),
            "the literal `false` is the pre-fix shape (a rejected call stays in the log)"
        );
        // Positive control: the other three verdict-bearing flags must also follow
        // `reject`, so a truncated response (or "reject nothing") fails here rather
        // than satisfying the pin above by accident.
        for flag in [
            "setDisallowCall(reject)",
            "setRejectCall(reject)",
            "setSkipNotification(reject)",
        ] {
            assert!(code.contains(flag), "response is missing `{flag}`:\n{code}");
        }
        // …and the verdict itself must still come from the Rust blocklist, so the pin
        // cannot be satisfied by hard-coding `reject` to a constant.
        assert!(
            code.contains("BlocklistGlue.mustRejectCall("),
            "the verdict must come from the Rust blocklist:\n{code}"
        );
    }

    /// Comments are stripped before the pins look at the source, so a prose sentence
    /// mentioning the library cannot satisfy a check meant for code. A `//` inside a
    /// string literal is not a comment; that is what makes this a character machine
    /// rather than a `find("//")`. Fifth copy of this helper in the repo
    /// (`incall.rs`, `rotation.rs`, `jni_glue.rs`, `amos-telephony/src/number.rs`);
    /// there is no `tests/common`, and the `amos-tauri` copies cannot share one
    /// without making this module's tests depend on another module's test-only items.
    fn strip_kotlin_comments(src: &str) -> String {
        let chars: Vec<char> = src.chars().collect();
        let mut out = String::with_capacity(src.len());
        let mut i = 0usize;
        let mut block_depth = 0usize;
        while i < chars.len() {
            let c = chars[i];
            if block_depth > 0 {
                if c == '/' && chars.get(i + 1) == Some(&'*') {
                    block_depth += 1;
                    i += 2;
                } else if c == '*' && chars.get(i + 1) == Some(&'/') {
                    block_depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'/') {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                block_depth = 1;
                i += 2;
                continue;
            }
            if c == '"' {
                out.push(c);
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        out.push(chars[i]);
                        i += 1;
                    }
                    out.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            out.push(c);
            i += 1;
        }
        out
    }

    /// The body (`{`…`}`) of the first `init { … }` block in the comment-stripped
    /// [src], braces balanced. `None` when there is no `init` block.
    fn init_block(src: &str) -> Option<&str> {
        let open = src.find("init {")? + "init ".len();
        let mut depth = 0usize;
        for (i, c) in src.char_indices() {
            if i < open {
                continue;
            }
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&src[open..=i]);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// The role triple's folding rule (REQ-A800 / F-DEV-099).
    ///
    /// `BlocklistStatusOut::role_held` is documented as "AmOS currently holds
    /// ROLE_CALL_SCREENING, i.e. rejection is live", and `PhoneApp.svelte` renders
    /// `role_held == false` as the sentence 「AmOS 未获系统「来电筛选」权限——来电不会被拒接」
    /// — a statement about the device. Every route by which the answer can be
    /// *missing* therefore has to land on `role_requestable == false`, the branch
    /// that prints 「…原生桥未就绪」 instead. `host_status_is_honest_about_the_missing_
    /// call_screening_role` already pins this rule for the desktop half; these pin the
    /// half where the glue exists but cannot answer.
    mod role_status {
        use super::*;

        /// The reachable case: `screeningRoleSupported()` is a bare `SDK_INT >= 29`
        /// check, so it succeeds even when `bind` never ran — while
        /// `screeningRoleHeldBound()` returns `appContext ?: return false`'s `false`.
        /// That pair used to be folded to `(true, false, true)`, i.e. "the role is not
        /// granted, you may ask" — offered with a grant button that
        /// `requestScreeningRoleBound()` answers `false` to without doing anything.
        #[test]
        fn a_not_bound_glue_is_not_reported_as_a_missing_role() {
            let (supported, held, requestable) = role_status_from(Ok(true), Ok(false), Ok(false));
            assert!(supported, "the platform still supports the role");
            assert!(
                !requestable,
                "a not-bound glue cannot deliver a request, so the UI must not offer one"
            );
            assert!(
                !held,
                "held is false for want of an answer, not because the role is off"
            );
        }

        /// The one case where the amber 「未获权限 + 授予」 banner is the right thing.
        #[test]
        fn a_genuinely_unheld_role_on_a_bound_glue_is_still_askable() {
            let (supported, held, requestable) = role_status_from(Ok(true), Ok(false), Ok(true));
            assert!(supported, "the platform supports the role");
            assert!(!held, "the role is genuinely not held");
            assert!(
                requestable,
                "and the glue is bound, so a request can be delivered"
            );
        }

        /// The JNI call did not answer. The wire type can only carry a bool, so `held`
        /// lands on `false` — but `requestable` is what the caller gates on, and a
        /// bound glue can still deliver the request.
        #[test]
        fn a_failed_held_probe_does_not_invent_a_device_fact() {
            let (supported, held, requestable) = role_status_from(
                Ok(true),
                Err("blocklist attach failed".to_string()),
                Ok(true),
            );
            assert!(supported && !held);
            assert!(
                requestable,
                "the glue is bound, so a request can still be delivered"
            );
        }

        /// Desktop / JVM never captured — the arm that was already correct.
        #[test]
        fn no_glue_at_all_is_unsupported_not_unheld() {
            let triple = role_status_from(Err("no vm".to_string()), Ok(false), Ok(false));
            assert_eq!(triple, (false, false, false));
        }

        #[test]
        fn a_bound_glue_that_holds_the_role_is_live() {
            let triple = role_status_from(Ok(true), Ok(true), Ok(true));
            assert_eq!(triple, (true, true, true));
        }

        /// `bound` is a local check in Kotlin, but "no VM captured" reaches Rust as an
        /// `Err`. It must land on "cannot deliver", never on "askable".
        #[test]
        fn an_unreadable_bound_flag_is_treated_as_not_bound() {
            let (_, _, requestable) =
                role_status_from(Ok(true), Ok(false), Err("no vm".to_string()));
            assert!(!requestable);
        }
    }
}
