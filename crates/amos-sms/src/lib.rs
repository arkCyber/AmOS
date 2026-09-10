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
pub mod provider;
pub mod spec;
pub mod wire;

pub use error::SmsError;
pub use provider::{MockSms, SmsProvider};
pub use spec::{SmsMessage, SmsThread};
