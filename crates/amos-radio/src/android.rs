//! Real Android backend for the radios — **skeleton** (compile-gated `android`).
//!
//! On the no-UI Android base (`docs/no-ui-android.md`) Wi-Fi is owned by the
//! Android `WifiManager` (reachable via `Context#getSystemService("wifi")`) and
//! Bluetooth by `BluetoothManager` → `BluetoothAdapter`. Both are reachable only
//! from a process holding the app/Activity context — i.e. the **System UI APK**
//! (Tauri core), which is why this provider lives beside the System UI and not in
//! the headless daemon.
//!
//! This module is **deliberately a documented skeleton**, not yet the finished
//! on-device integration:
//! * It proves the build/plumbing (`android` feature + optional `jni` dep) and
//!   the real `Context` plumbing, and `cargo check --features android` keeps it
//!   compiling.
//! * Wi-Fi enable/state go through the (pre-API-29) `WifiManager#setWifiEnabled`
//!   / `isWifiEnabled`; Bluetooth through `BluetoothAdapter#enable/disable/
//!   isEnabled`. A device implementation should modernize Wi-Fi to the
//!   `ConnectivityManager` setWiFiEnabled path and gate Bluetooth behind the
//!   `BLUETOOTH_CONNECT` runtime permission.
//! * **A platform refusal is an error, never a silent success** (REQ-A184). These
//!   platform calls answer "did you accept this?" and their `false` is routine in
//!   the field (`setWifiEnabled` is restricted to system/device-owner callers from
//!   API 29; `enable`/`disable` can be blocked by user or device policy), so
//!   discarding the answer would leave the Airplane cascade half-applied with no
//!   rollback and nothing reported. `set_wifi`, `set_bluetooth` and `set_hotspot`
//!   all turn a refusal into [`RadioError::Provider`]; the two booleans used to be
//!   dropped, one of them under a doc comment that claimed it was returned.
//! * **Airplane** is modelled as an AmOS-authored bit (the manager turns the real
//!   Wi-Fi/Bluetooth off anyway); on device it should read/toggle the
//!   authoritative `Settings.Global.AIRPLANE_MODE_ON` via `ContentResolver`.
//! * **Hotspot** (the Wi-Fi access point / personal hotspot) drives the real
//!   tethering stack through the Kotlin `TetheringGlue` (in the System UI APK).
//!   `android.net.TetheringManager` is **public SDK only from API 36** (absent
//!   from the android-34/35 `android.jar`s) and `ConnectivityManager`'s tethering
//!   members are `@SystemApi` (absent from the public SDK entirely), so there is
//!   no public tethering call to write below 36 — the glue reports that honestly
//!   rather than pretending a fallback exists. The start/stop is **callback-based**
//!   (`TetheringRequest` + `StartTetheringCallback` / `StopTetheringCallback`),
//!   which raw JNI cannot express, so the glue owns the call and hands back a
//!   boolean: `setWifiTethering` = "did the platform accept it?" (a `false` —
//!   unavailable, no upstream, or a missing `TETHER_PRIVILEGED` — becomes a
//!   provider error, so the UI never claims an AP the platform refused),
//!   `isWifiTethering` = the live state the platform reports through
//!   `TetheringEventCallback`.
//!
//! Runtime requires a real Android VM (`jni::JavaVM`) plus a `GlobalRef` to the
//! app `Context`. Not runnable on the desktop host.

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};

use crate::bluetooth::{BtBond, BtPeer, BtScan, BtScanDevice, BOND_BONDED};
use crate::error::{RadioError, Result};
use crate::provider::{PlatformReason, RadioControl, RadioProvider, SystemSurface};
use crate::state::RadioSnapshot;

/// `with_local_frame` (used by the paired-device walk) requires the error type to be
/// constructible from a JNI error. Same mapping as [`jerr`], so a JNI failure reads
/// identically wherever it surfaces.
impl From<jni::errors::Error> for RadioError {
    fn from(e: jni::errors::Error) -> Self {
        RadioError::Provider(e.to_string())
    }
}

/// `Send + Sync` handle to the Java `android.content.Context` (Application /
/// Activity) used to reach system services.
///
/// A JNI **global** reference is process-wide and safe to use from any thread as
/// long as each use attaches that thread to the VM first — `jni`'s `GlobalRef`
/// isn't auto-`Sync`, so we wrap it and assert the invariant explicitly.
struct AndroidContext(GlobalRef);

// SAFETY: A JNI global ref outlives the creating env and is VM-global. Every
// method on the provider re-attaches the calling thread before touching it, so
// sharing the handle across threads (to satisfy `RadioProvider: Send + Sync`) is
// sound as long as users never pass the raw jobject into a different env without
// attaching. Dropping is handled by `GlobalRef` (detach-on-drop).
unsafe impl Send for AndroidContext {}
// SAFETY: as above — access always happens on an attached thread.
unsafe impl Sync for AndroidContext {}

/// Feature-gated error mapper (keeps call sites terse; no unwraps).
fn jerr(e: jni::errors::Error) -> RadioError {
    RadioError::Provider(e.to_string())
}

/// Run a JNI call and, when it fails, **clear the pending Java exception** before
/// returning the error.
///
/// Without this, a failed call poisons the whole thread: the JVM keeps the exception
/// pending, so the *next* JNI call on that thread aborts the process under CheckJNI
/// (`JNI DETECTED ERROR IN APPLICATION: JNI NewStringUTF called with pending
/// exception java.lang.ClassNotFoundException: Didn't find class
/// "com.amos.ai.glue.TetheringGlue" …` → SIGABRT). Observed on device in
/// `snapshot()`: the hotspot read failed on a tokio worker thread and the following
/// `system_service` killed the app (REQ-A185). Every JNI call in this module goes
/// through this macro, so a refusal stays a *returned error*.
///
/// A macro rather than a function because the JNI wrappers take `&mut self`: the call
/// is expanded into its own statement (releasing that borrow) and the exception check
/// then takes a shared borrow — which a function taking both as arguments cannot
/// express without a conflicting or short-lived borrow.
macro_rules! jni {
    ($env:expr, $call:expr $(,)?) => {{
        let r = $call;
        amos_jni::ClearAfterFailure::clear_after(&$env, r.is_err());
        r.map_err(jerr)
    }};
}

/// Read a `String`-returning no-arg method (`getName`, `getAddress`) off `obj`.
///
/// A platform `null` reads as an empty string — some devices genuinely report no
/// name — while a wrong-shaped answer becomes an error: `JNIEnv::get_string` verifies
/// the object really is a `java.lang.String`, so garbage is refused rather than
/// stringified.
fn read_java_string(env: &mut JNIEnv<'_>, obj: &JObject<'_>, method: &str) -> Result<String> {
    let raw = jni!(
        env,
        env.call_method(obj, method, "()Ljava/lang/String;", &[])
    )?
    .l()
    .map_err(jerr)?;
    if raw.is_null() {
        return Ok(String::new());
    }
    let text: JString = raw.into();
    let text: String = jni!(env, env.get_string(&text))?.into();
    Ok(text)
}

/// The Kotlin half of the hotspot (`android-glue/.../TetheringGlue.kt`). The
/// platform's tethering start/stop is callback-based and cannot be issued from
/// raw JNI, so the glue owns it and answers a plain boolean. Resolved through the
/// app's class loader **once, at attach time** ([`resolve_glue_class`]).
const TETHERING_CLASS: &str = "com.amos.ai.glue.TetheringGlue";

/// The Kotlin half of Bluetooth **discovery** (REQ-A200,
/// `android-glue/.../BluetoothGlue.kt`). A scan is callback-based (results arrive as
/// broadcasts), so the glue owns the `BroadcastReceiver` and answers a JSON state
/// string; resolved through the app's class loader at attach time, like the hotspot.
const BLUETOOTH_CLASS: &str = "com.amos.ai.glue.BluetoothGlue";

/// The Kotlin half of the **platform-capability** question (REQ-A202,
/// `android-glue/.../RadioGlue.kt`). It owns the API-level knowledge (which switches
/// the platform took away from apps) and the `Intent` that opens the surface which
/// still has them. Resolved through the app's class loader at attach time, like the
/// other glues; `None` when it is absent, in which case `control` falls back to
/// *attempting* the switch (the platform then reports its own refusal honestly).
const RADIO_CLASS: &str = "com.amos.ai.glue.RadioGlue";

/// Look up `context.getSystemService(name)` and hand back the service object.
fn system_service<'e>(env: &mut JNIEnv<'e>, ctx: &JObject<'e>, name: &str) -> Result<JObject<'e>> {
    let svc = jni!(env, env.new_string(name))?;
    let out = jni!(
        env,
        env.call_method(
            ctx,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&svc)],
        ),
    )?;
    jni!(env, out.l())
}

/// Resolve a glue class through the **app's** class loader (shared implementation in
/// `crates/amos-jni/src/lib.rs`; see REQ-A186).
///
/// `JNIEnv::find_class` uses the caller thread's loader: on a Java-created thread that
/// is the app loader, but on a tokio worker it is the bootstrap one, which knows
/// nothing about `com.amos.ai.glue.*` — the read then fails with
/// `ClassNotFoundException` (and, before the clearing helper existed, aborted the
/// process on the next JNI call). Resolving **once, at attach time** (a Java thread)
/// and keeping a global ref makes the hotspot path work from any thread.
fn resolve_glue_class(
    env: &mut JNIEnv<'_>,
    context: &JObject<'_>,
    name: &str,
) -> Option<GlobalRef> {
    amos_jni::resolve_class(env, context, name)
}

/// A real Android provider that plugs into [`crate::RadioManager`] in place of
/// the [`crate::MockRadioProvider`] on device.
pub struct AndroidRadioProvider {
    vm: JavaVM,
    context: AndroidContext,
    /// AmOS-authored airplane bit. Skeleton: on device read/toggle
    /// `Settings.Global.AIRPLANE_MODE_ON` via `ContentResolver`.
    airplane: AtomicBool,
    /// Mirror of the last Wi-Fi-tethering state we successfully requested. The
    /// **glue's live state is authoritative** (`isWifiTethering`, fed by the
    /// platform's `TetheringEventCallback`); this atomic is only the fallback for
    /// when the glue cannot be reached at all, and it is never a fabricated
    /// `true`.
    hotspot: AtomicBool,
    /// `com.amos.ai.glue.TetheringGlue`, resolved **at attach time** through the
    /// app's class loader (REQ-A185): on a tokio worker thread
    /// `JNIEnv::find_class` uses the bootstrap loader and cannot see the app's
    /// classes. `None` when the glue is absent — the hotspot then reports an
    /// honest error instead of taking the process down.
    tethering: Option<GlobalRef>,
    /// `com.amos.ai.glue.BluetoothGlue`, resolved the same way (REQ-A200). `None` when
    /// the glue is absent — a scan then reports an honest error rather than an empty
    /// result list.
    bluetooth: Option<GlobalRef>,
    /// `com.amos.ai.glue.RadioGlue` (REQ-A202): the platform's answer to "may an app
    /// switch this radio, and where can the user do it instead". `None` when the glue
    /// is absent — then a `set` is attempted as before and the platform's own refusal
    /// is what the caller sees.
    radio: Option<GlobalRef>,
}

impl AndroidRadioProvider {
    /// Construct from a `JavaVM` and a global ref to the app `Context`. `env` is
    /// only used to create the global ref (it must be the creating/attached env).
    pub fn new(
        vm: JavaVM,
        env: &mut JNIEnv<'_>,
        context: JObject<'_>,
        airplane_on: bool,
    ) -> Result<Self> {
        let context = AndroidContext(env.new_global_ref(context).map_err(jerr)?);
        // Resolve the hotspot glue now, while we are on a Java thread with the app's
        // class loader (see the field's doc). A missing class is not fatal.
        let tethering = env
            .with_local_frame(8, |env| -> jni::errors::Result<Option<GlobalRef>> {
                Ok(resolve_glue_class(env, context.0.as_obj(), TETHERING_CLASS))
            })
            .ok()
            .flatten();
        let bluetooth = env
            .with_local_frame(8, |env| -> jni::errors::Result<Option<GlobalRef>> {
                Ok(resolve_glue_class(env, context.0.as_obj(), BLUETOOTH_CLASS))
            })
            .ok()
            .flatten();
        let radio = env
            .with_local_frame(8, |env| -> jni::errors::Result<Option<GlobalRef>> {
                Ok(resolve_glue_class(env, context.0.as_obj(), RADIO_CLASS))
            })
            .ok()
            .flatten();
        Ok(Self {
            vm,
            context,
            airplane: AtomicBool::new(airplane_on),
            hotspot: AtomicBool::new(false),
            tethering,
            bluetooth,
            radio,
        })
    }

    /// Attach this thread to the VM (auto-detaches when the env drops). The shared
    /// helper clears any exception left pending by an earlier operation, so a refusal
    /// in one call cannot abort the process on the next one (REQ-A186).
    fn env(&self) -> Result<JNIEnv<'_>> {
        amos_jni::attached(&self.vm).map_err(jerr)
    }

    /// The glue's `managedSurface(key)` answer, raw (`"app_controlled"` or
    /// `"<reason>:<surface>"`).
    fn radio_managed_surface(&self, env: &mut JNIEnv<'_>, key: &str) -> Result<String> {
        let class = self.radio_glue()?;
        let class: &JClass<'_> = class.as_obj().into();
        let jkey = jni!(env, env.new_string(key))?;
        let raw = jni!(
            env,
            env.call_static_method(
                class,
                "managedSurface",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&jkey)],
            ),
        )?
        .l()
        .map_err(jerr)?;
        if raw.is_null() {
            return Err(RadioError::Provider(
                "the radio glue returned no capability answer".to_string(),
            ));
        }
        let text: JString = raw.into();
        let text: String = jni!(env, env.get_string(&text))?.into();
        Ok(text)
    }

    /// `RadioGlue.openSystemSurface(context, surface)` — did an Activity start?
    fn radio_open_surface(&self, env: &mut JNIEnv<'_>, surface: &str) -> Result<bool> {
        let class = self.radio_glue()?;
        let class: &JClass<'_> = class.as_obj().into();
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let jsurface = jni!(env, env.new_string(surface))?;
        jni!(
            env,
            env.call_static_method(
                class,
                "openSystemSurface",
                "(Landroid/content/Context;Ljava/lang/String;)Z",
                &[JValue::Object(ctx), JValue::Object(&jsurface)],
            ),
        )?
        .z()
        .map_err(jerr)
    }

    /// The resolved `RadioGlue` class, or an honest error when the build has none.
    fn radio_glue(&self) -> Result<&GlobalRef> {
        self.radio.as_ref().ok_or_else(|| {
            RadioError::Provider("RadioGlue not available in this build".to_string())
        })
    }

    /// Read the real Wi-Fi state via `WifiManager#isWifiEnabled`.
    fn wifi_enabled(&self, env: &mut JNIEnv<'_>) -> Result<bool> {
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = system_service(env, ctx, "wifi")?;
        jni!(env, env.call_method(&mgr, "isWifiEnabled", "()Z", &[]))?
            .z()
            .map_err(jerr)
    }

    /// `BluetoothManager#getAdapter`, shared by every Bluetooth call (REQ-A199).
    ///
    /// `Ok(None)` means the device has **no Bluetooth adapter**. That is deliberately
    /// not an error *here*, because the two directions differ:
    /// * the snapshot read reports the absence as "off" (a snapshot has two states),
    ///   and logs it so a tile stuck at off stays traceable, while
    /// * every write and every detail read refuses with an explicit error — a rename
    ///   or a paired-device list that silently did nothing would be the very defect
    ///   this module exists to prevent.
    fn bluetooth_adapter<'e>(&self, env: &mut JNIEnv<'e>) -> Result<Option<JObject<'e>>> {
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = system_service(env, ctx, "bluetooth")?;
        let adapter = jni!(
            env,
            env.call_method(
                &mgr,
                "getAdapter",
                "()Landroid/bluetooth/BluetoothAdapter;",
                &[],
            ),
        )?
        .l()
        .map_err(jerr)?;
        Ok(if adapter.is_null() {
            None
        } else {
            Some(adapter)
        })
    }

    /// Read the real Bluetooth state via `BluetoothAdapter#isEnabled`.
    ///
    /// A device with **no adapter** is reported as `false` — the snapshot has no
    /// third state, so "absent" and "off" share the bit. That is a *read* value, not
    /// a claim: the toggle goes through [`AndroidRadioProvider::bluetooth_set`],
    /// which refuses with an explicit "no Bluetooth adapter on this device" error
    /// instead of silently doing nothing. Logged so a UI stuck at "off" is traceable.
    fn bluetooth_enabled(&self, env: &mut JNIEnv<'_>) -> Result<bool> {
        let Some(adapter) = self.bluetooth_adapter(env)? else {
            tracing::debug!(
                target: "amos::radio",
                "no Bluetooth adapter on this device — reporting Bluetooth off"
            );
            return Ok(false);
        };
        jni!(env, env.call_method(&adapter, "isEnabled", "()Z", &[]))?
            .z()
            .map_err(jerr)
    }

    /// Ask `BluetoothAdapter#enable/disable` and hand back **the platform's own
    /// answer**: `true` = the adapter accepted the request, `false` = it refused
    /// (restricted by user or device policy). The caller turns `false` into a
    /// provider error.
    ///
    /// The doc here used to read "Returns the boolean it reported" while the body
    /// discarded it — a documented contract the code did not honour (REQ-A184).
    fn bluetooth_set(&self, env: &mut JNIEnv<'_>, on: bool) -> Result<bool> {
        let Some(adapter) = self.bluetooth_adapter(env)? else {
            return Err(RadioError::Provider(
                "no Bluetooth adapter on this device".to_string(),
            ));
        };
        let method = if on { "enable" } else { "disable" };
        jni!(env, env.call_method(&adapter, method, "()Z", &[]))?
            .z()
            .map_err(jerr)
    }

    /// `BluetoothAdapter#getName` — what the adapter really calls itself (REQ-A199).
    ///
    /// This is the value a screen may present as a **device fact**; the name kept in
    /// the durable store is only ever the offline preference, shown when nobody can
    /// ask the adapter (the offline Mock answers [`RadioError::Unsupported`]).
    fn bluetooth_name(&self, env: &mut JNIEnv<'_>) -> Result<String> {
        let Some(adapter) = self.bluetooth_adapter(env)? else {
            return Err(RadioError::Provider(
                "no Bluetooth adapter on this device".to_string(),
            ));
        };
        read_java_string(env, &adapter, "getName")
    }

    /// `BluetoothAdapter#setName(String)` — the request **and** the adapter's answer.
    ///
    /// `false` (a missing `BLUETOOTH_CONNECT`, or a user/device-policy restriction)
    /// becomes a provider error, the same contract as `enable`/`disable` and
    /// `setWifiEnabled` (REQ-A184).
    ///
    /// The returned name is read **back from the adapter** rather than echoed: the
    /// platform may truncate or normalize, and the caller mirrors this value into the
    /// store — echoing the request would put a claim in the UI that the adapter does
    /// not hold.
    fn bluetooth_name_set(&self, env: &mut JNIEnv<'_>, name: &str) -> Result<String> {
        let Some(adapter) = self.bluetooth_adapter(env)? else {
            return Err(RadioError::Provider(
                "no Bluetooth adapter on this device".to_string(),
            ));
        };
        let jname = jni!(env, env.new_string(name))?;
        let accepted = jni!(
            env,
            env.call_method(
                &adapter,
                "setName",
                "(Ljava/lang/String;)Z",
                &[JValue::Object(&jname)],
            ),
        )?
        .z()
        .map_err(jerr)?;
        if !accepted {
            return Err(RadioError::Provider(
                "the platform refused the Bluetooth name change (BluetoothAdapter#setName \
                 returned false: restricted by user or device policy)"
                    .to_string(),
            ));
        }
        self.bluetooth_name(env)
    }

    /// `BluetoothGlue` (the scan/pair glue), or an explicit error when this build has
    /// none — a scan must not answer "accepted, nothing found" without asking anyone.
    fn bluetooth_glue(&self) -> Result<&GlobalRef> {
        self.bluetooth.as_ref().ok_or_else(|| {
            RadioError::Provider("Bluetooth glue not available in this build".to_string())
        })
    }

    /// `BluetoothGlue.startDiscovery(context)` — did the platform accept the scan?
    fn bluetooth_discovery_start(&self, env: &mut JNIEnv<'_>) -> Result<bool> {
        let class = self.bluetooth_glue()?;
        let class: &JClass<'_> = class.as_obj().into();
        let ctx: &JObject<'_> = self.context.0.as_obj();
        jni!(
            env,
            env.call_static_method(
                class,
                "startDiscovery",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(ctx)],
            ),
        )?
        .z()
        .map_err(jerr)
    }

    /// `BluetoothGlue.stopDiscovery(context)` — cancel a running scan.
    fn bluetooth_discovery_stop(&self, env: &mut JNIEnv<'_>) -> Result<bool> {
        let class = self.bluetooth_glue()?;
        let class: &JClass<'_> = class.as_obj().into();
        let ctx: &JObject<'_> = self.context.0.as_obj();
        jni!(
            env,
            env.call_static_method(
                class,
                "stopDiscovery",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(ctx)],
            ),
        )?
        .z()
        .map_err(jerr)
    }

    /// `BluetoothGlue.bond(context, address)` — was the pairing request accepted?
    fn bluetooth_bond(&self, env: &mut JNIEnv<'_>, address: &str) -> Result<bool> {
        let class = self.bluetooth_glue()?;
        let class: &JClass<'_> = class.as_obj().into();
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let jaddress = jni!(env, env.new_string(address))?;
        jni!(
            env,
            env.call_static_method(
                class,
                "bond",
                "(Landroid/content/Context;Ljava/lang/String;)Z",
                &[JValue::Object(ctx), JValue::Object(&jaddress)],
            ),
        )?
        .z()
        .map_err(jerr)
    }

    /// `BluetoothGlue.scanState(context)` — the glue's JSON state, parsed (and
    /// **validated**) into [`BtScan`].
    fn bluetooth_scan(&self, env: &mut JNIEnv<'_>) -> Result<BtScan> {
        let class = self.bluetooth_glue()?;
        let class: &JClass<'_> = class.as_obj().into();
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let raw = jni!(
            env,
            env.call_static_method(
                class,
                "scanState",
                "(Landroid/content/Context;)Ljava/lang/String;",
                &[JValue::Object(ctx)],
            ),
        )?
        .l()
        .map_err(jerr)?;
        if raw.is_null() {
            return Err(RadioError::Provider(
                "the Bluetooth glue returned no scan state".to_string(),
            ));
        }
        let text: JString = raw.into();
        let text: String = jni!(env, env.get_string(&text))?.into();
        parse_scan_json(&text)
    }

    /// `BluetoothAdapter#getBondedDevices` — the devices this adapter is paired with.
    ///
    /// The platform hands back a `java.util.Set<BluetoothDevice>`, and raw JNI cannot
    /// express a for-each, so the loop walks the `Iterator` explicitly. Each device is
    /// read inside its **own local frame**, so a long paired list cannot exhaust the
    /// (default 512-slot) local reference table — and the frame is popped even when a
    /// read inside it fails.
    ///
    /// A `null` set is refused instead of reported as `[]`: "the platform told us
    /// nothing" and "the adapter is paired with nothing" are different facts, and only
    /// the second may be shown as an empty list.
    fn bluetooth_bonded(&self, env: &mut JNIEnv<'_>) -> Result<Vec<BtPeer>> {
        let Some(adapter) = self.bluetooth_adapter(env)? else {
            return Err(RadioError::Provider(
                "no Bluetooth adapter on this device".to_string(),
            ));
        };
        let set = jni!(
            env,
            env.call_method(&adapter, "getBondedDevices", "()Ljava/util/Set;", &[]),
        )?
        .l()
        .map_err(jerr)?;
        if set.is_null() {
            return Err(RadioError::Provider(
                "the platform returned no bonded-device list".to_string(),
            ));
        }
        let it = jni!(
            env,
            env.call_method(&set, "iterator", "()Ljava/util/Iterator;", &[]),
        )?
        .l()
        .map_err(jerr)?;
        let mut peers: Vec<BtPeer> = Vec::new();
        loop {
            let has_next = jni!(env, env.call_method(&it, "hasNext", "()Z", &[]))?
                .z()
                .map_err(jerr)?;
            if !has_next {
                break;
            }
            let peer = env.with_local_frame(8, |env| -> Result<Option<BtPeer>> {
                let device = jni!(
                    env,
                    env.call_method(&it, "next", "()Ljava/lang/Object;", &[])
                )?
                .l()
                .map_err(jerr)?;
                if device.is_null() {
                    return Ok(None);
                }
                let state = jni!(env, env.call_method(&device, "getBondState", "()I", &[]))?
                    .i()
                    .map_err(jerr)?;
                if state != BOND_BONDED {
                    // Defensive: the platform's own list holds bonded devices only.
                    // Anything else is left out rather than relabelled a peer.
                    return Ok(None);
                }
                let address = read_java_string(env, &device, "getAddress")?;
                let name = read_java_string(env, &device, "getName")?;
                Ok(Some(BtPeer::new(address, name)))
            })?;
            if let Some(p) = peer {
                peers.push(p);
            }
        }
        Ok(peers)
    }

    /// `TetheringGlue.setWifiTethering(context, on)` — the platform's answer to
    /// the request. `false` means it was refused (unsupported, no upstream, or a
    /// missing `TETHER_PRIVILEGED`); the caller turns that into a provider error.
    fn hotspot_set(&self, env: &mut JNIEnv<'_>, on: bool) -> Result<bool> {
        let Some(class) = self.tethering.as_ref() else {
            return Err(RadioError::Provider(
                "tethering glue not available in this build".to_string(),
            ));
        };
        let class: &JClass<'_> = class.as_obj().into();
        let ctx: &JObject<'_> = self.context.0.as_obj();
        jni!(
            env,
            env.call_static_method(
                class,
                "setWifiTethering",
                "(Landroid/content/Context;Z)Z",
                &[JValue::Object(ctx), JValue::from(on)],
            ),
        )?
        .z()
        .map_err(jerr)
    }

    /// `TetheringGlue.isWifiTethering(context)` — the live Wi-Fi-tethering state
    /// the platform reports (via its `TetheringEventCallback`).
    fn hotspot_is_on(&self, env: &mut JNIEnv<'_>) -> Result<bool> {
        let Some(class) = self.tethering.as_ref() else {
            return Err(RadioError::Provider(
                "tethering glue not available in this build".to_string(),
            ));
        };
        let class: &JClass<'_> = class.as_obj().into();
        let ctx: &JObject<'_> = self.context.0.as_obj();
        jni!(
            env,
            env.call_static_method(
                class,
                "isWifiTethering",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(ctx)],
            ),
        )?
        .z()
        .map_err(jerr)
    }
}

#[async_trait]
impl RadioProvider for AndroidRadioProvider {
    async fn snapshot(&self) -> Result<RadioSnapshot> {
        let mut env = self.env()?;
        let wifi = self.wifi_enabled(&mut env)?;
        let bluetooth = self.bluetooth_enabled(&mut env)?;
        let airplane = self.airplane.load(Ordering::Relaxed);
        // Hotspot is best-effort: a build without the tethering glue must not blank
        // the whole radio snapshot, so fall back to the last state the platform
        // accepted (never a fabricated `true`).
        let hotspot = match self.hotspot_is_on(&mut env) {
            Ok(v) => {
                self.hotspot.store(v, Ordering::Relaxed);
                v
            }
            Err(e) => {
                tracing::debug!(
                    target: "amos::radio",
                    error = %e,
                    "hotspot state unavailable from the tethering glue — reporting the last confirmed state"
                );
                self.hotspot.load(Ordering::Relaxed)
            }
        };
        Ok(RadioSnapshot {
            wifi,
            bluetooth,
            airplane,
            hotspot,
        })
    }

    async fn set_wifi(&self, on: bool) -> Result<()> {
        let mut env = self.env()?;
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = system_service(&mut env, ctx, "wifi")?;
        // `setWifiEnabled` answers "did you accept this request", not "it is done":
        // `false` = the platform refused (API 29+ restricts this call to
        // system/device-owner apps; a missing `CHANGE_WIFI_STATE` is a
        // `SecurityException` instead). Discarding that answer makes a refusal
        // indistinguishable from a switch — which is how the Airplane cascade
        // half-applies without rolling back and without reporting (REQ-A184).
        // `set_hotspot` below has always turned a refusal into an error; this is the
        // same contract, one method over.
        let accepted = jni!(
            env,
            env.call_method(&mgr, "setWifiEnabled", "(Z)Z", &[JValue::from(on)]),
        )?
        .z()
        .map_err(jerr)?;
        if !accepted {
            return Err(RadioError::Provider(format!(
                "the platform refused to switch Wi-Fi {} (setWifiEnabled returned false: \
                 a missing CHANGE_WIFI_STATE, or a non-system caller on API 29+)",
                if on { "on" } else { "off" }
            )));
        }
        Ok(())
    }

    async fn set_bluetooth(&self, on: bool) -> Result<()> {
        let mut env = self.env()?;
        // Same contract as Wi-Fi/hotspot: the platform's answer decides. A refusal is
        // a provider error, never a silent success (REQ-A184).
        if self.bluetooth_set(&mut env, on)? {
            return Ok(());
        }
        Err(RadioError::Provider(format!(
            "the platform refused to switch Bluetooth {} (BluetoothAdapter#enable/disable \
             returned false: restricted by user or device policy)",
            if on { "on" } else { "off" }
        )))
    }

    /// The adapter's own name (REQ-A199). Never a fabricated value: a device without
    /// an adapter, or without `BLUETOOTH_CONNECT`, is an error the UI can fall back
    /// from to its remembered preference.
    async fn bluetooth_local_name(&self) -> Result<String> {
        let mut env = self.env()?;
        self.bluetooth_name(&mut env)
    }

    /// Rename the adapter and answer with **what the adapter reports afterwards**.
    async fn set_bluetooth_local_name(&self, name: &str) -> Result<String> {
        let mut env = self.env()?;
        self.bluetooth_name_set(&mut env, name)
    }

    /// The devices the adapter is paired with.
    ///
    /// Note what is deliberately **not** here (see `docs/radio.md` §10): unpairing.
    /// `BluetoothDevice#removeBond` is not in the public SDK, so a normally-installed
    /// app cannot do it — the UI says so instead of offering a button that would fail.
    async fn bluetooth_paired_devices(&self) -> Result<Vec<BtPeer>> {
        let mut env = self.env()?;
        self.bluetooth_bonded(&mut env)
    }

    /// Start a scan through `BluetoothGlue` (REQ-A200). `false` from the glue becomes a
    /// provider error — the platform refused (or `BLUETOOTH_SCAN` is missing), and the
    /// screen must not render that as "nothing nearby".
    async fn bluetooth_start_discovery(&self) -> Result<bool> {
        let mut env = self.env()?;
        if self.bluetooth_discovery_start(&mut env)? {
            return Ok(true);
        }
        Err(RadioError::Provider(
            "the platform refused to start a Bluetooth scan (BluetoothGlue#startDiscovery \
             returned false: no adapter, or BLUETOOTH_SCAN not granted)"
                .to_string(),
        ))
    }

    /// Cancel a scan. `false` is a refusal, like every other platform verdict here.
    async fn bluetooth_stop_discovery(&self) -> Result<bool> {
        let mut env = self.env()?;
        if self.bluetooth_discovery_stop(&mut env)? {
            return Ok(true);
        }
        Err(RadioError::Provider(
            "the platform refused to cancel the Bluetooth scan (BluetoothGlue#stopDiscovery \
             returned false)"
                .to_string(),
        ))
    }

    /// The glue's scan state (parsed + validated by [`parse_scan_json`]).
    async fn bluetooth_scan_state(&self) -> Result<BtScan> {
        let mut env = self.env()?;
        self.bluetooth_scan(&mut env)
    }

    /// Ask the platform to pair. `false` = the request was refused (unknown address, no
    /// `BLUETOOTH_CONNECT`, or the platform declined) — reported, never assumed.
    async fn bluetooth_pair(&self, address: &str) -> Result<bool> {
        let mut env = self.env()?;
        if self.bluetooth_bond(&mut env, address)? {
            return Ok(true);
        }
        Err(RadioError::Provider(
            "the platform refused to pair (BluetoothGlue#bond returned false: unknown \
             address, or BLUETOOTH_CONNECT not granted)"
                .to_string(),
        ))
    }

    /// The **platform's** answer to "may an app switch this radio, and where can the user
    /// do it instead" (REQ-A202).
    ///
    /// This is the answer that turns an inert switch into an honest one: on the S5
    /// (Android 14) it reports `wifi` and `bluetooth` as `switch_removed` and `airplane`
    /// as `privileged_only`, so `RadioManager` refuses those writes *before* touching the
    /// device and the screen offers the system surface instead.
    ///
    /// Failure handling is deliberately asymmetric with the rest of this module: a missing
    /// or unreadable answer falls back to [`RadioControl::AppControlled`] (so the write is
    /// attempted and the platform's own refusal reaches the user), **never** to
    /// `PlatformManaged` — a broken contract must not make a working switch look forbidden.
    /// The fallback is logged, so it is visible rather than silent.
    async fn control(&self, radio: crate::state::RadioMode) -> RadioControl {
        let key = radio.key();
        let mut env = match self.env() {
            Ok(env) => env,
            Err(e) => {
                tracing::warn!(
                    target: "amos::radio",
                    radio = key,
                    error = %e,
                    "cannot ask the platform about a radio switch — attempting it instead"
                );
                return RadioControl::AppControlled;
            }
        };
        match self.radio_managed_surface(&mut env, key) {
            Ok(raw) => parse_managed_surface(&raw).unwrap_or_else(|| {
                tracing::warn!(
                    target: "amos::radio",
                    radio = key,
                    answer = %raw,
                    "unreadable platform-capability answer — attempting the switch instead"
                );
                RadioControl::AppControlled
            }),
            Err(e) => {
                tracing::warn!(
                    target: "amos::radio",
                    radio = key,
                    error = %e,
                    "the radio glue could not answer — attempting the switch instead"
                );
                RadioControl::AppControlled
            }
        }
    }

    /// Open the system surface that owns a platform-managed switch (REQ-A202). A refusal
    /// (no glue, no Activity for the action) is an error the screen reports — it never
    /// pretends the user was handed anywhere.
    async fn open_system_surface(&self, surface: SystemSurface) -> Result<()> {
        let mut env = self.env()?;
        if self.radio_open_surface(&mut env, surface.key())? {
            return Ok(());
        }
        Err(RadioError::Provider(format!(
            "the platform refused to open the system surface `{}`",
            surface.key()
        )))
    }

    async fn set_airplane(&self, on: bool) -> Result<()> {
        // An AmOS-authored bit — a **platform limit, not unfinished work** (REQ-A184;
        // the same framing the hotspot needed for `TETHER_PRIVILEGED`, REQ-A174): the
        // authoritative switch is `Settings.Global.AIRPLANE_MODE_ON`, and writing it
        // needs `WRITE_SECURE_SETTINGS` (signature|privileged), so a normally
        // installed app can never set it. What AmOS guarantees instead is complete on
        // its own: `RadioManager` switches the real Wi-Fi + Bluetooth + AP off on the
        // way in and gates them until it is turned back off, and `snapshot` reports
        // *this* bit — so the toggle never claims a radio state the platform holds
        // differently, and the device really does stop transmitting.
        self.airplane.store(on, Ordering::Relaxed);
        Ok(())
    }

    async fn set_hotspot(&self, on: bool) -> Result<()> {
        let mut env = self.env()?;
        // The glue is the only place that can issue the callback-based platform
        // call; it answers whether the request was *accepted*. Anything else —
        // missing glue, missing TETHER_PRIVILEGED, no upstream, unsupported — is a
        // provider error, so the UI never claims an AP the platform refused.
        if self.hotspot_set(&mut env, on)? {
            // Mirror only what was accepted; `snapshot` then reads the glue's
            // callback-driven state once the AP actually comes up.
            self.hotspot.store(on, Ordering::Relaxed);
            return Ok(());
        }
        Err(RadioError::Provider(format!(
            "the device refused to {} Wi-Fi tethering (no TETHER_PRIVILEGED, no upstream, or no public tethering API below Android 36)",
            if on { "start" } else { "stop" }
        )))
    }
}

/// Parse the `BluetoothGlue.scanState` JSON into a [`BtScan`].
///
/// **Pure and host-testable on purpose**: this is the contract between the Kotlin glue
/// and Rust, and a wrong guess about its shape (`discovering` vs `scanning`, a missing
/// `scan` flag) would silently read as "no devices nearby". Anything unparseable — or a
/// payload missing the fields that decide what the screen may claim — is an **error**,
/// never a defaulted empty list.
///
/// The fields that decide a claim are therefore all **required**: `discovering` /
/// `capped` / `scan` (can this app look at all?), `classic` / `le` (which transports
/// were searched? "no devices" on a channel nobody scanned is a different answer), and
/// per device `bond` / `le` (does the row offer "pair", show pairing progress, or carry
/// the paired tag?) — a reply that omits a `bond` state must not be read as "not
/// paired" when the device may in fact be mid-pairing (REQ-A201).
///
/// Unknown extra fields are ignored (the glue may grow a field without breaking Rust),
/// but `devices` and `bonds` must be lists, each device must carry a usable `address`
/// and `bond`, and each bond record a `state`.
fn parse_scan_json(raw: &str) -> Result<BtScan> {
    let v: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| RadioError::Provider(format!("Bluetooth glue reply unparseable: {e}")))?;
    let obj = v
        .as_object()
        .ok_or_else(|| RadioError::Provider("Bluetooth glue reply is not an object".to_string()))?;
    let flag = |key: &str| -> Result<bool> {
        obj.get(key)
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| RadioError::Provider(format!("Bluetooth glue reply is missing `{key}`")))
    };
    let devices = obj
        .get("devices")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RadioError::Provider("Bluetooth glue reply has no `devices`".to_string()))?;
    let mut out = Vec::with_capacity(devices.len());
    for d in devices {
        let address = d
            .get("address")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if address.is_empty() {
            // An entry nobody can identify (no address) is dropped rather than shown as
            // a nameless, addressless row; the platform always has the address.
            continue;
        }
        let bond = d
            .get("bond")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| {
                RadioError::Provider(format!(
                    "Bluetooth glue reply has a device without a `bond` state ({address})"
                ))
            })? as i32;
        let le = d
            .get("le")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| {
                RadioError::Provider(format!(
                    "Bluetooth glue reply has a device without an `le` flag ({address})"
                ))
            })?;
        out.push(BtScanDevice {
            address,
            name: d
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            rssi: d
                .get("rssi")
                .and_then(serde_json::Value::as_i64)
                .map(|n| n as i32),
            bond,
            le,
        });
    }
    let raw_bonds = obj
        .get("bonds")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RadioError::Provider("Bluetooth glue reply has no `bonds`".to_string()))?;
    let mut bonds = Vec::with_capacity(raw_bonds.len());
    for b in raw_bonds {
        let address = b
            .get("address")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if address.is_empty() {
            // A transition for an address we cannot name is unusable (it could not be
            // matched to the device the user asked to pair with).
            continue;
        }
        let state = b
            .get("state")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| {
                RadioError::Provider(format!(
                    "Bluetooth glue reply has a bond record without a `state` ({address})"
                ))
            })? as i32;
        bonds.push(BtBond { address, state });
    }
    Ok(BtScan {
        discovering: flag("discovering")?,
        classic: flag("classic")?,
        le: flag("le")?,
        capped: flag("capped")?,
        scan_allowed: flag("scan")?,
        devices: out,
        bonds,
    })
}

/// Parse the `RadioGlue.managedSurface` answer into a [`RadioControl`] (REQ-A202).
///
/// **Pure and host-testable on purpose**, like [`parse_scan_json`]: it is the contract
/// between the Kotlin glue (which owns the API-level knowledge) and Rust.
///
/// * `"app_controlled"` ⇒ [`RadioControl::AppControlled`] — this app may switch it.
/// * `"<reason>:<surface>"` (e.g. `"switch_removed:bluetooth_settings"`) ⇒
///   [`RadioControl::PlatformManaged`].
/// * **anything else** (empty, one-sided, unknown token) ⇒ `None`, and the caller then
///   *attempts* the switch. That direction is deliberate: a broken contract must degrade
///   to "try it and report what the platform says", never to "this switch is forbidden"
///   — the second would disable a working radio on the strength of a parsing bug.
fn parse_managed_surface(raw: &str) -> Option<RadioControl> {
    let raw = raw.trim();
    if raw == "app_controlled" {
        return Some(RadioControl::AppControlled);
    }
    let (reason, surface) = raw.split_once(':')?;
    let reason = PlatformReason::from_code(reason.trim())?;
    let surface = SystemSurface::from_key(surface.trim())?;
    Some(RadioControl::PlatformManaged { surface, reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Host-runnable tests for the parts of this module that do not need an Android VM:
    // the glue's JSON contract (REQ-A200). Everything else here needs a real device.
    // Run with `cargo test -p amos-radio --features android --lib`.

    #[test]
    fn parses_the_glue_capability_answer() {
        // The three answers the device sends (REQ-A202): WiFi removed from apps (API 29),
        // Bluetooth removed (API 33), and the airplane bit that always needed
        // WRITE_SECURE_SETTINGS.
        assert_eq!(
            parse_managed_surface("app_controlled"),
            Some(RadioControl::AppControlled)
        );
        for (raw, surface) in [
            ("switch_removed:wifi_panel", SystemSurface::WifiPanel),
            (
                "switch_removed:bluetooth_settings",
                SystemSurface::BluetoothSettings,
            ),
            (
                "privileged_only:airplane_settings",
                SystemSurface::AirplaneSettings,
            ),
            (
                "privileged_only:wireless_settings",
                SystemSurface::WirelessSettings,
            ),
        ] {
            assert_eq!(
                parse_managed_surface(raw),
                Some(RadioControl::PlatformManaged {
                    surface,
                    reason: PlatformReason::from_code(raw.split_once(':').unwrap().0).unwrap(),
                }),
                "must parse {raw}"
            );
        }
        // Whitespace around the tokens (a Kotlin string built by hand) is tolerated.
        assert_eq!(
            parse_managed_surface(" switch_removed : wifi_panel "),
            Some(RadioControl::PlatformManaged {
                surface: SystemSurface::WifiPanel,
                reason: PlatformReason::SwitchRemoved,
            })
        );
    }

    #[test]
    fn an_unreadable_capability_answer_falls_back_to_attempting_the_switch() {
        // Every one of these must be `None` so the caller *tries* the switch and reports
        // the platform's own answer. Reading any of them as "platform-managed" would
        // disable a working radio because of a broken contract — and reading them as
        // `AppControlled` (a `Some`) would hide the broken contract from the caller.
        for bad in [
            "",
            "   ",
            "app-controlled",
            "switch_removed",
            ":wifi_panel",
            "switch_removed:",
            "nope:wifi_panel",
            "switch_removed:settings_app",
            "switch_removed:wifi_panel:extra",
        ] {
            assert_eq!(
                parse_managed_surface(bad),
                None,
                "must be unreadable: {bad:?}"
            );
        }
        // …while the exact token with surrounding whitespace is still the token.
        assert_eq!(
            parse_managed_surface("  app_controlled\n"),
            Some(RadioControl::AppControlled)
        );
    }

    #[test]
    fn parses_a_realistic_glue_reply() {
        let s = parse_scan_json(
            r#"{"discovering":true,"classic":true,"le":true,"capped":false,"scan":true,
                "devices":[{"address":"AA:BB:CC:DD:EE:FF","name":"Buds","rssi":-61,"bond":12,"le":true},
                           {"address":"11:22:33:44:55:66","name":"","rssi":-90,"bond":10,"le":false}],
                "bonds":[{"address":"AA:BB:CC:DD:EE:FF","state":11}]}"#,
        )
        .unwrap();
        assert!(s.discovering && !s.capped && s.scan_allowed);
        assert!(s.classic && s.le, "both transports were searched");
        assert_eq!(s.devices.len(), 2);
        assert_eq!(s.devices[0].display_name(), "Buds");
        assert_eq!(s.devices[0].rssi, Some(-61));
        assert!(s.devices[0].is_bonded() && s.devices[0].le);
        // A device the platform did not name still gets its address as the label.
        assert_eq!(s.devices[1].display_name(), "11:22:33:44:55:66");
        assert!(!s.devices[1].le, "classic-only device");
        // The session record (a transition that arrived *after* the row was built)
        // outranks the row's own reading.
        assert!(s.is_pairing("AA:BB:CC:DD:EE:FF"));
        assert!(!s.is_bonded("AA:BB:CC:DD:EE:FF"));
    }

    #[test]
    fn an_empty_scan_still_reports_whether_scanning_is_allowed() {
        // "0 devices, allowed" and "0 devices, not allowed" are different facts — the
        // second must never be rendered as "nothing is nearby".
        let allowed = parse_scan_json(
            r#"{"discovering":false,"classic":false,"le":false,"capped":false,"scan":true,"devices":[],"bonds":[]}"#,
        )
        .unwrap();
        assert!(allowed.devices.is_empty() && allowed.scan_allowed);
        let refused = parse_scan_json(
            r#"{"discovering":false,"classic":false,"le":false,"capped":false,"scan":false,"devices":[],"bonds":[]}"#,
        )
        .unwrap();
        assert!(refused.devices.is_empty() && !refused.scan_allowed);
    }

    #[test]
    fn a_reply_missing_a_deciding_field_is_an_error_not_a_default() {
        // Defaulting these would be exactly the silent lie this repo removes: an
        // unreadable reply must not become "no devices nearby". `classic`/`le` were
        // added with the LE scan (REQ-A201): without them the screen cannot tell which
        // channels were actually searched.
        let full = r#""discovering":false,"classic":false,"le":false,"capped":false,"scan":true,"devices":[],"bonds":[]"#;
        for missing in ["discovering", "classic", "le", "capped", "scan"] {
            let body = full
                .split(',')
                .filter(|kv| !kv.starts_with(&format!("\"{missing}\"")))
                .collect::<Vec<_>>()
                .join(",");
            let bad = format!("{{{body}}}");
            assert!(
                matches!(parse_scan_json(&bad), Err(RadioError::Provider(_))),
                "must refuse a reply without `{missing}`: {bad}"
            );
        }
        for bad in [
            r#"{"discovering":false,"classic":false,"le":false,"capped":false,"scan":true,"devices":[]}"#,
            r#"not json"#,
            r#"[1,2,3]"#,
        ] {
            assert!(
                matches!(parse_scan_json(bad), Err(RadioError::Provider(_))),
                "must refuse: {bad}"
            );
        }
    }

    #[test]
    fn a_device_or_bond_without_its_state_is_an_error() {
        // The two fields a row's *behaviour* hangs off: `bond` decides between
        // "pair", "pairing…" and "paired", and `le` which transport tag it carries.
        // Reading a missing one as a default is how a mid-pairing device gets offered
        // "pair" again (REQ-A201).
        let head = r#""discovering":false,"classic":false,"le":false,"capped":false,"scan":true"#;
        for bad in [
            format!(
                r#"{{{head},"devices":[{{"address":"AA:BB","name":"x","rssi":-60,"le":false}}],"bonds":[]}}"#
            ),
            format!(
                r#"{{{head},"devices":[{{"address":"AA:BB","name":"x","rssi":-60,"bond":10}}],"bonds":[]}}"#
            ),
            format!(r#"{{{head},"devices":[],"bonds":[{{"address":"AA:BB"}}]}}"#),
        ] {
            assert!(
                matches!(parse_scan_json(&bad), Err(RadioError::Provider(_))),
                "must refuse: {bad}"
            );
        }
    }

    #[test]
    fn entries_without_an_address_are_dropped_and_unknown_fields_are_ignored() {
        let s = parse_scan_json(
            r#"{"discovering":false,"classic":true,"le":false,"capped":true,"scan":true,"extra":"ignored",
                "devices":[{"name":"no address"},{"address":"   ","name":"blank","bond":10,"le":false},
                           {"address":"AA:BB","name":"ok","bond":10,"le":true}],
                "bonds":[{"state":11},{"address":"  ","state":11},{"address":"CC:DD","state":10}]}"#,
        )
        .unwrap();
        assert!(s.capped, "the cap must be visible to the caller");
        assert_eq!(s.devices.len(), 1);
        assert_eq!(s.devices[0].address, "AA:BB");
        // A transition for an unnamed address is unusable and therefore dropped, and an
        // unknown extra field never breaks the contract.
        assert_eq!(s.bonds.len(), 1);
        assert_eq!(s.bonds[0].address, "CC:DD");
        assert_eq!(s.bonds[0].state, 10);
    }
}
