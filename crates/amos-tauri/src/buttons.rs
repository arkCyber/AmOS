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
    pub fn from_name(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "home" => Some(Self::Home),
            "voice" => Some(Self::Voice),
            "ai" | "ai_assistant" | "assistant" | "aibutton" => Some(Self::AiAssistant),
            _ => None,
        }
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
        let _ = app.emit(HARDWARE_BUTTON_EVENT, button);
        dispatch_dom(app, button);
    }

    /// The most recently pressed button, if any.
    pub fn last(&self) -> Option<HardwareButton> {
        *self.last.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Take (and clear) the pending action if any — one press = one pull.
    pub fn take_pending(&self) -> Option<HardwareButton> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

/// Tauri command: pull an un-consumed hardware-button action. This is the reliable
/// on-device delivery path: a plain `invoke` (which every other feature uses and
/// which demonstrably works) returns the pending action string and clears it, so the
/// shell does not depend on the Rust→JS event system / `eval` reaching the webview
/// on mobile. The shell polls this on a short interval (see `osInputBridge`).
#[tauri::command]
pub fn take_pending_hardware_button(
    state: State<'_, HardwareButtons>,
) -> Option<String> {
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
    for w in app.webview_windows().values() {
        let _ = w.eval(&js);
    }
}

/// Tauri command: simulate a hardware button press (desktop dev / tests).
#[tauri::command]
pub fn simulate_button(
    app: AppHandle,
    state: State<'_, HardwareButtons>,
    button: String,
) -> Result<(), String> {
    let b =
        HardwareButton::from_name(&button).ok_or_else(|| format!("unknown button: {button}"))?;
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
        assert_eq!(serde_json::to_value(HardwareButton::Voice).unwrap(), "voice");
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
}
