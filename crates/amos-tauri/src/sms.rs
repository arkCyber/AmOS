//! SMS bridge — exposes the real-SMS domain (`amos-sms`) to the WebView.
//!
//! Same shape as the radio/flashlight bridges, with three production concerns
//! made explicit:
//!
//! * **No UI-thread blocking.** Reading SMS means `ContentResolver`/JNI work on
//!   device. Tauri runs *synchronous* commands on the main thread, so every
//!   command here is `async` and the provider call is moved to the blocking pool
//!   (`tauri::async_runtime::spawn_blocking`) with a hard [`SMS_TIMEOUT`] — a
//!   wedged platform call surfaces as an honest error instead of a frozen UI.
//! * **Honest state.** `sms_status` reports which backend is in effect so the UI
//!   can tell the device inbox apart from the host mock (which is *not* an empty
//!   inbox); permission denial is an error, never an empty list.
//! * **Audited sends.** `sms_send` validates at the boundary and logs the
//!   outcome with a **masked** address (never the body — privacy is preserved).
//!
//! On the desktop/CI host the provider is `MockSms::new()` — an empty, honest
//! inbox (no real SMS on a host, never faked). On a real device the Kotlin
//! `SmsGlue` installs `AndroidSmsProvider` (see `docs/sms.md`).

use std::sync::Arc;
use std::time::Duration;

use amos_sms::{
    normalize_address, segment_count, validate_text, MockSms, SmsMessage, SmsProvider, SmsThread,
};
use serde::Serialize;
use tauri::State;

/// Hard cap on one provider call. The blocking task itself cannot be cancelled,
/// but the caller is released with an honest timeout error instead of hanging.
const SMS_TIMEOUT: Duration = Duration::from_secs(8);

/// Bridge state managed by Tauri.
pub struct SmsBridge {
    provider: Arc<dyn SmsProvider>,
}

impl SmsBridge {
    /// Desktop/CI boot: an empty (honest) mock inbox — no real SMS is claimed.
    pub fn boot() -> Self {
        Self {
            provider: Arc::new(MockSms::new()),
        }
    }

    /// Build over any provider (used by device bring-up / tests).
    pub fn with_provider(provider: Box<dyn SmsProvider>) -> Self {
        Self {
            provider: Arc::from(provider),
        }
    }
}

impl Default for SmsBridge {
    fn default() -> Self {
        Self::boot()
    }
}

/// Serializable mirror of an SMS thread.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsThreadOut {
    pub id: String,
    pub address: String,
    pub display_name: String,
    pub last_text: String,
    pub last_ts_ms: i64,
    pub unread: u32,
}

impl From<&SmsThread> for SmsThreadOut {
    fn from(t: &SmsThread) -> Self {
        Self {
            id: t.id.clone(),
            address: t.address.clone(),
            display_name: t.display_name.clone(),
            last_text: t.last_text.clone(),
            last_ts_ms: t.last_ts_ms,
            unread: t.unread,
        }
    }
}

/// Serializable mirror of one SMS message.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsMessageOut {
    pub thread_id: String,
    pub id: String,
    pub from_me: bool,
    pub text: String,
    pub ts_ms: i64,
    pub read: bool,
}

impl From<&SmsMessage> for SmsMessageOut {
    fn from(m: &SmsMessage) -> Self {
        Self {
            thread_id: m.thread_id.clone(),
            id: m.id.clone(),
            from_me: m.from_me,
            text: m.text.clone(),
            ts_ms: m.ts_ms,
            read: m.read,
        }
    }
}

/// Serializable folder counts (tabs/badges).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsFolderCountsOut {
    pub inbox: u32,
    pub sent: u32,
    pub draft: u32,
}

impl From<&amos_sms::SmsFolderCounts> for SmsFolderCountsOut {
    fn from(c: &amos_sms::SmsFolderCounts) -> Self {
        Self {
            inbox: c.inbox,
            sent: c.sent,
            draft: c.draft,
        }
    }
}

/// Serializable backend status so the UI can distinguish the device inbox from
/// the host mock without guessing (and without doing any I/O).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsStatusOut {
    /// Backend id: `"mock"` (host/offline) or `"android-sms"` (device).
    pub provider: String,
    /// `true` only for a real device backend.
    pub device: bool,
}

/// The provider in effect: the installed on-device backend when present
/// (feature `android`), else the host mock held by the bridge.
fn active_arc(state: &SmsBridge) -> Arc<dyn SmsProvider> {
    #[cfg(feature = "android")]
    {
        if let Some(p) = device::DEVICE.get() {
            return Arc::clone(p);
        }
    }
    Arc::clone(&state.provider)
}

/// Run one provider call on the blocking pool under a hard timeout.
///
/// Provider reads/sends are blocking (ContentResolver/JNI); running them on the
/// async runtime would stall other commands, and running them on the main thread
/// (which is where Tauri executes *sync* commands) would freeze the UI.
async fn blocking<T, F>(f: F) -> Result<T, amos_sms::SmsError>
where
    F: FnOnce() -> Result<T, amos_sms::SmsError> + Send + 'static,
    T: Send + 'static,
{
    blocking_with(SMS_TIMEOUT, f).await
}

/// [`blocking`] with an explicit timeout (so tests can use a short one).
async fn blocking_with<T, F>(timeout: Duration, f: F) -> Result<T, amos_sms::SmsError>
where
    F: FnOnce() -> Result<T, amos_sms::SmsError> + Send + 'static,
    T: Send + 'static,
{
    use amos_sms::SmsError;
    match tokio::time::timeout(timeout, tauri::async_runtime::spawn_blocking(f)).await {
        Ok(Ok(result)) => result,
        Ok(Err(join_err)) => Err(SmsError::Failed(format!(
            "SMS worker did not complete: {join_err}"
        ))),
        Err(_) => Err(SmsError::Failed(format!(
            "SMS provider timed out after {}s",
            timeout.as_secs()
        ))),
    }
}

/// Mask an address for audit logs: keep at most the last 4 digits.
fn mask_address(address: &str) -> String {
    let digits: Vec<char> = address.chars().filter(char::is_ascii_digit).collect();
    let tail: String = digits[digits.len().saturating_sub(4)..].iter().collect();
    format!("***{tail}")
}

/// Validate a send before dispatch (fast, no I/O); returns the normalized
/// address and segment count for the audit trail.
fn checked_send(address: &str, text: &str) -> Result<(String, usize), String> {
    let addr = normalize_address(address).map_err(|e| e.to_string())?;
    validate_text(text).map_err(|e| e.to_string())?;
    Ok((addr, segment_count(text)))
}

/// Which backend backs SMS right now (no I/O — safe to call at any time).
#[tauri::command]
pub fn sms_status(state: State<'_, SmsBridge>) -> SmsStatusOut {
    status_of(active_arc(&state).as_ref())
}

/// Read one folder's threads (newest first), with **blocked senders removed**.
/// `Err` (permission denied / unavailable / unknown folder) is honest and must
/// never be shown as "no messages"; an `Ok` empty list means that folder is
/// empty (or fully filtered — [`filter_threads`] reports the hidden count).
#[tauri::command]
pub async fn sms_snapshot(
    state: State<'_, SmsBridge>,
    folder: String,
) -> Result<Vec<SmsThreadOut>, String> {
    let folder = amos_sms::SmsFolder::from_wire(&folder).map_err(|e| e.to_string())?;
    let provider = active_arc(&state);
    let threads = blocking(move || provider.snapshot(folder))
        .await
        .map_err(|e| e.to_string())?;
    let (kept, hidden) = crate::blocklist::filter_threads(threads, &crate::blocklist::shared());
    if hidden > 0 {
        tracing::info!(target: "amos::sms", hidden, "blocked senders filtered from the list");
    }
    Ok(kept.iter().map(SmsThreadOut::from).collect())
}

/// Distinct thread counts per folder (inbox / sent / draft).
#[tauri::command]
pub async fn sms_counts(state: State<'_, SmsBridge>) -> Result<SmsFolderCountsOut, String> {
    let provider = active_arc(&state);
    blocking(move || provider.counts())
        .await
        .map(|c| SmsFolderCountsOut::from(&c))
        .map_err(|e| e.to_string())
}

/// Read one thread's messages (chronological). An empty/absent `folder` means
/// "the whole conversation"; otherwise only that folder's rows.
///
/// `address` is the thread's remote party: when it is blocked for SMS the read
/// is refused with an honest error (a blocked sender's content must not appear
/// even if a caller asks for the thread id directly).
#[tauri::command]
pub async fn sms_messages(
    state: State<'_, SmsBridge>,
    thread_id: String,
    folder: Option<String>,
    address: Option<String>,
) -> Result<Vec<SmsMessageOut>, String> {
    if thread_id.trim().is_empty() {
        return Err("invalid SMS payload: blank thread id".to_string());
    }
    if let Some(addr) = address.as_deref().filter(|a| !a.trim().is_empty()) {
        if let Some(reason) = crate::blocklist::shared().check(addr, amos_blocklist::Channel::Sms) {
            return Err(format!("blocked by rule: {reason:?}"));
        }
    }
    let folder = match folder.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(name) => Some(amos_sms::SmsFolder::from_wire(name).map_err(|e| e.to_string())?),
    };
    let provider = active_arc(&state);
    blocking(move || provider.messages(&thread_id, folder))
        .await
        .map(|v| v.iter().map(SmsMessageOut::from).collect())
        .map_err(|e| e.to_string())
}

/// Send a text (real `SmsManager` on device; the mock never claims delivery).
/// Returns `"sent"` on success so the caller can tell success from the `null`
/// that an unavailable/errored bridge yields.
#[tauri::command]
pub async fn sms_send(
    state: State<'_, SmsBridge>,
    address: String,
    text: String,
) -> Result<String, String> {
    let (addr, segments) = checked_send(&address, &text)?;
    let masked = mask_address(&addr);
    let provider = active_arc(&state);
    let send_addr = addr.clone();
    match blocking(move || provider.send(&send_addr, &text)).await {
        Ok(()) => {
            tracing::info!(
                target: "amos::sms",
                to = %masked,
                segments,
                "SMS send accepted by the provider"
            );
            Ok("sent".to_string())
        }
        Err(e) => {
            tracing::warn!(
                target: "amos::sms",
                to = %masked,
                kind = e.kind(),
                "SMS send failed"
            );
            Err(e.to_string())
        }
    }
}

/// Mapping helpers kept pure so they are unit-testable without a Tauri runtime.
fn status_of(p: &dyn SmsProvider) -> SmsStatusOut {
    let name = p.name();
    SmsStatusOut {
        provider: name.to_string(),
        device: name != amos_sms::MOCK_PROVIDER,
    }
}

/// Event emitted when the device reports a new SMS (the inbox changed). The
/// frontend refreshes on it instead of polling; the payload carries the sender
/// only when the platform provided it (empty string otherwise — never invented).
pub const SMS_RECEIVED_EVENT: &str = "sms-received";

/// Payload of [`SMS_RECEIVED_EVENT`].
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsIncomingOut {
    /// Sender address when known, else `""` (we never guess it).
    pub address: String,
}

/// Build the incoming payload (pure: trims, never fabricates an address).
#[cfg(any(feature = "android", test))]
fn incoming_payload(address: &str) -> SmsIncomingOut {
    SmsIncomingOut {
        address: address.trim().to_string(),
    }
}

/// On-device push: the Kotlin `SmsGlue` registers a `SMS_RECEIVED` receiver and
/// upcalls here, so received messages reach the UI live instead of on a manual
/// refresh. Compile-checked under `--features android`; exercised at device time.
#[cfg(feature = "android")]
mod events {
    use super::*;
    use jni::objects::JString;
    use jni::sys::{jobject, jstring};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};

    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// Install the emitter (called once from `lib.rs::setup`).
    pub fn install(app: AppHandle) {
        let _ = APP.set(app);
    }

    /// `SmsGlue.onIncoming(address)` — JNI `(JNIEnv*, jobject, String)`.
    ///
    /// # Safety
    /// `env`/`this`/`address` are the standard JNI args of the instance-method
    /// call on the main thread; `address` is valid for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_SmsGlue_onIncoming(
        env: *mut jni::sys::JNIEnv,
        _this: jobject,
        address: jstring,
    ) {
        let Some(app) = APP.get() else {
            return; // no UI attached → nothing to notify (honest no-op)
        };
        if env.is_null() || address.is_null() {
            return;
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
            return;
        };
        // SAFETY: `address` is a live local ref for the duration of this call.
        let jstr = unsafe { JString::from_raw(address) };
        let addr: String = env.get_string(&jstr).map(|s| s.into()).unwrap_or_default();
        let payload = incoming_payload(&addr);
        // A blocked sender must not raise an AmOS notification or refresh the
        // Messages screen. (The message row itself is owned by the platform's
        // default SMS app; we cannot delete it — see docs/sms.md.)
        if !payload.address.is_empty() && crate::blocklist::shared().blocks_sms(&payload.address) {
            tracing::info!(
                target: "amos::sms",
                from = %mask_address(&payload.address),
                "incoming SMS from a blocked sender ignored"
            );
            return;
        }
        tracing::info!(
            target: "amos::sms",
            from = %if payload.address.is_empty() { "<unknown>".to_string() } else { mask_address(&payload.address) },
            "incoming SMS signalled by the device"
        );
        let _ = app.emit(SMS_RECEIVED_EVENT, payload);
    }
}

#[cfg(feature = "android")]
pub use events::install as install_events;

/// Test-only mapping helper (the commands map inline through [`blocking`]).
#[cfg(test)]
fn snapshot_of(
    p: &dyn SmsProvider,
    folder: amos_sms::SmsFolder,
) -> Result<Vec<SmsThreadOut>, String> {
    p.snapshot(folder)
        .map(|v| v.iter().map(SmsThreadOut::from).collect())
        .map_err(|e| e.to_string())
}

/// On-device SMS attach (feature `android`): the Kotlin `SmsGlue` instance
/// (which owns the Context / ContentResolver) is handed to Rust over JNI,
/// wrapped in a real `amos_sms::AndroidSmsProvider`, and installed into a
/// process global the commands consult — mirroring the media/flashlight device
/// seam. Compile-checked under `--features android`; exercised at device time.
#[cfg(feature = "android")]
mod device {
    use super::*;
    use jni::objects::JObject;
    use jni::sys::jobject;
    use std::sync::{Arc, OnceLock};

    /// The real Android SMS provider, installed exactly-once at attach.
    pub(crate) static DEVICE: OnceLock<Arc<dyn SmsProvider>> = OnceLock::new();

    fn install(vm: jni::JavaVM, env: &jni::JNIEnv<'_>, glue: JObject<'_>) {
        use amos_sms::AndroidSmsProvider;
        if let Ok(p) = AndroidSmsProvider::new(vm, env, glue) {
            let _ = DEVICE.set(Arc::new(p)); // first attach wins (exactly-once)
        }
    }

    /// `SmsGlue.attach()` — JNI `(JNIEnv*, jobject)`; `this` is the Kotlin
    /// `SmsGlue` instance holding the app Context / ContentResolver.
    ///
    /// # Safety
    /// `env`/`this` are the standard JNI arguments of a native call on the main
    /// thread; `this` is valid for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_SmsGlue_attach(
        env: *mut jni::sys::JNIEnv,
        this: jobject,
    ) {
        if env.is_null() || this.is_null() {
            return; // nothing valid → honest no-op (mock stays active)
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
            return;
        };
        let Ok(vm) = env.get_java_vm() else {
            return;
        };
        // SAFETY: `this` is a live local ref for the duration of this call.
        let glue = unsafe { JObject::from_raw(this) };
        install(vm, &env, glue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_sms::SmsError;

    #[test]
    fn host_boot_is_an_empty_honest_store() {
        let b = SmsBridge::boot();
        for f in amos_sms::SmsFolder::ALL {
            assert!(b.provider.snapshot(f).unwrap().is_empty(), "{f:?}");
        }
        assert!(snapshot_of(b.provider.as_ref(), amos_sms::SmsFolder::Inbox)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn maps_seeded_threads_and_messages_per_folder() {
        let b = SmsBridge::with_provider(Box::new(MockSms::seeded()));
        let inbox = snapshot_of(b.provider.as_ref(), amos_sms::SmsFolder::Inbox).unwrap();
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox[0].address, "13800138000");
        assert_eq!(inbox[0].unread, 1);
        let sent = snapshot_of(b.provider.as_ref(), amos_sms::SmsFolder::Sent).unwrap();
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|t| t.unread == 0));
        let msgs = b
            .provider
            .messages("1", Some(amos_sms::SmsFolder::Inbox))
            .unwrap();
        let out: Vec<SmsMessageOut> = msgs.iter().map(SmsMessageOut::from).collect();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|m| !m.from_me));
        // Counts surface through the serializable mirror.
        let counts = SmsFolderCountsOut::from(&b.provider.counts().unwrap());
        assert_eq!(
            counts,
            SmsFolderCountsOut {
                inbox: 2,
                sent: 2,
                draft: 1
            }
        );
    }

    #[test]
    fn unknown_folder_is_rejected_before_any_provider_call() {
        assert!(amos_sms::SmsFolder::from_wire("outbox").is_err());
        assert!(amos_sms::SmsFolder::from_wire("").is_err());
        assert_eq!(
            amos_sms::SmsFolder::from_wire("sent").unwrap(),
            amos_sms::SmsFolder::Sent
        );
    }

    #[test]
    fn send_rejects_blank_via_bridge_provider() {
        let b = SmsBridge::with_provider(Box::new(MockSms::seeded()));
        assert!(b.provider.send("10086", "  ").is_err());
        assert!(b.provider.send("10086", "OK").is_ok());
    }

    #[test]
    fn status_distinguishes_mock_from_a_device_backend() {
        let mock = SmsBridge::boot();
        assert_eq!(
            status_of(mock.provider.as_ref()),
            SmsStatusOut {
                provider: "mock".into(),
                device: false
            }
        );
        // A provider with any other id is reported as a device backend.
        struct FakeDevice;
        impl SmsProvider for FakeDevice {
            fn name(&self) -> &'static str {
                "android-sms"
            }
            fn snapshot(&self, _f: amos_sms::SmsFolder) -> Result<Vec<SmsThread>, SmsError> {
                Ok(Vec::new())
            }
            fn messages(
                &self,
                _t: &str,
                _f: Option<amos_sms::SmsFolder>,
            ) -> Result<Vec<SmsMessage>, SmsError> {
                Ok(Vec::new())
            }
            fn counts(&self) -> Result<amos_sms::SmsFolderCounts, SmsError> {
                Ok(amos_sms::SmsFolderCounts::default())
            }
            fn send(&self, _a: &str, _t: &str) -> Result<(), SmsError> {
                Ok(())
            }
        }
        assert_eq!(
            status_of(&FakeDevice),
            SmsStatusOut {
                provider: "android-sms".into(),
                device: true
            }
        );
    }

    #[test]
    fn send_is_validated_before_dispatch() {
        // Normalized address + honest segment count for the audit trail.
        let (addr, segments) = checked_send(" +86 138-0013-8000 ", "hello").unwrap();
        assert_eq!(addr, "+8613800138000");
        assert_eq!(segments, 1);
        // Blank/oversized/malformed input never reaches the provider.
        assert!(checked_send("10086", "   ").is_err());
        assert!(checked_send("abc", "hi").is_err());
        assert!(
            checked_send("10086", &"a".repeat(amos_sms::validate::MAX_TEXT_CHARS + 1)).is_err()
        );
        // 200 GSM-7 chars → 2 segments.
        assert_eq!(checked_send("10086", &"a".repeat(200)).unwrap().1, 2);
    }

    #[test]
    fn audit_masks_the_address() {
        assert_eq!(mask_address("13800138000"), "***8000");
        assert_eq!(mask_address("+8613800138000"), "***8000");
        assert_eq!(mask_address("1008"), "***1008");
        assert_eq!(mask_address("12"), "***12"); // never panics on short input
    }

    #[test]
    fn incoming_event_payload_never_invents_an_address() {
        assert_eq!(SMS_RECEIVED_EVENT, "sms-received");
        assert_eq!(incoming_payload(" 10086 ").address, "10086");
        assert_eq!(incoming_payload("").address, ""); // unknown stays unknown
    }

    /// A provider that hangs must not keep the caller waiting forever.
    #[tokio::test]
    async fn a_hung_provider_times_out_instead_of_blocking_the_caller() {
        let err = blocking_with(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(500));
            Ok::<(), SmsError>(())
        })
        .await
        .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
    }

    #[tokio::test]
    async fn blocking_returns_the_provider_result() {
        let ok = blocking_with(Duration::from_secs(5), || Ok::<u32, SmsError>(7))
            .await
            .unwrap();
        assert_eq!(ok, 7);
        let err = blocking_with(Duration::from_secs(5), || {
            Err::<u32, SmsError>(SmsError::PermissionDenied("no READ_SMS".into()))
        })
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "permission");
    }
}
