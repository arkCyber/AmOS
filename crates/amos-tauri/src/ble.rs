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

/// One GATT service discovered on the connected device.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BleService {
    pub uuid: String,
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

/// Bridge state: holds the current GATT connection state.
pub struct BleState {
    pub connected: std::sync::Mutex<bool>,
    pub address: std::sync::Mutex<Option<String>>,
}

impl BleState {
    pub fn new() -> Self {
        Self {
            connected: std::sync::Mutex::new(false),
            address: std::sync::Mutex::new(None),
        }
    }
}

impl Default for BleState {
    fn default() -> Self {
        Self::new()
    }
}

/// NFC status reply.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NfcStatusResult {
    pub available: bool,
    pub state: String,
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

/// Biometric availability reply.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BiometricAvailability {
    pub kind: String,
    pub label: String,
    pub enrolled: bool,
    pub hardware_present: bool,
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
    pub const BLE_CLASS: &str = "com/amos/ai/glue/BluetoothGattGlue";
    /// NFC glue class.
    pub const NFC_CLASS: &str = "com/amos/ai/glue/NfcGlue";
    /// Biometric glue class.
    pub const BIOMETRIC_CLASS: &str = "com/amos/ai/glue/BiometricGlue";

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
        let binding = BINDING.get()?;
        let mut env = amos_jni::attached(&binding.vm).ok()?;
        let result = f(&binding.context, &mut env);
        if result.is_err() {
            amos_jni::clear_pending(&env);
        }
        result.ok()
    }
}

#[cfg(feature = "android")]
use crate::jni_glue as glue_state;

// ─────────────────────────────────────────────────────────────────────────────
//  BLE GATT Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Connect to a BLE device by address.
#[tauri::command]
pub fn ble_connect(address: String) -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|ctx, env| {
            let addr = env.new_string(&address).map_err(|e| e.to_string())?;
            let sig = "(Landroid/content/Context;Ljava/lang/String;)Z";
            let args = [
                ::jni::objects::JValue::Object(ctx.as_ref()),
                ::jni::objects::JValue::Object(&addr),
            ];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::BLE_CLASS, "connect", sig, &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });
        match result {
            Some(true) => Ok(true),
            Some(false) => Ok(false),
            None => Err(AmosError::new(
                crate::error::ErrorCode::BleConnectFailed,
                "BluetoothGattGlue not bound".to_string(),
            )),
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
        let result = android_jni::with_context(|_ctx, env| {
            let args: [::jni::objects::JValue<'_, '_>; 0] = [];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::BLE_CLASS, "disconnect", "()Z", &args)
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
#[tauri::command]
pub fn ble_discover_services() -> Result<Vec<BleService>, AmosError> {
    #[cfg(feature = "android")]
    {
        let _ = android_jni::with_context(|_ctx, env| {
            let args: [::jni::objects::JValue<'_, '_>; 0] = [];
            amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::BLE_CLASS, "discoverServices", "()I", &args)
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        });
        if let Some(state) = glue_state::BLE_GATT_STATE.get() {
            let svcs = state.take_services();
            Ok(svcs
                .into_iter()
                .map(|s| BleService { uuid: s.uuid })
                .collect())
        } else {
            Ok(vec![])
        }
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(vec![])
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
        let started = android_jni::with_context(|_ctx, env| {
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
                env.call_static_method(android_jni::BLE_CLASS, "readCharacteristic", sig, &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });

        match started {
            Some(true) => {}
            refused => {
                // Never leave a waiter behind for an answer that cannot come.
                state.disarm_read(&characteristic_uuid);
                return Ok(BleReadResult {
                    ok: false,
                    bytes: None,
                    error: Some(match refused {
                        Some(false) => "the platform refused readCharacteristic".to_string(),
                        _ => "BluetoothGattGlue not bound".to_string(),
                    }),
                });
            }
        }

        // A GATT read the stack *refuses* (status != GATT_SUCCESS) never calls the callback, so
        // it surfaces here as the timeout rather than as a wrong value.
        match tokio::time::timeout(READ_TIMEOUT, rx).await {
            Ok(Ok(bytes)) => Ok(BleReadResult {
                ok: true,
                bytes: Some(bytes),
                error: None,
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
                        "no read result within {READ_TIMEOUT:?} (the GATT read failed or the device did not answer)"
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
#[tauri::command]
pub async fn ble_write(
    service_uuid: String,
    characteristic_uuid: String,
    value: Vec<u8>,
    with_response: bool,
) -> Result<BleWriteResult, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|_ctx, env| {
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
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::BLE_CLASS, "writeCharacteristic", sig, &args)
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });
        Ok(BleWriteResult {
            ok: result == Some(true),
            error: if result == Some(true) {
                None
            } else {
                Some("writeCharacteristic failed".to_string())
            },
        })
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

/// Start receiving notifications for a GATT characteristic.
#[tauri::command]
pub fn ble_subscribe(service_uuid: String, characteristic_uuid: String) -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|_ctx, env| {
            let svc = env.new_string(&service_uuid).map_err(|e| e.to_string())?;
            let chr = env
                .new_string(&characteristic_uuid)
                .map_err(|e| e.to_string())?;
            // Resolve the characteristic via the service UUID first, so two
            // services that share a 16-bit characteristic UUID (very common,
            // e.g. `0x2A19` Battery Level appears in both the Battery Service
            // and the Environmental Sensor service) don't silently get bound to
            // the wrong one.
            let sig = "(Ljava/lang/String;Ljava/lang/String;Z)Z";
            let args = [
                ::jni::objects::JValue::Object(&svc),
                ::jni::objects::JValue::Object(&chr),
                ::jni::objects::JValue::Bool(1),
            ];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(
                    android_jni::BLE_CLASS,
                    "setCharacteristicNotification",
                    sig,
                    &args
                )
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });
        Ok(result.unwrap_or(false))
    }
    #[cfg(not(feature = "android"))]
    {
        let _ = (service_uuid, characteristic_uuid);
        Ok(false)
    }
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
pub fn ble_unsubscribe(
    service_uuid: String,
    characteristic_uuid: String,
) -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|_ctx, env| {
            let svc = env.new_string(&service_uuid).map_err(|e| e.to_string())?;
            let chr = env
                .new_string(&characteristic_uuid)
                .map_err(|e| e.to_string())?;
            let sig = "(Ljava/lang/String;Ljava/lang/String;Z)Z";
            let args = [
                ::jni::objects::JValue::Object(&svc),
                ::jni::objects::JValue::Object(&chr),
                ::jni::objects::JValue::Bool(0),
            ];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(
                    android_jni::BLE_CLASS,
                    "setCharacteristicNotification",
                    sig,
                    &args
                )
            )
            .map_err(|e| e.to_string())?;
            v.z().map_err(|e| e.to_string())
        });
        Ok(result.unwrap_or(false))
    }
    #[cfg(not(feature = "android"))]
    {
        let _ = (service_uuid, characteristic_uuid);
        Ok(false)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  NFC Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Check whether NFC hardware is present and enabled.
#[tauri::command]
pub fn nfc_status() -> Result<NfcStatusResult, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|ctx, env| {
            // NfcGlue.init(context)
            let init_sig = "(Landroid/content/Context;)Z";
            let init_args = [::jni::objects::JValue::Object(ctx.as_ref())];
            let _ = amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::NFC_CLASS, "init", init_sig, &init_args)
            )
            .map_err(|e| e.to_string())?;

            // NfcGlue.getStatus() → String (JSON)
            let args: [::jni::objects::JValue<'_, '_>; 0] = [];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(
                    android_jni::NFC_CLASS,
                    "getStatus",
                    "()Ljava/lang/String;",
                    &args
                )
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
        match result {
            Some(json_str) => {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    Ok(NfcStatusResult {
                        available: parsed["available"].as_bool().unwrap_or(false),
                        state: parsed["state"]
                            .as_str()
                            .unwrap_or("no_hardware")
                            .to_string(),
                    })
                } else {
                    Ok(NfcStatusResult {
                        available: false,
                        state: "no_hardware".to_string(),
                    })
                }
            }
            None => Ok(NfcStatusResult {
                available: false,
                state: "no_hardware".to_string(),
            }),
        }
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(NfcStatusResult {
            available: false,
            state: "no_hardware".to_string(),
        })
    }
}

/// Start NFC foreground dispatch.
#[tauri::command]
pub fn nfc_start_dispatch(_app: AppHandle) -> Result<bool, AmosError> {
    #[cfg(feature = "android")]
    {
        // First init the adapter, then start foreground dispatch.
        // Foreground dispatch needs Activity; we use the bound context.
        let result = android_jni::with_context(|ctx, env| {
            // Initialize the NFC adapter.
            let init_sig = "(Landroid/content/Context;)Z";
            let init_args = [::jni::objects::JValue::Object(ctx.as_ref())];
            let init_ok = amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::NFC_CLASS, "init", init_sig, &init_args)
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
                    android_jni::NFC_CLASS,
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
            // Stop foreground dispatch with the activity from the context.
            let sig = "(Landroid/app/Activity;)Z";
            let args = [::jni::objects::JValue::Object(ctx.as_ref())];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(
                    android_jni::NFC_CLASS,
                    "stopForegroundDispatch",
                    sig,
                    &args
                )
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
        let result = android_jni::with_context(|_ctx, env| {
            let args: [::jni::objects::JValue<'_, '_>; 0] = [];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::NFC_CLASS, "formatTag", "()Z", &args)
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
        let result = android_jni::with_context(|_ctx, env| {
            let jstr = env.new_string(&json_str).map_err(|e| e.to_string())?;
            let sig = "(Ljava/lang/String;)Z";
            let args = [::jni::objects::JValue::Object(&jstr)];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::NFC_CLASS, "writeNdefMessage", sig, &args)
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
            None => Ok(NfcWriteResult {
                ok: false,
                bytes_written: None,
                error: Some("NfcGlue not bound".to_string()),
            }),
        }
    }
    #[cfg(not(feature = "android"))]
    {
        let _ = records;
        Ok(NfcWriteResult {
            ok: false,
            bytes_written: None,
            error: Some("NFC not available".to_string()),
        })
    }
}

/// Read raw bytes from a specific NFC tag id.
///
/// The Kotlin glue reads the **currently held** tag (`readTagBytes()` takes no arguments), so
/// the id is informational here — but it must still be declared under the name the caller sends:
/// the frontend sends `tagId`, Tauri maps that to `tag_id`, and the parameter used to be named
/// `_tag_id`, which is a *different* key — the command failed with "invalid args" before it ever
/// reached the glue. `tauri-args-scan` reported it as "key `tagId` matches no argument" (REQ-A412).
/// The id is logged rather than dropped, so the value is not accepted-and-ignored in silence.
#[tauri::command]
pub fn nfc_read_bytes(tag_id: String) -> Result<Option<String>, AmosError> {
    tracing::debug!(
        target: "amos::ble",
        %tag_id,
        "nfc_read_bytes: the glue reads the held tag; the id is informational"
    );
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|_ctx, env| {
            let args: [::jni::objects::JValue<'_, '_>; 0] = [];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(
                    android_jni::NFC_CLASS,
                    "readTagBytes",
                    "()Ljava/lang/String;",
                    &args
                )
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
            Ok::<Option<String>, String>(Some(s.into()))
        });
        Ok(result.flatten())
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(None)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Biometric Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Check biometric hardware presence and enrollment status.
#[tauri::command]
pub fn biometric_available() -> Result<BiometricAvailability, AmosError> {
    #[cfg(feature = "android")]
    {
        let result = android_jni::with_context(|ctx, env| {
            let sig = "(Landroid/content/Context;)Ljava/lang/String;";
            let args = [::jni::objects::JValue::Object(ctx.as_ref())];
            let v = amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::BIOMETRIC_CLASS, "getAvailability", sig, &args)
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
        match result {
            Some(json_str) => {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    Ok(BiometricAvailability {
                        kind: parsed["kind"].as_str().unwrap_or("none").to_string(),
                        label: parsed["label"].as_str().unwrap_or("生物识别").to_string(),
                        enrolled: parsed["enrolled"].as_bool().unwrap_or(false),
                        hardware_present: parsed["hardware_present"].as_bool().unwrap_or(false),
                    })
                } else {
                    Ok(BiometricAvailability {
                        kind: "none".to_string(),
                        label: "生物识别".to_string(),
                        enrolled: false,
                        hardware_present: false,
                    })
                }
            }
            None => Ok(BiometricAvailability {
                kind: "none".to_string(),
                label: "生物识别".to_string(),
                enrolled: false,
                hardware_present: false,
            }),
        }
    }
    #[cfg(not(feature = "android"))]
    {
        Ok(BiometricAvailability {
            kind: "none".to_string(),
            label: "生物识别".to_string(),
            enrolled: false,
            hardware_present: false,
        })
    }
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
            None => {
                return Ok(BiometricResult {
                    ok: false,
                    result: None,
                    error: Some("biometric not initialized".to_string()),
                });
            }
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
            let sig = "(Landroid/content/Context;Ljava/lang/String;Z)V";
            let reason_jstr = env.new_string(&reason).map_err(|e| e.to_string())?;
            let args = [
                ::jni::objects::JValue::Object(ctx.as_ref()),
                ::jni::objects::JValue::Object(&reason_jstr),
                ::jni::objects::JValue::Bool(if allow_device_credential { 1 } else { 0 }),
            ];
            amos_jni::jni_call!(
                env,
                env.call_static_method(android_jni::BIOMETRIC_CLASS, "authenticate", sig, &args)
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
            return Ok(BiometricResult {
                ok: false,
                result: None,
                error: Some("biometric not initialized".to_string()),
            });
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
        Ok(BiometricResult {
            ok: false,
            result: None,
            error: Some("biometric not available".to_string()),
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public install entry
// ─────────────────────────────────────────────────────────────────────────────

/// Install the device glue binding (called from MainActivity.onStart via JNI).
#[cfg(feature = "android")]
pub fn install_glue(
    env: &mut ::jni::JNIEnv<'_>,
    context: jni::objects::JObject<'_>,
) -> Result<(), String> {
    android_jni::install(env, context)?;
    glue_state::init();
    Ok(())
}
