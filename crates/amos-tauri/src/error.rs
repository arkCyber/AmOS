//! `error.rs` — typed error envelope shared across the System UI Rust core.
//!
//! Every `#[tauri::command]` that can fail returns [`Result<T, AmosError>`].
//! The envelope is two pieces of information — a **stable code** the UI can
//! branch on, and a **human-readable message** the UI should not parse — plus
//! an optional cause chain so a watcher can see where the failure actually
//! originated without grepping the source.
//!
//! # Why a code AND a message
//!
//! The frontend i18n layer translates the *code* into the user's locale. The
//! *message* is a developer-facing diagnostic (logs, the error overlay) that
//! stays in English and may change without notice. Branching on the message —
//! a habit this crate's earlier code encouraged — made every rewording a wire
//! break; the code is the contract.

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(into = "&'static str")]
pub enum ErrorCode {
    ButtonsUnknown,
    ButtonsNameTooLong,
    ButtonsDeliveryFailed,
    DisplayContractMissing,
    DisplayWriteFailed,
    DisplayReadMalformed,
    FlashlightStoredShapeInvalid,
    FlashlightProviderUnconfirmed,
    NetGuardToggleFailed,
    NetGuardStatusFailed,
    SensorsUnknownMode,
    SensorsUnknownKind,
    SensorsRateOutOfRange,
    SensorsRpcFailed,
    TelemetrySpyWatchOpenFailed,
    TelemetrySpyStreamError,
    TelemetrySpyEmitFailed,
    // --- telephony (REQ-A268 follow-up: dialer / call state surface) ---
    /// Caller-supplied number exceeds [`telephony::MAX_TELEPHONY_DIAL_BYTES`].
    TelephonyNumberTooLong,
    /// Caller-supplied call id exceeds [`telephony::MAX_TELEPHONY_CALL_ID_BYTES`].
    TelephonyCallIdTooLong,
    /// Any telephony RPC failed (daemon unreachable / rejected).
    TelephonyRpcFailed,
    /// `spawn_telephony_watch` could not open the long-lived `Watch` stream.
    TelephonyWatchOpenFailed,
    /// A `Watch` event could not be read off the stream.
    TelephonyWatchStreamError,
    // --- radio / Bluetooth (REQ-A202/REQ-A203 carry-over: structured refusal) ---
    /// Caller asked for a radio key (`wifi` / `bluetooth` / …) the bridge does not know.
    RadioUnknownKey,
    /// The Bluetooth MAC address passed to `bluetooth_pair` is empty or too long.
    RadioAddressInvalid,
    /// Any radio / Bluetooth provider call failed (Mock refused; Android provider missing).
    RadioRpcFailed,
    /// `radio_open_settings` was asked for a switch this app owns — no system surface exists.
    RadioNoSystemSurface,
    // --- SMS (REQ-A268 follow-up: messaging surface) ---
    /// Caller passed blank `thread_id` / `message_id` / `address` to an SMS command.
    SmsBlankId,
    /// Caller passed a thread id / message id / address that is over the SMS-id size cap.
    SmsIdTooLong,
    /// Caller passed an unknown folder name (`inbox` | `sent` | `draft` only).
    SmsUnknownFolder,
    /// Caller asked for messages from a sender the blocklist has blocked for SMS.
    SmsBlockedSender,
    /// The `sms_send` text body exceeds [`sms::MAX_SMS_TEXT_BYTES`].
    SmsTextTooLong,
    /// SMS provider rejected the read / send (SmsError kind); the user-visible
    /// reason lives in `message` and the SmsError kind in `cause[0]`.
    SmsProviderRejected,
    // --- AI bridge / RAG (REQ-A268 follow-up: LLM surface) ---
    /// Caller passed a `prompt` / `context` string over the prompt byte cap.
    AiPromptTooLong,
    /// Caller passed a `session_id` over the session-id byte cap.
    AiSessionIdTooLong,
    /// Caller passed an `api_key` / `model` / `endpoint` string over its byte cap.
    AiBackendPayloadTooLong,
    /// Caller passed an Android `package_name` that is empty or over the cap.
    AiAndroidPackageInvalid,
    /// Any AI / Android-manager RPC failed (daemon unreachable / rejected).
    AiRpcFailed,
    /// `ai_backend_switch` could not invoke / complete the `ai-backend.sh` script.
    AiBackendSwitchFailed,
    /// A RAG id / text / query string is over its byte cap.
    RagPayloadTooLong,
    /// Any RAG RPC failed (notes-index unreachable / rejected).
    RagRpcFailed,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ButtonsUnknown => "amos.buttons.unknown",
            Self::ButtonsNameTooLong => "amos.buttons.name_too_long",
            Self::ButtonsDeliveryFailed => "amos.buttons.delivery_failed",
            Self::DisplayContractMissing => "amos.display.contract_missing",
            Self::DisplayWriteFailed => "amos.display.write_failed",
            Self::DisplayReadMalformed => "amos.display.read_malformed",
            Self::FlashlightStoredShapeInvalid => "amos.flashlight.stored_shape_invalid",
            Self::FlashlightProviderUnconfirmed => "amos.flashlight.provider_unconfirmed",
            Self::NetGuardToggleFailed => "amos.netguard.toggle_failed",
            Self::NetGuardStatusFailed => "amos.netguard.status_failed",
            Self::SensorsUnknownMode => "amos.sensors.unknown_mode",
            Self::SensorsUnknownKind => "amos.sensors.unknown_kind",
            Self::SensorsRateOutOfRange => "amos.sensors.rate_out_of_range",
            Self::SensorsRpcFailed => "amos.sensors.rpc_failed",
            Self::TelemetrySpyWatchOpenFailed => "amos.telemetry_spy.watch_open_failed",
            Self::TelemetrySpyStreamError => "amos.telemetry_spy.stream_error",
            Self::TelemetrySpyEmitFailed => "amos.telemetry_spy.emit_failed",
            Self::TelephonyNumberTooLong => "amos.telephony.number_too_long",
            Self::TelephonyCallIdTooLong => "amos.telephony.call_id_too_long",
            Self::TelephonyRpcFailed => "amos.telephony.rpc_failed",
            Self::TelephonyWatchOpenFailed => "amos.telephony.watch_open_failed",
            Self::TelephonyWatchStreamError => "amos.telephony.watch_stream_error",
            Self::RadioUnknownKey => "amos.radio.unknown_key",
            Self::RadioAddressInvalid => "amos.radio.address_invalid",
            Self::RadioRpcFailed => "amos.radio.rpc_failed",
            Self::RadioNoSystemSurface => "amos.radio.no_system_surface",
            Self::SmsBlankId => "amos.sms.blank_id",
            Self::SmsIdTooLong => "amos.sms.id_too_long",
            Self::SmsUnknownFolder => "amos.sms.unknown_folder",
            Self::SmsBlockedSender => "amos.sms.blocked_sender",
            Self::SmsTextTooLong => "amos.sms.text_too_long",
            Self::SmsProviderRejected => "amos.sms.provider_rejected",
            Self::AiPromptTooLong => "amos.ai.prompt_too_long",
            Self::AiSessionIdTooLong => "amos.ai.session_id_too_long",
            Self::AiBackendPayloadTooLong => "amos.ai.backend_payload_too_long",
            Self::AiAndroidPackageInvalid => "amos.ai.android_package_invalid",
            Self::AiRpcFailed => "amos.ai.rpc_failed",
            Self::AiBackendSwitchFailed => "amos.ai.backend_switch_failed",
            Self::RagPayloadTooLong => "amos.rag.payload_too_long",
            Self::RagRpcFailed => "amos.rag.rpc_failed",
        }
    }

    pub fn group(self) -> &'static str {
        let s = self.as_str();
        let after_prefix = match s.strip_prefix("amos.") {
            Some(rest) => rest,
            None => return s,
        };
        match after_prefix.find('.') {
            Some(end) => &after_prefix[..end],
            None => after_prefix,
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl From<ErrorCode> for &'static str {
    fn from(c: ErrorCode) -> &'static str {
        c.as_str()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AmosError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cause: Vec<String>,
}

impl AmosError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause: Vec::new(),
        }
    }

    pub fn with_cause(
        code: ErrorCode,
        message: impl Into<String>,
        cause: impl fmt::Display,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            cause: vec![cause.to_string()],
        }
    }

    pub fn push_cause(mut self, cause: impl fmt::Display) -> Self {
        self.cause.push(cause.to_string());
        self
    }

    pub fn code(&self) -> &'static str {
        self.code.as_str()
    }
}

impl fmt::Display for AmosError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        for c in &self.cause {
            write!(f, " (caused by: {c})")?;
        }
        Ok(())
    }
}

impl std::error::Error for AmosError {}

pub type AmosResult<T> = Result<T, AmosError>;

pub trait IntoAmosError {
    fn into_envelope(self, code: ErrorCode) -> AmosError;
}

impl<E: fmt::Display> IntoAmosError for E {
    fn into_envelope(self, code: ErrorCode) -> AmosError {
        AmosError::with_cause(code, code.as_str(), self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_distinct_stability_keys() {
        let codes = [
            ErrorCode::ButtonsUnknown,
            ErrorCode::ButtonsNameTooLong,
            ErrorCode::ButtonsDeliveryFailed,
            ErrorCode::DisplayContractMissing,
            ErrorCode::DisplayWriteFailed,
            ErrorCode::DisplayReadMalformed,
            ErrorCode::FlashlightStoredShapeInvalid,
            ErrorCode::FlashlightProviderUnconfirmed,
            ErrorCode::NetGuardToggleFailed,
            ErrorCode::NetGuardStatusFailed,
            ErrorCode::SensorsUnknownMode,
            ErrorCode::SensorsUnknownKind,
            ErrorCode::SensorsRateOutOfRange,
            ErrorCode::SensorsRpcFailed,
            ErrorCode::TelemetrySpyWatchOpenFailed,
            ErrorCode::TelemetrySpyStreamError,
            ErrorCode::TelemetrySpyEmitFailed,
            ErrorCode::TelephonyNumberTooLong,
            ErrorCode::TelephonyCallIdTooLong,
            ErrorCode::TelephonyRpcFailed,
            ErrorCode::TelephonyWatchOpenFailed,
            ErrorCode::TelephonyWatchStreamError,
            ErrorCode::RadioUnknownKey,
            ErrorCode::RadioAddressInvalid,
            ErrorCode::RadioRpcFailed,
            ErrorCode::RadioNoSystemSurface,
            ErrorCode::SmsBlankId,
            ErrorCode::SmsIdTooLong,
            ErrorCode::SmsUnknownFolder,
            ErrorCode::SmsBlockedSender,
            ErrorCode::SmsTextTooLong,
            ErrorCode::SmsProviderRejected,
            ErrorCode::AiPromptTooLong,
            ErrorCode::AiSessionIdTooLong,
            ErrorCode::AiBackendPayloadTooLong,
            ErrorCode::AiAndroidPackageInvalid,
            ErrorCode::AiRpcFailed,
            ErrorCode::AiBackendSwitchFailed,
            ErrorCode::RagPayloadTooLong,
            ErrorCode::RagRpcFailed,
        ];
        let mut seen = std::collections::HashSet::new();
        for c in codes {
            let s = c.as_str();
            assert!(seen.insert(s), "duplicate code string: {s}");
            assert!(s.starts_with("amos."), "code must be namespaced: {s}");
        }
    }

    #[test]
    fn group_is_the_module_after_the_amos_prefix() {
        assert_eq!(ErrorCode::ButtonsUnknown.group(), "buttons");
        assert_eq!(ErrorCode::NetGuardToggleFailed.group(), "netguard");
        assert_eq!(ErrorCode::SensorsUnknownMode.group(), "sensors");
        assert_eq!(ErrorCode::DisplayContractMissing.group(), "display");
        assert_eq!(ErrorCode::TelemetrySpyEmitFailed.group(), "telemetry_spy");
        assert_eq!(
            ErrorCode::FlashlightStoredShapeInvalid.group(),
            "flashlight"
        );
        // The follow-up groups added when migrating telephony / sms / radio /
        // ai / rag to typed envelopes: each module's variants must collapse to
        // the same group so a single tracing filter scopes the whole surface.
        assert_eq!(ErrorCode::TelephonyRpcFailed.group(), "telephony");
        assert_eq!(ErrorCode::RadioRpcFailed.group(), "radio");
        assert_eq!(ErrorCode::SmsProviderRejected.group(), "sms");
        assert_eq!(ErrorCode::AiRpcFailed.group(), "ai");
        assert_eq!(ErrorCode::RagRpcFailed.group(), "rag");
    }

    #[test]
    fn envelope_serialises_with_code_and_message() {
        let e = AmosError::new(ErrorCode::ButtonsUnknown, "boop");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "amos.buttons.unknown");
        assert_eq!(v["message"], "boop");
        assert!(v.get("cause").is_none(), "no cause field on empty chain");
    }

    #[test]
    fn envelope_serialises_the_cause_chain_when_present() {
        let e = AmosError::with_cause(ErrorCode::NetGuardStatusFailed, "status", "daemon down");
        let e = e.push_cause("socket closed");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "amos.netguard.status_failed");
        assert_eq!(v["cause"][0], "daemon down");
        assert_eq!(v["cause"][1], "socket closed");
    }

    #[test]
    fn into_envelope_preserves_the_underlying_message() {
        let e: AmosError = "rpc failed".into_envelope(ErrorCode::NetGuardToggleFailed);
        assert_eq!(e.code(), "amos.netguard.toggle_failed");
        assert_eq!(e.message, "amos.netguard.toggle_failed");
        assert_eq!(e.cause, vec!["rpc failed".to_string()]);
    }
}
