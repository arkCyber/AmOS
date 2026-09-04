//! Real Android backend for dialing — feature-gated `android` (see `Cargo.toml`).
//!
//! On the no-UI Android base (`docs/no-ui-android.md`) calls must be placed from a
//! process holding the app `Context` + **`ROLE_DIALER`** — i.e. the **System UI
//! (Tauri core) APK**, not the headless `amos-ai` daemon (see `docs/telephony.md`
//! §2 host-process note & §12 #1). This module is that host: it takes a `JavaVM`
//! plus a global ref to the app `Context` and dials via the well-trodden
//! `Intent(ACTION_CALL, tel:…)` path — the documented fallback in `docs/telephony.md
//! §5`.
//!
//! Status — **honest on-device skeleton**, mirroring `amos-radio`'s `android.rs`:
//! * `dial`/`emergency_call` place a real call intent and return a provider call id.
//!   On-device this should migrate to `TelecomManager#placeCall` (the modern
//!   `ROLE_DIALER` path); `ACTION_CALL` is the conservative fallback that also works
//!   for emergency numbers.
//! * `answer`/`end`/recording and live `status` are **not** wired yet: real in-call
//!   control requires an `InCallService`/`TelephonyCallback` bridge and a call-state
//!   broadcast, which is device-validated P3 work (they return an explicit
//!   `Provider` error rather than pretending).
//! * `subscribe` returns a live receiver wired to an in-call event registry (empty
//!   until the device callback lands).
//!
//! Runtime requires a real Android VM (`jni::JavaVM`) + a `GlobalRef` to the app
//! `Context`. Not runnable on the desktop host; `cargo check --features android`
//! keeps it compiling.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};
use tokio::sync::mpsc;

use crate::error::{Result, TelephonyError};
use crate::number::Number;
use crate::provider::{EmergencyTelephonyProvider, ProviderEvent, TelephonyProvider};
use crate::session::{Call, CallId};

/// `android.content.Intent.ACTION_CALL` (dial fallback; also reaches emergency codes).
const ACTION_CALL: &str = "android.intent.action.CALL";
/// `Intent.FLAG_ACTIVITY_NEW_TASK` (no Activity here to host the call dialog).
const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
const TEL_SCHEME: &str = "tel:";

/// `Send + Sync` handle to the Java app `Context` used to fire dial intents.
///
/// A JNI **global** reference is process-wide and safe to use from any thread as long
/// as each use attaches that thread to the VM first — same pattern as `amos-radio`.
struct AndroidContext(GlobalRef);

// SAFETY: A JNI global ref outlives the creating env and is VM-global; every method
// re-attaches the calling thread before touching it. Dropping is handled by GlobalRef.
unsafe impl Send for AndroidContext {}
// SAFETY: access always happens on an attached thread.
unsafe impl Sync for AndroidContext {}

/// Feature-gated error mapper (no unwraps in production code).
fn jerr(e: jni::errors::Error) -> TelephonyError {
    TelephonyError::Provider(e.to_string())
}

/// Shared subscriber registry so `subscribe` returns a live receiver; device
/// callbacks (TelephonyCallback / Telecom InCallService) will later push into it.
struct EventBus {
    subs: Mutex<Vec<mpsc::UnboundedSender<ProviderEvent>>>,
}

impl EventBus {
    fn new() -> Self {
        Self {
            subs: Mutex::new(Vec::new()),
        }
    }

    fn subscribe(&self) -> mpsc::UnboundedReceiver<ProviderEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut g) = self.subs.lock() {
            g.push(tx);
        }
        rx
    }
}

/// Fire an `ACTION_CALL` intent for `number` from the app `Context`.
///
/// TODO(on-device, P3): migrate to `TelecomManager#placeCall` so the System UI, as
/// `ROLE_DIALER`, drives the call through Telecom (better in-call control + explicit
/// emergency marking) rather than a broadcast intent.
fn place(env: &mut JNIEnv<'_>, ctx: &JObject<'_>, number: &Number) -> Result<()> {
    let action = env.new_string(ACTION_CALL).map_err(jerr)?;
    let intent = env
        .new_object(
            "android/content/Intent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&action)],
        )
        .map_err(jerr)?;
    let tel = env
        .new_string(format!("{TEL_SCHEME}{}", number.digits()))
        .map_err(jerr)?;
    let uri = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&tel)],
        )
        .and_then(|v| v.l())
        .map_err(jerr)?;
    env.call_method(
        &intent,
        "setData",
        "(Landroid/net/Uri;)Landroid/content/Intent;",
        &[JValue::Object(&uri)],
    )
    .map_err(jerr)?;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
    )
    .map_err(jerr)?;
    env.call_method(
        ctx,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )
    .map_err(jerr)?;
    Ok(())
}

/// Ordinary (SIM/telecom) call backend. Lives in the System UI process.
pub struct AndroidTelephonyProvider {
    vm: JavaVM,
    context: AndroidContext,
    events: Arc<EventBus>,
    seq: AtomicU64,
}

impl AndroidTelephonyProvider {
    /// Construct from a `JavaVM` + a global ref to the app `Context`. `env` is only
    /// used to create the global ref.
    pub fn new(vm: JavaVM, env: &JNIEnv<'_>, context: JObject<'_>) -> Result<Self> {
        Ok(Self {
            vm,
            context: AndroidContext(env.new_global_ref(context).map_err(jerr)?),
            events: Arc::new(EventBus::new()),
            seq: AtomicU64::new(0),
        })
    }

    fn attach(&self) -> Result<JNIEnv<'_>> {
        self.vm.attach_current_thread_permanently().map_err(jerr)
    }

    fn next_id(&self) -> CallId {
        CallId::new(format!(
            "tel_{:016x}",
            self.seq.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn dial_impl(&self, number: &Number) -> Result<CallId> {
        let mut env = self.attach()?;
        let ctx: &JObject<'_> = self.context.0.as_obj();
        place(&mut env, ctx, number)?;
        Ok(self.next_id())
    }
}

#[async_trait]
impl TelephonyProvider for AndroidTelephonyProvider {
    async fn dial(&self, number: &Number) -> Result<CallId> {
        self.dial_impl(number)
    }

    async fn answer(&self, _id: &CallId) -> Result<()> {
        Err(TelephonyError::Provider(
            "on-device answer requires an InCallService bridge (P3, device-validated)".to_string(),
        ))
    }

    async fn end(&self, _id: &CallId) -> Result<()> {
        Err(TelephonyError::Provider(
            "on-device end requires an InCallService bridge (P3, device-validated)".to_string(),
        ))
    }

    async fn start_recording(&self, _id: &CallId) -> Result<()> {
        Err(TelephonyError::Provider(
            "on-device recording requires a call-audio tap (audio pipeline, not yet wired)"
                .to_string(),
        ))
    }

    async fn stop_recording(&self, _id: &CallId) -> Result<()> {
        Err(TelephonyError::Provider(
            "on-device recording requires a call-audio tap (audio pipeline, not yet wired)"
                .to_string(),
        ))
    }

    async fn status(&self) -> Result<Vec<Call>> {
        // No live-call tracking until a TelephonyCallback / Telecom InCallService feed
        // is bridged; report empty rather than guessing.
        Ok(Vec::new())
    }

    fn subscribe(&self) -> mpsc::UnboundedReceiver<ProviderEvent> {
        self.events.subscribe()
    }
}

/// Privileged emergency hard path (110/112…). A **separate** implementation so the
/// ordinary path can never be swapped into emergency handling by mistake.
pub struct AndroidEmergencyTelephonyProvider {
    inner: AndroidTelephonyProvider,
}

impl AndroidEmergencyTelephonyProvider {
    pub fn new(vm: JavaVM, env: &JNIEnv<'_>, context: JObject<'_>) -> Result<Self> {
        Ok(Self {
            inner: AndroidTelephonyProvider::new(vm, env, context)?,
        })
    }
}

#[async_trait]
impl EmergencyTelephonyProvider for AndroidEmergencyTelephonyProvider {
    async fn emergency_call(&self, number: Number) -> Result<CallId> {
        // Intent-dial the emergency code. The platform guarantees the network lets it
        // through (no SIM / locked / no-UI) — that guarantee is the framework's, not
        // ours (see docs/telephony.md §12 #2).
        self.inner.dial_impl(&number)
    }
}
