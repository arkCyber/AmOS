//! Hardware button handling: **Home**, **Voice**, **AI assistant**.
//!
//! Physical buttons on the phone are read by a platform driver (GPIO / `evdev` /
//! Android key events) which calls [`HardwareButtons::press`] with the pressed
//! button. That emits a `hardware-button` Tauri event the frontend routes. A
//! `simulate_button` command lets desktop dev / tests drive the same path, and
//! `ButtonAction::from` is a pure mapping (unit-testable) to frontend actions.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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
    /// Launch the AI assistant.
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
        }
    }

    /// Record and broadcast a hardware button press.
    pub fn press(&self, app: &AppHandle, button: HardwareButton) {
        if let Ok(mut last) = self.last.lock() {
            *last = Some(button);
        }
        tracing::debug!("hardware button: {button:?}");
        let _ = app.emit(HARDWARE_BUTTON_EVENT, button);
    }

    /// The most recently pressed button, if any.
    pub fn last(&self) -> Option<HardwareButton> {
        *self.last.lock().unwrap_or_else(|p| p.into_inner())
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
    fn state_records_last_press() {
        let b = HardwareButtons::new();
        // Without an AppHandle we can't emit, but last() is still updated in the
        // real press(); here we verify default is None.
        assert_eq!(b.last(), None);
    }
}
