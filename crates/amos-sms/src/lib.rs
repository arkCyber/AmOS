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
pub mod redact;
pub mod spec;
pub mod trash;
pub mod validate;
pub mod wire;

#[cfg(feature = "android")]
pub mod android;

pub use error::SmsError;
pub use folder::{SmsFolder, SmsFolderCounts};
pub use provider::{MockSms, SmsProvider, MOCK_PROVIDER};
// Balance redaction on the display path (REQ-A41): domain-level so every
// consumer (Tauri bridge, tests, future surfaces) inherits the same policy.
pub use redact::{is_bank_sender, redact_balances, redact_for, REDACTION};
// View-layer trash (REQ-A42): hide + restore, ids only — the platform store is
// owned by the default SMS app and is never written by AmOS.
pub use spec::{SmsMessage, SmsThread};
pub use trash::{filter_messages, PreviewOverride, SmsTrash, TrashEntry, DEFAULT_TRASH_CAP};
pub use validate::{normalize_address, segment_count, validate_text};

#[cfg(feature = "android")]
pub use android::AndroidSmsProvider;
