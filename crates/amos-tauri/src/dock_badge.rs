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
//! and `dock_request_attention` (level: `info` / `critical`). Both are honest about
//! what the platform can do, and the two answers are deliberately **different
//! shapes** (REQ-A412 — this header used to claim both were `Ok` with no effect):
//!
//! * `dock_badge_set` → `Ok` everywhere. macOS sets the free-form label, Windows
//!   / Linux set the numeric taskbar count, and on mobile there is no badge
//!   surface at all, so only the ledger and the `dock-badge-changed` event
//!   happen. The UI never has to gate the call behind `target_os`.
//! * `dock_request_attention` → `Err("unsupported platform")` on mobile, because a
//!   bounce cannot be approximated the way a badge can: there is nothing to call,
//!   and a silent `Ok` would be indistinguishable from a bounce the user ignored.
//!   On desktop it bounces, or is a no-op that returns `Ok` (Linux/Windows).
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
#[cfg(desktop)]
use tauri::UserAttentionType;
use tauri::{AppHandle, Emitter, Manager};

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
    #[cfg(desktop)]
    fn to_native(self) -> UserAttentionType {
        match self {
            AttentionLevel::Info => UserAttentionType::Informational,
            AttentionLevel::Critical => UserAttentionType::Critical,
        }
    }
}

/// Process-wide ledger of the last badge label this process applied.
///
/// **In-memory only** (REQ-A412): this is not persistence, so the "a new window can
/// re-apply it on launch" this doc used to promise is impossible by construction — a
/// relaunch starts empty, which is also what the OS does with an unsaved Dock badge.
/// What it is for is a reader that wants the current badge *without* asking the OS
/// ([`DockBadgeState::current`]) and the tests that pin what `apply()` actually
/// recorded (the old test reproduced the sanitising pipeline locally and so never
/// noticed what production did).
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

    /// Read the current label — the ledger's only reader today (tests; a future
    /// "what is the badge now?" command would be the second).
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

    // Both `set_badge_label` (macOS) and the cross-platform `set_badge_count`
    // live behind tauri 2's `#[cfg(desktop)]` gate — the
    // `/// Desktop window getters.` block in
    // tauri-2.x/src/webview/webview_window.rs — so neither is callable on
    // Android/iOS. Building this seam against a mobile target failed with
    // E0599 ("no method named `set_badge_count` found for reference
    // `&tauri::WebviewWindow<R>`"); the dock/taskbar affordance simply doesn't
    // exist on phones, and the badge is *also* no-op on Android per the tauri
    // docs ("Android: Unsupported"). The mirror-to-frontend emit below stays
    // active on mobile so the Dock tile surface (a future Android widget, a
    // UI badge) can still hear it.
    #[cfg(desktop)]
    {
        let main_window = app.get_webview_window("main");

        if let Some(window) = &main_window {
            // macOS path: free-form label (we use it everywhere because it
            // accepts strings, not just numbers, and is what the Dock
            // actually shows).
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
            // Cross-platform count fallback (Windows taskbar / Linux Unity).
            // We map an arbitrary label to a count: numeric strings become
            // that number, everything else becomes `None` (clear).
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
///
/// Mobile platforms (Android/iOS) have no Dock — the matching tauri methods
/// (`request_user_attention` / `UserAttentionType`) live behind
/// `#[cfg(desktop)]`. On phones the caller gets an honest `Err("unsupported
/// platform")` so the UI can degrade gracefully; the call doesn't panic and
/// doesn't compile-fail the Android APK (the prior behaviour — the entire
/// function was active on Android but called a non-existent method —
/// manifested as E0599 from `make android-app`, the gate that caught it).
pub fn request_attention<R: tauri::Runtime>(
    app: &AppHandle<R>,
    level: AttentionLevel,
) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = (app, level);
        tracing::debug!(
            target: "amos::dock_badge",
            ?level,
            "request_attention is a no-op on mobile (no Dock surface)"
        );
        return Err("unsupported platform".to_string());
    }
    #[cfg(desktop)]
    {
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
pub fn dock_badge_set(app: AppHandle, label: Option<String>) -> Result<(), String> {
    // No `State<DockBadgeState>` parameter: this command only *applies* a label, and
    // `apply` reaches the same handle through the app. The parameter that used to sit here
    // existed solely to be ignored (`let _ = state;`) — the state is for readers
    // (`current()`), not for the writer.
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

    // `to_native` (and `UserAttentionType`) exist only on desktop targets: without this gate the
    // test module cannot compile for a mobile target at all (REQ-A412).
    #[cfg(desktop)]
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

    /// The `desktop` cfg is the **target**, not the `android` feature, and `tauri_build::build()`
    /// emits it (`cfg_alias("desktop", !mobile)`). If that ever stopped being true, the badge and
    /// attention paths would silently compile out on macOS — no OS call, no error, no test
    /// failure anywhere — so the gate is pinned against the host target (REQ-A412).
    #[test]
    fn the_desktop_gate_matches_the_host_target() {
        #[cfg(desktop)]
        assert!(
            !matches!(std::env::consts::OS, "android" | "ios"),
            "`desktop` is set on a mobile target: the badge path would be compiled in where its \
             methods do not exist"
        );
        #[cfg(not(desktop))]
        assert!(
            matches!(std::env::consts::OS, "android" | "ios"),
            "`desktop` is NOT set on a desktop target: every badge write would be compiled out \
             and `request_attention` would answer \"unsupported platform\""
        );
    }

    /// A mock host with the ledger managed — `apply()` needs an `AppHandle`, and unlike the tests
    /// above this one drives the **production** path.
    #[cfg(desktop)]
    fn mock_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .manage(DockBadgeState::new())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        app.handle().clone()
    }

    #[cfg(desktop)]
    #[test]
    fn apply_records_what_it_applied_and_collapses_a_blank_to_no_badge() {
        // The defect this file's own comment describes: the old test reproduced the sanitising
        // pipeline *in the test body*, so it passed no matter what `apply()` did. This one calls
        // `apply()` and reads the ledger it wrote.
        let handle = mock_handle();
        apply(&handle, Some("   ".into())).expect("apply");
        assert_eq!(
            handle.state::<DockBadgeState>().current(),
            None,
            "whitespace must clear the badge, not paint an empty one"
        );
        apply(&handle, Some("3".into())).expect("apply");
        assert_eq!(
            handle.state::<DockBadgeState>().current(),
            Some("3".to_string())
        );
        // …and an explicit clear is a real state, not a missing one.
        apply(&handle, None).expect("apply");
        assert_eq!(handle.state::<DockBadgeState>().current(), None);
    }

    #[cfg(desktop)]
    #[test]
    fn apply_truncates_through_the_production_path() {
        let handle = mock_handle();
        apply(&handle, Some("x".repeat(MAX_BADGE_CHARS * 3))).expect("apply");
        let stored = handle
            .state::<DockBadgeState>()
            .current()
            .expect("a label was stored");
        assert_eq!(stored.chars().count(), MAX_BADGE_CHARS);
        assert_eq!(stored, "x".repeat(MAX_BADGE_CHARS));
    }
}
