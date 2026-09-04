//! Error type and result alias for the sensor domain core.

use crate::spec::{CameraId, SensorKind};
use thiserror::Error;

/// Errors surfaced by the sensor manager and its providers.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum SensorError {
    /// A requested continuous stream exceeds the hardware ceiling.
    #[error("{kind:?} stream of {requested_hz} Hz exceeds the hardware ceiling of {max_hz} Hz")]
    TooFast {
        kind: SensorKind,
        requested_hz: u32,
        max_hz: u32,
    },

    /// A requested continuous stream is gated by PowerSave mode.
    #[error("{kind:?} stream of {requested_hz} Hz exceeds the PowerSave ceiling of {max_hz} Hz")]
    PowerSaveRate {
        kind: SensorKind,
        requested_hz: u32,
        max_hz: u32,
    },

    /// No such physical camera on this device.
    #[error("no camera with id {0:?} on this device")]
    CameraNotFound(CameraId),

    /// The arguments to a call were internally inconsistent.
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),

    /// A provider (real or mock) reported a backend failure.
    #[error("sensor provider failure: {0}")]
    Provider(String),
}

/// Result alias used throughout the sensor core.
pub type Result<T> = std::result::Result<T, SensorError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_displayable_and_comparable() {
        let e = SensorError::PowerSaveRate {
            kind: SensorKind::Imu,
            requested_hz: 200,
            max_hz: 25,
        };
        let s = e.to_string();
        assert!(s.contains("imu") || s.contains("Imu"));
        assert!(s.contains("200"));
        assert_eq!(
            e,
            SensorError::PowerSaveRate {
                kind: SensorKind::Imu,
                requested_hz: 200,
                max_hz: 25,
            }
        );
        assert!(SensorError::CameraNotFound(CameraId::REAR)
            .to_string()
            .contains("no camera"));
    }
}
