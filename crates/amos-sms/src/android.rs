//! Real Android SMS backend — feature-gated `android`.
//!
//! On the Android System UI APK, SMS lives in the system provider database
//! (`content://sms`) and sending goes through `SmsManager` — both reachable only
//! from a process holding the app `Context` (the System UI Tauri APK, never the
//! headless daemon). Rust cannot touch `ContentResolver`, so the Kotlin
//! `SmsGlue` owns it and answers a **String ↔ String JSON** contract over JNI:
//!
//! * `snapshot()` → `{"threads":[…]}` (parsed by [`crate::wire::parse_snapshot`]).
//! * `messages(threadId)` → `{"thread_id","messages":[…]}`.
//! * `send(address, text)` → `{"ok":true}` or `{"error":"…"}`.
//!
//! Runtime needs a real Android VM + the glue instance; on host this only has to
//! **compile** (`cargo check -p amos-sms --features android`). Nothing is faked:
//! a missing glue / thrown call surfaces as an honest [`SmsError`].

use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};

use crate::error::SmsError;
use crate::provider::SmsProvider;
use crate::spec::{SmsMessage, SmsThread};
use crate::wire::{parse_messages, parse_snapshot};

/// Map a JNI error into an [`SmsError::Failed`].
fn jerr(e: jni::errors::Error) -> SmsError {
    SmsError::Failed(format!("android sms glue error: {e}"))
}

/// `Send + Sync` handle to the Kotlin `SmsGlue` instance.
struct AndroidGlue(GlobalRef);

// SAFETY: a JNI global ref is VM-global and outlives the creating env; every
// method re-attaches the calling thread before touching it.
unsafe impl Send for AndroidGlue {}
// SAFETY: access always happens on an attached thread.
unsafe impl Sync for AndroidGlue {}

/// The real Android backend behind the [`SmsProvider`] seam.
pub struct AndroidSmsProvider {
    vm: JavaVM,
    glue: AndroidGlue,
}

impl AndroidSmsProvider {
    /// Attach to the Kotlin `SmsGlue` instance. `env` is only used to promote the
    /// glue object into a global ref.
    pub fn new(vm: JavaVM, env: &JNIEnv<'_>, glue: JObject<'_>) -> Result<Self, SmsError> {
        Ok(Self {
            vm,
            glue: AndroidGlue(env.new_global_ref(glue).map_err(jerr)?),
        })
    }

    fn attach(&self) -> Result<JNIEnv<'_>, SmsError> {
        self.vm.attach_current_thread_permanently().map_err(jerr)
    }

    /// Call a `()Ljava/lang/String;` glue method and read the returned string.
    fn call0(&self, method: &str) -> Result<String, SmsError> {
        let mut env = self.attach()?;
        let glue = self.glue.0.as_obj();
        let out = env
            .call_method(glue, method, "()Ljava/lang/String;", &[])
            .map_err(jerr)?;
        let jstr = JString::from(out.l().map_err(jerr)?);
        let s: String = env.get_string(&jstr).map_err(jerr)?.into();
        Ok(s)
    }

    /// Call a `(Ljava/lang/String;)Ljava/lang/String;` glue method.
    fn call1(&self, method: &str, arg: &str) -> Result<String, SmsError> {
        let mut env = self.attach()?;
        let glue = self.glue.0.as_obj();
        let jarg: JObject = env.new_string(arg).map_err(jerr)?.into();
        let out = env
            .call_method(
                glue,
                method,
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&jarg)],
            )
            .map_err(jerr)?;
        let jstr = JString::from(out.l().map_err(jerr)?);
        let s: String = env.get_string(&jstr).map_err(jerr)?.into();
        Ok(s)
    }

    /// Call a `(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;` method.
    fn call2(&self, method: &str, a: &str, b: &str) -> Result<String, SmsError> {
        let mut env = self.attach()?;
        let glue = self.glue.0.as_obj();
        let ja: JObject = env.new_string(a).map_err(jerr)?.into();
        let jb: JObject = env.new_string(b).map_err(jerr)?.into();
        let out = env
            .call_method(
                glue,
                method,
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&ja), JValue::Object(&jb)],
            )
            .map_err(jerr)?;
        let jstr = JString::from(out.l().map_err(jerr)?);
        let s: String = env.get_string(&jstr).map_err(jerr)?.into();
        Ok(s)
    }
}

impl SmsProvider for AndroidSmsProvider {
    fn snapshot(&self) -> Result<Vec<SmsThread>, SmsError> {
        parse_snapshot(&self.call0("snapshot")?)
    }

    fn messages(&self, thread_id: &str) -> Result<Vec<SmsMessage>, SmsError> {
        parse_messages(&self.call1("messages", thread_id)?)
    }

    fn send(&self, address: &str, text: &str) -> Result<(), SmsError> {
        let payload = self.call2("send", address, text)?;
        let v: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|e| SmsError::Invalid(format!("unparseable send reply: {e}")))?;
        if let Some(err) = v.get("error").and_then(serde_json::Value::as_str) {
            return Err(SmsError::Failed(err.to_string()));
        }
        if v.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err(SmsError::Invalid("send reply without ok/error".into()))
        }
    }
}
