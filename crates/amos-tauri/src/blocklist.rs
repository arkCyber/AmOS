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
        if let Ok(text) = std::fs::read_to_string(&path) {
            match Blocklist::from_json(&text, DEFAULT_CAP) {
                Ok(loaded) => {
                    if let Ok(mut list) = self.inner.write() {
                        *list = loaded;
                    }
                    tracing::info!(target: "amos::blocklist", path = %path.display(), "blocklist loaded");
                }
                Err(e) => tracing::warn!(
                    target: "amos::blocklist",
                    path = %path.display(),
                    kind = e.kind(),
                    "blocklist file unreadable — starting empty"
                ),
            }
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

    /// Write the rules atomically (temp file + rename). Best-effort: failures are
    /// logged, never fatal (a full disk must not break call screening).
    pub fn persist(&self) {
        let Some(path) = self.path() else {
            return; // no file configured (tests / host before setup)
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
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
    /// At least one rule covers SMS.
    pub has_sms_rules: bool,
    /// The platform supports the Call Screening role (Android 10 / API 29+).
    pub role_supported: bool,
    /// AmOS currently holds `ROLE_CALL_SCREENING`, i.e. rejection is live.
    pub role_held: bool,
    /// The native glue is attached, so a role request can actually be delivered
    /// (host/desktop or a not-yet-bound glue cannot).
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
        has_sms_rules: state.has_sms_rules(),
        role_supported,
        role_held,
        role_requestable,
    }
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
#[cfg(not(feature = "android"))]
fn role_probe() -> (bool, bool, bool) {
    (false, false, false)
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
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("blocklist attach failed: {e}"))?;
        let class = env
            .find_class("com/amos/ai/glue/BlocklistGlue")
            .map_err(|e| e.to_string())?;
        let value = env
            .call_static_method(&class, method, "()Z", &[])
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

    /// `(role_supported, role_held, requestable)`; `requestable` is false when the
    /// glue is not bound, so the UI can tell "not granted yet" from "cannot ask".
    pub(super) fn role_probe() -> (bool, bool, bool) {
        match role_supported() {
            Ok(supported) => (supported, role_held().unwrap_or(false), true),
            Err(_) => (false, false, false),
        }
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

    /// `BlocklistGlue.hasCallRules()` → `true` when any rule covers calls, so the
    /// UI can request the system Call Screening role only when it matters.
    #[no_mangle]
    pub extern "system" fn Java_com_amos_ai_glue_BlocklistGlue_hasCallRules(
        _env: *mut jni::sys::JNIEnv,
        _this: jni::sys::jobject,
    ) -> jboolean {
        if shared().has_call_rules() {
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
        // An SMS-only rule must not claim call coverage (the UI keys the
        // "grant the role" prompt off `has_call_rules`).
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
}
