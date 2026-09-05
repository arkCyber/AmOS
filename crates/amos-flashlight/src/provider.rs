//! Provider seams and a deterministic mock.
//!
//! The [`FlashlightProvider`] is the single point where the flashlight policy
//! ([`crate::FlashlightManager`]) talks to real illumination hardware. By design
//! it is a *dumb* register over the torch: it only reports the current snapshot
//! (on/off + whether a usable torch exists) and flips the torch on/off. All
//! policy (the "cannot light a torch that doesn't exist" guard) lives in
//! [`crate::FlashlightManager`], never here — the same split the radio /
//! telephony cores use (policy in the domain core, not the provider).
//!
//! For P0 we ship a deterministic in-memory [`MockFlashlightProvider`]; the real
//! Android backend (Android `CameraManager#setTorchMode`) replaces it under the
//! `android` feature.

use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::error::Result;
use crate::state::FlashlightState;

/// The external seam to a real (or mocked) flashlight backend.
#[async_trait]
pub trait FlashlightProvider: Send + Sync {
    /// Read the current flashlight snapshot (torch on/off + hardware presence).
    async fn snapshot(&self) -> Result<FlashlightState>;

    /// Set the torch on (`true`) or off (`false`). Returns the boolean the
    /// backend reported, or an error if the write failed.
    async fn set_on(&self, on: bool) -> Result<()>;

    /// Report a torch state the **OS** drove externally (e.g. a
    /// `CameraManager.TorchCallback` → thermal shutdown, another app toggling,
    /// or the camera capturing), so `snapshot()` stays truthful even when the
    /// change did not originate from [`FlashlightProvider::set_on`].
    ///
    /// Default: no-op. The Mock has no OS, so it never changes under external
    /// events; the real Android backend reflects them.
    fn note_external_state(&self, _on: bool) {}
}

/// Deterministic, in-memory [`FlashlightProvider`] for tests and offline demos.
///
/// Thread-safe (a `tokio` mutex guards the state) and seedable with the true
/// hardware picture so the mock is honest about whether a torch exists. It does
/// **not** enforce any policy by itself — the manager does that.
pub struct MockFlashlightProvider {
    inner: Arc<Mutex<FlashlightState>>,
}

impl MockFlashlightProvider {
    /// Create a mock starting from `initial` state.
    pub fn new(initial: FlashlightState) -> Self {
        Self {
            inner: Arc::new(Mutex::new(initial)),
        }
    }
}

impl Default for MockFlashlightProvider {
    fn default() -> Self {
        Self::new(FlashlightState::default())
    }
}

#[async_trait]
impl FlashlightProvider for MockFlashlightProvider {
    async fn snapshot(&self) -> Result<FlashlightState> {
        Ok(*self.inner.lock().await)
    }

    async fn set_on(&self, on: bool) -> Result<()> {
        let mut g = self.inner.lock().await;
        g.on = on;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_round_trips_on_off() {
        let p = MockFlashlightProvider::new(FlashlightState::off_with_torch());
        assert!(!p.snapshot().await.unwrap().lit());

        p.set_on(true).await.unwrap();
        assert!(p.snapshot().await.unwrap().lit());

        p.set_on(false).await.unwrap();
        assert!(!p.snapshot().await.unwrap().lit());
        // The hardware-presence fact is never clobbered by a toggle.
        assert!(p.snapshot().await.unwrap().available());
    }

    #[tokio::test]
    async fn mock_preserves_hardware_picture() {
        let p = MockFlashlightProvider::new(FlashlightState::no_torch());
        p.set_on(true).await.unwrap();
        let s = p.snapshot().await.unwrap();
        assert!(s.lit());
        assert!(
            !s.available(),
            "mock has no torch; toggling must not invent one"
        );
    }

    #[tokio::test]
    async fn mock_ignores_external_state_notes() {
        // A Mock has no OS driving it, so an external-state note must never move
        // the mock (the default `note_external_state` no-op). Real backends
        // override it to reflect OS-driven torch changes.
        let p = MockFlashlightProvider::new(FlashlightState::off_with_torch());
        p.note_external_state(true);
        assert!(!p.snapshot().await.unwrap().lit());
    }
}
