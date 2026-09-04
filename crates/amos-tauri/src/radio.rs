//! Tauri <-> radio/connectivity bridge (in-process).
//!
//! The WebView's quick-settings toggles call `radio_status`/`radio_set`. Unlike
//! telephony (which round-trips to the headless `amos-ai` daemon), Wi-Fi and
//! Bluetooth on the no-UI Android base are owned by Android services reachable
//! *from the System UI APK itself* (Android `ConnectivityManager` for Wi-Fi,
//! `BluetoothManager` for Bluetooth, via JNI/binder). So the provider seam lives
//! here and is driven directly by these commands.
//!
//! Today a [`MockRadioProvider`] backs the bridge, seeded from the durable
//! `amos.settings` store so quick-settings survive restarts; every successful
//! set is mirrored back into that store (preserving the other toggles) so the
//! cross-window `store-updated` sync keeps working. A real Android provider
//! replaces the Mock under `amos-radio`'s `android` feature (docs/radio.md).

use std::sync::Arc;

use crate::store::SharedStore;
use amos_radio::{MockRadioProvider, RadioManager, RadioMode, RadioProvider, RadioSnapshot};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, State};

/// Serializable snapshot of the radios (prost-free; plain bools).
#[derive(Clone, Debug, Serialize)]
pub struct RadioPayload {
    pub wifi: bool,
    pub bluetooth: bool,
    pub airplane: bool,
}

impl From<RadioSnapshot> for RadioPayload {
    fn from(s: RadioSnapshot) -> Self {
        Self {
            wifi: s.wifi,
            bluetooth: s.bluetooth,
            airplane: s.airplane,
        }
    }
}

/// Managed state: a policy-owning [`RadioManager`] over the active provider.
pub struct RadioBridge {
    manager: RadioManager,
}

impl RadioBridge {
    /// Build a bridge backed by [`MockRadioProvider`] seeded from `seed` (the
    /// persisted radio bits read from `amos.settings` at boot).
    pub fn mock_seeded(seed: RadioSnapshot) -> Self {
        let provider: Arc<dyn RadioProvider> = Arc::new(MockRadioProvider::new(seed));
        Self {
            manager: RadioManager::new(provider),
        }
    }

    /// **On-device**: back the bridge with the real Android provider
    /// ([`amos_radio::AndroidRadioProvider`]) instead of the Mock.
    ///
    /// `vm`/`env`/`context` come from the System UI APK's JNI environment (its
    /// `JavaVM` + a global ref to the Activity/Application context). Desktop has
    /// no JVM, so this is gated behind the `android` feature (see docs/radio.md
    /// §6); `cargo check --features android` keeps the wiring compiling.
    #[cfg(feature = "android")]
    pub fn from_android(
        vm: jni::JavaVM,
        env: &jni::JNIEnv<'_>,
        context: jni::objects::JObject<'_>,
        airplane_on: bool,
    ) -> Result<Self, String> {
        let provider = amos_radio::AndroidRadioProvider::new(vm, env, context, airplane_on)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            manager: RadioManager::new(Arc::new(provider)),
        })
    }
}

/// Parse persisted radio bits out of the durable `amos.settings` JSON so the Mock
/// starts where the last session left it. Unknown/corrupt input → defaults.
pub fn seed_from_settings(settings_json: Option<&str>) -> RadioSnapshot {
    let mut s = RadioSnapshot::default();
    if let Some(raw) = settings_json {
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(raw) {
            if let Some(b) = obj.get("wifi").and_then(Value::as_bool) {
                s.wifi = b;
            }
            if let Some(b) = obj.get("bluetooth").and_then(Value::as_bool) {
                s.bluetooth = b;
            }
            if let Some(b) = obj.get("airplane").and_then(Value::as_bool) {
                s.airplane = b;
            }
        }
    }
    s
}

/// Mirror the authoritative snapshot back into the `amos.settings` store key,
/// preserving every other quick-toggle (darkmode/dnd/location) in that object.
/// Uses `SharedStore::set` so the `store-updated` broadcast keeps every window in
/// sync (matching how the frontend's plain quick-toggles already write).
fn persist_radios(app: &AppHandle, store: &SharedStore, snap: RadioSnapshot) {
    let mut map: Map<String, Value> = match store
        .get("amos.settings")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
    {
        Some(m) => m,
        None => Map::new(),
    };
    map.insert("wifi".to_string(), Value::Bool(snap.wifi));
    map.insert("bluetooth".to_string(), Value::Bool(snap.bluetooth));
    map.insert("airplane".to_string(), Value::Bool(snap.airplane));
    if let Ok(text) = serde_json::to_string(&Value::Object(map)) {
        store.set(app, "amos.settings", text);
    }
}

/// Read the current radio state.
#[tauri::command]
pub async fn radio_status(bridge: State<'_, RadioBridge>) -> Result<RadioPayload, String> {
    let snap = bridge.manager.snapshot().await.map_err(|e| e.to_string())?;
    Ok(snap.into())
}

/// Toggle one radio (`wifi` / `bluetooth` / `airplane`), enforcing the Airplane
/// cascade/guard in the domain core, and return the authoritative snapshot.
#[tauri::command]
pub async fn radio_set(
    app: AppHandle,
    bridge: State<'_, RadioBridge>,
    store: State<'_, SharedStore>,
    key: String,
    enabled: bool,
) -> Result<RadioPayload, String> {
    let radio = RadioMode::from_key(&key).ok_or_else(|| format!("unknown radio key: {key:?}"))?;
    let snap = bridge
        .manager
        .set(radio, enabled)
        .await
        .map_err(|e| e.to_string())?;
    persist_radios(&app, &store, snap);
    Ok(snap.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_parses_known_radio_bits_only() {
        let seed = seed_from_settings(Some(r#"{"wifi":true,"airplane":true,"darkmode":1}"#));
        assert!(seed.wifi);
        assert!(!seed.bluetooth);
        assert!(seed.airplane);
    }

    #[test]
    fn seed_defaults_on_absent_or_corrupt_settings() {
        assert_eq!(seed_from_settings(None), RadioSnapshot::default());
        assert_eq!(
            seed_from_settings(Some("not json")),
            RadioSnapshot::default()
        );
        assert_eq!(
            seed_from_settings(Some("[1,2,3]")),
            RadioSnapshot::default()
        );
    }

    #[test]
    fn payload_round_trips_from_snapshot() {
        let p = RadioPayload::from(RadioSnapshot {
            wifi: true,
            bluetooth: false,
            airplane: true,
        });
        assert!(p.wifi);
        assert!(!p.bluetooth);
        assert!(p.airplane);
    }
}
