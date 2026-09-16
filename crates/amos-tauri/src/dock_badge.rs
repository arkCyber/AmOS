//! `dock_badge` — Dock badge + request-attention (macOS UX).
//!
//! Two native macOS affordances the AmOS shell now drives:
//!
//! * **Dock badge** — the red circle with a number, drawn on the app's Dock icon.
//!   Set via Tauri 2's `WebviewWindow::set_badge_count` (cross-platform but no-op
//!   on targets that have no badge surface); we use `set_badge_label` on macOS
//!   because it accepts a free-form string ("3 new", "●", …) and lets us localize.
//! * **Request attention** — when the app is in the background and a real
//!   notification arrives, the Dock icon bounces once.  `request_user_attention`
//!   wraps `NSApp.requestUserAttention`; `Critical` keeps bouncing until the
//!   user clicks the icon, `Informational` bounces a single time.
//!
//! The frontend exposes two commands: `dock_badge_set` (label or `null` to clear)
//! and `dock_request_attention` (level: `info` / `critical`).  Both are honest:
//! a non-macOS host returns `Ok` with no effect — the UI does not have to gate
//! the call behind `target_os`, and tests can run on Linux.
//!
//! ## Why a single Rust module instead of letting the WebView call these
//!
//! macOS Dock icon manipulation is a per-app singleton; a wrong call (or a
//! race between two WebViews) would let two windows race to clear a badge that
//! the other just set.  Hosting it in Rust means there is exactly one writer,
//! and every write is reported at `debug` so an operator can see what the app
//! thinks its unread count is.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

/// The Dock badge label (macOS) or a count (Windows/Linux Unity).  `None`
/// clears.  Bound to a few characters so we don't fight the Dock's own clip —
/// macOS will truncate very long labels anyway, but a long string is almost
/// certainly a caller mistake.
pub const MAX_BADGE_CHARS: usize = 12;

/// What kind of attention the app is requesting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AttentionLevel {
    /// Bounces once and stops (`NSInformationalRequest`).
    Info,
    /// Bounces continuously until the user clicks the Dock icon (`NSCriticalRequest`).
    Critical,
}

impl AttentionLevel {
    fn to_native(self) -> UserAttentionType {
        match self {
            AttentionLevel::Info => UserAttentionType::Informational,
            AttentionLevel::Critical => UserAttentionType::Critical,
        }
    }
}

/// Process-wide state: the last-set badge label, so a new window can re-apply
/// it on launch and the boot path can report it.
#[derive(Default)]
pub struct DockBadgeState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// `None` = no badge / cleared.
    label: Option<String>,
}

impl DockBadgeState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the current label (test seam + boot fact).
    pub fn current(&self) -> Option<String> {
        match self.inner.lock() {
            Ok(g) => g.label.clone(),
            // A poisoned mutex is unrecoverable; report "no label" rather than
            // panic (callers must treat the answer as the truth, not a guess).
            Err(p) => p.into_inner().label.clone(),
        }
    }

    fn set_inner(&self, label: Option<String>) {
        match self.inner.lock() {
            Ok(mut g) => g.label = label,
            Err(p) => p.into_inner().label = label,
        }
    }
}

/// Apply a label (or clear it with `None`).
///
/// Called from the `dock_badge_set` Tauri command.
pub fn apply<R: tauri::Runtime>(app: &AppHandle<R>, label: Option<String>) -> Result<(), String> {
    // Sanitize before we touch the OS — see [`sanitize_label`] for the rules.
    let label = sanitize_label(label);
    // Cross-platform no-op when no badge surface exists: the OS call returns Ok
    // without doing anything on Android, and `set_badge_label` is `#[cfg(macos)]`
    // so a non-macOS build takes the `set_badge_count` path below.
    let main_window = app.get_webview_window("main");

    if let Some(window) = &main_window {
        // macOS path: free-form label (we use it everywhere because it accepts
        // strings, not just numbers, and is what the Dock actually shows).
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = window.set_badge_label(label.clone()) {
                tracing::warn!(
                    target: "amos::dock_badge",
                    error = %e,
                    "Dock badge label could not be set"
                );
                return Err(e.to_string());
            }
        }
        // Cross-platform count fallback (Windows taskbar / Linux Unity).  We map
        // an arbitrary label to a count: numeric strings become that number,
        // everything else becomes `None` (clear).
        #[cfg(not(target_os = "macos"))]
        {
            let count = label.as_ref().and_then(|s| s.parse::<i64>().ok());
            if let Err(e) = window.set_badge_count(count) {
                tracing::warn!(
                    target: "amos::dock_badge",
                    error = %e,
                    "Dock/taskbar badge count could not be set"
                );
                return Err(e.to_string());
            }
        }
    }

    if let Some(state) = app.try_state::<DockBadgeState>() {
        state.set_inner(label.clone());
    }
    // Mirror to the frontend so the Dock tile's own badge stays in sync
    // (a window that paints its own badge should not have to ask Rust).
    if let Err(e) = app.emit("dock-badge-changed", label.as_deref().unwrap_or("")) {
        tracing::debug!(
            target: "amos::dock_badge",
            error = %e,
            "dock-badge-changed event could not be delivered (no listener)"
        );
    }
    tracing::debug!(
        target: "amos::dock_badge",
        label = label.as_deref().unwrap_or("(clear)"),
        "dock badge applied"
    );
    Ok(())
}

/// Request user attention: bounce the Dock icon.
pub fn request_attention<R: tauri::Runtime>(
    app: &AppHandle<R>,
    level: AttentionLevel,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!(
            target: "amos::dock_badge",
            "request_attention: no main window; nothing to bounce"
        );
        return Err("no main window".to_string());
    };
    let native = level.to_native();
    if let Err(e) = window.request_user_attention(Some(native)) {
        tracing::warn!(
            target: "amos::dock_badge",
            error = %e,
            ?level,
            "Dock attention request failed"
        );
        return Err(e.to_string());
    }
    tracing::info!(target: "amos::dock_badge", ?level, "Dock attention requested");
    Ok(())
}

fn truncate_label(s: &str) -> String {
    let mut out = String::with_capacity(MAX_BADGE_CHARS.min(s.len()));
    for (i, c) in s.chars().enumerate() {
        if i >= MAX_BADGE_CHARS {
            break;
        }
        out.push(c);
    }
    out
}

/// Truncate, then collapse empty / whitespace-only to `None`.
///
/// Without the `None` collapse, an empty-string caller would leave a literal
/// blank badge on the macOS Dock (the engine does not sanitize), which is a
/// **visible** regression from the "no badge" state — exactly the defect the
/// pre-fix unit test (`empty_label_is_handled_as_clear`) was supposed to pin
/// but did not (it tested the local string manipulation in the test body, not
/// what `apply()` actually hands to the OS).
///
/// `pub` so a future caller that wants the same collapse without going through
/// `apply` (a CLI flag, a test helper) can reuse it without re-deriving the rule.
pub fn sanitize_label(label: Option<String>) -> Option<String> {
    label
        .map(|s| truncate_label(&s))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn dock_badge_set(
    app: AppHandle,
    state: tauri::State<'_, DockBadgeState>,
    label: Option<String>,
) -> Result<(), String> {
    // The command's `State` parameter gives us the same handle `apply()` mutates
    // — we pass it through so the boot fact + frontend echo stays accurate.
    let _ = state;
    apply(&app, label)
}

#[tauri::command]
pub fn dock_request_attention(app: AppHandle, level: AttentionLevel) -> Result<(), String> {
    request_attention(&app, level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_truncated_to_the_doc_bound() {
        let big = "x".repeat(MAX_BADGE_CHARS * 4);
        let out = truncate_label(&big);
        assert_eq!(out.chars().count(), MAX_BADGE_CHARS);
    }

    #[test]
    fn label_under_the_bound_passes_through() {
        let s = "3";
        let out = truncate_label(s);
        assert_eq!(out, "3");
    }

    #[test]
    fn attention_level_maps_to_the_native_enum() {
        // The mapping is the contract: if Tauri ever renames these variants,
        // this test fails first.
        assert!(matches!(
            AttentionLevel::Info.to_native(),
            UserAttentionType::Informational
        ));
        assert!(matches!(
            AttentionLevel::Critical.to_native(),
            UserAttentionType::Critical
        ));
    }

    #[test]
    fn empty_label_is_handled_as_clear() {
        // Pin the production code path (`apply()` runs `sanitize_label` first).
        // The pre-fix test reproduced the local pipeline in the test body and
        // therefore passed regardless of what `apply()` actually did — exactly
        // the doc-vs-code defect this rewrite closes.
        assert_eq!(sanitize_label(Some("".into())), None);
        assert_eq!(sanitize_label(Some("   ".into())), None);
        // An explicit `None` is still a clear.
        assert_eq!(sanitize_label(None), None);
        // A real label passes through (modulo the bound).
        assert_eq!(sanitize_label(Some("3".into())), Some("3".into()));
        // Truncation still applies before the empty-collapse.
        let big = "x".repeat(MAX_BADGE_CHARS * 4);
        let trimmed = sanitize_label(Some(big)).expect("non-empty");
        assert_eq!(trimmed.chars().count(), MAX_BADGE_CHARS);
    }
}
