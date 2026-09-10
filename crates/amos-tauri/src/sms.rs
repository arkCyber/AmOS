//! SMS bridge — exposes the real-SMS domain (`amos-sms`) to the WebView.
//!
//! Same shape as the radio/flashlight bridges: the System UI's Messages screen
//! talks to a `SmsProvider` through these commands. On the desktop/CI host the
//! provider is `MockSms::new()` — an **empty, honest** inbox (no real SMS on a
//! host, never faked). On a real device the provider is intended to be backed by
//! the Android `SmsGlue` (content://sms + SmsManager); that wiring is device
//! bring-up (see docs/sms.md). Commands return a serializable mirror because the
//! domain types are transport-agnostic.

use amos_sms::{MockSms, SmsMessage, SmsProvider, SmsThread};
use serde::Serialize;
use tauri::State;

/// Bridge state managed by Tauri.
pub struct SmsBridge {
    provider: Box<dyn SmsProvider>,
}

impl SmsBridge {
    /// Desktop/CI boot: an empty (honest) mock inbox — no real SMS is claimed.
    pub fn boot() -> Self {
        Self {
            provider: Box::new(MockSms::new()),
        }
    }

    /// Build over any provider (used by device bring-up / tests).
    pub fn with_provider(provider: Box<dyn SmsProvider>) -> Self {
        Self { provider }
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

/// The provider in effect: the installed on-device backend when present
/// (feature `android`), else the host mock held by the bridge.
fn active(state: &SmsBridge) -> &dyn SmsProvider {
    #[cfg(feature = "android")]
    {
        if let Some(p) = device::DEVICE.get() {
            return p.as_ref();
        }
    }
    state.provider.as_ref()
}

/// Read the inbox snapshot (threads, newest first). Empty when no real SMS
/// provider is available; never fabricated.
#[tauri::command]
pub fn sms_snapshot(state: State<'_, SmsBridge>) -> Result<Vec<SmsThreadOut>, String> {
    snapshot_of(active(&state))
}

/// Read one thread's messages (chronological).
#[tauri::command]
pub fn sms_messages(
    state: State<'_, SmsBridge>,
    thread_id: String,
) -> Result<Vec<SmsMessageOut>, String> {
    active(&state)
        .messages(&thread_id)
        .map(|v| v.iter().map(SmsMessageOut::from).collect())
        .map_err(|e| e.to_string())
}

/// Send a text (real `SmsManager` on device; the mock never claims delivery).
/// Returns `"sent"` on success so the caller can tell success from the `null`
/// that an unavailable/errored bridge yields.
#[tauri::command]
pub fn sms_send(
    state: State<'_, SmsBridge>,
    address: String,
    text: String,
) -> Result<String, String> {
    active(&state)
        .send(&address, &text)
        .map(|()| "sent".to_string())
        .map_err(|e| e.to_string())
}

/// Mapping helper kept pure so it is unit-testable without a Tauri runtime.
fn snapshot_of(p: &dyn SmsProvider) -> Result<Vec<SmsThreadOut>, String> {
    p.snapshot()
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

    #[test]
    fn host_boot_is_an_empty_honest_inbox() {
        let b = SmsBridge::boot();
        assert!(snapshot_of(b.provider.as_ref()).unwrap().is_empty());
    }

    #[test]
    fn maps_seeded_threads_and_messages() {
        let b = SmsBridge::with_provider(Box::new(MockSms::seeded()));
        let ts = snapshot_of(b.provider.as_ref()).unwrap();
        assert_eq!(ts.len(), 2);
        assert_eq!(ts[0].address, "13800138000");
        assert_eq!(ts[0].unread, 1);
        let msgs = b.provider.messages("1").unwrap();
        let out: Vec<SmsMessageOut> = msgs.iter().map(SmsMessageOut::from).collect();
        assert_eq!(out.len(), 2);
        assert!(!out[1].read);
    }

    #[test]
    fn send_rejects_blank_via_bridge_provider() {
        let b = SmsBridge::with_provider(Box::new(MockSms::seeded()));
        assert!(b.provider.send("10086", "  ").is_err());
        assert!(b.provider.send("10086", "OK").is_ok());
    }
}
