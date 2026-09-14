//! [`RadioManager`]: drives a [`RadioProvider`] and enforces the radio policy.
//!
//! The provider is deliberately a dumb register (see [`crate::provider`]); all the
//! rules the UI depends on live here so they are unit-testable and identical
//! across the Mock and a future real backend:
//!
//! * Enabling Airplane mode cascades Wi-Fi + Bluetooth + the Wi-Fi AP (personal
//!   hotspot) **off** — and is
//!   **atomic in intent**: if any cascade step fails after Airplane is switched on,
//!   the provider is rolled back to the prior snapshot and the error surfaces. The
//!   rollback itself can fail (the provider is the one that just failed); every such
//!   step is **logged**, so the returned error never hides a half-applied state.
//! * The non-airplane radios (Wi-Fi / Bluetooth / hotspot) cannot be switched on
//!   while Airplane mode is active — the set is refused with
//!   [`RadioError::AirplaneActive`].
//!
//! [`RadioManager::set`] returns the resulting authoritative [`RadioSnapshot`]
//! so callers (e.g. the System UI bridge) can mirror exactly what the radios now
//! report, rather than trusting their intent.

use std::sync::Arc;

use crate::bluetooth::BtPeer;
use crate::error::{RadioError, Result};
use crate::provider::{RadioControl, RadioProvider, SystemSurface};
use crate::state::{RadioMode, RadioSnapshot};

/// A policy-owning handle over one [`RadioProvider`].
pub struct RadioManager {
    provider: Arc<dyn RadioProvider>,
}

impl RadioManager {
    /// Wrap a provider (Mock today; a real Android backend later).
    pub fn new(provider: Arc<dyn RadioProvider>) -> Self {
        Self { provider }
    }

    /// Read the current on/off state of every radio.
    pub async fn snapshot(&self) -> Result<RadioSnapshot> {
        self.provider.snapshot().await
    }

    /// Whether an **app** may switch `radio` on this device (REQ-A202).
    ///
    /// A pass-through to the provider on purpose: only the provider knows the platform
    /// (API level, held permissions), and the Mock's `AppControlled` is a *claim about
    /// the store*, not a claim about a radio.
    pub async fn control(&self, radio: RadioMode) -> RadioControl {
        self.provider.control(radio).await
    }

    /// Open the system surface that owns a platform-managed switch (REQ-A202).
    pub async fn open_system_surface(&self, surface: SystemSurface) -> Result<()> {
        self.provider.open_system_surface(surface).await
    }

    /// Refuse a switch the platform owns, **before** any provider write.
    ///
    /// Kept in the policy layer (like the Airplane cascade and the Bluetooth name
    /// rules) so every entry point — a single toggle, the cascade, the offline Mock —
    /// gets the same answer from one place.
    async fn refuse_if_platform_managed(&self, radio: RadioMode) -> Result<()> {
        match self.provider.control(radio).await {
            RadioControl::AppControlled => Ok(()),
            RadioControl::PlatformManaged { surface, reason } => Err(RadioError::PlatformManaged {
                radio,
                surface,
                reason,
            }),
        }
    }

    /// Apply a toggle to one radio, enforcing the Airplane-mode policy, and
    /// return the resulting authoritative snapshot.
    pub async fn set(&self, radio: RadioMode, on: bool) -> Result<RadioSnapshot> {
        // The platform comes first (REQ-A202): if an app may not switch this radio,
        // the request is refused **before** anything is touched. Attempting it anyway
        // and reporting the platform's `false` afterwards would (a) tell the user a
        // write failed that was never allowed to succeed, and (b) make the screen look
        // like a bug rather than a platform limit with a way out.
        self.refuse_if_platform_managed(radio).await?;
        match radio {
            RadioMode::Airplane => {
                if on {
                    // The cascade must be *possible* before it starts: every radio it
                    // switches off has to be one this app may switch. Otherwise the
                    // first step could apply and the second refuse, leaving the device
                    // half-cascaded — the exact state `rollback_to` exists to avoid.
                    for member in [RadioMode::Wifi, RadioMode::Bluetooth, RadioMode::Hotspot] {
                        self.refuse_if_platform_managed(member).await?;
                    }
                    // Airplane ON cascades Wi-Fi + Bluetooth off. Do it atomically:
                    // capture the prior state and, if a cascade step fails after
                    // Airplane is already on, roll the whole set back so the user's
                    // failed action does not leave a half-applied Airplane state.
                    // The rollback is *reported*, not assumed: see `rollback_to`.
                    let before = self.snapshot().await?;
                    self.provider.set_airplane(true).await?;
                    if let Err(e) = self.provider.set_wifi(false).await {
                        self.rollback_to(before).await;
                        return Err(e);
                    }
                    if let Err(e) = self.provider.set_bluetooth(false).await {
                        self.rollback_to(before).await;
                        return Err(e);
                    }
                    if let Err(e) = self.provider.set_hotspot(false).await {
                        self.rollback_to(before).await;
                        return Err(e);
                    }
                } else {
                    self.provider.set_airplane(false).await?;
                }
            }
            RadioMode::Wifi => {
                self.ensure_airplane_off(RadioMode::Wifi).await?;
                self.provider.set_wifi(on).await?;
            }
            RadioMode::Bluetooth => {
                self.ensure_airplane_off(RadioMode::Bluetooth).await?;
                self.provider.set_bluetooth(on).await?;
            }
            RadioMode::Hotspot => {
                self.ensure_airplane_off(RadioMode::Hotspot).await?;
                self.provider.set_hotspot(on).await?;
            }
        }
        self.snapshot().await
    }

    /// Read the Bluetooth adapter's own name (REQ-A199).
    ///
    /// A provider with no adapter answers [`RadioError::Unsupported`] — the caller
    /// then keeps showing its *remembered* name as a preference, instead of
    /// painting that remembered value as a device fact.
    pub async fn bluetooth_local_name(&self) -> Result<String> {
        self.provider.bluetooth_local_name().await
    }

    /// Rename the adapter and return the name the platform reports afterwards.
    ///
    /// The **name rules live here**, in the policy layer, not in each provider —
    /// the same split as the Airplane cascade: a blank name is refused before any
    /// provider is reached, and an over-long name is truncated on a char boundary
    /// ([`crate::bluetooth::normalize_local_name`]). So the device backend, a
    /// future backend and the offline Mock all agree on what "a valid name" is,
    /// and the rule is unit-testable without a device.
    pub async fn set_bluetooth_local_name(&self, name: &str) -> Result<String> {
        let wanted = crate::bluetooth::normalize_local_name(name)?;
        self.provider.set_bluetooth_local_name(&wanted).await
    }

    /// The devices this adapter is paired with (empty list is a real answer;
    /// `Unsupported` means nobody could ask the platform).
    pub async fn bluetooth_paired_devices(&self) -> Result<Vec<BtPeer>> {
        self.provider.bluetooth_paired_devices().await
    }

    /// Start a Bluetooth scan. `Ok(true)` = the platform accepted it.
    pub async fn bluetooth_start_discovery(&self) -> Result<bool> {
        self.provider.bluetooth_start_discovery().await
    }

    /// Cancel a running Bluetooth scan (`Ok(true)` = cancelled or nothing was running).
    pub async fn bluetooth_stop_discovery(&self) -> Result<bool> {
        self.provider.bluetooth_stop_discovery().await
    }

    /// The scan's current state (running / capped / allowed / results).
    pub async fn bluetooth_scan_state(&self) -> Result<crate::bluetooth::BtScan> {
        self.provider.bluetooth_scan_state().await
    }

    /// Ask the platform to pair with `address`.
    ///
    /// The **address rule lives here**, in the policy layer (like the name rules and
    /// the Airplane cascade): a blank address is refused before any provider is
    /// reached, because "pair with nothing" is not a request the platform should ever
    /// see. Returns whether the platform accepted the request — never "paired".
    pub async fn bluetooth_pair(&self, address: &str) -> Result<bool> {
        let wanted = address.trim();
        if wanted.is_empty() {
            return Err(RadioError::Provider(
                "refusing to pair a Bluetooth device without an address".to_string(),
            ));
        }
        self.provider.bluetooth_pair(wanted).await
    }

    /// Best-effort restore of every radio bit to `before` after a failed cascade.
    ///
    /// The original failure is the one the caller gets, but the restore is **not
    /// allowed to be silent**: the manager cannot undo a provider's failure, so a
    /// step that fails means the device keeps whatever the provider actually holds —
    /// the user's action reported an error, yet a radio may well have been switched.
    /// Each failed step is therefore logged with the radio and the error, so the
    /// broken restore is visible instead of being covered by the returned error.
    async fn rollback_to(&self, before: RadioSnapshot) {
        if let Err(e) = self.provider.set_airplane(before.airplane).await {
            tracing::warn!(
                target: "amos::radio",
                radio = "airplane",
                wanted = before.airplane,
                error = %e,
                "airplane rollback failed — the device may keep a partially applied state"
            );
        }
        if let Err(e) = self.provider.set_wifi(before.wifi).await {
            tracing::warn!(
                target: "amos::radio",
                radio = "wifi",
                wanted = before.wifi,
                error = %e,
                "Wi-Fi rollback failed — the device may keep a partially applied state"
            );
        }
        if let Err(e) = self.provider.set_bluetooth(before.bluetooth).await {
            tracing::warn!(
                target: "amos::radio",
                radio = "bluetooth",
                wanted = before.bluetooth,
                error = %e,
                "Bluetooth rollback failed — the device may keep a partially applied state"
            );
        }
        if let Err(e) = self.provider.set_hotspot(before.hotspot).await {
            tracing::warn!(
                target: "amos::radio",
                radio = "hotspot",
                wanted = before.hotspot,
                error = %e,
                "hotspot rollback failed — the device may keep a partially applied state"
            );
        }
    }

    /// Refuse non-airplane radios while Airplane mode is on.
    async fn ensure_airplane_off(&self, radio: RadioMode) -> Result<()> {
        let snap = self.snapshot().await?;
        if snap.airplane {
            return Err(RadioError::AirplaneActive(radio));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{MockRadioProvider, PlatformReason};
    use crate::state::RadioSnapshot;

    fn manager(initial: RadioSnapshot) -> RadioManager {
        RadioManager::new(Arc::new(MockRadioProvider::new(initial)))
    }

    fn radios_on() -> RadioSnapshot {
        RadioSnapshot {
            wifi: true,
            bluetooth: true,
            airplane: false,
            hotspot: true,
        }
    }

    #[tokio::test]
    async fn airplane_on_cascades_wifi_and_bt_off() {
        let m = manager(radios_on());
        let snap = m.set(RadioMode::Airplane, true).await.unwrap();
        assert!(snap.airplane);
        assert!(!snap.wifi, "airplane ON must switch Wi-Fi off");
        assert!(!snap.bluetooth, "airplane ON must switch Bluetooth off");
        assert!(
            !snap.hotspot,
            "airplane ON must switch the personal hotspot (AP) off too"
        );
    }

    #[tokio::test]
    async fn enabling_wifi_or_bt_under_airplane_is_refused() {
        let m = manager(RadioSnapshot {
            airplane: true,
            ..RadioSnapshot::default()
        });
        assert!(matches!(
            m.set(RadioMode::Wifi, true).await,
            Err(RadioError::AirplaneActive(RadioMode::Wifi))
        ));
        assert!(matches!(
            m.set(RadioMode::Bluetooth, true).await,
            Err(RadioError::AirplaneActive(RadioMode::Bluetooth))
        ));
        assert!(matches!(
            m.set(RadioMode::Hotspot, true).await,
            Err(RadioError::AirplaneActive(RadioMode::Hotspot))
        ));
    }

    #[tokio::test]
    async fn hotspot_is_its_own_bit_not_the_wifi_client() {
        // The AP and the station radio are independent: enabling the hotspot must
        // not touch the Wi-Fi client bit (they are different Android managers).
        let m = manager(RadioSnapshot::default());
        let snap = m.set(RadioMode::Hotspot, true).await.unwrap();
        assert!(snap.hotspot);
        assert!(!snap.wifi, "the AP bit must not turn the Wi-Fi client on");

        let off = m.set(RadioMode::Wifi, false).await.unwrap();
        assert!(
            off.hotspot,
            "toggling the Wi-Fi client must not disturb the hotspot"
        );
    }

    #[tokio::test]
    async fn airplane_off_allows_toggling_radios() {
        let m = manager(RadioSnapshot::default());
        let snap = m.set(RadioMode::Bluetooth, true).await.unwrap();
        assert!(snap.bluetooth);
        assert!(!snap.airplane);
    }

    #[tokio::test]
    async fn turning_airplane_off_reenables_radio_control() {
        let m = manager(RadioSnapshot {
            airplane: true,
            ..RadioSnapshot::default()
        });
        let off = m.set(RadioMode::Airplane, false).await.unwrap();
        assert!(!off.airplane);

        let wifi_on = m.set(RadioMode::Wifi, true).await.unwrap();
        assert!(wifi_on.wifi);
        assert!(!wifi_on.airplane);
    }

    #[tokio::test]
    async fn airplane_on_is_idempotent() {
        let m = manager(radios_on());
        let first = m.set(RadioMode::Airplane, true).await.unwrap();
        assert!(first.airplane && !first.wifi && !first.bluetooth);
        // Turning it on again must not error nor resurrect the radios.
        let again = m.set(RadioMode::Airplane, true).await.unwrap();
        assert_eq!(again, first);
    }

    #[tokio::test]
    async fn radios_stay_off_after_airplane_cycle_until_re_enabled() {
        let m = manager(radios_on());
        let _on = m.set(RadioMode::Airplane, true).await.unwrap();
        let _off = m.set(RadioMode::Airplane, false).await.unwrap();
        // Cascading OFF does not silently re-enable the radios.
        let snap = m.snapshot().await.unwrap();
        assert!(!snap.airplane && !snap.wifi && !snap.bluetooth);
        // But each can be turned back on individually once airplane is off.
        assert!(m.set(RadioMode::Wifi, true).await.unwrap().wifi);
        assert!(m.set(RadioMode::Bluetooth, true).await.unwrap().bluetooth);
    }

    #[tokio::test]
    async fn set_returns_authoritative_snapshot() {
        let m = manager(radios_on());
        let snap = m.set(RadioMode::Wifi, false).await.unwrap();
        assert!(!snap.wifi);
        assert!(snap.bluetooth, "Bluetooth is untouched by the Wi-Fi toggle");
    }

    // ---- failure-injection: Airplane cascade is atomic (rolls back) ----
    use async_trait::async_trait;
    use tokio::sync::Mutex;

    /// A provider whose Wi-Fi/Bluetooth/hotspot writes can be made to fail a set
    /// number of times, to prove the manager rolls back a partially-applied cascade.
    struct FlakyProvider {
        state: Mutex<RadioSnapshot>,
        wifi_failures: Mutex<usize>,
        bt_failures: Mutex<usize>,
        hotspot_failures: Mutex<usize>,
    }

    impl FlakyProvider {
        fn new(
            initial: RadioSnapshot,
            wifi_failures: usize,
            bt_failures: usize,
            hotspot_failures: usize,
        ) -> Self {
            Self {
                state: Mutex::new(initial),
                wifi_failures: Mutex::new(wifi_failures),
                bt_failures: Mutex::new(bt_failures),
                hotspot_failures: Mutex::new(hotspot_failures),
            }
        }
    }

    #[async_trait]
    impl RadioProvider for FlakyProvider {
        async fn snapshot(&self) -> Result<RadioSnapshot> {
            Ok(*self.state.lock().await)
        }
        async fn set_wifi(&self, on: bool) -> Result<()> {
            let mut f = self.wifi_failures.lock().await;
            if *f > 0 {
                *f -= 1;
                return Err(RadioError::Provider("injected wifi failure".into()));
            }
            drop(f);
            self.state.lock().await.wifi = on;
            Ok(())
        }
        async fn set_bluetooth(&self, on: bool) -> Result<()> {
            let mut f = self.bt_failures.lock().await;
            if *f > 0 {
                *f -= 1;
                return Err(RadioError::Provider("injected bluetooth failure".into()));
            }
            drop(f);
            self.state.lock().await.bluetooth = on;
            Ok(())
        }
        async fn set_airplane(&self, on: bool) -> Result<()> {
            self.state.lock().await.airplane = on;
            Ok(())
        }
        async fn set_hotspot(&self, on: bool) -> Result<()> {
            let mut f = self.hotspot_failures.lock().await;
            if *f > 0 {
                *f -= 1;
                return Err(RadioError::Provider("injected hotspot failure".into()));
            }
            drop(f);
            self.state.lock().await.hotspot = on;
            Ok(())
        }
    }

    #[tokio::test]
    async fn airplane_cascade_wifi_failure_rolls_back_to_prior_state() {
        let initial = radios_on();
        let provider = Arc::new(FlakyProvider::new(
            initial, /*wifi_fail*/ 1, /*bt_fail*/ 0, /*hotspot_fail*/ 0,
        ));
        let m = RadioManager::new(provider);

        let err = m.set(RadioMode::Airplane, true).await.unwrap_err();
        assert!(matches!(err, RadioError::Provider(_)), "{err}");
        // No partial Airplane state may leak: every bit restored to `before`.
        assert_eq!(m.snapshot().await.unwrap(), initial);
    }

    #[tokio::test]
    async fn airplane_cascade_bluetooth_failure_rolls_back_to_prior_state() {
        let initial = radios_on();
        let provider = Arc::new(FlakyProvider::new(
            initial, /*wifi_fail*/ 0, /*bt_fail*/ 1, /*hotspot_fail*/ 0,
        ));
        let m = RadioManager::new(provider);

        let err = m.set(RadioMode::Airplane, true).await.unwrap_err();
        assert!(matches!(err, RadioError::Provider(_)), "{err}");
        assert_eq!(m.snapshot().await.unwrap(), initial);
    }

    #[tokio::test]
    async fn airplane_cascade_hotspot_failure_rolls_back_to_prior_state() {
        // The AP is the last cascade step; a failure there must roll the whole set
        // back just like Wi-Fi/Bluetooth — no half-applied Airplane state.
        let initial = radios_on();
        let provider = Arc::new(FlakyProvider::new(
            initial, /*wifi_fail*/ 0, /*bt_fail*/ 0, /*hotspot_fail*/ 1,
        ));
        let m = RadioManager::new(provider);

        let err = m.set(RadioMode::Airplane, true).await.unwrap_err();
        assert!(matches!(err, RadioError::Provider(_)), "{err}");
        assert_eq!(m.snapshot().await.unwrap(), initial);
    }

    #[tokio::test]
    async fn airplane_on_succeeds_when_cascade_has_no_failures() {
        let initial = radios_on();
        let provider = Arc::new(FlakyProvider::new(
            initial, /*wifi_fail*/ 0, /*bt_fail*/ 0, /*hotspot_fail*/ 0,
        ));
        let m = RadioManager::new(provider);

        let snap = m.set(RadioMode::Airplane, true).await.unwrap();
        assert!(snap.airplane && !snap.wifi && !snap.bluetooth && !snap.hotspot);
    }

    /// A provider that answers the platform-capability question per radio and records
    /// every write it receives — the shape a real device has, and what lets a test
    /// prove that a refused switch **never reached the provider** (REQ-A202).
    struct ManagedProvider {
        managed: Vec<(RadioMode, SystemSurface, PlatformReason)>,
        writes: tokio::sync::Mutex<Vec<(&'static str, bool)>>,
    }

    impl ManagedProvider {
        fn new(managed: Vec<(RadioMode, SystemSurface, PlatformReason)>) -> Self {
            Self {
                managed,
                writes: tokio::sync::Mutex::new(Vec::new()),
            }
        }
        async fn record(&self, radio: &'static str, on: bool) {
            self.writes.lock().await.push((radio, on));
        }
        async fn writes(&self) -> Vec<(&'static str, bool)> {
            self.writes.lock().await.clone()
        }
    }

    #[async_trait]
    impl RadioProvider for ManagedProvider {
        async fn snapshot(&self) -> Result<RadioSnapshot> {
            Ok(radios_on())
        }
        async fn set_wifi(&self, on: bool) -> Result<()> {
            self.record("wifi", on).await;
            Ok(())
        }
        async fn set_bluetooth(&self, on: bool) -> Result<()> {
            self.record("bluetooth", on).await;
            Ok(())
        }
        async fn set_airplane(&self, on: bool) -> Result<()> {
            self.record("airplane", on).await;
            Ok(())
        }
        async fn set_hotspot(&self, on: bool) -> Result<()> {
            self.record("hotspot", on).await;
            Ok(())
        }
        async fn control(&self, radio: RadioMode) -> RadioControl {
            for (r, surface, reason) in &self.managed {
                if *r == radio {
                    return RadioControl::PlatformManaged {
                        surface: *surface,
                        reason: *reason,
                    };
                }
            }
            RadioControl::AppControlled
        }
        async fn open_system_surface(&self, _surface: SystemSurface) -> Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_platform_managed_radio_is_refused_before_the_provider_is_asked_to_write() {
        // What a normal app meets on the S5 (REQ-A202): the switch exists in the UI but
        // no app may flip it. The failure the *old* code produced ("the platform refused
        // to switch Bluetooth on") described an attempt the platform never allows — and
        // told the user nothing they could do about it.
        let provider = Arc::new(ManagedProvider::new(vec![(
            RadioMode::Bluetooth,
            SystemSurface::BluetoothSettings,
            PlatformReason::SwitchRemoved,
        )]));
        let m = RadioManager::new(provider.clone());

        let err = m.set(RadioMode::Bluetooth, true).await.unwrap_err();
        assert_eq!(
            err,
            RadioError::PlatformManaged {
                radio: RadioMode::Bluetooth,
                surface: SystemSurface::BluetoothSettings,
                reason: PlatformReason::SwitchRemoved,
            }
        );
        assert!(
            provider.writes().await.is_empty(),
            "nothing may be attempted on a switch the platform owns"
        );
        // The read side still reports the device's real state — refusing a write must
        // never blank the snapshot.
        assert!(m.snapshot().await.unwrap().bluetooth);
    }

    #[tokio::test]
    async fn the_airplane_cascade_refuses_when_a_member_is_platform_managed() {
        // Airplane ON switches Wi-Fi + Bluetooth + the AP off. If one of them is a
        // switch an app may not touch, the cascade cannot be *started*: otherwise the
        // first step applies and the second refuses, leaving the device half-cascaded
        // (the state `rollback_to` exists to avoid — and which no rollback can undo
        // when the platform forbids both directions).
        let provider = Arc::new(ManagedProvider::new(vec![(
            RadioMode::Bluetooth,
            SystemSurface::BluetoothSettings,
            PlatformReason::SwitchRemoved,
        )]));
        let m = RadioManager::new(provider.clone());

        let err = m.set(RadioMode::Airplane, true).await.unwrap_err();
        assert_eq!(
            err,
            RadioError::PlatformManaged {
                radio: RadioMode::Bluetooth,
                surface: SystemSurface::BluetoothSettings,
                reason: PlatformReason::SwitchRemoved,
            },
            "the error names the member that blocks the cascade, not the airplane bit"
        );
        assert!(
            provider.writes().await.is_empty(),
            "no cascade step may run — the airplane bit is not even set"
        );
        let snap = m.snapshot().await.unwrap();
        assert!(!snap.airplane && snap.wifi && snap.bluetooth && snap.hotspot);
    }

    #[tokio::test]
    async fn control_and_the_system_surface_follow_the_provider() {
        let provider = Arc::new(ManagedProvider::new(vec![(
            RadioMode::Wifi,
            SystemSurface::WifiPanel,
            PlatformReason::SwitchRemoved,
        )]));
        let m = RadioManager::new(provider);
        assert!(m.control(RadioMode::Wifi).await.is_managed());
        assert_eq!(
            m.control(RadioMode::Hotspot).await,
            RadioControl::AppControlled
        );
        // Opening the surface is a *provider* action (only it holds the Context), and
        // its acceptance is what the caller gets.
        m.open_system_surface(SystemSurface::WifiPanel)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn the_offline_mock_owns_every_switch_and_has_no_surface_to_open() {
        // The Mock's `AppControlled` is a claim about the *store*, and it must stay the
        // default: a desktop/offline run has no platform to consult. It also has nothing
        // to hand the user to, so opening a surface is `Unsupported` rather than a
        // silent `Ok` that would read as "the screen appeared".
        let m = manager(radios_on());
        for radio in RadioMode::ALL {
            assert_eq!(m.control(radio).await, RadioControl::AppControlled);
        }
        assert!(matches!(
            m.open_system_surface(SystemSurface::AirplaneSettings).await,
            Err(RadioError::Unsupported(_))
        ));
    }

    /// Records what the policy layer hands to a provider, so the name rules can be
    /// checked without a device (REQ-A199).
    struct RecordingNameProvider {
        seen: tokio::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl RadioProvider for RecordingNameProvider {
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
        async fn set_bluetooth_local_name(&self, name: &str) -> Result<String> {
            self.seen.lock().await.push(name.to_string());
            // The platform's answer: here, what it was given.
            Ok(name.to_string())
        }
    }

    #[tokio::test]
    async fn the_name_policy_holds_in_the_manager_not_in_each_provider() {
        let provider = Arc::new(RecordingNameProvider {
            seen: tokio::sync::Mutex::new(Vec::new()),
        });
        let m = RadioManager::new(provider.clone());

        // A blank name is refused **before** any provider call: a wrong-shaped
        // provider never gets the chance to accept something meaningless.
        let err = m.set_bluetooth_local_name("   ").await.unwrap_err();
        assert!(matches!(err, RadioError::Provider(_)), "{err}");
        assert!(provider.seen.lock().await.is_empty(), "nothing was sent");

        // An over-long name reaches the provider already trimmed and truncated on a
        // char boundary (the provider only ever sees a name the platform can take).
        let long = format!("  {}  ", "中".repeat(100));
        let accepted = m.set_bluetooth_local_name(&long).await.unwrap();
        assert_eq!(accepted.len(), 246);
        assert_eq!(provider.seen.lock().await.as_slice(), [accepted]);
    }

    #[tokio::test]
    async fn bluetooth_details_are_unsupported_until_a_device_backend_answers() {
        // The Mock-backed manager is the desktop/offline shape: it must say
        // "unsupported" rather than report a device failure the user cannot act on,
        // because the UI falls back to its remembered preference on exactly that
        // distinction (REQ-A199).
        let m = manager(radios_on());
        assert!(matches!(
            m.bluetooth_local_name().await,
            Err(RadioError::Unsupported(_))
        ));
        assert!(matches!(
            m.bluetooth_paired_devices().await,
            Err(RadioError::Unsupported(_))
        ));
    }
}
