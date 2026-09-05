//! Error type and result alias for the Web3 digital-signature core.

use thiserror::Error;

/// Errors surfaced by the Web3 core.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum Error {
    /// A 32-byte seed could not be turned into a valid secp256k1 secret scalar.
    /// This is effectively impossible after deterministic RFC6979 rejection
    /// sampling, but is still surfaced rather than masked.
    #[error("seed did not yield a valid secp256k1 secret scalar")]
    InvalidSecret,

    /// Bytes handed in as a public key were not a valid secp256k1 point.
    #[error("invalid secp256k1 public key encoding")]
    InvalidPublicKey,

    /// Bytes handed in as a signature were not a valid ECDSA signature.
    #[error("invalid ECDSA signature encoding")]
    InvalidSignature,

    /// A hex string could not be decoded for the expected length.
    #[error("invalid hex: {0}")]
    Hex(String),

    /// A structured (EIP-712) value was malformed / of an unsupported shape.
    #[error("EIP-712: {0}")]
    TypedData(String),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;
