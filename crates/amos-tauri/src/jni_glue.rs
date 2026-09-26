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

/// One characteristic of a discovered GATT service.
///
/// `properties` is the **raw** `BluetoothGattCharacteristic#getProperties()` bitmask, carried
/// rather than pre-digested: which actions it permits (read / write / notify / indicate) is a
/// fact about the device, and the screen must gate its read / write / subscribe controls on it.
/// Before this field existed, discovery answered service UUIDs alone, so the screen offered
/// every action for any characteristic the user typed and the *device* became the only thing
/// that refused — a control enabled for more than it does (REQ-A1198 / F-SH-487).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CharacteristicInfo {
    pub uuid: String,
    pub properties: i32,
}

/// One discovered GATT service, with the characteristics the platform reported for it.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServiceInfo {
    pub uuid: String,
    /// Not `#[serde(default)]`: the field is part of the contract the Kotlin callback and this
    /// struct share. A payload without it is a **contract break**, and the honest answer is the
    /// parse failure [`deliver_services`](BleGattState::deliver_services) now forwards — not a
    /// service list quietly stripped of its characteristics (or, worse, an empty list).
    pub characteristics: Vec<CharacteristicInfo>,
}

/// BLE GATT connection state.
pub struct BleGattState {
    pub connected: Mutex<bool>,
    /// In-flight GATT **service discovery**.
    ///
    /// `BluetoothGatt.discoverServices()` is asynchronous — it returns an accept/reject
    /// immediately and the list arrives later in `onServicesDiscovered` on a Binder thread.
    /// `ble_discover_services` arms this slot *before* it fires the call and awaits the
    /// receiver; the callback delivers into it.
    ///
    /// The defect this closes: the command used to fire `discoverServices()` and then drain a
    /// plain `Mutex<Vec<ServiceInfo>>` slot **on the same tick**, before the callback could
    /// have run — so on device it answered "0 services" while the platform was still
    /// discovering, and the screen read that empty list as "the device has no services". The
    /// same race REQ-A413 fixed for `ble_read`, one operation over. Discovery is not keyed by
    /// anything (there is one GATT client), so this is a single slot: a second arm supersedes
    /// the first, whose receiver resolves `Err` and the command reports as superseded.
    /// The sender carries `Result<Vec<ServiceInfo>, String>`: `Ok` is the platform's list and
    /// `Err` is a payload the platform sent that could not be read. The callback used to
    /// `unwrap_or_default()` the parse, so a malformed payload became an **empty list** — which
    /// the command reported as `ok: true` with zero services, i.e. the same answer as a device
    /// that advertises none. A parse failure is not a fact about the device (REQ-A1198 /
    /// F-SH-488).
    pub pending_services: Mutex<Option<oneshot::Sender<Result<Vec<ServiceInfo>, String>>>>,
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
    ///
    /// The sender carries `Result<Vec<u8>, i32>`: `Ok` is the value, `Err` is the stack's
    /// non-`GATT_SUCCESS` status for **this** read. REQ-A413 shipped with Kotlin calling back
    /// only on success, so a failed read reached the screen as a 5s timeout with no cause —
    /// deferred there because forwarding `status` needs both the Kotlin callback and this Rust
    /// export changed together (REQ-A1158 / F-SH-459 closes that).
    pub pending_reads: Mutex<HashMap<String, oneshot::Sender<Result<Vec<u8>, i32>>>>,
    /// In-flight BLE **connection** (single slot — one GATT client).
    ///
    /// `BluetoothDevice.connectGatt()` returns a `BluetoothGatt` object immediately and the
    /// rendezvous verdict arrives later in `onConnectionStateChange(status, newState)`. The
    /// sender carries `(connected, status)`: the stack's own answer, not the fact that a client
    /// object was created. `ble_connect` arms this *before* it fires the JNI call and awaits it,
    /// so the screen's 「已连接」 is the device's answer rather than the caller's request
    /// (REQ-A1158 / F-SH-459). A second connect supersedes the first.
    pub pending_connect: Mutex<Option<oneshot::Sender<(bool, i32)>>>,
    /// In-flight GATT **writes**, keyed by characteristic UUID, carrying the stack's
    /// `onCharacteristicWriteResult` status (`0` == `GATT_SUCCESS`).
    ///
    /// A write is asynchronous in exactly the same way a read is: `writeCharacteristic`
    /// answers whether the request was **queued**, and the verdict arrives later in
    /// `onCharacteristicWriteResult`. `ble_write` used to return the queue-acceptance as
    /// "success", so a write the stack took and then failed reported `ok: true` — the screen
    /// said 「写入成功」 for a value the device never received (REQ-A1157 / F-SH-458). Keyed by
    /// UUID for the same reason reads are: two writes in flight must not take each other's status.
    pub pending_writes: Mutex<HashMap<String, oneshot::Sender<i32>>>,
    /// In-flight **descriptor writes**, keyed by the characteristic whose CCC is being written.
    ///
    /// Subscribing is two steps: `setCharacteristicNotification` (a *local* registration that
    /// answers immediately) and writing the Client Characteristic Configuration descriptor, whose
    /// verdict — whether the **device** turned notifications on — arrives later in
    /// `onDescriptorWrite`. `ble_subscribe`/`ble_unsubscribe` used to return the local half as
    /// success, so the screen said 「已订阅」 for a device that never acknowledged (or for a
    /// characteristic that has no CCC at all). Arming here before the call lets them await the
    /// device's answer (REQ-A1158 / F-SH-459).
    pub pending_descriptor_writes: Mutex<HashMap<String, oneshot::Sender<i32>>>,
    pub pending_notification: Mutex<Option<(String, Vec<u8>)>>, // (uuid, value)
}

impl BleGattState {
    pub fn new() -> Self {
        Self {
            connected: Mutex::new(false),
            pending_services: Mutex::new(None),
            pending_reads: Mutex::new(HashMap::new()),
            pending_connect: Mutex::new(None),
            pending_writes: Mutex::new(HashMap::new()),
            pending_descriptor_writes: Mutex::new(HashMap::new()),
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

    /// Arm a discovery and hand back the receiver its answer will arrive on. A second arm
    /// replaces the earlier waiter (its receiver resolves `Err` — "superseded").
    pub fn arm_services(&self) -> oneshot::Receiver<Result<Vec<ServiceInfo>, String>> {
        let (tx, rx) = oneshot::channel();
        *self
            .pending_services
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(tx);
        rx
    }

    /// Drop a discovery waiter that will never be answered (its JNI call did not go through).
    pub fn disarm_services(&self) {
        *self
            .pending_services
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Deliver the platform's answer to the waiting `ble_discover_services`: its service list, or
    /// the reason a payload it sent could not be read. Returns `false` when nobody was waiting
    /// (the command already timed out), so the callback can log it rather than drop it in silence.
    pub fn deliver_services(&self, answer: Result<Vec<ServiceInfo>, String>) -> bool {
        let sender = self
            .pending_services
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        match sender {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// Arm a write for `uuid`; the receiver resolves with the stack's write status. A second
    /// write of the *same* characteristic replaces the earlier waiter (its receiver resolves
    /// `Err` and the command reports it as superseded).
    pub fn arm_write(&self, uuid: &str) -> oneshot::Receiver<i32> {
        let (tx, rx) = oneshot::channel();
        self.pending_writes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(uuid.to_string(), tx);
        rx
    }

    /// Drop a write waiter that will never be answered (its JNI call did not go through).
    pub fn disarm_write(&self, uuid: &str) {
        self.pending_writes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(uuid);
    }

    /// Deliver a write status to the waiter armed for **this** characteristic. Returns `false`
    /// when nobody was waiting (the command already timed out).
    pub fn deliver_write(&self, uuid: &str, status: i32) -> bool {
        let sender = self
            .pending_writes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(uuid);
        match sender {
            Some(tx) => tx.send(status).is_ok(),
            None => false,
        }
    }

    /// Arm a **CCC descriptor write** for `uuid` (the characteristic whose notifications are
    /// being toggled); the receiver resolves with the stack's `onDescriptorWrite` status.
    ///
    /// Keyed by characteristic UUID for the same reason writes are: two subscribes in flight
    /// (e.g. a battery level and a heart rate at once) must not take each other's status.
    pub fn arm_descriptor_write(&self, uuid: &str) -> oneshot::Receiver<i32> {
        let (tx, rx) = oneshot::channel();
        self.pending_descriptor_writes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(uuid.to_string(), tx);
        rx
    }

    /// Drop a descriptor-write waiter that will never be answered (its JNI call did not go
    /// through, or the characteristic had no CCC to write).
    pub fn disarm_descriptor_write(&self, uuid: &str) {
        self.pending_descriptor_writes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(uuid);
    }

    /// Deliver the device's answer to a CCC descriptor write to the waiter armed for **this**
    /// characteristic. Returns `false` when nobody was waiting (the command already timed out).
    pub fn deliver_descriptor_write(&self, uuid: &str, status: i32) -> bool {
        let sender = self
            .pending_descriptor_writes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(uuid);
        match sender {
            Some(tx) => tx.send(status).is_ok(),
            None => false,
        }
    }

    /// Arm a read for `uuid` and hand back the receiver its answer will arrive on.
    ///
    /// A second read of the *same* characteristic replaces the earlier waiter; the earlier
    /// receiver resolves with `Err` (its sender was dropped), which `ble_read` reports as
    /// "superseded" rather than leaving the caller to wait out the timeout.
    pub fn arm_read(&self, uuid: &str) -> oneshot::Receiver<Result<Vec<u8>, i32>> {
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

    /// Deliver a read **value** to the waiter armed for **this** characteristic.
    ///
    /// Returns `false` when nobody was waiting (the command already timed out, or the value
    /// belongs to a characteristic no command is reading); the value still reaches the UI
    /// through the `ble-value-changed` event either way.
    pub fn deliver_read(&self, uuid: &str, value: Vec<u8>) -> bool {
        self.resolve_read(uuid, Ok(value))
    }

    /// Deliver the stack's **failure status** for a read (`status != GATT_SUCCESS`) to the
    /// waiter armed for this characteristic. Without this a failed read reached `ble_read` only
    /// as its 5s timeout — the device's own error code was dropped by the Kotlin callback
    /// (REQ-A1158 / F-SH-459).
    pub fn deliver_read_failure(&self, uuid: &str, status: i32) -> bool {
        self.resolve_read(uuid, Err(status))
    }

    fn resolve_read(&self, uuid: &str, outcome: Result<Vec<u8>, i32>) -> bool {
        let sender = self
            .pending_reads
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(uuid);
        match sender {
            Some(tx) => tx.send(outcome).is_ok(),
            None => false,
        }
    }

    /// Arm the (single) connection waiter and hand back the receiver the stack's verdict will
    /// arrive on. A second connect supersedes the first, whose receiver resolves `Err`.
    pub fn arm_connect(&self) -> oneshot::Receiver<(bool, i32)> {
        let (tx, rx) = oneshot::channel();
        *self
            .pending_connect
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(tx);
        rx
    }

    /// Drop a connection waiter that will never be answered (its JNI call did not go through).
    pub fn disarm_connect(&self) {
        *self
            .pending_connect
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Deliver the stack's connection verdict — `(connected, status)`, where `status` is the
    /// `onConnectionStateChange` status (`0` == `GATT_SUCCESS`). Returns `false` when nobody was
    /// waiting (the command already timed out), so the callback can log rather than drop it.
    pub fn deliver_connect(&self, connected: bool, status: i32) -> bool {
        let sender = self
            .pending_connect
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        match sender {
            Some(tx) => tx.send((connected, status)).is_ok(),
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

/// `BluetoothGattGlue.onConnectionStateChange(connected: Boolean, status: Int)` — JNI `(ZI)V`.
///
/// `status` is the stack's own verdict (`0` == `GATT_SUCCESS`); forwarding it lets `ble_connect`
/// tell "connected" from "the stack refused with 133" instead of the caller assuming the
/// rendezvous succeeded because `connectGatt` handed back a client object (REQ-A1158 / F-SH-459).
#[no_mangle]
pub extern "system" fn Java_com_amos_ai_glue_BluetoothGattGlue_onConnectionStateChange(
    _env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    connected: u8,
    status: jni::sys::jint,
) {
    let state = BLE_GATT_STATE.get().cloned();
    if let Some(state) = state {
        state.set_connected(connected != 0);
        // Hand the verdict to the `ble_connect` call that is waiting for it. Nobody waiting
        // (the command timed out, or this is a later disconnect) is logged, not dropped in
        // silence: the device *did* answer.
        if !state.deliver_connect(connected != 0, status) {
            tracing::debug!(
                target: "amos::jni",
                "BLE connection state had no waiter (connected={}, status={status})",
                connected != 0
            );
        }
    }

    let event = if connected != 0 {
        "connected"
    } else {
        "disconnected"
    };
    emit(
        crate::ble::BLE_VALUE_EVENT,
        serde_json::json!({ "event": event, "status": status }),
    );
}

/// Read the platform's service-list JSON into the shape the waiter expects.
///
/// Returns the list (or the reason it could not be read) **and** the `count` the diagnostic
/// event carries: `-1` for an unreadable payload, because `0` already means "the device really
/// answered with an empty list" and the two must not look alike to a listener.
///
/// Split out of the JNI export so the seam itself is reachable from a test. A test that calls
/// [`BleGattState::deliver_services`] alone pins the mailbox and **not** the routing, and the
/// defect this round fixed lived in the routing: a payload that failed to parse used to reach
/// the waiter as `Ok(vec![])`, i.e. as "this device advertises no services" — the same answer
/// the screen shows for a device that genuinely has none (REQ-A1198 / F-SH-488).
pub fn read_service_payload(json: &str) -> (Result<Vec<ServiceInfo>, String>, i64) {
    // The wire shape the Kotlin glue sends:
    // `[{"uuid": "...", "characteristics": [{"uuid": "...", "properties": N}]}, ...]`.
    let parsed: Result<Vec<ServiceInfo>, String> = serde_json::from_str(json)
        .map_err(|e| format!("the platform's service list could not be read: {e}"));
    let count = match &parsed {
        Ok(infos) => infos.len() as i64,
        Err(_) => -1,
    };
    (parsed, count)
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

    let (parsed, count) = read_service_payload(&services_str);

    if let Some(state) = BLE_GATT_STATE.get() {
        // Hand the answer to the `ble_discover_services` call that is waiting for it. An answer
        // nobody was waiting for is logged rather than dropped in silence — the command had
        // already timed out (the caller got an honest failure), but the *device did answer*,
        // and a silent drop would make that indistinguishable from a device that never replied.
        if !state.deliver_services(parsed.clone()) {
            tracing::debug!(
                target: "amos::jni",
                "BLE discovery result had no waiter (command timed out)"
            );
        }
    }

    emit(
        crate::ble::BLE_VALUE_EVENT,
        serde_json::json!({
            "event": "services_discovered",
            "count": count,
        }),
    );
}

/// `BluetoothGattGlue.onCharacteristicReadResult(uuid: String, value: ByteArray, status: Int)` —
/// JNI `(Ljava/lang/String;[BI)V`.
///
/// Delivers to the `ble_read` call that is waiting for **this** UUID (see
/// [`BleGattState::deliver_read`] / [`BleGattState::deliver_read_failure`]); the event below is
/// the UI's copy, emitted only for a successful read. A `status != GATT_SUCCESS` is the stack's
/// own verdict and is delivered as a failure rather than silently dropped — the Kotlin callback
/// used to skip the callback entirely on failure, so a failed read reached the screen as a bare
/// 5s timeout with no cause (REQ-A1158 / F-SH-459). A value nobody is waiting for is logged
/// rather than silently dropped — with a per-UUID map that means the command had already timed
/// out or a consumer subscribed without reading.
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
    status: jni::sys::jint,
) {
    // SAFETY: the live JNI handles this native method was called with; `extract_jstring`
    // null-checks them before wrapping anything.
    let uuid_str = unsafe { extract_jstring(env, uuid) }.unwrap_or_default();
    // SAFETY: as above, for the `jbyteArray`; `extract_byte_array` null-checks both.
    let bytes = unsafe { extract_byte_array(env, value) }.unwrap_or_default();

    if let Some(state) = BLE_GATT_STATE.get() {
        let delivered = if status == 0 {
            state.deliver_read(&uuid_str, bytes.clone())
        } else {
            state.deliver_read_failure(&uuid_str, status)
        };
        if !delivered {
            tracing::debug!(
                target: "amos::jni",
                "BLE read result for {uuid_str} (status={status}) had no waiter (command timed out or nobody asked)"
            );
        }
    }

    // Only a successful read carries a value for the UI's log; a failure is the caller's
    // business (it already receives the status) and must not be rendered as a value frame.
    if status == 0 {
        emit(
            crate::ble::BLE_VALUE_EVENT,
            serde_json::json!({
                "event": "read_result",
                "uuid": uuid_str,
                "value": bytes,
            }),
        );
    }
}

/// `BluetoothGattGlue.onCharacteristicWriteResult(uuid: String, status: Int)` — JNI `(Ljava/lang/String;I)V`.
///
/// Delivers the stack's verdict to the `ble_write` call that is waiting for **this**
/// characteristic (see [`BleGattState::deliver_write`]): `writeCharacteristic` only answers
/// whether the request was *queued*, so this callback is where "the device took the value"
/// or "the write failed" is decided. The event below is the UI's copy.
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

    if let Some(state) = BLE_GATT_STATE.get() {
        if !state.deliver_write(&uuid_str, status) {
            tracing::debug!(
                target: "amos::jni",
                "BLE write result for {uuid_str} had no waiter (command timed out or nobody asked)"
            );
        }
    }

    emit(
        crate::ble::BLE_VALUE_EVENT,
        serde_json::json!({
            "event": "write_result",
            "uuid": uuid_str,
            "ok": status == 0,
        }),
    );
}

/// `BluetoothGattGlue.onDescriptorWriteResult(uuid: String, status: Int)` — JNI `(Ljava/lang/String;I)V`.
///
/// Delivers the device's answer to a CCC (Client Characteristic Configuration) descriptor write
/// to the `ble_subscribe` / `ble_unsubscribe` call waiting for **this** characteristic. Toggling
/// notifications is two steps: a *local* `setCharacteristicNotification` (which answers whether
/// the stack registered the request, not whether the device agreed) and the descriptor write,
/// whose verdict lands here. Without this callback the commands reported the local half alone —
/// 「已订阅」 for a device that never acknowledged (REQ-A1158 / F-SH-459).
///
/// # Safety
///
/// Called by the JVM only: `env` is a valid `JNIEnv*` for the calling thread and `uuid` is a
/// live local reference for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_BluetoothGattGlue_onDescriptorWriteResult(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    uuid: jni::sys::jstring,
    status: i32,
) {
    // SAFETY: the live JNI handle this native method was called with; `extract_jstring`
    // null-checks it before wrapping anything.
    let uuid_str = unsafe { extract_jstring(env, uuid) }.unwrap_or_default();

    if let Some(state) = BLE_GATT_STATE.get() {
        if !state.deliver_descriptor_write(&uuid_str, status) {
            tracing::debug!(
                target: "amos::jni",
                "BLE descriptor-write result for {uuid_str} had no waiter (command timed out or nobody asked)"
            );
        }
    }
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
        crate::ble::BLE_VALUE_EVENT,
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
    emit(crate::ble::NFC_TAG_EVENT, payload);
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

    /// A discovered list resolves the waiter that asked for it. This is the half the command
    /// used to skip entirely: `ble_discover_services` fired `discoverServices()` and read a
    /// shared `Vec` **on the same tick**, so the waiter never existed and the answer always
    /// looked empty (REQ-A1157).
    #[test]
    fn a_discovery_result_resolves_the_armed_waiter() {
        let state = BleGattState::new();
        let mut rx = state.arm_services();

        let answer = Ok(vec![ServiceInfo {
            uuid: "180d".into(),
            characteristics: vec![CharacteristicInfo {
                uuid: "2a37".into(),
                properties: 0x10,
            }],
        }]);
        assert!(state.deliver_services(answer));

        let got = rx
            .try_recv()
            .expect("discovery answer")
            .expect("the platform's list");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].uuid, "180d");
        assert_eq!(got[0].characteristics[0].uuid, "2a37");
        assert_eq!(got[0].characteristics[0].properties, 0x10);
    }

    /// The routing the JNI export performs on the platform's JSON — read through the same
    /// function the export calls, so this pins the **seam** rather than a mailbox beside it.
    ///
    /// `ServiceInfo::characteristics` deliberately carries no `#[serde(default)]`: with a
    /// default, a payload from a glue that never sent characteristics would deserialize into
    /// "this device advertises none" — the same thing the screen shows for a device that
    /// genuinely has none, and a different fact from what happened (REQ-A1198 / F-SH-488).
    #[test]
    fn the_routing_reads_the_glue_shape_and_refuses_a_payload_it_cannot_read() {
        let payload = r#"[{"uuid":"180d","characteristics":[{"uuid":"2a37","properties":16}]}]"#;
        let (list, count) = read_service_payload(payload);
        let list = list.expect("the Kotlin glue's shape parses");
        assert_eq!(count, 1);
        assert_eq!(list[0].uuid, "180d");
        assert_eq!(list[0].characteristics[0].uuid, "2a37");
        assert_eq!(list[0].characteristics[0].properties, 16);

        // An empty list the device really returned is `0`, and a payload this side cannot read
        // is `-1`: a listener must be able to tell "it said none" from "we could not read it".
        let (empty, empty_count) = read_service_payload("[]");
        assert!(empty.expect("an empty list is a real answer").is_empty());
        assert_eq!(empty_count, 0);

        let (old, old_count) = read_service_payload(r#"[{"uuid":"180d"}]"#);
        assert!(
            old.is_err(),
            "a payload without characteristics must not read as an empty list"
        );
        assert_eq!(old_count, -1);

        let (garbage, garbage_count) = read_service_payload("not json");
        assert!(garbage.is_err());
        assert_eq!(garbage_count, -1);
    }

    /// …and that failure reaches the waiting command as a failure, so the screen says "could not
    /// read the list" rather than "the device has no services" (REQ-A1198 / F-SH-488).
    #[test]
    fn an_unreadable_discovery_payload_reaches_the_waiter_as_a_failure() {
        let state = BleGattState::new();
        let mut rx = state.arm_services();

        // Exactly what the export hands over for `[{"uuid":"180d"}]`.
        let (parsed, _) = read_service_payload(r#"[{"uuid":"180d"}]"#);
        assert!(state.deliver_services(parsed));

        let got = rx.try_recv().expect("discovery answer");
        assert!(got.is_err());
    }

    /// A second discovery supersedes the first: the earlier caller is told (its sender was
    /// dropped) instead of receiving a list it no longer owns.
    #[test]
    fn a_second_discovery_supersedes_the_first() {
        let state = BleGattState::new();
        let mut first = state.arm_services();
        let mut second = state.arm_services();

        assert!(state.deliver_services(Ok(Vec::new())));

        assert!(second.try_recv().is_ok());
        assert!(matches!(
            first.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    /// A discovery nobody is waiting for is *reported* as unclaimed (so the callback can log
    /// that the device did answer) rather than dropped in silence, and a disarmed discovery
    /// leaves no channel behind for a late answer.
    #[test]
    fn an_unclaimed_or_disarmed_discovery_is_reported_not_swallowed() {
        let state = BleGattState::new();
        assert!(!state.deliver_services(Ok(Vec::new())));

        let mut rx = state.arm_services();
        state.disarm_services();
        assert!(!state.deliver_services(Ok(Vec::new())));
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    /// A write status reaches the waiter armed for **that** characteristic and nobody else —
    /// the same per-UUID discipline reads use, and the reason a write the stack accepted then
    /// failed can no longer be reported as success (REQ-A1157 / F-SH-458).
    #[test]
    fn a_write_result_reaches_only_the_waiter_that_asked_for_it() {
        let state = BleGattState::new();
        let mut battery = state.arm_write("battery");
        let mut temperature = state.arm_write("temperature");

        assert!(state.deliver_write("battery", 0));

        assert_eq!(battery.try_recv().expect("battery status"), 0);
        assert!(matches!(
            temperature.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        // A non-zero status is a real verdict, not an absence: it is delivered, and `ble_write`
        // reads it as a failure.
        assert!(state.deliver_write("temperature", 133)); // GATT_INVALID_ATTRIBUTE_LENGTH
        assert_eq!(temperature.try_recv().expect("temperature status"), 133);
    }

    /// Two writes of one characteristic: the older caller is told it was superseded.
    #[test]
    fn a_second_write_of_the_same_characteristic_supersedes_the_first() {
        let state = BleGattState::new();
        let mut first = state.arm_write("battery");
        let mut second = state.arm_write("battery");

        assert!(state.deliver_write("battery", 0));

        assert_eq!(second.try_recv().expect("newer waiter"), 0);
        assert!(matches!(
            first.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    /// A write status nobody is waiting for is reported as unclaimed, and a disarmed write
    /// leaves no channel behind for a late status.
    #[test]
    fn an_unclaimed_or_disarmed_write_is_reported_not_swallowed() {
        let state = BleGattState::new();
        assert!(!state.deliver_write("nobody-asked", 0));

        let mut rx = state.arm_write("battery");
        state.disarm_write("battery");
        assert!(!state.deliver_write("battery", 0));
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    /// A CCC descriptor-write verdict reaches the waiter armed for **that** characteristic and
    /// nobody else — so two subscribes in flight cannot take each other's answer, and a device
    /// that refused the subscription is reported as a failure rather than the local registration
    /// being reported as success (REQ-A1158 / F-SH-459).
    #[test]
    fn a_descriptor_write_verdict_reaches_only_the_waiter_that_asked_for_it() {
        let state = BleGattState::new();
        let mut battery = state.arm_descriptor_write("battery");
        let mut heart_rate = state.arm_descriptor_write("heart-rate");

        // GATT_ERROR (133) — the classic "the device refused to turn notifications on".
        assert!(state.deliver_descriptor_write("battery", 133));

        assert_eq!(battery.try_recv().expect("battery verdict"), 133);
        assert!(matches!(
            heart_rate.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        assert!(state.deliver_descriptor_write("heart-rate", 0));
        assert_eq!(heart_rate.try_recv().expect("heart-rate verdict"), 0);
    }

    /// A descriptor-write verdict nobody is waiting for is reported as unclaimed (so the callback
    /// can log that the device did answer), and a disarmed waiter leaves no channel behind for a
    /// late verdict — the case of a characteristic whose CCC the glue reported as absent.
    #[test]
    fn an_unclaimed_or_disarmed_descriptor_write_is_reported_not_swallowed() {
        let state = BleGattState::new();
        assert!(!state.deliver_descriptor_write("nobody-asked", 0));

        let mut rx = state.arm_descriptor_write("battery");
        state.disarm_descriptor_write("battery");
        assert!(!state.deliver_descriptor_write("battery", 0));
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    /// A delivered value resolves **the** waiter that asked for that characteristic and nobody
    /// else. The old single-slot state returned the same bytes to whoever called next, with the
    /// UUID discarded — a reading attributed to the wrong sensor (REQ-A413).
    #[test]
    fn a_read_result_reaches_only_the_waiter_that_asked_for_it() {
        let state = BleGattState::new();
        let mut battery = state.arm_read("battery");
        let mut temperature = state.arm_read("temperature");

        assert!(state.deliver_read("battery", vec![99]));

        assert_eq!(
            battery
                .try_recv()
                .expect("battery answer")
                .expect("a value"),
            vec![99]
        );
        assert!(matches!(
            temperature.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        assert!(state.deliver_read("temperature", vec![21]));
        assert_eq!(
            temperature
                .try_recv()
                .expect("temperature answer")
                .expect("a value"),
            vec![21]
        );
    }

    /// A **failed** read carries the stack's own status instead of vanishing into the 5s
    /// timeout: this is the half REQ-A413 left open (Kotlin only called back on `GATT_SUCCESS`),
    /// so a device that refused the read reached the screen as "no result within 5s" with no
    /// cause (REQ-A1158 / F-SH-459).
    #[test]
    fn a_read_failure_status_reaches_its_waiter_and_not_its_neighbour() {
        let state = BleGattState::new();
        let mut battery = state.arm_read("battery");
        let mut temperature = state.arm_read("temperature");

        assert!(state.deliver_read_failure("battery", 137)); // GATT_ERROR

        assert_eq!(
            battery.try_recv().expect("battery verdict"),
            Err(137),
            "the stack's non-zero status is the answer, not an absence"
        );
        assert!(matches!(
            temperature.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        // A success on the same characteristic is still an `Ok` — the two outcomes are told
        // apart, never collapsed (a `0` status must not read as a failure).
        assert!(state.deliver_read("temperature", vec![21]));
        assert_eq!(
            temperature.try_recv().expect("temperature answer"),
            Ok(vec![21])
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

        assert_eq!(
            second.try_recv().expect("newer waiter").expect("a value"),
            vec![7]
        );
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

    /// The connection **verdict** reaches the caller that asked for the connection: the stack's
    /// `(connected, status)`, not the fact that `connectGatt` returned a client object. This is
    /// the half `ble_connect` used to skip — it returned whether a `BluetoothGatt` was created,
    /// so a rendezvous the stack then refused with 133 still read as 「已连接」 (REQ-A1158 /
    /// F-SH-459).
    #[test]
    fn a_connection_verdict_resolves_the_armed_waiter_with_its_status() {
        let state = BleGattState::new();
        let mut rx = state.arm_connect();

        // A refusal is a verdict too — `connected == false` *and* the stack's own status.
        assert!(state.deliver_connect(false, 133));

        assert_eq!(rx.try_recv().expect("connect verdict"), (false, 133));

        // A success is a different verdict, not the same one with a different flag.
        let mut rx = state.arm_connect();
        assert!(state.deliver_connect(true, 0));
        assert_eq!(rx.try_recv().expect("connect verdict"), (true, 0));
    }

    /// A second connect supersedes the first (the older caller is told, its sender dropped), and
    /// a connect nobody is waiting for is *reported* as unclaimed so the callback can log it
    /// rather than dropping the device's answer in silence.
    #[test]
    fn a_second_connect_supersedes_the_first_and_an_unclaimed_one_is_reported() {
        let state = BleGattState::new();
        assert!(!state.deliver_connect(true, 0));

        let mut first = state.arm_connect();
        let mut second = state.arm_connect();
        assert!(state.deliver_connect(true, 0));

        assert_eq!(second.try_recv().expect("newer waiter"), (true, 0));
        assert!(matches!(
            first.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));

        let mut rx = state.arm_connect();
        state.disarm_connect();
        assert!(!state.deliver_connect(true, 0));
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    /// The wire event name is declared once, in `ble.rs`, and the JNI callbacks
    /// emit **through** that declaration. This is a source-level pin, so the
    /// negative control is a host test: re-spelling the wire name as a literal at
    /// any emit site makes it fail.
    ///
    /// A runtime assertion (`emitted == BLE_VALUE_EVENT`) cannot catch this: a
    /// literal with the same value compares equal. What can be caught — and is
    /// what actually breaks the frontend, whose own mirrored constant would no
    /// longer match after a rename — is the *existence of a second spelling*.
    /// Only reading the file can express "the declaration is the only spelling".
    #[test]
    fn the_production_half_emits_through_the_declared_event_constants() {
        const SRC: &str = include_str!("jni_glue.rs");
        let production_end = SRC
            .find("#[cfg(test)]")
            .expect("this file has a test module");
        let production = &SRC[..production_end];
        for (name, constant) in [
            ("ble-value-changed", "crate::ble::BLE_VALUE_EVENT"),
            ("nfc-tag-discovered", "crate::ble::NFC_TAG_EVENT"),
        ] {
            let quoted = format!("\"{name}\"");
            assert!(
                !production.contains(quoted.as_str()),
                "jni_glue.rs must emit {constant}, not the literal {quoted}: a second \
                 spelling makes the `ble.rs` declaration a lie and a rename a silent \
                 wire break for every listener"
            );
        }
    }

    /// …and the callbacks really do reach the wire under those declared names.
    /// Null handles are enough: `extract_jstring` / `extract_byte_array` null-check
    /// their arguments before wrapping anything, so the empty-string path runs the
    /// same `emit` the device path runs.
    #[test]
    fn the_jni_callbacks_emit_the_declared_event_names() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        set_emitter(move |event, _payload| {
            sink.lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(event.to_string());
        });

        // SAFETY: null handles. Both extractors check for null before wrapping, so
        // nothing is dereferenced; the point is to run the emit, not the parse.
        unsafe {
            Java_com_amos_ai_glue_NfcGlue_onNfcTagDiscovered(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            Java_com_amos_ai_glue_BluetoothGattGlue_onCharacteristicChanged(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
        }

        assert_eq!(
            seen.lock().unwrap_or_else(|p| p.into_inner()).as_slice(),
            [crate::ble::NFC_TAG_EVENT, crate::ble::BLE_VALUE_EVENT],
        );
    }

    /// Strip Kotlin block and line comments, leaving string literals intact — so the file's own
    /// prose (which exists to *describe* the rule) cannot answer a question about the code.
    ///
    /// A `//` inside a string literal is not a comment; that is what makes this a character
    /// machine rather than a `find("//")` (the same helper `incall.rs` / `rotation.rs` carry; see
    /// `incall.rs`'s note on why the copies are not shared).
    fn strip_kotlin_comments(src: &str) -> String {
        let chars: Vec<char> = src.chars().collect();
        let mut out = String::with_capacity(src.len());
        let mut i = 0usize;
        let mut block_depth = 0usize;
        while i < chars.len() {
            let c = chars[i];
            if block_depth > 0 {
                if c == '/' && chars.get(i + 1) == Some(&'*') {
                    block_depth += 1;
                    i += 2;
                } else if c == '*' && chars.get(i + 1) == Some(&'/') {
                    block_depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'/') {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                block_depth = 1;
                i += 2;
                continue;
            }
            if c == '"' {
                out.push(c);
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        out.push(chars[i]);
                        i += 1;
                    }
                    out.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            out.push(c);
            i += 1;
        }
        out
    }

    /// Every integer `const` in `src`, as `(NAME, value)` — in both spellings this seam uses
    /// (Kotlin `const val NAME = 0`, Rust `pub const NAME: i32 = 0;`).
    fn const_numbers(src: &str) -> Vec<(String, i64)> {
        let mut out = Vec::new();
        let mut from = 0usize;
        while let Some(rel) = src[from..].find("const ") {
            let after_const = from + rel + "const ".len();
            let rest = &src[after_const..];
            let rest = rest.strip_prefix("val ").unwrap_or(rest);
            let Some(eq) = rest.find('=') else { break };
            let head = &rest[..eq];
            let name = head
                .split([':', ' ', '\n', '\t'])
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            let after = rest[eq + 1..].trim_start();
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !name.is_empty() {
                if let Ok(v) = digits.parse::<i64>() {
                    out.push((name, v));
                }
            }
            from = after_const + eq + 1;
        }
        out
    }

    /// The three `setCharacteristicNotification` verdict codes are a **two-sided** contract with
    /// no compiler across the JNI seam: Kotlin answers one of `NOTIFY_NO_REQUEST` /
    /// `NOTIFY_DESCRIPTOR_QUEUED` / `NOTIFY_NO_DESCRIPTOR`, and `ble.rs::notify_verdict` decides
    /// what each one means (await the device, refuse, or treat a disable as vacuous). Only the
    /// *numbers* cross the wire, so a flip on either side silently reinterprets the device's
    /// answer — e.g. `NO_DESCRIPTOR` and `DESCRIPTOR_QUEUED` exchanged makes `ble_subscribe`
    /// wait five seconds for a verdict that will never come, and read the CCC-absent case as a
    /// success. `jni-contract-scan` pins the *signature* (`…Z)I`), not the values.
    ///
    /// Both directions, from **source text on both sides** (so neither list is hand-copied into
    /// this test): every Kotlin code must have a Rust counterpart with the same number, and every
    /// Rust code must be claimed by Kotlin. A floor pins that the extractors found anything at
    /// all.
    #[test]
    fn the_notify_verdict_codes_agree_across_the_jni_seam() {
        const KT: &str = include_str!("../android-glue/com/amos/ai/glue/BluetoothGattGlue.kt");
        const RUST: &str = include_str!("ble.rs");

        let kt_code = strip_kotlin_comments(KT);
        let kt: Vec<(String, i64)> = const_numbers(&kt_code)
            .into_iter()
            .filter(|(n, _)| n.starts_with("NOTIFY_"))
            .collect();

        let rust_mod = RUST
            .find("mod notify_verdict {")
            .expect("ble.rs must declare the `notify_verdict` module the Kotlin codes mirror");
        let rust_body = &RUST[rust_mod..];
        let rust_end = rust_body
            .find("\n}\n")
            .expect("the `notify_verdict` module must still close");
        let rust: Vec<(String, i64)> = const_numbers(&rust_body[..rust_end])
            .into_iter()
            .map(|(n, v)| (format!("NOTIFY_{n}"), v))
            .collect();

        // Floor: "scanned nothing" must not read as green.
        assert_eq!(
            kt.len(),
            3,
            "expected the three NOTIFY_* codes in BluetoothGattGlue.kt, found {kt:?}"
        );
        assert_eq!(
            rust.len(),
            3,
            "expected the three notify_verdict consts in ble.rs, found {rust:?}"
        );

        for (name, value) in &kt {
            let Some((_, rust_value)) = rust.iter().find(|(n, _)| n == name) else {
                panic!(
                    "BluetoothGattGlue.kt declares {name} = {value}, but ble.rs's `notify_verdict` \
                     has no counterpart: the glue would answer a code `ble_subscribe` cannot read"
                );
            };
            assert_eq!(
                value, rust_value,
                "{name} is {value} in Kotlin and {rust_value} in Rust — only the number crosses \
                 the seam, so the two sides now disagree about what this answer means"
            );
        }
        for (name, _) in &rust {
            assert!(
                kt.iter().any(|(n, _)| n == name),
                "ble.rs declares {name}, but BluetoothGattGlue.kt never answers it — the Rust \
                 branch that reads it is dead on device"
            );
        }
    }
}
