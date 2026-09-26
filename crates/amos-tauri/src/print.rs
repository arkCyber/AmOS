//! `print` — the host's **print** path: hand the focused app window's content to the
//! platform's own print dialog.
//!
//! Command:
//!   * `print_document` — open the platform print dialog for the focused app window
//!
//! # Why this module exists
//!
//! `docs/DESKTOP_AUDIT_2026_SEP21.md` §5 ranked "the print pipeline" as the shell's
//! most visible missing capability, and §0/§6 record that **no** GUI behaviour in this
//! tree has ever been confirmed by eye. Both halves are true of what came before this
//! module, and the second half is the defect: the only print path in the app was one
//! line in the in-app File menu (`TopbarMainMenu.svelte`) calling `window.print()`, and
//! `docs/DESKTOP_AUDIT_2026_SEP21.md` §5 (written 2026-09-21) states as fact that "the
//! File menu does not have a single `Print…` row" — because the audit grepped
//! `menu.rs`, where that row genuinely is absent.
//!
//! # The three rules this module follows, each learned elsewhere in this repo
//!
//! 1. **The WebView never names a window to print.** `print_document` takes **no
//!    arguments**; the host answers "which window" with its own two sources
//!    ([`crate::wm::focused_app_label`], the same answer ⌘W and the window-item sync
//!    ask for). Printing is an *output* of whatever the user is looking at, so a label
//!    from the WebView would let a background surface print itself, and a
//!    caller-chosen token is exactly what `docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` §2 D2
//!    forbids (`session.rs` rule 1, applied one step further: there is nothing here to
//!    name at all).
//!
//!    This also fixes the concrete trap the obvious implementation walks into. The
//!    native menu forwards its activation to the shell as `menu-event`, and the *only*
//!    subscriber is `DesktopShell.svelte` — which mounts **only in the launcher
//!    window** (`Shell.svelte`: `s.kind === "app"` renders `DesktopAppWindow` instead;
//!    REQ-A416). So a `case "menu.print": window.print()` would print **the desktop**
//!    — the launcher — while the user is looking at a document in an app window. The
//!    host path cannot make that mistake: the launcher is never a target
//!    ([`crate::wm::is_screen_window`], F-SH-008).
//!
//! 2. **Unavailability is a runtime fact, never a `cfg` on the command.**
//!    `print_document` is registered on **every** target; on a host with no print
//!    dialog it answers a named refusal ([`codes::UNSUPPORTED_PLATFORM`]) instead of
//!    being an unregistered command, which the bridge reports as an opaque failure
//!    (`session.rs` rule 2; `wine.rs`'s rule, and the reason its first draft —
//!    registered under `#[cfg(target_os = "darwin")]`, which is not a `target_os`
//!    value — never registered at all).
//!
//! 3. **The reply is a value, not `()`,** because Tauri serializes `()` to `null` and
//!    the bridge reads `null` as failure (REQ-A513 / F-SH-053): a *successful* print
//!    request would reach the shell looking like a refusal.
//!
//! # `Ok` does not mean "printed", and this module never says it does
//!
//! **Read this before trusting the reply.** `WebviewWindow::print()` cannot report
//! whether a dialog appeared or whether a page came out of a printer: it returns
//! `Ok(())` on every platform, and in three of the four wry implementations the
//! `Ok(())` is reached without the call having done anything. Measured in this tree's
//! vendored wry (0.55.1) and tauri (2.11.5), `~/.cargo/registry/.../wry-0.55.1/src/`:
//!
//! | target | `print()` body | what `Ok(())` means |
//! | --- | --- | --- |
//! | macOS (`wkwebview/mod.rs:858`) | runs `printOperationWithPrintInfo:` **only if** `respondsToSelector` says the selector exists (macOS 11+) | "we asked" — and on a host **without** the selector the body is skipped and it still returns `Ok(())`, i.e. a **silent no-op** |
//! | Windows (`webview2/mod.rs:1712`) | `eval("window.print()")` | "the script was **queued**" |
//! | Linux (`webkitgtk/mod.rs:679`) | `webkit2gtk::PrintOperation::run_dialog(None)` whose `PrintOperationResult` is **dropped** | "the dialog was shown" — **also for Cancel** |
//! | Android (`android/mod.rs:344`) | `Ok(())`, nothing else | nothing at all |
//!
//! tauri's own doc comment on `WebviewWindow::print()` says "Currently only supported on
//! macOS on `wry`. `window.print()` works on all platforms." — the first sentence is
//! **stale** for Windows and Linux (both have real bodies, read above), and the second
//! is the claim that made the one-line frontend row look sufficient. Neither this module
//! nor any test in it can settle which of those bodies actually paints a page: that
//! needs a real desktop, a real printer, and eyes (§6 of the audit — not available in
//! this tree).
//!
//! So [`PrintRequest`] is named for what is **known** — *which window we asked the
//! platform about* — and never for an outcome. A caller that renders "printed" from this
//! reply is reporting something nobody measured.

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AmosError, AmosResult, ErrorCode};

/// The wire codes this module's refusals carry, **derived** from
/// [`ErrorCode::as_str`] so a second literal spelling of the same code cannot appear
/// here (`error.rs`'s rule: the code is the contract, and a re-typed copy of it is how a
/// rename becomes a silent wire break).
pub mod codes {
    use super::ErrorCode;

    /// No print dialog exists on this host. Reached on Android / iOS.
    pub const UNSUPPORTED_PLATFORM: &str = ErrorCode::PrintUnsupportedPlatform.as_str();
    /// Nothing focused that may be printed — the launcher is not a target (F-SH-008).
    pub const NO_WINDOW: &str = ErrorCode::PrintNoWindow.as_str();
    /// The platform's own call returned an error. The cause carries its message.
    pub const DIALOG_FAILED: &str = ErrorCode::PrintDialogFailed.as_str();
}

/// The message [`codes::UNSUPPORTED_PLATFORM`] carries.
///
/// English and developer-facing, per `error.rs`'s "the *message* is a diagnostic, the
/// *code* is what the UI branches on" — the shell translates the code.
const UNSUPPORTED_MESSAGE: &str = "no print dialog exists on this platform (desktop only)";

/// Which platform this build is running on, as far as printing is concerned.
///
/// `Unsupported` means "this host has no print dialog" — it is derived from the same
/// `cfg!`s as the table in the module header, not from a list that could fall behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PrintPlatform {
    /// `wkwebview`'s `printOperationWithPrintInfo:` (macOS 11+; see the header table).
    MacOs,
    /// `webview2`'s `print()`, which is `eval("window.print()")`.
    Windows,
    /// `webkit2gtk`'s `PrintOperation`.
    Linux,
    /// Android / iOS: no dialog. Distinguishing "no dialog" from "a platform we did not
    /// enumerate" is deliberate — both refuse, and the code says so.
    Unsupported,
}

impl PrintPlatform {
    /// The name used in refusal messages and logs (a `match` over `Debug` would print
    /// the variant spelling, which is an implementation detail).
    pub const fn name(self) -> &'static str {
        match self {
            Self::MacOs => "macOS",
            Self::Windows => "Windows",
            Self::Linux => "Linux",
            Self::Unsupported => "this platform",
        }
    }
}

/// Which platform this build targets. `const`, so the whole table is a compile-time
/// constant on each target rather than a runtime probe.
pub const fn platform() -> PrintPlatform {
    if cfg!(target_os = "macos") {
        PrintPlatform::MacOs
    } else if cfg!(target_os = "windows") {
        PrintPlatform::Windows
    } else if cfg!(target_os = "linux") {
        PrintPlatform::Linux
    } else {
        PrintPlatform::Unsupported
    }
}

/// Does `platform` have a print dialog this host can ask for?
///
/// **Pure, and the only place the answer is written** — the command refuses through this,
/// so a platform cannot be "supported" in the doc table and unsupported here.
pub const fn supports_dialog(platform: PrintPlatform) -> bool {
    !matches!(platform, PrintPlatform::Unsupported)
}

/// What the host accepted, as the command's reply.
///
/// A **value**, not `()` (rule 3 in the header). The fields are exactly the two facts the
/// host knows: which window it asked about, and on which platform. Every field is read by
/// the shell's refusal notice, so neither is carried for decoration.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintRequest {
    /// The label of the app window the platform was asked to print.
    pub window: String,
    /// The platform that was asked, so a log line from a bug report says which
    /// implementation ran.
    pub platform: PrintPlatform,
}

/// Ask the platform to open its print dialog for `label`, and report what it said.
///
/// **The only place the platform call happens.** Desktop-only, because
/// `WebviewWindow::print()` is: `tauri::webview::Webview::print` is behind
/// `#[cfg(desktop)]` (tauri 2.11.5, `src/webview/mod.rs:1481`), so a mobile build has no
/// such method to call — the `#[cfg(not(desktop))]` twin below is what keeps the claim
/// inside the platform's actual surface rather than behind an `if` that can never be
/// false.
#[cfg(desktop)]
fn ask_platform<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or_else(|| {
        format!(
            "window '{label}' has no platform window (an external surface, or one that is gone)"
        )
    })?;
    window.print().map_err(|e| e.to_string())
}

/// Non-desktop (Android / iOS): there is no print dialog to ask for. Reached only if
/// [`print_focused`]'s platform check is ever weakened, which is why it answers the same
/// named refusal rather than panicking.
#[cfg(not(desktop))]
fn ask_platform<R: Runtime>(_app: &AppHandle<R>, _label: &str) -> Result<(), String> {
    Err(UNSUPPORTED_MESSAGE.to_string())
}

/// Decide whether to print, and if so whether the platform accepted the request.
///
/// **Pure decision / side effect**, in this repo's usual shape: the platform call is
/// `ask`, passed in rather than reached for. Production passes
/// `|label| ask_platform(&app, label)`; a unit test passes a closure that *records the
/// label* and answers without a window server. That is the half a test can honestly
/// measure: which window the host asked about. Whether a dialog appeared is not
/// observable through `WebviewWindow::print()` at all (see the header table), so no test
/// here claims it.
///
/// Desktop-gated with the call it wraps; the refusal for a host without a dialog is
/// raised by the twin below on the same code path, so the *command* is one shape
/// everywhere (rule 2).
#[cfg(desktop)]
pub fn print_focused<R: Runtime, F>(app: &AppHandle<R>, ask: F) -> AmosResult<PrintRequest>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let platform = platform();
    if !supports_dialog(platform) {
        // Not a `cfg`: the *decision* stays a runtime fact so a test on any host can
        // exercise the refusal, and so the code that answers it is the code that ships.
        return Err(AmosError::new(
            ErrorCode::PrintUnsupportedPlatform,
            UNSUPPORTED_MESSAGE,
        ));
    }
    let Some(label) = crate::wm::focused_app_label(app) else {
        return Err(AmosError::new(
            ErrorCode::PrintNoWindow,
            "no app window is focused to print (the launcher is never a target)",
        ));
    };
    ask(&label).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::PrintDialogFailed,
            format!("the platform's print call for window '{label}' failed"),
            e,
        )
    })?;
    tracing::info!(
        target: "amos::print",
        window = %label,
        platform = platform.name(),
        "asked the platform to open its print dialog (this does not mean a page was printed \
         — see print.rs's header table)"
    );
    Ok(PrintRequest {
        window: label,
        platform,
    })
}

/// Non-desktop twin — see [`ask_platform`]'s twin above.
#[cfg(not(desktop))]
pub fn print_focused<R: Runtime, F>(_app: &AppHandle<R>, _ask: F) -> AmosResult<PrintRequest>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    Err(AmosError::new(
        ErrorCode::PrintUnsupportedPlatform,
        UNSUPPORTED_MESSAGE,
    ))
}

/* ---- Tauri commands --------------------------------------------------------- */

/// Open the platform's print dialog for the **focused app window**.
///
/// Zero arguments on purpose — see rule 1 in the module header. Registered on every
/// target; a host with no dialog answers [`codes::UNSUPPORTED_PLATFORM`].
#[tauri::command]
pub fn print_document<R: Runtime>(app: AppHandle<R>) -> AmosResult<PrintRequest> {
    print_focused(&app, |label| ask_platform(&app, label))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every platform in the table, so a case is written once for all of them.
    const PLATFORMS: [PrintPlatform; 4] = [
        PrintPlatform::MacOs,
        PrintPlatform::Windows,
        PrintPlatform::Linux,
        PrintPlatform::Unsupported,
    ];

    /// A mock app with a desktop `WmState` — the shape `wm.rs`'s identity tests use,
    /// because the focus model is production state, not a test seam.
    #[cfg(desktop)]
    fn desktop_host() -> (
        tauri::App<tauri::test::MockRuntime>,
        AppHandle<tauri::test::MockRuntime>,
    ) {
        let app = tauri::test::mock_builder()
            .manage(crate::wm::WmState::new_for_test(
                amos_wm::form::FormFactor::Desktop,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let handle = app.handle().clone();
        (app, handle)
    }

    /// The support table, with a witness per platform.
    ///
    /// The `Unsupported` witness is the one that matters: a rewrite of [`supports_dialog`]
    /// as `matches!(p, MacOs | Windows | Linux)` would keep the three `true`s and lose this
    /// one, which is the whole difference between "we print on mobile" and "we refuse".
    #[test]
    fn every_platform_answers_whether_it_has_a_dialog() {
        for platform in PLATFORMS {
            let expected = !matches!(platform, PrintPlatform::Unsupported);
            assert_eq!(
                supports_dialog(platform),
                expected,
                "{} must answer {expected}",
                platform.name()
            );
        }
        // Named witnesses, so the loop above cannot pass by agreeing with itself.
        assert!(supports_dialog(PrintPlatform::MacOs));
        assert!(supports_dialog(PrintPlatform::Windows));
        assert!(supports_dialog(PrintPlatform::Linux));
        assert!(!supports_dialog(PrintPlatform::Unsupported));
    }

    /// [`platform`] reports the target this test is running on — the `cfg!` chain and the
    /// header's table are two statements of one fact, so they are checked against each other
    /// rather than both being read out of `cfg!`.
    #[test]
    fn this_build_reports_the_platform_it_is_running_on() {
        let expected = if cfg!(target_os = "macos") {
            PrintPlatform::MacOs
        } else if cfg!(target_os = "windows") {
            PrintPlatform::Windows
        } else if cfg!(target_os = "linux") {
            PrintPlatform::Linux
        } else {
            PrintPlatform::Unsupported
        };
        assert_eq!(platform(), expected);
        // A desktop test host that reports `Unsupported` would make every print test below
        // pass through the refusal arm without exercising anything.
        assert_eq!(
            platform() != PrintPlatform::Unsupported,
            cfg!(desktop),
            "the support table and the build's own cfg must agree"
        );
    }

    /// The load-bearing test: the host asks the platform about **the focused app window**,
    /// and the reply names that window — not the launcher, not an empty string.
    ///
    /// The `ask` closure records its argument, so the assertion is on what the *production
    /// decision* handed to the platform call, not on the reply the decision then built.
    ///
    /// Honest boundary: under `tauri::test::mock_runtime`, `is_focused()` is
    /// **hard-coded to `Ok(false)`** (`mock_runtime.rs:753`), so this exercises the
    /// **model** source of [`crate::wm::focused_app_label`] only. The platform-key branch
    /// and its ordering are pinned purely, with named witnesses, in
    /// `wm::tests::the_focused_target_prefers_the_key_window_and_falls_back_to_the_model`.
    #[cfg(desktop)]
    #[test]
    fn the_reply_names_the_focused_window_it_asked_the_platform_about() {
        let (_app, handle) = desktop_host();
        let state = handle.state::<crate::wm::WmState>();
        state.open(&handle, "files").expect("the window opens");

        let mut asked: Option<String> = None;
        let request = print_focused(&handle, |label| {
            asked = Some(label.to_string());
            Ok(())
        })
        .expect("the platform accepts the request");

        assert_eq!(
            asked.as_deref(),
            Some(request.window.as_str()),
            "the reply must name the window the platform was actually asked about"
        );
        assert_eq!(request.window, "files");
        assert_ne!(
            request.window, "main",
            "the launcher is the desktop, never a print target (F-SH-008)"
        );
        assert!(
            supports_dialog(request.platform),
            "a reply is only built after the platform check passed"
        );
    }

    /// The launcher is focused and nothing else ⇒ a **named** refusal, and the platform is
    /// never asked.
    ///
    /// This is the surface where the `Shell.svelte` trap would have shipped: the native
    /// menu's only subscriber runs in the **launcher** window, so a `window.print()` there
    /// prints the desktop while the user is looking at an app window. The `asked` flag is
    /// what notices a wrong implementation that substituted a default target — it would
    /// still return `Ok`.
    ///
    /// The **precondition is asserted**, not assumed: a fresh desktop host really does have
    /// the launcher focused (measured here), which is what makes this test about the launcher
    /// rather than about an empty model. An empty model reduces to the same code path
    /// (`focused_app_label` answering `None`) and is pinned purely in
    /// `wm::tests::the_focused_target_prefers_the_key_window_and_falls_back_to_the_model`
    /// by `focused_target_label(None, None) == None`.
    #[cfg(desktop)]
    #[test]
    fn the_launcher_is_never_printed_and_the_platform_is_never_asked() {
        let (_app, handle) = desktop_host();
        let snapshot = handle
            .state::<crate::wm::WmState>()
            .snapshot()
            .expect("the model is readable");
        let focused = snapshot
            .windows
            .iter()
            .find(|w| w.focused)
            .map(|w| w.label.clone());
        assert_eq!(
            focused.as_deref(),
            Some("main"),
            "precondition: a fresh desktop host has the launcher focused — if this changes, \
             the rest of this test would pass for the wrong reason"
        );

        let mut asked = false;
        let err = print_focused(&handle, |_| {
            asked = true;
            Ok(())
        })
        .expect_err("the launcher is a desktop, not a document");

        assert_eq!(err.code(), codes::NO_WINDOW);
        assert!(!asked, "the launcher must never reach the platform call");
    }

    /// A platform call that fails is a refusal **that keeps the platform's own words** in
    /// the cause chain — a bare `dialog_failed` would make the one thing a bug report needs
    /// unrecoverable, and `error.rs`'s envelope exists precisely to avoid that.
    #[cfg(desktop)]
    #[test]
    fn a_failed_platform_call_is_named_and_keeps_its_cause() {
        let (_app, handle) = desktop_host();
        handle
            .state::<crate::wm::WmState>()
            .open(&handle, "files")
            .expect("the window opens");

        let err = print_focused(&handle, |_| Err("WebView is not attached".to_string()))
            .expect_err("the platform refused");

        assert_eq!(err.code(), codes::DIALOG_FAILED);
        assert_eq!(err.cause, vec!["WebView is not attached".to_string()]);
        assert!(
            err.message.contains("files"),
            "the refusal must name the window it was about, got: {}",
            err.message
        );
    }

    /// A label with no platform window (an external surface, or one that is gone) is
    /// refused by the **real** `ask_platform`, not only by an injected closure — this is
    /// the one arm of the production call a headless test can reach.
    #[cfg(desktop)]
    #[test]
    fn a_label_with_no_platform_window_is_refused_by_name() {
        let (_app, handle) = desktop_host();
        let err = ask_platform(&handle, "no-such-window").expect_err("no such window exists");
        assert!(
            err.contains("no-such-window") && err.contains("no platform window"),
            "the refusal must say which window and why, got: {err}"
        );
    }

    /// The refusals are the **declared** wire codes, pinned by value — the frontend
    /// branches on these exact strings, so a rename here is a wire break that no other
    /// test in this file would notice (they compare against `codes::`, which derives from
    /// the same declaration).
    #[test]
    fn the_refusal_codes_are_the_declared_wire_codes() {
        assert_eq!(
            codes::UNSUPPORTED_PLATFORM,
            "amos.print.unsupported_platform"
        );
        assert_eq!(codes::NO_WINDOW, "amos.print.no_window");
        assert_eq!(codes::DIALOG_FAILED, "amos.print.dialog_failed");

        // The three codes are the *distinct, correctly namespaced* values the shell
        // branches on — a duplicate or a mis-namespaced one would still satisfy the three
        // `assert_eq!`s above, since `codes::` derives from the same declaration.
        let declared = [
            ErrorCode::PrintUnsupportedPlatform.as_str(),
            ErrorCode::PrintNoWindow.as_str(),
            ErrorCode::PrintDialogFailed.as_str(),
        ];
        let mut seen = std::collections::HashSet::new();
        for code in declared {
            assert!(seen.insert(code), "duplicate code: {code}");
            assert!(
                code.strip_prefix("amos.print.")
                    .is_some_and(|rest| !rest.is_empty()),
                "every print code must be namespaced under amos.print.: {code}"
            );
        }
        assert_eq!(seen.len(), 3, "three codes, three expectations");
        assert_eq!(ErrorCode::PrintNoWindow.group(), "print");
    }
}
