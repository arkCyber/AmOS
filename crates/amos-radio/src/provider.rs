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
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::error::Result;
use crate::state::RadioSnapshot;

/// The external seam to a real (or mocked) radio stack.
#[async_trait]
pub trait RadioProvider: Send + Sync {
    /// Read the current on/off state of every radio.
    async fn snapshot(&self) -> Result<RadioSnapshot>;

    /// Switch Wi-Fi on/off.
    async fn set_wifi(&self, on: bool) -> Result<()>;

    /// Switch Bluetooth on/off.
    async fn set_bluetooth(&self, on: bool) -> Result<()>;

    /// Switch Airplane mode on/off.
    async fn set_airplane(&self, on: bool) -> Result<()>;
}

/// Deterministic, in-memory [`RadioProvider`] for tests and offline demos.
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
}
