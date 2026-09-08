//! Small no-panic error type for the telemetry-spy domain core.
//!
//! Dependency-free (no `thiserror`) so the crate's default build stays pure
//! `std`. Variants model the honest states this crate can be in: a live-capture
//! path that needs a real device / root, a bad caller input, an interface that
//! does not exist, or a real I/O failure from the capture backend.

use std::fmt;

/// Errors produced by the telemetry-spy domain core and its capture backend.
#[derive(Debug)]
pub enum Error {
    /// The requested path needs something the host / this build does not have
    /// (a raw-socket capture slot on a rooted / AmOS-AOSP device). Always fails
    /// **explicitly**; never silently degrades to a fake success.
    NotOnDevice(&'static str),
    /// The named network interface could not be found.
    InterfaceNotFound(String),
    /// A frame / packet could not be decoded (unsupported link type etc.).
    Unsupported(String),
    /// The caller supplied something invalid.
    InvalidArgument(String),
    /// An underlying I/O failure from the capture backend.
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotOnDevice(msg) => write!(f, "not on device (not wired): {msg}"),
            Error::InterfaceNotFound(name) => write!(f, "interface not found: {name}"),
            Error::Unsupported(msg) => write!(f, "unsupported packet/link: {msg}"),
            Error::InvalidArgument(msg) => write!(f, "invalid argument: {msg}"),
            Error::Io(e) => write!(f, "capture backend I/O error: {e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            Error::NotOnDevice(_)
            | Error::InterfaceNotFound(_)
            | Error::Unsupported(_)
            | Error::InvalidArgument(_) => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

/// Convenient alias used across the crate.
pub type Result<T> = std::result::Result<T, Error>;
