//! The single error type surfaced by `amos-audio`'s traits and resamplers.

use std::fmt;

/// Errors returned by audio capture / playback and the resampling helpers.
#[derive(Debug, Clone)]
pub enum AudioError {
    /// A device-rate we cannot honour (e.g. an unsupported resample ratio).
    UnsupportedFormat(String),
    /// The underlying OS / HAL / FFI call failed (open, read, write, close).
    Device(String),
    /// The caller passed inconsistent arguments (bad spec, misaligned buffer).
    InvalidArguments(String),
    /// The stream is at end-of-input (only meaningful for finite sources).
    EndOfStream,
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AudioError::UnsupportedFormat(m) => write!(f, "unsupported audio format: {m}"),
            AudioError::Device(m) => write!(f, "audio device error: {m}"),
            AudioError::InvalidArguments(m) => write!(f, "invalid arguments: {m}"),
            AudioError::EndOfStream => write!(f, "end of audio stream"),
        }
    }
}

impl std::error::Error for AudioError {}

/// Convenience constructor for an underlying OS/device error (from an errno or
/// an FFI status code), used by the platform seams.
pub fn device_err(context: &str, code: i32) -> AudioError {
    AudioError::Device(format!("{context} (errno/status {code})"))
}
