//! Real Android backend for dialing — feature-gated `android` (see `Cargo.toml`).
//!
//! On the no-UI Android base (`docs/no-ui-android.md`) calls must be placed from a
//! process holding the app `Context` + **`ROLE_DIALER`** — i.e. the **System UI
//! (Tauri core) APK**, not the headless `amos-ai` daemon (see `docs/telephony.md`
//! §2 host-process note & §12 #1). This module is that host: it takes a `JavaVM`
//! plus a global ref to the app `Context` and drives the call through
//! **`TelecomManager#placeCall`** — the privileged Binder transaction to the
//! framework's `ITelecomService` (which `TelecomManager` is a thin Java wrapper
//! over).
//!
//! # Why `placeCall`, not a hand-rolled `/dev/binder` client
//!
//! `TelecomManager#placeCall` **is** the Binder path to Telecom: its counterpart
//! `com.android.internal.telecom.ITelecomService` runs inside **`system_server`**.
//! A raw Rust `ioctl` on `/dev/binder` would only re-implement the exact
//! marshalling this one JNI call already does — and would gain **no** crash
//! immunity, because a dead `system_server` means a dead Telecom service either
//! way. The real "110/112 even with no SIM / locked / UI dead" guarantee comes from
//! the **modem / RIL** routing emergency numbers at the network layer, not from
//! which process talks to Telecom; a fully-wedged OS is OEM hardware (separate
//! power domain), out of scope for an app crate. `placeCall` is chosen over an
//! `ACTION_CALL` broadcast because it is the modern *`ROLE_DIALER`* entry point
//! that yields explicit in-call state and lets a future `InCallService` bridge
//! drive answer/end/recording through Telecom.
//!
//! # Status — **honest on-device skeleton** (mirrors `amos-radio`'s `android.rs`)
//!
//! * `dial`/`emergency_call` place a real call and return a provider call id.
//! * Every dial is routed through [`crate::route`] against an [`EmergencyMap`]: the
//!   ordinary provider **refuses** a recognized emergency code and the emergency
//!   provider **refuses** an ordinary number — the same hard separation the
//!   domain/`Mock` enforces — so 110/112 can never fall onto the SIM path.
//! * `answer`/`end`/recording and live `status` are **not** wired yet: real in-call
//!   control requires an `InCallService`/`TelephonyCallback` bridge + a call-state
//!   broadcast (device-validated P3; they return an explicit `Provider` error).
//! * `subscribe` returns a live receiver wired to an in-call event registry (empty
//!   until the device callback lands).
//!
//! Runtime requires a real Android VM (`jni::JavaVM`) + a `GlobalRef` to the app
//! `Context`, and the caller package must be the default dialer (or hold
//! `CALL_PRIVILEGED` / a platform signature) or Telecom rejects the transaction.
//! Not runnable on the desktop host; `cargo check --features android` keeps it
//! compiling, and the pure routing/enforcement logic is unit-tested headlessly in
//! `crate::route`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};
use tokio::sync::mpsc;

use crate::error::{Result, TelephonyError};
use crate::number::{EmergencyMap, Number};
use crate::provider::{EmergencyTelephonyProvider, ProviderEvent, TelephonyProvider};
use crate::route::{guard_emergency, guard_regular};
use crate::session::{Call, CallId};

/// `Context.getSystemService` key for the Telecom manager.
const TELECOM_SERVICE: &str = "telecom";
const TEL_SCHEME: &str = "tel:";

/// `Send + Sync` handle to the Java app `Context` used to reach system services.
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

/// `context.getSystemService(Context.TELECOM_SERVICE)` → the `TelecomManager`.
///
/// The returned object is used by runtime (dynamic) dispatch, so no Java cast is
/// needed: `TelecomManager#placeCall` resolves on the instance's actual class.
fn telecom_manager<'e>(env: &mut JNIEnv<'e>, ctx: &JObject<'e>) -> Result<JObject<'e>> {
    let name = env.new_string(TELECOM_SERVICE).map_err(jerr)?;
    let svc = env
        .call_method(
            ctx,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&name)],
        )
        .and_then(|v| v.l())
        .map_err(jerr)?;
    if svc.is_null() {
        return Err(TelephonyError::Provider(
            "TelecomManager unavailable: no telephony service on this device".into(),
        ));
    }
    Ok(svc)
}

/// `Uri.parse("tel:<digits>")` — the dial address both `placeCall` paths use.
fn dial_uri<'e>(env: &mut JNIEnv<'e>, number: &Number) -> Result<JObject<'e>> {
    let tel = env
        .new_string(format!("{TEL_SCHEME}{}", number.digits()))
        .map_err(jerr)?;
    env.call_static_method(
        "android/net/Uri",
        "parse",
        "(Ljava/lang/String;)Landroid/net/Uri;",
        &[JValue::Object(&tel)],
    )
    .and_then(|v| v.l())
    .map_err(jerr)
}

/// Ordinary (SIM/telecom) call backend. Lives in the System UI process.
pub struct AndroidTelephonyProvider {
    vm: JavaVM,
    context: AndroidContext,
    /// Jurisdiction emergency set — held so this backend enforces the same hard
    /// emergency/regular separation as the domain/`Mock` (see `crate::route`).
    emergency: EmergencyMap,
    events: Arc<EventBus>,
    seq: AtomicU64,
}

impl AndroidTelephonyProvider {
    /// Construct from a `JavaVM` + a global ref to the app `Context`, plus the
    /// [`EmergencyMap`] this backend routes emergency numbers against. `env` is only
    /// used to create the global ref.
    pub fn new(
        vm: JavaVM,
        env: &JNIEnv<'_>,
        context: JObject<'_>,
        emergency: EmergencyMap,
    ) -> Result<Self> {
        Ok(Self {
            vm,
            context: AndroidContext(env.new_global_ref(context).map_err(jerr)?),
            emergency,
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
        // `ctx` and `env` are both borrowed from `&self` here (radio's proven
        // pattern), so `telecom_manager` can tie them to one lifetime.
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let tm = telecom_manager(&mut env, ctx)?;
        let uri = dial_uri(&mut env, number)?;
        // placeCall(Uri, Bundle) needs an (empty is fine) extras bundle since API 23.
        let bundle = env
            .new_object("android/os/Bundle", "()V", &[])
            .map_err(jerr)?;
        env.call_method(
            &tm,
            "placeCall",
            "(Landroid/net/Uri;Landroid/os/Bundle;)V",
            &[JValue::Object(&uri), JValue::Object(&bundle)],
        )
        .map_err(|e| {
            TelephonyError::Provider(format!(
                "TelecomManager#placeCall rejected the call ({e}); \
                 is this process the default dialer (ROLE_DIALER)?"
            ))
        })?;
        Ok(self.next_id())
    }
}

#[async_trait]
impl TelephonyProvider for AndroidTelephonyProvider {
    async fn dial(&self, number: &Number) -> Result<CallId> {
        // Hard separation: a recognized emergency number can never ride the ordinary
        // SIM/telecom path (mirrors the domain/`Mock`, enforced before any Binder
        // transaction). A caller must use the emergency provider for 110/112.
        guard_regular(&self.emergency, number)?;
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
    pub fn new(
        vm: JavaVM,
        env: &JNIEnv<'_>,
        context: JObject<'_>,
        emergency: EmergencyMap,
    ) -> Result<Self> {
        Ok(Self {
            inner: AndroidTelephonyProvider::new(vm, env, context, emergency)?,
        })
    }
}

#[async_trait]
impl EmergencyTelephonyProvider for AndroidEmergencyTelephonyProvider {
    async fn emergency_call(&self, number: Number) -> Result<CallId> {
        // Only a recognized emergency code may use the privileged path — an ordinary
        // number is refused rather than silently placed where ordinary safeguards
        // (rate-limiting, recording policy) are bypassed.
        guard_emergency(&self.inner.emergency, &number)?;
        self.inner.dial_impl(&number)
    }
}
