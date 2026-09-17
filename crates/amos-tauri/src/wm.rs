//! Tauri window-manager adapter + system-wide context (multi-window phase).
//!
//! Bridges the transport-agnostic `amos-wm` state machine to *real* Tauri
//! `WebviewWindow`s, and implements the system-wide clipboard/selection
//! context (`SystemContext`) that gets injected into `AgentRequest.context`
//! when the AI assistant streams a reply — see `docs/multi-window.md`.
//!
//! The `WindowManager` decides *what* should happen (focus, z-order, show/hide);
//! this module decides *how* to mirror each `WmEvent` onto the running app:
//! `Created` → build a real window, `Shown/Hidden` → `show()/hide()`,
//! `FocusChanged` → `set_focus()`, `Closed` → `close()`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use amos_wm::form::{
    resolve_hint, FormFactor, HintSource, LayoutPolicy, ShellFit, FORM_FACTOR_ENV,
};
use amos_wm::layout::{Bounds, Size, SplitAxis};
use amos_wm::split::SplitScreen;
use amos_wm::{WindowId, WindowKind, WindowManager, WmEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::store::{SharedStore, APP_FOCUSED_KEY};

/// Window area the layout model uses **until the real OS window has been
/// measured** (`WmState::sync_window_layout`). It is not a claim about the screen:
/// an unmeasured host used to keep this 1080×1920 phone rectangle forever, which
/// made the content-column signal and any split describe a window nobody had.
const FALLBACK_SCREEN: Bounds = Bounds::new(0, 0, 1080, 1920);

/// The handset-shaped shell window `tauri.conf.json` declares (logical px).
///
/// App windows already opened at their class's size, but the **shell itself** kept
/// launching as a phone slab on a PC because that config value is static — so the
/// form-factor work was applied to every window except the main one (REQ-A222).
/// This constant is the *only* geometry the host replaces at boot, and only when
/// the window is still exactly this size (see [`LayoutPolicy::shell_resize`]).
///
/// It is **derived** from the phone class's own window size rather than re-typed,
/// so the number lives in one place. `the_shell_default_is_the_phone_window_in_
/// tauri_conf` additionally reads `tauri.conf.json` and fails if the declared main
/// window drifts from it: a stale copy here would make the comparison in
/// [`shell_fit_reading`] never match, silently restoring the very defect this
/// constant exists to remove ("a PC opens as a phone slab").
pub const SHELL_DEFAULT_WINDOW: Size = LayoutPolicy::of(FormFactor::Phone).initial_window;
/// Tauri event broadcast after any layout change, so **non-initiating** windows /
/// surfaces can refresh their geometry without round-tripping a command.
pub const LAYOUT_EVENT: &str = "layout-changed";

/// Tauri label of the launcher window (declared in `tauri.conf.json`).
const LAUNCHER_LABEL: &str = "main";

/// Web path (relative to `frontendDist`) every app window loads.
const APP_ENTRY: &str = "index.html";

/// Maximum bytes in a system-context text entry (selected text for AI injection).
///
/// This text is merged into `AgentRequest.context` under `system_selection`, so a
/// malicious app window could try to stuff a huge string here to inflate the AI
/// prompt beyond `MAX_AI_PROMPT_BYTES`. The 32 KiB cap covers a long document
/// selection while keeping the total prompt well under the AI model's limit.
pub const MAX_CONTEXT_TEXT_BYTES: usize = 32 << 10;

/// Maximum bytes in a shell window title.
///
/// Titles appear in window decorations, screen-reader announcements, and the OS task
/// bar; a title beyond 256 bytes is almost certainly a misbehaving app. The cap
/// also prevents a huge title from exceeding platform limits.
pub const MAX_SHELL_TITLE_BYTES: usize = 256;

/// Maximum bytes in a `target_window` / `source_window` label in
/// `system_set_context` (the context map keys itself on these labels, and they
/// show up in every `system-context-updated` broadcast — a paste-sized label
/// would inflate every consumer of that event).
pub const MAX_CONTEXT_LABEL_BYTES: usize = 256;

/// Restore a window to "full" screen. Desktop Tauri has a real `maximize`; on
/// Android (the System UI APK) windows are always fullscreen, and `WebviewWindow`
/// has no `maximize`, so this is a cross-target no-op that still compiles.
#[cfg(desktop)]
fn window_maximize(w: &tauri::WebviewWindow) {
    let _ = w.maximize();
}
#[cfg(not(desktop))]
fn window_maximize(_w: &tauri::WebviewWindow) {
    /* mobile: single always-fullscreen window — nothing to restore */
}

/// Human-readable title for an app window.
///
/// Falls back to `"Amos"` for unknown labels; the actual names live in
/// the frontend's `APP_META` and would require a cross-process lookup.
/// Kept as a simple map rather than a dependency to avoid pulling
/// the frontend metadata into the Rust host.
fn app_window_title(label: &str) -> &'static str {
    match label {
        "clock" => "Clock",
        "settings" => "Settings",
        "calculator" => "Calculator",
        "weather" => "Weather",
        "notes" => "Notes",
        "reminders" => "Reminders",
        "calendar" => "Calendar",
        "vmemos" => "Voice Memos",
        "photos" => "Photos",
        "files" => "Files",
        "android" => "Android",
        "messages" => "Messages",
        "phone" => "Phone",
        "music" => "Music",
        "player" => "Player",
        "maps" => "Maps",
        "camera" => "Camera",
        "ai" => "AI Assistant",
        "interpreter" => "Interpreter",
        "mail" => "Mail",
        "store" => "App Store",
        "pwa" => "PWA Hub",
        "privacy" => "Privacy",
        "contacts" => "Contacts",
        "magnifier" => "Magnifier",
        "monitor" => "System Monitor",
        "devocare" => "Device Care",
        "terminal" => "Terminal",
        // Launcher and any unrecognized label.
        _ => "Amos",
    }
}

/// Shared state: the transport-agnostic `WindowManager` plus a registry that
/// maps `WindowId` ⇄ Tauri window label.
pub struct WmState {
    inner: Mutex<WmCore>,
}

struct WmCore {
    wm: WindowManager,
    /// WindowId -> Tauri window label.
    labels: HashMap<WindowId, String>,
    /// Tauri window label -> WindowId.
    by_label: HashMap<String, WindowId>,
    /// WindowId -> human-readable kind ("Launcher" | "App" | "System").
    kinds: HashMap<WindowId, String>,
    /// WindowIds that are *external* surfaces (e.g. a legacy Android APK surface
    /// composited from Waydroid) — tracked in the state machine for focus/z-order
    /// but **not** backed by a Tauri WebviewWindow.
    external: HashSet<WindowId>,
    /// Full OS window area the split layout sub-divides (0,0 origin).
    screen: Bounds,
    /// Active split-screen session (which two windows share the screen), if any.
    split: Option<SplitScreen>,
    /// Form-factor policy this host runs under (resolved once at startup).
    ///
    /// The policy owns the split divider/minimum pane (previously two module
    /// constants) and the class-dependent capabilities the shell reads back
    /// (`form`, `columns`, `multi_window`, `free_resize`).
    policy: LayoutPolicy,
    /// A shell-window size this host asked the OS for and has **not yet seen applied**
    /// ([`WmState::fit_shell_window`]); cleared by [`WmState::note_applied_size`] when a
    /// real (post-application) measurement answers it (REQ-A230).
    shell_fit: Option<Size>,
}

/// The class this build was compiled for — the **only** form-factor fact a
/// compiler can know: Tauri's `cfg(desktop)` is emitted by `tauri-build` from the
/// target triple, and a phone and a tablet share one Android target (that
/// distinction is runtime, see `amos_wm::form::LayoutPolicy::columns_for`).
fn built_for_form_factor() -> FormFactor {
    if cfg!(desktop) {
        FormFactor::Desktop
    } else {
        FormFactor::Phone
    }
}

/// Resolve the host's form factor from an optional `AMOS_FORM_FACTOR` hint.
///
/// Pure (the raw value is injected) so the fallback path is testable without
/// touching the process environment. Returns the form factor, where it came from,
/// and the warning to report when the value was unusable — the caller logs it:
/// an ignored knob must be visible, never silent.
fn resolve_host_form_factor(
    built_for: FormFactor,
    raw: Option<&str>,
) -> (FormFactor, HintSource, Option<String>) {
    match resolve_hint(raw, built_for) {
        Ok((form, source)) => (form, source, None),
        Err(message) => (built_for, HintSource::BuildDefault, Some(message)),
    }
}

/// Upper bound on a believable window edge (px). Beyond this a size is a
/// nonsense reading, not a screen; the layout keeps its previous value instead of
/// accepting it (Power of 10 #2: bounded).
const MAX_SCREEN_EDGE: u32 = 100_000;

/// A believable window edge (logical px), or `None` when the reading is not one:
/// non-finite, below 1, or absurdly large. Rounding happens *before* the bound so
/// an absurd `f64` cannot saturate the cast (Power of 10 #2: bounded).
fn sane_edge(v: f64) -> Option<u32> {
    if !v.is_finite() || v < 1.0 {
        return None;
    }
    let rounded = v.round();
    if rounded > f64::from(MAX_SCREEN_EDGE) {
        return None;
    }
    Some(rounded as u32)
}

/// The **logical** size of a window from its physical reading + DPI scale, or
/// `None` when the reading is unusable.
///
/// A missing/absurd scale factor is treated as 1 here (never a divide by zero),
/// which is the documented contract of the layout path ([`logical_screen`]'s
/// tests pin it). A caller that must not act on a *doubtful* reading refuses
/// before calling this — see [`shell_fit_reading`].
fn logical_size_of(width: f64, height: f64, scale: f64) -> Option<Size> {
    let effective_scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    match (
        sane_edge(width / effective_scale),
        sane_edge(height / effective_scale),
    ) {
        (Some(w), Some(h)) => Some(Size::new(w, h)),
        _ => None,
    }
}

/// Translates a **physical** window size + DPI scale into the **logical** pixel
/// rect the layout model works in.
///
/// The panes are applied with `LogicalPosition`/`LogicalSize`
/// ([`WmState::apply_split_to_real`]), so the model *must* be logical — feeding it
/// physical pixels would put a 2× display's panes outside the window. Every
/// unusable reading (non-finite, ≤ 0, absurd) falls back to `fallback` rather than
/// producing a zero-sized or overflowing rect.
fn logical_screen(width: f64, height: f64, scale: f64, fallback: Bounds) -> Bounds {
    match logical_size_of(width, height, scale) {
        Some(size) => Bounds::new(fallback.x, fallback.y, size.width, size.height),
        None => fallback,
    }
}

/// What the OS did with a shell-window size request ([`WmState::fit_shell_window`]).
///
/// Reported, never guessed: the boot request can be answered with a *different* size —
/// measured on macOS, asking a laptop display (1728×1117 logical) for the tablet class's
/// 900×1200 portrait window yields **900×882** (the window manager clamps to what the
/// display can hold). The host cannot know that in advance (the policy is a class fact,
/// not a screen fact), so it says what actually happened instead of leaving the two log
/// lines for a human to compare (REQ-A230).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFitOutcome {
    /// The window ended up at exactly the size that was asked for.
    Honoured { size: Size },
    /// The window ended up somewhere else (a display that cannot hold the request, or a
    /// window-manager clamp).
    Adjusted { requested: Size, applied: Size },
}

/// Compare a shell-size request with the size the OS actually applied.
pub const fn shell_fit_outcome(requested: Size, applied: Size) -> ShellFitOutcome {
    if requested.width == applied.width && requested.height == applied.height {
        ShellFitOutcome::Honoured { size: applied }
    } else {
        ShellFitOutcome::Adjusted { requested, applied }
    }
}

/// What happened when the host asked the platform to focus the Launcher window.
///
/// The distinction matters because the call *returning* `Ok` is not the outcome: on
/// macOS a **non-bundled** binary (the one `cargo build` produces and
/// `make run-ui-release` launches) is not a "regular" app, so it can stay behind every
/// other app no matter what it asks for — measured 2026-09-14: `show()`/`set_focus()`
/// both returned `Ok`, the host logged "the shell window is focused", and the process
/// still reported `frontmost = false` with the editor in front (REQ-A232). So the host
/// **asks the platform** (`is_focused`) and reports what it found, instead of trusting
/// a call that cannot fail for the reason that matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LauncherFocus {
    /// The window is the key window: the model's starting state is true on screen.
    Focused,
    /// The platform took the calls but did not hand focus over (a background app).
    Refused,
    /// There is no Launcher window to focus.
    NoWindow,
}

/// The reading the shell-window fit is based on: `Some((was, fit))` when the shell is
/// still at the handset default and this class wants a different geometry, `None` when
/// the window must be left exactly as it is.
///
/// This is the *pure seam* the host hands its raw `inner_size()` +
/// `scale_factor()` numbers to. It exists because the composition — convert a
/// **physical** reading into **logical** pixels, then ask the policy — used to be
/// an inline expression inside a method that needs a real `AppHandle` and
/// therefore could not be tested at all; that composition is exactly what the
/// REQ-A218 DPI defect was (a 2× display reports 960×1640 physical for the 480×820
/// config default, so a comparison done in physical pixels would never fire).
///
/// Two refusals are deliberate:
/// * a garbage size (`0×0`, `NaN`, absurdly large) answers `None` **before** the
///   policy is consulted — it must never be mistaken for "the default" and
///   trigger a resize;
/// * an unusable scale factor (`NaN`, `0`, negative) answers `None` instead of
///   being treated as 1: `logical_size_of` treats it as 1 for the *layout*
///   path, but guessing here could make a 2× user's own window look like the
///   default and get fought.
pub fn shell_fit_reading(
    policy: LayoutPolicy,
    width: u32,
    height: u32,
    scale: f64,
) -> Option<(Size, ShellFit)> {
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let was = logical_size_of(f64::from(width), f64::from(height), scale)?;
    let fit = policy.shell_fit(was, SHELL_DEFAULT_WINDOW);
    if fit == ShellFit::Leave {
        return None;
    }
    Some((was, fit))
}

/// Where a window at `current` must move to sit inside `screen` under `policy` —
/// `None` when it is already fine (no call, no event, no windowing churn).
///
/// The **size** comes from the same domain rule that decides where a new window
/// opens (`LayoutPolicy::fit_window`), so the two cannot disagree; the **position**
/// is the user's (a drag must be respected unless it put the window off screen).
/// Pure, so the rule is testable without a window.
fn reclamp_target(policy: LayoutPolicy, current: Bounds, screen: Bounds) -> Option<Bounds> {
    let sized = policy.fit_window(Size::new(current.width, current.height), screen);
    let placed = Bounds::new(current.x, current.y, sized.width, sized.height).clamp_into(screen);
    (placed != current).then_some(placed)
}

/// A believable **signed** edge (logical px) or `None`: NaN/infinite/absurd
/// readings must never be turned into a window position (the unsigned counterpart
/// is [`sane_edge`], used for sizes).
fn sane_signed_edge(v: f64) -> Option<i32> {
    if !v.is_finite() {
        return None;
    }
    let rounded = v.round();
    let bound = f64::from(MAX_SCREEN_EDGE);
    if rounded < -bound || rounded > bound {
        return None;
    }
    Some(rounded as i32)
}

/// Is `label` the window that defines the **OS screen area** the layout
/// sub-divides? Only the Launcher/main window does: app windows (including split
/// panes) are placed *inside* that area, so a pane resize must never be mistaken
/// for a screen change — which would also make the pane-writing loop feed itself.
pub fn is_screen_window(label: &str) -> bool {
    label == LAUNCHER_LABEL
}

/// Longest title the shell may hand to the OS, in **characters** (not bytes).
///
/// A macOS title bar elides a long title on its own, so this is not about the
/// pixels: it bounds what the *window object* carries (and what the window menu,
/// the Dock's window list and a screen reader are handed) when the string did not
/// come from our own i18n — a store-installed app's display name comes from its
/// manifest (`lib/storeApps`), i.e. from a third party.
///
/// Characters rather than bytes on purpose: 120 CJK glyphs are a reasonable title,
/// 120 bytes of CJK would be 40.
pub const MAX_SHELL_TITLE_CHARS: usize = 120;

/// Normalize a title the shell asked the window to carry (pure; no I/O).
///
/// Rules, each with a named refusal instead of a silent edit:
///
/// * **trimmed** — leading/trailing whitespace is not part of a title;
/// * **empty refused** — a window with no title is worse than one with the previous
///   title: macOS draws an empty title bar, and the window menu/the Dock would show
///   a nameless window;
/// * **control characters refused** — a title is rendered on **one line** by the OS
///   (and read aloud by a screen reader): `\n`, `\t` or an escape sequence in a
///   title is either a bug or an injection. Refused with the offending `U+XXXX`, so
///   the cause is visible instead of a title that looks fine and behaves oddly;
/// * **truncated at [`MAX_SHELL_TITLE_CHARS`], with a visible `…`** — the one place
///   this function edits rather than refuses, and deliberately so: refusing a long
///   name would leave the *previous* app's name in the title bar while this app is
///   on screen, which is a wrong statement rather than a short one. The ellipsis is
///   the statement that something was left out.
///
/// Honest boundary: this is *shape* validation, not sanitization of meaning — the
/// host cannot know whether "Settings" is the right name; it only guarantees that
/// the string the OS renders is one line, non-empty and bounded.
pub fn normalize_shell_title(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(
            "a window title may not be empty (the OS draws an empty title bar)".to_string(),
        );
    }
    if let Some(bad) = trimmed.chars().find(|c| c.is_control()) {
        return Err(format!(
            "a window title may not contain a control character (U+{:04X}): the OS renders a title as one line",
            bad as u32
        ));
    }
    let mut title: String = trimmed.chars().take(MAX_SHELL_TITLE_CHARS).collect();
    if trimmed.chars().count() > MAX_SHELL_TITLE_CHARS {
        // Keep the last char slot for the marker, so the result is bounded *and*
        // visibly incomplete.
        title = title.chars().take(MAX_SHELL_TITLE_CHARS - 1).collect();
        title.push('…');
    }
    Ok(title)
}

/// Decode a window event into the **(physical width, physical height, new DPI)**
/// reading it carries, or `None` for events that cannot change the usable area.
///
/// `ScaleFactorChanged` is the reason this exists: it carries the new inner size
/// *because* the window has not been resized yet at that moment, so a handler that
/// re-read `inner_size()` would pair the **new** scale factor with the **old**
/// size and compute a wrong logical screen (a 2× monitor would look twice as
/// wide as it is). Using the event's own numbers removes that mistake by
/// construction, and keeping the decoding here — instead of inline in the event
/// handler — makes it unit-testable (Power of 10 #9: assert what you can).
pub fn resize_reading(event: &tauri::WindowEvent) -> Option<(u32, u32, Option<f64>)> {
    match event {
        tauri::WindowEvent::Resized(size) => Some((size.width, size.height, None)),
        tauri::WindowEvent::ScaleFactorChanged {
            scale_factor,
            new_inner_size,
            ..
        } => Some(dpi_change_reading(
            new_inner_size.width,
            new_inner_size.height,
            *scale_factor,
        )),
        _ => None,
    }
}

/// The reading a DPI change implies, from the event's **own** new size and factor.
///
/// Split out because [`tauri::WindowEvent`]'s `ScaleFactorChanged` variant is
/// `#[non_exhaustive]`: a test cannot construct that event, so the arm's contract —
/// **it must always report the new factor**, never `None` (a `None` would send the
/// handler back to the window's stale scale factor, silently restoring the very
/// bug this path exists to remove) — is pinned through this function instead.
pub fn dpi_change_reading(width: u32, height: u32, scale: f64) -> (u32, u32, Option<f64>) {
    (width, height, Some(scale))
}

impl Default for WmState {
    fn default() -> Self {
        Self::new()
    }
}

impl WmState {
    /// Create the manager for this host: resolve the form factor from the build's
    /// own class plus `AMOS_FORM_FACTOR`, then build the state for it.
    pub fn new() -> Self {
        let built_for = built_for_form_factor();
        let raw = std::env::var(FORM_FACTOR_ENV).ok();
        let (form, source, unusable) = resolve_host_form_factor(built_for, raw.as_deref());
        if let Some(message) = unusable {
            tracing::warn!(
                hint = %FORM_FACTOR_ENV,
                %message,
                fallback = form.as_str(),
                "unusable form-factor hint; falling back to the build's own class"
            );
        }
        tracing::info!(
            form = form.as_str(),
            source = source.as_str(),
            ui = form.has_ui(),
            "windowing form factor resolved"
        );
        Self::with_form_factor(form)
    }

    /// Create a manager for an **explicitly given** class (no environment read, no
    /// guessing). `new()` resolves the hint and delegates here; tests and any
    /// embedder that already knows its class use it directly.
    ///
    /// The Launcher is bound to the Tauri main window.
    // `WindowManager::new()` registers the Launcher synchronously, so
    // `launcher()` is always Some here; this single documented invariant-site is
    // allowed (P0-1), everything else in production is gated.
    #[allow(clippy::expect_used)]
    pub fn with_form_factor(form: FormFactor) -> Self {
        let wm = WindowManager::new(); // registers + focuses the Launcher
        let launcher = wm.launcher().expect("launcher always registered");
        let mut labels = HashMap::new();
        let mut by_label = HashMap::new();
        let mut kinds = HashMap::new();
        labels.insert(launcher, LAUNCHER_LABEL.to_string());
        by_label.insert(LAUNCHER_LABEL.to_string(), launcher);
        kinds.insert(launcher, WindowKind::Launcher.to_string());
        Self {
            inner: Mutex::new(WmCore {
                wm,
                labels,
                by_label,
                kinds,
                external: HashSet::new(),
                screen: FALLBACK_SCREEN,
                split: None,
                policy: LayoutPolicy::of(form),
                shell_fit: None,
            }),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, WmCore>, String> {
        self.inner.lock().map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn new_for_test(form: FormFactor) -> Self {
        Self::with_form_factor(form)
    }

    /// Label for a window id, if registered.
    fn label_for(&self, id: WindowId) -> Result<String, String> {
        self.lock()?
            .labels
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("unknown window id {id:?}"))
    }

    fn real_window(&self, app: &AppHandle, id: WindowId) -> Result<tauri::WebviewWindow, String> {
        let label = self.label_for(id)?;
        app.get_webview_window(&label)
            .ok_or_else(|| format!("window '{label}' does not exist"))
    }

    /// How many **app** windows this host currently has registered.
    ///
    /// The Launcher and external container surfaces are not app windows: a phone's
    /// single fullscreen app window is the rule, and neither the shell nor a
    /// container surface is one.
    fn app_window_count(core: &WmCore) -> usize {
        let app = WindowKind::App.to_string();
        core.kinds.values().filter(|k| **k == app).count()
    }

    /// May this host register one more app window?
    ///
    /// The answer comes from the class's policy ([`LayoutPolicy::check_app_window`])
    /// and nowhere else; the message names the class and the count (a bare "no" is
    /// not a refusal an operator can act on). Called by **both** the production path
    /// ([`WmState::open`]) and the test seam ([`WmState::register_app`]) so they
    /// cannot drift, and called **before** any registration so a refusal leaves no
    /// state behind.
    fn check_new_app_window(core: &WmCore) -> Result<(), String> {
        core.policy
            .check_app_window(Self::app_window_count(core))
            .map_err(|refusal| refusal.to_string())
    }

    /// Keep every visible app window inside a (possibly shrunken) screen.
    ///
    /// `Ok(n)` = how many windows were moved/resized; `Ok(0)` = nothing had to move.
    ///
    /// Why read the platform instead of keeping a per-window ledger: the user can drag
    /// and resize an app window themselves, so a ledger the host maintains would be a
    /// second truth that drifts the moment the user touches a window. The platform is
    /// the only source that is *already* right.
    ///
    /// Boundaries (honest):
    ///   * the Launcher **is** the screen, so it is never moved;
    ///   * external container surfaces own their geometry (Wayland/DMA-BUF) — skipped;
    ///   * hidden windows are skipped (nothing on screen to rescue);
    ///   * an unreadable/garbage geometry is skipped and **counted** in the log rather
    ///     than being replaced by a guess.
    pub fn reclamp_windows(&self, app: &AppHandle) -> Result<usize, String> {
        let (screen, policy, targets) = {
            let core = self.lock()?;
            let targets: Vec<(WindowId, String)> = core
                .wm
                .windows()
                .into_iter()
                .filter(|id| !core.external.contains(id))
                .filter(|id| core.wm.state_of(*id) != Some(amos_wm::WindowState::Hidden))
                .filter_map(|id| core.labels.get(&id).map(|l| (id, l.clone())))
                .filter(|(_, label)| !is_screen_window(label))
                .collect();
            (core.screen, core.policy, targets)
        };

        let mut moved = 0usize;
        let mut unreadable = 0usize;
        for (_id, label) in targets {
            let Some(window) = app.get_webview_window(&label) else {
                unreadable += 1;
                continue;
            };
            let scale = window.scale_factor().unwrap_or(1.0);
            let Some(size) = window
                .inner_size()
                .ok()
                .and_then(|s| logical_size_of(f64::from(s.width), f64::from(s.height), scale))
            else {
                unreadable += 1;
                continue;
            };
            let Some(pos) = window.outer_position().ok().map(|p| {
                let effective = if scale.is_finite() && scale > 0.0 {
                    scale
                } else {
                    1.0
                };
                (p.x as f64 / effective, p.y as f64 / effective)
            }) else {
                unreadable += 1;
                continue;
            };
            let Some(x) = sane_signed_edge(pos.0) else {
                unreadable += 1;
                continue;
            };
            let Some(y) = sane_signed_edge(pos.1) else {
                unreadable += 1;
                continue;
            };

            let current = Bounds::new(x, y, size.width, size.height);
            let Some(target) = reclamp_target(policy, current, screen) else {
                continue; // already fully on screen and no smaller than the class minimum
            };
            let applied = window
                .set_position(tauri::LogicalPosition::new(
                    f64::from(target.x),
                    f64::from(target.y),
                ))
                .and_then(|()| {
                    window.set_size(tauri::LogicalSize::new(
                        f64::from(target.width),
                        f64::from(target.height),
                    ))
                });
            match applied {
                Ok(()) => {
                    moved += 1;
                    tracing::info!(
                        window = %label,
                        from_x = current.x,
                        from_y = current.y,
                        to_x = target.x,
                        to_y = target.y,
                        width = target.width,
                        height = target.height,
                        "an app window was pulled back inside the shrunken screen"
                    );
                }
                Err(e) => tracing::warn!(
                    window = %label,
                    error = %e,
                    "an app window is outside the screen and could not be moved"
                ),
            }
        }

        if unreadable > 0 {
            tracing::warn!(
                unreadable,
                "some app windows could not be measured; they were left where they are"
            );
        }
        Ok(moved)
    }

    /// Open (create-if-needed + focus) the window addressed by `label`.
    pub fn open(&self, app: &AppHandle, label: &str) -> Result<Vec<WmEvent>, String> {
        let events = {
            let mut core = self.lock()?;
            let (id, mut events) = match core.by_label.get(label) {
                Some(id) => (*id, Vec::new()),
                None => {
                    // The class may host only so many app windows (`multi_window`),
                    // and this is asked **before** anything is registered: a refused
                    // window must leave no trace in the model. (An earlier version
                    // checked after registering, so the state machine kept an app
                    // window with no real window behind it — and returned an error
                    // on top of that.)
                    Self::check_new_app_window(&core)?;
                    let (id, created) = core.wm.register(WindowKind::App);
                    core.labels.insert(id, label.to_string());
                    core.by_label.insert(label.to_string(), id);
                    core.kinds.insert(id, WindowKind::App.to_string());
                    (id, created)
                }
            };
            events.extend(core.wm.open(id));
            events
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Focus an already-registered window.
    pub fn focus(&self, app: &AppHandle, label: &str) -> Result<Vec<WmEvent>, String> {
        let events = {
            let mut core = self.lock()?;
            let id = *core
                .by_label
                .get(label)
                .ok_or_else(|| format!("window '{label}' is not registered"))?;
            core.wm.focus(id)
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Hide a registered window.
    pub fn hide(&self, app: &AppHandle, label: &str) -> Result<Vec<WmEvent>, String> {
        let events = {
            let mut core = self.lock()?;
            let id = *core
                .by_label
                .get(label)
                .ok_or_else(|| format!("window '{label}' is not registered"))?;
            core.wm.hide(id)
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Close a registered window (Launcher is a no-op, as enforced by `amos-wm`) and
    /// restore whatever a closed split pane leaves behind.
    pub fn close(&self, app: &AppHandle, label: &str) -> Result<Vec<WmEvent>, String> {
        let (events, split_survivor) = self.close_core(label)?;
        self.apply(app, &events)?;
        // A split whose pane window was closed has ended (see `close_core`): the
        // surviving pane must not stay at half-screen geometry with no split left to
        // explain it — the same restoration `wm_split_exit` performs.
        if let Some(survivor) = split_survivor {
            if let Some(w) = app.get_webview_window(&survivor) {
                window_maximize(&w);
            }
        }
        Ok(events)
    }

    /// The state half of [`WmState::close`]: drop the window from the state machine
    /// **and** from this host's registries, returning the events plus the label of a
    /// split's surviving pane when this close ended the split.
    ///
    /// A closed window must leave **no** trace: `amos-wm` removes it, and this host
    /// used to keep its `label ⇄ id` mapping forever. Consequences were real, not
    /// theoretical — `open_surface` (the Android APK launch path, see
    /// `ai_bridge.rs`) short-circuits on a label it already knows, so after the LMK
    /// tore a surface down (`lib/lmk.ts` → `wm_close`), **re-launching that same app
    /// re-focused a dead id and registered nothing**: the container ran with no
    /// surface in the window manager and the shell said nothing (REQ-A227). A split
    /// holding the closed window is ended for the same reason it cannot survive a
    /// screen that no longer fits: a pane whose window is gone cannot be placed.
    fn close_core(&self, label: &str) -> Result<(Vec<WmEvent>, Option<String>), String> {
        let mut core = self.lock()?;
        let id = *core
            .by_label
            .get(label)
            .ok_or_else(|| format!("window '{label}' is not registered"))?;
        // Which split (if any) this window is part of — remembered before the window
        // is removed, so the *surviving* pane's label can be handed back.
        let survivor = core.split.as_ref().and_then(|sp| {
            if sp.primary == id {
                core.labels.get(&sp.secondary).cloned()
            } else if sp.secondary == id {
                core.labels.get(&sp.primary).cloned()
            } else {
                None
            }
        });
        let events = core.wm.close(id);
        if survivor.is_some() {
            core.split = None;
        }
        // No stale registration: otherwise a later launch of the same label silently
        // no-ops (`focus` on an id the state machine no longer has) and the debug card
        // would keep a name for a window that is gone.
        core.by_label.remove(label);
        core.labels.remove(&id);
        core.kinds.remove(&id);
        core.external.remove(&id);
        Ok((events, survivor))
    }

    /// Return to the Launcher (home).
    pub fn home(&self, app: &AppHandle) -> Result<Vec<WmEvent>, String> {
        let events = { self.lock()?.wm.home() };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Whether `id` is an external surface (no real Tauri window behind it).
    fn is_external(&self, id: WindowId) -> bool {
        self.lock()
            .map(|c| c.external.contains(&id))
            .unwrap_or(false)
    }

    /// Register an external surface (e.g. a legacy Android APK's composited
    /// surface) as a `System` window in the state machine, focused on top. No
    /// `WebviewWindow` is created — the surface is composited separately
    /// (Waydroid Wayland/DMA-BUF), but it *does* participate in focus/z-order
    /// and shows up in `wm_windows`.
    pub fn open_surface(&self, label: &str) -> Result<(), String> {
        {
            let mut core = self.lock()?;
            // Reuse an existing surface window bound to this label if present.
            if let Some(id) = core.by_label.get(label).copied() {
                core.wm.focus(id);
                return Ok(());
            }
            let (id, mut events) = core.wm.register(WindowKind::System);
            core.labels.insert(id, label.to_string());
            core.by_label.insert(label.to_string(), id);
            core.kinds.insert(id, WindowKind::System.to_string());
            core.external.insert(id);
            events.extend(core.wm.open(id));
        }
        Ok(())
    }

    /// Register a **host-owned** window without an `AppHandle` (unit tests only).
    ///
    /// This is the registration [`WmState::open`] performs on first use: a real
    /// `WindowKind::App` window bound to `label`. It deliberately does **not** use
    /// [`WmState::open_surface`] — an external container surface is not a window this
    /// host can place, which is exactly what the split rules are about (REQ-A226), so
    /// state-machine tests must not have to borrow that shape to get two windows.
    #[cfg(test)]
    fn register_app(&self, label: &str) -> Result<(), String> {
        let mut core = self.lock()?;
        if core.by_label.contains_key(label) {
            return Ok(());
        }

        // The same policy question `open` asks (one rule, one place): a test cannot
        // register a window the real host would refuse.
        Self::check_new_app_window(&core)?;

        let (id, _created) = core.wm.register(WindowKind::App);
        core.labels.insert(id, label.to_string());
        core.by_label.insert(label.to_string(), id);
        core.kinds.insert(id, WindowKind::App.to_string());
        core.wm.open(id);
        Ok(())
    }

    /// Mirror a batch of state-machine events onto the real windows.
    fn apply(&self, app: &AppHandle, events: &[WmEvent]) -> Result<(), String> {
        for e in events {
            match *e {
                WmEvent::Created(id) => {
                    if self.is_external(id) {
                        continue; // external surfaces have no WebviewWindow
                    }
                    let label = self.label_for(id)?;
                    if app.get_webview_window(&label).is_none() {
                        // The class decides how big a new app window opens: a PC must
                        // not open a 480×820 handset slab (the value was hard-coded
                        // here before the form-factor domain), and the window never
                        // exceeds the screen it will be drawn on. One lock for both
                        // facts, so they cannot disagree.
                        let (policy, screen) = {
                            let core = self.lock()?;
                            (core.policy, core.screen)
                        };
                        let opens_at = policy.initial_window_in(screen);

                        // Load the app entry with a `#window=` fragment so the boot
                        // script auto-navigates to that app's screen.
                        let url = WebviewUrl::App(format!("{APP_ENTRY}#window={label}").into());
                        // On desktop, hide the native title bar so the app window
                        // renders edge-to-edge (REQ-A249 / PC_DESKTOP_ARCHITECTURE.md §4.3).
                        // `mut` is only used by the desktop-gated line below.
                        #[cfg_attr(not(desktop), allow(unused_mut))]
                        let mut builder = WebviewWindowBuilder::new(app, label.clone(), url)
                            .title(app_window_title(&label))
                            .inner_size(f64::from(opens_at.width), f64::from(opens_at.height))
                            // G5: the class decides whether the user may freely
                            // resize, and how small the window may get.
                            .resizable(policy.free_resize)
                            .min_inner_size(
                                f64::from(policy.min_pane.width),
                                f64::from(policy.min_pane.height),
                            );
                        // macOS title-bar overlay (REQ-A249 / PC_DESKTOP_ARCHITECTURE.md
                        // §4.3). `title_bar_style` exists on desktop Tauri only: on
                        // Android/iOS the method is absent, so a *runtime*
                        // `FormFactor::Desktop` guard is not enough — the call still has
                        // to resolve at compile time. Ungated, this single line broke
                        // `make android-app` for the whole APK with E0599 (measured
                        // 2026-09-16; see FMEA F-WM-019). Same host pattern as
                        // `window_maximize` above: a cross-target no-op.
                        #[cfg(desktop)]
                        if policy.form == FormFactor::Desktop {
                            builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
                        }
                        builder
                            .build()
                            .map_err(|e| format!("failed to create window '{label}': {e}"))?;
                    }
                }
                WmEvent::Closed(id) => {
                    if self.is_external(id) {
                        continue; // nothing to close on the host side
                    }
                    if let Some(w) = self
                        .label_for(id)
                        .ok()
                        .and_then(|l| app.get_webview_window(&l))
                    {
                        let _ = w.close();
                    }
                }
                WmEvent::Shown(id) => {
                    if self.is_external(id) {
                        continue;
                    }
                    self.real_window(app, id)?
                        .show()
                        .map_err(|e| e.to_string())?;
                }
                WmEvent::Hidden(id) => {
                    if self.is_external(id) {
                        continue;
                    }
                    self.real_window(app, id)?
                        .hide()
                        .map_err(|e| e.to_string())?;
                }
                WmEvent::FocusChanged(Some(id)) => {
                    if self.is_external(id) {
                        continue;
                    }
                    let _ = self.real_window(app, id)?.set_focus();
                    // Write the focused app label to the shared store so the desktop
                    // TopBar can render the active app's menu.  This mirrors the same
                    // pattern the System UI already uses for settings / notifications:
                    // the host owns the authoritative store, not any one WebView.
                    if let Some(label) = self.lock()?.labels.get(&id).cloned() {
                        if let Some(store) = app.try_state::<SharedStore>() {
                            // One source: `SharedStore::set` already broadcasts
                            // `store-updated` to every window, and the desktop
                            // TopBar reads the key from there
                            // (`lib/wm.ts::APP_FOCUSED_KEY` → `createStoreValue`).
                            // A second, purpose-built `emit` was tried and removed:
                            // `scripts/tauri-event-scan.mjs` reported it as "emitted
                            // by the host but no screen subscribes to it" — and it
                            // was right, the frontend deliberately reads the store.
                            store.set(app, APP_FOCUSED_KEY, serde_json::json!(&label).to_string());
                        }
                    }
                }
                // Nothing focused: leave windowing as-is (Launcher stays visible).
                WmEvent::FocusChanged(None) => {}
            }
        }
        Ok(())
    }

    /// Serializable snapshot of the current windowing state.
    pub fn snapshot(&self) -> Result<WmSnapshot, String> {
        let core = self.lock()?;
        let focused = core.wm.focused();
        let windows = core
            .wm
            .windows()
            .into_iter()
            .map(|id| WindowInfo {
                id: id.0,
                label: core.labels.get(&id).cloned().unwrap_or_default(),
                kind: core
                    .kinds
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| "Unknown".to_string()),
                state: core
                    .wm
                    .state_of(id)
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                focused: Some(id) == focused,
                external: core.external.contains(&id),
            })
            .collect();
        Ok(WmSnapshot {
            focused: focused.map(|id| id.0),
            windows,
        })
    }

    /// The full OS window area the split layout sub-divides (0,0 origin).
    pub fn screen(&self) -> Result<Bounds, String> {
        Ok(self.lock()?.screen)
    }

    /// Set the full window area used for split layout. If a split is active it is
    /// kept only when its divider still fits the new screen; otherwise the split
    /// ends (honest — never silently re-clamped).
    ///
    /// Always answers with the current snapshot: this is the **explicit** command
    /// path (the caller asked, so it gets an answer). The re-measurement path uses
    /// [`WmState::sync_screen`], which stays silent when nothing changed.
    pub fn set_screen(&self, width: u32, height: u32) -> Result<LayoutSnapshot, String> {
        match self.sync_screen(Bounds::new(0, 0, width, height))? {
            Some(snapshot) => Ok(snapshot),
            None => self.layout_snapshot(),
        }
    }

    /// Apply a measured screen rect to the layout model, returning the new
    /// snapshot — or `None` when the rect is unchanged, so a caller that
    /// re-measures on every window-resize tick does not emit a storm of
    /// `layout-changed` events (the same "only report a real change" rule the
    /// power governor's DVFS ticker follows). A split that no longer fits ends.
    pub fn sync_screen(&self, screen: Bounds) -> Result<Option<LayoutSnapshot>, String> {
        // One place decides what a screen change does to a live split.
        let clamped = Bounds::new(0, 0, screen.width.max(1), screen.height.max(1));
        {
            let mut core = self.lock()?;
            if core.screen == clamped {
                return Ok(None);
            }
            core.screen = clamped;
            if let Some(s) = core.split.as_mut() {
                if !s.set_screen(clamped) {
                    core.split = None;
                }
            }
        }
        Ok(Some(self.layout_snapshot()?))
    }

    /// Measure the real OS window (the Launcher/main window): its **physical**
    /// size plus DPI scale.
    ///
    /// Private because the only safe way to use it is via
    /// [`WmState::sync_window_layout`] — and **not** from a `ScaleFactorChanged`
    /// handler, where the window has not caught up yet (see [`resize_reading`]).
    fn window_reading(app: &AppHandle) -> Result<Option<(u32, u32, f64)>, String> {
        let Some(window) = app.get_webview_window(LAUNCHER_LABEL) else {
            return Ok(None);
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window.inner_size().map_err(|e| e.to_string())?;
        Ok(Some((size.width, size.height, scale)))
    }

    /// Apply a **physical** window reading (pixels + DPI) to the layout model.
    ///
    /// The one place that turns a measurement into the model's screen: it converts
    /// to logical pixels, and — only when the logical area really changed — updates
    /// the model, re-applies any live split to the real windows and broadcasts
    /// `layout-changed`. Returns the new snapshot, or `None` for a no-op reading.
    pub fn sync_from_pixels(
        &self,
        width: u32,
        height: u32,
        scale: f64,
        app: &AppHandle,
    ) -> Result<Option<LayoutSnapshot>, String> {
        let measured = logical_screen(f64::from(width), f64::from(height), scale, self.screen()?);
        let Some(snapshot) = self.sync_screen(measured)? else {
            return Ok(None);
        };
        tracing::info!(
            width = snapshot.screen_w,
            height = snapshot.screen_h,
            scale,
            columns = snapshot.columns,
            "layout screen re-measured from the OS window"
        );
        finish_layout(app, self, &snapshot)?;
        Ok(Some(snapshot))
    }

    /// Re-measure the screen window and sync the layout model to it.
    ///
    /// `Ok(None)` means "unchanged" **or** "no window to measure yet"; the latter
    /// is reported at `debug` because the model then still holds
    /// [`FALLBACK_SCREEN`], a placeholder and **not** a claim about the screen. A
    /// failed read is an error, never a silent fallback.
    ///
    /// Call this at boot. For resize events, decode the event with
    /// [`resize_reading`] and pass those numbers to [`WmState::sync_from_pixels`].
    pub fn sync_window_layout(&self, app: &AppHandle) -> Result<Option<LayoutSnapshot>, String> {
        match Self::window_reading(app)? {
            Some((width, height, scale)) => self.sync_from_pixels(width, height, scale, app),
            None => {
                tracing::debug!(
                    label = LAUNCHER_LABEL,
                    "no window to measure yet; the layout keeps its fallback screen"
                );
                Ok(None)
            }
        }
    }

    /// Apply this class's shell geometry when the window is still at the handset
    /// default — the one geometry the host may replace — and report `(was, fit)`. Any
    /// other size is somebody's choice and is left exactly as it is
    /// ([`shell_fit_reading`]).
    ///
    /// The pair is what the host **requested**: `set_size`/`maximize` hand the platform
    /// an instruction, and the authoritative geometry is whatever the next measurement
    /// ([`WmState::sync_window_layout`]) reads back — which is why the boot log says
    /// "requested" rather than "is now".
    pub fn fit_shell_window(&self, app: &AppHandle) -> Result<Option<(Size, ShellFit)>, String> {
        let Some(window) = app.get_webview_window(LAUNCHER_LABEL) else {
            return Ok(None);
        };
        // Without a scale factor the *physical* reading cannot be compared with the
        // *logical* config default. The honest answer is "do nothing": assuming 1×
        // could make a 2× user's own window look like the default and get fought.
        let scale = match window.scale_factor() {
            Ok(scale) => scale,
            Err(e) => {
                tracing::warn!(
                    target: "amos::wm",
                    error = %e,
                    "could not read the shell window's scale factor; leaving its size alone"
                );
                return Ok(None);
            }
        };
        let size = window.inner_size().map_err(|e| e.to_string())?;
        // The config value is logical px and `inner_size()` is physical, so the
        // comparison happens in logical pixels (the same space the panes use) —
        // inside the pure seam, where it is unit-tested.
        let Some((was, fit)) =
            shell_fit_reading(self.lock()?.policy, size.width, size.height, scale)
        else {
            return Ok(None);
        };
        match fit {
            // A PC shell fills the desktop it runs on (REQ-A233): the *platform* owns the
            // usable area (menu bar, Dock, notches), so this is `maximize`, not a size the
            // host would have to guess — and a guessed size is exactly how the shell used
            // to end up as a slab that overhung the desktop's edge.
            ShellFit::Maximize => window_maximize(&window),
            ShellFit::Resize(now) => window
                .set_size(tauri::LogicalSize::new(
                    f64::from(now.width),
                    f64::from(now.height),
                ))
                .map_err(|e| e.to_string())?,
            ShellFit::Leave => return Ok(None), // unreachable: the seam already filtered
        }
        // Remember an *exact* request: `set_size` is only a request to the platform (and
        // it is **asynchronous** — measured on macOS, the very next `inner_size()` still
        // reports the old 480×820 for ~50 ms), so the *answer* is the next real
        // measurement. [`WmState::note_applied_size`] compares them and reports honestly
        // (REQ-A230). A `Maximize` has no exact size to compare against — the measurement
        // reports the area the platform chose, and nothing is claimed beyond that.
        self.lock()?.shell_fit = match fit {
            ShellFit::Resize(now) => Some(now),
            _ => None,
        };
        Ok(Some((was, fit)))
    }

    /// Report the size the OS **applied** to the shell window — called from the
    /// resize-event path, whose measurement is post-application by construction —
    /// against the size [`WmState::fit_shell_window`] asked for, if one is outstanding.
    ///
    /// `Ok(None)` means "nothing to report": no outstanding request (a user's own later
    /// resize says nothing about our request), or a previous event already answered it.
    /// The comparison is [`shell_fit_outcome`], so the decision itself is unit-tested.
    pub fn note_applied_size(&self, applied: Size) -> Result<Option<ShellFitOutcome>, String> {
        let mut core = self.lock()?;
        let Some(requested) = core.shell_fit.take() else {
            return Ok(None);
        };
        Ok(Some(shell_fit_outcome(requested, applied)))
    }

    /// Test seam: stage an outstanding shell-size request without a window.
    #[cfg(test)]
    fn set_shell_fit(&self, size: Size) -> Result<(), String> {
        self.lock()?.shell_fit = Some(size);
        Ok(())
    }

    /// Apply the state machine's own starting invariant to the **real** window: the
    /// Launcher is `Focused` from boot (`launcher_is_focused_on_start`), and this adapter's
    /// module doc promises `FocusChanged(Some(id)) → set_focus()` — but nothing ever told
    /// the OS at boot, so a shell started from a background process stayed *behind* other
    /// apps: the window existed, rendered, and the user could not see it (REQ-A232).
    ///
    /// A platform failure is an `Err`; "the platform refused to focus" is **not** an error
    /// but a fact the caller must report (see [`LauncherFocus`]).
    pub fn focus_launcher(&self, app: &AppHandle) -> Result<LauncherFocus, String> {
        let Some(window) = app.get_webview_window(LAUNCHER_LABEL) else {
            return Ok(LauncherFocus::NoWindow);
        };
        // `show` first: a hidden window would swallow the focus request, and the intent at
        // boot is "the shell is on screen **and** in front".
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        // Ask the platform rather than trusting the call.
        let focused = window.is_focused().map_err(|e| e.to_string())?;
        Ok(if focused {
            LauncherFocus::Focused
        } else {
            LauncherFocus::Refused
        })
    }

    /// Enter a split between two registered, distinct, non-Launcher windows.
    pub fn enter_split(&self, a: &str, b: &str, axis: &str) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        // A class with no user interface has nothing to split: refuse honestly
        // instead of returning a snapshot that implies a screen nobody sees.
        if !core.policy.form.has_ui() {
            return Err(format!(
                "form factor '{}' has no user interface to split",
                core.policy.form
            ));
        }
        let ia = *core
            .by_label
            .get(a)
            .ok_or_else(|| format!("window '{a}' is not registered"))?;
        let ib = *core
            .by_label
            .get(b)
            .ok_or_else(|| format!("window '{b}' is not registered"))?;
        if ia == ib {
            return Err("cannot split a window with itself".to_string());
        }
        if core.kinds.get(&ia).map(String::as_str) == Some("Launcher")
            || core.kinds.get(&ib).map(String::as_str) == Some("Launcher")
        {
            return Err("the Launcher cannot be split".to_string());
        }
        // NOTE (REQ-A226): this accepts **any** two registered, non-Launcher windows —
        // including an external container surface, whose geometry the container owns.
        // That is deliberate: the split is the *model* describing where the two windows
        // belong (the placer already says "its geometry is owned elsewhere / comes
        // later"), and a stricter refusal here would need a registration seam that only
        // tests use. What must never happen is **offering** an unplaceable window, and
        // that is enforced where the offer is made — [`pane_candidates`] (the
        // `wm_split_candidates` command *and* the snapshot field) — plus
        // [`WmState::apply_split_to_real`], which now **reports** a pane it cannot place
        // instead of skipping it silently.
        let axis = match parse_axis(axis)? {
            Some(explicit) => explicit,
            // `"auto"`: let the policy pick from the screen's aspect instead of
            // making every caller hard-code an orientation (tablet/desktop shells
            // rotate; a phone does not).
            None => core
                .policy
                .split_axis(Size::new(core.screen.width, core.screen.height)),
        };
        let screen = core.screen;
        let policy = core.policy;
        let sp = SplitScreen::new(ia, ib, screen, axis, policy.divider_gap, policy.min_pane)
            .ok_or_else(|| "screen too small to split those two windows".to_string())?;
        core.split = Some(sp);
        layout_core(&core)
    }

    /// Set the divider so the primary pane takes `percent` (1..=99).
    pub fn split_resize(&self, percent: u32) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        let sp = core
            .split
            .as_mut()
            .ok_or_else(|| "no active split".to_string())?;
        if !sp.resize_to(percent) {
            return Err(
                "that divider share is not feasible at the current minimum size".to_string(),
            );
        }
        layout_core(&core)
    }

    /// Move the divider by `delta` percentage points.
    pub fn split_move(&self, delta: i32) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        let sp = core
            .split
            .as_mut()
            .ok_or_else(|| "no active split".to_string())?;
        if !sp.resize_by(delta) {
            return Err(
                "that divider move is not feasible at the current minimum size".to_string(),
            );
        }
        layout_core(&core)
    }

    /// Swap which window is in the primary (first) pane.
    pub fn split_swap(&self) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        let sp = core
            .split
            .as_mut()
            .ok_or_else(|| "no active split".to_string())?;
        sp.swap();
        layout_core(&core)
    }

    /// End the active split (windows return to fullscreen / previous layout).
    pub fn split_exit(&self) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        core.split = None;
        layout_core(&core)
    }

    /// Apply the active split's pane rects to the **real** Tauri windows: each pane
    /// window is moved/resized to its bounds. External or not-yet-created windows
    /// are skipped (their geometry is owned elsewhere / comes later). No-op when
    /// there is no active split. Best-effort — a window that fails to resize is
    /// **reported** rather than aborting the whole layout (REQ-A147): the layout model
    /// then says the split is in place while the screen shows the old geometry.
    ///
    /// G5: enforces `min_pane` constraint on every pane rect before applying it.
    pub fn apply_split_to_real(&self, app: &AppHandle) -> Result<(), String> {
        let snapshot = self.layout_snapshot()?;
        let Some(info) = &snapshot.split else {
            return Ok(());
        };
        let min_pane = {
            let core = self.lock()?;
            core.policy.min_pane
        };
        for pane in &info.panes {
            let Some(window) = app.get_webview_window(&pane.label) else {
                // Reported, not silent: the pane is in the model but nothing on screen
                // moved. Since `enter_split` refuses container surfaces (REQ-A226) this
                // is a window that has not been created yet (or whose creation failed),
                // which is exactly the kind of gap a silent `continue` hides.
                tracing::warn!(
                    pane = %pane.label,
                    "split pane has no window to place; the screen does not match the layout model"
                );
                continue;
            };
            // G5: enforce minimum pane size (REQ-A256)
            let bounds = amos_wm::layout::Bounds::new(pane.x, pane.y, pane.width, pane.height);
            let enforced = bounds.enforce_min(min_pane);

            let resized = window
                .set_position(tauri::LogicalPosition::new(
                    enforced.x as f64,
                    enforced.y as f64,
                ))
                .and_then(|()| {
                    window.set_size(tauri::LogicalSize::new(
                        enforced.width as f64,
                        enforced.height as f64,
                    ))
                });
            if let Err(e) = resized {
                tracing::warn!(
                    pane = %pane.label,
                    error = %e,
                    "the split layout could not be applied to this window; \
                     the screen does not match the layout model"
                );
            }
        }
        Ok(())
    }

    /// The two window labels in the active split, if any (pane order: primary,
    /// secondary). Used by the host to restore those windows when the split ends.
    pub fn split_labels(&self) -> Result<Option<(String, String)>, String> {
        let core = self.lock()?;
        Ok(match &core.split {
            Some(sp) => match (
                core.labels.get(&sp.primary).cloned(),
                core.labels.get(&sp.secondary).cloned(),
            ) {
                (Some(a), Some(b)) => Some((a, b)),
                _ => None,
            },
            None => None,
        })
    }

    /// The labels the host offers for entering a split (front two shown windows that
    /// are **this host's own** — see [`pane_candidates`]).
    pub fn split_candidates_labels(&self) -> Result<Vec<String>, String> {
        let core = self.lock()?;
        Ok(pane_candidates(&core))
    }

    /// App-free snapshot of the current layout state.
    pub fn layout_snapshot(&self) -> Result<LayoutSnapshot, String> {
        let core = self.lock()?;
        layout_core(&core)
    }
}

/// Serializable view of a single window (enums aren't ergonomic over IPC).
#[derive(Serialize, Clone, Debug)]
pub struct WindowInfo {
    pub id: u64,
    pub label: String,
    pub kind: String,
    pub state: String,
    pub focused: bool,
    /// True when this is an external composited surface (no WebviewWindow).
    pub external: bool,
}

/// Serializable view of the whole windowing state.
#[derive(Serialize, Clone, Debug)]
pub struct WmSnapshot {
    pub focused: Option<u64>,
    pub windows: Vec<WindowInfo>,
}

// ---- Multi-window layout (screen + split) — state + commands ----

/// Serializable pane rect for one split window.
#[derive(Serialize, Clone, Debug)]
pub struct PaneLayout {
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Serializable view of an active split session.
#[derive(Serialize, Clone, Debug)]
pub struct SplitLayoutInfo {
    /// `"vertical"` (left/right) or `"horizontal"` (top/bottom).
    pub axis: String,
    /// First pane's share of the usable extent (1..=99).
    pub percent: u32,
    /// Window in the first (primary) pane.
    pub primary: String,
    /// Window in the second pane.
    pub secondary: String,
    /// The two pane rects (index 0 = primary).
    pub panes: Vec<PaneLayout>,
}

/// Serializable snapshot of the layout sub-state.
#[derive(Serialize, Clone, Debug)]
pub struct LayoutSnapshot {
    pub screen_w: u32,
    pub screen_h: u32,
    /// The active split, if any.
    pub split: Option<SplitLayoutInfo>,
    /// The labels the host offers for entering a split: the front two shown windows
    /// **this host owns** (a container surface has no window to place, so it is never
    /// offered — REQ-A226). Identical to `wm_split_candidates`' answer.
    pub candidates: Vec<String>,
    /// The form factor this host resolved at startup — `"phone"`, `"tablet"`,
    /// `"desktop"` or `"robot"` (wire key = `amos_wm::form::FormFactor::as_str`).
    /// The shell must read its capabilities from here instead of guessing from the
    /// WebView width: a phone and a tablet are the *same* build.
    pub form: String,
    /// Content columns the current screen width supports (1..=4). This is the
    /// **runtime** phone-vs-tablet signal (`LayoutPolicy::columns_for`).
    pub columns: u8,
    /// May this class show more than one app window at once?
    pub multi_window: bool,
    /// May the user freely move/resize windows on this class?
    pub free_resize: bool,
    /// Divider width between two split panes (px).
    pub divider_gap: u32,
}

/// Parse a `wm_split` axis argument. `Ok(None)` means `"auto"`: the caller lets
/// the form-factor policy choose from the screen's aspect.
fn parse_axis(s: &str) -> Result<Option<SplitAxis>, String> {
    match s {
        "vertical" | "v" => Ok(Some(SplitAxis::Vertical)),
        "horizontal" | "h" => Ok(Some(SplitAxis::Horizontal)),
        "auto" | "" => Ok(None),
        other => Err(format!(
            "unknown split axis: {other:?} (vertical|horizontal|auto)"
        )),
    }
}

/// The labels a **split pane** can actually be: registered windows the host owns.
///
/// External container surfaces (`legacy:<id>` — a composited APK whose geometry
/// belongs to the container, `docs/android-compat.md`) are deliberately excluded.
/// [`WmState::apply_split_to_real`] skips them (there is no `WebviewWindow` to move),
/// so offering one would advertise a split the screen never shows — the exact lie
/// that function's doc warns with. This is the single source of the candidate list
/// for both the `wm_split_candidates` command and the `LayoutSnapshot` field, so the
/// two can never disagree (REQ-A226).
///
/// Reversibility (honest boundary): `amos-wm`'s `SplitScreen` itself still accepts any
/// two ids — if the container ever learns to obey pane rects, dropping this filter is
/// the whole change.
fn pane_candidates(core: &WmCore) -> Vec<String> {
    core.wm
        .split_candidates()
        .into_iter()
        .filter(|id| !core.external.contains(id))
        .filter_map(|id| core.labels.get(&id).cloned())
        .collect()
}

fn pane(label: String, b: Bounds) -> PaneLayout {
    PaneLayout {
        label,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
    }
}

/// Build a [`LayoutSnapshot`] from an already-locked core (no re-locking).
fn layout_core(core: &WmCore) -> Result<LayoutSnapshot, String> {
    let split = match &core.split {
        Some(sp) => {
            let (a, b) = sp
                .bounds()
                .ok_or_else(|| "split geometry is not available".to_string())?;
            let primary = core.labels.get(&sp.primary).cloned().unwrap_or_default();
            let secondary = core.labels.get(&sp.secondary).cloned().unwrap_or_default();
            Some(SplitLayoutInfo {
                axis: match sp.axis {
                    SplitAxis::Vertical => "vertical",
                    SplitAxis::Horizontal => "horizontal",
                }
                .to_string(),
                percent: sp.percent(),
                primary: primary.clone(),
                secondary: secondary.clone(),
                panes: vec![pane(primary, a), pane(secondary, b)],
            })
        }
        None => None,
    };
    let candidates = pane_candidates(core);
    Ok(LayoutSnapshot {
        screen_w: core.screen.width,
        screen_h: core.screen.height,
        split,
        candidates,
        form: core.policy.form.as_str().to_string(),
        columns: core.policy.columns_for(core.screen.width),
        multi_window: core.policy.multi_window,
        free_resize: core.policy.free_resize,
        divider_gap: core.policy.divider_gap,
    })
}

/// Common tail of a mutating layout command: apply the (possibly empty) split to
/// the real windows, broadcast a `layout-changed` event with the new snapshot, and
/// return it. Emitting the *authoritative* reply lets non-initiating surfaces
/// refresh without their own command round-trip.
fn finish_layout(
    app: &AppHandle,
    state: &WmState,
    snap: &LayoutSnapshot,
) -> Result<LayoutSnapshot, String> {
    state.apply_split_to_real(app)?;
    let _ = app.emit(LAYOUT_EVENT, snap);
    Ok(snap.clone())
}

// ---- Tauri commands (frontend: `invoke('wm_open', { label })`) ----

/// Read-only snapshot of the multi-window layout state.
#[tauri::command]
pub fn wm_layout_snapshot(state: State<'_, WmState>) -> Result<LayoutSnapshot, String> {
    state.layout_snapshot()
}

/// Set the full window area the split layout sub-divides (re-applies any live
/// split to the real windows + broadcasts `layout-changed`).
#[tauri::command]
pub fn wm_layout_set_screen(
    app: AppHandle,
    state: State<'_, WmState>,
    width: u32,
    height: u32,
) -> Result<LayoutSnapshot, String> {
    let snap = state.set_screen(width, height)?;
    finish_layout(&app, &state, &snap)
}

/// Enter a split between two windows (`axis`: `vertical` | `horizontal` | `auto`,
/// where `auto` lets the form-factor policy pick from the screen's aspect) and
/// apply the panes to the real windows.
#[tauri::command]
pub fn wm_split(
    app: AppHandle,
    state: State<'_, WmState>,
    primary: String,
    secondary: String,
    axis: String,
) -> Result<LayoutSnapshot, String> {
    let snap = state.enter_split(&primary, &secondary, &axis)?;
    finish_layout(&app, &state, &snap)
}

/// Set the divider so the primary pane takes `percent` (1..=99), re-applying to
/// the real windows.
#[tauri::command]
pub fn wm_split_resize(
    app: AppHandle,
    state: State<'_, WmState>,
    percent: u32,
) -> Result<LayoutSnapshot, String> {
    let snap = state.split_resize(percent)?;
    finish_layout(&app, &state, &snap)
}

/// Move the divider by `delta` percentage points, re-applying to the real windows.
#[tauri::command]
pub fn wm_split_move(
    app: AppHandle,
    state: State<'_, WmState>,
    delta: i32,
) -> Result<LayoutSnapshot, String> {
    let snap = state.split_move(delta)?;
    finish_layout(&app, &state, &snap)
}

/// Swap which window is in the primary pane, re-applying to the real windows and
/// giving the **new primary** window OS focus (input routing follows the swap).
#[tauri::command]
pub fn wm_split_swap(app: AppHandle, state: State<'_, WmState>) -> Result<LayoutSnapshot, String> {
    let snap = state.split_swap()?;
    finish_layout(&app, &state, &snap)?;
    // After a swap, focus the window that is now the primary pane.
    if let Some((primary, _)) = state.split_labels()? {
        if let Some(w) = app.get_webview_window(&primary) {
            let _ = w.set_focus();
        }
    }
    Ok(snap)
}

/// End the active split: restore the two windows to fullscreen (maximize them),
/// clear the split state, and broadcast `layout-changed`.
#[tauri::command]
pub fn wm_split_exit(app: AppHandle, state: State<'_, WmState>) -> Result<LayoutSnapshot, String> {
    // Remember which windows were split before clearing, so we can restore them.
    let pair = state.split_labels()?;
    let snap = state.split_exit()?;
    if let Some((a, b)) = pair {
        for label in [a, b] {
            if let Some(w) = app.get_webview_window(&label) {
                // Returning a split pane to the "full" screen = maximize. Honest
                // fallback when no exact pre-split geometry was captured.
                window_maximize(&w);
            }
        }
    }
    finish_layout(&app, &state, &snap)
}

/// GUI demo entry for the real multi-window host: pick the two front split
/// candidates, `enter_split` them, then animate a divider cycle — resize 40 →
/// swap → resize 60 → swap — and finally `exit`. Every step is applied to the
/// real windows and broadcast as `layout-changed`, so a dev window can watch the
/// panes move. Requires a live multi-window Tauri app to be visually meaningful.
#[tauri::command]
pub async fn wm_split_demo(
    app: AppHandle,
    state: State<'_, WmState>,
) -> Result<LayoutSnapshot, String> {
    let candidates = state.split_candidates_labels()?;
    if candidates.len() < 2 {
        return Err("need at least two open windows to run the split demo".to_string());
    }
    let a = candidates[0].clone();
    let b = candidates[1].clone();

    let step_ms = std::time::Duration::from_millis(500);
    // `auto`: the demo follows the resolved form factor's own axis choice (a
    // landscape desktop splits side-by-side, a portrait phone stacks) instead of
    // hard-coding an orientation.
    let mut snap = state.enter_split(&a, &b, "auto")?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_resize(40)?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_swap()?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_resize(60)?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_swap()?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    // Restore: maximize the two windows and clear the split.
    let pair = state.split_labels()?;
    snap = state.split_exit()?;
    if let Some((x, y)) = pair {
        for label in [x, y] {
            if let Some(w) = app.get_webview_window(&label) {
                window_maximize(&w);
            }
        }
    }
    finish_layout(&app, &state, &snap)
}

/// The window labels the host can offer for entering a split.
#[tauri::command]
pub fn wm_split_candidates(state: State<'_, WmState>) -> Result<Vec<String>, String> {
    state.split_candidates_labels()
}

/// Open (create + focus) the window for `label`; returns the new snapshot.
#[tauri::command]
pub fn wm_open(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.open(&app, &label)?;
    state.snapshot()
}

/// Focus the window for `label` without changing visibility.
#[tauri::command]
pub fn wm_focus(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.focus(&app, &label)?;
    state.snapshot()
}

/// Hide the window for `label`.
#[tauri::command]
pub fn wm_hide(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.hide(&app, &label)?;
    state.snapshot()
}

/// Close the window for `label` (Launcher is a no-op).
#[tauri::command]
pub fn wm_close(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.close(&app, &label)?;
    state.snapshot()
}

/// Return to the Launcher.
#[tauri::command]
pub fn wm_home(app: AppHandle, state: State<'_, WmState>) -> Result<WmSnapshot, String> {
    state.home(&app)?;
    state.snapshot()
}

/// Read-only snapshot of the current windowing state.
#[tauri::command]
pub fn wm_windows(state: State<'_, WmState>) -> Result<WmSnapshot, String> {
    state.snapshot()
}

// ---- System-wide context (multi-window AI context sharing) ----

/// A snippet of text captured from a source window, destined for a target.
#[derive(Clone, Serialize, Debug)]
pub struct SystemContextEntry {
    pub source_window: String,
    pub text: String,
    pub timestamp_ms: u64,
}

/// Shared system-wide clipboard/selection context, injected into AI requests.
///
/// Keyed by *target* window label: when the AI assistant asks, the backend
/// takes the entry addressed to it and merges it into `AgentRequest.context`
/// under the `system_selection` key (see `docs/multi-window.md` §3).
pub struct SystemContext {
    inner: Mutex<HashMap<String, SystemContextEntry>>,
}

impl Default for SystemContext {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemContext {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Record context captured from `source_window`, addressed to `target_window`.
    pub fn set(&self, target_window: &str, source_window: &str, text: &str) {
        let entry = SystemContextEntry {
            source_window: source_window.to_string(),
            text: text.to_string(),
            timestamp_ms: now_ms(),
        };
        if let Ok(mut g) = self.inner.lock() {
            g.insert(target_window.to_string(), entry);
        }
    }

    /// Drop the context addressed to `target_window` (e.g. user cleared it).
    pub fn clear(&self, target_window: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(target_window);
        }
    }

    /// Peek (without consuming) the context for `target_window`.
    ///
    /// Poison-tolerant: a panic in another thread is not "this window has no context".
    pub fn peek(&self, target_window: &str) -> Option<SystemContextEntry> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(target_window)
            .cloned()
    }

    /// Take (and consume) the context for `target_window`, if any.
    pub fn take_for(&self, target_window: &str) -> Option<SystemContextEntry> {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(target_window)
        } else {
            None
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Merge the system-wide context addressed to `target` into `out` under the
/// `system_selection` key, consuming it. Shared by `ask_ai_agent` and unit
/// tests so the injection path is exercised headlessly.
pub fn inject_context(ctx: &SystemContext, target: &str, out: &mut HashMap<String, String>) {
    if let Some(entry) = ctx.take_for(target) {
        out.insert("system_selection".to_string(), entry.text);
    }
}

/// Tauri command: capture selection/clipboard text from a window for a target.
#[tauri::command]
pub fn system_set_context(
    state: State<'_, SystemContext>,
    target_window: String,
    source_window: String,
    text: String,
) -> Result<(), String> {
    // Bound the labels at the seam — they key the context map and ride on every
    // `system-context-updated` broadcast, so a paste-sized label would inflate
    // every consumer of that event.
    if target_window.is_empty() || target_window.len() > MAX_CONTEXT_LABEL_BYTES {
        return Err(format!(
            "context target_window invalid: {} bytes (max {MAX_CONTEXT_LABEL_BYTES})",
            target_window.len()
        ));
    }
    if source_window.is_empty() || source_window.len() > MAX_CONTEXT_LABEL_BYTES {
        return Err(format!(
            "context source_window invalid: {} bytes (max {MAX_CONTEXT_LABEL_BYTES})",
            source_window.len()
        ));
    }
    // Bound the text so a malicious app cannot flood the AI context: the selected
    // text is injected into the prompt, and unbounded injection would defeat the
    // prompt cap `MAX_AI_PROMPT_BYTES` at the `ask_ai_agent` seam.
    if text.len() > MAX_CONTEXT_TEXT_BYTES {
        return Err(format!(
            "context text too long: {} bytes (max {MAX_CONTEXT_TEXT_BYTES})",
            text.len()
        ));
    }
    state.set(&target_window, &source_window, &text);
    Ok(())
}

/// Tauri command: drop the context addressed to a window.
#[tauri::command]
pub fn system_clear_context(
    state: State<'_, SystemContext>,
    target_window: String,
) -> Result<(), String> {
    if target_window.is_empty() || target_window.len() > MAX_CONTEXT_LABEL_BYTES {
        return Err(format!(
            "context target_window invalid: {} bytes (max {MAX_CONTEXT_LABEL_BYTES})",
            target_window.len()
        ));
    }
    state.clear(&target_window);
    Ok(())
}

/// Tauri command: peek (without consuming) the context addressed to a window,
/// so the target app can show a "已附加系统上下文" hint before sending.
#[tauri::command]
pub fn system_peek_context(
    state: State<'_, SystemContext>,
    target_window: String,
) -> Result<Option<SystemContextEntry>, String> {
    if target_window.is_empty() || target_window.len() > MAX_CONTEXT_LABEL_BYTES {
        return Err(format!(
            "context target_window invalid: {} bytes (max {MAX_CONTEXT_LABEL_BYTES})",
            target_window.len()
        ));
    }
    Ok(state.peek(&target_window))
}

/// Tauri command: name the shell window — what the OS puts in its **title bar**.
///
/// On macOS the title bar answers "what am I looking at": this shell is one window
/// that shows the launcher, the lock screen or an app, and it used to carry the
/// configured `Amos · AI System UI` for all of them (so the window menu, the Dock's
/// window list and a screen reader said the same thing no matter what was on
/// screen). The shell now sends the **localized name of the app** it is showing, or
/// `None` for the surfaces that are the shell itself — and `None` deliberately does
/// **not** mean "empty": it means *restore what the host was configured with*, read
/// from the live config rather than from a second copy of the product name in the UI
/// (REQ-A234's "do not duplicate `LAUNCHER_LABEL`" rule, applied to the title).
///
/// Returns the title that was actually applied, so a caller can tell an applied
/// title from the one it asked for (a long third-party name is truncated, see
/// [`normalize_shell_title`]) — a silently different title is exactly the class of
/// thing this crate reports instead of hiding.
#[tauri::command]
pub fn wm_set_shell_title(app: AppHandle, title: Option<String>) -> Result<String, String> {
    let Some(window) = app.get_webview_window(LAUNCHER_LABEL) else {
        return Err(format!(
            "no `{LAUNCHER_LABEL}` window to name (the shell is not mounted)"
        ));
    };
    let wanted = match title {
        Some(asked) => {
            if asked.len() > MAX_SHELL_TITLE_BYTES {
                return Err(format!(
                    "title too long: {} bytes (max {MAX_SHELL_TITLE_BYTES})",
                    asked.len()
                ));
            }
            normalize_shell_title(&asked)?
        }
        None => configured_shell_title(&app),
    };
    window
        .set_title(&wanted)
        .map_err(|e| format!("the platform refused the title: {e}"))?;
    Ok(wanted)
}

/// The title the launcher window was **configured** with (`tauri.conf.json`),
/// falling back to the product name, then to the label.
///
/// Read from `AppHandle::config()` on every call: one source of truth, no cached
/// copy that can drift from the config the window was actually created with.
fn configured_shell_title(app: &AppHandle) -> String {
    let config = app.config();
    config
        .app
        .windows
        .iter()
        .find(|w| w.label == LAUNCHER_LABEL)
        .map(|w| w.title.clone())
        .filter(|t| !t.trim().is_empty())
        .or_else(|| config.product_name.clone().filter(|t| !t.trim().is_empty()))
        .unwrap_or_else(|| LAUNCHER_LABEL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn open_surface_registers_external_system_window() {
        let s = WmState::new();
        s.open_surface("legacy:waydroid_0").unwrap();

        let snap = s.snapshot().unwrap();
        let surface = snap
            .windows
            .iter()
            .find(|w| w.label == "legacy:waydroid_0")
            .expect("surface window registered");
        assert_eq!(
            surface.kind, "System",
            "legacy APK surfaces are System windows"
        );
        assert!(surface.external, "external surfaces have no WebviewWindow");
        assert!(surface.focused, "opening a surface focuses it");
        assert_eq!(snap.focused, Some(surface.id));
    }

    #[test]
    fn open_surface_reuses_existing_label() {
        let s = WmState::new();
        s.open_surface("legacy:surf-1").unwrap();
        s.open_surface("legacy:surf-1").unwrap(); // same label again
        let snap = s.snapshot().unwrap();
        let count = snap
            .windows
            .iter()
            .filter(|w| w.label == "legacy:surf-1")
            .count();
        assert_eq!(count, 1, "reusing a label does not duplicate the window");
    }

    #[test]
    fn inject_context_puts_selection_into_request_map() {
        let ctx = SystemContext::new();
        ctx.set("ai", "notes", "selected text for the agent");

        let mut out = HashMap::new();
        inject_context(&ctx, "ai", &mut out);

        assert_eq!(
            out.get("system_selection").map(String::as_str),
            Some("selected text for the agent"),
            "context injected under system_selection"
        );
        assert!(ctx.peek("ai").is_none(), "context consumed after injection");
    }

    #[test]
    fn inject_context_noop_for_unknown_target() {
        let ctx = SystemContext::new();
        ctx.set("ai", "notes", "hello");
        let mut out = HashMap::new();
        inject_context(&ctx, "settings", &mut out);
        assert!(out.is_empty(), "nothing injected for a different target");
        assert!(
            ctx.peek("ai").is_some(),
            "context still present for its target"
        );
    }

    #[test]
    fn layout_split_resize_swap_exit_round_trip() {
        let s = WmState::new();
        s.register_app("notes").unwrap();
        s.register_app("maps").unwrap();
        assert_eq!(
            s.layout_snapshot().unwrap().candidates,
            vec!["maps", "notes"],
            "front two shown, non-Launcher surfaces are split candidates"
        );

        let snap = s.enter_split("notes", "maps", "vertical").unwrap();
        let info = snap.split.expect("split active");
        assert_eq!(info.primary, "notes");
        assert_eq!(info.secondary, "maps");
        assert_eq!(info.axis, "vertical");
        assert_eq!(snap.screen_w, 1080);
        assert_eq!(
            s.split_labels().unwrap(),
            Some(("notes".to_string(), "maps".to_string()))
        );
        assert_eq!(info.panes.len(), 2);
        // The two panes tile the screen minus the divider gap (the gap now comes
        // from the form-factor policy instead of a module constant).
        let total: u64 = info.panes.iter().map(|p| u64::from(p.width)).sum();
        assert_eq!(total + u64::from(snap.divider_gap), 1080);

        // Feasible divider move.
        let r = s.split_resize(40).unwrap().split.unwrap();
        assert_eq!(r.percent, 40);

        // Swap flips which window is primary.
        let sw = s.split_swap().unwrap().split.unwrap();
        assert_eq!(sw.primary, "maps");
        assert_eq!(sw.secondary, "notes");

        // Exit clears the split (and the host then maximizes those windows).
        assert!(s.split_exit().unwrap().split.is_none());
        assert_eq!(s.split_labels().unwrap(), None);
    }

    #[test]
    fn layout_split_rejects_bad_input_and_set_screen_can_end_a_split() {
        let s = WmState::new();
        s.register_app("a").unwrap();
        s.register_app("b").unwrap();

        // Same window twice.
        assert!(s.enter_split("a", "a", "vertical").is_err());
        // Unknown axis.
        assert!(s.enter_split("a", "b", "diagonal").is_err());
        // Launcher cannot be split.
        assert!(s.enter_split("main", "a", "vertical").is_err());
        // A divider share below the minimum size is rejected.
        let _ = s.enter_split("a", "b", "vertical").unwrap();
        assert!(
            s.split_resize(5).is_err(),
            "5% pane is below the minimum size"
        );
        assert_eq!(s.layout_snapshot().unwrap().split.unwrap().percent, 50);

        // Shrinking the screen below the min panes ends the split (no silent clamp).
        let snap = s.set_screen(200, 100).unwrap();
        assert!(snap.split.is_none());
        assert_eq!((snap.screen_w, snap.screen_h), (200, 100));
    }

    #[test]
    fn form_factor_hint_falls_back_visibly_when_it_is_unusable() {
        // Pure: the raw hint is injected, so this is deterministic in CI (no
        // process-environment race) and the fallback path is genuinely executed.
        let (form, source, warn) = resolve_host_form_factor(FormFactor::Desktop, None);
        assert_eq!(
            (form, source),
            (FormFactor::Desktop, HintSource::BuildDefault)
        );
        assert!(warn.is_none(), "no hint is not a problem");

        let (form, source, warn) = resolve_host_form_factor(FormFactor::Phone, Some("tablet"));
        assert_eq!((form, source), (FormFactor::Tablet, HintSource::Env));
        assert!(warn.is_none());

        let (form, source, warn) = resolve_host_form_factor(FormFactor::Desktop, Some("pc"));
        assert_eq!(
            (form, source),
            (FormFactor::Desktop, HintSource::BuildDefault),
            "an unusable hint must not change the class"
        );
        let warn = warn.expect("an unusable hint must be reported, not swallowed");
        assert!(
            warn.contains("AMOS_FORM_FACTOR") && warn.contains("\"pc\""),
            "the warning names the variable and the rejected value: {warn}"
        );
    }

    #[test]
    fn the_snapshot_reports_the_class_and_its_capabilities() {
        let s = WmState::with_form_factor(FormFactor::Tablet);
        let snap = s.layout_snapshot().unwrap();
        assert_eq!(snap.form, "tablet");
        assert_eq!((snap.screen_w, snap.screen_h), (1080, 1920));
        assert_eq!(snap.columns, 2, "1080px wide hits the tablet's ceiling");
        assert!(
            snap.multi_window && !snap.free_resize,
            "a tablet may split but has no drag-resize affordance"
        );
        assert_eq!(snap.divider_gap, 12);

        // The column signal is screen-driven, so the same build answers both ways.
        assert_eq!(s.set_screen(500, 900).unwrap().columns, 1);
        assert_eq!(s.set_screen(1000, 800).unwrap().columns, 2);
    }

    #[test]
    fn a_phone_class_never_reports_a_second_column_or_free_resize() {
        let s = WmState::with_form_factor(FormFactor::Phone);
        let snap = s.set_screen(1920, 1080).unwrap();
        assert_eq!(snap.form, "phone");
        assert_eq!(
            snap.columns, 1,
            "a phone stays one column however wide the surface is"
        );
        assert!(!snap.multi_window && !snap.free_resize);
        assert_eq!(snap.divider_gap, 8, "the legacy divider is unchanged");
    }

    #[test]
    fn auto_split_axis_follows_the_screen_aspect() {
        let s = WmState::with_form_factor(FormFactor::Tablet);
        s.register_app("a").unwrap();
        s.register_app("b").unwrap();
        assert_eq!(parse_axis("").unwrap(), None, "an empty axis means auto");

        // Portrait: the two panes stack.
        let portrait = s.enter_split("a", "b", "auto").unwrap();
        assert_eq!(portrait.split.as_ref().unwrap().axis, "horizontal");
        s.split_exit().unwrap();

        // Landscape: side by side, tiling the new screen minus the tablet divider.
        s.set_screen(1920, 1080).unwrap();
        let landscape = s.enter_split("a", "b", "auto").unwrap();
        let info = landscape.split.expect("split active");
        assert_eq!(info.axis, "vertical");
        let total: u64 = info.panes.iter().map(|p| u64::from(p.width)).sum();
        assert_eq!(total + u64::from(landscape.divider_gap), 1920);
    }

    #[test]
    fn an_unknown_axis_is_still_refused_and_the_message_lists_the_accepted_ones() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        s.register_app("a").unwrap();
        s.register_app("b").unwrap();
        let err = s.enter_split("a", "b", "diagonal").unwrap_err();
        assert!(err.contains("unknown split axis"), "{err}");
        assert!(
            err.contains("auto"),
            "the message lists every accepted value: {err}"
        );
    }

    #[test]
    fn only_the_launcher_window_defines_the_screen_area() {
        // The resize handler relies on this: app windows (and therefore split
        // panes) must never be mistaken for the screen, or the pane-writing loop
        // would feed itself.
        assert!(
            is_screen_window("main"),
            "the Launcher/main window is the screen"
        );
        for other in ["notes", "maps", "app-1", "Main", ""] {
            assert!(
                !is_screen_window(other),
                "{other:?} is not the screen window"
            );
        }
    }

    #[test]
    fn a_shell_title_is_trimmed_and_an_honest_one_passes_unchanged() {
        // The macOS title bar is what the window menu / Dock window list read, so the
        // ordinary path must be a *no-op* on a normal localized name — otherwise this
        // "validation" would be a rewriter that changes names it has no business in.
        for honest in ["Settings", "设置", "照片", "Amos"] {
            assert_eq!(
                normalize_shell_title(honest).expect("honest"),
                honest,
                "{honest} must survive untouched"
            );
        }
        assert_eq!(
            normalize_shell_title("  设置  ").expect("trimmed"),
            "设置",
            "surrounding whitespace is not part of a title"
        );
    }

    #[test]
    fn an_empty_or_control_character_title_is_refused_by_name() {
        // Empty: macOS would draw an empty title bar and the window menu a nameless
        // window. Control characters: the OS renders a title as ONE line, so a `\n`
        // or an escape sequence is a bug or an injection — refused with the code
        // point, so the cause is visible.
        for empty in ["", "   ", "\t"] {
            let err = normalize_shell_title(empty).expect_err("empty refused");
            assert!(err.contains("empty"), "{err}");
        }
        for (raw, code) in [
            ("Settings\nmore", "U+000A"),
            ("Set\ttings", "U+0009"),
            ("\u{1b}[31mred", "U+001B"),
            ("bell\u{7}mid", "U+0007"),
        ] {
            let err = normalize_shell_title(raw).expect_err("control char refused");
            assert!(
                err.contains(code) && err.contains("one line"),
                "the refusal names the code point ({code}): {err}"
            );
        }
        // Trimming happens first, so a *trailing* newline is whitespace (not an
        // injection): `"Settings\n"` is the title "Settings". Only a control character
        // that would survive into the middle of the rendered line is refused.
        assert_eq!(
            normalize_shell_title("Settings\n").expect("trimmed"),
            "Settings"
        );
    }

    #[test]
    fn a_long_title_is_truncated_to_a_bounded_string_with_a_visible_marker() {
        // A store app's display name comes from its manifest, i.e. from a third party.
        // Truncating (rather than refusing) is deliberate: refusing would leave the
        // *previous* app's name in the title bar while this app is on screen — a wrong
        // statement instead of a short one. The `…` is the statement.
        let long = "x".repeat(500);
        let cut = normalize_shell_title(&long).expect("truncated");
        assert_eq!(cut.chars().count(), MAX_SHELL_TITLE_CHARS);
        assert!(cut.ends_with('…'), "{cut}");
        assert!(cut.starts_with(&"x".repeat(MAX_SHELL_TITLE_CHARS - 1)));

        // …and the bound is in **characters**: 121 CJK glyphs are a long-ish title, not
        // 363. (A byte-based cap would cut Chinese titles at 40 glyphs.)
        let cjk = "机".repeat(MAX_SHELL_TITLE_CHARS + 1);
        let cut = normalize_shell_title(&cjk).expect("truncated");
        assert_eq!(cut.chars().count(), MAX_SHELL_TITLE_CHARS);
        assert_eq!(
            cut.chars().filter(|c| *c == '机').count(),
            MAX_SHELL_TITLE_CHARS - 1
        );
        assert!(
            cjk.len() > MAX_SHELL_TITLE_CHARS * 3,
            "the test is about bytes≠chars"
        );

        // The boundary itself is legal, unchanged (no off-by-one in the cap).
        let exact = "y".repeat(MAX_SHELL_TITLE_CHARS);
        assert_eq!(normalize_shell_title(&exact).expect("boundary"), exact);
    }

    #[test]
    fn logical_screen_converts_physical_pixels_and_refuses_nonsense() {
        let fallback = Bounds::new(0, 0, 1080, 1920);
        // 1× display: unchanged.
        assert_eq!(
            logical_screen(1280.0, 800.0, 1.0, fallback),
            Bounds::new(0, 0, 1280, 800)
        );
        // 2× display: the panes are applied in logical pixels, so the model must
        // halve the physical reading (this is the 2×-screen defect the pure fn exists
        // to prevent).
        assert_eq!(
            logical_screen(2560.0, 1600.0, 2.0, fallback),
            Bounds::new(0, 0, 1280, 800)
        );
        // Fractional DPI rounds to the nearest logical pixel.
        assert_eq!(
            logical_screen(1500.0, 900.0, 1.5, fallback),
            Bounds::new(0, 0, 1000, 600)
        );
        // A missing/absurd scale factor is treated as 1 (never a divide by zero).
        assert_eq!(
            logical_screen(800.0, 600.0, 0.0, fallback),
            Bounds::new(0, 0, 800, 600)
        );
        assert_eq!(
            logical_screen(800.0, 600.0, f64::NAN, fallback),
            Bounds::new(0, 0, 800, 600)
        );
        assert_eq!(
            logical_screen(800.0, 600.0, -1.0, fallback),
            Bounds::new(0, 0, 800, 600)
        );
        // Unusable readings keep the previous rect instead of inventing one.
        for (w, h) in [
            (f64::NAN, 600.0),
            (800.0, f64::NAN),
            (0.0, 600.0),
            (800.0, 0.0),
            (-10.0, 600.0),
            (f64::INFINITY, 600.0),
            (1e12, 600.0),
        ] {
            assert_eq!(
                logical_screen(w, h, 1.0, fallback),
                fallback,
                "{w}×{h} must not become a screen"
            );
        }
        // The maximum believable edge is accepted exactly; just past it is refused.
        assert_eq!(
            logical_screen(f64::from(MAX_SCREEN_EDGE), 10.0, 1.0, fallback),
            Bounds::new(0, 0, MAX_SCREEN_EDGE, 10)
        );
        assert_eq!(
            logical_screen(f64::from(MAX_SCREEN_EDGE) + 1.0, 10.0, 1.0, fallback),
            fallback
        );
    }

    #[test]
    fn re_measuring_the_screen_reports_only_real_changes() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        // The first measurement applies and is reported.
        let first = s.sync_screen(Bounds::new(0, 0, 1280, 800)).unwrap();
        let first = first.expect("the first measurement changes the fallback screen");
        assert_eq!((first.screen_w, first.screen_h), (1280, 800));
        assert_eq!(first.columns, 4, "1280px is the widest band");

        // The same reading again is not a change (no event storm on a resize tick).
        assert!(s
            .sync_screen(Bounds::new(0, 0, 1280, 800))
            .unwrap()
            .is_none());
        // ...but it is still reported when read back.
        assert_eq!(s.layout_snapshot().unwrap().screen_w, 1280);

        // A real change is reported, and the column signal follows it.
        let narrow = s
            .sync_screen(Bounds::new(0, 0, 500, 800))
            .unwrap()
            .expect("a different width is a change");
        assert_eq!(narrow.columns, 1);
    }

    #[test]
    fn re_measuring_the_screen_ends_a_split_that_no_longer_fits() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        s.register_app("a").unwrap();
        s.register_app("b").unwrap();
        s.sync_screen(Bounds::new(0, 0, 1600, 900)).unwrap();
        assert_eq!(
            s.enter_split("a", "b", "auto").unwrap().split.unwrap().axis,
            "vertical",
            "a landscape screen splits side by side"
        );

        // The window is dragged down to a size that cannot host two minimum panes:
        // the split ends honestly (never silently re-clamped).
        let tiny = s
            .sync_screen(Bounds::new(0, 0, 200, 100))
            .unwrap()
            .expect("a different size is a change");
        assert!(tiny.split.is_none(), "the split ended with the window");
    }

    #[test]
    fn a_closed_label_is_registered_again_on_the_next_launch() {
        // The Android flow the LMK path drives: launch an APK → `open_surface` →
        // the container reclaims it (`lib/lmk.ts` → `wm_close` → `close_core`) → the
        // user launches the same app again. Before REQ-A227 the host kept the stale
        // `label ⇄ id` mapping, so `open_surface` short-circuited into `focus` on an
        // id the state machine no longer had and the re-launch **registered nothing** —
        // silently, with the app running and nothing on screen.
        let s = WmState::with_form_factor(FormFactor::Tablet);
        s.open_surface("legacy:waydroid_0").unwrap();
        assert!(s
            .snapshot()
            .unwrap()
            .windows
            .iter()
            .any(|w| w.label == "legacy:waydroid_0"));

        s.close_core("legacy:waydroid_0").unwrap();
        assert!(
            !s.snapshot()
                .unwrap()
                .windows
                .iter()
                .any(|w| w.label == "legacy:waydroid_0"),
            "a closed window is gone from the window list (no ghost)"
        );
        assert!(
            !s.split_candidates_labels()
                .unwrap()
                .contains(&"legacy:waydroid_0".to_string()),
            "…and it is not offered as a pane either"
        );

        // Re-launch: the surface must actually come back (Shown + Focused, still an
        // external System surface), not vanish into a dead id.
        s.open_surface("legacy:waydroid_0").unwrap();
        let windows = s.snapshot().unwrap().windows;
        let relaunched: Vec<_> = windows
            .iter()
            .filter(|w| w.label == "legacy:waydroid_0")
            .collect();
        assert_eq!(
            relaunched.len(),
            1,
            "exactly one surface after the re-launch"
        );
        assert!(relaunched[0].external && relaunched[0].kind == "System");
        assert_eq!(
            relaunched[0].state, "Focused",
            "the launch path focuses the surface it just opened"
        );
    }

    #[test]
    fn closing_a_split_pane_ends_the_split_and_names_the_survivor() {
        // A pane whose window is closed cannot be placed, so the split cannot outlive
        // it (the same honesty rule as a screen that no longer fits). The host is told
        // which window survived, so it can restore it to full screen instead of leaving
        // it at half-screen geometry with no split left to explain it.
        let s = WmState::with_form_factor(FormFactor::Tablet);
        s.register_app("notes").unwrap();
        s.register_app("maps").unwrap();
        s.enter_split("notes", "maps", "vertical").unwrap();

        let (events, survivor) = s.close_core("notes").unwrap();
        assert!(
            events.iter().any(|e| matches!(e, WmEvent::Closed(_))),
            "the close is reported: {events:?}"
        );
        assert_eq!(survivor.as_deref(), Some("maps"));
        assert!(
            s.layout_snapshot().unwrap().split.is_none(),
            "a split cannot outlive one of its panes"
        );
        assert_eq!(s.split_labels().unwrap(), None);
        // The survivor is still a normal, registered window.
        assert!(s
            .snapshot()
            .unwrap()
            .windows
            .iter()
            .any(|w| w.label == "maps"));
    }

    #[test]
    fn closing_a_window_outside_the_split_leaves_the_split_alone() {
        let s = WmState::with_form_factor(FormFactor::Tablet);
        for label in ["notes", "maps", "photos"] {
            s.register_app(label).unwrap();
        }
        s.enter_split("notes", "maps", "vertical").unwrap();

        let (_events, survivor) = s.close_core("photos").unwrap();
        assert_eq!(survivor, None, "no pane was closed, so nothing to restore");
        assert!(
            s.layout_snapshot().unwrap().split.is_some(),
            "an unrelated close must not disturb the split"
        );
    }

    #[test]
    fn the_shell_fit_is_only_honoured_when_the_os_applied_it_exactly() {
        let asked = Size::new(900, 1200);
        assert_eq!(
            shell_fit_outcome(asked, Size::new(900, 1200)),
            ShellFitOutcome::Honoured { size: asked }
        );
        // The real measurement from this Mac (REQ-A230): a laptop display (1728×1117
        // logical) cannot hold the tablet class's portrait window, so the OS clamped the
        // height. That is an *adjusted* fit, and it must be reported as one.
        assert_eq!(
            shell_fit_outcome(asked, Size::new(900, 882)),
            ShellFitOutcome::Adjusted {
                requested: asked,
                applied: Size::new(900, 882)
            }
        );
        // Either edge differing is a difference (a window manager may grow it too).
        assert!(matches!(
            shell_fit_outcome(asked, Size::new(901, 1200)),
            ShellFitOutcome::Adjusted { .. }
        ));
        assert!(matches!(
            shell_fit_outcome(asked, Size::new(900, 1201)),
            ShellFitOutcome::Adjusted { .. }
        ));
    }

    #[test]
    fn an_applied_size_is_reported_once_and_only_while_a_request_is_outstanding() {
        let s = WmState::with_form_factor(FormFactor::Tablet);

        // A resize the user performs on their own (nothing outstanding) is not ours to
        // report: `None`, and it stays that way.
        assert_eq!(s.note_applied_size(Size::new(800, 600)).unwrap(), None);

        // An outstanding request is answered exactly once, with the comparison result.
        s.set_shell_fit(Size::new(900, 1200)).unwrap();
        assert_eq!(
            s.note_applied_size(Size::new(900, 882)).unwrap(),
            Some(ShellFitOutcome::Adjusted {
                requested: Size::new(900, 1200),
                applied: Size::new(900, 882)
            })
        );
        assert_eq!(
            s.note_applied_size(Size::new(900, 882)).unwrap(),
            None,
            "the same event must not be reported twice"
        );

        // …and an honoured request reports as honoured (no warning).
        s.set_shell_fit(Size::new(1024, 720)).unwrap();
        assert_eq!(
            s.note_applied_size(Size::new(1024, 720)).unwrap(),
            Some(ShellFitOutcome::Honoured {
                size: Size::new(1024, 720)
            })
        );
        assert_eq!(s.note_applied_size(Size::new(1024, 720)).unwrap(), None);
    }

    #[test]
    fn a_container_surface_is_never_offered_as_a_pane() {
        // REQ-A226: an external container surface (`legacy:*`, a composited APK —
        // `docs/android-compat.md`) has **no `WebviewWindow`**, and
        // `apply_split_to_real` skips it (the container owns its geometry). Offering it
        // as a candidate would let the shipped settings UI answer a split the screen
        // never shows — "the layout model says the split is in place while the screen
        // shows the old geometry", the warning that function's own doc carries. The
        // settings page offers whatever `wm_split_candidates` says, so this list is
        // where the rule has to hold.
        //
        // The *model* still accepts any two registered windows (see the NOTE in
        // `enter_split`): this test pins the **offer**, not the refusal.
        let s = WmState::with_form_factor(FormFactor::Tablet);
        s.open_surface("legacy:waydroid_0").unwrap();
        s.open_surface("legacy:waydroid_1").unwrap();
        s.register_app("notes").unwrap();

        assert_eq!(
            s.split_candidates_labels().unwrap(),
            vec!["notes".to_string()],
            "only windows this host owns may be offered as panes"
        );
        assert_eq!(
            s.layout_snapshot().unwrap().candidates,
            vec!["notes".to_string()],
            "the snapshot's candidate list must agree with the command"
        );

        // …and a window this host owns is still offered and still splits.
        s.register_app("maps").unwrap();
        assert_eq!(
            s.split_candidates_labels().unwrap(),
            vec!["maps".to_string(), "notes".to_string()],
            "the two host-owned windows are the offer, most recent first"
        );
        let snap = s.enter_split("notes", "maps", "auto").unwrap();
        assert_eq!(snap.split.as_ref().unwrap().primary, "notes");
        assert_eq!(
            s.split_labels().unwrap(),
            Some(("notes".to_string(), "maps".to_string()))
        );
    }

    #[test]
    fn a_headless_class_refuses_to_split() {
        let s = WmState::with_form_factor(FormFactor::Robot);
        s.register_app("a").unwrap();
        // A headless class hosts **one** app window at most (`multi_window=false`),
        // so the second participant is an external container surface — which is the
        // pair a robot board actually has, and it must not become a way around the
        // rule just because it is not an app window.
        s.open_surface("legacy:x").unwrap();
        let err = s.enter_split("a", "legacy:x", "auto").unwrap_err();
        assert!(
            err.contains("robot") && err.contains("no user interface"),
            "the refusal names the class: {err}"
        );
        assert!(s.layout_snapshot().unwrap().split.is_none());
    }

    /// The refusal must happen **before** anything is registered (REQ-A257): a
    /// window that exists in the model but has no real window behind it is the
    /// failure shape REQ-A227 was about.
    #[test]
    fn a_refused_app_window_leaves_no_trace_in_the_model() {
        let s = WmState::with_form_factor(FormFactor::Phone);
        s.register_app("a").unwrap();
        let err = s.register_app("b").unwrap_err();
        assert!(err.contains("phone"), "{err}");

        let labels: Vec<String> = s
            .snapshot()
            .unwrap()
            .windows
            .into_iter()
            .map(|w| w.label)
            .collect();
        assert_eq!(
            labels,
            vec!["main".to_string(), "a".to_string()],
            "the refused window is not in the model at all"
        );
    }

    #[test]
    fn closing_the_single_app_window_frees_the_slot() {
        let s = WmState::with_form_factor(FormFactor::Phone);
        s.register_app("a").unwrap();
        assert!(s.register_app("b").is_err(), "one app window at a time");
        s.close_core("a").unwrap();
        s.register_app("b").unwrap();
        assert_eq!(
            s.snapshot()
                .unwrap()
                .windows
                .into_iter()
                .filter(|w| w.label == "b")
                .count(),
            1
        );
    }

    #[test]
    fn container_surfaces_do_not_consume_an_app_window_slot() {
        // A phone may show its one app window *beside* a composited container
        // surface (the Android path): the surface is a `System` window, so it must
        // not eat the single app slot.
        let s = WmState::with_form_factor(FormFactor::Phone);
        s.open_surface("legacy:waydroid_0").unwrap();
        s.register_app("calculator").unwrap();
        let err = s.register_app("settings").unwrap_err();
        assert!(err.contains("1 app window"), "{err}");
    }

    #[test]
    fn the_layout_snapshot_wire_shape_is_pinned() {
        // `tauri-reply-scan.mjs` cannot check this command — `lib/wm.ts` reaches it
        // through a dynamic `invoke(command, args)` helper, so the reply generic is
        // not statically nameable (that is the gate's documented boundary). That is
        // exactly the shape of the SMS-trash defect (a renamed Rust field reads as
        // `undefined` in the shell), and my normalizer would then quietly fall back
        // to phone defaults instead of failing. So the contract is pinned here, key
        // by key; the TS mirror is pinned by `wm.test.ts`'s key-set test, and both
        // lists are documented in `docs/multi-window.md` §1.5.
        let s = WmState::with_form_factor(FormFactor::Tablet);
        s.register_app("notes").unwrap();
        s.register_app("maps").unwrap();
        s.enter_split("notes", "maps", "auto").unwrap();

        let snapshot = s.layout_snapshot().unwrap();
        let json = serde_json::to_value(&snapshot).expect("a snapshot serializes");
        let obj = json.as_object().expect("a snapshot is a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "candidates",
                "columns",
                "divider_gap",
                "form",
                "free_resize",
                "multi_window",
                "screen_h",
                "screen_w",
                "split",
            ],
            "lib/wm.ts's LayoutSnapshot declares exactly these names"
        );
        // The class travels as its wire key, never as the Rust variant name.
        assert_eq!(obj["form"], "tablet");
        assert_eq!(obj["multi_window"], true);
        assert_eq!(obj["free_resize"], false);
        assert_eq!(obj["divider_gap"], 12);
        assert!(
            obj["columns"]
                .as_u64()
                .is_some_and(|c| (1..=4).contains(&c)),
            "columns stays in the documented 1..=4 band"
        );
        assert_eq!(obj["screen_w"], 1080, "the fallback screen until measured");
        assert_eq!(obj["screen_h"], 1920);

        let split = obj["split"].as_object().expect("a split object");
        let mut split_keys: Vec<&str> = split.keys().map(String::as_str).collect();
        split_keys.sort_unstable();
        assert_eq!(
            split_keys,
            vec!["axis", "panes", "percent", "primary", "secondary"]
        );
        assert_eq!(split["axis"], "horizontal", "1080×1920 is portrait");
        let pane = split["panes"][0].as_object().expect("a pane object");
        let mut pane_keys: Vec<&str> = pane.keys().map(String::as_str).collect();
        pane_keys.sort_unstable();
        assert_eq!(pane_keys, vec!["height", "label", "width", "x", "y"]);
    }

    #[test]
    fn resize_events_carry_their_own_reading_and_others_carry_none() {
        use tauri::{PhysicalSize, WindowEvent};
        // A plain resize carries the new physical size and no DPI change.
        assert_eq!(
            resize_reading(&WindowEvent::Resized(PhysicalSize::new(1280, 800))),
            Some((1280, 800, None))
        );
        // A DPI change carries **both** its new size and its new factor. The event
        // itself cannot be constructed here (`WindowEvent::ScaleFactorChanged` is
        // `#[non_exhaustive]`), so that arm's contract is pinned through
        // `dpi_change_reading` below — it must report `Some`, or the handler would
        // fall back to the window's stale scale factor and silently restore the bug
        // this path exists to remove.
        // Everything else cannot change the usable area.
        for event in [
            WindowEvent::Destroyed,
            WindowEvent::Focused(true),
            WindowEvent::Moved(tauri::PhysicalPosition::new(10, 20)),
        ] {
            assert_eq!(resize_reading(&event), None, "{event:?} is not a resize");
        }
    }

    /// A refused app window must leave **no trace**, and a window that is already on
    /// screen (or bigger than the class minimum) must not be touched at all: the
    /// re-clamp runs on every real screen change, so "no call when nothing moved" is
    /// what keeps it from fighting the user (REQ-A257).
    #[test]
    fn reclamp_target_moves_only_windows_that_need_it() {
        let screen = Bounds::new(0, 0, 800, 600);
        let policy = LayoutPolicy::of(FormFactor::Desktop); // min_pane 360×480

        // Fully inside and above the minimum → no call at all.
        assert_eq!(
            reclamp_target(policy, Bounds::new(10, 10, 400, 500), screen),
            None
        );
        assert_eq!(
            reclamp_target(policy, Bounds::new(0, 0, 800, 600), screen),
            None
        );

        // Hanging off the bottom-right → pulled back inside, size kept.
        let off = reclamp_target(policy, Bounds::new(700, 550, 400, 500), screen)
            .expect("a window half off the screen must move");
        assert!(off.right() <= screen.right() && off.bottom() <= screen.bottom());
        assert_eq!((off.width, off.height), (400, 500), "size is untouched");

        // Negative origin → slid to the screen's origin.
        let neg = reclamp_target(policy, Bounds::new(-50, -30, 400, 500), screen).expect("moves");
        assert_eq!((neg.x, neg.y), (0, 0));

        // Smaller than the class minimum → grown (the rule `free_resize` cannot
        // violate), and still inside the screen.
        let tiny = reclamp_target(policy, Bounds::new(10, 10, 100, 100), screen).expect("moves");
        assert_eq!((tiny.width, tiny.height), (360, 480));

        // **Larger** than the screen → shrunk to the screen (same rule that decides
        // where a new window opens; a window can never be bigger than its screen).
        let over = reclamp_target(policy, Bounds::new(0, 0, 3000, 2000), screen).expect("moves");
        assert_eq!((over.width, over.height), (800, 600));

        // A screen *smaller* than the minimum wins (physical fact), and the window is
        // never left zero-sized.
        let squeezed = reclamp_target(
            policy,
            Bounds::new(0, 0, 900, 900),
            Bounds::new(0, 0, 100, 40),
        )
        .expect("moves");
        assert_eq!((squeezed.width, squeezed.height), (100, 40));
        assert!(squeezed.width >= 1 && squeezed.height >= 1);
    }

    #[test]
    fn only_a_believable_reading_becomes_a_window_position() {
        assert_eq!(sane_signed_edge(0.0), Some(0));
        assert_eq!(sane_signed_edge(-120.4), Some(-120));
        assert_eq!(sane_signed_edge(1496.6), Some(1497));
        for junk in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1.0e9, -1.0e9] {
            assert_eq!(sane_signed_edge(junk), None, "{junk} is not a position");
        }
    }

    #[test]
    fn phone_form_factor_refuses_second_app_window() {
        // G5: multi_window=false must be enforced at window creation (REQ-A256).
        let state = WmState::new_for_test(FormFactor::Phone);

        // First app window succeeds (register without building real Tauri window)
        state.register_app("calculator").unwrap();

        // Second app window is refused with an honest error
        let result = state.register_app("settings");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("phone"),
            "error mentions the form factor: {}",
            err
        );
        assert!(
            err.contains("multi_window=false"),
            "error cites the policy: {}",
            err
        );
        assert!(
            err.contains("1 app window"),
            "error reports the count: {}",
            err
        );
    }

    #[test]
    fn desktop_form_factor_allows_multiple_app_windows() {
        // G5: multi_window=true must allow concurrent app windows (REQ-A256).
        let state = WmState::new_for_test(FormFactor::Desktop);

        // Open three app windows — all succeed
        for label in ["calculator", "settings", "notes"] {
            state.register_app(label).unwrap();
        }

        let snapshot = state.snapshot().unwrap();
        let app_windows: Vec<_> = snapshot
            .windows
            .iter()
            .filter(|w| w.kind == "App")
            .collect();
        assert_eq!(app_windows.len(), 3, "desktop allows three app windows");
    }

    #[test]
    fn tablet_form_factor_allows_multiple_app_windows() {
        // G5: tablet also has multi_window=true (REQ-A256).
        let state = WmState::new_for_test(FormFactor::Tablet);

        state.register_app("calculator").unwrap();
        state.register_app("settings").unwrap();

        let snapshot = state.snapshot().unwrap();
        let app_windows: Vec<_> = snapshot
            .windows
            .iter()
            .filter(|w| w.kind == "App")
            .collect();
        assert_eq!(app_windows.len(), 2, "tablet allows two app windows");
    }

    #[test]
    fn enforce_min_is_applied_to_split_panes() {
        // G5: split pane geometry must respect min_pane (REQ-A256).
        use amos_wm::layout::{Bounds, Size};

        let min = Size::new(360, 480);

        // A pane smaller than minimum is grown
        let small = Bounds::new(0, 0, 200, 300);
        let enforced = small.enforce_min(min);
        assert_eq!(enforced.width, 360, "width enforced to minimum");
        assert_eq!(enforced.height, 480, "height enforced to minimum");
        assert_eq!(enforced.x, 0, "origin preserved");

        // A pane already above minimum is unchanged
        let ok = Bounds::new(10, 20, 500, 600);
        let enforced = ok.enforce_min(min);
        assert_eq!(enforced, ok, "already-valid pane unchanged");

        // Zero-size input is clamped to at least 1×1
        let zero = Bounds::new(5, 5, 0, 0);
        let enforced = zero.enforce_min(Size::new(0, 0));
        assert!(
            enforced.width >= 1 && enforced.height >= 1,
            "enforce_min never returns zero-size: {:?}",
            enforced
        );
    }

    #[test]
    fn the_shell_default_is_the_phone_window_declared_in_tauri_conf() {
        // One number lives in three places (this constant, the phone policy it is
        // derived from, and the config file the OS actually opens). A stale copy
        // would make `shell_fit_reading` never match — silently restoring the
        // "a PC opens as a phone slab" defect with no signal at all.
        let raw = include_str!("../tauri.conf.json");
        let conf: serde_json::Value =
            serde_json::from_str(raw).expect("tauri.conf.json must be valid JSON");
        let main = &conf["app"]["windows"][0];
        let width = main["width"]
            .as_u64()
            .expect("the main window declares a width") as u32;
        let height = main["height"]
            .as_u64()
            .expect("the main window declares a height") as u32;
        assert_eq!(
            Size::new(width, height),
            SHELL_DEFAULT_WINDOW,
            "the shell default must be the geometry tauri.conf.json actually opens"
        );
        // ...and the class that legitimately keeps that slab is the source of the
        // constant, so the phone path stays byte-identical by construction.
        assert_eq!(
            SHELL_DEFAULT_WINDOW,
            LayoutPolicy::of(FormFactor::Phone).initial_window,
            "the shell default is the phone class's own window size"
        );
    }

    #[test]
    fn the_shell_is_grown_from_the_config_default_in_logical_pixels() {
        let desktop = LayoutPolicy::of(FormFactor::Desktop);
        let handset = SHELL_DEFAULT_WINDOW;
        // The desktop class aligns with the desktop: the policy asks for a *maximize*,
        // not for the old fixed 1024x720 slab (REQ-A233).
        let class = ShellFit::Maximize;
        // 1× display: the config default is measured as itself.
        assert_eq!(
            shell_fit_reading(desktop, handset.width, handset.height, 1.0),
            Some((handset, class))
        );
        // 2× display: the same window reports 960×1640 **physical**. Comparing the
        // physical reading against the logical default would never match — the
        // exact composition defect this pure seam exists to prevent.
        assert_eq!(
            shell_fit_reading(desktop, handset.width * 2, handset.height * 2, 2.0),
            Some((handset, class))
        );
        // Fractional DPI rounds to the nearest logical pixel, so 1.5× matches too.
        assert_eq!(
            shell_fit_reading(desktop, 720, 1230, 1.5),
            Some((handset, class))
        );
        // A window somebody already sized is never fought, on any class.
        assert_eq!(shell_fit_reading(desktop, 2560, 1600, 2.0), None);
        assert_eq!(shell_fit_reading(desktop, 1280, 800, 1.0), None);
        assert_eq!(shell_fit_reading(desktop, 1024, 720, 1.0), None);
        // A phone shell already *is* the handset default: nothing to do.
        assert_eq!(
            shell_fit_reading(
                LayoutPolicy::of(FormFactor::Phone),
                handset.width,
                handset.height,
                1.0
            ),
            None
        );
        // A headless class never touches geometry, even at the default size.
        assert_eq!(
            shell_fit_reading(
                LayoutPolicy::of(FormFactor::Robot),
                handset.width,
                handset.height,
                1.0
            ),
            None
        );
    }

    #[test]
    fn a_shell_reading_that_is_not_a_window_never_triggers_a_resize() {
        let desktop = LayoutPolicy::of(FormFactor::Desktop);
        // Garbage *sizes* answer `None` before the policy is consulted. A
        // fallback-based comparison (the shape this function replaced) would let a
        // zero/absurd reading look like "the default" and resize a window on it.
        for (w, h) in [(0, 0), (0, 820), (480, 0), (u32::MAX, 820)] {
            assert_eq!(
                shell_fit_reading(desktop, w, h, 1.0),
                None,
                "{w}×{h} is not a window size"
            );
        }
        // ...and so does an unusable scale factor. `logical_size_of` treats it as
        // 1× for the layout path, but guessing here could make a 2× user's own
        // window (physical 480×820 ⇒ logical 240×410) look like the default.
        for scale in [f64::NAN, 0.0, -1.0, f64::INFINITY] {
            assert_eq!(
                shell_fit_reading(desktop, 480, 820, scale),
                None,
                "scale {scale} cannot be used to compare physical against logical"
            );
        }
    }

    #[test]
    fn a_dpi_change_always_reports_its_new_factor() {
        // The end-to-end arithmetic the handler performs, minus the Tauri window:
        // a 2× panel reports 2560×1600 physical, so the logical screen is
        // 1280×800 — and that is what the model gets.
        let (w, h, scale) = dpi_change_reading(2560, 1600, 2.0);
        assert_eq!(scale, Some(2.0), "a DPI change must carry its new factor");
        assert_eq!(
            logical_screen(
                f64::from(w),
                f64::from(h),
                scale.unwrap_or(1.0),
                FALLBACK_SCREEN
            ),
            Bounds::new(0, 0, 1280, 800)
        );
        // And the alternative really is worse: the stale 1× factor would make the
        // screen twice as wide as the panel is.
        assert_eq!(
            logical_screen(f64::from(w), f64::from(h), 1.0, FALLBACK_SCREEN),
            Bounds::new(0, 0, 2560, 1600),
            "re-reading a stale scale factor is the defect this path prevents"
        );
    }
}
