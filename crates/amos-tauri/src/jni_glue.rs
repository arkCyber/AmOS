//! JNI bridge layer for Kotlin glue callbacks (feature `android`).
//!
//! Provides JNI upcall handlers for:
//! - [`BluetoothGattGlue`] — BLE GATT connect/read/write/subscribe callbacks
//! - [`NfcGlue`] — NFC tag discovery events
//! - [`BiometricGlue`] — biometric auth result callbacks
//!
//! ## Thread safety
//! Kotlin callbacks fire on Binder/main threads. All Rust state is guarded by
//! `Mutex`/`RwLock`. Results are stored in atomic state cells so synchronous
//! `#[tauri::command]` calls can read them after the JNI call returns.
//!
//! ## Architecture
//! ```
//! [Kotlin Glue] --JNI--> [jni_glue.rs] --Tauri Event--> [WebView frontend]
//! ```
//! The Tauri event emitter is set up in `lib.rs::setup` when `SensorHost` is
//! configured. Until then every callback is a quiet no-op.

#![cfg(feature = "android")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

// ─────────────────────────────────────────────────────────────────────────────
//  BLE GATT state
// ─────────────────────────────────────────────────────────────────────────────

/// One discovered GATT service.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServiceInfo {
    pub uuid: String,
}

/// BLE GATT connection state.
pub struct BleGattState {
    pub connected: Mutex<bool>,
    pub services: Mutex<Vec<ServiceInfo>>,
    /// In-flight GATT **reads**, keyed by characteristic UUID.
    ///
    /// A read is asynchronous: Kotlin starts it and the value arrives later in
    /// `onCharacteristicReadResult` on a Binder thread, so `ble_read` arms a `oneshot::Sender`
    /// here *before* it asks for the read and awaits the matching receiver.
    ///
    /// Keying by UUID is the whole point (REQ-A413). The old shape was a single
    /// `Mutex<Option<(String, Vec<u8>)>>` slot that the command drained while **discarding the
    /// UUID it read off it**, so (a) two reads in flight overwrote each other's answer and
    /// (b) a value could be handed to a caller that had asked for a different characteristic —
    /// a wrong reading attributed to the wrong sensor. A map makes each waiter's answer its own.
    pub pending_reads: Mutex<HashMap<String, oneshot::Sender<Vec<u8>>>>,
    pub pending_notification: Mutex<Option<(String, Vec<u8>)>>, // (uuid, value)
}

impl BleGattState {
    pub fn new() -> Self {
        Self {
            connected: Mutex::new(false),
            services: Mutex::new(Vec::new()),
            pending_reads: Mutex::new(HashMap::new()),
            pending_notification: Mutex::new(None),
        }
    }

    pub fn set_connected(&self, connected: bool) {
        *self.connected.lock().unwrap_or_else(|p| p.into_inner()) = connected;
    }

    #[allow(dead_code)]
    pub fn is_connected(&self) -> bool {
        *self.connected.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set_services(&self, services: Vec<ServiceInfo>) {
        *self.services.lock().unwrap_or_else(|p| p.into_inner()) = services;
    }

    pub fn take_services(&self) -> Vec<ServiceInfo> {
        std::mem::take(&mut *self.services.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// Arm a read for `uuid` and hand back the receiver its answer will arrive on.
    ///
    /// A second read of the *same* characteristic replaces the earlier waiter; the earlier
    /// receiver resolves with `Err` (its sender was dropped), which `ble_read` reports as
    /// "superseded" rather than leaving the caller to wait out the timeout.
    pub fn arm_read(&self, uuid: &str) -> oneshot::Receiver<Vec<u8>> {
        let (tx, rx) = oneshot::channel();
        self.pending_reads
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(uuid.to_string(), tx);
        rx
    }

    /// Drop a waiter that will never be answered (its JNI call did not go through), so a
    /// late value for this characteristic is not delivered into a dead channel.
    pub fn disarm_read(&self, uuid: &str) {
        self.pending_reads
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(uuid);
    }

    /// Deliver a read result to the waiter armed for **this** characteristic.
    ///
    /// Returns `false` when nobody was waiting (the command already timed out, or the value
    /// belongs to a characteristic no command is reading); the value still reaches the UI
    /// through the `ble-value-changed` event either way.
    pub fn deliver_read(&self, uuid: &str, value: Vec<u8>) -> bool {
        let sender = self
            .pending_reads
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(uuid);
        match sender {
            Some(tx) => tx.send(value).is_ok(),
            None => false,
        }
    }

    pub fn set_pending_notification(&self, uuid: String, value: Vec<u8>) {
        *self
            .pending_notification
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some((uuid, value));
    }

    #[allow(dead_code)]
    pub fn take_pending_notification(&self) -> Option<(String, Vec<u8>)> {
        self.pending_notification
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }
}

impl Default for BleGattState {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  NFC state
// ─────────────────────────────────────────────────────────────────────────────

/// NFC tag info received from Kotlin.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NfcTagInfo {
    pub id: String,
    pub technology: String,
    pub ndef: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub records: Option<serde_json::Value>,
}

/// NFC state (last discovered tag).
pub struct NfcState {
    last_tag: Mutex<Option<NfcTagInfo>>,
}

impl NfcState {
    pub fn new() -> Self {
        Self {
            last_tag: Mutex::new(None),
        }
    }

    pub fn set_tag(&self, tag: NfcTagInfo) {
        *self.last_tag.lock().unwrap_or_else(|p| p.into_inner()) = Some(tag);
    }

    pub fn take_tag(&self) -> Option<NfcTagInfo> {
        self.last_tag
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }

    #[allow(dead_code)]
    pub fn peek_tag(&self) -> Option<NfcTagInfo> {
        self.last_tag
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl Default for NfcState {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Biometric state
// ─────────────────────────────────────────────────────────────────────────────

use tokio::sync::oneshot;

/// Biometric auth result.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BiometricAuthResult {
    pub ok: bool,
    pub result: Option<String>,
    pub error: Option<String>,
}

/// Biometric state.
///
/// The Rust→Kotlin prompt is asynchronous: `BiometricPrompt.authenticate`
/// returns immediately and the result is delivered via `onAuthenticationSucceeded`
/// / `onAuthenticationError` on the main thread. We bridge the two with a
/// `oneshot::Sender` so the Tauri command can `await` the real answer (instead
/// of returning a "pending" placeholder that the caller has no listener for,
/// which was the original bug — see audit H1).
pub struct BiometricState {
    last_result: Mutex<Option<BiometricAuthResult>>,
    /// Pending prompt, if one is in-flight. While `Some`, calls to
    /// `biometric_authenticate` reuse this slot.
    pending: Mutex<Option<oneshot::Sender<BiometricAuthResult>>>,
}

impl BiometricState {
    pub fn new() -> Self {
        Self {
            last_result: Mutex::new(None),
            pending: Mutex::new(None),
        }
    }

    pub fn set_result(&self, result: BiometricAuthResult) {
        // First, complete any pending prompt.
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(tx) = sender {
            // Ignore Err: the caller already dropped their receiver (timeout,
            // user navigated away). Fall through to update `last_result` so a
            // future poll-on-next-invoke path still sees the outcome.
            let _ = tx.send(result.clone());
        }
        *self.last_result.lock().unwrap_or_else(|p| p.into_inner()) = Some(result);
    }

    pub fn take_result(&self) -> Option<BiometricAuthResult> {
        self.last_result
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }

    /// Register a one-shot receiver for the next prompt's result.
    /// Returns `None` if another prompt is already in-flight.
    pub fn arm_prompt(&self) -> Option<oneshot::Receiver<BiometricAuthResult>> {
        let mut guard = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_some() {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        *guard = Some(tx);
        Some(rx)
    }

    /// Cancel any in-flight prompt. The caller's `rx` will resolve with an
    /// `Err`, which we surface as a `BiometricResult { error: "cancelled" }`.
    pub fn cancel_pending(&self) {
        if let Some(tx) = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            let _ = tx.send(BiometricAuthResult {
                ok: false,
                result: None,
                error: Some("cancelled".to_string()),
            });
        }
    }
}

impl Default for BiometricState {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Managed state holders (OnceLock'd so JNI callbacks can access them)
// ─────────────────────────────────────────────────────────────────────────────

pub static BLE_GATT_STATE: OnceLock<Arc<BleGattState>> = OnceLock::new();
pub static NFC_STATE: OnceLock<Arc<NfcState>> = OnceLock::new();
pub static BIOMETRIC_STATE: OnceLock<Arc<BiometricState>> = OnceLock::new();

/// Initialize the JNI glue state. Called from `ble::install_glue` after binding is attached.
pub fn init() {
    let _ = BLE_GATT_STATE.set(Arc::new(BleGattState::new()));
    let _ = NFC_STATE.set(Arc::new(NfcState::new()));
    let _ = BIOMETRIC_STATE.set(Arc::new(BiometricState::new()));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tauri event emitter (installed by lib.rs)
// ─────────────────────────────────────────────────────────────────────────────

/// The host-side event sink: `app.emit(event, payload)` from `lib.rs::setup`.
type EventEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

pub static EMITTER: OnceLock<EventEmitter> = OnceLock::new();

/// Set the event emitter. Called from `lib.rs::setup` with a closure that
/// calls `app.emit(event, payload)`.
pub fn set_emitter<F>(f: F)
where
    F: Fn(&str, serde_json::Value) + Send + Sync + 'static,
{
    let _ = EMITTER.set(Arc::new(f));
}

fn emit(event: &str, payload: serde_json::Value) {
    if let Some(f) = EMITTER.get() {
        f(event, payload);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Boot JNI callbacks (from Kotlin glue → Rust install)
// ─────────────────────────────────────────────────────────────────────────────

/// `BluetoothGattGlue.nativeInstall(context)` — installs the JavaVM binding.
/// Called by Kotlin's `install()` to bootstrap the bidirectional JNI bridge.
/// All three glues (BLE, NFC, Biometric) share the same binding.
///
/// # Safety
///
/// Called by the JVM only, so `env` is a valid `JNIEnv*` for the calling thread (which is
/// already attached — that is why this function wraps it with `JNIEnv::from_raw` instead of
/// attaching) and `context` is a live local reference for the duration of this call.
/// `BINDING.set(..)` is what keeps the global ref alive afterwards; nothing here stores a
/// raw pointer.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_BluetoothGattGlue_nativeInstall(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    context: jni::sys::jobject,
) {
    // We're already on an attached thread — use the raw env directly.
    let jni_env = match jni::JNIEnv::from_raw(env) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!(target: "amos::jni", "nativeInstall: failed to get env: {}", e);
            return;
        }
    };

    // Get JavaVM and install the binding.
    let vm = match jni_env.get_java_vm() {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(target: "amos::jni", "nativeInstall: failed to get JavaVM: {}", e);
            return;
        }
    };

    let context_ref = match jni_env
        // SAFETY: `context` is the live local reference the JVM passed to this native
        // method, and `jni_env` wraps the same thread's `env`; `new_global_ref` copies it
        // into a JVM-managed global ref, so the raw handle does not outlive this statement.
        .new_global_ref(unsafe { jni::objects::JObject::from_raw(context) })
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(target: "amos::jni", "nativeInstall: failed to create global ref: {}", e);
            return;
        }
    };

    // Install into BLE GATT state binding (used by ble commands). A second install is
    // idempotent: `set` fails when something already bound the glue.
    if crate::ble::android_jni::BINDING
        .set(crate::ble::android_jni::Binding {
            vm,
            context: context_ref,
        })
        .is_err()
    {
        tracing::warn!(target: "amos::jni", "JavaVM binding already installed (idempotent)");
    }

    // Initialize the JNI glue state.
    crate::jni_glue::init();

    tracing::info!(target: "amos::jni", "JavaVM binding installed via BluetoothGattGlue.nativeInstall");
}

// ─────────────────────────────────────────────────────────────────────────────
//  BLE GATT JNI callbacks (from Kotlin BluetoothGattGlue)
// ─────────────────────────────────────────────────────────────────────────────

/// `BluetoothGattGlue.onConnectionStateChange(connected: Boolean)` — JNI `(Z)V`.
#[no_mangle]
pub extern "system" fn Java_com_amos_ai_glue_BluetoothGattGlue_onConnectionStateChange(
    _env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    connected: u8,
) {
    let state = BLE_GATT_STATE.get().cloned();
    if let Some(state) = state {
        state.set_connected(connected != 0);
    }

    let event = if connected != 0 {
        "connected"
    } else {
        "disconnected"
    };
    emit("ble-value-changed", serde_json::json!({ "event": event }));
}

/// `BluetoothGattGlue.onServicesDiscovered(servicesJson: String)` — JNI `(Ljava/lang/String;)V`.
///
/// Kotlin serializes the List<Map<String, Any>> to JSON before calling.
///
/// # Safety
///
/// Called by the JVM only: `env` is a valid `JNIEnv*` for the calling thread and
/// `services_json` is a live local reference for the duration of the call (the helper
/// rejects a null handle rather than dereferencing it).
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_BluetoothGattGlue_onServicesDiscovered(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    services_json: jni::sys::jstring,
) {
    // SAFETY: both arguments are the live JNI values this native method was called with;
    // `extract_jstring` null-checks them before wrapping anything.
    let services_str = unsafe { extract_jstring(env, services_json) }.unwrap_or_default();

    // Parse JSON [{"uuid": "..."}, ...]
    let infos: Vec<ServiceInfo> = serde_json::from_str(&services_str).unwrap_or_default();

    if let Some(state) = BLE_GATT_STATE.get() {
        state.set_services(infos.clone());
    }

    emit(
        "ble-value-changed",
        serde_json::json!({
            "event": "services_discovered",
            "count": infos.len(),
        }),
    );
}

/// `BluetoothGattGlue.onCharacteristicReadResult(uuid: String, value: ByteArray)` — JNI `(Ljava/lang/String;[B)V`.
///
/// Delivers to the `ble_read` call that is waiting for **this** UUID (see
/// [`BleGattState::deliver_read`]); the event below is the UI's copy. A value nobody is
/// waiting for is logged rather than silently dropped — with a per-UUID map that means the
/// command had already timed out or a consumer subscribed without reading.
///
/// # Safety
///
/// Called by the JVM only: `env` is a valid `JNIEnv*` for the calling thread, and `uuid`
/// / `value` are live local references for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_BluetoothGattGlue_onCharacteristicReadResult(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    uuid: jni::sys::jstring,
    value: jni::sys::jbyteArray,
) {
    // SAFETY: the live JNI handles this native method was called with; `extract_jstring`
    // null-checks them before wrapping anything.
    let uuid_str = unsafe { extract_jstring(env, uuid) }.unwrap_or_default();
    // SAFETY: as above, for the `jbyteArray`; `extract_byte_array` null-checks both.
    let bytes = unsafe { extract_byte_array(env, value) }.unwrap_or_default();

    if let Some(state) = BLE_GATT_STATE.get() {
        if !state.deliver_read(&uuid_str, bytes.clone()) {
            tracing::debug!(
                target: "amos::jni",
                "BLE read result for {uuid_str} had no waiter (command timed out or nobody asked)"
            );
        }
    }

    emit(
        "ble-value-changed",
        serde_json::json!({
            "event": "read_result",
            "uuid": uuid_str,
            "value": bytes,
        }),
    );
}

/// `BluetoothGattGlue.onCharacteristicWriteResult(uuid: String, status: Int)` — JNI `(Ljava/lang/String;I)V`.
///
/// # Safety
///
/// Called by the JVM only: `env` is a valid `JNIEnv*` for the calling thread and `uuid` is
/// a live local reference for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_BluetoothGattGlue_onCharacteristicWriteResult(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    uuid: jni::sys::jstring,
    status: i32,
) {
    // SAFETY: the live JNI handle this native method was called with; `extract_jstring`
    // null-checks it before wrapping anything.
    let uuid_str = unsafe { extract_jstring(env, uuid) }.unwrap_or_default();

    emit(
        "ble-value-changed",
        serde_json::json!({
            "event": "write_result",
            "uuid": uuid_str,
            "ok": status == 0,
        }),
    );
}

/// `BluetoothGattGlue.onCharacteristicChanged(uuid: String, value: ByteArray)` — JNI `(Ljava/lang/String;[B)V`.
///
/// # Safety
///
/// Called by the JVM only: `env` is a valid `JNIEnv*` for the calling thread and `uuid` /
/// `value` are live local references for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_BluetoothGattGlue_onCharacteristicChanged(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    uuid: jni::sys::jstring,
    value: jni::sys::jbyteArray,
) {
    // SAFETY: the live JNI handles this native method was called with; both helpers
    // null-check their arguments before wrapping anything.
    let uuid_str = unsafe { extract_jstring(env, uuid) }.unwrap_or_default();
    // SAFETY: as above, for the `jbyteArray`.
    let bytes = unsafe { extract_byte_array(env, value) }.unwrap_or_default();

    if let Some(state) = BLE_GATT_STATE.get() {
        state.set_pending_notification(uuid_str.clone(), bytes.clone());
    }

    emit(
        "ble-value-changed",
        serde_json::json!({
            "event": "notification",
            "uuid": uuid_str,
            "value": bytes,
        }),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  NFC JNI callbacks
// ─────────────────────────────────────────────────────────────────────────────

/// `NfcGlue.onNfcTagDiscovered(tagJson: String)` — JNI `(Ljava/lang/String;)V`.
///
/// Kotlin serializes the Map<String, Any> to JSON before calling (Map to JNI is
/// awkward in Rust, and Kotlin's `JSONObject.toString()` is well-defined).
///
/// # Safety
///
/// Called by the JVM only: `env` is a valid `JNIEnv*` for the calling thread and `tag_json`
/// is a live local reference for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_NfcGlue_onNfcTagDiscovered(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    tag_json: jni::sys::jstring,
) {
    // SAFETY: the live JNI values this native method was called with; `extract_jstring`
    // null-checks them before wrapping anything.
    let tag_str = unsafe { extract_jstring(env, tag_json) }.unwrap_or_default();

    let parsed: serde_json::Value = serde_json::from_str(&tag_str).unwrap_or_default();

    let tag_info = NfcTagInfo {
        id: parsed["id"].as_str().unwrap_or("").to_string(),
        technology: parsed["technology"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
        ndef: parsed["ndef"].as_bool().unwrap_or(false),
        records: parsed.get("records").cloned(),
    };

    if let Some(state) = NFC_STATE.get() {
        state.set_tag(tag_info.clone());
    }

    let payload = serde_json::to_value(&tag_info).unwrap_or_default();
    emit("nfc-tag-discovered", payload);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Biometric JNI callbacks
// ─────────────────────────────────────────────────────────────────────────────

/// `BiometricGlue.onBiometricResult(resultJson: String)` — JNI `(Ljava/lang/String;)V`.
///
/// # Safety
///
/// Called by the JVM only: `env` is a valid `JNIEnv*` for the calling thread and
/// `result_json` is a live local reference for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_BiometricGlue_onBiometricResult(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    result_json: jni::sys::jstring,
) {
    // SAFETY: the live JNI values this native method was called with; `extract_jstring`
    // null-checks them before wrapping anything.
    let result_str = unsafe { extract_jstring(env, result_json) }.unwrap_or_default();

    let parsed: serde_json::Value = serde_json::from_str(&result_str).unwrap_or_default();

    let result = BiometricAuthResult {
        ok: parsed["ok"].as_bool().unwrap_or(false),
        result: parsed["result"].as_str().map(|s| s.to_string()),
        error: parsed["error"].as_str().map(|s| s.to_string()),
    };

    if let Some(state) = BIOMETRIC_STATE.get() {
        state.set_result(result.clone());
    }

    let payload = serde_json::to_value(&result).unwrap_or_default();
    emit("biometric-result", payload);
}

// ─────────────────────────────────────────────────────────────────────────────
//  JNI helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Extract a Java String from a `jstring`. Returns None on null/invalid.
///
/// # Safety
///
/// `env` must be a valid `JNIEnv*` for the **current** thread and `js` a live local
/// reference (or null) for the duration of the call; the function re-wraps the env and never
/// stores either handle.
unsafe fn extract_jstring(env: *mut jni::sys::JNIEnv, js: jni::sys::jstring) -> Option<String> {
    if env.is_null() || js.is_null() {
        return None;
    }
    // SAFETY: `env` was just checked non-null and is the JNI-supplied pointer for this
    // thread; `JNIEnv::from_raw` only fails (and is handled) when it is not.
    let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return None;
    };
    // SAFETY: `js` was checked non-null and is a live local reference for this call, so the
    // borrowed `JString` cannot outlive it (it is consumed by `get_string` immediately).
    let jstr = unsafe { jni::objects::JString::from_raw(js) };
    env.get_string(&jstr).ok().map(|s| s.into())
}

/// Extract a Java `byte[]` from a `jbyteArray`. Returns None on null/invalid.
///
/// # Safety
///
/// As [`extract_jstring`]: a valid `JNIEnv*` for the current thread and a live (or null)
/// `jbyteArray` local reference for the duration of the call.
unsafe fn extract_byte_array(
    env: *mut jni::sys::JNIEnv,
    arr: jni::sys::jbyteArray,
) -> Option<Vec<u8>> {
    if env.is_null() || arr.is_null() {
        return None;
    }
    // SAFETY: `env` was just checked non-null and is the JNI-supplied pointer for this
    // thread; a failure is handled by returning `None`.
    let Ok(env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return None;
    };
    // SAFETY: `arr` was checked non-null and is a live local reference for this call; the
    // bytes are copied out by `convert_byte_array`, which consumes the wrapper.
    let bytes = unsafe { jni::objects::JByteArray::from_raw(arr as jni::sys::jarray) };
    env.convert_byte_array(&bytes).ok()
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests (host-side: this module is `#![cfg(feature = "android")]`, so they are
//  compiled and run by `cargo test -p amos-tauri --features android --lib`)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A delivered value resolves **the** waiter that asked for that characteristic and nobody
    /// else. The old single-slot state returned the same bytes to whoever called next, with the
    /// UUID discarded — a reading attributed to the wrong sensor (REQ-A413).
    #[test]
    fn a_read_result_reaches_only_the_waiter_that_asked_for_it() {
        let state = BleGattState::new();
        let mut battery = state.arm_read("battery");
        let mut temperature = state.arm_read("temperature");

        assert!(state.deliver_read("battery", vec![99]));

        assert_eq!(battery.try_recv().expect("battery answer"), vec![99]);
        assert!(matches!(
            temperature.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        assert!(state.deliver_read("temperature", vec![21]));
        assert_eq!(
            temperature.try_recv().expect("temperature answer"),
            vec![21]
        );
    }

    /// Two reads of one characteristic: the older caller is told it was superseded (its sender
    /// was dropped) instead of silently receiving the newer answer.
    #[test]
    fn a_second_read_of_the_same_characteristic_supersedes_the_first() {
        let state = BleGattState::new();
        let mut first = state.arm_read("battery");
        let mut second = state.arm_read("battery");

        assert!(state.deliver_read("battery", vec![7]));

        assert_eq!(second.try_recv().expect("newer waiter"), vec![7]);
        assert!(matches!(
            first.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    /// A value nobody is waiting for is *reported* as unclaimed (so the callback can log it)
    /// rather than dropped in silence, and a disarmed read leaves no channel behind for a late
    /// answer that can no longer be used.
    #[test]
    fn an_unclaimed_or_disarmed_read_is_reported_not_swallowed() {
        let state = BleGattState::new();
        assert!(!state.deliver_read("nobody-asked", vec![1]));

        let mut rx = state.arm_read("battery");
        state.disarm_read("battery");
        assert!(!state.deliver_read("battery", vec![2]));
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }
}
