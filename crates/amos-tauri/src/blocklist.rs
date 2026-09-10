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
}
