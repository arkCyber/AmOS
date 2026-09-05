//! Error type and result alias for the flashlight domain core.

use thiserror::Error;

/// Errors surfaced by the flashlight manager and its providers.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum FlashlightError {
    /// The torch was requested ON, but this device reports no usable flash unit
    /// (no rear camera with a flash), so illumination is impossible.
    #[error("no torch hardware (no rear camera with a usable flash unit) on this device")]
    NoTorchHardware,

    /// A provider (real or mock) reported a backend failure (e.g. the camera is
    /// currently owned by another app, or `setTorchMode` threw).
    #[error("flashlight provider failure: {0}")]
    Provider(String),
}

/// Result alias used throughout the flashlight core.
pub type Result<T> = std::result::Result<T, FlashlightError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_constructible_and_displayable() {
        let no_torch = FlashlightError::NoTorchHardware;
        assert!(no_torch.to_string().contains("no torch hardware"));
        assert_eq!(no_torch, FlashlightError::NoTorchHardware);

        let provider = FlashlightError::Provider("camera in use".to_string());
        assert!(provider.to_string().contains("camera in use"));
        assert_eq!(
            provider,
            FlashlightError::Provider("camera in use".to_string())
        );
        assert_ne!(no_torch, provider);
    }
}
