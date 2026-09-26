//! Tauri <-> BLE GATT / NFC / Biometric bridge (in-process).
//!
//! ## BLE GATT
//! Real BLE read/write/notify runs in the Android System UI APK via
//! `BluetoothGattGlue` (JNI). The host-side commands are the seam that connects
//! the WebView to that glue. On desktop/host, all commands return `false` / empty;
//! the frontend falls back to `navigator.bluetooth` (Web Bluetooth API).
//!
//! ## NFC
//! Real NFC read/write uses `NfcAdapter` / `Ndef` via `NfcGlue`. Not available on iOS.
//!
//! ## Biometric
//! Real biometric auth uses `BiometricPrompt` (Android API 23+) via `BiometricGlue`.
//!
//! Each domain has honest stub returns on host so the UI can show the right degradation.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::AmosError;

/// The Tauri event emitted when a BLE GATT characteristic value changes (from Kotlin glue).
pub const BLE_VALUE_EVENT: &str = "ble-value-changed";

/// The Tauri event emitted when an NFC tag is discovered.
pub const NFC_TAG_EVENT: &str = "nfc-tag-discovered";

// ─────────────────────────────────────────────────────────────────────────────
//  Bridge types
// ─────────────────────────────────────────────────────────────────────────────

/// One characteristic of a discovered GATT service.
///
/// `properties` is the device's raw `BluetoothGattCharacteristic#getProperties()` bitmask. It
/// crosses the bridge undigested on purpose: the screen is what decides whether to enable read /
/// write / subscribe, and a bitmask it can re-interpret is the fact, while a pre-chewed
/// `{readable: bool, writable: bool}` would hide the indicate/notify distinction (REQ-A1198 /
/// F-SH-487).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BleCharacteristic {
    pub uuid: String,
    pub properties: i32,
}

/// One GATT service discovered on the connected device, with the characteristics the platform
/// reported for it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BleService {
    pub uuid: String,
    pub characteristics: Vec<BleCharacteristic>,
}

/// Result of a GATT read.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BleReadResult {
    pub ok: bool,
    pub bytes: Option<Vec<u8>>,
    pub error: Option<String>,
}

/// Result of a GATT write.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BleWriteResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// Result of a GATT service discovery.
///
/// Distinct from an **empty** `services` list, which is a real answer ("the device advertises
/// no services"): `ok: false` means this side could not get a list at all — no glue bound, a
/// refused `discoverServices`, a stack that accepted the request but never answered, one
/// discovery superseded by a newer one, or a payload the platform sent that could not be read
/// (REQ-A1198 / F-SH-488). The screen must say those apart (REQ-A1157).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BleDiscoverResult {
    pub ok: bool,
    pub services: Vec<BleService>,
    pub error: Option<String>,
}

impl BleDiscoverResult {
    /// A discovery that failed, with the reason the caller can show.
    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            services: Vec::new(),
            error: Some(error.into()),
        }
    }
}

/// What `nfc_status` can honestly answer about the adapter.
///
/// **The defect this vocabulary closes (REQ-A775 / F-AND-007).** The reply used to be
/// one free-form `state` string plus the flag `available`, and **every** way the
/// question could fail — no glue bound, the thread not attached, a JNI exception from
/// the NFC service (e.g. `SecurityException` when `android.permission.NFC` is
/// undeclared, see REQ-A774 / F-AND-006), a glue class that would not resolve, a reply
/// that would not parse — was folded into the platform's own answer `no_hardware`.
/// The NFC screen prints that as **"本机没有 NFC 硬件"**, so the app asserted a fact
/// about the user's *hardware* that it had never learned, on a phone that has an NFC
/// radio, and offered no way out: there is no action that fixes "your phone has no
/// NFC". That is the shape F-SH-228 named for GNSS ("a failed read folded into a
/// valid value, and downstream can no longer tell 'nothing' from 'exactly this
/// value'"); the GNSS half was fixed in REQ-A772 and this is its twin.
///
/// The three states the *platform* can report are kept exactly as `NfcGlue` spells
/// them, because they are the platform's answer and this side must not paraphrase
/// it. `Unavailable` is the fourth, and it is this side's own: **we could not ask**.
/// Only `NoHardware` may claim a hardware fact.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NfcState {
    /// The platform reports an adapter and it is on.
    Enabled,
    /// The platform reports an adapter the user turned off in Settings. The user can
    /// change this, and the screen says where.
    Disabled,
    /// The platform's own answer: `NfcAdapter.getDefaultAdapter` returned null, i.e.
    /// the device reports no NFC radio. The **only** state allowed to say so.
    NoHardware,
    /// The adapter state could not be read at all — no glue bound, a thread that
    /// could not attach, a JNI exception, a class that would not resolve, or a reply
    /// that would not parse. A statement about *this app's* reach, never about the
    /// device's hardware.
    Unavailable,
}

/// NFC status reply.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NfcStatusResult {
    /// Whether the platform reports an adapter at all. **Derived** from [`Self::state`]
    /// (never set independently) so the two cannot disagree — `Unavailable` reports
    /// `false` because nothing was learned, which is also why no caller may read it as
    /// "no hardware": that sentence belongs to [`NfcState::NoHardware`] alone.
    pub available: bool,
    pub state: NfcState,
    /// Why the state reads the way it does, when this side had to decide it
    /// (`Unavailable`). `None` when the platform answered for itself. Carried so the
    /// screen can say *which* failure it is instead of inventing a cause.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl NfcStatusResult {
    /// The one constructor: `available` and `detail` are derived from `state` here and
    /// nowhere else.
    fn from_state(state: NfcState, detail: Option<String>) -> Self {
        Self {
            available: matches!(state, NfcState::Enabled | NfcState::Disabled),
            state,
            detail: if state == NfcState::Unavailable {
                detail
            } else {
                None
            },
        }
    }
}

/// Fold the glue's reply into a state — **pure**, so the fold is pinned by a host test
/// rather than only on a device (`nfc_status` itself is `feature = "android"`).
///
/// `reply` is what `NfcGlue.getStatus()` handed back, or the reason the question could
/// not be asked at all. A state string this side does not know is `Unavailable`, never
/// a hardware claim: a future glue that adds a state must add its word here too, and
/// the count assertion in `frontend-ts`'s `declaredMirrors.test.ts` is the ratchet.
pub fn nfc_state_from(reply: Result<String, String>) -> (NfcState, Option<String>) {
    let json = match reply {
        Ok(json) => json,
        Err(why) => return (NfcState::Unavailable, Some(why)),
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json) else {
        return (
            NfcState::Unavailable,
            Some("NfcGlue.getStatus() did not return JSON this side could parse".to_string()),
        );
    };
    match parsed["state"].as_str() {
        Some("enabled") => (NfcState::Enabled, None),
        Some("disabled") => (NfcState::Disabled, None),
        Some("no_hardware") => (NfcState::NoHardware, None),
        Some(other) => (
            NfcState::Unavailable,
            Some(format!(
                "NfcGlue.getStatus() reported an unknown state {other:?}"
            )),
        ),
        None => (
            NfcState::Unavailable,
            Some("NfcGlue.getStatus() returned JSON with no `state` field".to_string()),
        ),
    }
}

/// One NDEF record.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NdefRecord {
    pub tnf: u8,
    pub r#type: String,
    pub payload: String,
    pub id: String,
}

/// NFC write result — matches the TypeScript `NfcWriteResult` discriminated union.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NfcWriteResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_written: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// NFC tag discovery event payload.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NfcTagEvent {
    pub id: String,
    pub technology: String,
    pub ndef: bool,
    pub records: Option<Vec<NdefRecord>>,
}

/// What reading a tag can honestly answer (REQ-A781 / F-AND-009).
///
/// **The fold this vocabulary closes.** `NfcGlue.readTagBytes()` answered `String?`, and one
/// `null` carried three different things: no tag had been seen, the tag was read fine and
/// carries no NDEF payload, and the read threw. This side added a fourth —
/// `Ok(result.flatten())` folded "the glue is not bound", a JNI error, and the whole host
/// build into the same `None`. `NfcApp.svelte` had one branch for it, so every one of the four
/// printed **"读取失败：系统没有返回卡片字节"**, a sentence about the *tag*: a tag that was read
/// perfectly well and simply has nothing on it was reported as a failed read, and a question
/// that never reached the glue was reported as the tag's own answer. The screen's copy for the
/// honest half (`nfc.readEmpty`, rendered when the hex is the empty string) was unreachable,
/// because `readTagBytes()` could return `null` but never `""`.
///
/// [`NfcState`] is the same shape for the *adapter* question, and `Unavailable` means the same
/// thing in both: a statement about **this side's reach**, never about the device.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NfcReadState {
    /// The glue read the tag and it returned bytes — `hex` is `Some`, and `Some("")` is a real
    /// answer (a zero-length payload), which is what keeps `nfc.readEmpty` reachable.
    Bytes,
    /// The glue read the tag successfully and it carries **no NDEF message**. A successful
    /// read of an empty tag — never "the read failed".
    Empty,
    /// The glue is holding no tag: none has been discovered, or the screen cleared the list.
    NoTag,
    /// The glue saw the tag and the read threw (`IOException`, the tag left the field, the
    /// technology refused the connect). The glue's own words are in `detail`.
    Failed,
    /// The question never reached the glue: no binding, a JNI error, a reply this side could
    /// not parse, or the host build. The **same fourth state** [`NfcState::Unavailable`] is for
    /// `nfc_status`, and the screen words it the same way — about this app, not the phone.
    Unavailable,
}

/// What `nfc_read_bytes` answers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NfcReadResult {
    /// What happened. Derive every other field's presence from this.
    pub state: NfcReadState,
    /// The hex id of the tag the glue **actually read**, or `None` when nothing was read.
    ///
    /// This is not decoration. The glue can only ever act on `lastTag`, one field overwritten
    /// by each discovery, while the screen addresses a tag the user picked out of a list of up
    /// to 50 — so the id the read reports is the only thing that can stop one tag's bytes from
    /// being shown under another tag's name. `frontend-ts` compares it with the selection in
    /// `nfcReadBelongsTo`, and `scripts/nfc-read-glue-const-scan.mjs` fails the build if any of
    /// the three layers drops it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_id: Option<String>,
    /// The bytes as lowercase hex. `Some` for [`NfcReadState::Bytes`] — including the empty
    /// string — and `None` for every state where nothing was read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hex: Option<String>,
    /// Why, when there is a why: the glue's own words for [`NfcReadState::Failed`], this side's
    /// own for [`NfcReadState::Unavailable`]. `None` when the tag answered for itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl NfcReadResult {
    /// The one construction of each state, so `hex` and `detail` eligibility cannot drift.
    fn bytes(tag_id: Option<String>, hex: String) -> Self {
        Self {
            state: NfcReadState::Bytes,
            tag_id,
            hex: Some(hex),
            detail: None,
        }
    }

    fn empty(tag_id: Option<String>) -> Self {
        Self {
            state: NfcReadState::Empty,
            tag_id,
            hex: None,
            detail: None,
        }
    }

    fn no_tag() -> Self {
        Self {
            state: NfcReadState::NoTag,
            tag_id: None,
            hex: None,
            detail: None,
        }
    }

    fn failed(tag_id: Option<String>, detail: String) -> Self {
        Self {
            state: NfcReadState::Failed,
            tag_id,
            hex: None,
            detail: Some(detail),
        }
    }

    fn unavailable(detail: String) -> Self {
        Self {
            state: NfcReadState::Unavailable,
            tag_id: None,
            hex: None,
            detail: Some(detail),
        }
    }
}

/// Fold the glue's read reply into a state — **pure**, so the fold is pinned by a host test
/// rather than only on a device, exactly as [`nfc_state_from`] is.
///
/// `reply` is what `NfcGlue.readTagBytes()` handed back, or the reason the question could not be
/// asked at all. A state word this side does not know is `Unavailable`, never a tag fact: a
/// future glue that adds a state must add its word here too, and
/// `scripts/nfc-read-glue-const-scan.mjs` is the ratchet.
pub fn nfc_read_from(reply: Result<String, String>) -> NfcReadResult {
    let json = match reply {
        Ok(json) => json,
        Err(why) => return NfcReadResult::unavailable(why),
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json) else {
        return NfcReadResult::unavailable(
            "NfcGlue.readTagBytes() did not return JSON this side could parse".to_string(),
        );
    };
    let tag_id = parsed["id"].as_str().map(str::to_string);
    let hex = parsed["hex"].as_str().map(str::to_string);
    match parsed["state"].as_str() {
        Some("bytes") => match hex {
            Some(h) => NfcReadResult::bytes(tag_id, h),
            // Saying "bytes" and carrying none is not an empty tag — it is a reply this side
            // cannot read. Reporting it as `Empty` would invent a fact about the tag.
            None => NfcReadResult::unavailable(
                "NfcGlue.readTagBytes() answered \"bytes\" with no `hex` field".to_string(),
            ),
        },
        Some("empty") => NfcReadResult::empty(tag_id),
        Some("no-tag") => NfcReadResult::no_tag(),
        Some("failed") => NfcReadResult::failed(
            tag_id,
            parsed["error"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| "NfcGlue.readTagBytes() threw without a message".to_string()),
        ),
        Some(other) => NfcReadResult::unavailable(format!(
            "NfcGlue.readTagBytes() reported an unknown state {other:?}"
        )),
        None => NfcReadResult::unavailable(
            "NfcGlue.readTagBytes() returned JSON with no `state` field".to_string(),
        ),
    }
}

/// What the device can answer about its biometric sensor (REQ-A779 / F-AND-008).
///
/// The reply used to be two bare booleans (`enrolled`, `hardware_present`), and the Kotlin
/// glue that produced them had the two codes that matter **exchanged**: `BIOMETRIC_ERROR_
/// NO_HARDWARE` (12) sat on the arm reporting the sensor as present, `BIOMETRIC_ERROR_NONE_
/// ENROLLED` (11) fell to `else`. The screen's two sentences are derived from those booleans,
/// so a phone with no sensor was told to enrol a fingerprint and the one phone that needed
/// that sentence was told it had no biometrics. Two booleans also cannot express "we could not
/// ask", so five failure sources on the Rust side (no Context, unattached thread, JNI error
/// — including the `SecurityException` a locked-down OEM ROM raises — an unresolvable class,
/// unparseable JSON) and the host build all folded into the *same* all-false struct the UI
/// renders as "this device has no biometrics".
///
/// The spelling of each variant is a cross-language contract: `BiometricGlue.kt` emits it and
/// `frontend-ts/src/lib/biometric.ts` switches on it. `declaredMirrors.test.ts` and
/// `scripts/biometric-glue-const-scan.mjs` both fail if the three sides drift.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BiometricDeviceState {
    /// A strong biometric is enrolled and the prompt can run.
    Enrolled,
    /// The sensor is there; nothing is enrolled. The one state where "enrol a fingerprint"
    /// is the correct sentence.
    NotEnrolled,
    /// The sensor is there but temporarily unavailable (another app holds it, etc.).
    HwUnavailable,
    /// The device reports no biometric sensor at all.
    NoHardware,
    /// The platform declined to answer (security update required, unsupported, or a code this
    /// build has never seen). Says **nothing** about the hardware.
    Unknown,
    /// We never got an answer out of the platform — JNI failure, no attached Context, or a
    /// host build. Says **nothing** about the hardware, and must not be shown as if it did.
    /// Only the Rust seam can produce this one; the glue never emits it.
    Unavailable,
}

impl BiometricDeviceState {
    /// A reply we can trust only as far as it goes: `hardware_present` is an `Option` so
    /// "unknown" cannot be read as "absent" by a consumer that only looks at the boolean.
    pub fn hardware_present(self) -> Option<bool> {
        match self {
            Self::Enrolled | Self::NotEnrolled | Self::HwUnavailable => Some(true),
            Self::NoHardware => Some(false),
            Self::Unknown | Self::Unavailable => None,
        }
    }

    /// Whether the prompt can actually run right now.
    pub fn is_ready(self) -> bool {
        matches!(self, Self::Enrolled)
    }
}

/// Biometric availability reply.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BiometricAvailability {
    /// What the device said, in the shared vocabulary above.
    pub state: BiometricDeviceState,
    /// The raw `BiometricManager.canAuthenticate` result. `None` when the platform was never
    /// reached. Carried so a reader can audit the translation rather than trust it.
    #[serde(default)]
    pub can_authenticate: Option<i32>,
    /// `face` / `fingerprint` / `iris` / `biometric` / `none`.
    pub kind: String,
    pub label: String,
    pub enrolled: bool,
    /// `Some(true)` "the sensor is there", `Some(false)` "the device says there is none",
    /// `None` "no answer — do not render this as either".
    pub hardware_present: Option<bool>,
    /// The host's own words when `state` is `Unavailable` (the JNI error, or which seam
    /// failed). `None` otherwise.
    #[serde(default)]
    pub detail: Option<String>,
}

/// Biometric authentication reply.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BiometricResult {
    pub ok: bool,
    pub result: Option<String>,
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Android JNI bridge
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(feature = "android")]
pub(crate) mod android_jni {
    use ::jni::JavaVM;
    use jni::objects::{GlobalRef, JObject};
    use std::sync::OnceLock;

    /// BLE GATT glue class.
    ///
    /// **Dotted**, because it is handed to [`glue_class`] → `ClassLoader#loadClass`, which takes a
    /// binary name — the slashed JNI form (`com/amos/…`) that `find_class` wants would fail to
    /// load here. `crates/amos-radio`'s three glue constants are spelled the same way.
    pub const BLE_CLASS: &str = "com.amos.ai.glue.BluetoothGattGlue";
    /// NFC glue class (dotted, as [`BLE_CLASS`]).
    pub const NFC_CLASS: &str = "com.amos.ai.glue.NfcGlue";
    /// Biometric glue class (dotted, as [`BLE_CLASS`]).
    pub const BIOMETRIC_CLASS: &str = "com.amos.ai.glue.BiometricGlue";

    /// `JavaVM` + global `Context` ref. Activity hands up on `onStart`.
    pub struct Binding {
        pub vm: JavaVM,
        pub context: GlobalRef,
    }
    // SAFETY: `JavaVM` and `GlobalRef` are JNI handles the specification allows any attached
    // thread to use (a *global* ref is JVM-managed and explicitly shareable — that is what
    // "global" means). The `jni` crate marks them `!Send`/`!Sync` only because attaching a
    // thread is the caller's job, and `with_context` attaches before every use.
    unsafe impl Send for Binding {}
    // SAFETY: see the `Send` note above: both fields are handles the JVM defines as usable
    // from any attached thread, and `Binding` adds no interior mutability of its own.
    unsafe impl Sync for Binding {}

    pub(crate) static BINDING: OnceLock<Binding> = OnceLock::new();

    /// Install the binding (called from `MainActivity.onStart`).
    pub fn install(env: &mut ::jni::JNIEnv<'_>, context: JObject<'_>) -> Result<(), String> {
        let vm = env.get_java_vm().map_err(|e| e.to_string())?;
        let context = env.new_global_ref(&context).map_err(|e| e.to_string())?;
        match BINDING.set(Binding { vm, context }) {
            Ok(()) => Ok(()),
            Err(_) => Err("device glue binding already attached".to_string()),
        }
    }

    /// Get the bound context for JNI calls.
    pub fn with_context<F, R>(f: F) -> Option<R>
    where
        F: FnOnce(&GlobalRef, &mut ::jni::JNIEnv<'_>) -> Result<R, String>,
    {
        with_context_result(f).ok()
    }

    /// The same call, **without** the fold: the caller gets the reason.
    ///
    /// `with_context` answers `Option<R>`, which is the right shape when `None` maps
    /// onto a distinction the caller already has ("the glue is not bound here" ⇒ a
    /// host build). It is the wrong shape at a seam where *the platform's own answer*
    /// is one of the possibilities: there, `None` silently becomes that answer.
    ///
    /// **Measured (REQ-A775 / F-AND-007).** `nfc_status` used `with_context` and
    /// mapped `None` onto `no_hardware` — the *platform's* statement that the device
    /// has no NFC adapter. So five different facts arrived at the UI as "本机没有 NFC
    /// 硬件": no glue bound, a thread that could not attach, a JNI exception from the
    /// NFC service (a `SecurityException` when `android.permission.NFC` is undeclared
    /// is exactly this), a glue class that would not resolve, and a reply that would
    /// not parse. The user cannot tell any of them from a phone that really has no
    /// NFC, and there is nothing they can do about any of them. Same family as
    /// F-SH-228 / F-SH-196: a failed read folded into a valid value.
    pub fn with_context_result<F, R>(f: F) -> Result<R, String>
    where
        F: FnOnce(&GlobalRef, &mut ::jni::JNIEnv<'_>) -> Result<R, String>,
    {
        let Some(binding) = BINDING.get() else {
            return Err(
                "no Android Context has been bound (MainActivity.onStart has not run)".to_string(),
            );
        };
        let mut env =
            amos_jni::attached(&binding.vm).map_err(|e| format!("thread not attached: {e}"))?;
        let result = f(&binding.context, &mut env);
        if result.is_err() {
            amos_jni::clear_pending(&env);
        }
        result
    }

    /// The glue class through the **app's** class loader, from the bound `Context`.
    ///
    /// `call_static_method(<&str>)` is a `find_class` one step removed, and `find_class` uses the
    /// *calling thread's* loader — the bootstrap one on a tokio worker (every `async` command in
    /// this file), which cannot see `com.amos.ai.glue.*`; the call then fails with
    /// `ClassNotFoundException` (measured on the handset, REQ-A1866 / REQ-A1867). Resolving
    /// through the Context ([`amos_jni::resolve_class`]) and passing the handle is correct from
    /// either thread. The returned global ref must outlive the borrowed `JClass`, so a site binds
    /// both: `let class = android_jni::glue_class(env, ctx, NAME)?;` then
    /// `let class: &::jni::objects::JClass<'_> = class.as_obj().into();`.
    pub fn glue_class(
        env: &mut ::jni::JNIEnv<'_>,
        ctx: &GlobalRef,
        name: &str,
    ) -> Result<GlobalRef, String> {
        amos_jni::resolve_class(env, ctx.as_ref(), name)
            .ok_or_else(|| format!("the glue class {name} is not on the app's class loader"))
    }
}

#[cfg(feature = "android")]
use crate::jni_glue as glue_state;

// ─────────────────────────────────────────────────────────────────────────────
//  BLE GATT Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Connect to a BLE device by address.
///
/// `BluetoothDevice.connectGatt()` **returns immediately** with a `BluetoothGatt` object; the
/// rendezvous verdict arrives later in `onConnectionStateChange(status, newState)` on a Binder
/// thread. So this command arms a waiter *before* it fires the call and awaits the stack's
/// answer, exactly like [`ble_read`] — the answer, not the request.
///
/// The defect this closes (REQ-A1158 / F-SH-459): the command returned whether a `BluetoothGatt`
/// object was created, which is true even for a device that is out of range or that the stack
/// then refuses with status 133 — so the screen printed 「已连接」 for a link that never came up.
#[tauri::command]
pub async fn ble_connect(address: String) -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    #[cfg(feature = "android")]
    {
        let Some(state) = glue_state::BLE_GATT_STATE.get().cloned() else {
            return Err(AmosError::new(
                crate::error::ErrorCode::BleConnectFailed,
                "BluetoothGattGlue not bound".to_string(),
            ));
        };

        let rx = state.arm_connect();
        let started = android_jni::with_context_result(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::BLE_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            let addr = env.new_string(&address).map_err(|e| e.to_string())?;
            let sig = "(Landroid/content/Context;Ljava/lang/String;)Z";
            let args = [
                ::jni::objects::JValue::Object(ctx.as_ref()),
                ::jni::objects::JValue::Object(&addr),
            ];
            // `connect` answers whether a client object was created — *not* whether the device
            // answered. The verdict comes on the callback below.
            let v = amos_jni::jni_call!(env, env.call_static_method(class, "connect", sig, &args))
                .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });

        match started {
            Ok(true) => {}
            Ok(false) => {
                // Never leave a waiter behind for a verdict that cannot come.
                state.disarm_connect();
                return Ok(false);
            }
            // The platform was never asked: a failed JNI call is its own fact, not a verdict
            // about the link. Reporting it as "not bound" would name a cause we did not observe
            // (the very fold the device round behind REQ-A1867 caught).
            Err(reason) => {
                state.disarm_connect();
                return Err(AmosError::new(
                    crate::error::ErrorCode::BleConnectFailed,
                    reason,
                ));
            }
        }

        match tokio::time::timeout(CONNECT_TIMEOUT, rx).await {
            // `GATT_SUCCESS` (0) *and* connected: the rendezvous the device reported.
            Ok(Ok((true, 0))) => Ok(true),
            // The stack reported a state change that is not a clean connection — a refusal
            // (e.g. 133), or a disconnect. Not connected; the status is logged (the screen's
            // failure notice is generic and cannot show it).
            Ok(Ok((_connected, status))) => {
                tracing::debug!(target: "amos::ble", "BLE connect ended without connecting (status {status})");
                Ok(false)
            }
            Ok(Err(_superseded)) => Ok(false),
            Err(_timeout) => {
                state.disarm_connect();
                Err(AmosError::new(
                    crate::error::ErrorCode::BleConnectFailed,
                    format!(
                        "no connection state within {CONNECT_TIMEOUT:?} (the device did not answer)"
                    ),
                ))
            }
        }
    }
    #[cfg(not(feature = "android"))]
    {
        let _ = address;
        Ok(false)
    }
}

/// Disconnect from the current BLE device.
#[tauri::command]
pub fn ble_disconnect() -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::BLE_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            let args: [::jni::objects::JValue<'_, '_>; 0] = [];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(class, "disconnect", "()Z", &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });
        Ok(result.unwrap_or(false))
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(false)
    }
}

/// Discover all GATT services on the connected device.
///
/// `BluetoothGatt.discoverServices()` is **asynchronous** — it answers whether the request was
/// accepted and the list arrives later in `onServicesDiscovered`. This command therefore arms a
/// waiter *before* it fires the call and awaits the answer, exactly like [`ble_read`]; the
/// callback delivers into it (see `jni_glue::BLE_GATT_STATE`).
///
/// The defect this closes (REQ-A1157 / F-SH-458): the command used to fire `discoverServices()`
/// and then drain a shared `Vec` slot **on the same tick**, before the Binder callback could
/// possibly have run — so on device it answered "0 services" while the platform was still
/// discovering, and the screen showed an empty list as if the device had none. It also discarded
/// the JNI return (`let _ =`), so a refused call was indistinguishable from "no services".
/// Translate the glue's discovered services into the shape the screen consumes.
///
/// One owner for the translation, and it is deliberately outside the `android` block so a host
/// test can reach it: the **characteristics and their property bits** are what the screen gates
/// its three controls on, and a mapping that dropped them would send the screen back to "every
/// action looks available until the device refuses it" with no gate able to see the loss
/// (REQ-A1198 / F-SH-487).
#[cfg(feature = "android")]
pub fn services_for_screen(services: Vec<crate::jni_glue::ServiceInfo>) -> Vec<BleService> {
    services
        .into_iter()
        .map(|s| BleService {
            uuid: s.uuid,
            characteristics: s
                .characteristics
                .into_iter()
                .map(|c| BleCharacteristic {
                    uuid: c.uuid,
                    properties: c.properties,
                })
                .collect(),
        })
        .collect()
}

/// Fold the awaited discovery verdict into the answer the screen renders.
///
/// The receiver's error is flattened to `()` at the call site: a `RecvError` has no public
/// constructor, so a fold that took it directly could not be exercised off-device — and this
/// function exists precisely because the *last* arm was not.
///
/// `Ok(Err(reason))` is the arm this round fixed (REQ-A1198 / F-SH-488). The platform **did**
/// answer; the payload could not be read. Reporting that as `ok: true` with an empty list is not
/// a neutral default — it is the same claim the screen draws for a device that advertises no
/// services, i.e. a fact about the device manufactured from a fact about our parsing.
pub fn discovery_answer(answer: Result<Result<Vec<BleService>, String>, ()>) -> BleDiscoverResult {
    match answer {
        Ok(Ok(services)) => BleDiscoverResult {
            ok: true,
            services,
            error: None,
        },
        Ok(Err(reason)) => BleDiscoverResult::failed(reason),
        Err(()) => BleDiscoverResult::failed("this discovery was superseded by a newer one"),
    }
}

#[tauri::command]
pub async fn ble_discover_services() -> Result<BleDiscoverResult, AmosError> {
    #[cfg(feature = "android")]
    const DISCOVER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    #[cfg(feature = "android")]
    {
        let Some(state) = glue_state::BLE_GATT_STATE.get().cloned() else {
            return Ok(BleDiscoverResult::failed("JNI glue not installed"));
        };

        let rx = state.arm_services();
        let started = android_jni::with_context_result(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::BLE_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            let args: [::jni::objects::JValue<'_, '_>; 0] = [];
            // `discoverServices` answers whether the platform *accepted* the request (1) or
            // refused it (0); the list itself comes back on the callback. Discarding this (as
            // the first version did) made a refused discovery look like an empty device.
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(class, "discoverServices", "()I", &args)
            )
            .map_err(|e| e.to_string())?;
            v.i().map_err(|e| e.to_string())
        });

        match started {
            Ok(code) if code != 0 => {}
            Ok(_) => {
                // Never leave a waiter behind for an answer that cannot come.
                state.disarm_services();
                return Ok(BleDiscoverResult::failed(
                    "the platform refused discoverServices".to_string(),
                ));
            }
            // A failed JNI call is its own fact. The device round that exposed REQ-A1867 read
            // exactly this fold: `ClassNotFoundException` arrived here as 「BluetoothGattGlue
            // not bound」, naming a binding state nobody had observed.
            Err(reason) => {
                state.disarm_services();
                return Ok(BleDiscoverResult::failed(reason));
            }
        }

        match tokio::time::timeout(DISCOVER_TIMEOUT, rx).await {
            // The verdict is folded by `discovery_answer` — a pure function outside this block,
            // so the parse-failure arm is pinned by a host test rather than by nothing at all.
            Ok(answer) => Ok(discovery_answer(
                answer.map_err(|_| ()).map(|r| r.map(services_for_screen)),
            )),
            Err(_timeout) => {
                state.disarm_services();
                Ok(BleDiscoverResult::failed(format!(
                    "no service list within {DISCOVER_TIMEOUT:?} (discovery failed or the device did not answer)"
                )))
            }
        }
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(BleDiscoverResult::failed("BLE not available"))
    }
}

/// Read a GATT characteristic value.
///
/// The JVM read is **asynchronous** (`BluetoothGatt.readCharacteristic` returns immediately;
/// the value arrives later in `onCharacteristicReadResult`), so this command arms a waiter for
/// its own characteristic before asking for the read and awaits the answer — mirroring
/// `biometric_authenticate`. The previous shape drained a single shared slot *immediately after
/// firing the read*, which raced the callback (so on device it essentially always answered
/// "no read result yet") and discarded the UUID it read off the slot (so a value could be
/// attributed to a different characteristic). See `BleGattState::pending_reads` (REQ-A413).
#[tauri::command]
pub async fn ble_read(
    service_uuid: String,
    characteristic_uuid: String,
) -> Result<BleReadResult, AmosError> {
    #[cfg(feature = "android")]
    const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    #[cfg(feature = "android")]
    {
        let Some(state) = glue_state::BLE_GATT_STATE.get().cloned() else {
            return Ok(BleReadResult {
                ok: false,
                bytes: None,
                error: Some("JNI glue not installed".to_string()),
            });
        };

        let rx = state.arm_read(&characteristic_uuid);
        let started = android_jni::with_context_result(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::BLE_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            let svc = env.new_string(&service_uuid).map_err(|e| e.to_string())?;
            let chr = env
                .new_string(&characteristic_uuid)
                .map_err(|e| e.to_string())?;
            let sig = "(Ljava/lang/String;Ljava/lang/String;)Z";
            let args = [
                ::jni::objects::JValue::Object(&svc),
                ::jni::objects::JValue::Object(&chr),
            ];
            // `readCharacteristic` answers whether the platform *accepted* the request; the
            // value itself comes back on the callback. Ignoring this boolean (as the first
            // version did) meant a refused read looked exactly like a slow one.
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(class, "readCharacteristic", sig, &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });

        match started {
            Ok(true) => {}
            Ok(false) => {
                // Never leave a waiter behind for an answer that cannot come.
                state.disarm_read(&characteristic_uuid);
                return Ok(BleReadResult {
                    ok: false,
                    bytes: None,
                    error: Some("the platform refused readCharacteristic".to_string()),
                });
            }
            // A failed JNI call is its own fact, not a claim about the binding (REQ-A1867).
            Err(reason) => {
                state.disarm_read(&characteristic_uuid);
                return Ok(BleReadResult {
                    ok: false,
                    bytes: None,
                    error: Some(reason),
                });
            }
        }

        // A GATT read the stack *refuses* reports its own status (`onCharacteristicReadResult`
        // with `status != GATT_SUCCESS`), which arrives here as `Ok(Err(status))` — the cause,
        // not a bare timeout (REQ-A1158 / F-SH-459).
        match tokio::time::timeout(READ_TIMEOUT, rx).await {
            Ok(Ok(Ok(bytes))) => Ok(BleReadResult {
                ok: true,
                bytes: Some(bytes),
                error: None,
            }),
            Ok(Ok(Err(status))) => Ok(BleReadResult {
                ok: false,
                bytes: None,
                error: Some(format!("the stack reported read status {status}")),
            }),
            Ok(Err(_sender_dropped)) => Ok(BleReadResult {
                ok: false,
                bytes: None,
                error: Some("this read was superseded by a newer one".to_string()),
            }),
            Err(_timeout) => {
                state.disarm_read(&characteristic_uuid);
                Ok(BleReadResult {
                    ok: false,
                    bytes: None,
                    error: Some(format!(
                        "no read result within {READ_TIMEOUT:?} (the device did not answer)"
                    )),
                })
            }
        }
    }
    #[cfg(not(feature = "android"))]
    {
        let _ = (service_uuid, characteristic_uuid);
        Ok(BleReadResult {
            ok: false,
            bytes: None,
            error: Some("BLE not available".to_string()),
        })
    }
}

/// Write a value to a GATT characteristic.
///
/// `BluetoothGatt.writeCharacteristic` only answers whether the request was **queued**; the
/// stack's verdict arrives later in `onCharacteristicWriteResult` (for both write types). So this
/// command arms a waiter for **this** characteristic before firing the write and awaits the
/// status, mirroring [`ble_read`].
///
/// The defect this closes (REQ-A1157 / F-SH-458): the command returned the queue-acceptance as
/// its result, so a write the stack took and then failed (status != `GATT_SUCCESS`, e.g.
/// `GATT_INVALID_ATTRIBUTE_LENGTH`, a device that refused it, or a link that dropped mid-write)
/// was reported to the screen as 「写入成功」 — a claim about the device made from a fact about
/// the local queue.
#[tauri::command]
pub async fn ble_write(
    service_uuid: String,
    characteristic_uuid: String,
    value: Vec<u8>,
    with_response: bool,
) -> Result<BleWriteResult, AmosError> {
    #[cfg(feature = "android")]
    const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    #[cfg(feature = "android")]
    {
        let Some(state) = glue_state::BLE_GATT_STATE.get().cloned() else {
            return Ok(BleWriteResult {
                ok: false,
                error: Some("JNI glue not installed".to_string()),
            });
        };

        let rx = state.arm_write(&characteristic_uuid);
        let started = android_jni::with_context_result(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::BLE_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            let svc = env.new_string(&service_uuid).map_err(|e| e.to_string())?;
            let chr = env
                .new_string(&characteristic_uuid)
                .map_err(|e| e.to_string())?;
            let bytes = env
                .byte_array_from_slice(&value)
                .map_err(|e| e.to_string())?;
            let sig = "(Ljava/lang/String;Ljava/lang/String;[BZ)Z";
            let args = [
                ::jni::objects::JValue::Object(&svc),
                ::jni::objects::JValue::Object(&chr),
                ::jni::objects::JValue::Object(&bytes),
                ::jni::objects::JValue::Bool(if with_response { 1 } else { 0 }),
            ];
            // Whether the stack *queued* the write — not whether the device took it.
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(class, "writeCharacteristic", sig, &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });

        match started {
            Ok(true) => {}
            Ok(false) => {
                // Never leave a waiter behind for a verdict that cannot come.
                state.disarm_write(&characteristic_uuid);
                return Ok(BleWriteResult {
                    ok: false,
                    error: Some("the platform refused writeCharacteristic".to_string()),
                });
            }
            // A failed JNI call is its own fact, not a claim about the binding (REQ-A1867).
            Err(reason) => {
                state.disarm_write(&characteristic_uuid);
                return Ok(BleWriteResult {
                    ok: false,
                    error: Some(reason),
                });
            }
        }

        match tokio::time::timeout(WRITE_TIMEOUT, rx).await {
            Ok(Ok(0)) => Ok(BleWriteResult {
                ok: true,
                error: None,
            }),
            Ok(Ok(status)) => Ok(BleWriteResult {
                ok: false,
                error: Some(format!("the stack reported write status {status}")),
            }),
            Ok(Err(_superseded)) => Ok(BleWriteResult {
                ok: false,
                error: Some("this write was superseded by a newer one".to_string()),
            }),
            Err(_timeout) => {
                state.disarm_write(&characteristic_uuid);
                Ok(BleWriteResult {
                    ok: false,
                    error: Some(format!(
                        "no write result within {WRITE_TIMEOUT:?} (the write failed or the device did not answer)"
                    )),
                })
            }
        }
    }
    #[cfg(not(feature = "android"))]
    {
        let _ = (service_uuid, characteristic_uuid, value, with_response);
        Ok(BleWriteResult {
            ok: false,
            error: Some("BLE not available".to_string()),
        })
    }
}

/// Verdict codes returned by `BluetoothGattGlue.setCharacteristicNotification` (JNI `I`).
///
/// The member used to answer a bare `Z` "did the stack accept the local registration", which is
/// a fact about the **local** stack, not about the device. It now distinguishes the three things
/// a caller must tell apart (REQ-A1158 / F-SH-459):
#[cfg(feature = "android")]
mod notify_verdict {
    /// No request reached the stack (no glue, not connected, refused, or no permission).
    pub const NO_REQUEST: i32 = 0;
    /// The CCC descriptor write was handed to the stack; the device's verdict arrives later in
    /// `onDescriptorWriteResult`.
    pub const DESCRIPTOR_QUEUED: i32 = 1;
    /// The characteristic carries no CCC descriptor, so the device can never be told to notify.
    pub const NO_DESCRIPTOR: i32 = 2;
}

/// Start receiving notifications for a GATT characteristic.
///
/// Two steps happen on device, and only the second is about the **device**: a local
/// `setCharacteristicNotification` (the stack registering the request) and the CCC descriptor
/// write, whose verdict arrives later in `onDescriptorWrite`. This command used to return the
/// local half as success, so the screen said 「已订阅」 for a device that never acknowledged — or
/// for a characteristic with no CCC at all (REQ-A1158 / F-SH-459).
#[tauri::command]
pub async fn ble_subscribe(
    service_uuid: String,
    characteristic_uuid: String,
) -> Result<bool, AmosError> {
    toggle_notifications(service_uuid, characteristic_uuid, true).await
}

/// Stop receiving notifications for a GATT characteristic.
///
/// Calls the **same** three-argument Kotlin member as `ble_subscribe` with `enable = false`.
/// It used to pass a two-argument descriptor `("(Ljava/lang/String;Z)Z")` and drop
/// `service_uuid` on the floor: the JVM resolves a static call by name *and* signature, so
/// every unsubscribe would have raised `NoSuchMethodError` on device — notifications could be
/// turned on but never off, which no gate saw because the descriptor was built in a `let`
/// inside a closure (`jni-contract-scan`'s R1 could not read it; REQ-A413 fixed the reader and
/// the defect it was hiding).
#[tauri::command]
pub async fn ble_unsubscribe(
    service_uuid: String,
    characteristic_uuid: String,
) -> Result<bool, AmosError> {
    toggle_notifications(service_uuid, characteristic_uuid, false).await
}

/// Shared body of [`ble_subscribe`] / [`ble_unsubscribe`]: fire the Kotlin toggle, then await the
/// descriptor write the device answers (see [`notify_verdict`]).
///
/// `enable` decides what "no CCC descriptor" means. Enabling is impossible without one, so that
/// is a refusal; disabling is vacuously satisfied, since a characteristic with no CCC was never
/// being notified on.
#[cfg(feature = "android")]
async fn toggle_notifications(
    service_uuid: String,
    characteristic_uuid: String,
    enable: bool,
) -> Result<bool, AmosError> {
    use notify_verdict::{DESCRIPTOR_QUEUED, NO_DESCRIPTOR, NO_REQUEST};

    const SUBSCRIBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    let Some(state) = glue_state::BLE_GATT_STATE.get().cloned() else {
        return Ok(false);
    };

    let rx = state.arm_descriptor_write(&characteristic_uuid);
    let verdict = android_jni::with_context(|ctx, env| {
        let class = android_jni::glue_class(env, ctx, android_jni::BLE_CLASS)?;
        let class: &::jni::objects::JClass<'_> = class.as_obj().into();
        let svc = env.new_string(&service_uuid).map_err(|e| e.to_string())?;
        let chr = env
            .new_string(&characteristic_uuid)
            .map_err(|e| e.to_string())?;
        // Resolve the characteristic via the service UUID first, so two
        // services that share a 16-bit characteristic UUID (very common,
        // e.g. `0x2A19` Battery Level appears in both the Battery Service
        // and the Environmental Sensor service) don't silently get bound to
        // the wrong one.
        let sig = "(Ljava/lang/String;Ljava/lang/String;Z)I";
        let args = [
            ::jni::objects::JValue::Object(&svc),
            ::jni::objects::JValue::Object(&chr),
            ::jni::objects::JValue::Bool(if enable { 1 } else { 0 }),
        ];
        let v = amos_jni::jni_call!(
            env,
            env.call_static_method(class, "setCharacteristicNotification", sig, &args)
        )
        .map_err(|e| e.to_string())?;
        v.i().map_err(|e| e.to_string())
    });

    match verdict {
        Some(NO_DESCRIPTOR) => {
            // No descriptor write will ever arrive; do not leave a waiter behind.
            state.disarm_descriptor_write(&characteristic_uuid);
            Ok(!enable)
        }
        Some(DESCRIPTOR_QUEUED) => match tokio::time::timeout(SUBSCRIBE_TIMEOUT, rx).await {
            Ok(Ok(0)) => Ok(true),
            Ok(Ok(status)) => {
                tracing::debug!(
                    target: "amos::ble",
                    "descriptor write for {characteristic_uuid} reported status {status}"
                );
                Ok(false)
            }
            Ok(Err(_superseded)) => Ok(false),
            Err(_timeout) => {
                state.disarm_descriptor_write(&characteristic_uuid);
                Ok(false)
            }
        },
        Some(NO_REQUEST) | None => {
            // Nothing reached the stack (or the glue is unbound) — no verdict is coming.
            state.disarm_descriptor_write(&characteristic_uuid);
            Ok(false)
        }
        Some(other) => {
            tracing::debug!(
                target: "amos::ble",
                "setCharacteristicNotification answered an unexpected code {other}"
            );
            state.disarm_descriptor_write(&characteristic_uuid);
            Ok(false)
        }
    }
}

#[cfg(not(feature = "android"))]
async fn toggle_notifications(
    _service_uuid: String,
    _characteristic_uuid: String,
    _enable: bool,
) -> Result<bool, AmosError> {
    Ok(false)
}

// ─────────────────────────────────────────────────────────────────────────────
//  NFC Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// The refusal an NFC **operation** produces when the device glue is not bound —
/// no Activity has run `onStart` to hand up the Context (`android_jni::BINDING`
/// is unset, so `with_context` answers `None`).
///
/// This is the **one construction** of [`crate::error::ErrorCode::NfcNotInitialized`]
/// (REQ-A637): `error.rs` declares the variant with exactly this trigger, but no
/// path reached it, so `nfc_write_message` answered an unbound glue with
/// `Ok(NfcWriteResult { ok: false, error: "NfcGlue not bound" })` — a *success*
/// carrying a string the caller cannot tell from "the tag refused the write".
/// `ble_connect` already models the same unbound-binding condition as a named
/// refusal ([`crate::error::ErrorCode::BleConnectFailed`], ble.rs); NFC now matches
/// it. Feature-independent so the mapping is host-testable — the JNI call only
/// compiles under `--features android`, but the *decision* for a missing binding
/// does not depend on it.
fn nfc_not_initialized() -> AmosError {
    AmosError::new(
        crate::error::ErrorCode::NfcNotInitialized,
        "NFC glue is not initialized (no Activity has run onStart)".to_string(),
    )
}

/// Check whether NFC hardware is present and enabled.
///
/// Every failure keeps its own state — see [`NfcState`]. The glue's own JSON still
/// carries `available`, but it is **ignored** here: this side derives the flag from
/// the state, so the two cannot disagree and a lying `available` cannot get through.
#[tauri::command]
pub fn nfc_status() -> Result<NfcStatusResult, AmosError> {
    #[cfg(feature = "android")]
    let reply = android_jni::with_context_result(|ctx, env| {
        let class = android_jni::glue_class(env, ctx, android_jni::NFC_CLASS)?;
        let class: &::jni::objects::JClass<'_> = class.as_obj().into();
        // NfcGlue.init(context)
        let init_sig = "(Landroid/content/Context;)Z";
        let init_args = [::jni::objects::JValue::Object(ctx.as_ref())];
        let _ = amos_jni::jni_call!(
            env,
            env.call_static_method(class, "init", init_sig, &init_args)
        )
        .map_err(|e| e.to_string())?;

        // NfcGlue.getStatus() → String (JSON)
        let args: [::jni::objects::JValue<'_, '_>; 0] = [];
        let v = amos_jni::jni_call!(
            env,
            env.call_static_method(class, "getStatus", "()Ljava/lang/String;", &args)
        )
        .map_err(|e| e.to_string())?;
        let jstr_owned = v.l().map_err(|e| e.to_string())?;
        let jstr_raw = jstr_owned.as_raw();
        let jstr: ::jni::objects::JString<'_> =
            // SAFETY: `jstr_raw` borrows from `jstr_owned`, a live local reference
            // returned by the call above; the wrapper is consumed by `get_string` on the
            // next line, so it cannot outlive the handle it borrows.
            unsafe { ::jni::objects::JString::from_raw(jstr_raw) };
        let s = env.get_string(&jstr).map_err(|e| e.to_string())?;
        Ok::<String, String>(s.into())
    });

    // Not an Android build: there is no NFC adapter layer to ask. That is *this*
    // side's limitation, and saying so is the point — the old code answered
    // `no_hardware`, i.e. it made a claim about the hardware of a Mac.
    #[cfg(not(feature = "android"))]
    let reply: Result<String, String> =
        Err("this build has no Android NFC glue (host/desktop target)".to_string());

    let (state, detail) = nfc_state_from(reply);
    Ok(NfcStatusResult::from_state(state, detail))
}

/// Start NFC foreground dispatch.
#[tauri::command]
pub fn nfc_start_dispatch(_app: AppHandle) -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    {
        // First init the adapter, then start foreground dispatch.
        // Foreground dispatch needs Activity; we use the bound context.
        let result = android_jni::with_context(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::NFC_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            // Initialize the NFC adapter.
            let init_sig = "(Landroid/content/Context;)Z";
            let init_args = [::jni::objects::JValue::Object(ctx.as_ref())];
            let init_ok = amos_jni::jni_call!(
                env,
                env.call_static_method(class, "init", init_sig, &init_args)
            )
            .map_err(|e| e.to_string())?
            .z()
            .map_err(|e| e.to_string())?;

            if !init_ok {
                return Ok(false);
            }

            // Start foreground dispatch with the activity from the context.
            // Note: the context is the Activity, so we can cast it.
            let dispatch_sig = "(Landroid/app/Activity;)Z";
            let dispatch_args = [::jni::objects::JValue::Object(ctx.as_ref())];
            let dispatch_ok = amos_jni::jni_call!(
                env,
                env.call_static_method(
                    class,
                    "startForegroundDispatch",
                    dispatch_sig,
                    &dispatch_args
                )
            )
            .map_err(|e| e.to_string())?
            .z()
            .map_err(|e| e.to_string())?;

            Ok(dispatch_ok)
        });
        Ok(result.unwrap_or(false))
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(false)
    }
}

/// Stop NFC foreground dispatch.
#[tauri::command]
pub fn nfc_stop_dispatch(_app: AppHandle) -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::NFC_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            // Stop foreground dispatch with the activity from the context.
            let sig = "(Landroid/app/Activity;)Z";
            let args = [::jni::objects::JValue::Object(ctx.as_ref())];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(class, "stopForegroundDispatch", sig, &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });
        Ok(result.unwrap_or(false))
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(true)
    }
}

/// Format a raw NFC tag into NDEF.
#[tauri::command]
pub fn nfc_format_tag() -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::NFC_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            let args: [::jni::objects::JValue<'_, '_>; 0] = [];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(class, "formatTag", "()Z", &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });
        Ok(result.unwrap_or(false))
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(false)
    }
}

/// Write an NDEF message to the current tag.
#[tauri::command]
pub fn nfc_write_message(records: Vec<NdefRecord>) -> Result<NfcWriteResult, AmosError> {
    #[cfg(feature = "android")]
    {
        // Serialize records to JSON for NfcGlue.writeNdefMessage(jsonString)
        let json = serde_json::json!({
            "records": records.iter().map(|r| {
                serde_json::json!({
                    "tnf": r.tnf,
                    "type": r.r#type,
                    "payload": r.payload,
                    "id": r.id,
                })
            }).collect::<Vec<_>>()
        });
        let json_str = serde_json::to_string(&json).unwrap_or_else(|_| "{}".to_string());
        let result = android_jni::with_context(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::NFC_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            let jstr = env.new_string(&json_str).map_err(|e| e.to_string())?;
            let sig = "(Ljava/lang/String;)Z";
            let args = [::jni::objects::JValue::Object(&jstr)];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(class, "writeNdefMessage", sig, &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });
        match result {
            Some(true) => {
                let total: u32 = records.iter().map(|r| (r.payload.len() / 2) as u32).sum();
                Ok(NfcWriteResult {
                    ok: true,
                    bytes_written: Some(total),
                    error: None,
                })
            }
            Some(false) => Ok(NfcWriteResult {
                ok: false,
                bytes_written: None,
                error: Some("writeNdefMessage refused".to_string()),
            }),
            // The glue is not bound. `Some(false)` above is the tag refusing an
            // otherwise-live glue; this is "there is no glue at all" and must be a
            // named refusal so the caller can tell the two apart (REQ-A637).
            None => Err(nfc_not_initialized()),
        }
    }
    #[cfg(not(feature = "android"))]
    {
        let _ = records;
        // No Activity and no device glue exist off-device, so this is a fortiori the
        // declared "glue not initialized" condition — the host build answers with the
        // same named refusal as the on-device unbound-glue path rather than an
        // `Ok { ok: false, error: "NFC not available" }` that reads as a hardware fact.
        Err(nfc_not_initialized())
    }
}

/// Read the bytes of an NFC tag.
///
/// The Kotlin glue reads the **currently held** tag (`readTagBytes()` takes no arguments), so
/// `tag_id` cannot select what is read — but it must still be declared under the name the caller
/// sends: the frontend sends `tagId`, Tauri maps that to `tag_id`, and the parameter used to be
/// named `_tag_id`, which is a *different* key — the command failed with "invalid args" before it
/// ever reached the glue. `tauri-args-scan` reported it as "key `tagId` matches no argument"
/// (REQ-A412).
///
/// The id is still not a selector, and that is exactly why the answer has to carry the id the
/// glue **actually read** ([`NfcReadResult::tag_id`]): the screen addresses a tag the user picked
/// from a list, the glue can only act on the last tag it saw, and the two can differ. The caller
/// compares them with `nfcReadBelongsTo` rather than presenting one tag's bytes as another's.
///
/// ## Why the answer is a state and not `Ok(None)` (REQ-A781 / F-AND-009)
///
/// This used to end in `Ok(result.flatten())`, which folded four different outcomes — the glue
/// holding no tag, a tag with no NDEF payload, a read that threw, and "the question never reached
/// the glue" (no binding, a JNI error, or the host build) — into one `None`, which the screen
/// rendered as **"读取失败：系统没有返回卡片字节"**. See [`NfcReadState`]. Like `nfc_status`, this
/// is a *query* about what the glue currently sees, so it answers with an in-band state carrying
/// this side's own words rather than refusing with an `AmosError`; the NFC **actions**
/// (`nfc_write_message`, `nfc_format_tag`) keep the named-refusal shape REQ-A637 gave them.
#[tauri::command]
pub fn nfc_read_bytes(tag_id: String) -> Result<NfcReadResult, AmosError> {
    tracing::debug!(
        target: "amos::ble",
        %tag_id,
        "nfc_read_bytes: the glue reads the held tag; the reply names the id it actually read"
    );
    #[cfg(feature = "android")]
    let reply = android_jni::with_context_result(|ctx, env| {
        let class = android_jni::glue_class(env, ctx, android_jni::NFC_CLASS)?;
        let class: &::jni::objects::JClass<'_> = class.as_obj().into();
        let args: [::jni::objects::JValue<'_, '_>; 0] = [];
        let v = amos_jni::jni_call!(
            env,
            env.call_static_method(class, "readTagBytes", "()Ljava/lang/String;", &args)
        )
        .map_err(|e| e.to_string())?;
        let jstr_owned = v.l().map_err(|e| e.to_string())?;
        let jstr_raw = jstr_owned.as_raw();
        let jstr: ::jni::objects::JString<'_> =
            // SAFETY: `jstr_raw` borrows from `jstr_owned`, a live local reference returned by
            // the call above; the wrapper is consumed by `get_string` on the next line and
            // cannot outlive it.
            unsafe { ::jni::objects::JString::from_raw(jstr_raw) };
        let s = env.get_string(&jstr).map_err(|e| e.to_string())?;
        Ok::<String, String>(s.into())
    });

    // Not an Android build: there is no NFC glue to ask. That is *this* side's limitation, and
    // saying so is the point — the old code answered `None`, which the screen worded as the
    // tag's own "no bytes".
    #[cfg(not(feature = "android"))]
    let reply: Result<String, String> =
        Err("this build has no Android NFC glue (host/desktop target)".to_string());

    Ok(nfc_read_from(reply))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Biometric Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// The refusal `biometric_authenticate` produces without an Activity-bound prompt
/// (the Kotlin glue needs a `FragmentActivity` to host `BiometricPrompt`).
///
/// The **one construction** of [`crate::error::ErrorCode::BiometricNoActivity`]
/// (REQ-A637): `error.rs` declares the variant with this exact trigger, but no path
/// reached it — the command degraded an unbound prompt into
/// `Ok(BiometricResult { ok: false, error: "biometric not initialized" })`, an
/// indistinguishable-from-a-platform-error success. A caller cannot reason about
/// "is the prompt even available?" without the named refusal.
fn biometric_no_activity() -> AmosError {
    AmosError::new(
        crate::error::ErrorCode::BiometricNoActivity,
        "biometric_authenticate was called without an Activity-bound prompt".to_string(),
    )
}

/// The reply for a question that was never answered, carrying *which* seam failed.
///
/// One constructor, so `kind`/`label`/`enrolled`/`hardware_present` cannot be set to a
/// hardware claim by accident: an unanswered question has no `kind` to name and no boolean
/// to assert.
fn biometric_unavailable(detail: impl Into<String>) -> BiometricAvailability {
    BiometricAvailability {
        state: BiometricDeviceState::Unavailable,
        can_authenticate: None,
        kind: "none".to_string(),
        label: "生物识别".to_string(),
        enrolled: false,
        hardware_present: None,
        detail: Some(detail.into()),
    }
}

/// Fold the glue's reply into an availability — **pure**, so the fold is pinned by a host
/// test rather than only on a device (`biometric_available` itself is `feature = "android"`).
///
/// `reply` is what `BiometricGlue.getAvailability()` handed back, or the reason the question
/// could not be asked at all. Three properties are load-bearing:
///
/// 1. **Every failure is `Unavailable`, never `NoHardware`.** A state string this side does
///    not know, a reply that will not parse, or a JNI error is *our* failure to learn, not the
///    phone's statement about its hardware. The old fold returned `hardware_present: false`
///    for all of them, which the screen renders as "此设备没有生物识别".
/// 2. **`hardware_present` and `enrolled` are derived from `state`, not read from the glue.**
///    The wire still carries them (older readers, and the JSON is easier to read by eye), but
///    the values here come from [`BiometricDeviceState::hardware_present`] — so the two can
///    never disagree, which is exactly the defect that started this (the glue's arms *were*
///    the disagreement).
/// 3. **`detail` is the host's own words** for `Unavailable`, so the screen can say which
///    failure it is instead of inventing a cause.
pub fn biometric_availability_from(reply: Result<String, String>) -> BiometricAvailability {
    let json = match reply {
        Ok(json) => json,
        Err(why) => return biometric_unavailable(why),
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json) else {
        return biometric_unavailable(
            "BiometricGlue.getAvailability() did not return JSON this side could parse",
        );
    };
    let state = match parsed["state"].as_str() {
        Some("enrolled") => BiometricDeviceState::Enrolled,
        Some("not-enrolled") => BiometricDeviceState::NotEnrolled,
        Some("hw-unavailable") => BiometricDeviceState::HwUnavailable,
        Some("no-hardware") => BiometricDeviceState::NoHardware,
        Some("unknown") => BiometricDeviceState::Unknown,
        Some(other) => {
            return biometric_unavailable(format!(
                "BiometricGlue.getAvailability() reported an unknown state {other:?}"
            ))
        }
        None => {
            return biometric_unavailable(
                "BiometricGlue.getAvailability() returned JSON with no `state` field",
            )
        }
    };

    // A determinate state is one the platform actually answered: only then does a `kind` from
    // the feature flags mean anything.
    let determinate = !matches!(state, BiometricDeviceState::Unknown);
    let (kind, label) = if determinate {
        (
            parsed["kind"].as_str().unwrap_or("none").to_string(),
            parsed["label"].as_str().unwrap_or("生物识别").to_string(),
        )
    } else {
        ("none".to_string(), "生物识别".to_string())
    };

    BiometricAvailability {
        state,
        can_authenticate: parsed["can_authenticate"].as_i64().map(|v| v as i32),
        kind,
        label,
        enrolled: matches!(state, BiometricDeviceState::Enrolled),
        hardware_present: state.hardware_present(),
        detail: None,
    }
}

/// Check biometric hardware presence and enrollment status.
///
/// The five failure sources (`with_context_result`'s unbound Context, an unattached thread, a
/// JNI error — including the `SecurityException` an OEM ROM raises — an unresolvable glue
/// class, and unparseable JSON) each arrive at the screen with their own `detail`, instead of
/// all of them reading as "this device has no biometrics" (REQ-A779 / F-AND-008).
#[tauri::command]
pub fn biometric_available() -> Result<BiometricAvailability, AmosError> {
    #[cfg(feature = "android")]
    let reply: Result<String, String> = android_jni::with_context_result(|ctx, env| {
        let class = android_jni::glue_class(env, ctx, android_jni::BIOMETRIC_CLASS)?;
        let class: &::jni::objects::JClass<'_> = class.as_obj().into();
        let sig = "(Landroid/content/Context;)Ljava/lang/String;";
        let args = [::jni::objects::JValue::Object(ctx.as_ref())];
        let v = amos_jni::jni_call!(
            env,
            env.call_static_method(class, "getAvailability", sig, &args)
        )
        .map_err(|e| e.to_string())?;
        let jstr_owned = v.l().map_err(|e| e.to_string())?;
        let jstr_raw = jstr_owned.as_raw();
        let jstr: ::jni::objects::JString<'_> =
            // SAFETY: `jstr_raw` borrows from `jstr_owned`, a live local reference
            // returned by the call above; the wrapper is consumed by `get_string` on the
            // next line and cannot outlive it.
            unsafe { ::jni::objects::JString::from_raw(jstr_raw) };
        let s = env.get_string(&jstr).map_err(|e| e.to_string())?;
        Ok::<String, String>(s.into())
    });

    // Not an Android build: there is no biometric adapter layer to ask. That is *this* side's
    // limitation, and saying so is the point — the old code answered with an all-false
    // struct, i.e. it made a claim about the hardware of a Mac.
    #[cfg(not(feature = "android"))]
    let reply: Result<String, String> =
        Err("this build has no Android biometric glue (host/desktop target)".to_string());

    Ok(biometric_availability_from(reply))
}

/// Prompt for biometric authentication.
///
/// The Kotlin side returns immediately; the real outcome arrives via the
/// `onAuthenticationSucceeded` / `onAuthenticationError` JNI callbacks
/// (handled inside `BiometricState::set_result`). We bridge the two by
/// registering a `oneshot::Sender` before calling Kotlin and `await`-ing the
/// receiver here. A 30-second timeout is applied so a stuck BiometricPrompt
/// can't park the Tauri command thread forever.
#[tauri::command]
pub async fn biometric_authenticate(
    reason: String,
    allow_device_credential: bool,
) -> Result<BiometricResult, AmosError> {
    #[cfg(feature = "android")]
    const PROMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    #[cfg(feature = "android")]
    {
        let state = match glue_state::BIOMETRIC_STATE.get() {
            Some(s) => s,
            // No Activity-bound prompt exists (`glue_state::init` never ran under
            // `MainActivity.onStart`) — the declared `BiometricNoActivity` condition
            // (REQ-A637), a named refusal rather than an `Ok { ok: false }`.
            None => return Err(biometric_no_activity()),
        };

        // Drain any stale result from a previous prompt so a fast re-prompt
        // doesn't see the previous outcome.
        let _ = state.take_result();

        // Register the oneshot receiver. If a prompt is already in flight,
        // refuse the second call instead of silently overwriting the first
        // user's answer (audit H4).
        let rx = match state.arm_prompt() {
            Some(rx) => rx,
            None => {
                return Ok(BiometricResult {
                    ok: false,
                    result: None,
                    error: Some("another prompt is already in progress".to_string()),
                });
            }
        };

        // Fire the Kotlin prompt.
        let fired = android_jni::with_context(|ctx, env| {
            let class = android_jni::glue_class(env, ctx, android_jni::BIOMETRIC_CLASS)?;
            let class: &::jni::objects::JClass<'_> = class.as_obj().into();
            let sig = "(Landroid/content/Context;Ljava/lang/String;Z)V";
            let reason_jstr = env.new_string(&reason).map_err(|e| e.to_string())?;
            let args = [
                ::jni::objects::JValue::Object(ctx.as_ref()),
                ::jni::objects::JValue::Object(&reason_jstr),
                ::jni::objects::JValue::Bool(if allow_device_credential { 1 } else { 0 }),
            ];
            amos_jni::jni_call!(
                env,
                env.call_static_method(class, "authenticate", sig, &args)
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        // `with_context` answers `Option<R>` (a missing binding or a failed JNI call both
        // become `None`, and it clears the pending Java exception on the error path), so the
        // question here is `is_some`, not `is_ok` — this line did not compile at all under
        // `--features android` until the `E0599` was fixed.
        .is_some();

        if !fired {
            // Roll back the oneshot so the next call can arm itself.
            state.cancel_pending();
            // Same declared condition as the `None` arm above: the prompt binding
            // vanished between the two `with_context` calls (or the JNI call failed),
            // so the refusal is "no Activity-bound prompt", not a returned result.
            return Err(biometric_no_activity());
        }

        // Await the answer with a timeout. Resolve to a deterministic
        // "timeout" string on expiry rather than panicking.
        match tokio::time::timeout(PROMPT_TIMEOUT, rx).await {
            Ok(Ok(r)) => Ok(BiometricResult {
                ok: r.ok,
                result: r.result,
                error: r.error,
            }),
            Ok(Err(_oneshot_dropped)) => Ok(BiometricResult {
                ok: false,
                result: None,
                error: Some("biometric prompt cancelled".to_string()),
            }),
            Err(_timeout) => {
                state.cancel_pending();
                Ok(BiometricResult {
                    ok: false,
                    result: None,
                    error: Some("biometric prompt timed out".to_string()),
                })
            }
        }
    }
    #[cfg(not(feature = "android"))]
    {
        let _ = (reason, allow_device_credential);
        // No Activity-bound prompt exists off-device — the declared condition itself.
        // A named refusal keeps the host and on-device shapes identical (REQ-A637).
        Err(biometric_no_activity())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public install entry
// ─────────────────────────────────────────────────────────────────────────────

/// Install the device glue binding.
///
/// **Nothing calls this** (REQ-A832): the doc here used to say "called from MainActivity.onStart
/// via JNI", and that is not true — the live boot path is Kotlin's
/// `BluetoothGattGlue.nativeInstall` → `Java_com_amos_ai_glue_BluetoothGattGlue_nativeInstall`
/// (`jni_glue.rs`), which calls `jni_glue::init()`, plus `lib.rs`'s `setup`. Both of the things
/// this wraps (`android_jni::install`, `glue_state::init`) are reached there, so the states are
/// armed and no device behaviour depends on this entry point. Kept as the Rust-side install entry
/// (recorded in `scripts/rust-unwired-baseline.json` as `library-surface`) rather than deleted,
/// because a Rust call site may still want it; a `pub fn` documented as called when it is not is
/// the shape this workspace's audits keep finding.
#[cfg(feature = "android")]
pub fn install_glue(
    env: &mut ::jni::JNIEnv<'_>,
    context: jni::objects::JObject<'_>,
) -> Result<(), String> {
    android_jni::install(env, context)?;
    glue_state::init();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    /// Every glue class is resolved through the **app's** loader, never named at the call site.
    ///
    /// `call_static_method(<&str class name>, …)` **is** a `find_class`, and `find_class` uses the
    /// *calling thread's* loader — the bootstrap one on the tokio worker every `async` command in
    /// this file runs on, which cannot see `com.amos.ai.glue.*`. Measured on the attached handset
    /// (2026-09-26): `ble_discover_services` answered 「BluetoothGattGlue not bound」 — which is
    /// `with_context` folding the `ClassNotFoundException` into `None` (a genuinely unbound glue
    /// would answer `0` ⇒ 「the platform refused discoverServices」) — while the *sync*
    /// `ble_disconnect`, naming the same class, ran. Pinned at the Rust **source** because a host
    /// has no class loader to be the wrong one, so no unit test can run the resolution at all
    /// (REQ-A1867 ∕ F-AND-017).
    #[test]
    fn the_glue_classes_are_resolved_through_the_context_and_never_named() {
        const SOURCE: &str = include_str!("ble.rs");
        // Every needle below is assembled from pieces: the workspace's JNI gates scan this file
        // **including its tests**, so a needle spelled out whole would itself be read as the
        // production call site it searches for (the same reason `screen_record_android.rs`
        // splits its needle). `jni-exception-scan` rule 3 and `jni-contract-scan` R1 both key on
        // a contiguous token.
        let call_token = concat!("call_static_", "method(");
        let glue_root = concat!("com.amos.ai.", "glue.");

        for name in ["BLE_CLASS", "NFC_CLASS", "BIOMETRIC_CLASS"] {
            let by_name = format!("{call_token}android_jni::{name}");
            assert!(
                !SOURCE.contains(&by_name),
                "the glue class must not be resolved by name on the command thread (REQ-A1867): {by_name}"
            );
            let resolver = format!("glue_class(env, ctx, android_jni::{name})");
            assert!(
                SOURCE.contains(&resolver),
                "every glue call must resolve through the app's loader: {resolver}"
            );
        }

        // The name `resolve_class` receives is a **binary** name: it is handed verbatim to
        // `ClassLoader#loadClass`, so the slashed JNI spelling the call sites used before would
        // fold into the very "not bound" sentence this fix exists to undo.
        for (name, leaf) in [
            ("BLE_CLASS", "BluetoothGattGlue"),
            ("NFC_CLASS", "NfcGlue"),
            ("BIOMETRIC_CLASS", "BiometricGlue"),
        ] {
            let decl = format!("const {name}: &str = \"{glue_root}{leaf}\"");
            assert!(
                SOURCE.contains(&decl),
                "the name handed to ClassLoader#loadClass must be dotted: {decl}"
            );
        }

        // The four `arm_*` waiters fire a JNI call and match its answer. They must bind the
        // **honest** sibling — `with_context` folds *any* failure into `None`, and these arms
        // fold `None` into a factual-sounding sentence, so the device round behind REQ-A1867
        // read a `ClassNotFoundException` as 「the glue is not bound」. Only the guard where
        // nothing was ever asked (`BLE_GATT_STATE` unset) may still say "not bound".
        let folding = concat!("let started = android_jni::with_context", "(");
        let honest = concat!("let started = android_jni::with_context", "_result(");
        assert_eq!(
            SOURCE.matches(folding).count(),
            0,
            "a failed JNI call must not be folded into an answer the platform never gave (REQ-A1877)"
        );
        assert_eq!(
            SOURCE.matches(honest).count(),
            4,
            "all four awaited JNI calls must report their own failure: {honest}"
        );
    }

    /// The JNI binding that every BLE / NFC / biometric command reads is installed by
    /// exactly **one** Kotlin call — `BluetoothGattGlue.install(this)` → `nativeInstall` →
    /// `ble::android_jni::BINDING.set(..)` (REQ-A1864 / F-DEV-158). Nothing else in the
    /// repository constructs that binding.
    ///
    /// The generated Activity is git-ignored, so on a clean checkout the APK can ship the
    /// whole compiled glue and bind none of it — with both sides green, because the
    /// binding's absence is not a compile error and the Rust command that would notice it
    /// only runs on a device. Measured 2026-09-26 on the attached phone: no
    /// `Rust JNI binding installed` line in logcat, and the installed bridge (a build
    /// predating REQ-A775) was folding the unbound answer into `no_hardware`.
    ///
    /// So the two **tracked** artifacts that can keep it wired are pinned together: the
    /// wiring template a human copies from, and the shell gate that refuses a build whose
    /// Activity does not call it. Dropping the call from both is what let this happen.
    #[test]
    fn the_jni_binding_bootstrap_is_an_instruction_the_template_and_the_gate_both_carry() {
        const TEMPLATE: &str =
            include_str!("../android-glue/com/amos/ai/glue/MainActivity.Wiring.kt");
        assert!(
            TEMPLATE.contains("BluetoothGattGlue.install(this)"),
            "MainActivity.Wiring.kt must keep instructing the BLE/NFC/biometric bootstrap in \
             `onStart` — it is the only tracked place a re-generation is told to copy it from"
        );

        const GATE: &str = include_str!("../../../scripts/android-activity-wiring-check.sh");
        let required = GATE
            .split_once("REQUIRED=(")
            .and_then(|(_, rest)| rest.split_once("\n)"))
            .map(|(body, _)| body)
            .expect("the wiring check must declare a REQUIRED=( ... ) list");
        assert!(
            required.contains("BluetoothGattGlue.install("),
            "android-activity-wiring-check.sh must REQUIRE BluetoothGattGlue.install(: a gate \
             that does not name the bootstrap cannot refuse a build that binds nothing"
        );
    }

    /// The waiter's payload becomes the screen's services **with** their characteristics and
    /// property bits — the bits the screen's three controls are gated on. Losing them here would
    /// send the screen back to "every action looks available until the device refuses it", and
    /// nothing else in the chain would notice (REQ-A1198 / F-SH-487).
    #[cfg(feature = "android")]
    #[test]
    fn every_discovered_characteristic_and_its_property_bits_reach_the_screen() {
        let out = services_for_screen(vec![
            crate::jni_glue::ServiceInfo {
                uuid: "180d".into(),
                characteristics: vec![
                    crate::jni_glue::CharacteristicInfo {
                        uuid: "2a37".into(),
                        properties: 0x10,
                    },
                    crate::jni_glue::CharacteristicInfo {
                        uuid: "2a38".into(),
                        properties: 0x02,
                    },
                ],
            },
            // A service the platform reported with no characteristics is an **empty** list on
            // the wire, not a missing field: the screen reads `.length` on it.
            crate::jni_glue::ServiceInfo {
                uuid: "180f".into(),
                characteristics: vec![],
            },
        ]);

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].uuid, "180d");
        assert_eq!(out[0].characteristics.len(), 2);
        assert_eq!(out[0].characteristics[0].uuid, "2a37");
        assert_eq!(out[0].characteristics[0].properties, 0x10);
        assert_eq!(out[0].characteristics[1].properties, 0x02);
        assert!(out[1].characteristics.is_empty());
    }

    /// Three facts the screen must render differently, folded apart: the platform's list, a
    /// payload it sent that could not be read, and a discovery that was superseded.
    ///
    /// The middle one is the defect (REQ-A1198 / F-SH-488): it used to fold into `ok: true` with
    /// an empty `services`, which the screen draws as "this device advertises no services" — a
    /// claim about the device made from a claim about our parsing.
    #[test]
    fn an_unreadable_payload_is_not_the_same_answer_as_a_device_with_no_services() {
        let one = BleService {
            uuid: "180d".into(),
            characteristics: vec![BleCharacteristic {
                uuid: "2a37".into(),
                properties: 0x10,
            }],
        };

        let listed = discovery_answer(Ok(Ok(vec![one.clone()])));
        assert!(listed.ok);
        assert_eq!(listed.services.len(), 1);
        assert_eq!(listed.services[0].characteristics[0].properties, 0x10);
        assert!(listed.error.is_none());

        // A device that genuinely has no services: `ok: true`, an empty list, no reason.
        let empty = discovery_answer(Ok(Ok(Vec::new())));
        assert!(empty.ok, "an empty device is a successful answer");
        assert!(empty.services.is_empty());

        let unreadable = discovery_answer(Ok(Err(
            "the platform's service list could not be read: expected value".into(),
        )));
        assert!(
            !unreadable.ok,
            "a payload we could not read is not a device with no services"
        );
        assert!(unreadable.services.is_empty());
        assert_eq!(
            unreadable.error.as_deref(),
            Some("the platform's service list could not be read: expected value")
        );

        let superseded = discovery_answer(Err(()));
        assert!(!superseded.ok);
        assert!(
            superseded
                .error
                .as_deref()
                .is_some_and(|e| e.contains("superseded")),
            "a superseded discovery keeps its own words"
        );
    }

    /// REQ-A637 / F-SH-109. `error.rs` declared `NfcNotInitialized` with the trigger
    /// "the glue was not initialized (no Activity has run `onStart`)", but no code path
    /// emitted it: `nfc_write_message` answered an unbound glue with
    /// `Ok(NfcWriteResult { ok: false, error: "NfcGlue not bound" })`, which is
    /// indistinguishable from the tag refusing a write. This asserts the *typed refusal*
    /// — a reverted `Ok(..)` makes `unwrap_err()` panic, so the test discriminates.
    #[test]
    fn nfc_write_message_refuses_an_unbound_glue_with_the_declared_code() {
        let err = nfc_write_message(vec![NdefRecord {
            tnf: 1,
            r#type: "T".to_string(),
            payload: "02656e".to_string(),
            id: String::new(),
        }])
        .expect_err("an unbound NFC glue must refuse, not return an Ok payload");
        assert_eq!(err.code, ErrorCode::NfcNotInitialized);
        assert_eq!(err.code(), "amos.nfc.not_initialized");
        // The refusal carries a diagnostic, not an empty string (a bare code the UI
        // cannot log is the "declared but unestablished" failure this round fixes).
        assert!(!err.message.is_empty(), "the refusal must explain itself");
        // Negative control for the whole family: the one *wired* sibling code proves
        // this is a real vocabulary and not a coincidence of naming.
        assert_ne!(err.code, ErrorCode::BleConnectFailed);
    }

    /// REQ-A637 / F-SH-109, biometric twin. The declared `BiometricNoActivity` trigger is
    /// "called without an Activity-bound prompt"; off-device that condition always holds,
    /// so the host build answers with the named refusal — and this is the only test that
    /// can exercise it (the JNI branch is behind `--features android`).
    #[tokio::test]
    async fn biometric_authenticate_refuses_without_an_activity_bound_prompt() {
        let err = biometric_authenticate("unlock".to_string(), false)
            .await
            .expect_err("no Activity-bound prompt exists off-device — must refuse");
        assert_eq!(err.code, ErrorCode::BiometricNoActivity);
        assert_eq!(err.code(), "amos.biometric.no_activity");
        assert!(!err.message.is_empty(), "the refusal must explain itself");
    }

    /// The two codes this round wired are distinct, so a copy-paste that made the
    /// biometric helper return the NFC code (or vice versa) fails here rather than
    /// silently mislabeling every refusal.
    #[test]
    fn the_two_wired_refusals_are_distinct() {
        assert_ne!(nfc_not_initialized().code, biometric_no_activity().code);
        assert_ne!(nfc_not_initialized().code(), biometric_no_activity().code());
    }

    /// REQ-A1157 / F-SH-458. When the bridge cannot answer, discovery and write must say so —
    /// never present an **empty** service list as a device fact, and never report a write as
    /// done. The old `ble_discover_services` returned `Ok(vec![])` on this build, which reads
    /// downstream as "the device advertises no services".
    ///
    /// Runs in both configurations, so the assertion is on the *shape* (a payload whose `ok`
    /// is false and which carries a non-empty reason), not on one build's wording: on host the
    /// reason is "BLE not available"; under `--features android` it is the unbound-glue reason.
    #[tokio::test]
    async fn the_ble_bridge_reports_its_own_ignorance_instead_of_an_empty_answer() {
        let d = ble_discover_services()
            .await
            .expect("the bridge answers with a payload, not a transport error");
        assert!(!d.ok, "an unavailable bridge must not claim a service list");
        assert!(d.services.is_empty());
        assert!(
            d.error.as_deref().is_some_and(|e| !e.is_empty()),
            "the failure must carry a reason the screen can show"
        );

        let w = ble_write("180d".into(), "2a37".into(), vec![1], true)
            .await
            .expect("the bridge answers with a payload, not a transport error");
        assert!(
            !w.ok,
            "an unavailable bridge must not report a completed write"
        );
        assert!(
            w.error.as_deref().is_some_and(|e| !e.is_empty()),
            "the failure must carry a reason the screen can show"
        );
    }

    /// REQ-A1158 / F-SH-459. `ble_connect` must never report a connection it did not get, and
    /// `ble_read` must never report a value it did not read. Both used to answer from the
    /// *request* rather than the stack's verdict (a client object was created ⇒ 「已连接」; a
    /// read was queued ⇒ a value slot that was always empty).
    ///
    /// Shape-only again, so it runs in both configurations: on host the reason is "BLE not
    /// available"; under `--features android` the unbound glue makes `ble_connect` refuse with
    /// `BleConnectFailed`. What must hold in **both** is that neither ever fabricates success.
    #[tokio::test]
    async fn connect_and_read_never_fabricate_a_verdict_they_did_not_get() {
        let c = ble_connect("AA:BB:CC:DD:EE:FF".into()).await;
        assert!(
            !matches!(c, Ok(true)),
            "an unavailable bridge must never report a live connection"
        );

        let r = ble_read("180d".into(), "2a37".into())
            .await
            .expect("the bridge answers with a payload, not a transport error");
        assert!(!r.ok, "an unavailable bridge must not report a read value");
        assert!(
            r.error.as_deref().is_some_and(|e| !e.is_empty()),
            "the failure must carry a reason the screen can show"
        );
    }

    /// REQ-A1158 / F-SH-459. A subscription is only real once the **device** acknowledged the CCC
    /// descriptor write that turns notifications on. With no bridge at all neither half can have
    /// happened, so `ble_subscribe` must answer `false`; `ble_unsubscribe` asking about a
    /// notification stream that was never established is vacuously satisfied, so it may answer
    /// `true` — what neither may do is claim a subscription the device never agreed to.
    #[tokio::test]
    async fn subscribe_never_fabricates_a_verdict_it_did_not_get() {
        let s = ble_subscribe("180d".into(), "2a37".into())
            .await
            .expect("the bridge answers with a payload, not a transport error");
        assert!(
            !s,
            "an unavailable bridge must never report a live subscription"
        );

        let u = ble_unsubscribe("180d".into(), "2a37".into())
            .await
            .expect("the bridge answers with a payload, not a transport error");
        // With no bridge, neither the local registration nor the descriptor write happened, so
        // there is no subscription to release: both halves answer `false`. (The vacuous
        // "no CCC ⇒ disabling is already satisfied" branch only fires with a bound glue.)
        assert!(
            !u,
            "an unavailable bridge must not report a subscription to release"
        );
    }

    // ── REQ-A775 / F-AND-007: the adapter-state fold ────────────────────────────
    //
    // `nfc_status` is `feature = "android"`, so off-device the only thing that can be
    // pinned is the fold itself. That is the whole defect, though: the JNI call was
    // never the problem — mapping its *five* outcomes onto one is.

    /// The glue's own three answers survive verbatim. Ordered so a fold that collapsed
    /// two of them (e.g. `disabled` → `no_hardware`, the exact shape of the bug) fails
    /// on the pair rather than passing by accident.
    #[test]
    fn the_platforms_own_three_answers_are_kept() {
        for (json, want) in [
            (r#"{"available":true,"state":"enabled"}"#, NfcState::Enabled),
            (
                r#"{"available":true,"state":"disabled"}"#,
                NfcState::Disabled,
            ),
            (
                r#"{"available":false,"state":"no_hardware"}"#,
                NfcState::NoHardware,
            ),
        ] {
            let (state, detail) = nfc_state_from(Ok(json.to_string()));
            assert_eq!(
                state, want,
                "NfcGlue's own state must reach the caller unchanged"
            );
            // The platform answered for itself, so this side has nothing to explain.
            assert_eq!(detail, None, "{json} is the platform's answer, not a guess");
        }
    }

    /// **The defect.** Every way the question could fail must land on `Unavailable`,
    /// and *only* `NoHardware` may claim a hardware fact — so the assertion is
    /// two-sided: the five failures agree with each other, and all five differ from
    /// the one state that is allowed to say "no NFC hardware".
    #[test]
    fn every_way_the_question_can_fail_is_unavailable_never_no_hardware() {
        let failures: [(&str, Result<String, String>); 5] = [
            (
                "no glue bound",
                Err("no Android Context has been bound".to_string()),
            ),
            (
                "a JNI exception (SecurityException with no declared permission)",
                Err("java.lang.SecurityException: ...".to_string()),
            ),
            (
                "a reply that is not JSON",
                Ok("<html>500</html>".to_string()),
            ),
            (
                "a reply with no `state` field",
                Ok(r#"{"available":true}"#.to_string()),
            ),
            (
                "a state word this side does not know",
                Ok(r#"{"available":true,"state":"radio_on"}"#.to_string()),
            ),
        ];
        for (what, reply) in failures {
            let (state, detail) = nfc_state_from(reply);
            assert_eq!(
                state,
                NfcState::Unavailable,
                "{what} must not be reported as a hardware fact"
            );
            assert_ne!(
                state,
                NfcState::NoHardware,
                "{what}: 'this device has no NFC hardware' is a claim only the platform may make"
            );
            let detail = detail.expect("this side decided the state, so it must say why");
            assert!(!detail.is_empty(), "{what}: the reason must be readable");
        }
    }

    /// The flag is derived, so it cannot contradict the state: `available` is true for
    /// exactly the two states in which an adapter exists, and false for *both* "no
    /// hardware" and "could not ask" — which is precisely why the UI must branch on
    /// `state` and not on `available`.
    #[test]
    fn available_is_derived_from_the_state_and_never_reads_as_a_hardware_claim() {
        let enabled = NfcStatusResult::from_state(NfcState::Enabled, None);
        let disabled = NfcStatusResult::from_state(NfcState::Disabled, None);
        let none = NfcStatusResult::from_state(NfcState::NoHardware, None);
        let unknown = NfcStatusResult::from_state(NfcState::Unavailable, Some("bound?".into()));
        assert!(enabled.available && disabled.available);
        assert!(!none.available && !unknown.available);
        assert_eq!(none.state, NfcState::NoHardware);
        assert_eq!(unknown.state, NfcState::Unavailable);
        // A platform answer carries no `detail` even when one was handed in: the field
        // exists for this side's own uncertainty, and a stale reason beside a definite
        // state is how a UI ends up explaining a cause that is not the cause.
        assert_eq!(
            NfcStatusResult::from_state(NfcState::Enabled, Some("stale".into())).detail,
            None
        );
        assert_eq!(unknown.detail.as_deref(), Some("bound?"));
    }

    /// The wire spellings are the contract the WebView branches on
    /// (`NfcApp.svelte` → `stateKey`). Pinned here because a rename is silent: the
    /// screen's `stateKey` would fall through to its unknown-state wording and print
    /// the wrong sentence for every adapter state at once.
    #[test]
    fn the_wire_spellings_are_the_kebab_case_ones_the_webview_branches_on() {
        let wire =
            |s: NfcState| serde_json::to_value(NfcStatusResult::from_state(s, None)).unwrap();
        assert_eq!(wire(NfcState::Enabled)["state"], "enabled");
        assert_eq!(wire(NfcState::Disabled)["state"], "disabled");
        assert_eq!(wire(NfcState::NoHardware)["state"], "no-hardware");
        assert_eq!(wire(NfcState::Unavailable)["state"], "unavailable");
    }

    // ── Reading a tag (REQ-A781 / F-AND-009) ─────────────────────────────────────────────
    //
    // `nfc_read_bytes` is `feature = "android"`, so off-device the fold is what can be pinned
    // — and the fold *is* the defect: four different outcomes used to arrive as one `None`,
    // which the screen worded as the tag's own "no bytes".

    /// **The defect.** The four answers the read used to fold together stay apart, and the two
    /// that are easiest to confuse — "the tag was read and holds nothing" and "the read failed"
    /// — are asserted *against each other*, because reporting the first as the second is what
    /// shipped.
    #[test]
    fn the_four_answers_the_read_used_to_fold_together_stay_apart() {
        let bytes = nfc_read_from(Ok(
            r#"{"state":"bytes","id":"aa11","hex":"deadbeef"}"#.into()
        ));
        assert_eq!(bytes.state, NfcReadState::Bytes);
        assert_eq!(bytes.hex.as_deref(), Some("deadbeef"));
        assert_eq!(bytes.tag_id.as_deref(), Some("aa11"));

        let empty = nfc_read_from(Ok(r#"{"state":"empty","id":"aa11","hex":null}"#.into()));
        assert_eq!(empty.state, NfcReadState::Empty);
        assert_eq!(empty.tag_id.as_deref(), Some("aa11"));

        let no_tag = nfc_read_from(Ok(r#"{"state":"no-tag","id":null,"hex":null}"#.into()));
        assert_eq!(no_tag.state, NfcReadState::NoTag);

        let failed = nfc_read_from(Ok(
            r#"{"state":"failed","id":"aa11","error":"TagLostException"}"#.into(),
        ));
        assert_eq!(failed.state, NfcReadState::Failed);
        assert_eq!(failed.detail.as_deref(), Some("TagLostException"));

        // Pairwise: a fold that merged any two of these fails here rather than silently
        // choosing one sentence for both.
        let all = [
            bytes.state,
            empty.state,
            no_tag.state,
            failed.state,
            NfcReadState::Unavailable,
        ];
        for (i, a) in all.iter().enumerate() {
            for b in all[i + 1..].iter() {
                assert_ne!(a, b, "two different read outcomes share a state");
            }
        }
        assert_eq!(bytes.state, NfcReadState::Bytes);
    }

    /// The sentence the user actually read. `nfc.readFailed` says the *system returned no tag
    /// bytes*, so this is the case that was a false statement: the tag was read, it simply
    /// carries no NDEF message, and the screen has a separate word for that — which no
    /// producer could reach while the read answered `String?`.
    #[test]
    fn a_tag_that_was_read_and_holds_nothing_is_not_a_failed_read() {
        let empty = nfc_read_from(Ok(r#"{"state":"empty","id":"aa11"}"#.into()));
        assert_eq!(empty.state, NfcReadState::Empty);
        assert_ne!(
            empty.state,
            NfcReadState::Failed,
            "a successful read of a tag with no payload must not be reported as a failed read"
        );
        // A zero-length payload is likewise a read that happened, and it must carry the empty
        // string rather than nothing — `Some("")` is what renders the screen's `nfc.readEmpty`.
        let zero = nfc_read_from(Ok(r#"{"state":"bytes","id":"aa11","hex":""}"#.into()));
        assert_eq!(zero.state, NfcReadState::Bytes);
        assert_eq!(zero.hex.as_deref(), Some(""));
    }

    /// Every way the question can fail to be *answered* lands on `Unavailable`, and none of
    /// them is a claim about the tag: not `Empty` ("this tag holds nothing"), not `NoTag`
    /// ("nothing is in the field"), not `Failed` ("the read threw") and certainly not `Bytes`.
    #[test]
    fn every_way_the_read_question_can_fail_is_unavailable_never_a_tag_fact() {
        let failures: [(&str, Result<String, String>); 6] = [
            (
                "the glue is not bound",
                Err("no Android Context has been bound".to_string()),
            ),
            (
                "a JNI exception",
                Err("java.lang.SecurityException: ...".to_string()),
            ),
            (
                "a reply that is not JSON",
                Ok("<html>500</html>".to_string()),
            ),
            (
                "a reply with no `state` field",
                Ok(r#"{"id":"aa11"}"#.to_string()),
            ),
            (
                "a state word this side does not know",
                Ok(r#"{"state":"calibrating"}"#.to_string()),
            ),
            (
                "`bytes` with no `hex` to show",
                Ok(r#"{"state":"bytes","id":"aa11"}"#.to_string()),
            ),
        ];
        for (what, reply) in failures {
            let r = nfc_read_from(reply);
            assert_eq!(r.state, NfcReadState::Unavailable, "{what}");
            assert_ne!(r.state, NfcReadState::Empty, "{what}: the tag said nothing");
            assert_ne!(
                r.state,
                NfcReadState::NoTag,
                "{what}: nothing said it was in the field"
            );
            assert_eq!(r.hex, None, "{what}: there are no bytes to show");
            assert_eq!(
                r.tag_id, None,
                "{what}: no tag was read, so none may be named"
            );
            let detail = r
                .detail
                .expect("this side decided the state, so it must say why");
            assert!(!detail.is_empty(), "{what}: the reason must be readable");
        }
    }

    /// The other half: the read names the tag it read, and says nothing when it read nothing.
    /// The screen compares this with the tag the user selected — the glue can only act on the
    /// last tag it saw, so without this field the hex of one tag renders under another's name.
    #[test]
    fn the_read_reports_which_tag_it_read_and_only_when_it_read_one() {
        for (json, want_id) in [
            (r#"{"state":"bytes","id":"aa11","hex":"00"}"#, Some("aa11")),
            (r#"{"state":"empty","id":"aa11"}"#, Some("aa11")),
            (
                r#"{"state":"failed","id":"aa11","error":"TagLostException"}"#,
                Some("aa11"),
            ),
            (r#"{"state":"no-tag","id":null}"#, None),
            (
                r#"{"state":"failed","id":null,"error":"TagLostException"}"#,
                None,
            ),
        ] {
            let r = nfc_read_from(Ok(json.to_string()));
            assert_eq!(r.tag_id.as_deref(), want_id, "{json}");
        }
    }

    /// The wire spellings are the contract the WebView branches on (`lib/nfc.ts`'s
    /// `NfcReadStateWire` → `nfcReadNoticeKey` → both locale dictionaries). Pinned here
    /// because a rename is silent: the screen's `default` arm would word every non-answer
    /// as "the adapter could not be read" and no test would notice.
    #[test]
    fn the_read_wire_spellings_are_the_kebab_case_ones_the_webview_branches_on() {
        let wire = |r: NfcReadResult| serde_json::to_value(r).unwrap();
        assert_eq!(
            wire(nfc_read_from(Ok(r#"{"state":"bytes","hex":"00"}"#.into())))["state"],
            "bytes"
        );
        assert_eq!(
            wire(nfc_read_from(Ok(r#"{"state":"empty"}"#.into())))["state"],
            "empty"
        );
        assert_eq!(
            wire(nfc_read_from(Ok(r#"{"state":"no-tag"}"#.into())))["state"],
            "no-tag"
        );
        assert_eq!(
            wire(nfc_read_from(
                Ok(r#"{"state":"failed","error":"e"}"#.into())
            ))["state"],
            "failed"
        );
        assert_eq!(
            wire(nfc_read_from(Err("host".into())))["state"],
            "unavailable"
        );
    }

    /// The command itself, off-device: the host build answers `Unavailable` carrying its own
    /// words — **not** `Ok(None)`, which the screen rendered as the tag's answer. Runs under
    /// `--features android` too (there is no binding there either, so the fold lands on the
    /// same state), which is why the detail's *content* is not asserted.
    #[test]
    fn nfc_read_bytes_off_device_reports_unavailable_with_its_own_words() {
        let r = nfc_read_bytes("aa11".to_string()).expect("the query itself cannot fail");
        assert_eq!(r.state, NfcReadState::Unavailable);
        assert_ne!(r.state, NfcReadState::NoTag);
        assert_eq!(r.hex, None);
        assert_eq!(r.tag_id, None);
        assert!(
            !r.detail.unwrap_or_default().is_empty(),
            "the caller must be told this side could not ask, not that the tag is empty"
        );
    }

    // ── Biometric availability (REQ-A779 / F-AND-008) ────────────────────────────────────
    //
    // `biometric_available` is `feature = "android"`, so off-device the fold is what can be
    // pinned — and the fold is the defect: five ways to fail, all of which used to arrive as
    // `hardware_present: false`, i.e. "this device has no biometrics".

    /// The glue's five determinate answers survive verbatim, and the two that mean opposite
    /// things about the hardware stay opposite. Ordered as pairs so a fold that swapped
    /// `no-hardware` with `not-enrolled` fails on the pair rather than passing by accident
    /// — that exchange is exactly what the Kotlin side shipped.
    #[test]
    fn the_platforms_own_answers_are_kept_and_not_exchanged() {
        let cases: [(&str, i32, BiometricDeviceState, Option<bool>, bool); 4] = [
            (
                "enrolled",
                0,
                BiometricDeviceState::Enrolled,
                Some(true),
                true,
            ),
            (
                "not-enrolled",
                11,
                BiometricDeviceState::NotEnrolled,
                Some(true),
                false,
            ),
            (
                "hw-unavailable",
                1,
                BiometricDeviceState::HwUnavailable,
                Some(true),
                false,
            ),
            (
                "no-hardware",
                12,
                BiometricDeviceState::NoHardware,
                Some(false),
                false,
            ),
        ];
        for (state, code, want_state, want_hw, want_enrolled) in cases {
            let json = format!(
                r#"{{"state":"{state}","can_authenticate":{code},"kind":"fingerprint","label":"指纹"}}"#
            );
            let a = biometric_availability_from(Ok(json.clone()));
            assert_eq!(
                a.state, want_state,
                "{json}: the glue's state must arrive unchanged"
            );
            assert_eq!(
                a.hardware_present, want_hw,
                "{json}: the hardware answer is the code's"
            );
            assert_eq!(a.enrolled, want_enrolled, "{json}");
            assert_eq!(
                a.can_authenticate,
                Some(code),
                "{json}: the raw code is carried"
            );
            // The platform answered for itself, so this side has nothing to explain.
            assert_eq!(
                a.detail, None,
                "{json} is the platform's answer, not a guess"
            );
        }
        // The two that must never be confused, stated once more as a pair.
        let none = biometric_availability_from(Ok(r#"{"state":"no-hardware"}"#.to_string()));
        let empty = biometric_availability_from(Ok(r#"{"state":"not-enrolled"}"#.to_string()));
        assert_eq!(none.hardware_present, Some(false));
        assert_eq!(empty.hardware_present, Some(true));
    }

    /// `unknown` is the platform declining to answer. It must not be rounded to `false`:
    /// `hardware_present: None` is the only representation that cannot be read as a claim.
    #[test]
    fn a_code_that_answers_nothing_is_neither_present_nor_absent() {
        let a = biometric_availability_from(Ok(
            r#"{"state":"unknown","can_authenticate":15}"#.to_string()
        ));
        assert_eq!(a.state, BiometricDeviceState::Unknown);
        assert_eq!(
            a.hardware_present, None,
            "15 (SECURITY_UPDATE_REQUIRED) is not a 'no sensor'"
        );
        assert!(!a.enrolled);
        assert_eq!(a.can_authenticate, Some(15));
        // A state we cannot classify names no sensor kind either — the feature flags say what
        // the device *has*, and that is exactly what we just failed to learn.
        assert_eq!(a.kind, "none");
    }

    /// **The defect.** Every way the question can fail lands on `Unavailable` with a reason,
    /// and none of them claims a hardware fact — the assertion is two-sided: the failures
    /// agree with each other, and all of them differ from the one state allowed to say
    /// "no sensor".
    #[test]
    fn every_way_the_biometric_question_can_fail_is_unavailable_never_no_hardware() {
        let failures: [(&str, Result<String, String>); 6] = [
            (
                "no glue bound (no Android Context)",
                Err(
                    "no Android Context has been bound (MainActivity.onStart has not run)"
                        .to_string(),
                ),
            ),
            (
                "a thread that could not attach",
                Err("thread not attached: ...".to_string()),
            ),
            (
                "a JNI exception",
                Err("java.lang.SecurityException: ...".to_string()),
            ),
            (
                "a glue class that would not resolve",
                Err("java.lang.NoSuchMethodError: no static method getAvailability".to_string()),
            ),
            (
                "a reply that is not JSON",
                Ok("<html>500</html>".to_string()),
            ),
            (
                "a state word this side does not know",
                Ok(r#"{"state":"fingerprint_locked"}"#.to_string()),
            ),
        ];
        for (what, reply) in failures {
            let a = biometric_availability_from(reply);
            assert_eq!(
                a.state,
                BiometricDeviceState::Unavailable,
                "{what} must not be reported as a hardware fact"
            );
            assert_ne!(
                a.state,
                BiometricDeviceState::NoHardware,
                "{what}: 'this device has no biometric sensor' is a claim only the platform may make"
            );
            assert_eq!(
                a.hardware_present, None,
                "{what}: 'we could not ask' must not be serialized as 'there is none'"
            );
            assert!(!a.enrolled, "{what}");
            let detail = a
                .detail
                .expect("this side decided the state, so it must say why");
            assert!(!detail.is_empty(), "{what}: the reason must be readable");
        }
        // A reply with no `state` field at all is the same family.
        let no_state = biometric_availability_from(Ok(r#"{"enrolled":true}"#.to_string()));
        assert_eq!(no_state.state, BiometricDeviceState::Unavailable);
        assert_eq!(no_state.hardware_present, None);
    }

    /// The two booleans are derived from `state`, so they cannot contradict it — and the
    /// *derivation* is asserted in both directions, because the bug was two fields that
    /// could disagree.
    #[test]
    fn enrolled_and_hardware_present_are_derived_from_the_state() {
        for (state, hw, enrolled) in [
            (BiometricDeviceState::Enrolled, Some(true), true),
            (BiometricDeviceState::NotEnrolled, Some(true), false),
            (BiometricDeviceState::HwUnavailable, Some(true), false),
            (BiometricDeviceState::NoHardware, Some(false), false),
            (BiometricDeviceState::Unknown, None, false),
            (BiometricDeviceState::Unavailable, None, false),
        ] {
            assert_eq!(state.hardware_present(), hw, "{state:?}");
            // Built from serde's own spelling, so this test cannot pass on a spelling the
            // wire does not actually use.
            let spelling = serde_json::to_value(state).unwrap();
            let a = biometric_availability_from(Ok(format!(r#"{{"state":{spelling}}}"#)));
            assert_eq!(a.hardware_present, hw, "{state:?}: derived, then carried");
            assert_eq!(a.enrolled, enrolled, "{state:?}: derived, then carried");
            assert!(
                !(a.enrolled && a.hardware_present != Some(true)),
                "{state:?}: enrolled implies the sensor is there"
            );
        }
        assert!(BiometricDeviceState::Enrolled.is_ready());
        assert!(!BiometricDeviceState::NotEnrolled.is_ready());
    }

    /// The wire spellings are the contract the WebView branches on
    /// (`LockPage.svelte` → the four `bio*` predicates) and that the Kotlin glue emits.
    /// `scripts/biometric-glue-const-scan.mjs` is the other half of the ratchet.
    #[test]
    fn biometric_wire_spellings_are_the_kebab_case_ones_the_glue_emits() {
        let wire = |s: BiometricDeviceState| serde_json::to_value(s).unwrap();
        assert_eq!(wire(BiometricDeviceState::Enrolled), "enrolled");
        assert_eq!(wire(BiometricDeviceState::NotEnrolled), "not-enrolled");
        assert_eq!(wire(BiometricDeviceState::HwUnavailable), "hw-unavailable");
        assert_eq!(wire(BiometricDeviceState::NoHardware), "no-hardware");
        assert_eq!(wire(BiometricDeviceState::Unknown), "unknown");
        assert_eq!(wire(BiometricDeviceState::Unavailable), "unavailable");
    }

    /// The host build answers "I am not an Android device", not "there is no sensor".
    #[test]
    fn the_host_build_reports_its_own_ignorance() {
        let a = biometric_availability_from(Err(
            "this build has no Android biometric glue (host/desktop target)".to_string(),
        ));
        assert_eq!(a.state, BiometricDeviceState::Unavailable);
        assert_eq!(a.hardware_present, None);
        assert!(a.detail.as_deref().unwrap_or("").contains("host"));
    }
}
