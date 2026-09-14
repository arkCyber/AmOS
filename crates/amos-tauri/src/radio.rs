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

use std::sync::{Arc, OnceLock};

use crate::store::SharedStore;
use amos_radio::{
    MockRadioProvider, RadioControl, RadioError, RadioManager, RadioMode, RadioProvider,
    RadioSnapshot, SwitchableProvider,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

/// The provider every command goes through, and the seed the Mock was built from.
///
/// Process-wide (not Tauri state) because the Android glue reaches Rust through a
/// JNI upcall (`Java_com_amos_ai_glue_RadioGlue_attachNative`), which has no
/// `State` to read: it needs the *same* switchable provider the commands use, so the
/// device backend replaces the Mock instead of living beside it (REQ-A185).
static SWITCHABLE: OnceLock<Arc<SwitchableProvider>> = OnceLock::new();
/// The radio bits the store held at boot — the Android provider starts from them,
/// because the platform's airplane bit is not readable by a normal install.
static SEED: OnceLock<RadioSnapshot> = OnceLock::new();

/// Serializable snapshot of the radios (prost-free; plain bools).
#[derive(Clone, Debug, Serialize)]
pub struct RadioPayload {
    pub wifi: bool,
    pub bluetooth: bool,
    pub airplane: bool,
    /// The Wi-Fi access point (personal hotspot) is up.
    pub hotspot: bool,
}

impl From<RadioSnapshot> for RadioPayload {
    fn from(s: RadioSnapshot) -> Self {
        Self {
            wifi: s.wifi,
            bluetooth: s.bluetooth,
            airplane: s.airplane,
            hotspot: s.hotspot,
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
    ///
    /// The Mock sits inside a [`SwitchableProvider`], so the Android glue can hand
    /// the real backend to the **same** provider later (REQ-A185): before that upcall
    /// the quick-settings tiles mirror the store (offline behaviour, unchanged);
    /// after it, reads and writes go to the device.
    pub fn mock_seeded(seed: RadioSnapshot) -> Self {
        let provider: Arc<dyn RadioProvider> = Arc::new(MockRadioProvider::new(seed));
        let switchable = Arc::new(SwitchableProvider::new(provider));
        // First call wins; a second `RadioBridge` (tests, a re-entrant setup) must not
        // silently steal the JNI attach point — so a losing `set` is *reported*, not
        // discarded (REQ-A186: the discard gate found these two).
        if SWITCHABLE.set(Arc::clone(&switchable)).is_err() {
            tracing::warn!(
                target: "amos::radio",
                "a radio bridge already owns the JNI attach point — this instance keeps its own provider"
            );
        }
        if SEED.set(seed).is_err() {
            tracing::debug!(target: "amos::radio", "radio seed already recorded");
        }
        Self {
            manager: RadioManager::new(switchable),
        }
    }

    /// **On-device**: hand the real Android provider
    /// ([`amos_radio::AndroidRadioProvider`]) to the process-wide
    /// [`SwitchableProvider`] that `radio_status`/`radio_set` already go through, so
    /// the quick-settings tiles stop mirroring the store and start reading and
    /// driving the device (REQ-A185).
    ///
    /// Called from the JNI upcall below (`RadioGlue.attachNative`, wired from
    /// `AmosGlue.onStart`). `vm`/`env`/`context` are the System UI APK's JNI
    /// environment plus a reference to the app context.
    #[cfg(feature = "android")]
    pub fn install_android(
        vm: jni::JavaVM,
        env: &mut jni::JNIEnv<'_>,
        context: jni::objects::JObject<'_>,
    ) -> Result<(), String> {
        let Some(switchable) = SWITCHABLE.get() else {
            return Err(
                "radio bridge not built yet — mock_seeded must run before the glue attaches"
                    .to_string(),
            );
        };
        // The provider starts from the persisted bits: the platform's airplane
        // setting is not readable by a normal install, and this keeps the
        // pre/post-switch behaviour identical for every other bit.
        let airplane_on = SEED.get().copied().unwrap_or_default().airplane;
        let provider = amos_radio::AndroidRadioProvider::new(vm, env, context, airplane_on)
            .map_err(|e| e.to_string())?;
        switchable.install(Arc::new(provider))?;
        tracing::info!(
            target: "amos::radio",
            "Android radio provider installed — radio_status/radio_set now read and drive the device"
        );
        Ok(())
    }
}

/// JNI upcall from `com.amos.ai.glue.RadioGlue.attachNative(context)`.
///
/// This is the *only* way the real radio provider can reach Rust: the `JavaVM` +
/// `Context` exist only inside the Android app, and Tauri's `setup` (where the
/// bridge is built) runs before the Activity hands them over. Without this upcall
/// the APK ships a compiled `AndroidRadioProvider` that nothing ever installs and
/// every radio call is answered by the Mock — the defect a device round found
/// (REQ-A185: "the tiles claimed Wi-Fi off while the phone's Wi-Fi was on").
/// # Safety
///
/// Called by the JVM as the native implementation of
/// `RadioGlue.attachNative(context)`: `env`/`this` are the standard JNI
/// instance-method arguments and `context` a live `android.content.Context` local
/// reference, all valid for the duration of the call. Nothing here may be called
/// with fabricated pointers.
#[cfg(feature = "android")]
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_RadioGlue_attachNative(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    context: jni::sys::jobject,
) {
    if env.is_null() || context.is_null() {
        return; // nothing to attach to — the Mock stays in place, honestly
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call, valid for its
    // duration; the returned guard borrows it only inside this scope.
    let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return;
    };
    let Ok(vm) = env.get_java_vm() else {
        return;
    };
    // SAFETY: `context` is a live local reference passed as this call's argument and
    // is only read (never stored) before the JVM reclaims it.
    let ctx = unsafe { jni::objects::JObject::from_raw(context) };
    match RadioBridge::install_android(vm, &mut env, ctx) {
        Ok(()) => {}
        Err(e) => tracing::warn!(
            target: "amos::radio",
            error = %e,
            "Android radio provider NOT installed — quick-settings keep mirroring the store"
        ),
    }
}

/// The store key for the shared quick-settings object (wifi / bluetooth / airplane /
/// hotspot plus the frontend-owned darkmode / dnd / location toggles this merge must
/// preserve).
pub const SETTINGS_KEY: &str = "amos.settings";

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
            if let Some(b) = obj.get("hotspot").and_then(Value::as_bool) {
                s.hotspot = b;
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
    let (mut map, unusable) = crate::store::object_for_merge(store, SETTINGS_KEY);
    if unusable {
        // Nothing in the stored value can be preserved (it is not a JSON object), so the
        // darkmode/dnd/location toggles it should have carried are about to be replaced.
        tracing::warn!(
            target: "amos::radio",
            key = SETTINGS_KEY,
            "stored quick-settings value is not a JSON object — other toggles cannot be preserved"
        );
    }
    map.insert("wifi".to_string(), Value::Bool(snap.wifi));
    map.insert("bluetooth".to_string(), Value::Bool(snap.bluetooth));
    map.insert("airplane".to_string(), Value::Bool(snap.airplane));
    map.insert("hotspot".to_string(), Value::Bool(snap.hotspot));
    if let Ok(text) = serde_json::to_string(&Value::Object(map)) {
        store.set(app, SETTINGS_KEY, text);
    }
}

/// Read the current radio state.
#[tauri::command]
pub async fn radio_status(bridge: State<'_, RadioBridge>) -> Result<RadioPayload, String> {
    let snap = bridge.manager.snapshot().await.map_err(|e| e.to_string())?;
    Ok(snap.into())
}

/* ---- Bluetooth details (REQ-A199): beyond the on/off bit, a screen shows what the
 *      adapter calls itself and which devices it is paired with. All three commands
 *      answer with the **device's** value or a plain error — the offline Mock answers
 *      "unsupported", which is what tells the UI to fall back to its remembered
 *      preference instead of presenting it as a device fact. ---- */

/// Serializable view of one paired device.
#[derive(Clone, Debug, Serialize)]
pub struct BluetoothPeerPayload {
    pub address: String,
    pub name: String,
}

impl From<amos_radio::BtPeer> for BluetoothPeerPayload {
    fn from(p: amos_radio::BtPeer) -> Self {
        Self {
            address: p.address,
            name: p.name,
        }
    }
}

/// The Bluetooth adapter's own name, as the device reports it.
///
/// Fails (rather than returning the store's remembered name) when nobody can ask the
/// adapter — an Android build whose glue never attached, or a desktop run. The screen
/// then keeps showing its remembered value **as a preference**; that difference is the
/// whole point of this command existing instead of reusing the store.
#[tauri::command]
pub async fn bluetooth_adapter_name(bridge: State<'_, RadioBridge>) -> Result<String, String> {
    bridge
        .manager
        .bluetooth_local_name()
        .await
        .map_err(|e| e.to_string())
}

/// Rename the adapter; answers with the name the **adapter** reports afterwards (it may
/// truncate or normalize), which is what the screen must mirror.
///
/// Note there is no store write here, unlike [`radio_set`]: the bits `radio_set`
/// persists live in the shared quick-settings object Rust already owns and merges, while
/// `amos.bluetooth` is the screen's own shape (`name` + `discoverable` + `paired`) — the
/// command hands back the fact and the screen mirrors it, so the two cannot drift into
/// disagreeing shapes.
#[tauri::command]
pub async fn bluetooth_rename_adapter(
    bridge: State<'_, RadioBridge>,
    name: String,
) -> Result<String, String> {
    bridge
        .manager
        .set_bluetooth_local_name(&name)
        .await
        .map_err(|e| e.to_string())
}

/// The devices the adapter is paired with. An empty list is a real answer ("paired with
/// nothing"); an error means nobody could ask.
///
/// There is deliberately **no unpair command**: `BluetoothDevice#removeBond` is not in
/// the public SDK, so a normally-installed app cannot unpair — the screen says so
/// instead of offering a button that would fail (docs/radio.md §10).
#[tauri::command]
pub async fn bluetooth_paired_devices(
    bridge: State<'_, RadioBridge>,
) -> Result<Vec<BluetoothPeerPayload>, String> {
    bridge
        .manager
        .bluetooth_paired_devices()
        .await
        .map(|peers| peers.into_iter().map(Into::into).collect())
        .map_err(|e| e.to_string())
}

/* ---- Bluetooth discovery (REQ-A200): start/stop a scan, read its state, ask the
 *      platform to pair. The scan itself lives in the Kotlin glue (a BroadcastReceiver
 *      cannot live in Rust); these commands are the only way the screen reaches it. ---- */

/// One device seen by a scan.
#[derive(Clone, Debug, Serialize)]
pub struct BluetoothScanDevicePayload {
    pub address: String,
    /// The advertised name, or `""` when the platform has none — the screen then labels
    /// the row with the address (it must never render a blank row).
    pub name: String,
    /// Signal strength in dBm when reported.
    pub rssi: Option<i32>,
    /// The **raw** platform bond state (10 none / 11 bonding / 12 bonded) — three states,
    /// not a bool, so the row can offer "pair", show pairing progress, or carry the
    /// paired tag (REQ-A201).
    pub bond: i32,
    /// Seen over a Bluetooth **LE** advertisement (as opposed to classic BR/EDR
    /// discovery) — the row says which channel saw it.
    pub le: bool,
}

/// One bond transition seen during the scan session (see `amos_radio::BtBond`).
#[derive(Clone, Debug, Serialize)]
pub struct BluetoothBondPayload {
    pub address: String,
    pub state: i32,
}

/// A scan's state: running / on which transports / **capped** / allowed / results.
///
/// `scan_allowed == false` (no `BLUETOOTH_SCAN`) is deliberately distinct from an empty
/// `devices` list: "this app may not look" and "nothing is nearby" are different facts.
/// The same distinction lives one level down in `classic` / `le`: an empty list on a
/// transport that was never scanned is not evidence of an empty room.
#[derive(Clone, Debug, Serialize)]
pub struct BluetoothScanPayload {
    pub discovering: bool,
    pub classic: bool,
    pub le: bool,
    pub capped: bool,
    pub scan_allowed: bool,
    pub devices: Vec<BluetoothScanDevicePayload>,
    pub bonds: Vec<BluetoothBondPayload>,
}

impl From<amos_radio::BtScan> for BluetoothScanPayload {
    fn from(s: amos_radio::BtScan) -> Self {
        Self {
            discovering: s.discovering,
            classic: s.classic,
            le: s.le,
            capped: s.capped,
            scan_allowed: s.scan_allowed,
            devices: s
                .devices
                .into_iter()
                .map(|d| BluetoothScanDevicePayload {
                    address: d.address,
                    name: d.name,
                    rssi: d.rssi,
                    bond: d.bond,
                    le: d.le,
                })
                .collect(),
            bonds: s
                .bonds
                .into_iter()
                .map(|b| BluetoothBondPayload {
                    address: b.address,
                    state: b.state,
                })
                .collect(),
        }
    }
}

/// Start a Bluetooth scan. Fails when the platform refuses (no adapter, or
/// `BLUETOOTH_SCAN` not granted) — the screen then says the search could not start
/// rather than showing an empty list.
#[tauri::command]
pub async fn bluetooth_start_scan(bridge: State<'_, RadioBridge>) -> Result<bool, String> {
    bridge
        .manager
        .bluetooth_start_discovery()
        .await
        .map_err(|e| e.to_string())
}

/// Cancel a running scan. Called when the screen leaves the Bluetooth page (and by the
/// explicit stop button) — a scan left running costs battery and the platform would end
/// it silently ~12 s later anyway.
#[tauri::command]
pub async fn bluetooth_stop_scan(bridge: State<'_, RadioBridge>) -> Result<bool, String> {
    bridge
        .manager
        .bluetooth_stop_discovery()
        .await
        .map_err(|e| e.to_string())
}

/// Read the scan state (what was found + whether it is still running).
#[tauri::command]
pub async fn bluetooth_scan_state(
    bridge: State<'_, RadioBridge>,
) -> Result<BluetoothScanPayload, String> {
    bridge
        .manager
        .bluetooth_scan_state()
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}

/// Ask the platform to pair with `address`.
///
/// Resolves `true` when the request was **accepted** — the system then runs its own
/// pairing flow and the user confirms on the peer. It never means "paired": the paired
/// list comes from `bluetooth_paired_devices`. A refusal is an error.
#[tauri::command]
pub async fn bluetooth_pair(
    bridge: State<'_, RadioBridge>,
    address: String,
) -> Result<bool, String> {
    bridge
        .manager
        .bluetooth_pair(&address)
        .await
        .map_err(|e| e.to_string())
}

/// The platform's answer to "may an **app** switch this radio?" (REQ-A202).
///
/// This is what makes an inert switch honest. On the S5 (Android 14) `radio_set("wifi",
/// …)` and `radio_set("bluetooth", …)` were refused by the platform — unconditionally,
/// because Android removed those app-facing switches — and the screen had nothing to
/// say about it: `invoke` turns a command failure into `null`, so a tile tap just did
/// nothing. The screen now **asks this first** and, when the platform owns the switch,
/// offers [`radio_open_settings`] instead of a doomed write.
#[derive(Clone, Debug, Serialize)]
pub struct RadioControlPayload {
    /// The radio key (`"wifi"` / `"bluetooth"` / `"airplane"` / `"hotspot"`).
    pub radio: String,
    /// `true` when this app may switch it — a refusal from `radio_set` is then a real
    /// device refusal, not a platform limit (and rides back as structured data).
    pub app_controlled: bool,
    /// The system surface that owns the switch (`"wifi_panel"`, `"bluetooth_settings"`,
    /// `"airplane_settings"`, `"wireless_settings"`). A **machine token**: the screen
    /// localises its own explanation and its own button label.
    pub surface: Option<String>,
    /// Why an app may not switch it (`"switch_removed"` — the platform took the API away;
    /// `"privileged_only"` — it needs a permission a normal install never gets).
    pub reason: Option<String>,
}

impl RadioControlPayload {
    fn new(radio: RadioMode, control: RadioControl) -> Self {
        match control {
            RadioControl::AppControlled => Self {
                radio: radio.key().to_string(),
                app_controlled: true,
                surface: None,
                reason: None,
            },
            RadioControl::PlatformManaged { surface, reason } => Self {
                radio: radio.key().to_string(),
                app_controlled: false,
                surface: Some(surface.key().to_string()),
                reason: Some(reason.code().to_string()),
            },
        }
    }
}

/* ---- Structured set results (REQ-A203): a refusal is *data*, not a dead call. ---- */

/// Why a `radio_set` did not apply — machine tokens first, diagnostics second.
///
/// The screen switches its own localised sentence on [`Self::kind`]; the free-form
/// [`Self::detail`] (the domain error's `Display`) is ledger copy, never primary
/// wording — the same split as `radio_control`'s `surface`/`reason`.
#[derive(Clone, Debug, Serialize)]
pub struct RadioRefusalPayload {
    /// Stable kind token (`RadioError::kind`): `platform_managed` (no app may flip
    /// it), `airplane_active` (the cascade guard), `provider_refused` (the device
    /// refused *this* attempt), `unsupported` (nobody here could serve it).
    pub kind: String,
    /// The radio the refusal names — a cascade refusal names the **member** that was
    /// refused, not the radio that was asked. `None` when only the detail is known:
    /// a guess is not a fact.
    pub radio: Option<String>,
    /// For `platform_managed`: the system surface that owns the switch (same token
    /// space as `radio_control`), so the screen can offer the way out right here.
    pub surface: Option<String>,
    /// For `platform_managed`: why the switch is not the app's (`switch_removed`, …).
    pub reason: Option<String>,
    /// Free-form diagnostic detail for the ledger (and logcat while it scrolls).
    pub detail: String,
}

impl RadioRefusalPayload {
    fn from_error(err: &RadioError) -> Self {
        Self {
            kind: err.kind().to_string(),
            radio: err.radio().map(|r| r.key().to_string()),
            surface: match err {
                RadioError::PlatformManaged { surface, .. } => Some(surface.key().to_string()),
                _ => None,
            },
            reason: match err {
                RadioError::PlatformManaged { reason, .. } => Some(reason.code().to_string()),
                _ => None,
            },
            detail: err.to_string(),
        }
    }
}

/// The full answer to one `radio_set` (REQ-A203): what was asked, whether the write
/// landed, the authoritative state **after the attempt**, and — when it did not land
/// — a structured [`RadioRefusalPayload`].
#[derive(Clone, Debug, Serialize)]
pub struct RadioSetPayload {
    /// The radio the request named.
    pub radio: String,
    /// The on/off value that was asked for.
    pub requested: bool,
    /// `true` when the provider accepted the write and the store was mirrored.
    pub applied: bool,
    /// The radios as the **device reports them after the attempt** — never the
    /// request echoed back (a refused write must not look applied, and a rolled-back
    /// cascade must not be described by its failed request). `null` only when even
    /// the read failed: then no state is claimed at all.
    pub state: Option<RadioPayload>,
    /// Present exactly when `applied` is `false`.
    pub refusal: Option<RadioRefusalPayload>,
}

impl RadioSetPayload {
    fn applied(radio: RadioMode, requested: bool, snap: RadioSnapshot) -> Self {
        Self {
            radio: radio.key().to_string(),
            requested,
            applied: true,
            state: Some(snap.into()),
            refusal: None,
        }
    }

    fn refused(
        radio: RadioMode,
        requested: bool,
        err: RadioError,
        state: Option<RadioSnapshot>,
    ) -> Self {
        Self {
            radio: radio.key().to_string(),
            requested,
            applied: false,
            state: state.map(Into::into),
            refusal: Some(RadioRefusalPayload::from_error(&err)),
        }
    }
}

/// Ask whether an **app** may switch `key` on this device, and which system surface owns
/// it when it may not (REQ-A202).
///
/// A read, deliberately: the screen needs the answer *before* the user taps, so a tile
/// can say "Android 13 起普通应用不能开关蓝牙" and offer the settings screen instead of
/// swallowing a refusal it cannot explain.
#[tauri::command]
pub async fn radio_control(
    bridge: State<'_, RadioBridge>,
    key: String,
) -> Result<RadioControlPayload, String> {
    let radio = RadioMode::from_key(&key).ok_or_else(|| format!("unknown radio key: {key:?}"))?;
    let control = bridge.manager.control(radio).await;
    Ok(RadioControlPayload::new(radio, control))
}

/// Open the system surface that owns a platform-managed switch (REQ-A202).
///
/// Resolves `true` when an Activity was started. A switch this app *can* flip has no
/// system surface ("use `radio_set`"), and a platform that refuses the surface is an
/// error — the screen never claims it handed the user somewhere.
#[tauri::command]
pub async fn radio_open_settings(
    bridge: State<'_, RadioBridge>,
    key: String,
) -> Result<bool, String> {
    let radio = RadioMode::from_key(&key).ok_or_else(|| format!("unknown radio key: {key:?}"))?;
    match bridge.manager.control(radio).await {
        RadioControl::AppControlled => Err(format!(
            "`{key}` is switched by this app on this device — there is no system surface to open"
        )),
        RadioControl::PlatformManaged { surface, .. } => bridge
            .manager
            .open_system_surface(surface)
            .await
            .map(|()| true)
            .map_err(|e| e.to_string()),
    }
}

/// Toggle one radio (`wifi` / `bluetooth` / `airplane` / `hotspot`), enforcing the
/// Airplane cascade/guard in the domain core.
///
/// The answer is **structured** (REQ-A203): `applied: true` rides with the
/// authoritative snapshot and the store is mirrored. A refusal — the platform owning
/// the switch, the airplane guard, or the device saying no to *this* attempt — is
/// `applied: false` plus machine-token reasons and a freshly **read** state, so the
/// screen can say what happened. Before this the command failed and `invoke` turned
/// that into `null`: on the S5 a tile tap looked like nothing at all, and the only
/// trace lived in the diagnostic ledger. Only a malformed request is a command
/// failure; nothing is persisted unless the write landed.
#[tauri::command]
pub async fn radio_set(
    app: AppHandle,
    bridge: State<'_, RadioBridge>,
    store: State<'_, SharedStore>,
    key: String,
    enabled: bool,
) -> Result<RadioSetPayload, String> {
    let radio = RadioMode::from_key(&key).ok_or_else(|| format!("unknown radio key: {key:?}"))?;
    match bridge.manager.set(radio, enabled).await {
        Ok(snap) => {
            persist_radios(&app, &store, snap);
            Ok(RadioSetPayload::applied(radio, enabled, snap))
        }
        // The refusal is the *answer*, not a broken call. Its state is read, never
        // assumed: a rollback (or a policy refusal) must be described by what the
        // provider reports now, not by the request that failed.
        Err(e) => {
            let state = bridge.manager.snapshot().await.ok();
            tracing::warn!(
                target: "amos::radio",
                radio = radio.key(),
                requested = enabled,
                kind = e.kind(),
                error = %e,
                "radio_set refused"
            );
            Ok(RadioSetPayload::refused(radio, enabled, e, state))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_parses_known_radio_bits_only() {
        let seed = seed_from_settings(Some(
            r#"{"wifi":true,"airplane":true,"hotspot":true,"darkmode":1}"#,
        ));
        assert!(seed.wifi);
        assert!(!seed.bluetooth);
        assert!(seed.airplane);
        assert!(seed.hotspot);
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
            hotspot: true,
        });
        assert!(p.wifi);
        assert!(!p.bluetooth);
        assert!(p.airplane);
        assert!(p.hotspot);
    }

    #[test]
    fn a_platform_managed_radio_crosses_the_bridge_with_its_surface_and_reason() {
        // The UI cannot act on this by itself: it needs (a) the boolean to know not to
        // attempt a write, and (b) the two machine tokens to pick its own wording and its
        // own system-settings action. Dropping either would leave the screen reporting a
        // refusal it cannot explain (REQ-A202).
        use amos_radio::{PlatformReason, SystemSurface};
        let managed = RadioControlPayload::new(
            RadioMode::Bluetooth,
            RadioControl::PlatformManaged {
                surface: SystemSurface::BluetoothSettings,
                reason: PlatformReason::SwitchRemoved,
            },
        );
        assert_eq!(managed.radio, "bluetooth");
        assert!(!managed.app_controlled);
        assert_eq!(managed.surface.as_deref(), Some("bluetooth_settings"));
        assert_eq!(managed.reason.as_deref(), Some("switch_removed"));

        let own = RadioControlPayload::new(RadioMode::Hotspot, RadioControl::AppControlled);
        assert_eq!(own.radio, "hotspot");
        assert!(own.app_controlled);
        assert!(own.surface.is_none() && own.reason.is_none());
    }

    #[test]
    fn an_applied_set_reports_the_write_and_the_snapshot() {
        // `applied: true` is a claim about a write that landed, so it must ride with
        // the snapshot that proves it (REQ-A203) — and carry no refusal.
        let p = RadioSetPayload::applied(
            RadioMode::Hotspot,
            true,
            RadioSnapshot {
                wifi: true,
                bluetooth: false,
                airplane: false,
                hotspot: true,
            },
        );
        assert_eq!(p.radio, "hotspot");
        assert!(p.requested);
        assert!(p.applied);
        assert_eq!(p.state.map(|s| s.hotspot), Some(true));
        assert!(p.refusal.is_none());
    }

    #[test]
    fn a_platform_managed_refusal_carries_the_way_out() {
        // `radio_control` can come back empty (a failed mount read), and the tile then
        // attempts the write the manager refuses. The structured answer must carry the
        // surface + reason here too, so the screen can offer the system surface instead
        // of a dead end — and the state must be the *read*, not the request echoed.
        use amos_radio::{PlatformReason, SystemSurface};
        let err = RadioError::PlatformManaged {
            radio: RadioMode::Wifi,
            surface: SystemSurface::WifiPanel,
            reason: PlatformReason::SwitchRemoved,
        };
        let read = RadioSnapshot {
            wifi: true,
            bluetooth: true,
            airplane: false,
            hotspot: false,
        };
        let p = RadioSetPayload::refused(RadioMode::Wifi, false, err, Some(read));
        assert!(!p.applied);
        assert!(!p.requested);
        let refusal = p.refusal.expect("a refusal rides with a refused set");
        assert_eq!(refusal.kind, "platform_managed");
        assert_eq!(refusal.radio.as_deref(), Some("wifi"));
        assert_eq!(refusal.surface.as_deref(), Some("wifi_panel"));
        assert_eq!(refusal.reason.as_deref(), Some("switch_removed"));
        assert!(refusal.detail.contains("wifi_panel"), "{:?}", refusal.detail);
        let state = p.state.expect("the read answer must survive the bridge");
        assert!(state.wifi && state.bluetooth);
    }

    #[test]
    fn a_provider_refusal_invents_no_platform_story() {
        // Wi-Fi refusing at *runtime* (device policy, rf-kill) has no system surface
        // to offer: dressing it up as platform-managed would send the user to a
        // settings screen that cannot help. The kind says what happened, the ledger
        // gets the detail, and no surface is claimed (REQ-A203).
        let p = RadioSetPayload::refused(
            RadioMode::Wifi,
            false,
            RadioError::Provider(
                "the platform refused to switch Wi-Fi off (setWifiEnabled returned false)".into(),
            ),
            Some(RadioSnapshot::default()),
        );
        let refusal = p.refusal.expect("a refusal rides with a refused set");
        assert_eq!(refusal.kind, "provider_refused");
        assert_eq!(refusal.radio, None, "no structured radio may be invented");
        assert_eq!(refusal.surface, None);
        assert_eq!(refusal.reason, None);
        assert!(
            refusal.detail.contains("setWifiEnabled"),
            "{:?}",
            refusal.detail
        );
    }

    #[test]
    fn a_refusal_with_no_readable_state_claims_no_state() {
        // When even the follow-up read fails, `state` stays `null`: a fabricated
        // snapshot would be exactly the lie this bridge exists to refuse.
        let p = RadioSetPayload::refused(
            RadioMode::Bluetooth,
            true,
            RadioError::Provider("adapter unavailable".into()),
            None,
        );
        assert!(!p.applied);
        assert!(p.state.is_none());
    }

    #[test]
    fn bluetooth_peer_payload_carries_both_fields_across_the_bridge() {
        // The screen identifies a paired device by address and labels it by name, so
        // neither field may be dropped in the Tauri payload (REQ-A199).
        let p = BluetoothPeerPayload::from(amos_radio::BtPeer::new(" AA:BB:CC ", " Buds "));
        assert_eq!(p.address, "AA:BB:CC");
        assert_eq!(p.name, "Buds");
    }

    #[test]
    fn bluetooth_scan_payload_keeps_the_flags_that_decide_what_the_screen_may_claim() {
        // `capped` and `scan_allowed` are the difference between "partial list",
        // "cannot look" and "nothing there", and `classic`/`le` say which transports
        // were actually searched — dropping any of them in the payload would make the
        // screen claim something the device did not say (REQ-A200/A201).
        let scan = amos_radio::BtScan {
            discovering: true,
            classic: true,
            le: true,
            capped: true,
            scan_allowed: false,
            devices: vec![amos_radio::BtScanDevice {
                address: "AA:BB".into(),
                name: String::new(),
                rssi: Some(-70),
                bond: amos_radio::BOND_BONDING,
                le: true,
            }],
            bonds: vec![amos_radio::BtBond {
                address: "AA:BB".into(),
                state: 10,
            }],
        };
        let p: BluetoothScanPayload = scan.into();
        assert!(p.discovering && p.capped && !p.scan_allowed);
        assert!(p.classic && p.le);
        assert_eq!(p.devices.len(), 1);
        assert_eq!(p.devices[0].address, "AA:BB");
        assert_eq!(p.devices[0].rssi, Some(-70));
        assert_eq!(
            p.devices[0].bond,
            amos_radio::BOND_BONDING,
            "the bonding state must survive the bridge — it is what the row's \
             pairing progress is rendered from"
        );
        assert!(p.devices[0].le);
        // The session bond record rides along too: the screen needs it for an address
        // whose row is not in the list any more.
        assert_eq!(p.bonds.len(), 1);
        assert_eq!(p.bonds[0].address, "AA:BB");
        assert_eq!(p.bonds[0].state, 10);
    }
}
