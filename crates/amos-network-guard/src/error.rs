//! Small no-panic error type for the egress guard domain core.
//!
//! Kept dependency-free (no `thiserror`) so the crate's default build stays pure
//! `std`. Variants model the honest states this crate can actually be in: a path
//! that still needs a real device / root, bad caller input, or a real I/O failure
//! from a backend.

use std::fmt;

/// Errors produced by the guard domain core and its backends.
#[derive(Debug)]
pub enum Error {
    /// The requested path is reserved but not yet wired, and needs something the
    /// host/this build does not have (a running `VpnService` Context, root, an
    /// AOSP system-component slot). Always fails **explicitly**, never silently
    /// degrades to a fake success.
    NotOnDevice(&'static str),
    /// A rule could not be applied because the caller supplied something invalid.
    InvalidArgument(String),
    /// An underlying I/O failure from an egress backend.
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotOnDevice(msg) => write!(f, "not on device (not wired): {msg}"),
            Error::InvalidArgument(msg) => write!(f, "invalid argument: {msg}"),
            Error::Io(e) => write!(f, "egress backend I/O error: {e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            Error::NotOnDevice(_) | Error::InvalidArgument(_) => None,
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
