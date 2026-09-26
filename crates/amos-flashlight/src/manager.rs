//! [`FlashlightManager`]: drives a [`FlashlightProvider`] and enforces the
//! flashlight policy.
//!
//! The provider is deliberately a dumb register (see [`crate::provider`]); all
//! the rules the UI depends on live here so they are unit-testable and identical
//! across the Mock and a future real backend:
//!
//! * The torch **cannot be lit on a device that has no usable torch hardware** —
//!   [`FlashlightError::NoTorchHardware`]. This is the analog of radio's
//!   "no non-airplane radio while Airplane is on" guard: turning the light off on
//!   such a device is always harmless/idempotent, but turning it on is refused.
//! * Switching the torch **off** is always permitted, even when no torch exists
//!   (defensive/idempotent), mirroring radio's cascading-OFF semantics.
//!
//! [`FlashlightManager::set_on`] / [`FlashlightManager::toggle`] return the
//! resulting authoritative [`FlashlightState`] so callers (e.g. the System UI
//! bridge) can mirror exactly what the backend now reports, rather than trusting
//! their intent.

use std::sync::Arc;

use crate::error::{FlashlightError, Result};
use crate::provider::FlashlightProvider;
use crate::state::FlashlightState;

/// A policy-owning handle over one [`FlashlightProvider`].
pub struct FlashlightManager {
    provider: Arc<dyn FlashlightProvider>,
}

impl FlashlightManager {
    /// Wrap a provider (Mock today; a real Android backend later).
    pub fn new(provider: Arc<dyn FlashlightProvider>) -> Self {
        Self { provider }
    }

    /// Read the current flashlight snapshot (torch on/off + hardware presence).
    pub async fn snapshot(&self) -> Result<FlashlightState> {
        self.provider.snapshot().await
    }

    /// Set the torch on (`true`) / off (`false`), enforcing the hardware-presence
    /// guard, and return the resulting authoritative snapshot.
    pub async fn set_on(&self, on: bool) -> Result<FlashlightState> {
        if on {
            let snap = self.snapshot().await?;
            if !snap.available() {
                // A torch that doesn't exist cannot illuminate. Refuse rather
                // than pretend the light is on.
                return Err(FlashlightError::NoTorchHardware);
            }
        }
        // OFF is always permitted (idempotent + defensive).
        self.provider.set_on(on).await?;
        self.snapshot().await
    }

    /// Like [`Self::set_on`], but also reports whether the provider actually
    /// **confirmed** the requested change.
    ///
    /// Returns `(state, confirmed)`: `state` is the resulting authoritative
    /// snapshot (the caller mirrors what the backend now reports, not its own
    /// intent), and `confirmed` is `true` only when that snapshot's `lit()`
    /// equals the requested `on`. A provider that reports success but leaves the
    /// torch in the other state — an OS `TorchCallback` racing us, a driver that
    /// dropped the write, a fallback backend serving a request the real hardware
    /// never saw — yields `confirmed == false` while `state` still tells the
    /// truth. This is the signal the System UI bridge turns into the
    /// `amos.flashlight.provider_unconfirmed` wire code, which otherwise had no
    /// producing path.
    pub async fn set_on_checked(&self, on: bool) -> Result<(FlashlightState, bool)> {
        let snap = self.set_on(on).await?;
        Ok((snap, snap.lit() == on))
    }

    /// Flip the torch: off→on, on→off. Turning off when it is already off (or on
    /// a torch-less device) is a harmless no-op that returns the current state.
    pub async fn toggle(&self) -> Result<FlashlightState> {
        let snap = self.snapshot().await?;
        self.set_on(!snap.lit()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MockFlashlightProvider;

    fn manager(state: FlashlightState) -> FlashlightManager {
        FlashlightManager::new(Arc::new(MockFlashlightProvider::new(state)))
    }

    #[tokio::test]
    async fn torch_on_device_can_be_lit_and_switched_off() {
        let m = manager(FlashlightState::off_with_torch());
        let lit = m.set_on(true).await.unwrap();
        assert!(lit.lit());
        assert!(lit.available());

        let off = m.set_on(false).await.unwrap();
        assert!(!off.lit());
        assert!(
            off.available(),
            "hardware presence is untouched by toggling"
        );
    }

    #[tokio::test]
    async fn torchless_device_refuses_to_light() {
        let m = manager(FlashlightState::no_torch());
        assert!(matches!(
            m.set_on(true).await,
            Err(FlashlightError::NoTorchHardware)
        ));
        // And nothing was invented: still no torch, still dark.
        let snap = m.snapshot().await.unwrap();
        assert!(!snap.lit() && !snap.available());
    }

    #[tokio::test]
    async fn torchless_device_still_allows_defensive_off() {
        // Turning "off" a torch that isn't lit must never error — the UI's
        // quick-setting can safely always send the current intent.
        let m = manager(FlashlightState::no_torch());
        let snap = m.set_on(false).await.unwrap();
        assert!(!snap.lit());
    }

    #[tokio::test]
    async fn set_returns_authoritative_snapshot() {
        let m = manager(FlashlightState::off_with_torch());
        assert!(m.set_on(true).await.unwrap().lit());
    }

    #[tokio::test]
    async fn toggle_flips_state() {
        let m = manager(FlashlightState::off_with_torch());
        assert!(m.toggle().await.unwrap().lit());
        assert!(!m.toggle().await.unwrap().lit());
        assert!(m.toggle().await.unwrap().lit());
    }

    /// A provider that accepts every write (`set_on` → `Ok(())`) but never
    /// actually moves the torch — the "silent failure" the `provider_unconfirmed`
    /// wire code exists to name. `snapshot` keeps returning the seeded truth, so
    /// a request-vs-persisted comparison is the only way to catch it.
    struct StuckProvider {
        state: std::sync::Mutex<FlashlightState>,
    }

    impl StuckProvider {
        fn new(initial: FlashlightState) -> Self {
            Self {
                state: std::sync::Mutex::new(initial),
            }
        }
    }

    #[async_trait::async_trait]
    impl FlashlightProvider for StuckProvider {
        async fn snapshot(&self) -> Result<FlashlightState> {
            Ok(*self.state.lock().unwrap())
        }

        async fn set_on(&self, _on: bool) -> Result<()> {
            Ok(()) // reports success, changes nothing
        }
    }

    #[tokio::test]
    async fn set_on_checked_confirms_a_provider_that_honours_the_request() {
        let m = manager(FlashlightState::off_with_torch());
        let (state, confirmed) = m.set_on_checked(true).await.unwrap();
        assert!(state.lit());
        assert!(confirmed, "the mock honours the write, so it is confirmed");

        let (state, confirmed) = m.set_on_checked(false).await.unwrap();
        assert!(!state.lit());
        assert!(confirmed, "turning it off is confirmed too");
    }

    #[tokio::test]
    async fn set_on_checked_flags_a_silent_failure() {
        // The provider says Ok but the torch never lights: the request was NOT
        // confirmed. `state` still reports the truth (dark), and `confirmed` is
        // the signal the bridge emits as `amos.flashlight.provider_unconfirmed`.
        let m = FlashlightManager::new(Arc::new(StuckProvider::new(
            FlashlightState::off_with_torch(),
        )));
        let (state, confirmed) = m.set_on_checked(true).await.unwrap();
        assert!(!state.lit(), "the authoritative snapshot stays dark");
        assert!(!confirmed, "a write that changed nothing is not confirmed");
    }

    #[tokio::test]
    async fn toggle_on_torchless_device_is_refused_not_pretended() {
        let m = manager(FlashlightState::no_torch());
        assert!(matches!(
            m.toggle().await,
            Err(FlashlightError::NoTorchHardware)
        ));
    }
}
