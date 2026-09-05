//! Error type and result alias for the identity / DID core.

use thiserror::Error;

/// Errors surfaced by the identity core.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum Error {
    /// A string was not a well-formed `did:key:…`.
    #[error("invalid did:key: {0}")]
    InvalidDid(String),

    /// An unsupported / unknown key curve was requested.
    #[error("unsupported curve")]
    UnsupportedCurve,

    /// A base58btc / multibase payload could not be decoded.
    #[error("invalid base58btc payload: {0}")]
    Decode(String),

    /// A key seed was not a valid secret scalar / key material.
    #[error("invalid key seed")]
    InvalidSeed,

    /// The keystore failed (bad passphrase, ciphertext tampering, …).
    #[error("keystore: {0}")]
    Keystore(String),

    /// A failure surfaced from the underlying `amos-web3` core.
    #[error("web3: {0}")]
    Web3(String),
}

impl From<amos_web3::error::Error> for Error {
    fn from(e: amos_web3::error::Error) -> Self {
        Error::Web3(e.to_string())
    }
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;
