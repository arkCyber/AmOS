//! Provider seams and a deterministic mock.
//!
//! The [`RadioProvider`] is the single point where the radio policy
//! ([`crate::RadioManager`]) talks to a real radio stack. By design it is a
//! *dumb* register over the actual radios: it only reads/writes each bit. All
//! policy (Airplane cascade, the "no non-airplane radio while Airplane is on"
//! guard) lives in [`crate::RadioManager`], never here — the same split the
//! telephony core uses (policy in the domain core, not the provider).
//!
//! For P0/P1 we ship a deterministic in-memory [`MockRadioProvider`]; the real
//! Android backend (Android `ConnectivityManager` for Wi-Fi + `BluetoothManager`
//! for Bluetooth via JNI/binder) replaces it under the `android` feature.

use async_trait::async_trait;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

use crate::error::Result;
use crate::state::{RadioMode, RadioSnapshot};

/// The external seam to a real (or mocked) radio stack.
///
/// **Contract for every `set_*`** (REQ-A184): the return value *is* the outcome —
/// `Ok(())` means the platform accepted and applied the switch, and a refusal (a
/// platform `false`, a missing permission, an absent service) is an
/// [`crate::error::RadioError`]. A provider must never answer `Ok` because it could
/// not tell: the Airplane cascade rolls back on an error, so swallowing one leaves
/// the device half-switched with nothing reported.
#[async_trait]
pub trait RadioProvider: Send + Sync {
    /// Read the current on/off state of every radio.
    async fn snapshot(&self) -> Result<RadioSnapshot>;

    /// Switch Wi-Fi on/off. See the trait contract: a platform refusal is an error.
    async fn set_wifi(&self, on: bool) -> Result<()>;

    /// Switch Bluetooth on/off. See the trait contract: a platform refusal is an error.
    async fn set_bluetooth(&self, on: bool) -> Result<()>;

    /// Switch Airplane mode on/off.
    ///
    /// A provider that cannot reach the authoritative platform switch must still
    /// keep the guarantee the caller relies on: the *real* radios are switched off
    /// and gated by [`crate::RadioManager`]'s cascade, and this bit is what
    /// `snapshot` reports — so the toggle never claims a radio state the platform
    /// holds differently (REQ-A184).
    async fn set_airplane(&self, on: bool) -> Result<()>;

    /// Switch the Wi-Fi **access point** (personal hotspot) on/off. Note this is
    /// the AP, not the [`RadioProvider::set_wifi`] station radio: on a device it
    /// maps to `ConnectivityManager#startTethering`/`stopTethering`.
    async fn set_hotspot(&self, on: bool) -> Result<()>;

    /// Read the Bluetooth adapter's own name (REQ-A199).
    ///
    /// Default: **unsupported**. A provider with no adapter must say so
    /// ([`crate::RadioError::Unsupported`]) instead of inventing a name: the
    /// settings screen paints a store-remembered name as a *preference* and only a
    /// device answer may be presented as what the adapter really calls itself.
    async fn bluetooth_local_name(&self) -> Result<String> {
        Err(crate::error::RadioError::Unsupported(
            "reading the Bluetooth adapter name".to_string(),
        ))
    }

    /// Set the adapter's name and return **the name the platform reports
    /// afterwards** (authoritative: the platform may truncate, so echoing the
    /// request would be a claim we did not verify). A refusal is an error, like
    /// every other `set_*` here.
    async fn set_bluetooth_local_name(&self, _name: &str) -> Result<String> {
        Err(crate::error::RadioError::Unsupported(
            "renaming the Bluetooth adapter".to_string(),
        ))
    }

    /// The devices this adapter is **paired** with
    /// (`BluetoothAdapter#getBondedDevices`). Default: unsupported, for the same
    /// reason as [`RadioProvider::bluetooth_local_name`] — a fabricated peer list
    /// would be exactly the kind of lie the radio work exists to remove.
    async fn bluetooth_paired_devices(&self) -> Result<Vec<crate::bluetooth::BtPeer>> {
        Err(crate::error::RadioError::Unsupported(
            "listing paired Bluetooth devices".to_string(),
        ))
    }

    /// Start a Bluetooth **scan** (REQ-A200) and report whether the platform
    /// **accepted** it (`Ok(true)`), like every other platform verdict in this trait.
    ///
    /// Default: unsupported. A provider that cannot scan must not answer "accepted but
    /// empty" — the screen would show "no devices nearby", which is a different claim.
    async fn bluetooth_start_discovery(&self) -> Result<bool> {
        Err(crate::error::RadioError::Unsupported(
            "starting a Bluetooth scan".to_string(),
        ))
    }

    /// Cancel a running scan. Both an accepted cancel and "there was nothing running"
    /// are `Ok(true)` on the device side; a refusal is an error.
    async fn bluetooth_stop_discovery(&self) -> Result<bool> {
        Err(crate::error::RadioError::Unsupported(
            "cancelling a Bluetooth scan".to_string(),
        ))
    }

    /// The current scan state: running / capped / allowed / what was found.
    async fn bluetooth_scan_state(&self) -> Result<crate::bluetooth::BtScan> {
        Err(crate::error::RadioError::Unsupported(
            "reading the Bluetooth scan state".to_string(),
        ))
    }

    /// Ask the platform to **pair** with `address`; `Ok(true)` = the request was
    /// accepted and the system's pairing flow has started (the user confirms on the
    /// peer device). It never means "paired" — that comes from
    /// [`RadioProvider::bluetooth_paired_devices`].
    async fn bluetooth_pair(&self, _address: &str) -> Result<bool> {
        Err(crate::error::RadioError::Unsupported(
            "pairing a Bluetooth device".to_string(),
        ))
    }

    /// Whether an **app** may flip `radio` on this platform at all (REQ-A202).
    ///
    /// Default: [`RadioControl::AppControlled`] — the in-memory Mock and any backend
    /// where the store *is* the radio hold that. A real platform answers differently
    /// for the switches it took away from apps (Android removed the app-facing Wi-Fi
    /// switch in API 29 and the Bluetooth one in API 33, and the authoritative airplane
    /// bit never was writable without `WRITE_SECURE_SETTINGS`).
    ///
    /// Why this is a *read* and not an error from `set_*`: the caller must know **before**
    /// anything is touched. The Airplane cascade switches several radios off in sequence,
    /// so discovering "the platform forbids this one" halfway through is exactly the
    /// half-applied state the manager exists to prevent — and the screen needs to say
    /// what to do instead (open the system surface), not just that a write failed.
    async fn control(&self, _radio: RadioMode) -> RadioControl {
        RadioControl::AppControlled
    }

    /// Open the **system surface** that owns `surface` (the Wi-Fi panel, the Bluetooth
    /// settings screen, …), so a platform-managed switch still has a path a user can
    /// take.
    ///
    /// Default: unsupported. A provider with no UI to hand the user to (the offline
    /// Mock, a desktop build) says so instead of pretending it opened something.
    async fn open_system_surface(&self, _surface: SystemSurface) -> Result<()> {
        Err(crate::error::RadioError::Unsupported(
            "opening a system radio surface".to_string(),
        ))
    }
}

/// A system surface that owns a radio switch an app may not flip (REQ-A202).
///
/// The tokens are **stable machine keys**, not copy: the UI localises its own
/// explanation per radio, and Rust never ships a user-facing sentence. They are also
/// what crosses the bridge (`radio_control`), so a test can pin them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemSurface {
    /// The system Wi-Fi panel (`Settings.Panel.ACTION_INTERNET_CONNECTIVITY`, API 29+)
    /// or, on older builds, the Wi-Fi settings screen.
    WifiPanel,
    /// The system Bluetooth settings screen (`Settings.ACTION_BLUETOOTH_SETTINGS`) —
    /// the only place a user can still switch Bluetooth on modern Android.
    BluetoothSettings,
    /// The system airplane-mode settings screen (`Settings.ACTION_AIRPLANE_MODE_SETTINGS`).
    AirplaneSettings,
    /// The system wireless settings screen (`Settings.ACTION_WIRELESS_SETTINGS`) — home
    /// of tethering/AP controls on builds without a dedicated panel.
    WirelessSettings,
}

impl SystemSurface {
    /// Stable wire key (crosses the bridge; pinned by tests).
    pub fn key(self) -> &'static str {
        match self {
            SystemSurface::WifiPanel => "wifi_panel",
            SystemSurface::BluetoothSettings => "bluetooth_settings",
            SystemSurface::AirplaneSettings => "airplane_settings",
            SystemSurface::WirelessSettings => "wireless_settings",
        }
    }

    /// Parse a wire key; `None` for anything unknown (a surface the glue cannot open).
    pub fn from_key(s: &str) -> Option<SystemSurface> {
        match s {
            "wifi_panel" => Some(SystemSurface::WifiPanel),
            "bluetooth_settings" => Some(SystemSurface::BluetoothSettings),
            "airplane_settings" => Some(SystemSurface::AirplaneSettings),
            "wireless_settings" => Some(SystemSurface::WirelessSettings),
            _ => None,
        }
    }
}

impl std::fmt::Display for SystemSurface {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.key())
    }
}

/// **Why** an app may not flip a switch (REQ-A202). A stable code, not copy: the UI
/// owns the wording per radio and per platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformReason {
    /// The platform removed the app-facing switch: `WifiManager#setWifiEnabled` is a
    /// no-op for normal apps from API 29, `BluetoothAdapter#enable/disable` from API 33
    /// (verified on the S5 / Android 14 — both return `false` unconditionally).
    SwitchRemoved,
    /// The switch needs a privileged/signature permission a normal install never gets
    /// (`WRITE_SECURE_SETTINGS` for the airplane bit, `TETHER_PRIVILEGED` for the AP).
    PrivilegedOnly,
}

impl PlatformReason {
    /// Stable wire code (crosses the bridge; pinned by tests).
    pub fn code(self) -> &'static str {
        match self {
            PlatformReason::SwitchRemoved => "switch_removed",
            PlatformReason::PrivilegedOnly => "privileged_only",
        }
    }

    /// Parse a wire code; `None` for anything unknown (see [`SystemSurface::from_key`]).
    pub fn from_code(s: &str) -> Option<PlatformReason> {
        match s {
            "switch_removed" => Some(PlatformReason::SwitchRemoved),
            "privileged_only" => Some(PlatformReason::PrivilegedOnly),
            _ => None,
        }
    }
}

impl std::fmt::Display for PlatformReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

/// Whether the active provider may flip a radio (REQ-A202).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RadioControl {
    /// The provider can switch it: a refusal from a `set_*` is a real failure.
    AppControlled,
    /// The platform owns the switch. `set` must be refused **before** it is attempted,
    /// and the screen should offer [`SystemSurface`] instead.
    PlatformManaged {
        surface: SystemSurface,
        reason: PlatformReason,
    },
}

impl RadioControl {
    /// `true` when the switch belongs to the platform, not to this app.
    pub fn is_managed(self) -> bool {
        matches!(self, RadioControl::PlatformManaged { .. })
    }
}

/// A provider that delegates to a **fallback** until a real backend is installed.
///
/// Why this exists (REQ-A185): the System UI builds its radio bridge during Tauri's
/// `setup`, which runs *before* any Android Activity callback — while the app's
/// `JavaVM` + `Context` only arrive later, through the Kotlin glue's JNI upcall.
/// Swapping the *provider* (rather than the manager) keeps one policy instance and
/// one code path: before the upcall every call goes to the Mock, after it every call
/// goes to the device, and the Airplane cascade behaves identically in both cases.
///
/// Installing is **once**: a second install is an error, not a silent overwrite
/// (two live providers would mean two truths about the same radio).
pub struct SwitchableProvider {
    fallback: Arc<dyn RadioProvider>,
    real: OnceLock<Arc<dyn RadioProvider>>,
}

impl SwitchableProvider {
    /// Wrap `fallback` (the Mock, seeded from the durable settings store).
    pub fn new(fallback: Arc<dyn RadioProvider>) -> Self {
        Self {
            fallback,
            real: OnceLock::new(),
        }
    }

    /// Install the real backend. `Err` when one is already installed.
    pub fn install(&self, provider: Arc<dyn RadioProvider>) -> std::result::Result<(), String> {
        self.real
            .set(provider)
            .map_err(|_| "a real radio provider is already installed".to_string())
    }

    /// `true` once the real backend is in place (diagnostics and tests read this).
    pub fn is_switched(&self) -> bool {
        self.real.get().is_some()
    }

    /// The provider every call goes to right now.
    fn active(&self) -> &Arc<dyn RadioProvider> {
        self.real.get().unwrap_or(&self.fallback)
    }
}

#[async_trait]
impl RadioProvider for SwitchableProvider {
    async fn snapshot(&self) -> Result<RadioSnapshot> {
        self.active().snapshot().await
    }

    async fn set_wifi(&self, on: bool) -> Result<()> {
        self.active().set_wifi(on).await
    }

    async fn set_bluetooth(&self, on: bool) -> Result<()> {
        self.active().set_bluetooth(on).await
    }

    async fn set_airplane(&self, on: bool) -> Result<()> {
        self.active().set_airplane(on).await
    }

    async fn set_hotspot(&self, on: bool) -> Result<()> {
        self.active().set_hotspot(on).await
    }

    /// Delegated like every other call, so the moment the glue installs the device
    /// backend the *same* provider object starts answering these with the adapter's
    /// truth instead of `Unsupported` (REQ-A199).
    async fn bluetooth_local_name(&self) -> Result<String> {
        self.active().bluetooth_local_name().await
    }

    async fn set_bluetooth_local_name(&self, name: &str) -> Result<String> {
        self.active().set_bluetooth_local_name(name).await
    }

    async fn bluetooth_paired_devices(&self) -> Result<Vec<crate::bluetooth::BtPeer>> {
        self.active().bluetooth_paired_devices().await
    }

    async fn bluetooth_start_discovery(&self) -> Result<bool> {
        self.active().bluetooth_start_discovery().await
    }

    async fn bluetooth_stop_discovery(&self) -> Result<bool> {
        self.active().bluetooth_stop_discovery().await
    }

    async fn bluetooth_scan_state(&self) -> Result<crate::bluetooth::BtScan> {
        self.active().bluetooth_scan_state().await
    }

    async fn bluetooth_pair(&self, address: &str) -> Result<bool> {
        self.active().bluetooth_pair(address).await
    }

    /// Delegated like every other call, and **not** defaulted: the whole point of
    /// asking is to hear the *device* say which switches it took away. A fallback
    /// (Mock) answer here would let the tiles keep offering a switch the platform
    /// forbids (REQ-A202).
    async fn control(&self, radio: RadioMode) -> RadioControl {
        self.active().control(radio).await
    }

    async fn open_system_surface(&self, surface: SystemSurface) -> Result<()> {
        self.active().open_system_surface(surface).await
    }
}

///
/// Thread-safe (a `tokio` mutex guards the bits) and seedable from a durable
/// settings snapshot so quick-settings state survives restarts. It does **not**
/// enforce any policy by itself — the manager does that.
pub struct MockRadioProvider {
    inner: Arc<Mutex<RadioSnapshot>>,
}

impl MockRadioProvider {
    /// Create a mock starting from `initial` state.
    pub fn new(initial: RadioSnapshot) -> Self {
        Self {
            inner: Arc::new(Mutex::new(initial)),
        }
    }
}

impl Default for MockRadioProvider {
    fn default() -> Self {
        Self::new(RadioSnapshot::default())
    }
}

#[async_trait]
impl RadioProvider for MockRadioProvider {
    async fn snapshot(&self) -> Result<RadioSnapshot> {
        Ok(*self.inner.lock().await)
    }

    async fn set_wifi(&self, on: bool) -> Result<()> {
        let mut g = self.inner.lock().await;
        g.wifi = on;
        Ok(())
    }

    async fn set_bluetooth(&self, on: bool) -> Result<()> {
        let mut g = self.inner.lock().await;
        g.bluetooth = on;
        Ok(())
    }

    async fn set_airplane(&self, on: bool) -> Result<()> {
        let mut g = self.inner.lock().await;
        g.airplane = on;
        Ok(())
    }

    async fn set_hotspot(&self, on: bool) -> Result<()> {
        let mut g = self.inner.lock().await;
        g.hotspot = on;
        Ok(())
    }
}

#[cfg(test)]
mod switchable_tests {
    use super::*;
    use crate::error::RadioError;
    use crate::state::{RadioMode, RadioSnapshot};

    /// A provider that answers every write with a refusal — the shape a real
    /// platform gives when it does not accept the switch (A184).
    struct RefusingProvider;

    #[async_trait]
    impl RadioProvider for RefusingProvider {
        async fn snapshot(&self) -> Result<RadioSnapshot> {
            Ok(RadioSnapshot {
                wifi: true,
                ..RadioSnapshot::default()
            })
        }
        async fn set_wifi(&self, _on: bool) -> Result<()> {
            Err(RadioError::Provider("refused".to_string()))
        }
        async fn set_bluetooth(&self, _on: bool) -> Result<()> {
            Err(RadioError::Provider("refused".to_string()))
        }
        async fn set_airplane(&self, _on: bool) -> Result<()> {
            Err(RadioError::Provider("refused".to_string()))
        }
        async fn set_hotspot(&self, _on: bool) -> Result<()> {
            Err(RadioError::Provider("refused".to_string()))
        }
    }

    #[tokio::test]
    async fn calls_go_to_the_fallback_until_a_real_backend_is_installed() {
        let mock: Arc<dyn RadioProvider> = Arc::new(MockRadioProvider::new(RadioSnapshot {
            wifi: false,
            ..RadioSnapshot::default()
        }));
        let sw = SwitchableProvider::new(mock);
        assert!(!sw.is_switched(), "starts unswitched");
        assert!(!sw.snapshot().await.unwrap().wifi, "the Mock answers first");
        assert!(sw.set_wifi(true).await.is_ok(), "the Mock never refuses");

        sw.install(Arc::new(RefusingProvider)).unwrap();
        assert!(sw.is_switched());
        let snap = sw.snapshot().await.unwrap();
        assert!(snap.wifi, "now the device backend answers (its own truth)");
        assert!(
            matches!(sw.set_wifi(false).await, Err(RadioError::Provider(_))),
            "and its refusal is what the caller sees — never the Mock's success"
        );
    }

    #[tokio::test]
    async fn installing_twice_is_an_error_not_a_silent_replacement() {
        let sw = SwitchableProvider::new(Arc::new(MockRadioProvider::default()));
        sw.install(Arc::new(RefusingProvider)).unwrap();
        let second = sw.install(Arc::new(MockRadioProvider::default()));
        assert!(second.is_err(), "two live providers would be two truths");
        assert!(
            sw.set_wifi(true).await.is_err(),
            "the first install still wins"
        );
    }

    /// A backend that answers the Bluetooth *details* — the shape the Android
    /// provider has once the glue attaches it (REQ-A199).
    struct DetailedBtProvider;

    #[async_trait]
    impl RadioProvider for DetailedBtProvider {
        async fn snapshot(&self) -> Result<RadioSnapshot> {
            Ok(RadioSnapshot::default())
        }
        async fn set_wifi(&self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn set_bluetooth(&self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn set_airplane(&self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn set_hotspot(&self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn bluetooth_local_name(&self) -> Result<String> {
            Ok("S5".to_string())
        }
        async fn set_bluetooth_local_name(&self, name: &str) -> Result<String> {
            // The authoritative answer, not the request: a platform may truncate.
            Ok(name.chars().take(2).collect())
        }
        async fn bluetooth_paired_devices(&self) -> Result<Vec<crate::bluetooth::BtPeer>> {
            Ok(vec![crate::bluetooth::BtPeer::new(
                "AA:BB:CC:DD:EE:FF",
                "Buds",
            )])
        }
    }

    #[tokio::test]
    async fn the_mock_says_unsupported_instead_of_inventing_bluetooth_details() {
        // The offline provider has no adapter: it must say so (Unsupported — the UI
        // then keeps showing its own remembered preference), not fabricate a name or
        // a peer list (REQ-A199).
        let mock = MockRadioProvider::default();
        assert!(matches!(
            mock.bluetooth_local_name().await,
            Err(RadioError::Unsupported(_))
        ));
        assert!(matches!(
            mock.set_bluetooth_local_name("AmOS").await,
            Err(RadioError::Unsupported(_))
        ));
        assert!(matches!(
            mock.bluetooth_paired_devices().await,
            Err(RadioError::Unsupported(_))
        ));
    }

    #[tokio::test]
    async fn bluetooth_details_follow_the_switch_to_the_real_backend() {
        let sw = SwitchableProvider::new(Arc::new(MockRadioProvider::default()));
        assert!(
            sw.bluetooth_local_name().await.is_err(),
            "before the upcall the Mock answers — and it has no adapter"
        );

        sw.install(Arc::new(DetailedBtProvider)).unwrap();
        assert_eq!(sw.bluetooth_local_name().await.unwrap(), "S5");
        assert_eq!(
            sw.set_bluetooth_local_name("Pixel 9").await.unwrap(),
            "Pi",
            "the provider's authoritative answer is what the caller gets"
        );
        let peers = sw.bluetooth_paired_devices().await.unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].display_name(), "Buds");
    }

    #[tokio::test]
    async fn a_switched_provider_keeps_the_managers_policy_intact() {
        // The point of swapping the provider rather than the manager: the Airplane
        // guard/cascade is the same object before and after the switch.
        let sw = Arc::new(SwitchableProvider::new(Arc::new(MockRadioProvider::new(
            RadioSnapshot {
                wifi: true,
                bluetooth: true,
                ..RadioSnapshot::default()
            },
        ))));
        let manager = crate::manager::RadioManager::new(sw.clone());
        let snap = manager.set(RadioMode::Airplane, true).await.unwrap();
        assert!(snap.airplane && !snap.wifi && !snap.bluetooth);
        assert!(
            matches!(
                manager.set(RadioMode::Wifi, true).await,
                Err(RadioError::AirplaneActive(RadioMode::Wifi))
            ),
            "the guard still refuses under Airplane mode"
        );
    }

    /// A provider whose platform-capability answer is programmable, so the switch can be
    /// shown to change *with the backend* (REQ-A202).
    struct ManagedAnswer {
        managed: bool,
    }

    #[async_trait]
    impl RadioProvider for ManagedAnswer {
        async fn snapshot(&self) -> Result<RadioSnapshot> {
            Ok(RadioSnapshot::default())
        }
        async fn set_wifi(&self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn set_bluetooth(&self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn set_airplane(&self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn set_hotspot(&self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn control(&self, _radio: RadioMode) -> RadioControl {
            if self.managed {
                RadioControl::PlatformManaged {
                    surface: SystemSurface::BluetoothSettings,
                    reason: PlatformReason::SwitchRemoved,
                }
            } else {
                RadioControl::AppControlled
            }
        }
    }

    #[tokio::test]
    async fn the_capability_answer_follows_the_switch_to_the_real_backend() {
        // The answer must not be defaulted from the fallback: before the upcall the
        // Mock says "app-controlled" (it owns its store), after it the *device* must be
        // the one telling the screen which switches it took away.
        let sw = SwitchableProvider::new(Arc::new(MockRadioProvider::default()));
        assert_eq!(
            sw.control(RadioMode::Bluetooth).await,
            RadioControl::AppControlled
        );
        assert!(sw
            .open_system_surface(SystemSurface::WifiPanel)
            .await
            .is_err());

        sw.install(Arc::new(ManagedAnswer { managed: true }))
            .unwrap();
        let answer = sw.control(RadioMode::Bluetooth).await;
        assert!(
            answer.is_managed(),
            "the device's answer replaces the Mock's"
        );
        assert_eq!(
            answer,
            RadioControl::PlatformManaged {
                surface: SystemSurface::BluetoothSettings,
                reason: PlatformReason::SwitchRemoved,
            }
        );
    }

    #[test]
    fn surface_and_reason_tokens_are_stable_and_round_trip() {
        // These cross the bridge and are localised by the UI: a silent rename would make
        // the screen explain the wrong thing (or nothing) on a real device.
        for surface in [
            SystemSurface::WifiPanel,
            SystemSurface::BluetoothSettings,
            SystemSurface::AirplaneSettings,
            SystemSurface::WirelessSettings,
        ] {
            assert_eq!(SystemSurface::from_key(surface.key()), Some(surface));
            assert_eq!(surface.to_string(), surface.key());
        }
        assert_eq!(SystemSurface::from_key("settings_app"), None);
        assert_eq!(PlatformReason::SwitchRemoved.code(), "switch_removed");
        assert_eq!(PlatformReason::PrivilegedOnly.code(), "privileged_only");
        assert_eq!(PlatformReason::SwitchRemoved.to_string(), "switch_removed");
        // `is_managed` is the one predicate the UI and the manager both lean on.
        assert!(!RadioControl::AppControlled.is_managed());
        assert!(RadioControl::PlatformManaged {
            surface: SystemSurface::WifiPanel,
            reason: PlatformReason::SwitchRemoved,
        }
        .is_managed());
    }
}
