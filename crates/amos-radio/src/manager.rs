//! [`RadioManager`]: drives a [`RadioProvider`] and enforces the radio policy.
//!
//! The provider is deliberately a dumb register (see [`crate::provider`]); all the
//! rules the UI depends on live here so they are unit-testable and identical
//! across the Mock and a future real backend:
//!
//! * Enabling Airplane mode cascades Wi-Fi + Bluetooth **off** — and is
//!   **atomic**: if any cascade step fails after Airplane is switched on, the
//!   provider is rolled back to the exact prior snapshot and the error surfaces,
//!   so a partially-applied Airplane state never leaks.
//! * The non-airplane radios (Wi-Fi / Bluetooth) cannot be switched on while
//!   Airplane mode is active — the set is refused with
//!   [`RadioError::AirplaneActive`].
//!
//! [`RadioManager::set`] returns the resulting authoritative [`RadioSnapshot`]
//! so callers (e.g. the System UI bridge) can mirror exactly what the radios now
//! report, rather than trusting their intent.

use std::sync::Arc;

use crate::error::{RadioError, Result};
use crate::provider::RadioProvider;
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

    /// Apply a toggle to one radio, enforcing the Airplane-mode policy, and
    /// return the resulting authoritative snapshot.
    pub async fn set(&self, radio: RadioMode, on: bool) -> Result<RadioSnapshot> {
        match radio {
            RadioMode::Airplane => {
                if on {
                    // Airplane ON cascades Wi-Fi + Bluetooth off. Do it atomically:
                    // capture the prior state and, if a cascade step fails after
                    // Airplane is already on, roll the whole set back so a partially
                    // applied Airplane state can never leak to the user/provider.
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
        }
        self.snapshot().await
    }

    /// Best-effort restore of every radio bit to `before` after a failed cascade.
    /// Swallows per-call errors (the original failure is the one we report).
    async fn rollback_to(&self, before: RadioSnapshot) {
        let _ = self.provider.set_airplane(before.airplane).await;
        let _ = self.provider.set_wifi(before.wifi).await;
        let _ = self.provider.set_bluetooth(before.bluetooth).await;
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
    use crate::provider::MockRadioProvider;
    use crate::state::RadioSnapshot;

    fn manager(initial: RadioSnapshot) -> RadioManager {
        RadioManager::new(Arc::new(MockRadioProvider::new(initial)))
    }

    fn radios_on() -> RadioSnapshot {
        RadioSnapshot {
            wifi: true,
            bluetooth: true,
            airplane: false,
        }
    }

    #[tokio::test]
    async fn airplane_on_cascades_wifi_and_bt_off() {
        let m = manager(radios_on());
        let snap = m.set(RadioMode::Airplane, true).await.unwrap();
        assert!(snap.airplane);
        assert!(!snap.wifi, "airplane ON must switch Wi-Fi off");
        assert!(!snap.bluetooth, "airplane ON must switch Bluetooth off");
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

    /// A provider whose Wi-Fi/Bluetooth writes can be made to fail a set number
    /// of times, to prove the manager rolls back a partially-applied cascade.
    struct FlakyProvider {
        state: Mutex<RadioSnapshot>,
        wifi_failures: Mutex<usize>,
        bt_failures: Mutex<usize>,
    }

    impl FlakyProvider {
        fn new(initial: RadioSnapshot, wifi_failures: usize, bt_failures: usize) -> Self {
            Self {
                state: Mutex::new(initial),
                wifi_failures: Mutex::new(wifi_failures),
                bt_failures: Mutex::new(bt_failures),
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
    }

    #[tokio::test]
    async fn airplane_cascade_wifi_failure_rolls_back_to_prior_state() {
        let initial = radios_on();
        let provider = Arc::new(FlakyProvider::new(
            initial, /*wifi_fail*/ 1, /*bt_fail*/ 0,
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
            initial, /*wifi_fail*/ 0, /*bt_fail*/ 1,
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
            initial, /*wifi_fail*/ 0, /*bt_fail*/ 0,
        ));
        let m = RadioManager::new(provider);

        let snap = m.set(RadioMode::Airplane, true).await.unwrap();
        assert!(snap.airplane && !snap.wifi && !snap.bluetooth);
    }
}
