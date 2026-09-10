//! amos-sms — real SMS domain core (offline, host-testable).
//!
//! Mirrors the repo's domain-core + Provider-seam pattern (cf. amos-flashlight /
//! amos-telephony): this crate owns the *types + honest seam*, never the device.
//! A future real backend (Android `SmsGlue`, reading `content://sms` and sending
//! via `SmsManager`) plugs in behind [`SmsProvider`]; the host uses the
//! deterministic [`MockSms`]. `src/wire.rs` is the stable JSON contract that
//! (Kotlin) glue and the UI share, kept pure + tested here.
//!
//! Real SMS read/send is **device + permission dependent** (READ_SMS /
//! SEND_SMS). This crate validates every shape without faking a message.

pub mod error;
pub mod folder;
pub mod provider;
pub mod spec;
pub mod validate;
pub mod wire;

#[cfg(feature = "android")]
pub mod android;

pub use error::SmsError;
pub use folder::{SmsFolder, SmsFolderCounts};
pub use provider::{MockSms, SmsProvider, MOCK_PROVIDER};
pub use spec::{SmsMessage, SmsThread};
pub use validate::{normalize_address, segment_count, validate_text};

#[cfg(feature = "android")]
pub use android::AndroidSmsProvider;
