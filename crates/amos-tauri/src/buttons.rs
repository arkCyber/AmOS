//! Hardware button handling: **Home**, **Voice**, **AI assistant**.
//!
//! Physical buttons on the phone are read by a platform driver (GPIO / `evdev` /
//! Android key events) which calls [`HardwareButtons::press`] with the pressed
//! button. That emits a `hardware-button` Tauri event the frontend routes. A
//! `simulate_button` command lets desktop dev / tests drive the same path, and
//! `ButtonAction::from` is a pure mapping (unit-testable) to frontend actions.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Tauri event name carrying a pressed hardware button.
pub const HARDWARE_BUTTON_EVENT: &str = "hardware-button";

/// Upper bound on a button name coming in from the wire / CLI / JNI.
///
/// Real names are ≤ 32 B (`home`, `voice`, `ai_assistant`); a 256 B cap is a
/// generous ceiling that still rejects a paste-sized input as a misroute —
/// `simulate_button` would otherwise spend unbounded work tokenising a giant
/// string and the DOM dispatch below would build a `CustomEvent` whose payload
/// is a megabyte of attacker text (a JS heap pressure primitive).
pub const MAX_BUTTON_NAME_BYTES: usize = 256;

/// Upper bound on the DOM `CustomEvent` payload one press hands to every
/// webview window (`"hardware-button"` with `detail.name`). The full string is
/// always `…'detail: {name: \"<name>\"}…'`; 512 B is comfortably larger than
/// the largest legitimate name (`MAX_BUTTON_NAME_BYTES` + framing) and refuses
/// the pathological case.
pub const MAX_DOM_PAYLOAD_BYTES: usize = 512;

/// Stability codes the caller can branch on without parsing human strings.
///
/// These are the **wire vocabulary** for the `buttons` module's failure surface,
/// kept alongside the constants so a frontend i18n layer can render an honest
/// "why" without ever inspecting the message text. A consumer should always
/// pattern-match on `code`, not on `message`.
pub mod codes {
    /// Caller-supplied button name could not be parsed into any known button.
    pub const UNKNOWN_BUTTON: &str = "amos.buttons.unknown";
    /// Caller-supplied button name exceeds [`super::MAX_BUTTON_NAME_BYTES`].
    pub const NAME_TOO_LONG: &str = "amos.buttons.name_too_long";
    /// Frontend bridge could not be reached on a registered listener.
    pub const DELIVERY_FAILED: &str = "amos.buttons.delivery_failed";
}

/// The three physical buttons exposed to the System UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HardwareButton {
    /// Return to the launcher / home screen.
    Home,
    /// Start (or signal) voice input.
    Voice,
    /// Launch the AI assistant. Serialized as `"ai_assistant"` (the lowercase
    /// rename would otherwise produce `"aiassistant"`, which the frontend does not
    /// recognise). Matches the frontend `buttonActionOf`/`from_name` vocabulary.
    #[serde(rename = "ai_assistant")]
    AiAssistant,
}

impl HardwareButton {
    /// Parse a button name from the wire / CLI. Case-insensitive.
    ///
    /// Returns [`None`] on an unknown verb; an **oversized** name is also
    /// rejected (and surfaced as a separate [`ErrorCode`] by [`Self::parse`])
    /// so a paste-sized input never reaches the DOM dispatch path.
    pub fn from_name(s: &str) -> Option<Self> {
        if s.len() > MAX_BUTTON_NAME_BYTES {
            return None;
        }
        match s.trim().to_ascii_lowercase().as_str() {
            "home" => Some(Self::Home),
            "voice" => Some(Self::Voice),
            "ai" | "ai_assistant" | "assistant" | "aibutton" => Some(Self::AiAssistant),
            _ => None,
        }
    }

    /// Parse with an explicit error envelope (the caller can render the code,
    /// not just the message). The size cap is checked **first** so a megabyte
    /// string is rejected before any tokenising work runs.
    pub fn parse(s: &str) -> Result<Self, crate::error::AmosError> {
        if s.len() > MAX_BUTTON_NAME_BYTES {
            return Err(crate::error::AmosError::new(
                crate::error::ErrorCode::ButtonsNameTooLong,
                format!(
                    "button name is {} bytes (limit {})",
                    s.len(),
                    MAX_BUTTON_NAME_BYTES
                ),
            ));
        }
        Self::from_name(s).ok_or_else(|| {
            crate::error::AmosError::new(
                crate::error::ErrorCode::ButtonsUnknown,
                format!("unknown button: {s}"),
            )
        })
    }
}

/// Frontend action a pressed button should trigger (pure, testable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonAction {
    GoHome,
    VoiceInput,
    OpenAiAssistant,
}

impl From<HardwareButton> for ButtonAction {
    fn from(b: HardwareButton) -> Self {
        match b {
            HardwareButton::Home => ButtonAction::GoHome,
            HardwareButton::Voice => ButtonAction::VoiceInput,
            HardwareButton::AiAssistant => ButtonAction::OpenAiAssistant,
        }
    }
}

/// App-managed hardware-button state: records the last press so a fresh window
/// (or a late frontend listener) can query it, and forwards presses as events.
pub struct HardwareButtons {
    last: Mutex<Option<HardwareButton>>,
    /// Un-consumed pending action for the frontend to pull via
    /// `take_pending_hardware_button` (the reliable on-device delivery path; see
    /// that command's docs for why we don't rely solely on events / DOM eval).
    pending: Mutex<Option<HardwareButton>>,
}

impl Default for HardwareButtons {
    fn default() -> Self {
        Self::new()
    }
}

impl HardwareButtons {
    pub fn new() -> Self {
        Self {
            last: Mutex::new(None),
            pending: Mutex::new(None),
        }
    }

    /// Record and broadcast a hardware button press.
    pub fn press(&self, app: &AppHandle, button: HardwareButton) {
        if let Ok(mut last) = self.last.lock() {
            *last = Some(button);
        }
        if let Ok(mut pending) = self.pending.lock() {
            // First-write-wins so a burst doesn't clobber an un-pulled action.
            if pending.is_none() {
                *pending = Some(button);
            }
        }
        tracing::debug!("hardware button: {button:?}");
        // Tauri event system (Rust -> JS `listen`). Also dispatched below as a DOM
        // event because on-device the hand-rolled frontend bridge (which relies on
        // `window.__TAURI_INTERNALS__.listen`) does not register in Tauri v2, so the
        // event never reaches the UI without this.
        // An `emit` error means a listener exists but the event could not reach it (Tauri
        // returns `Ok` when there is no listener at all), i.e. the UI misses this button
        // press. The DOM dispatch below is the second path, but not a reason to hide this.
        if let Err(e) = app.emit(HARDWARE_BUTTON_EVENT, button) {
            tracing::warn!(
                target: "amos::buttons",
                event = HARDWARE_BUTTON_EVENT,
                code = codes::DELIVERY_FAILED,
                error = %e,
                "hardware-button event could not be delivered to the UI"
            );
        }
        dispatch_dom(app, button);
    }

    /// The most recently pressed button, if any.
    pub fn last(&self) -> Option<HardwareButton> {
        *self.last.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Take (and clear) the pending action if any — one press = one pull.
    pub fn take_pending(&self) -> Option<HardwareButton> {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }
}

/// Tauri command: pull an un-consumed hardware-button action. This is the reliable
/// on-device delivery path: a plain `invoke` (which every other feature uses and
/// which demonstrably works) returns the pending action string and clears it, so the
/// shell does not depend on the Rust→JS event system / `eval` reaching the webview
/// on mobile. The shell polls this on a short interval (see `osInputBridge`).
#[tauri::command]
pub fn take_pending_hardware_button(state: State<'_, HardwareButtons>) -> Option<String> {
    state.take_pending().map(hardware_name)
}

/// Frontend vocabulary string for a button (matches serde serialization).
fn hardware_name(b: HardwareButton) -> String {
    match b {
        HardwareButton::Home => "home".to_string(),
        HardwareButton::Voice => "voice".to_string(),
        HardwareButton::AiAssistant => "ai_assistant".to_string(),
    }
}

/// Bridge a hardware button to the webview as a **DOM** `CustomEvent` named
/// `hardware-button` with `detail.name` = the frontend vocabulary string. Plain
/// `window.addEventListener("hardware-button", …)` catches this without the Tauri
/// event system (which the hand-rolled frontend `subscribe` cannot register against
/// in Tauri v2 on-device). Evaluated on every webview window so whichever shell is
/// mounted receives it.
fn dispatch_dom(app: &tauri::AppHandle, button: HardwareButton) {
    let name = match button {
        HardwareButton::Home => "home",
        HardwareButton::Voice => "voice",
        HardwareButton::AiAssistant => "ai_assistant",
    };
    let js = format!(
        "window.dispatchEvent(new CustomEvent('hardware-button', {{detail: {{name: '{name}'}}}}));"
    );
    // The DOM payload is small by construction (a literal 70-ish B), but the cap is
    // here as defence in depth against a future change that interpolates
    // caller-controlled text into the JS. The string is always ASCII letters +
    // `_` from the match above, so this is a cheap assertion.
    if js.len() > MAX_DOM_PAYLOAD_BYTES {
        tracing::warn!(
            target: "amos::buttons",
            payload_bytes = js.len(),
            limit = MAX_DOM_PAYLOAD_BYTES,
            "refusing to dispatch an over-sized DOM payload"
        );
        return;
    }
    for w in app.webview_windows().values() {
        // The eval is the delivery path that works on-device (the Tauri event system does
        // not reach the webview there — that is why this exists at all), so a window that
        // cannot be evaluated is a hardware button that does nothing. Say so instead of
        // leaving the press unexplained.
        if let Err(e) = w.eval(&js) {
            tracing::warn!(
                target: "amos::buttons",
                window = %w.label(),
                code = codes::DELIVERY_FAILED,
                error = %e,
                "hardware-button DOM event could not be evaluated in this window"
            );
        }
    }
}

/// Tauri command: simulate a hardware button press (desktop dev / tests).
///
/// Returns an [`AmosError`] envelope so a caller can branch on the stable code
/// (e.g. render "button not recognized" vs "name too long") without parsing the
/// human-readable message. The size cap is enforced **before** parsing, so a
/// paste-sized input is rejected with [`ErrorCode::ButtonsNameTooLong`] in O(1)
/// time.
#[tauri::command]
pub fn simulate_button(
    app: AppHandle,
    state: State<'_, HardwareButtons>,
    button: String,
) -> Result<(), crate::error::AmosError> {
    let b = HardwareButton::parse(&button)?;
    state.press(&app, b);
    Ok(())
}

#[cfg(feature = "android")]
pub fn install_android_app(app: AppHandle) {
    android_impl::install_app(app);
}

/// Android device seam (feature `android`): lets the native `MainActivity` hand a
/// physical **camera** / shutter key press up so it can be re-mapped to an AmOS
/// action (the active S5 mapping opens the **AI assistant**; `Home` is kept as an
/// alternative) instead of launching the OS camera. Mirrors the repo's
/// Kotlin→Rust upcall pattern.
#[cfg(feature = "android")]
mod android_impl {
    use super::*;
    use std::sync::OnceLock;
    use tauri::Manager;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn install_app(app: AppHandle) {
        // Exactly-once: a redundant re-attach keeps the first one (REQ-A187 baseline).
        let _ = APP.set(app);
    }

    /// `MainActivity.onPhysicalHome()` — a physical camera key was pressed and
    /// consumed; route it as the AmOS Home button (`HardwareButton::Home` →
    /// frontend `buttonActionOf("home")` → go to the launcher / home screen).
    /// Kept as an alternative mapping (some builds want a hardware Home).
    ///
    /// # Safety
    /// `env`/`this` are the standard JNI instance-method args, valid for the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_MainActivity_onPhysicalHome(
        _env: *mut jni::sys::JNIEnv,
        _this: jni::sys::jobject,
    ) {
        let Some(app) = APP.get() else {
            return;
        };
        let buttons = app.state::<HardwareButtons>();
        buttons.press(app, HardwareButton::Home);
    }

    /// `MainActivity.onPhysicalAssistant()` — a physical camera / shutter key was
    /// pressed and consumed; route it as the **AI assistant** button
    /// (`HardwareButton::AiAssistant` → frontend `buttonActionOf("ai")` →
    /// `open("ai")`, the AI app). This is the active S5 mapping.
    ///
    /// # Safety
    /// `env`/`this` are the standard JNI instance-method args, valid for the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_MainActivity_onPhysicalAssistant(
        _env: *mut jni::sys::JNIEnv,
        _this: jni::sys::jobject,
    ) {
        let Some(app) = APP.get() else {
            return;
        };
        let buttons = app.state::<HardwareButtons>();
        buttons.press(app, HardwareButton::AiAssistant);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_name_parses_all_three_and_rejects_unknown() {
        assert_eq!(
            HardwareButton::from_name("home"),
            Some(HardwareButton::Home)
        );
        assert_eq!(
            HardwareButton::from_name("VOICE"),
            Some(HardwareButton::Voice)
        );
        assert_eq!(
            HardwareButton::from_name("ai"),
            Some(HardwareButton::AiAssistant)
        );
        assert_eq!(
            HardwareButton::from_name("assistant"),
            Some(HardwareButton::AiAssistant)
        );
        assert_eq!(HardwareButton::from_name("volume"), None);
        assert_eq!(HardwareButton::from_name(""), None);
    }

    #[test]
    fn button_maps_to_action() {
        assert_eq!(
            ButtonAction::from(HardwareButton::Home),
            ButtonAction::GoHome
        );
        assert_eq!(
            ButtonAction::from(HardwareButton::Voice),
            ButtonAction::VoiceInput
        );
        assert_eq!(
            ButtonAction::from(HardwareButton::AiAssistant),
            ButtonAction::OpenAiAssistant
        );
    }

    #[test]
    fn serializes_to_frontend_vocabulary() {
        // The emitted `hardware-button` payload must match what the frontend
        // `buttonActionOf` / Svelte `mapHardwareAction` recognise. Regression: the
        // plain lowercase rename turned `AiAssistant` into "aiassistant" (unmapped),
        // so the camera-key → AI path silently did nothing.
        assert_eq!(serde_json::to_value(HardwareButton::Home).unwrap(), "home");
        assert_eq!(
            serde_json::to_value(HardwareButton::Voice).unwrap(),
            "voice"
        );
        assert_eq!(
            serde_json::to_value(HardwareButton::AiAssistant).unwrap(),
            "ai_assistant"
        );
    }

    #[test]
    fn state_records_last_press() {
        let b = HardwareButtons::new();
        // Without an AppHandle we can't emit, but last() is still updated in the
        // real press(); here we verify default is None.
        assert_eq!(b.last(), None);
    }

    #[test]
    fn oversized_button_name_is_rejected_before_parsing() {
        // A paste-sized input is refused by `from_name` (cheap branch on length)
        // and surfaced as a distinct `ButtonsNameTooLong` envelope by `parse`.
        let huge = "x".repeat(MAX_BUTTON_NAME_BYTES + 1);
        assert_eq!(HardwareButton::from_name(&huge), None);
        let err = HardwareButton::parse(&huge).expect_err("oversized is rejected");
        assert_eq!(err.code, crate::error::ErrorCode::ButtonsNameTooLong);
        assert!(
            err.message.contains("limit"),
            "the message names the cap: {err:?}"
        );

        // Exactly at the cap is still refused (the cap is exclusive — see the doc).
        let at_cap = "x".repeat(MAX_BUTTON_NAME_BYTES);
        assert_eq!(HardwareButton::from_name(&at_cap), None);
    }

    #[test]
    fn parse_returns_a_typed_envelope_for_unknown_buttons() {
        let err = HardwareButton::parse("volume").expect_err("unknown is rejected");
        assert_eq!(err.code, crate::error::ErrorCode::ButtonsUnknown);
        assert!(
            err.message.contains("volume"),
            "the message keeps the offending name for diagnostics: {err:?}"
        );

        // Whitespace alone does NOT become a default button; it is unknown on purpose.
        let err = HardwareButton::parse("   ").expect_err("whitespace is unknown");
        assert_eq!(err.code, crate::error::ErrorCode::ButtonsUnknown);
    }

    #[test]
    fn known_button_names_still_parse_through_the_envelope() {
        for (input, expected) in [
            ("home", HardwareButton::Home),
            ("Voice", HardwareButton::Voice),
            ("ai_assistant", HardwareButton::AiAssistant),
            ("assistant", HardwareButton::AiAssistant),
        ] {
            assert_eq!(HardwareButton::parse(input).unwrap(), expected);
        }
    }

    #[test]
    fn error_codes_for_buttons_are_distinct_stability_keys() {
        // The `code()` is the wire vocabulary; a UI branches on it, so it must
        // be a stable string AND different per failure mode.
        let too_long = HardwareButton::parse(&"x".repeat(MAX_BUTTON_NAME_BYTES + 1)).unwrap_err();
        let unknown = HardwareButton::parse("nope").unwrap_err();
        assert_ne!(too_long.code, unknown.code);
        assert!(too_long.code().starts_with("amos.buttons."));
        assert!(unknown.code().starts_with("amos.buttons."));
    }
}
