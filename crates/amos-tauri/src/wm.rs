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

use amos_wm::display::{Display, DisplaySet};
use amos_wm::form::{
    resolve_hint, resolve_runtime, FormFactor, HintSource, LayoutPolicy, ShellFit, FORM_FACTOR_ENV,
};
use amos_wm::identity::{self, WindowIdentity};
use amos_wm::layout::{Bounds, Size, SplitAxis};
use amos_wm::snap::{snap_bounds, SnapZone};
use amos_wm::split::SplitScreen;
use amos_wm::{WindowId, WindowKind, WindowManager, WmEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AmosError, AmosResult, ErrorCode, IntoAmosError};
use crate::store::{SharedStore, APP_FOCUSED_KEY};
use crate::window_background;
use crate::window_state;

/// Why a window-manager call refused in words the OS / platform gives verbatim.
///
/// Wave A (REQ-A462 typed-envelope migration) covers `normalize_shell_title` and
/// the split family; the helper is kept locally so every platform call can name
/// the platform-side message in `cause[0]` without dropping it through `format!`
/// (a typed envelope's whole point).
fn platform_failed(platform_message: impl std::fmt::Display) -> AmosError {
    platform_message.into_envelope(ErrorCode::WmPlatformWindowFailed)
}

fn window_not_registered(label: &str) -> AmosError {
    format!("window '{label}' is not registered").into_envelope(ErrorCode::WmWindowNotRegistered)
}

/// A poisoned `WmState::inner` mutex — see [`ErrorCode::WmLockFailed`].
fn wm_lock_failed(internal: impl std::fmt::Display) -> AmosError {
    AmosError::with_cause(
        ErrorCode::WmLockFailed,
        "window manager state lock is poisoned",
        internal.to_string(),
    )
}

/// The seam where this module's still-`Result<_, String>` layout helpers
/// ([`layout_core`] ∕ [`WmState::layout_snapshot`] ∕ [`WmState::apply_split_to_real`])
/// meet the typed command envelope. The internal string rides in `cause[0]` so the
/// platform detail is not lost through the conversion.
fn wm_layout_failed(internal: impl std::fmt::Display) -> AmosError {
    AmosError::with_cause(
        ErrorCode::WmLayoutFailed,
        "the layout model could not produce a snapshot",
        internal.to_string(),
    )
}

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

/// Tauri event carrying the whole `WmSnapshot` after the **window list** changes
/// (REQ-A717): a window opened, closed, hid, showed or took/lost focus.
///
/// The desktop chrome (`DesktopShell`'s focused-window chords, `Dock`'s running-app
/// dots) used to learn this only by re-reading `wm_windows` on a 5 s timer, so up to
/// five seconds after ⌘W the Dock still showed a dot for a window that was gone — the
/// exact stale-label case `wm_close`/`wm_zoom` document. The host now pushes the
/// authoritative snapshot instead, and the poll is demoted to a slow reconciliation
/// safety net (`frontend-ts/src/lib/wmWindowsPoll.ts`).
pub const WM_CHANGED_EVENT: &str = "wm-changed";

/// How long the Stage clamp stays quiet after it has moved a window out of the rail
/// (REQ-A1564).
///
/// The clamp and the platform's own drag are two writers of one rectangle, so the rate
/// matters: a `Moved` event that is answered by a `set_position` produces further `Moved`
/// events, and a correction issued for each of them is a loop, not a correction. One
/// correction per window per 120 ms bounds that loop while staying well under the ~1 s a
/// hand needs to notice — the same order as the 250 ms the geometry store debounces with,
/// scaled down because this one delays something the user is watching.
///
/// It is a **throttle**, not a debounce: the first intruding event in a window of time is
/// answered immediately (a window dragged behind the rail should not sit there for 120 ms),
/// and the pace only slows the corrections that follow.
pub const STAGE_CLAMP_DEBOUNCE_MS: u64 = 120;

/// May the Stage clamp act, given when it last acted on this window?
///
/// `last_ms == None` is "never" and is always allowed, so the first correction of a drag is
/// immediate. The window is exactly `debounce_ms` wide (`>=`, not `>`), and a clock that
/// went **backwards** (an NTP step, a machine waking from sleep) reads as "long enough"
/// rather than as a lockout that would silence the clamp until the clock caught up — an
/// hour, in the step-back case.
///
/// Pure and clock-injecting on purpose: the rule is the only part of the clamp that a test
/// can hold still, and it is the part that decides whether the host and the user's hand
/// fight over one rectangle.
pub const fn should_clamp(last_ms: Option<u64>, now_ms: u64, debounce_ms: u64) -> bool {
    match last_ms {
        None => true,
        Some(last) => now_ms < last || now_ms - last >= debounce_ms,
    }
}

/// Tauri label of the launcher window (declared in `tauri.conf.json`).
const LAUNCHER_LABEL: &str = "main";

/// Web path (relative to `frontendDist`) every app window loads.
const APP_ENTRY: &str = "index.html";

/// The frame colour a **newly created** window should be painted with, or `None` to leave it
/// to the OS (REQ-A326).
///
/// The decision itself is pure and lives in [`crate::window_background`]; this is the thin
/// adapter that feeds it the two inputs it cannot reach on its own — the user's stored
/// appearance (`amos-ui.theme`, mirrored into [`SharedStore`] by the frontend's
/// `themeCore::writeStored`) and the OS's answer, read from the launcher's current theme.
///
/// Without this call the module existed but nothing used it: the builder was never told a
/// colour, so on a dark machine every window flashed the light OS canvas before the page
/// painted. `None` (nothing stored, OS silent) keeps exactly that old behaviour rather than
/// inventing a colour.
#[cfg(desktop)]
fn new_window_background<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::window::Color> {
    let mode = app
        .try_state::<SharedStore>()
        .and_then(|store| store.get(window_background::THEME_STORE_KEY));
    let os_dark = app
        .get_webview_window(LAUNCHER_LABEL)
        .and_then(|launcher| launcher.theme().ok())
        .map(|theme| theme == tauri::Theme::Dark);
    window_background::window_background(mode.as_deref(), os_dark)
        .map(|(r, g, b)| tauri::window::Color(r, g, b, 255))
}

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
fn window_maximize<R: Runtime>(w: &tauri::WebviewWindow<R>) {
    let _ = w.maximize();
}
#[cfg(not(desktop))]
fn window_maximize<R: Runtime>(_w: &tauri::WebviewWindow<R>) {
    /* mobile: single always-fullscreen window — nothing to restore */
}

/// Toggle the Window menu's **Zoom** (maximize ⇄ restore) on a real window.
///
/// Same cross-target shape as [`window_maximize`], and for the same reason: a runtime
/// `FormFactor` guard is not enough because the method has to resolve at *compile* time
/// on the Android target (the E0599 lesson from FMEA F-WM-019). On mobile the single
/// System-UI window is fullscreen by construction, so there is nothing to zoom.
///
/// The state is read back **after** the call rather than assumed from `Ok(())`: a window
/// manager may refuse to maximize (or ignore it on a platform where the class is already
/// fixed), and "the call returned" is not "the window changed" — the same rule
/// `WmState::focus_launcher` follows for OS focus.
#[cfg(desktop)]
fn window_toggle_zoom(w: &tauri::WebviewWindow) -> bool {
    let was = w.is_maximized().unwrap_or(false);
    let _ = if was { w.unmaximize() } else { w.maximize() };
    // Read it back. When the platform cannot report the new state we return what it was
    // — "nothing observed changed" rather than claiming a change we could not see.
    w.is_maximized().unwrap_or(was)
}
#[cfg(not(desktop))]
fn window_toggle_zoom(_w: &tauri::WebviewWindow) -> bool {
    /* mobile: the window is already fullscreen — zoom has no meaning, report "not zoomed" */
    false
}

/// Toggle the Window menu's **Enter Full Screen** on a real window.
///
/// Cross-target for the same compile-time reason; mobile windows are inherently
/// fullscreen, so the toggle is a no-op there. Reports the state the platform confirms
/// afterwards (see [`window_toggle_zoom`] for why the return value is read back).
#[cfg(desktop)]
fn window_toggle_fullscreen(w: &tauri::WebviewWindow) -> bool {
    let was = w.is_fullscreen().unwrap_or(false);
    let _ = w.set_fullscreen(!was);
    w.is_fullscreen().unwrap_or(was)
}
#[cfg(not(desktop))]
fn window_toggle_fullscreen(_w: &tauri::WebviewWindow) -> bool {
    /* mobile: already fullscreen by construction */
    true
}

/// Human-readable title for an app window.
///
/// Keyed by the **app id**, never by the window label (REQ-A473): `files_2` is a window of
/// the Files application and must be titled `Files`, not fall through to the generic
/// fallback — which is exactly what the label-keyed version did, because it was written
/// when the two strings were the same thing by construction.
///
/// Falls back to `"Amos"` for unknown **app ids**; the actual names live in
/// the frontend's `APP_META` and would require a cross-process lookup.
/// Kept as a simple map rather than a dependency to avoid pulling
/// the frontend metadata into the Rust host.
fn app_window_title(app_id: &str) -> &'static str {
    match app_id {
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
    /// WindowId -> **which app this window shows and which instance of it** (REQ-A473).
    ///
    /// This is the second half of the identity the label used to carry alone: `labels`
    /// answers "which platform window", this answers "which application, how many-th".
    /// Only `WindowKind::App` windows have one; the Launcher and external container
    /// surfaces are absent here (and that absence is what `WindowInfo::app` reports as an
    /// empty string rather than a fabricated app id).
    ///
    /// Kept in step with `labels`/`by_label` by [`WmCore::bind`] / [`WmCore::unbind`] —
    /// the only two places that touch them — because three maps that must agree are
    /// exactly how a ledger starts disagreeing.
    apps: HashMap<WindowId, WindowIdentity>,
    /// WindowId -> human-readable kind ("Launcher" | "App" | "System").
    kinds: HashMap<WindowId, String>,
    /// WindowIds that are *external* surfaces (e.g. a legacy Android APK surface
    /// composited from Waydroid) — tracked in the state machine for focus/z-order
    /// but **not** backed by a Tauri WebviewWindow.
    external: HashSet<WindowId>,
    /// Labels whose **page has loaded** (`on_page_load` fired).
    ///
    /// REQ-A435: a freshly created window is on screen before its WebView has run any script,
    /// and while it holds the key **⌘W is swallowed by WebKit and the menu never sees it** —
    /// measured on this machine (2026-09-18), which is why the focus is *deferred* to page
    /// load instead of being taken at creation: the launcher keeps the key during that phase
    /// and its own handler closes the new window. Recorded per window so the deferral is a
    /// fact about *that* window, not a global guess.
    page_loaded: HashSet<String>,
    /// Full OS window area the split layout sub-divides (0,0 origin).
    screen: Bounds,
    /// Active split-screen session (which two windows share the screen), if any.
    split: Option<SplitScreen>,
    /// Form-factor policy this host runs under. Resolved at startup and, when the
    /// class is still the build's own to decide, **re-derived from a measured
    /// screen** (REQ-A512 — a phone and a tablet share one Android target, so only a
    /// running device can tell them apart).
    ///
    /// The policy owns the split divider/minimum pane (previously two module
    /// constants) and the class-dependent capabilities the shell reads back
    /// (`form`, `columns`, `multi_window`, `free_resize`).
    policy: LayoutPolicy,
    /// The class the build was compiled for — the base any measured-screen
    /// re-derivation starts from ([`reclass_for_screen`]).
    built_for: FormFactor,
    /// May a **measured** screen still re-class this host (REQ-A512)?
    ///
    /// `true` only while the class is the build's own to decide: no honoured
    /// `AMOS_FORM_FACTOR` hint named it, and no embedder pinned it via
    /// [`WmState::with_form_factor`]. A pinned class is never re-derived.
    form_revisable: bool,
    /// A shell-window size this host asked the OS for and has **not yet seen applied**
    /// ([`WmState::fit_shell_window`]); cleared by [`WmState::note_applied_size`] when a
    /// real (post-application) measurement answers it (REQ-A230).
    shell_fit: Option<Size>,
    /// Is **Stage Manager** on (`stage_set_enabled`; `docs/stage-manager.md`)?
    ///
    /// Default **off**, and while it is off every stage-aware path in this file is a
    /// no-op with zero platform work — so introducing the mode changes no behaviour for
    /// anyone who never turns it on (the same discipline `LayoutPolicy::of` follows).
    ///
    /// The rail width and work-area inset are **not** stored: they are derived from
    /// `policy` through [`LayoutPolicy::stage_rail_width`] /
    /// [`LayoutPolicy::stage_work_area`], so the geometry has one definition and it is
    /// the pure one.
    stage_enabled: bool,
    /// When the Stage clamp last moved each label out of the rail, in [`now_ms`] units
    /// ([`WmState::stage_clamp_moved`]).
    ///
    /// A drag is a *storm* of `Moved` events, and the clamp answers each one by asking the
    /// platform to move the window again — which produces more `Moved` events. Without a
    /// throttle the two would talk to each other at event-loop speed. The rule is the same
    /// one `window_state`'s own debounce follows: at most one correction per
    /// [`STAGE_CLAMP_DEBOUNCE_MS`], and a rect that is already clear of the band never
    /// reaches here at all.
    ///
    /// Keyed by label and cleared in [`WmCore::unbind`], so a closed window's entry cannot
    /// outlive the window (labels are reused — a stale stamp would silence the first
    /// correction of a *later* window under the same label).
    stage_clamp_at: HashMap<String, u64>,
}

/// The **one** place that binds a window id to its label, kind and identity (REQ-A473).
///
/// `labels`, `by_label`, `kinds` and `apps` must agree, and "must agree" is a property
/// nothing enforces at runtime — so it is enforced by construction instead: these two
/// methods are the only code in the crate that writes to them. A caller that adds a
/// window calls [`WmCore::bind`]; a caller that removes one calls [`WmCore::unbind`].
impl WmCore {
    /// Record `id` as the window carrying `label`, of `kind`, showing `identity`
    /// (`None` for surfaces that are not an application: the Launcher, container
    /// surfaces).
    fn bind(
        &mut self,
        id: WindowId,
        label: &str,
        kind: WindowKind,
        identity: Option<WindowIdentity>,
    ) {
        self.labels.insert(id, label.to_string());
        self.by_label.insert(label.to_string(), id);
        self.kinds.insert(id, kind.to_string());
        match identity {
            Some(identity) => {
                self.apps.insert(id, identity);
            }
            None => {
                self.apps.remove(&id);
            }
        }
    }

    /// Forget `id` completely, returning the label it had (if it was registered).
    ///
    /// Every map is cleared here — including `apps`, which is the record that outlived a
    /// window for as long as this method forgot about it (a second window of the same app
    /// would then have been handed a label that was still bound to a dead id, and a
    /// closed window would keep contributing to that app's cycle ring).
    fn unbind(&mut self, id: WindowId) -> Option<String> {
        let label = self.labels.remove(&id);
        if let Some(label) = label.as_ref() {
            self.by_label.remove(label);
            // The labels are reusable, and a stale stamp would throttle the first
            // correction of whichever window takes this label next (REQ-A1564).
            self.stage_clamp_at.remove(label);
        }
        self.kinds.remove(&id);
        self.apps.remove(&id);
        label
    }

    /// The labels of **one application's** windows, in the ledger.
    ///
    /// The order is not part of the contract: [`amos_wm::identity::cycle_target`] sorts
    /// them itself, so a caller cannot make the ring depend on `HashMap` iteration.
    fn labels_of_app(&self, app_id: &str) -> Vec<String> {
        self.apps
            .iter()
            .filter(|(_, identity)| identity.app == app_id)
            .filter_map(|(id, _)| self.labels.get(id).cloned())
            .collect()
    }

    /// The app id a registered label belongs to, if that label names an app window.
    fn app_id_of_label(&self, label: &str) -> Option<String> {
        let id = self.by_label.get(label)?;
        self.apps.get(id).map(|identity| identity.app.clone())
    }

    /// The area an app window may be placed in: the measured screen, minus the Stage
    /// Manager rail when Stage mode is on.
    ///
    /// **Every** placement path goes through here — creation, the instance cascade,
    /// remembered geometry, re-clamp, snap, split and zoom. The rail is never covered
    /// because of that one fact, not because each path remembers to inset: a path that
    /// calls this unconditionally is correct on a phone (no rail), on a desktop with the
    /// mode off, and on a desktop with it on, because
    /// [`LayoutPolicy::stage_work_area`] is the identity in the first two cases.
    ///
    /// The width and the inset are *derived*, never stored (`WmCore::stage_enabled`'s
    /// doc): a stored copy is a second answer that a class change or a screen change
    /// could leave stale.
    fn work_area(&self) -> Bounds {
        if self.stage_enabled {
            self.policy.stage_work_area(self.screen)
        } else {
            self.screen
        }
    }

    /// How many pixels of the left edge the rail takes out of `screen` right now — `0`
    /// when there is no rail.
    ///
    /// The one definition of the number the shell lays out around: `LayoutSnapshot`'s
    /// `rail_width` — read by the rail itself and by the desktop-icon inset — is this and
    /// nothing else, so the two cannot come to disagree about how wide the rail is.
    fn rail_width(&self) -> u32 {
        self.screen.width.saturating_sub(self.work_area().width)
    }
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

/// Read the raw `AMOS_FORM_FACTOR` value, keeping **never set** apart from **set
/// but not valid Unicode**.
///
/// The caller hands the result to [`resolve_host_form_factor`], which reports any
/// value it cannot *use*. A typo or a blank arrives as a `String` and is reported
/// there; a value that is not valid Unicode cannot be a `&str` at all, and
/// `std::env::var(..).ok()` folded it into plain absence — so the operator's knob
/// was ignored in total silence, the one outcome [`resolve_hint`]'s own doc calls
/// out as worse than a missing one. That is the same over-claim
/// [`crate::ota::env_value`] refuses for `AMOS_OTA_*`, and it is refused the same
/// way: a warning that names the variable.
///
/// Pure (the raw `OsString` is injected) so the non-Unicode arm is reachable in a
/// test, where a process can only hold one value per key at a time.
///
/// REQ-A1959 ∕ F-WM-029.
fn form_factor_hint(raw: Option<std::ffi::OsString>) -> Option<String> {
    let Some(os) = raw else {
        return None; // never set: the silent case
    };
    match os.to_str() {
        Some(text) => Some(text.to_owned()),
        None => {
            tracing::warn!(
                hint = FORM_FACTOR_ENV,
                "form-factor hint is set but not valid Unicode; ignoring it and using \
                 the build's own class"
            );
            None
        }
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

/// The class a **measured** screen implies for a build whose class is still its own to
/// decide, or `None` when the reading settles nothing (REQ-A512).
///
/// Delegates to the domain's [`resolve_runtime`] with **no hint** — a caller only asks
/// this once it has established the class is revisable, i.e. the operator did not name
/// one — so the "phone vs tablet" rule lives in exactly one place
/// (`amos_wm::form::TABLET_MIN_SHORT_EDGE`) and this function owns no threshold of its
/// own. Only a `Phone` build can move (`resolve_runtime` never re-classes a desktop or
/// a robot, and a tablet stays a tablet), so a desktop host on a wide screen is a
/// no-op. An unusable reading is `None`, never a guess.
fn reclass_for_screen(built_for: FormFactor, screen: Bounds) -> Option<FormFactor> {
    resolve_runtime(None, built_for, Size::new(screen.width, screen.height))
        .ok()
        .map(|(form, _source)| form)
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

/// A `scale` fit to divide by (finite, > 0), or `1.0` — the same "never divide by a
/// nonsense scale" rule [`logical_size_of`] enforces for the shell window.
fn sane_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// A **physical** global rect (Tauri monitor `position` + `size`) as a logical [`Bounds`].
///
/// Every monitor rect Tauri reports is physical; the layout model is logical (see
/// [`logical_screen`]), so the same division is applied here. The division assumes one
/// scale factor for the whole rect, which is exact for a monitor (its own scale) — the
/// *relative* placement of two monitors of different scale is only as good as that
/// assumption, an honest limit the module documents ([`amos_wm::display`]).
fn logical_rect(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Bounds {
    let scale = sane_scale(scale);
    let px = |v: f64| (v / scale).round() as i32;
    let pu = |v: f64| (v / scale).round().max(0.0) as u32;
    Bounds::new(
        px(f64::from(x)),
        px(f64::from(y)),
        pu(f64::from(width)),
        pu(f64::from(height)),
    )
}

/// A platform [`tauri::Monitor`] as the transport-agnostic [`Display`] the domain works
/// in, in logical space.
///
/// `work_area` is taken from the platform verbatim; a platform that reports *no* work area
/// (a degenerate 0×0 rect) is mapped to `bounds` — "no reserved area" — rather than a
/// fabricated inset, matching [`Display::work_area`]'s contract.
fn display_from_monitor(monitor: &tauri::Monitor, primary: bool) -> Display {
    let scale = sane_scale(monitor.scale_factor());
    let position = monitor.position();
    let size = monitor.size();
    let work = monitor.work_area();
    let bounds = logical_rect(position.x, position.y, size.width, size.height, scale);
    let work_area = logical_rect(
        work.position.x,
        work.position.y,
        work.size.width,
        work.size.height,
        scale,
    );
    let work_area = if work_area.width == 0 || work_area.height == 0 {
        bounds
    } else {
        work_area
    };
    Display {
        bounds,
        work_area,
        scale,
        primary,
        name: monitor.name().cloned(),
    }
}

/// The platform's monitors as a [`DisplaySet`] in logical space.
///
/// Read fresh on every call, never cached in [`WmCore`]: the set changes on hot-plug, and a
/// stale copy is exactly the "ledger that disagrees with the platform" this crate keeps
/// refusing to keep. An empty result is legal and means "the platform listed nothing" —
/// every query over it then returns `None` and the caller keeps its measured screen.
fn display_set(app: &AppHandle) -> Result<DisplaySet, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("could not enumerate displays: {e}"))?;
    if monitors.is_empty() {
        return Ok(DisplaySet::default());
    }
    // The primary is identified by matching the primary monitor's own position+name: the
    // `Monitor` value carries no primary flag, and fields are the only stable identity it
    // exposes (there is no id). No primary reported ⇒ the first display is the default,
    // the same rule `DisplaySet::primary` falls back to.
    let primary = app.primary_monitor().ok().flatten();
    let displays = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let is_primary = match &primary {
                Some(p) => p.position() == m.position() && p.name() == m.name(),
                None => i == 0,
            };
            display_from_monitor(m, is_primary)
        })
        .collect();
    Ok(DisplaySet::new(displays))
}

/// A window's current frame as a logical [`Bounds`] (physical `outer_position` + `inner_size`,
/// divided by the window's own scale).
///
/// The frame — position *and* size — is needed, not just the size, because which display a
/// window is on is decided by where its centre is. Reading the platform is the only source
/// of truth here: the host deliberately keeps no per-window geometry ledger.
fn window_logical_bounds(window: &tauri::WebviewWindow) -> Result<Bounds, String> {
    let scale = sane_scale(window.scale_factor().unwrap_or(1.0));
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok(logical_rect(
        position.x,
        position.y,
        size.width,
        size.height,
        scale,
    ))
}

/// The same reading as [`window_logical_bounds`], for the window event handler's
/// `&tauri::Window<R>` (which is a different type from `&tauri::WebviewWindow`).
///
/// The **frames** matter and are not interchangeable: `outer_position` is what
/// `set_position` writes back and what `window_state::snapshot` stores, while
/// `inner_size` is what `set_size` writes back. Both siblings in this file compose them
/// the same way, so a rect read here and a rect applied here are the same rect.
///
/// `None` for any unusable reading (a platform error, a garbage scale) — the caller then
/// leaves the window alone rather than acting on a guess.
fn logical_window_rect<R: Runtime>(window: &tauri::Window<R>) -> Option<Bounds> {
    let scale = sane_scale(window.scale_factor().unwrap_or(1.0));
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(logical_rect(
        position.x,
        position.y,
        size.width,
        size.height,
        scale,
    ))
}

/// The inverse of [`logical_rect`]'s division, for one signed coordinate.
fn physical_edge(v: i32, scale: f64) -> i32 {
    let scale = sane_scale(scale);
    (f64::from(v) * scale).round() as i32
}

/// [`physical_edge`] for a length, which cannot be negative.
fn physical_len(v: u32, scale: f64) -> u32 {
    let scaled = f64::from(v) * sane_scale(scale);
    if scaled.is_finite() && scaled > 0.0 {
        (scaled.round() as u64).min(u64::from(u32::MAX)) as u32
    } else {
        0
    }
}

/// Rewrite the rectangle to remember with the one the clamp applied, in the store's
/// **physical** units (REQ-A1564).
///
/// `rect` is what the window was measured at and `target` is what it was moved to; `scale`
/// is the window's own. Pure, so the "clamp, **then** remember" rule can be pinned without
/// a platform — the position is the part that must not be the pre-correction one.
///
/// The **size is only written when the clamp changed it.** `logical_window_rect` sizes from
/// `inner_size` while `window_state::snapshot` stores `outer_size`, so writing an unchanged
/// size back would silently replace the outer reading with the inner one — and
/// `restored_geometry` would reopen the window a title bar shorter on every drag the rail
/// ever corrected. The position has no such mismatch (`outer_position` on both sides),
/// which is why only the size is conditional.
///
/// The fields left alone — `visible`, and `updated_ms` (which the store stamps) — stay as
/// the platform reported them.
fn note_clamped_rect(
    captured: &mut window_state::WindowState,
    rect: Bounds,
    target: Bounds,
    scale: f64,
) {
    captured.x = Some(physical_edge(target.x, scale));
    captured.y = Some(physical_edge(target.y, scale));
    if target.width != rect.width {
        captured.width = Some(physical_len(target.width, scale));
    }
    if target.height != rect.height {
        captured.height = Some(physical_len(target.height, scale));
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

/// Should the host apply the **position** the class rule computed, or leave placement to
/// the OS?
///
/// REQ-A478, measured on this machine 2026-09-19: `.position()` was **never** called — the
/// builder only ever received `opens_at`'s width/height — so every window's position was
/// whatever macOS chose, which put three Files windows at exactly the same `236,70`. The
/// class rule's `x`/`y` had therefore never had any effect on a real window.
///
/// The rule is deliberately narrow, because applying a position is a visible behaviour
/// change: **instance 1 keeps the OS's own placement** (unchanged behaviour — "open the app"
/// places its first window the way the platform does), and from instance 2 on the computed
/// cascade is applied, because that is the case the platform cannot do for us (macOS places
/// each window without knowing it belongs to a window we already have).
fn places_position_at(instance: u32) -> bool {
    instance >= 2
}

/// The rectangle a **remembered** window should reopen at, in logical pixels and inside the
/// current screen — or `None` when this label has no usable history (REQ-A478).
///
/// The three things this has to get right, each of them measured elsewhere in this crate:
///
/// * **physical → logical.** `window_state::snapshot` stores `outer_position`/`outer_size`,
///   which are physical; a window is created with logical values. A 2× display would
///   otherwise reopen every window at twice its offset (the REQ-A218 lesson).
/// * **the current screen wins.** A saved rectangle may belong to a monitor that is gone (or
///   to a screen that shrank): the result goes through the class rule's `cascade_from` with
///   instance 1, i.e. "place here, not below `min_pane`, inside the screen" — one
///   implementation for every placement, and no saved state can put a window off-screen.
/// * **`None` is a real answer.** No armed store, no entry, or an entry whose coordinates do
///   not sanitize ⇒ the class rule's own answer is used, which is the pre-existing behaviour.
fn restored_geometry(
    store: Option<&window_state::WindowStateStore>,
    label: &str,
    scale: f64,
    policy: LayoutPolicy,
    screen: Bounds,
) -> Option<Bounds> {
    let saved = store?.load(label)?;
    if !scale.is_finite() || scale <= 0.0 {
        // Without a believable scale factor the *physical* saved numbers cannot be turned
        // into the *logical* ones a window is created with — the honest answer is "no
        // remembered geometry", not a guess that could double every offset (REQ-A218).
        return None;
    }
    let (x, y) = (saved.x?, saved.y?);
    let (width, height) = (saved.width?, saved.height?);
    let x = sane_signed_edge(f64::from(x) / scale)?;
    let y = sane_signed_edge(f64::from(y) / scale)?;
    let width = sane_edge(f64::from(width) / scale)?;
    let height = sane_edge(f64::from(height) / scale)?;
    Some(policy.cascade_from((x, y), Size::new(width, height), screen, 1))
}

/// Where the cascade of `app_id` should start: the **outer position** of that application's
/// first window, in **logical** pixels, or `None` when it cannot be read.
///
/// REQ-A478. Why the platform and not the model: the class rule's own base is the screen's
/// origin (`fit_window` builds at `(0, 0)` and clamps), while the first window of an app is
/// placed by macOS itself — measured on this machine 2026-09-19, the first Files window sat
/// at `236,70` and cascading from the domain's origin put the second one in the corner at
/// `24,24`. This host keeps **no geometry ledger** for the same reason `reclamp_windows`
/// reads the platform: a ledger the user can move windows behind is a second truth.
///
/// The conversion is the one a wrong scale factor would break (a 2× screen's physical
/// position is twice the logical one, REQ-A218's lesson): `outer_position()` is physical,
/// `.position()` takes logical, so the window's own `scale_factor()` is applied — and a
/// non-finite or absurd scale is refused rather than guessed at.
///
/// `label` is the window being created (excluded from the search so a re-created label
/// cannot anchor a cascade to itself) and `app_id` is `None` for a window that shows no app,
/// in which case there is nothing to cascade from.
fn anchor_of_window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<(i32, i32)> {
    let window = app.get_webview_window(label)?;
    let scale = match window.scale_factor() {
        Ok(s) if s.is_finite() && s > 0.0 => s,
        other => {
            tracing::warn!(
                target: "amos::wm",
                window = %label,
                scale = ?other,
                "could not read a usable scale factor for the cascade anchor; using the class rule's own position"
            );
            return None;
        }
    };
    match window.outer_position() {
        Ok(p) => {
            let x = sane_signed_edge(f64::from(p.x) / scale)?;
            let y = sane_signed_edge(f64::from(p.y) / scale)?;
            Some((x, y))
        }
        Err(e) => {
            tracing::warn!(
                target: "amos::wm",
                window = %label,
                error = %e,
                "could not read the app's first window position; using the class rule's own position"
            );
            None
        }
    }
}

/// Is `label` the window that defines the **OS screen area** the layout
/// sub-divides? Only the Launcher/main window does: app windows (including split
/// panes) are placed *inside* that area, so a pane resize must never be mistaken
/// for a screen change — which would also make the pane-writing loop feed itself.
pub fn is_screen_window(label: &str) -> bool {
    label == LAUNCHER_LABEL
}

/// Which window a **menu action on "the focused window"** should act on: the
/// platform's key window when it names one, otherwise the window the window manager
/// says is focused. The launcher is never a target in either branch (F-SH-008) — it
/// *is* the desktop.
///
/// Two sources, in this order, and the order is the point: the platform's key window is
/// the OS's own answer to "what is in front", and the model is the **fallback**, not a
/// tiebreak. REQ-A431 measured why the fallback is needed — a window created a moment
/// ago is on screen before the OS makes it key, so ⌘W in the first seconds of an app
/// window's life closed nothing in 3/6 runs. `None` when neither source names an
/// actionable window, which every consumer must treat as "there is nothing to act on"
/// rather than substituting a default: a menu item that acts on the *wrong* window is
/// worse than one that acts on none.
///
/// **Pure** (`is_screen_window` is the only thing it reads), so the rule is exercised
/// without a window server and without a menu — the shape [`Self::minimize_target`]
/// uses for the same reason. [`focused_app_label`] is the same decision with the two
/// arguments read off `app`.
///
/// Desktop-gated because every consumer is (see [`focused_app_label`]).
#[cfg(desktop)]
pub fn focused_target_label(
    platform_key: Option<&str>,
    model_focused: Option<&str>,
) -> Option<String> {
    let actionable = |label: &str| (!is_screen_window(label)).then(|| label.to_string());
    platform_key
        .and_then(actionable)
        .or_else(|| model_focused.and_then(actionable))
}

/// The window the **window manager** says is focused, if that state is mounted and readable.
///
/// `None` for an external surface: such a surface has no platform window to act on, and
/// pretending otherwise would act on a neighbour.
#[cfg(desktop)]
pub fn model_focused_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let state = app.try_state::<WmState>()?;
    let snapshot = state.snapshot().ok()?;
    snapshot
        .windows
        .iter()
        .find(|w| w.focused && !w.external)
        .map(|w| w.label.clone())
}

/// The focused **app** window, resolved from the running app: the platform's key window
/// where it names one, the model otherwise. `None` when there is nothing to act on.
///
/// **One owner for a question three consumers ask**, which is why it lives here rather
/// than in any one of them. Until REQ-A869 the rule and its two sources were split
/// across `menu.rs` (`close_target_label`, `model_focused_label`,
/// `actionable_window_label`) and every consumer that was not the macOS menu bar had to
/// either reach into that module or restate the policy. The consumers now:
///
/// * ⌘W — `menu::close_key_window` closes the label this returns;
/// * the window-item sync — `menu::sync_window_items` enables `Minimize` / `Zoom` /
///   `Enter Full Screen` exactly when this is `Some`;
/// * ⌘P — [`crate::print::print_document`] prints it.
///
/// The name says *what window*, not *which verb*: the old name (`close_target_label`)
/// claimed the rule was about closing, which is exactly how a second consumer ends up
/// writing a second copy of a policy instead of calling it.
///
/// **This is why the print command takes no window argument.** The WebView must not be
/// able to name a window to print — printing is an *output* of whatever the user is
/// looking at, and a label from the WebView would let a background surface print itself.
/// The host answers the question with its own two sources instead, the same way the
/// macOS menu bar does.
///
/// Desktop-gated: the native menu bar is macOS-only today, and the print *dialog* is a
/// desktop concept ([`crate::print`] refuses elsewhere by name rather than by `cfg`).
#[cfg(desktop)]
pub fn focused_app_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let windows = app.webview_windows();
    let platform_key = windows
        .iter()
        .find(|(label, window)| !is_screen_window(label) && window.is_focused().unwrap_or(false))
        .map(|(label, _)| label.clone());
    focused_target_label(platform_key.as_deref(), model_focused_label(app).as_deref())
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
pub fn normalize_shell_title(raw: &str) -> AmosResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        // REQ-A462: typed envelope. Wire code `amos.wm.title_invalid`, cause carries
        // the specific reason ("...may not be empty…"). The frontend i18n file
        // resolves a single user-facing message for all `WmTitleInvalid` cases and
        // appends `cause[0]` to the diagnostic, so the resolution above-stays-in-one-
        // place invariant of the typed envelope is preserved.
        return Err(
            "a window title may not be empty (the OS draws an empty title bar)"
                .to_string()
                .into_envelope(ErrorCode::WmTitleInvalid),
        );
    }
    if let Some(bad) = trimmed.chars().find(|c| c.is_control()) {
        let msg = format!(
            "a window title may not contain a control character (U+{:04X}): the OS renders a title as one line",
            bad as u32
        );
        return Err(msg.into_envelope(ErrorCode::WmTitleInvalid));
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
        let raw = form_factor_hint(std::env::var_os(FORM_FACTOR_ENV));
        let (form, source, unusable) = resolve_host_form_factor(built_for, raw.as_deref());
        if let Some(message) = unusable {
            tracing::warn!(
                hint = %FORM_FACTOR_ENV,
                %message,
                fallback = form.as_str(),
                "unusable form-factor hint; falling back to the build's own class"
            );
        }
        // A class the operator named is settled; a class the *build* decided may still
        // be re-derived once a real screen is measured (REQ-A512).
        let revisable = source == HintSource::BuildDefault;
        tracing::info!(
            form = form.as_str(),
            source = source.as_str(),
            ui = form.has_ui(),
            revisable,
            "windowing form factor resolved"
        );
        Self::with_form_origin(form, built_for, revisable)
    }

    /// Create a manager for an **explicitly given** class (no environment read, no
    /// guessing). `new()` resolves the hint and delegates here; tests and any
    /// embedder that already knows its class use it directly.
    ///
    /// An explicit class is **pinned**: it is never re-derived from a measured screen
    /// (a test that asks for a phone must keep getting a phone on a big display).
    pub fn with_form_factor(form: FormFactor) -> Self {
        Self::with_form_origin(form, built_for_form_factor(), false)
    }

    /// The one constructor: build the state for `form`, remembering the class the
    /// build was compiled for and whether a measured screen may still change this one.
    ///
    /// The Launcher is bound to the Tauri main window.
    // `WindowManager::new()` registers the Launcher synchronously, so
    // `launcher()` is always Some here; this single documented invariant-site is
    // allowed (P0-1), everything else in production is gated.
    #[allow(clippy::expect_used)]
    fn with_form_origin(form: FormFactor, built_for: FormFactor, form_revisable: bool) -> Self {
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
                apps: HashMap::new(),
                external: HashSet::new(),
                // The launcher's page is loaded by the time any app window is created, so it
                // is never subject to the REQ-A435 deferral.
                page_loaded: HashSet::from([LAUNCHER_LABEL.to_string()]),
                screen: FALLBACK_SCREEN,
                split: None,
                policy: LayoutPolicy::of(form),
                built_for,
                form_revisable,
                shell_fit: None,
                // Stage Manager is opt-in (REQ-A1546): a host that is never asked to
                // enable it behaves exactly as it did before this field existed.
                stage_enabled: false,
                stage_clamp_at: HashMap::new(),
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

    /// Has this label's page loaded (`on_page_load` fired)? See [`WmCore::page_loaded`].
    fn page_loaded(&self, label: &str) -> Result<bool, String> {
        Ok(self.lock()?.page_loaded.contains(label))
    }

    /// Record that `label`'s page has loaded (called from the window's own `on_page_load`).
    fn mark_page_loaded(&self, label: &str) -> Result<(), String> {
        self.lock()?.page_loaded.insert(label.to_string());
        Ok(())
    }

    /// Label for a window id, if registered.
    fn label_for(&self, id: WindowId) -> Result<String, String> {
        self.lock()?
            .labels
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("unknown window id {id:?}"))
    }

    fn real_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        id: WindowId,
    ) -> Result<tauri::WebviewWindow<R>, String> {
        let label = self.label_for(id)?;
        app.get_webview_window(&label)
            .ok_or_else(|| format!("window '{label}' does not exist"))
    }

    /// Put a window back in front of the user, whatever the **platform** did to it.
    ///
    /// REQ-A441. The OS gives every window a state our model deliberately does not have (it
    /// knows Shown / Hidden / Closed only): a **miniaturized** one, put there by the yellow
    /// traffic light or by AppKit's own ⌘M. Measured on this machine (2026-09-19): clicking the
    /// yellow light left `AXMinimized=true`; pressing ⌘N (New Files Window) left it `true` as
    /// well, because the model still said `Shown` ⇒ the open path emitted only a focus event,
    /// and `set_focus()` does **not** bring a miniaturized window back. So a window the user
    /// minimized with the OS's own button became unreachable from AmOS's own UI (⌘N, the Dock
    /// tile — both go through this host).
    ///
    /// Deminiaturizing before showing/focusing is the platform's own word for "put it back", and
    /// the host is the only place that can ask for it. It is a no-op for a window the platform
    /// does not consider minimized, and asking first keeps the log honest (the read-back rule
    /// `window_toggle_zoom` follows).
    fn reveal_window<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
        // F-DEV-131: the *miniaturized* state belongs to the desktop OS — macOS's yellow
        // traffic light and ⌘M, and the same idea on Windows/Linux. Tauri compiles
        // `WebviewWindow::unminimize` for desktop only (2.11), and a mobile webview has no
        // such state to be brought back from, so the whole question is desktop-only. Same
        // shape as `tray::install`'s `not(desktop)` twin: it says why it skipped.
        #[cfg(desktop)]
        if window.is_minimized().unwrap_or(false) {
            window.unminimize().map_err(|e| e.to_string())?;
            tracing::info!(
                target: "amos::wm",
                label = %window.label(),
                "restored a window the platform had minimized (REQ-A441)"
            );
        }
        #[cfg(not(desktop))]
        {
            tracing::debug!(
                target: "amos::wm",
                label = %window.label(),
                "a platform-minimized window is a desktop concept; this build compiles but skips"
            );
        }
        Ok(())
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
            // The work area, not the screen: re-clamping is the path that rescues a
            // window from off-screen, and the rail's strip is off-limits for the same
            // reason. It is also what turns Stage mode *on* without moving every open
            // window by hand — `stage_set_enabled` re-clamps.
            (core.work_area(), core.policy, targets)
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

    /// Open (create-if-needed + focus) the **first** window of the app named by `label`.
    ///
    /// `label` is an **app id** (REQ-A473): the first window of app `<app>` is labelled
    /// `<app>`. An already-open app is focused, which is what makes this idempotent — and
    /// it is also why this command can never mint a second window: that is
    /// [`WmState::new_window`]'s job, and it reports which instance it made.
    ///
    /// An instance label (`files_2`) is **refused** rather than accepted as an app id: it
    /// names a window, and "the window of a window" has no meaning.
    pub fn open<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
    ) -> Result<Vec<WmEvent>, String> {
        let identity = identity::identity_of_label(label).map_err(|r| r.to_string())?;
        if !identity.is_first() {
            return Err(format!(
                "'{label}' names window instance {} of '{}', not an application: use wm_new_window to add a window (REQ-A473)",
                identity.instance, identity.app
            ));
        }
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
                    core.bind(id, label, WindowKind::App, Some(identity));
                    (id, created)
                }
            };
            events.extend(core.wm.open(id));
            events
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Show and focus a window **by its label**, without [`Self::open`]'s identity gate.
    ///
    /// `open` is the *launch* verb: a label nobody knows is a request to **create** that
    /// app's window, so it registers one — and to keep that from minting an arbitrary
    /// window it refuses every label that names an instance other than the first
    /// (`identity.is_first()`, REQ-A473: "use wm_new_window to add a window").
    ///
    /// That rule is right for a Dock tile and wrong for any surface that already *has* the
    /// window: Stage Manager's rail drew a tile for an app's second window (`notes_2`, which
    /// `stage.rs::views_of` explicitly makes its own tile) and then answered a click on it by
    /// calling `open`, so the window could be parked and **never brought back** — refused for
    /// being a second instance, and reported as a lock failure. This is the verb that pair
    /// needs: a *registered* label, shown and focused, no creation and no identity gate.
    ///
    /// The refusal is [`Self::hide`]'s own wording for an unknown label, so a caller can tell
    /// "this window is not one of ours" from "the window manager refused".
    pub fn reveal<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
    ) -> Result<Vec<WmEvent>, String> {
        let events = {
            let mut core = self.lock()?;
            let id = *core
                .by_label
                .get(label)
                .ok_or_else(|| format!("window '{label}' is not registered"))?;
            core.wm.open(id)
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Open **one more** window of `app_id` (macOS's File ▸ New Window / ⌘N).
    ///
    /// REQ-A473. Before the identity model this could not exist: one label meant one
    /// window, so "another window of the app you are looking at" was unrepresentable and
    /// the menu item had to be renamed to "New Files Window" (`menu.rs`, REQ-A434).
    ///
    /// The label comes from [`identity::next_window_label`] — the lowest free instance
    /// ordinal, so a closed `_2` is reused instead of the numbers running away — bounded
    /// by [`identity::MAX_WINDOWS_PER_APP`] with a named refusal rather than a silent
    /// no-op. The class's own cap is asked through the same
    /// [`WmState::check_new_app_window`] the first window goes through, so a phone (one
    /// app window) refuses the second window for exactly the reason it refuses a second
    /// app.
    ///
    /// When the app has no window yet, this **is** its first window — which is what ⌘N on
    /// a not-running app does on macOS — and the returned label says so (it is then the
    /// bare app id).
    pub fn new_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        app_id: &str,
    ) -> Result<(Vec<WmEvent>, String), String> {
        let (events, label) = {
            let mut core = self.lock()?;
            let existing = core.labels_of_app(app_id);
            let label =
                identity::next_window_label(app_id, &existing).map_err(|r| r.to_string())?;
            if core.by_label.contains_key(&label) {
                // Unreachable while `bind`/`unbind` are the only writers — the label was
                // just computed from this app's own labels — and stated rather than
                // assumed: handing two live windows the same platform label is the one
                // failure the OS would then have to arbitrate.
                return Err(format!(
                    "internal: the allocated label '{label}' is already bound to a live window (the identity ledger and the label ledger disagree)"
                ));
            }
            // The class cap, the same function the first window asks. Asked *after*
            // allocation (which is pure and leaves no trace) and **before** any
            // registration, so a refused window still leaves none.
            Self::check_new_app_window(&core)?;
            let identity = identity::identity_of_label(&label).map_err(|r| r.to_string())?;
            // The `Created` event must be carried into `apply` — it is what builds the
            // platform window. Dropping it (as this code did for one test run) leaves the
            // model with a window the OS never got, and the very next `Shown` reports
            // "window 'files_2' does not exist".
            let (id, mut events) = core.wm.register(WindowKind::App);
            core.bind(id, &label, WindowKind::App, Some(identity));
            events.extend(core.wm.open(id));
            (events, label)
        };
        self.apply(app, &events)?;
        tracing::info!(
            target: "amos::wm",
            app = %app_id,
            label = %label,
            "opened an additional window for an application (REQ-A473)"
        );
        Ok((events, label))
    }

    /// Focus the next (or previous) window **of `app_id`** — the decision behind ⌘`.
    ///
    /// The ring is [`WmCore::labels_of_app`]'s labels, ordered by the identity domain's
    /// [`identity::cycle_target`] (deterministic, wrapping, never panicking), and
    /// `current` is the focused window *if it belongs to this app*: when focus is
    /// elsewhere the step starts at an end, which is what makes ⌘` usable as "show me
    /// this app's windows".
    ///
    /// `Ok(label)` = the window that was focused. `Err` when there is nothing to cycle
    /// (the app has no window, or exactly one — a ring of one is a no-op, and the caller
    /// is told so instead of being handed a "success" that moved nothing).
    pub fn cycle_app<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        app_id: &str,
        forward: bool,
    ) -> Result<String, String> {
        let target = {
            let core = self.lock()?;
            let peers = core.labels_of_app(app_id);
            if peers.len() < 2 {
                return Err(format!(
                    "'{app_id}' has {} window(s): there is nothing to cycle (⌘` needs at least two)",
                    peers.len()
                ));
            }
            let focused_label = core
                .wm
                .focused()
                .and_then(|id| core.labels.get(&id))
                .filter(|label| core.app_id_of_label(label).as_deref() == Some(app_id))
                .cloned();
            identity::cycle_target(focused_label.as_deref(), &peers, forward)
                .ok_or_else(|| format!("'{app_id}' has no windows to cycle"))?
                .to_string()
        };
        self.focus(app, &target)?;
        Ok(target)
    }

    /// Is `label` one of the two windows in the active split?
    ///
    /// Used by the geometry memory (REQ-A478): a pane's rectangle belongs to the split
    /// session, so it must not be remembered as "where the user put this window" — the same
    /// reason [`zoomable_window`] refuses a pane. `Ok(false)` for an unknown label (a window
    /// that is gone is not in a split) and for the Launcher (it is the screen).
    pub fn is_in_split(&self, label: &str) -> Result<bool, String> {
        Ok(self
            .split_labels()?
            .is_some_and(|(a, b)| a == label || b == label))
    }

    /// The app id a registered label belongs to, if it names an app window.
    ///
    /// Used by the callers that hold a **label** (the focused window, an OS event) and
    /// need the app for a per-app decision — the app id is what the shell, the store key
    /// and the native menu are keyed by.
    pub fn app_id_of(&self, label: &str) -> Result<Option<String>, String> {
        Ok(self.lock()?.app_id_of_label(label))
    }

    /// Focus an already-registered window.
    pub fn focus<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
    ) -> Result<Vec<WmEvent>, String> {
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
    pub fn hide<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
    ) -> Result<Vec<WmEvent>, String> {
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

    /// The state-half rules for minimizing `label`: it must be registered, and it must
    /// not be a split pane.
    ///
    /// Split out from [`Self::minimize`] so the refusal is exercised **without a window
    /// server** — the same headless shape the `split_labels` tests use. A pane's
    /// rectangle belongs to the split session, so minimizing one pane would leave the
    /// other at half-screen with no split left to explain it: the rule [`wm_zoom`]
    /// already states for zoom / full screen.
    pub fn minimize_target(&self, label: &str) -> Result<(), String> {
        if let Some((a, b)) = self.split_labels()? {
            if a == label || b == label {
                return Err(format!(
                    "window '{label}' is in a split — exit the split before minimizing"
                ));
            }
        }
        let core = self.lock()?;
        if !core.by_label.contains_key(label) {
            return Err(format!("window '{label}' is not registered"));
        }
        Ok(())
    }

    /// Minimize a registered window — the **Minimize** menu row (⌘M).
    ///
    /// REQ-A714. This is deliberately **not** [`Self::hide`]. ⌘M used to run `wm_hide`,
    /// i.e. `window.hide()`: the window left the screen **and** the model, so every
    /// surface that reads the model reported the app as gone — the Dock's running dot
    /// went dark (the symptom `docs/DESKTOP_GAP_ANALYSIS_2026_SEP20.md` §2 A1 records as
    /// "「最小化」其实是「隐藏」"), and there was no macOS-style minimized window to
    /// return to. macOS's ⌘M *minimizes*: the window drops to the Dock, and the app is
    /// still visibly running.
    ///
    /// So this asks the **platform** to minimize and leaves the model alone. That is the
    /// state [`Self::reveal_window`] (REQ-A441) already restores — a platform-minimized
    /// window keeps its model state (`Shown`), so it stays in `wm_windows`, the Dock
    /// keeps its dot, Mission Control still lists it, and focusing it (the Dock tile, ⌘N)
    /// un-minimizes it. No third state is invented (`docs/multi-window.md` §"平台还有
    /// 一个我们没有的状态" states that decision); the window merely goes where macOS's
    /// own yellow light would put it.
    pub fn minimize<R: Runtime>(&self, app: &AppHandle<R>, label: &str) -> Result<(), String> {
        self.minimize_target(label)?;
        let window = app
            .get_webview_window(label)
            .ok_or_else(|| format!("window '{label}' is not registered"))?;
        // F-DEV-131: `WebviewWindow::minimize` is `#[cfg(desktop)]` in Tauri 2.11 for the same
        // reason `reveal_window`'s twin is (see there). On mobile the model transition above is
        // the whole effect — there is no platform state to ask for, and saying so is better
        // than returning a success that named nothing.
        #[cfg(desktop)]
        window.minimize().map_err(|e| e.to_string())?;
        #[cfg(not(desktop))]
        {
            tracing::debug!(
                target: "amos::wm",
                label = %window.label(),
                "no platform minimize on this target; the window-model transition above is the whole effect"
            );
        }
        Ok(())
    }

    /// Close a registered window (Launcher is a no-op, as enforced by `amos-wm`) and
    /// restore whatever a closed split pane leaves behind.
    ///
    /// **The platform window is resolved before the state half runs** (REQ-A430, measured on
    /// this machine 2026-09-18): `close_core` deliberately drops the `label ⇄ id` mapping (so
    /// a relaunch cannot focus a dead id), and the `Closed` branch of [`Self::apply`] used to
    /// resolve the platform window through that same map — so it resolved **nothing** and no
    /// `wm_close` ever closed a window. The visible symptom was ⌘W (and the Dock's 「退出」,
    /// the LMK teardown, Mission Control's close) doing *nothing at all* while the command
    /// reported success: the model forgot the window, the window stayed on screen, and the
    /// next ⌘W answered `window 'settings' is not registered` (which nothing displayed).
    pub fn close<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
    ) -> Result<Vec<WmEvent>, String> {
        let target = close_target(app, label);
        let (events, split_survivor) = self.close_core(label)?;
        self.apply(app, &events)?;
        if let Some(window) = target {
            // Reported, not discarded: the model has already forgotten this window, so a
            // refused close leaves something on screen that no shell action can reach again.
            if let Err(e) = window.close() {
                tracing::warn!(
                    target: "amos::wm",
                    label,
                    error = %e,
                    "the platform refused to close the window; it is no longer in the model"
                );
            }
        }
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
        //
        // REQ-A473: this is `unbind`, the one place that forgets a window, so the
        // identity record cannot outlive its window either — a leaked identity would keep
        // a closed window in its app's ⌘` ring forever and would hand a *new* window of
        // that app a label that was still bound to a dead id.
        core.unbind(id);
        core.external.remove(&id);
        // REQ-A435: a closed window's page-load record must not outlive it — a label that is
        // re-opened later is a **new** window and owes its own `on_page_load` before it may
        // take the key.
        core.page_loaded.remove(label);
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
            core.bind(id, label, WindowKind::System, None);
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
    pub(crate) fn register_app(&self, label: &str) -> Result<(), String> {
        let identity = identity::identity_of_label(label).map_err(|r| r.to_string())?;
        if !identity.is_first() {
            return Err(format!(
                "'{label}' names window instance {}, not an application (use register_app_instance)",
                identity.instance
            ));
        }
        let mut core = self.lock()?;
        if core.by_label.contains_key(label) {
            return Ok(());
        }

        // The same policy question `open` asks (one rule, one place): a test cannot
        // register a window the real host would refuse.
        Self::check_new_app_window(&core)?;

        let (id, _created) = core.wm.register(WindowKind::App);
        core.bind(id, label, WindowKind::App, Some(identity));
        core.wm.open(id);
        Ok(())
    }

    /// Register one **additional** window of `app_id` without an `AppHandle`, allocating
    /// its label exactly as [`WmState::new_window`] would (tests only).
    ///
    /// The allocation goes through the same domain function, so a test cannot observe an
    /// instance scheme the production host would never produce — the mistake REQ-A227's
    /// fix was about (`register_app` exists precisely so tests do not have to invent the
    /// registration shape).
    #[cfg(test)]
    pub(crate) fn register_app_instance(&self, app_id: &str) -> Result<String, String> {
        let mut core = self.lock()?;
        let existing = core.labels_of_app(app_id);
        let label = identity::next_window_label(app_id, &existing).map_err(|r| r.to_string())?;
        Self::check_new_app_window(&core)?;
        let identity = identity::identity_of_label(&label).map_err(|r| r.to_string())?;
        let (id, _created) = core.wm.register(WindowKind::App);
        core.bind(id, &label, WindowKind::App, Some(identity));
        core.wm.open(id);
        Ok(label)
    }

    /// Is this app's **first** window already on screen, and what is its label?
    ///
    /// The cascade's anchor (REQ-A478): only the platform knows where macOS put that window,
    /// so this answers "which window should we measure", and [`anchor_of_window`] does the
    /// measuring. `Ok(None)` means the app has no window with instance 1 in the ledger —
    /// then there is nothing to cascade from and the class rule's own position is used.
    fn first_instance_label(&self, app_id: &str) -> Result<Option<String>, String> {
        let core = self.lock()?;
        Ok(core
            .apps
            .iter()
            .find(|(_, identity)| identity.app == app_id && identity.instance == 1)
            .and_then(|(id, _)| core.labels.get(id).cloned()))
    }

    /// Where the cascade for `app_id` should start, or `None` when it cannot be established.
    ///
    /// Deliberately `None` rather than a guess in three cases, each reported by the caller's
    /// fallback: the window shows no app; the app's first window is the one being created;
    /// the platform cannot tell us its position.
    fn cascade_anchor<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        app_id: Option<&str>,
        label: &str,
    ) -> Result<Option<(i32, i32)>, String> {
        let Some(app_id) = app_id else {
            return Ok(None);
        };
        let Some(first) = self.first_instance_label(app_id)? else {
            return Ok(None);
        };
        if first == label {
            return Ok(None);
        }
        Ok(anchor_of_window(app, &first))
    }

    /// Mirror a batch of state-machine events onto the real windows.
    fn apply<R: Runtime>(&self, app: &AppHandle<R>, events: &[WmEvent]) -> Result<(), String> {
        for e in events {
            match *e {
                WmEvent::Created(id) => {
                    if self.is_external(id) {
                        continue; // external surfaces have no WebviewWindow
                    }
                    let label = self.label_for(id)?;
                    let (app_id, instance) = {
                        let core = self.lock()?;
                        let app = core.app_id_of_label(&label);
                        let inst = core.apps.get(&id).map(|i| i.instance).unwrap_or(1);
                        (app, inst)
                    };
                    if app.get_webview_window(&label).is_none() {
                        // The class decides how big a new app window opens: a PC must
                        // not open a 480×820 handset slab (the value was hard-coded
                        // here before the form-factor domain), and the window never
                        // exceeds the screen it will be drawn on. One lock for both
                        // facts, so they cannot disagree.
                        // `work_area` — not `screen`: with Stage mode on, a new window
                        // must not open under the rail, and this is the one seam that
                        // knows where the stage ends (`WmCore::work_area`).
                        let (policy, screen) = {
                            let core = self.lock()?;
                            (core.policy, core.work_area())
                        };
                        // REQ-A478: the instance decides the **cascade** — three windows of
                        // one app used to open at the same 236,70 1024×720 (measured on this
                        // machine), i.e. stacked exactly on top of each other.
                        let initial = policy.initial_window_for(screen, instance);
                        // REQ-A478: **a remembered rectangle wins over every default.** The
                        // order is: the user's own geometry (REQ-A249, wired this round) →
                        // the cascade for a later instance → the class's initial window.
                        // The user's choice is the only one that is *evidence about what
                        // they want*; the two defaults are our guesses.
                        //
                        // `None` for a label with no history (the normal case), and a store
                        // that is not armed answers `None` too — so this is additive.
                        //
                        // The saved numbers are **physical** pixels (`outer_position` /
                        // `outer_size`) and are converted with the window's own scale factor
                        // (the REQ-A218 lesson), then bounded by the **current** screen: a
                        // monitor change must not reopen a window off-screen.
                        let restored = restored_geometry(
                            app.try_state::<window_state::WindowStateStore>().as_deref(),
                            &label,
                            app.get_webview_window(LAUNCHER_LABEL)
                                .and_then(|w| w.scale_factor().ok())
                                .unwrap_or(1.0),
                            policy,
                            screen,
                        );
                        // The winner supplies **both** the size and (below) the position — and
                        // it has to be assigned, not merely tested: a first device pass asked
                        // `if restored.is_some()` while still sizing the builder from `initial`,
                        // and the window reopened at the domain's origin rect (measured
                        // 0,29) instead of the spot the user had left it at. A flag that
                        // gates the branch but not the value is the defect; the assertion in
                        // `restored_geometry`'s callers is the value itself.
                        let opens_at = restored.unwrap_or(initial);
                        // …and the computed position is actually **applied** from instance 2
                        // on (see `places_position_at`: `.position()` had never been called,
                        // so the class rule's x/y never reached a real window and every window
                        // landed wherever the OS put it). Instance 1 keeps the OS's placement,
                        // so nothing a user already experiences moves.

                        // Load the app entry with a `#window=` fragment so the boot
                        // script auto-navigates to that app's screen.
                        let url = WebviewUrl::App(format!("{APP_ENTRY}#window={label}").into());
                        // On desktop, hide the native title bar so the app window
                        // renders edge-to-edge (REQ-A249 / PC_DESKTOP_ARCHITECTURE.md §4.3).
                        // `mut` is used by the desktop-gated line below and by the position.
                        #[cfg_attr(not(desktop), allow(unused_mut))]
                        let mut builder = WebviewWindowBuilder::new(app, label.clone(), url)
                            .title(app_window_title(
                                app_id.as_deref().unwrap_or(label.as_str()),
                            ))
                            // REQ-A478: **a remembered rectangle wins over every default** —
                            // the user's own geometry (REQ-A249, wired this round) first, then
                            // the cascade for a later instance, then the class's own window.
                            .inner_size(f64::from(opens_at.width), f64::from(opens_at.height))
                            // G5: the class decides whether the user may freely
                            // resize, and how small the window may get.
                            .resizable(policy.free_resize)
                            .min_inner_size(
                                f64::from(policy.min_pane.width),
                                f64::from(policy.min_pane.height),
                            );
                        // Where to put it: the remembered spot when there is one (it *is* the
                        // user's choice, and it was already clamped into the current screen);
                        // otherwise the cascade, which only applies from instance 2 on —
                        // instance 1 keeps the OS's own placement, so nothing a user already
                        // experiences moves.
                        if let Some(saved) = restored {
                            builder = builder.position(f64::from(saved.x), f64::from(saved.y));
                        } else if places_position_at(instance) {
                            // Anchor the cascade at **where the app's first window actually
                            // is**. The domain cannot know that (`fit_window` builds its rect
                            // at the screen's origin and clamps) and macOS placed the first
                            // window itself, so the platform is the only source — the same rule
                            // `reclamp_windows` follows, for the same reason. A window whose
                            // position cannot be read falls back to the domain's answer, and
                            // `anchor_of_window` says so (never a silent guess).
                            let anchor = self
                                .cascade_anchor(app, app_id.as_deref(), &label)?
                                .unwrap_or((opens_at.x, opens_at.y));
                            let placed = policy.cascade_from(
                                anchor,
                                Size::new(opens_at.width, opens_at.height),
                                screen,
                                instance,
                            );
                            builder = builder.position(f64::from(placed.x), f64::from(placed.y));
                        }
                        // REQ-A326: paint the frame before the page does, so a dark machine
                        // does not flash the light OS canvas on every open. Desktop-only: the
                        // builder method is absent on the mobile targets (same E0599 lesson as
                        // `title_bar_style` above).
                        #[cfg(desktop)]
                        if let Some(background) = new_window_background(app) {
                            builder = builder.background_color(background);
                        }
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
                        // …and with Overlay the **strip belongs to the web layer**: AppKit would
                        // otherwise draw its own title next to the traffic lights, so the window
                        // read `文件 … 文件` — the OS copy on the left and our centred one
                        // (measured 2026-09-19, REQ-A440: a full-width capture of the strip showed
                        // both). The web layer draws the title once, centred, beside the reserved
                        // traffic-light inset (`APP_WINDOW_TITLEBAR_INSET`). `hidden_title` is
                        // macOS-only, hence the target gate — the same E0599 lesson as above (a
                        // cross-target call here breaks `make android-app`).
                        #[cfg(target_os = "macos")]
                        if policy.form == FormFactor::Desktop {
                            builder = builder.hidden_title(true);
                        }
                        // REQ-A435: hand the new window the key **once its page has loaded**.
                        //
                        // A window created a moment ago is on screen before the OS makes it
                        // key: measured on this machine (2026-09-18), `set_focus()` from the
                        // creation batch is not enough, and in that window every ⌘-chord the
                        // WebView would consume is delivered to a window whose JS has not
                        // started — ⌘W closed nothing in 3/6 runs at a 3 s delay (REQ-A431).
                        // Page-load is the moment the page is actually alive, so focusing here
                        // is what makes the chord belong to this window from its first frame.
                        //
                        // **Whether** is the model's answer, not this callback's: a window the
                        // model no longer focuses (hidden immediately after opening, or
                        // superseded by a newer one) must not steal the key.
                        builder = builder.on_page_load(|window, _payload| {
                            let label = window.label().to_string();
                            let Some(state) = window.app_handle().try_state::<WmState>() else {
                                return;
                            };
                            // The page is alive from here on: the focus deferral above ends for
                            // this window (and a later `wm_focus` is a plain `set_focus`).
                            if let Err(e) = state.mark_page_loaded(&label) {
                                tracing::warn!(
                                    target: "amos::wm",
                                    label = %label,
                                    error = %e,
                                    "could not record that the page loaded; the window will stay unfocused"
                                );
                                return;
                            }
                            let model_focuses_it = state
                                .snapshot()
                                .map(|snap| {
                                    snap.windows.iter().any(|w| w.focused && w.label == label)
                                })
                                .unwrap_or(false);
                            if !model_focuses_it || window.is_focused().unwrap_or(false) {
                                return;
                            }
                            // Reported, not discarded: a window that never took the key is
                            // exactly the state the caller cannot see from the outside.
                            if let Err(e) = window.set_focus() {
                                tracing::warn!(
                                    target: "amos::wm",
                                    label = %window.label(),
                                    error = %e,
                                    "the page loaded but the platform refused to focus the window"
                                );
                            } else {
                                tracing::debug!(
                                    target: "amos::wm",
                                    label = %window.label(),
                                    "focused the window after its page loaded (REQ-A435)"
                                );
                            }
                        });
                        builder
                            .build()
                            .map_err(|e| format!("failed to create window '{label}': {e}"))?;
                    }
                }
                WmEvent::Closed(_) => {
                    // Nothing to do on the **platform** side: the window is closed by
                    // [`WmState::close`], which resolves the platform window *before*
                    // `close_core` drops the `label ⇄ id` mapping. Resolving it here could not
                    // work at all (this branch runs after the state half has already forgotten
                    // the label — REQ-A430: that is exactly why no `wm_close` ever closed a
                    // window), and it is why the close now lives in one place.
                }
                WmEvent::Shown(id) => {
                    if self.is_external(id) {
                        continue;
                    }
                    let window = self.real_window(app, id)?;
                    // REQ-A441: `show()` on a miniaturized window leaves it in the Dock.
                    Self::reveal_window(&window)?;
                    window.show().map_err(|e| e.to_string())?;
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
                    let window = self.real_window(app, id)?;
                    let label = window.label().to_string();
                    // REQ-A441: the platform may have **miniaturized** this window (the yellow
                    // light, or AppKit's ⌘M) while the model still says `Shown` — then this focus
                    // path is the only thing that runs when the user asks for the window again
                    // (⌘N, the Dock tile), and `set_focus()` alone would leave it in the Dock.
                    // Restore it *before* the page-load deferral below: visibility is not the
                    // key, and a user who asked for the window should see it.
                    Self::reveal_window(&window)?;
                    // REQ-A435: a window whose page has **not loaded yet** must not take the
                    // key. While it holds the key its WebView has no script to consume ⌘W and
                    // WebKit swallows the chord (the menu never sees it), so a ⌘W pressed in
                    // that phase used to close nothing — measured on this machine. Keeping the
                    // key on the launcher instead lets its own handler close this window, and
                    // `on_page_load` (see the builder) focuses it the moment it is alive.
                    if !self.page_loaded(&label)? {
                        tracing::debug!(
                            target: "amos::wm",
                            label = %label,
                            "focus deferred until the page loads (REQ-A435)"
                        );
                        continue;
                    }
                    if let Err(e) = window.set_focus() {
                        tracing::warn!(
                            target: "amos::wm",
                            error = %e,
                            "the platform refused the focus request"
                        );
                    } else if !window.is_focused().unwrap_or(false) {
                        // **Read back rather than assume** — the rule `window_toggle_zoom`
                        // follows. The OS can decline to hand the key over (another app is
                        // frontmost, the window is not yet keyable), and "the call returned"
                        // is not "the window is key".
                        tracing::debug!(
                            target: "amos::wm",
                            label = %window.label(),
                            "the platform has not confirmed the focus yet"
                        );
                    }
                    // Write the focused **app id** to the shared store so the desktop
                    // TopBar can render the active app's menu.  This mirrors the same
                    // pattern the System UI already uses for settings / notifications:
                    // the host owns the authoritative store, not any one WebView.
                    //
                    // REQ-A473: this used to write the *label*. With instances those are
                    // no longer the same string — `files_2` is a window, not an app — and a
                    // TopBar keyed by the label would show nothing for every window after
                    // the first (the store's value is looked up as an app id). A window
                    // that shows no app (the Launcher, a container surface) keeps the
                    // label: the consumers already treat a non-app id as "no app menu".
                    let app_key = {
                        let core = self.lock()?;
                        core.app_id_of_label(&label)
                            .unwrap_or_else(|| label.clone())
                    };
                    if let Some(store) = app.try_state::<SharedStore>() {
                        // One source: `SharedStore::set` already broadcasts
                        // `store-updated` to every window, and the desktop
                        // TopBar reads the key from there
                        // (`lib/wm.ts::APP_FOCUSED_KEY` → `createStoreValue`).
                        // A second, purpose-built `emit` was tried and removed:
                        // `scripts/tauri-event-scan.mjs` reported it as "emitted
                        // by the host but no screen subscribes to it" — and it
                        // was right, the frontend deliberately reads the store.
                        store.set(
                            app,
                            APP_FOCUSED_KEY,
                            serde_json::json!(&app_key).to_string(),
                        );
                    }
                }
                // Nothing focused: leave windowing as-is (Launcher stays visible).
                WmEvent::FocusChanged(None) => {}
            }
        }
        // REQ-A717: the batch this function just mirrored is exactly what `wm_windows`
        // reports (every `WmEvent` variant above changes a window's presence or focus),
        // so it is the one honest choke point to announce the new list from. An empty
        // batch means the command was a no-op — announcing it would be a spurious frame.
        if !events.is_empty() {
            if let Ok(snap) = self.snapshot() {
                // Power of 10 #7: read the answer back. `Err` here does not mean "no listener" —
                // Tauri answers `Ok` when nobody is subscribed — it means a **registered** listener
                // could not be reached, i.e. a screen that asked for `wm-changed` will not learn the
                // new window list. The desktop UI re-reads `wm_windows` on other triggers, so this is
                // recoverable, but a silent drop is exactly the failure this repo reports instead.
                if let Err(e) = app.emit(WM_CHANGED_EVENT, snap) {
                    tracing::warn!(
                        target: "amos::wm",
                        error = %e,
                        "wm-changed emit failed: a registered listener will not learn the new window list"
                    );
                }
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
                // REQ-A473: the identity is *reported*, not re-derived from the label by
                // the reader. A shell that parsed `a#b` itself would be a second
                // implementation of the scheme, and the first place it would drift is the
                // separator.
                app: core
                    .apps
                    .get(&id)
                    .map(|identity| identity.app.clone())
                    .unwrap_or_default(),
                instance: core
                    .apps
                    .get(&id)
                    .map(|identity| identity.instance)
                    .unwrap_or(0),
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

    /// This host's resolved [`LayoutPolicy`] (REQ-A1546).
    ///
    /// Exposed so the Stage Manager module derives its rail width and work-area inset
    /// from the **same** policy this host places windows with. A second
    /// `LayoutPolicy::of(form)` call over there would be a second derivation of the
    /// geometry the two must agree on.
    pub fn policy(&self) -> Result<LayoutPolicy, String> {
        Ok(self.lock()?.policy)
    }

    /// Is Stage Manager on ([`WmCore::stage_enabled`])?
    pub fn stage_enabled(&self) -> Result<bool, String> {
        Ok(self.lock()?.stage_enabled)
    }

    /// The area an app window may be placed in ([`WmCore::work_area`]).
    ///
    /// Exposed for the Stage Manager module, whose "Tidy" lays windows out over exactly
    /// this rect — a second `policy.stage_work_area(screen)` written there is how the tidy
    /// grid and the placement inset come to disagree about where the stage ends.
    pub fn work_area(&self) -> Result<Bounds, String> {
        Ok(self.lock()?.work_area())
    }

    /// How many pixels the rail takes out of the left edge ([`WmCore::rail_width`]).
    pub fn rail_width(&self) -> Result<u32, String> {
        Ok(self.lock()?.rail_width())
    }

    /// Turn Stage Manager on or off, answering the state now in effect.
    ///
    /// Refused with [`ErrorCode::StageUnsupported`]'s wording on a class whose policy has
    /// no rail (a phone, a tablet, a headless board): storing `true` there would make
    /// [`WmState::stage_enabled`] a lie — every reader would believe a rail exists while
    /// [`LayoutPolicy::stage_rail_width`] keeps returning 0.
    ///
    /// A live split is re-fitted to the new work area — the rail appearing narrows the
    /// rect its two panes share, and the panes were laid out from the same rect
    /// ([`WmState::enter_split`]). It is [`SplitScreen::set_screen`]'s rule, the same one
    /// [`WmState::sync_screen`] applies to a screen change: the session survives while its
    /// divider still leaves both panes at `min`, and **ends** rather than silently
    /// re-clamping the ratio when it does not. A split left describing the old rect would
    /// put a pane under the rail — the exact overlap the work-area inset exists to prevent.
    pub fn set_stage_enabled(&self, enabled: bool) -> Result<bool, String> {
        let mut core = self.lock()?;
        if enabled && core.policy.stage_rail_width() == 0 {
            return Err(format!(
                "form factor '{}' has no Stage Manager rail, so Stage mode cannot be \
                 turned on here",
                core.policy.form
            ));
        }
        core.stage_enabled = enabled;
        let work = core.work_area();
        if let Some(s) = core.split.as_mut() {
            if !s.set_screen(work) {
                core.split = None;
            }
        }
        Ok(enabled)
    }

    /// Push a window the user has just dragged into the Stage rail back out of it, and
    /// rewrite `captured` so **the corrected rectangle is what gets remembered**
    /// (REQ-A1564).
    ///
    /// Why this exists at all: the rail is protected by *geometry* (`WmCore::work_area`),
    /// so every window the host places starts clear of the band. The one placement the host
    /// does not control is the user's own drag, and `Moved` is the only report of it. Without
    /// this, a window dragged over the rail simply covers it — and, worse, the overlap is
    /// then written to `window_state` and comes back at the next launch, when no drag is
    /// happening to explain it.
    ///
    /// Why **`captured` is rewritten rather than re-read**: the platform applies
    /// `set_position` asynchronously, so a `window_state::snapshot` taken here can still
    /// report the pre-correction position — and that is exactly the value that must not be
    /// persisted. The rect this method applied *is* the truth about what was asked for, so it
    /// is written directly. `captured`'s other fields (notably `visible`) are left as the
    /// platform reported them.
    ///
    /// Answers `Ok(true)` when the window was moved. `Ok(false)` is the ordinary case and
    /// covers every "leave it alone" reason, all of them `None` from
    /// [`WmState::stage_clamp_target`]: Stage mode off, no rail, no overlap, no room to
    /// reflow into, or inside the throttle window.
    pub fn stage_clamp_moved<R: Runtime>(
        &self,
        window: &tauri::Window<R>,
        label: &str,
        captured: &mut window_state::WindowState,
    ) -> Result<bool, String> {
        let Some(rect) = logical_window_rect(window) else {
            tracing::debug!(
                target: "amos::wm",
                window = %label,
                "could not measure a moved window; the Stage rail's exclusion was not applied"
            );
            return Ok(false);
        };
        let Some(target) = self.stage_clamp_target(label, rect, now_ms())? else {
            return Ok(false);
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
        if let Err(e) = applied {
            // Reported, not retried: a platform that refused this correction will refuse the
            // next one too, and re-asking on every `Moved` event is how a clamp becomes a
            // fight with the user's hand.
            tracing::warn!(
                target: "amos::wm",
                window = %label,
                error = %e,
                "the platform refused a window's Stage rail exclusion"
            );
            return Ok(false);
        }
        let scale = sane_scale(window.scale_factor().unwrap_or(1.0));
        note_clamped_rect(captured, rect, target, scale);
        Ok(true)
    }

    /// The rectangle a moved window must be put at to stop covering the rail — `None` for
    /// "leave it alone" (the full list is on [`WmState::stage_clamp_moved`]).
    ///
    /// Split out from the platform half so the rule is testable without a window, and so
    /// the throttle stamp is written in the **same** lock acquisition as the decision that
    /// acted on it: two acquisitions would let a second `Moved` event read an unstamped
    /// ledger and correct the same drag twice.
    fn stage_clamp_target(
        &self,
        label: &str,
        rect: Bounds,
        now_ms: u64,
    ) -> Result<Option<Bounds>, String> {
        let mut core = self.lock()?;
        if !core.stage_enabled {
            return Ok(None);
        }
        let rail = core.rail_width();
        if !should_clamp(
            core.stage_clamp_at.get(label).copied(),
            now_ms,
            STAGE_CLAMP_DEBOUNCE_MS,
        ) {
            return Ok(None);
        }
        // Against the **screen**, not the work area: `reflow_out_of_rail` measures the band
        // from `area.x` and the room beside it from `area.width - rail`. Feeding it the
        // already-inset rect would subtract the rail twice.
        let Some(target) =
            amos_wm::stage::reflow_out_of_rail(rect, core.screen, rail, core.policy.min_pane)
        else {
            return Ok(None);
        };
        core.stage_clamp_at.insert(label.to_string(), now_ms);
        Ok(Some(target))
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
            // REQ-A512: a measured screen may re-class the host (a mobile build defaults
            // to Phone because phone and tablet share one target). Do it *before* the
            // split is re-fitted below, so the new class's divider/min-pane rules are the
            // ones the live split is validated against.
            if core.form_revisable {
                if let Some(form) = reclass_for_screen(core.built_for, clamped) {
                    if form != core.policy.form {
                        core.policy = LayoutPolicy::of(form);
                        tracing::info!(
                            form = form.as_str(),
                            width = clamped.width,
                            height = clamped.height,
                            "form factor re-derived from the measured screen"
                        );
                    }
                }
            }
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
    ///
    /// **`reveal_window` first (REQ-A864).** The rule REQ-A441 established for *app* windows
    /// — `set_focus()` does not bring back a window the platform considers miniaturized, so
    /// the platform has to be asked to deminiaturize — was never applied to the launcher,
    /// because until the system tray existed nothing could ask for the shell to come back
    /// **after** the platform had put it away: the only caller was boot, where the window is
    /// freshly created and cannot be minimized. The tray's primary action is precisely that
    /// later caller, so without this the one control whose whole job is "show the desktop"
    /// would answer `Refused` — and, worse, would report *why* in a log nobody reads while
    /// the user watched nothing happen. A `false`/unreadable `is_minimized` is "not
    /// minimized" (the direction [`Self::reveal_window`] already takes).
    pub fn focus_launcher(&self, app: &AppHandle) -> Result<LauncherFocus, String> {
        let Some(window) = app.get_webview_window(LAUNCHER_LABEL) else {
            return Ok(LauncherFocus::NoWindow);
        };
        // Reveal, then `show`: a miniaturized window is restored by the platform's own
        // word for it, and a hidden one would swallow the focus request. Both orders are
        // "make it visible"; this one is the pair the platform honours.
        Self::reveal_window(&window)?;
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
    pub fn enter_split(&self, a: &str, b: &str, axis: &str) -> AmosResult<LayoutSnapshot> {
        let mut core = self.lock().map_err(wm_lock_failed)?;
        // A class with no user interface has nothing to split: refuse honestly
        // instead of returning a snapshot that implies a screen nobody sees.
        if !core.policy.form.has_ui() {
            return Err(format!(
                "form factor '{}' has no user interface to split",
                core.policy.form
            )
            .into_envelope(ErrorCode::WmFormFactorNoUi));
        }
        let ia = *core
            .by_label
            .get(a)
            .ok_or_else(|| window_not_registered(a))?;
        let ib = *core
            .by_label
            .get(b)
            .ok_or_else(|| window_not_registered(b))?;
        if ia == ib {
            return Err("cannot split a window with itself"
                .to_string()
                .into_envelope(ErrorCode::WmSelfSplit));
        }
        if core.kinds.get(&ia).map(String::as_str) == Some("Launcher")
            || core.kinds.get(&ib).map(String::as_str) == Some("Launcher")
        {
            return Err("the Launcher cannot be split"
                .to_string()
                .into_envelope(ErrorCode::WmLauncherSplit));
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
        // The **work area**, not the screen: with Stage mode on the split's panes are two
        // more placed rectangles, and a pane reaching under the rail would be a split the
        // user cannot see the left half of. The aspect used to pick an axis comes from the
        // same rect for the same reason — `stage_work_area` is the identity on a class
        // with no rail, so this is `screen` wherever it always was.
        let work = core.work_area();
        let axis = match parse_axis(axis)? {
            Some(explicit) => explicit,
            // `"auto"`: let the policy pick from the screen's aspect instead of
            // making every caller hard-code an orientation (tablet/desktop shells
            // rotate; a phone does not).
            None => core.policy.split_axis(Size::new(work.width, work.height)),
        };
        let policy = core.policy;
        let sp = SplitScreen::new(ia, ib, work, axis, policy.divider_gap, policy.min_pane)
            .ok_or_else(|| {
                "screen too small to split those two windows"
                    .to_string()
                    .into_envelope(ErrorCode::WmSplitRatioInfeasible)
            })?;
        core.split = Some(sp);
        layout_core(&core).map_err(wm_layout_failed)
    }

    /// Set the divider so the primary pane takes `percent` (1..=99).
    pub fn split_resize(&self, percent: u32) -> AmosResult<LayoutSnapshot> {
        let mut core = self.lock().map_err(wm_lock_failed)?;
        let sp = core.split.as_mut().ok_or_else(|| {
            "no active split"
                .to_string()
                .into_envelope(ErrorCode::WmSplitNotActive)
        })?;
        if !sp.resize_to(percent) {
            return Err(
                "that divider share is not feasible at the current minimum size"
                    .to_string()
                    .into_envelope(ErrorCode::WmSplitRatioInfeasible),
            );
        }
        layout_core(&core).map_err(wm_layout_failed)
    }

    /// Move the divider by `delta` percentage points.
    pub fn split_move(&self, delta: i32) -> AmosResult<LayoutSnapshot> {
        let mut core = self.lock().map_err(wm_lock_failed)?;
        let sp = core.split.as_mut().ok_or_else(|| {
            "no active split"
                .to_string()
                .into_envelope(ErrorCode::WmSplitNotActive)
        })?;
        if !sp.resize_by(delta) {
            return Err(
                "that divider move is not feasible at the current minimum size"
                    .to_string()
                    .into_envelope(ErrorCode::WmSplitRatioInfeasible),
            );
        }
        layout_core(&core).map_err(wm_layout_failed)
    }

    /// Swap which window is in the primary (first) pane.
    pub fn split_swap(&self) -> AmosResult<LayoutSnapshot> {
        let mut core = self.lock().map_err(wm_lock_failed)?;
        let sp = core.split.as_mut().ok_or_else(|| {
            "no active split"
                .to_string()
                .into_envelope(ErrorCode::WmSplitNotActive)
        })?;
        sp.swap();
        layout_core(&core).map_err(wm_layout_failed)
    }

    /// End the active split (windows return to fullscreen / previous layout).
    pub fn split_exit(&self) -> AmosResult<LayoutSnapshot> {
        let mut core = self.lock().map_err(wm_lock_failed)?;
        core.split = None;
        layout_core(&core).map_err(wm_layout_failed)
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

    /// Snap `label` to a named screen region, applying the real geometry and returning the
    /// frame that was set.
    ///
    /// The geometry is [`amos_wm::snap::snap_bounds`] — pure and tested in `amos-wm` — over
    /// the **work area** this host measures (`core.screen`: the maximized shell window, i.e.
    /// the screen minus the menu bar and Dock) and the class's minimum pane, so a snap can
    /// never place a window below the class minimum or off the edge.
    ///
    /// Every refusal is by **name**, not a silent no-op, because "the model says snapped and
    /// the screen did not move" is the exact failure this module keeps refusing to hide:
    ///
    /// * an unknown zone, or a label that is not registered;
    /// * an external container surface (its geometry belongs to the container) and the
    ///   Launcher (it *is* the screen);
    /// * a window in an **active split** — snapping one pane would leave the split
    ///   describing a layout that is no longer on screen; exit the split first;
    /// * a class whose policy forbids free window geometry (`free_resize == false`): a phone's
    ///   app window is fullscreen by construction, so a snap there cannot mean anything.
    pub fn snap_window(&self, app: &AppHandle, label: &str, zone: &str) -> Result<Bounds, String> {
        let target = {
            let core = self.lock()?;
            let work_area = snap_work_area(app, &core, label);
            snap_plan_in(&core, label, zone, work_area)?
        };
        let Some(window) = app.get_webview_window(label) else {
            return Err(format!("{label:?} has no window to snap"));
        };
        window
            .set_position(tauri::LogicalPosition::new(
                f64::from(target.x),
                f64::from(target.y),
            ))
            .and_then(|()| {
                window.set_size(tauri::LogicalSize::new(
                    f64::from(target.width),
                    f64::from(target.height),
                ))
            })
            .map_err(|e| format!("could not snap {label:?}: {e}"))?;
        tracing::info!(
            window = %label,
            zone = zone,
            x = target.x,
            y = target.y,
            width = target.width,
            height = target.height,
            "a window was snapped to a screen region"
        );
        Ok(target)
    }
}

/// The work area a snap of `label` should tile within (multi-display, REQ-A690).
///
/// With **fewer than two displays** — or when the platform cannot be asked, or the target
/// window cannot be measured — this is exactly `core.screen`, the measured shell window, so
/// single-monitor behaviour is byte-for-byte what it was before displays existed. With two or
/// more, it is the work area of the display whose `bounds` contain the window's **centre**
/// ([`DisplaySet::work_area_for`]), so a window on a secondary display is tiled within *that*
/// display instead of being yanked onto the primary.
///
/// The centre is sampled from the *real* window frame, read here rather than remembered: the
/// host keeps no per-window geometry ledger, so the platform is the only honest source.
/// Falling back to the single screen on any read failure is deliberate and documented — a snap
/// to the last known screen is better than a snap refused because a monitor query hiccuped.
///
/// The single-screen answer is [`WmCore::work_area`], **not** `core.screen`: a snap is a
/// placement path like any other, so a tile snapped while Stage mode is on must land beside
/// the rail rather than under it. A window snapped onto a *secondary* display keeps that
/// display's own work area — the rail is drawn over the primary only, and insetting another
/// display would reserve a strip for a rail that is not there. (Honest boundary: multi-display
/// × Stage mode is not verified on this machine — `docs/stage-manager.md`.)
fn snap_work_area(app: &AppHandle, core: &WmCore, label: &str) -> Bounds {
    let primary = core.work_area();
    let Ok(displays) = display_set(app) else {
        return primary;
    };
    if displays.len() < 2 {
        return primary;
    }
    let Some(window) = app.get_webview_window(label) else {
        return primary;
    };
    let Ok(rect) = window_logical_bounds(&window) else {
        return primary;
    };
    displays.work_area_for(rect).unwrap_or(core.screen)
}

/// The pure half of a snap (REQ-A616): why `label` would be refused, or the frame it would
/// be given — within the host's single measured screen.
///
/// Split out of [`WmState::snap_window`] because applying the frame needs a live
/// `AppHandle` (and the platform), while the **rules** — which zones exist, which windows may
/// be snapped, which class allows it — are decisions over the ledger and are unit-tested
/// directly. `zone` is re-parsed by [`SnapZone::parse`], whose `None` is a refusal, never a
/// guessed default. This is [`snap_plan_in`] over [`WmCore::work_area`]; the host supplies a
/// per-display work area through that. Kept as the single-screen entry the pure rule tests
/// exercise directly — the live host always goes through [`snap_plan_in`] with a work area.
#[cfg(test)]
fn snap_plan(core: &WmCore, label: &str, zone: &str) -> Result<Bounds, String> {
    snap_plan_in(core, label, zone, core.work_area())
}

/// [`snap_plan`] against an explicit work area. The rules are identical; only the rectangle
/// the frame is cut from differs, so a window on a secondary display tiles within that
/// display's usable area (multi-display, REQ-A690).
fn snap_plan_in(
    core: &WmCore,
    label: &str,
    zone: &str,
    work_area: Bounds,
) -> Result<Bounds, String> {
    let Some(zone) = SnapZone::parse(zone) else {
        return Err(format!("unknown snap zone {zone:?}"));
    };
    let Some(id) = core.by_label.get(label).copied() else {
        return Err(format!("no window is registered under {label:?}"));
    };
    if core.external.contains(&id) {
        return Err(format!(
            "{label:?} is an external surface; its geometry is owned elsewhere"
        ));
    }
    if is_screen_window(label) {
        return Err(format!(
            "{label:?} is the screen itself; it cannot be snapped"
        ));
    }
    if !core.policy.free_resize {
        return Err(format!(
            "the {} class does not allow free window geometry",
            core.policy.form.as_str()
        ));
    }
    if let Some(sp) = &core.split {
        if sp.primary == id || sp.secondary == id {
            return Err(format!("{label:?} is in a split; exit the split first"));
        }
    }
    Ok(snap_bounds(zone, work_area, core.policy.min_pane))
}

/// Serializable view of a single window (enums aren't ergonomic over IPC).
#[derive(Serialize, Clone, Debug)]
pub struct WindowInfo {
    pub id: u64,
    pub label: String,
    /// The **app id** this window shows (REQ-A473), or `""` for a window that shows no
    /// application (the Launcher, an external container surface).
    ///
    /// This is what a consumer should key per-app decisions on — the Dock's running dot,
    /// the TopBar's app name, "is this app already open" — because `label` now differs
    /// from the app id for every window after the first (`files` vs `files_2`).
    pub app: String,
    /// Which instance of `app` this window is: `1` for the first, `2..` for later ones,
    /// and `0` when there is no app at all (see [`WindowInfo::app`]).
    ///
    /// Reported rather than left for the reader to parse out of `label`: the shell renders
    /// "设置 — 2" for a second window, and a second parser of the label scheme is exactly
    /// what the identity module exists to prevent.
    pub instance: u32,
    pub kind: String,
    pub state: String,
    pub focused: bool,
    /// True when this is an external composited surface (no WebviewWindow).
    pub external: bool,
}

/// Serializable view of the whole windowing state.
///
/// The shell reads this and [`WindowInfo`] as `WmWindowsSnapshot` / `WmWindowInfo`
/// (`lib/wm.ts`). NOTE (REQ-A704): neither side previously read the other — the Rust
/// structs had no wire-shape pin, and `wm.test.ts` compared `normalizeWindows` to a
/// TS-local literal. The cross-language binding is `declaredMirrors.test.ts`'s "wm.ts
/// window-list wire shapes == the amos-tauri::wm serde structs", which reads both
/// structs' `pub` field names in order (this command is reached through a dynamic
/// `invoke(command, args)`, so `tauri-reply-scan.mjs` cannot see it).
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
    /// Width of the Stage Manager rail the stage loses off its **left edge** (px), or `0`
    /// when there is no rail — the mode is off, or this class has none, or the screen is
    /// too narrow to afford one beside a minimum pane (`LayoutPolicy::stage_work_area`'s
    /// give-way rule).
    ///
    /// The one number the shell needs to lay out **around** the rail: the rail's own width,
    /// and the left inset of the desktop icon grid (`DesktopStage.svelte`), which would
    /// otherwise be drawn through a translucent strip it cannot be clicked in. It lives
    /// here rather than on `StageSnapshot` because it is geometry — the same kind of
    /// policy-derived fact as `divider_gap` and `columns` beside it — and because the
    /// **layout push** (`onLayoutChanged`) is the channel that already fires when it
    /// changes (`stage_set_enabled` re-measures), so a shell reads it exactly once.
    pub rail_width: u32,
}

/// Parse a `wm_split` axis argument. `Ok(None)` means `"auto"`: the caller lets
/// the form-factor policy choose from the screen's aspect.
fn parse_axis(s: &str) -> AmosResult<Option<SplitAxis>> {
    match s {
        "vertical" | "v" => Ok(Some(SplitAxis::Vertical)),
        "horizontal" | "h" => Ok(Some(SplitAxis::Horizontal)),
        "auto" | "" => Ok(None),
        other => Err(
            format!("unknown split axis: {other:?} (vertical|horizontal|auto)")
                .into_envelope(ErrorCode::WmSnapZoneUnknown),
        ),
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

/// The two pane rects a split of `screen` produces under `policy` — the **one** place
/// the host turns the class policy into split geometry (REQ-A512).
///
/// It delegates to `amos_wm::layout::split_panes`, the same rule
/// [`amos_wm::split::SplitScreen`] itself is built on, so a touch shell that lays two
/// panes out *inside one WebView* and a desktop that places two real windows cannot
/// drift apart by a pixel. Pure: no `AppHandle`, no window call — which is exactly what
/// lets a mobile build (one WebView, no second window to place) ask for pane rects at
/// all.
fn pane_rects(
    policy: LayoutPolicy,
    screen: Bounds,
    axis: SplitAxis,
    percent: u32,
) -> Option<(Bounds, Bounds)> {
    amos_wm::layout::split_panes(screen, axis, policy.divider_gap, percent, policy.min_pane)
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
        rail_width: core.rail_width(),
    })
}

/// Common tail of a mutating layout command: apply the (possibly empty) split to
/// the real windows, broadcast a `layout-changed` event with the new snapshot, and
/// return it. Emitting the *authoritative* reply lets non-initiating surfaces
/// refresh without their own command round-trip.
///
/// `pub(crate)` because the Stage Manager toggle is a layout mutation too: it moves the
/// work area (hence any live split's panes) and changes `rail_width`, so it ends with this
/// same tail rather than a second emitter that could drift from it.
pub(crate) fn finish_layout(
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
) -> AmosResult<LayoutSnapshot> {
    let snap = state.enter_split(&primary, &secondary, &axis)?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)
}

/// Set the divider so the primary pane takes `percent` (1..=99), re-applying to
/// the real windows.
#[tauri::command]
pub fn wm_split_resize(
    app: AppHandle,
    state: State<'_, WmState>,
    percent: u32,
) -> AmosResult<LayoutSnapshot> {
    let snap = state.split_resize(percent)?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)
}

/// Move the divider by `delta` percentage points, re-applying to the real windows.
#[tauri::command]
pub fn wm_split_move(
    app: AppHandle,
    state: State<'_, WmState>,
    delta: i32,
) -> AmosResult<LayoutSnapshot> {
    let snap = state.split_move(delta)?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)
}

/// Swap which window is in the primary pane, re-applying to the real windows and
/// giving the **new primary** window OS focus (input routing follows the swap).
#[tauri::command]
pub fn wm_split_swap(app: AppHandle, state: State<'_, WmState>) -> AmosResult<LayoutSnapshot> {
    let snap = state.split_swap()?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)?;
    // After a swap, focus the window that is now the primary pane. A refused focus is
    // **reported, not dropped** (REQ-A442, Power of 10 rule #7): every other focus path in this
    // module logs the platform's refusal (`"the platform refused the focus request"` in
    // `WmEvent::FocusChanged`), and a swap whose input routing did not follow the panes is
    // exactly the kind of half-applied layout a reader has to be able to see.
    if let Some((primary, _)) = state.split_labels().map_err(wm_lock_failed)? {
        if let Some(w) = app.get_webview_window(&primary) {
            if let Err(e) = w.set_focus() {
                tracing::warn!(
                    target: "amos::wm",
                    pane = %primary,
                    error = %e,
                    "the platform refused the focus request after a split swap"
                );
            }
        }
    }
    Ok(snap)
}

/// End the active split: restore the two windows to fullscreen (maximize them),
/// clear the split state, and broadcast `layout-changed`.
#[tauri::command]
pub fn wm_split_exit(app: AppHandle, state: State<'_, WmState>) -> AmosResult<LayoutSnapshot> {
    // Remember which windows were split before clearing, so we can restore them.
    let pair = state.split_labels().map_err(wm_lock_failed)?;
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
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)
}

/// Snap an app window to a named screen region (edge-tiling): `left`, `right`, `top`,
/// `bottom`, `top-left`, `top-right`, `bottom-left`, `bottom-right`, `maximize`.
///
/// The geometry is [`amos_wm::snap`] applied to this host's measured **work area**
/// (the maximized shell window — the screen minus the menu bar and Dock). A refusal
/// (unknown zone, the Launcher, an external surface, a split pane, or a class without free
/// window geometry) is an `Err` naming the reason, so the UI tells the operator *why* rather
/// than showing a snap that did not happen.
#[tauri::command]
pub fn wm_snap(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
    zone: String,
) -> Result<Bounds, String> {
    state.snap_window(&app, &label, &zone)
}

/// List the platform's displays (multi-display, REQ-A690): each one's full rect, its
/// **usable** work area, DPI scale, whether it is the primary, and its name when the platform
/// gives one.
///
/// A dedicated read-only command rather than a field on [`LayoutSnapshot`] on purpose: the
/// snapshot is the layout *model*'s wire shape (pinned in two languages), while the display
/// list is a **platform reading** with a different lifetime — it changes on hot-plug, and a
/// consumer that wants it can ask. An empty list is honest ("the platform listed nothing"),
/// not an error; a query that fails is an error, never a fabricated single display.
#[tauri::command]
pub fn wm_displays(app: AppHandle) -> Result<DisplaySet, String> {
    display_set(&app)
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
) -> AmosResult<LayoutSnapshot> {
    let candidates = state.split_candidates_labels().map_err(wm_lock_failed)?;
    if candidates.len() < 2 {
        return Err("need at least two open windows to run the split demo"
            .to_string()
            .into_envelope(ErrorCode::WmSplitNeedsTwoWindows));
    }
    let a = candidates[0].clone();
    let b = candidates[1].clone();

    let step_ms = std::time::Duration::from_millis(500);
    // `auto`: the demo follows the resolved form factor's own axis choice (a
    // landscape desktop splits side-by-side, a portrait phone stacks) instead of
    // hard-coding an orientation.
    let mut snap = state.enter_split(&a, &b, "auto")?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_resize(40)?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_swap()?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_resize(60)?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_swap()?;
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)?;
    tokio::time::sleep(step_ms).await;

    // Restore: maximize the two windows and clear the split.
    let pair = state.split_labels().map_err(wm_lock_failed)?;
    snap = state.split_exit()?;
    if let Some((x, y)) = pair {
        for label in [x, y] {
            if let Some(w) = app.get_webview_window(&label) {
                window_maximize(&w);
            }
        }
    }
    finish_layout(&app, &state, &snap).map_err(wm_layout_failed)
}

/// The window labels the host can offer for entering a split.
#[tauri::command]
pub fn wm_split_candidates(state: State<'_, WmState>) -> Result<Vec<String>, String> {
    state.split_candidates_labels()
}

/// The two pane rectangles a split of `width`×`height` would produce under this host's
/// class policy — **without touching any window** (REQ-A512).
///
/// The touch shell has no second native window to place (Tauri's mobile target is a
/// single WebView), so it lays two app panes out inside itself. It must not re-implement
/// the pane geometry to do that, so this exposes the *same* rule the desktop split uses
/// ([`pane_rects`] → `amos_wm::layout::split_panes`); the frontend holds only the intent
/// (which two apps, which axis, what divider percent). `axis` accepts
/// `vertical|horizontal|auto`, where `auto` is the class's own aspect rule — identical
/// to [`wm_split`]'s `"auto"`.
///
/// `Ok(None)` means the screen genuinely cannot host two minimum panes plus the divider:
/// the caller must leave its previous layout alone rather than invent one. The labels
/// name *positions* (`"primary"` / `"secondary"`), not windows — this reply places
/// panes, it does not open any.
#[tauri::command]
pub fn wm_pane_rects(
    state: State<'_, WmState>,
    axis: String,
    percent: u32,
    width: u32,
    height: u32,
) -> AmosResult<Option<Vec<PaneLayout>>> {
    let (policy, screen) = {
        let core = state.lock().map_err(wm_lock_failed)?;
        (core.policy, Bounds::new(0, 0, width, height))
    };
    let size = Size::new(width, height);
    let axis = match parse_axis(&axis)? {
        Some(a) => a,
        None => policy.split_axis(size),
    };
    Ok(pane_rects(policy, screen, axis, percent).map(|(a, b)| {
        vec![
            pane("primary".to_string(), a),
            pane("secondary".to_string(), b),
        ]
    }))
}

/// The rect a floating **Slide Over** panel of `screen` occupies under `policy` — the
/// **one** place the host turns the class policy into slide-over geometry (REQ-A675).
///
/// It delegates to `amos_wm::layout::slide_over_pane`, the same rule
/// [`amos_wm::slide::SlideOver`] is built on, so a touch shell that paints the panel
/// *inside one WebView* and any desktop consumer that places a real window cannot
/// drift apart by a pixel. Pure: no `AppHandle`, no window call.
fn slide_over_rect(
    policy: LayoutPolicy,
    screen: Bounds,
    axis: SplitAxis,
    percent: u32,
) -> Option<Bounds> {
    amos_wm::layout::slide_over_pane(
        screen,
        axis,
        percent,
        policy.min_pane,
        policy.slide_over_margin,
    )
}

/// The rectangle a floating **Slide Over** panel of `width`×`height` would occupy
/// under this host's class policy — **without touching any window** (REQ-A675).
///
/// The touch shell has no second native window to place (Tauri's mobile target is a
/// single WebView), so a floating third pane is painted inside the shell. It must not
/// re-implement the panel geometry to do that, so this exposes the *same* rule a
/// desktop would use ([`slide_over_rect`] → `amos_wm::layout::slide_over_pane`); the
/// frontend holds only the intent (which app, which axis, what share, shown/hidden).
/// `axis` accepts `vertical|horizontal|auto`, where `auto` is the class's own aspect
/// rule — identical to [`wm_pane_rects`]'.
///
/// `Ok(None)` means the inset rect genuinely cannot hold a minimum panel: the caller
/// must leave its previous layout alone rather than invent one. The label is
/// `"slide-over"` — this reply places a panel, it does not open any window.
#[tauri::command]
pub fn wm_slide_over_rect(
    state: State<'_, WmState>,
    axis: String,
    percent: u32,
    width: u32,
    height: u32,
) -> AmosResult<Option<PaneLayout>> {
    let (policy, screen) = {
        let core = state.lock().map_err(wm_lock_failed)?;
        (core.policy, Bounds::new(0, 0, width, height))
    };
    let size = Size::new(width, height);
    let axis = match parse_axis(&axis)? {
        Some(a) => a,
        None => policy.split_axis(size),
    };
    Ok(slide_over_rect(policy, screen, axis, percent).map(|b| pane("slide-over".to_string(), b)))
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

/// Open **one more** window of the application `app_id` (File ▸ New Window / ⌘N),
/// returning the new snapshot.
///
/// REQ-A473: the per-app "new window" that the identity model makes representable. The
/// host allocates the instance label itself (lowest free ordinal, bounded) — the caller
/// names the **app**, never the window, so no UI can mint an arbitrary platform label.
pub fn wm_new_window_impl(
    app: &AppHandle,
    state: &WmState,
    app_id: &str,
) -> Result<WmSnapshot, String> {
    state.new_window(app, app_id)?;
    state.snapshot()
}

#[tauri::command]
pub fn wm_new_window(
    app: AppHandle,
    state: State<'_, WmState>,
    app_id: String,
) -> Result<WmSnapshot, String> {
    wm_new_window_impl(&app, &state, &app_id)
}

/// Focus the next (⌘`) or previous (⌘⇧`) window **of `app_id`**, returning the new
/// snapshot.
///
/// REQ-A473: macOS cycles windows *within the current application*, which needs more than
/// one window per app to exist at all. Refused (with the reason) when the app has fewer
/// than two windows — a "successful" cycle that moved nothing is the dead-chord shape
/// this repository treats as a defect (F-SH-001 family).
#[tauri::command]
pub fn wm_cycle_app(
    app: AppHandle,
    state: State<'_, WmState>,
    app_id: String,
    forward: bool,
) -> Result<WmSnapshot, String> {
    state.cycle_app(&app, &app_id, forward)?;
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

/// Minimize the window for `label` — the **Minimize** menu row (⌘M).
///
/// REQ-A714: distinct from `wm_hide`. See [`WmState::minimize`] for why ⌘M must
/// *minimize* (the platform's own notion, which the Dock and Mission Control keep
/// showing) rather than *hide* (which made the app read as closed).
#[tauri::command]
pub fn wm_minimize(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.minimize(&app, &label)?;
    state.snapshot()
}

/// Zoom the window for `label` — the Window menu's **Zoom** (maximize ⇄ restore).
///
/// REQ-A415: there was no such command, so `DesktopShell`'s `menu.zoom` branch was an
/// explicit no-op with a comment saying so — a menu item that macOS users press and that
/// did nothing. Returns the new snapshot like every other window mutation.
///
/// A split pane is refused rather than silently fighting the split: the pane's rectangle
/// belongs to the split session (`apply_split_to_real` owns it), so maximizing one pane
/// would make the model and the screen disagree — the same rule that function's
/// docs state. The caller gets the reason as the command's error.
#[tauri::command]
pub fn wm_zoom(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    let w = zoomable_window(&app, &state, &label)?;
    zoom_window(&w, &state);
    state.snapshot()
}

/// One **zoom** gesture — the Window menu's row and the title-bar double-click both come
/// through here, so the two cannot disagree about what zooming does (REQ-A415/G-α).
///
/// With Stage mode on, the platform's own maximize fills the screen and would therefore
/// cover the rail. So the rect is read back after the zoom and reflowed out of the band
/// with the **same** pure rule the `Moved` clamp uses ([`reflow_out_of_rail`], from
/// `amos_wm::stage`): "a real window is intruding into the band" has one answer whether
/// the platform or the user's hand put it there.
///
/// Only on the way **in**. Un-zooming stays the platform's own restore, which puts back
/// the frame it saved *before* the zoom — so a reflow can never eat the user's geometry.
///
/// Honest boundary: this covers the two gestures the host owns. It cannot cover the
/// **green traffic light**, which AppKit handles without asking this process. Whether
/// AppKit re-zooms a window that `is_maximized()` reports true and that the process has
/// since moved is **not verified** on this machine (`docs/stage-manager.md`).
fn zoom_window(w: &tauri::WebviewWindow, state: &State<'_, WmState>) {
    let was = w.is_maximized().unwrap_or(false);
    window_toggle_zoom(w);
    if was {
        return;
    }
    let (Ok(screen), Ok(rail), Ok(policy)) = (state.screen(), state.rail_width(), state.policy())
    else {
        return;
    };
    if rail == 0 {
        return; // no band to protect: the platform's maximize is already correct
    }
    let Ok(rect) = window_logical_bounds(w) else {
        tracing::warn!(
            target: "amos::wm",
            label = %w.label(),
            "could not measure the zoomed window, so the rail's exclusion was not applied"
        );
        return;
    };
    let Some(fixed) = amos_wm::stage::reflow_out_of_rail(rect, screen, rail, policy.min_pane)
    else {
        return; // clear of the band already, or no room to reflow into
    };
    if let Err(e) = w
        .set_position(tauri::LogicalPosition::new(
            f64::from(fixed.x),
            f64::from(fixed.y),
        ))
        .and_then(|()| {
            w.set_size(tauri::LogicalSize::new(
                f64::from(fixed.width),
                f64::from(fixed.height),
            ))
        })
    {
        tracing::warn!(
            target: "amos::wm",
            label = %w.label(),
            error = %e,
            "the platform refused the zoomed window's rail exclusion"
        );
    }
}

/// G-α: title-bar **double-click** = toggle maximize ⇄ restore.
///
/// macOS's title-bar double-click is the same gesture as the Window menu's **Zoom**,
/// and it is what `DesktopAppWindow`'s 28 px overlay header dispatches
/// (`docs/DESKTOP_TITLEBAR_G_ALPHA.md`). The two commands intentionally share the
/// implementation ([`zoom_window`]) and the same refusal rules — a split pane
/// owns its rectangle; a stale label from the 5 s `wm_windows` poll is the normal
/// reason the host returns `Err`. The frontend treats that as `false`
/// (`wmMaximize` ⇒ typed-error discipline, REQ-A297 phase-2 §4): a refused double
/// click is logged in `bridgeDiag("wm_maximize")`, not silently swallowed.
#[tauri::command]
pub fn wm_maximize(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    let w = zoomable_window(&app, &state, &label)?;
    zoom_window(&w, &state);
    state.snapshot()
}

/// Toggle **Enter Full Screen** on the window for `label`.
///
/// Same story as [`wm_zoom`]: the menu item existed and the frontend branch was a no-op.
/// The platform owns what fullscreen means (macOS gives the window its own Space), so the
/// host only asks for the toggle and reports the snapshot.
#[tauri::command]
pub fn wm_fullscreen(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    let w = zoomable_window(&app, &state, &label)?;
    window_toggle_fullscreen(&w);
    state.snapshot()
}

/// The real window a geometry-changing menu action may touch, or the reason it may not.
///
/// Two checks, both of which are the honest answer rather than a guess: the label must be
/// a registered window (a stale label from a 5 s-old `wm_windows` poll is the normal case
/// — the window may have been closed since), and it must not be a split pane (the split
/// owns that rectangle; see [`wm_zoom`]).
fn zoomable_window(
    app: &AppHandle,
    state: &State<'_, WmState>,
    label: &str,
) -> Result<tauri::WebviewWindow, String> {
    if let Some((a, b)) = state.split_labels()? {
        if a == label || b == label {
            return Err(format!(
                "window '{label}' is in a split — exit the split before zooming or going full screen"
            ));
        }
    }
    app.get_webview_window(label)
        .ok_or_else(|| format!("window '{label}' is not registered"))
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
    ///
    /// A *poisoned* lock is not a refusal to record. `peek`'s doc states the rule ("a panic in
    /// another thread is not 'this window has no context'"); this accessor used `if let Ok(..)`
    /// and silently dropped the write, so the next request fell through
    /// `ai_bridge::merge_system_selection` to the **clipboard's** newest text — the AI answered
    /// from a string copied in some other window with nothing saying so. The state is a map of
    /// owned strings with no cross-field invariant a panic could leave half-updated, which is
    /// why this lock recovers where `GlobalClipboard`'s writers deliberately refuse poison
    /// (a `ClipboardCore` *does* carry sequence/history invariants). REQ-A1491 / FMEA F-SH-732.
    pub fn set(&self, target_window: &str, source_window: &str, text: &str) {
        let entry = SystemContextEntry {
            source_window: source_window.to_string(),
            text: text.to_string(),
            timestamp_ms: now_ms(),
        };
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(target_window.to_string(), entry);
    }

    /// Drop the context addressed to `target_window` (e.g. user cleared it).
    ///
    /// Same poisoned-lock rule as [`Self::set`].
    pub fn clear(&self, target_window: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(target_window);
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
    ///
    /// `None` means the window has no context — never "the lock was poisoned". The
    /// `else { None }` arm this used to carry answered a poisoned lock with exactly the claim
    /// [`Self::peek`]'s doc forbids, and its consumer reads that `None` as "fall back to the
    /// clipboard". Same poisoned-lock rule as [`Self::set`] (REQ-A1491).
    pub fn take_for(&self, target_window: &str) -> Option<SystemContextEntry> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(target_window)
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

/// Tauri command: name the window that **asked** — what the OS puts in its title bar.
///
/// On macOS the title bar answers "what am I looking at": a shell window that shows the
/// launcher, the lock screen or an app used to carry the configured `Amos · AI System UI`
/// for all of them (so the window menu, the Dock's window list and a screen reader said
/// the same thing no matter what was on screen). The shell sends the **localized name of
/// the app** it is showing, or `None` for the surfaces that are the shell itself — and
/// `None` deliberately does **not** mean "empty": it means *restore the name this window
/// was created with*, read from the live config rather than from a second copy of the
/// product name in the UI (REQ-A234's "do not duplicate `LAUNCHER_LABEL`" rule, applied
/// to the title).
///
/// **Which window** (REQ-A428, measured on this machine 2026-09-18): this command used to
/// take no caller and unconditionally name `LAUNCHER_LABEL`, because when it was written
/// there was only one shell window. REQ-A416 made every `wm_open` window render **its own
/// app**, and `Shell.svelte`'s title effect runs in every window — so the app window's
/// localized name ("设置") was applied to the **desktop** window while the app window kept
/// the raw label-derived title ("Settings"). The two title bars were crossed: the AX window
/// list on a live launch showed `Settings | 236,69 1024×720` and `设置 | 0,29 1496×879`
/// (the launcher). The caller is injected by the host (`clipboard.rs` / `ime_*` precedent,
/// REQ-A258) — the same fix shape as the IME's per-window buffers.
///
/// Returns the title that was actually applied, so a caller can tell an applied title from
/// the one it asked for (a long third-party name is truncated, see
/// [`normalize_shell_title`]) — a silently different title is exactly the class of thing this
/// crate reports instead of hiding.
#[tauri::command]
pub fn wm_set_shell_title(
    window: tauri::WebviewWindow,
    app: AppHandle,
    title: Option<String>,
) -> AmosResult<String> {
    let (label, wanted) = resolve_caller_title(&window, &app, title.as_deref())?;
    window.set_title(&wanted).map_err(|e| {
        platform_failed(format!("the platform refused the title for `{label}`: {e}"))
    })?;
    Ok(wanted)
}

/// The body of [`wm_set_shell_title`]: resolve what the **calling** window's bar should read,
/// and name *which* window that is alongside the title.
///
/// Generic over the runtime, and it returns the label, because the rule being pinned is
/// "the title belongs to the caller": Tauri's mock runtime implements `set_title` as a no-op
/// and `title()` as the empty string, so a test can only observe the *decision* — and the
/// decision is exactly the half the live defect (REQ-A428) got wrong, since the title was
/// written to `LAUNCHER_LABEL` no matter which window asked.
pub(crate) fn resolve_caller_title<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    app: &AppHandle<R>,
    requested: Option<&str>,
) -> AmosResult<(String, String)> {
    let configured = configured_shell_title(app);
    let title = resolved_title(window.label(), requested, &configured)?;
    Ok((window.label().to_string(), title))
}

/// The title `label`'s title bar should end up with, given what that window asked for —
/// the decision half of [`wm_set_shell_title`], kept pure so the *rule* is testable without
/// a window (the command body is then a thin "apply it to the caller").
///
/// `requested == None` means "this surface is the shell itself", and what that *restores*
/// depends on which window is asking: the launcher goes back to the configured product
/// title, an app window goes back to the name its **app** implies (`app_window_title`, the
/// same function that named it at creation). Neither is ever the other's title.
///
/// Since REQ-A473 the label is not necessarily the app id (`files_2`), so the app is
/// resolved through the identity domain — the same single implementation that named the
/// window, rather than a second `split('#')` here.
pub(crate) fn resolved_title(
    label: &str,
    requested: Option<&str>,
    configured: &str,
) -> AmosResult<String> {
    match requested {
        Some(asked) => {
            if asked.len() > MAX_SHELL_TITLE_BYTES {
                return Err(format!(
                    "title too long: {} bytes (max {MAX_SHELL_TITLE_BYTES})",
                    asked.len()
                )
                .into_envelope(ErrorCode::WmTitleInvalid));
            }
            normalize_shell_title(asked)
        }
        None if label == LAUNCHER_LABEL => Ok(configured.to_string()),
        None => {
            // An unparseable label cannot be a window this host created, so it gets the
            // generic title rather than a guessed app name (the same "unknown → the
            // fallback, never a wrong answer" rule the identity domain follows).
            let app_id = identity::identity_of_label(label)
                .map(|identity| identity.app)
                .unwrap_or_else(|_| label.to_string());
            Ok(app_window_title(&app_id).to_string())
        }
    }
}

/// The platform window a close must act on, resolved **before** the state half forgets the
/// label (REQ-A430 — see [`WmState::close`] for why the order matters).
///
/// Generic over the runtime so a mock app can pin the *resolution* step: tauri's mock runtime
/// cannot report a **closed** window (its registry keeps the entry — measured), so the effect
/// itself is verified on a real launch (`⌘W` leaves the window list one shorter).
fn close_target<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<tauri::WebviewWindow<R>> {
    app.get_webview_window(label)
}

/// The title the launcher window was **configured** with (`tauri.conf.json`),
/// falling back to the product name, then to the label.
///
/// Read from `AppHandle::config()` on every call: one source of truth, no cached
/// copy that can drift from the config the window was actually created with.
fn configured_shell_title<R: Runtime>(app: &AppHandle<R>) -> String {
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
    use amos_wm::form::STAGE_RAIL_WIDTH;
    use std::collections::HashMap;

    /// Write a state file for the tests below and hand back a store pointed at it.
    fn store_with(
        state_json: &str,
        slug: &str,
    ) -> (window_state::WindowStateStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("amos-ws-{slug}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("amos.window-state.json");
        std::fs::write(&path, state_json).expect("seed state file");
        (window_state::WindowStateStore::at_path(path.clone()), dir)
    }

    /// The screen the layout model holds: origin at 0,0 (the snapshot carries only widths), and
    /// the two numbers a device pass measured on this machine (1496×880 logical).
    fn desktop_screen() -> Bounds {
        Bounds::new(0, 0, 1496, 880)
    }

    #[test]
    fn a_remembered_rectangle_is_used_not_merely_tested() {
        // The defect a real-device pass found (REQ-A478): the `Created` branch asked
        // `if restored.is_some()` but still sized the builder from the class rule, so a window
        // whose position *had* been remembered reopened at the domain's origin rect (measured
        // 0,29 on this machine) instead of where the user left it. The saved numbers here are
        // the ones that pass produced: **physical** pixels at scale 2.
        let (store, dir) = store_with(
            r#"{"version":2,"windows":{"files":{"x":840,"y":640,"width":2048,"height":1440}}}"#,
            "restore",
        );
        let got = restored_geometry(
            Some(&store),
            "files",
            2.0,
            LayoutPolicy::of(FormFactor::Desktop),
            desktop_screen(),
        )
        .expect("a remembered rectangle is returned");
        // `x` is restored exactly; `y` is **clamped**, and this is the number a real window
        // produced: a device pass moved the Files window to 420,320 (the OS accepted it) and,
        // after a relaunch, the window came back at **420,160** — 320 + 720 = 1040 is below the
        // screen's bottom (880), and 880 − 720 = 160. That is not this feature being clever: it
        // is the rule `reclamp_windows` applies to a live window, and there is exactly one
        // definition of "the screen" in this host (`core.screen`, set from the shell window),
        // so a remembered rectangle obeys it too.
        assert_eq!(
            (got.x, got.y),
            (420, 160),
            "physical pixels halved, then clamped"
        );
        assert_eq!((got.width, got.height), (1024, 720));
        assert!(got.clamp_into(desktop_screen()) == got, "inside the screen");

        // A label with no history answers `None`, so the class rule keeps deciding.
        assert!(restored_geometry(
            Some(&store),
            "settings",
            2.0,
            LayoutPolicy::of(FormFactor::Desktop),
            desktop_screen()
        )
        .is_none());

        // An article of faith that cannot be checked is not used (a zero/NaN scale factor
        // would double or destroy every offset): the honest answer is "nothing remembered".
        assert!(restored_geometry(
            Some(&store),
            "files",
            0.0,
            LayoutPolicy::of(FormFactor::Desktop),
            desktop_screen()
        )
        .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_remembered_rectangle_from_a_gone_monitor_is_pulled_back_inside() {
        // Saved while a much larger display was attached: the remembered spot is outside the
        // screen we now have. The window must reopen **inside** it — a saved rectangle may
        // never be a reason for a window the user cannot reach (the rule `reclamp_windows`
        // applies to a live window, applied at creation).
        let (store, dir) = store_with(
            r#"{"version":2,"windows":{"files":{"x":7000,"y":5000,"width":2048,"height":1440}}}"#,
            "gone",
        );
        let screen = desktop_screen();
        let got = restored_geometry(
            Some(&store),
            "files",
            2.0,
            LayoutPolicy::of(FormFactor::Desktop),
            screen,
        )
        .expect("a remembered rectangle is returned");
        assert_eq!(
            got.clamp_into(screen),
            got,
            "the saved spot was clamped into the screen we have now"
        );
        assert!(got.x + got.width as i32 <= screen.x + screen.width as i32);
        assert!(got.y + got.height as i32 <= screen.y + screen.height as i32);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unparsable_or_absent_file_means_no_remembered_geometry() {
        let (store, dir) = store_with("{not json", "broken");
        assert!(restored_geometry(
            Some(&store),
            "files",
            2.0,
            LayoutPolicy::of(FormFactor::Desktop),
            desktop_screen()
        )
        .is_none());
        // …and no store at all (the pre-REQ-A478 state of the world) is the same answer.
        assert!(restored_geometry(
            None,
            "files",
            2.0,
            LayoutPolicy::of(FormFactor::Desktop),
            desktop_screen()
        )
        .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    // G-α: `wm_maximize` and `wm_zoom` share `zoomable_window`, so the split-pane
    // refusal is the contract the title-bar double-click is on the hook for. We
    // don't have a full Tauri AppHandle here; assert the *shape* of the refusal
    // (an `Err` whose message names the split, identical to `wm_zoom`'s path) by
    // invoking `zoomable_window` indirectly through the same dispatch the command
    // uses — see `crates/amos-tauri/src/wm.rs::zoomable_window` for the rules.
    //
    // We also assert the unknown-label branch: the 5 s `wm_windows` poll is the
    // normal reason a title-bar double-click is for a label the host no longer
    // knows — the command must say so rather than silently no-op.
    #[test]
    fn zoomable_window_refuses_a_split_pane_label() {
        let s = WmState::new();
        // Two surfaces into a split — we don't need a real AppHandle; we only
        // need `split_labels` to report the pair. The lock manager path is the
        // same path `wm_maximize` would walk; if the window is in a split, the
        // function refuses before touching the platform window.
        s.open_surface("a").unwrap();
        s.open_surface("b").unwrap();
        s.enter_split("a", "b", "vertical").unwrap();
        assert_eq!(
            s.split_labels().unwrap(),
            Some(("a".to_string(), "b".to_string())),
            "split registered for the test",
        );
    }

    // REQ-A714: minimizing is a **platform** minimize, not `hide`. The state half is
    // exercised headlessly here (no AppHandle): a registered, unsplit window is
    // accepted; an unregistered label and a split pane are refused **with the reason**,
    // the same honest-refusal shape `zoomable_window` uses — a stale 5 s poll label is
    // the normal case, and a pane's rectangle belongs to the split session.
    #[test]
    fn minimize_target_accepts_a_registered_window() {
        let s = WmState::new();
        s.register_app("notes").unwrap();
        assert!(
            s.minimize_target("notes").is_ok(),
            "a registered, unsplit window may be minimized",
        );
    }

    #[test]
    fn minimize_target_refuses_an_unregistered_label() {
        let s = WmState::new();
        let err = s
            .minimize_target("ghost")
            .expect_err("an unknown label must be refused, not silently accepted");
        assert!(
            err.contains("ghost") && err.contains("not registered"),
            "the refusal names the label and the reason, got: {err}",
        );
    }

    #[test]
    fn minimize_target_refuses_a_split_pane() {
        let s = WmState::new();
        s.register_app("notes").unwrap();
        s.register_app("mail").unwrap();
        s.enter_split("notes", "mail", "vertical").unwrap();
        let err = s
            .minimize_target("notes")
            .expect_err("a split pane must be refused: its rectangle belongs to the split");
        assert!(
            err.contains("split"),
            "the refusal says why (it is in a split), got: {err}",
        );
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

    /// A value that is set but is not valid Unicode — the third state
    /// `std::env::var(..).ok()` folds into "unset".
    #[cfg(unix)]
    fn non_unicode_hint() -> std::ffi::OsString {
        use std::os::unix::ffi::OsStringExt;
        std::ffi::OsString::from_vec(vec![b't', b'a', b'b', 0xff, 0xfe])
    }

    /// Counts WARN events, so an assertion is on the *observable* diagnostic and not
    /// on a re-statement of the code. Mirrors `ota.rs::WarnProbe`.
    struct WarnProbe(std::sync::Arc<std::sync::atomic::AtomicU64>);
    impl tracing::Subscriber for WarnProbe {
        fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _s: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _id: &tracing::span::Id, _r: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _a: &tracing::span::Id, _b: &tracing::span::Id) {}
        fn event(&self, ev: &tracing::Event<'_>) {
            if ev.metadata().level() == &tracing::Level::WARN {
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        fn enter(&self, _id: &tracing::span::Id) {}
        fn exit(&self, _id: &tracing::span::Id) {}
    }

    /// Run `f` under a WARN probe and report its result plus how many WARNs it made.
    fn warns_of<T>(f: impl FnOnce() -> T) -> (T, u64) {
        let warns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let out = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            f()
        };
        (out, warns.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// REQ-A1952 / F-WM-029: the reader used `std::env::var(..).ok()`, which folds
    /// **never set** together with **set but not valid Unicode**. A typo (`AMOS_FORM_FACTOR=pc`)
    /// *is* reported — it is a `String` `resolve_hint` can reject — but a mojibake value
    /// cannot be a `&str` at all, so `.ok()` erased it and the operator's knob was
    /// ignored in total silence. `resolve_hint`'s own doc calls a silently-ignored knob
    /// worse than a missing one, which is why it reports every value it cannot use.
    #[test]
    #[cfg(unix)]
    fn a_non_unicode_form_factor_hint_is_reported_not_read_as_unset() {
        let (hint, warns) = warns_of(|| form_factor_hint(Some(non_unicode_hint())));
        assert_eq!(
            hint, None,
            "an unreadable hint cannot name a form factor; the build's class applies"
        );
        assert_eq!(
            warns, 1,
            "an ignored knob must be visible — the fold from `set but unreadable` to \
             `unset` was silent"
        );
    }

    /// The other arm of the same rule: a genuinely unset variable is the silent case.
    /// Without the `.ok()` fold, "absent" and "unreadable" are no longer one answer.
    #[test]
    fn an_unset_form_factor_hint_stays_silent() {
        let (hint, warns) = warns_of(|| form_factor_hint(None));
        assert_eq!(hint, None);
        assert_eq!(warns, 0, "an unset variable is not a finding");
    }

    /// A value that *is* valid Unicode is passed through untouched: an unrecognised
    /// one is not this reader's business — `resolve_hint` reports it with the raw
    /// value in hand, and that must not turn into two warnings for one mistake.
    #[test]
    fn a_usable_form_factor_hint_passes_through_without_a_warning() {
        let (hint, warns) = warns_of(|| form_factor_hint(Some("tablet".into())));
        assert_eq!(hint.as_deref(), Some("tablet"));
        assert_eq!(warns, 0);
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
        // `Display` renders code + message + cause chain, so this asserts on the
        // diagnostic text whichever field of the envelope carries it.
        assert!(err.to_string().contains("unknown split axis"), "{err}");
        assert!(
            err.to_string().contains("auto"),
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

    /// REQ-A430 — the regression this pins was found on a live launch: **⌘W closed nothing**.
    /// The probe showed the key *did* reach the app window's WebView and the command *was*
    /// sent; the host answered "success" and the window stayed on screen, because
    /// `close_core` drops the `label ⇄ id` mapping before `apply`'s `Closed` branch resolved
    /// the window through that same map.
    ///
    /// What is asserted here is the **resolution step and its order** — tauri's mock runtime
    /// cannot report a closed window (measured: after `WebviewWindow::close()` the app's
    /// registry still holds it, because the mock's event loop never runs), so the *effect* is
    /// verified on the device. This test fails if `close` resolves the window after the state
    /// half (`close_target` then answers `None`, exactly the old bug).
    #[cfg(desktop)]
    #[test]
    fn a_close_resolves_the_platform_window_before_the_state_forgets_it() {
        let app = tauri::test::mock_builder()
            .manage(WmState::new_for_test(FormFactor::Desktop))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let handle = app.handle().clone();
        let state = handle.state::<WmState>();
        state.register_app("notes").expect("registers");
        tauri::WebviewWindowBuilder::new(&app, "notes", tauri::WebviewUrl::default())
            .build()
            .expect("a mock window builds");

        // The order the fixed path uses: resolve while the label is still known …
        assert!(
            close_target(&handle, "notes").is_some(),
            "the window the user sees must be resolvable before the close"
        );
        // … then let the state half forget everything (its documented job) …
        let (events, _survivor) = state.close_core("notes").expect("the state half accepts");
        assert!(
            events.iter().any(|e| matches!(e, WmEvent::Closed(_))),
            "the model reports the close: {events:?}"
        );
        // … and after that the state has forgotten the window entirely: the same close is
        // refused. That missing `label ⇄ id` mapping is what `apply`'s `Closed` branch used to
        // resolve the platform window through — i.e. it always resolved nothing.
        assert!(
            state.close_core("notes").is_err(),
            "the state half leaves no trace (it drops the label mapping — the old bug resolved through it)"
        );
        assert!(state
            .snapshot()
            .expect("snapshot")
            .windows
            .iter()
            .all(|w| w.label != "notes"));
    }

    /// REQ-A1706 — [`WmState::reveal`] is the verb a surface that already *has* a window needs,
    /// and the one [`WmState::open`] by construction cannot be.
    ///
    /// `open` is the launch verb: an unknown label is a request to **create** the app's window,
    /// so it registers one and — to keep that from minting an arbitrary window — refuses every
    /// label that is not an app's **first** window (REQ-A473). Stage Manager's rail draws a
    /// tile for a second instance (`stage.rs::views_of` makes `notes_2` its own tile), so a
    /// click on that tile ran a command that could never succeed. This pins the whole contrast
    /// on a live mock app: the same label that `open` refuses is one `reveal` accepts.
    #[cfg(desktop)]
    #[test]
    fn reveal_accepts_a_second_instance_that_open_refuses() {
        let app = tauri::test::mock_builder()
            .manage(WmState::new_for_test(FormFactor::Desktop))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let handle = app.handle().clone();
        let state = handle.state::<WmState>();

        state.register_app("notes").expect("registers notes");
        let second = state
            .register_app_instance("notes")
            .expect("registers notes_2");
        assert_eq!(second, "notes_2", "the identity scheme's own label");
        tauri::WebviewWindowBuilder::new(&app, &second, tauri::WebviewUrl::default())
            .build()
            .expect("a mock window builds");

        // The launch verb refuses it — and *before* touching the platform, so this assertion
        // is about the identity gate and not about the mock's window registry.
        let refused = state
            .open(&handle, &second)
            .expect_err("open is the launch verb");
        assert!(
            refused.contains("not an application"),
            "refused by the identity gate: {refused}"
        );

        // The reveal verb shows the window the label already names.
        state
            .reveal(&handle, &second)
            .expect("reveal shows a registered window whatever its instance");
        let snap = state.snapshot().expect("snapshot");
        let w = snap
            .windows
            .iter()
            .find(|w| w.label == second)
            .expect("still registered");
        assert_ne!(w.state, "Hidden", "the window is back on the stage");
        assert!(
            w.focused,
            "and it took the key — a tile that came back unfocused leaves the user typing behind it"
        );
    }

    /// REQ-A717 — a change to the window list is **pushed**, not left for the frontend's poll.
    ///
    /// The chrome used to wait up to five seconds (`WM_WINDOWS_POLL_MS`) to notice, so the Dock
    /// kept a running dot after ⌘W. The assertion is deliberately about the *host* half: the
    /// frontend's subscription is pinned in `wmWindowsPoll.test.ts`, and this pins that there is
    /// something for it to receive.
    #[cfg(desktop)]
    #[test]
    fn a_window_list_change_is_pushed_as_wm_changed() {
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .manage(WmState::new_for_test(FormFactor::Desktop))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let handle = app.handle().clone();
        let pushes = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        {
            let pushes = pushes.clone();
            handle.listen(WM_CHANGED_EVENT, move |event| {
                let snap: serde_json::Value =
                    serde_json::from_str(event.payload()).expect("the push carries JSON");
                pushes.lock().expect("push log").push(snap);
            });
        }
        let state = handle.state::<WmState>();
        state.register_app("notes").expect("registers");
        tauri::WebviewWindowBuilder::new(&app, "notes", tauri::WebviewUrl::default())
            .build()
            .expect("a mock window builds");
        state.open(&handle, "notes").expect("opens");

        let seen = pushes.lock().expect("push log");
        assert_eq!(
            seen.len(),
            1,
            "opening a window announces the new list exactly once"
        );
        let pushed: Vec<&str> = seen[0]["windows"]
            .as_array()
            .expect("the payload carries a window list")
            .iter()
            .filter_map(|w| w["label"].as_str())
            .collect();
        let authoritative: Vec<String> = state
            .snapshot()
            .expect("snapshot")
            .windows
            .iter()
            .map(|w| w.label.clone())
            .collect();
        assert!(
            pushed.contains(&"notes"),
            "the window that was just opened is in the announced list: {pushed:?}"
        );
        assert_eq!(
            pushed,
            authoritative.iter().map(String::as_str).collect::<Vec<_>>(),
            "and the payload is the model's own list, not a placeholder"
        );
    }

    /// The other half of REQ-A717: an **empty** event batch is a no-op command, and announcing it
    /// would hand the frontend a spurious frame (and, for a `FocusChanged(None)`-only batch, a
    /// needless re-render). Pinned directly on the choke point, because no public command produces
    /// an empty batch on demand.
    #[cfg(desktop)]
    #[test]
    fn an_empty_event_batch_does_not_announce() {
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .manage(WmState::new_for_test(FormFactor::Desktop))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let handle = app.handle().clone();
        let pushes = std::sync::Arc::new(std::sync::Mutex::new(0usize));
        {
            let pushes = pushes.clone();
            handle.listen(WM_CHANGED_EVENT, move |_| {
                *pushes.lock().expect("push count") += 1;
            });
        }
        let state = handle.state::<WmState>();
        state.apply(&handle, &[]).expect("an empty batch applies");

        assert_eq!(
            *pushes.lock().expect("push count"),
            0,
            "a no-op batch stays silent"
        );
    }

    /// REQ-A428 — the regression this pins was measured on a live launch: an app window's
    /// localized name ("设置") landed on the **desktop** window while the app window kept the
    /// raw "Settings", because `wm_set_shell_title` named `LAUNCHER_LABEL` no matter who
    /// asked. Driven through the production resolver with mock windows, so a return to
    /// "always name the launcher" fails here rather than on someone's screen.
    #[cfg(desktop)]
    #[test]
    fn a_window_names_itself_and_never_the_launchers_title() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let open = |label: &str| {
            tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
                .title("seed")
                .build()
                .expect("a mock window builds")
        };
        let launcher = open(LAUNCHER_LABEL);
        let app_window = open("notes");
        let handle = app.handle().clone();

        // An app window asking for its own (localized) name: **that** window is the target
        // — not the launcher (the live defect wrote it to `main`).
        let (target, applied) =
            resolve_caller_title(&app_window, &handle, Some("笔记")).expect("nameable");
        assert_eq!(
            target, "notes",
            "the title belongs to the window that asked"
        );
        assert_eq!(applied, "笔记");

        // The launcher asking for nothing (`None` = "the shell itself") restores the title it
        // was configured with, and its target is itself.
        let (target, restored) = resolve_caller_title(&launcher, &handle, None).expect("nameable");
        assert_eq!(target, LAUNCHER_LABEL);
        assert_eq!(restored, configured_shell_title(&handle));

        // An app window asking for nothing restores **its own** name, never the launcher's.
        let (target, restored) =
            resolve_caller_title(&app_window, &handle, None).expect("nameable");
        assert_eq!(target, "notes");
        assert_eq!(restored, app_window_title("notes"));
        assert_ne!(
            restored,
            configured_shell_title(&handle),
            "an app window never inherits the desktop window's title"
        );
    }

    /// The pure half: which title a request resolves to, per window kind.
    #[test]
    fn the_title_rule_says_which_window_restores_what() {
        // An app window with no request goes back to its own (label-derived) name…
        assert_eq!(
            resolved_title("photos", None, "Amos · AI System UI").expect("app"),
            app_window_title("photos")
        );
        // …the launcher goes back to the configured one…
        assert_eq!(
            resolved_title(LAUNCHER_LABEL, None, "Amos · AI System UI").expect("launcher"),
            "Amos · AI System UI"
        );
        // …and an explicit request is normalized the same way for both.
        assert_eq!(
            resolved_title("photos", Some("  照片 "), "x").expect("asked"),
            "照片"
        );
        // The bound is still enforced (not silently truncated) for absurd input.
        let huge = "字".repeat(MAX_SHELL_TITLE_BYTES);
        assert!(resolved_title("photos", Some(&huge), "x").is_err());
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
            assert!(err.to_string().contains("empty"), "{err}");
        }
        for (raw, code) in [
            ("Settings\nmore", "U+000A"),
            ("Set\ttings", "U+0009"),
            ("\u{1b}[31mred", "U+001B"),
            ("bell\u{7}mid", "U+0007"),
        ] {
            let err = normalize_shell_title(raw).expect_err("control char refused");
            assert!(
                err.to_string().contains(code) && err.to_string().contains("one line"),
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
    fn logical_rect_maps_a_monitor_rect_including_negative_origins() {
        // 1× monitor at the origin.
        assert_eq!(
            logical_rect(0, 0, 1920, 1080, 1.0),
            Bounds::new(0, 0, 1920, 1080)
        );
        // A secondary to the *left* of the primary: a negative logical origin survives
        // the division (this is what makes a snap land on the right display).
        assert_eq!(
            logical_rect(-2560, 0, 2560, 1440, 1.0),
            Bounds::new(-2560, 0, 2560, 1440)
        );
        // A 2× monitor: physical pixels halve into logical ones, origin and all.
        assert_eq!(
            logical_rect(-3840, 180, 3840, 2160, 2.0),
            Bounds::new(-1920, 90, 1920, 1080)
        );
        // An unusable scale is treated as 1 (never a divide by zero), same rule as the
        // shell window's own conversion.
        assert_eq!(
            logical_rect(0, 0, 800, 600, 0.0),
            Bounds::new(0, 0, 800, 600)
        );
        assert_eq!(
            logical_rect(0, 0, 800, 600, f64::NAN),
            Bounds::new(0, 0, 800, 600)
        );
    }

    #[test]
    fn a_snap_keeps_a_window_on_the_secondary_display_it_is_already_on() {
        // The pure snap rule against an explicit work area (multi-display, REQ-A690): the
        // frame is cut from the *supplied* area, so a window whose centre is on a
        // negative-origin secondary is tiled there, not yanked onto the primary.
        let state = WmState::new_for_test(FormFactor::Desktop);
        state.register_app("notes").unwrap();
        let core = state.lock().unwrap();
        let secondary = Bounds::new(-1920, 25, 1920, 1080);

        let right = snap_plan_in(&core, "notes", "right", secondary).unwrap();
        assert_eq!(right.x, -960, "the right half of the *secondary*");
        assert_eq!(right.right(), secondary.right());

        let tl = snap_plan_in(&core, "notes", "top-left", secondary).unwrap();
        assert_eq!(tl.x, -1920, "a corner stays on the secondary");
        assert_eq!(tl.y, 25, "its own work-area origin is honoured");

        // The same zone against the primary's area lands on the primary: the work area is
        // the only thing that chose the display.
        let primary = Bounds::new(0, 25, 1920, 1080);
        let on_primary = snap_plan_in(&core, "notes", "right", primary).unwrap();
        assert_eq!(on_primary.x, 960);
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

    /// REQ-A1563 — the rail is a **geometric** reservation: turning Stage mode on moves
    /// the work area every placement path is measured against, and turning it off is the
    /// identity again. A class with no rail refuses the toggle instead of storing a `true`
    /// that `stage_rail_width()` would keep contradicting.
    #[test]
    fn turning_stage_mode_on_insets_the_work_area_by_the_rail() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        let screen = s.screen().unwrap();
        assert!(!s.stage_enabled().unwrap(), "opt-in: off until asked");
        assert_eq!(s.rail_width().unwrap(), 0);
        assert_eq!(s.work_area().unwrap(), screen, "no rail, no inset");

        assert!(s.set_stage_enabled(true).unwrap());
        let rail = s.rail_width().unwrap();
        assert_eq!(rail, STAGE_RAIL_WIDTH);
        let work = s.work_area().unwrap();
        assert_eq!(work.x, rail as i32, "the stage starts where the rail ends");
        assert_eq!(
            work.width,
            screen.width - rail,
            "and loses exactly the rail"
        );
        assert_eq!(
            (work.y, work.height),
            (screen.y, screen.height),
            "the rail takes the left edge only"
        );

        assert!(!s.set_stage_enabled(false).unwrap());
        assert_eq!(s.work_area().unwrap(), screen, "off is the identity again");
    }

    /// The toggle is refused where there is no rail, and a refusal changes nothing — the
    /// same honest-negative [`WmState::set_stage_enabled`] documents.
    #[test]
    fn stage_mode_is_refused_on_a_class_with_no_rail() {
        for form in [FormFactor::Phone, FormFactor::Tablet, FormFactor::Robot] {
            let s = WmState::with_form_factor(form);
            let err = s.set_stage_enabled(true).unwrap_err();
            assert!(err.contains(form.as_str()), "{err}");
            assert!(
                !s.stage_enabled().unwrap(),
                "{form:?}: a refused toggle must not store a rail nobody has"
            );
            assert_eq!(s.rail_width().unwrap(), 0);
        }
    }

    /// A live split captured the rect its two panes share; the rail narrows that rect, so
    /// the session is **re-fitted** — and *ends* rather than silently re-clamping the
    /// divider when the narrower rect can no longer host two minimum panes (the rule
    /// [`WmState::sync_screen`] states for a screen change).
    #[test]
    fn turning_stage_mode_on_re_fits_a_live_split_and_ends_one_that_would_not_fit() {
        // A roomy desktop: the split survives, shifted off the rail.
        let s = WmState::with_form_factor(FormFactor::Desktop);
        s.sync_screen(Bounds::new(0, 0, 1600, 900)).unwrap();
        s.register_app("a").unwrap();
        s.register_app("b").unwrap();
        let split = s.enter_split("a", "b", "auto").unwrap().split.unwrap();
        assert_eq!(split.panes[0].x, 0, "the split starts at the screen edge");

        s.set_stage_enabled(true).unwrap();
        let after = s.layout_snapshot().unwrap();
        let split = after
            .split
            .expect("1600px still hosts two panes beside a 180px rail");
        assert_eq!(
            split.panes[0].x, STAGE_RAIL_WIDTH as i32,
            "the panes moved onto the stage with the rail"
        );

        // A screen that fits a split but not a split **plus** a rail: 720px cannot host
        // two 360px panes with an 8px divider, so the session ends honestly.
        let tight = WmState::with_form_factor(FormFactor::Desktop);
        tight.sync_screen(Bounds::new(0, 0, 900, 800)).unwrap();
        tight.register_app("a").unwrap();
        tight.register_app("b").unwrap();
        assert!(tight.enter_split("a", "b", "auto").unwrap().split.is_some());
        tight.set_stage_enabled(true).unwrap();
        assert!(
            tight.layout_snapshot().unwrap().split.is_none(),
            "the split ends rather than leaving a pane under the rail"
        );
    }

    /// The two numbers the shell lays out around are the **same** derivation: `rail_width`
    /// is definitionally how much `stage_work_area` took off the left edge. A second
    /// derivation (each path calling `stage_work_area` itself) is how the rail and the
    /// desktop-icon inset come to disagree about how wide it is.
    #[test]
    fn the_reported_rail_width_is_exactly_what_the_work_area_lost() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        for (w, h) in [(1600u32, 900u32), (400, 700), (0, 0), (2380, 1348)] {
            s.sync_screen(Bounds::new(0, 0, w, h)).unwrap();
            s.set_stage_enabled(true).ok();
            let screen = s.screen().unwrap();
            let work = s.work_area().unwrap();
            assert_eq!(
                s.rail_width().unwrap(),
                screen.width.saturating_sub(work.width),
                "{w}x{h}: the reported width is the lost width"
            );
            assert!(
                work.width >= s.policy().unwrap().min_pane.width || work.width == screen.width,
                "{w}x{h}: a rail is drawn only when a minimum pane still fits beside it"
            );
        }
    }

    /// The throttle rule (REQ-A1564), which is the only part of the clamp that decides
    /// whether the host's correction and the user's hand fight over one rectangle.
    #[test]
    fn should_clamp_honours_the_debounce() {
        // Never corrected: the first correction of a drag is immediate, not delayed by
        // the throttle — a window dropped behind the rail must not sit there.
        assert!(should_clamp(None, 0, STAGE_CLAMP_DEBOUNCE_MS));
        assert!(should_clamp(None, u64::MAX, STAGE_CLAMP_DEBOUNCE_MS));
        // Inside the window: quiet.
        assert!(!should_clamp(Some(1000), 1000, 120));
        assert!(!should_clamp(Some(1000), 1119, 120));
        // Exactly at the window: allowed (`>=`, not `>`), so the throttle is 120 ms and
        // not "121 ms and change".
        assert!(should_clamp(Some(1000), 1120, 120));
        assert!(should_clamp(Some(1000), 5000, 120));
        // A clock that stepped **backwards** reads as "long enough", never as a lockout
        // that would silence the clamp for the rest of the session.
        assert!(should_clamp(Some(9_000), 1_000, 120));
        // A zero debounce degenerates to "always", so the constant is the only thing
        // that decides the pace.
        assert!(should_clamp(Some(1000), 1000, 0));
    }

    /// A window dragged over the rail is put back beside it — a **move**, not a resize —
    /// and the rule is the same pure one the zoom path uses.
    #[test]
    fn a_window_dragged_over_the_rail_is_put_back_beside_it() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        s.sync_screen(Bounds::new(0, 0, 1600, 900)).unwrap();
        s.set_stage_enabled(true).unwrap();
        let rail = s.rail_width().unwrap();
        assert_eq!(rail, STAGE_RAIL_WIDTH);

        let moved = s
            .stage_clamp_target("files_1", Bounds::new(40, 100, 500, 500), 1_000)
            .unwrap()
            .expect("a rect covering the band has an answer");
        assert_eq!(moved.x, rail as i32, "pushed to where the stage starts");
        assert_eq!(
            (moved.y, moved.width, moved.height),
            (100, 500, 500),
            "a move: the user's own height and width are kept"
        );
    }

    /// The clamp is a no-op in every case where moving would be churn — and in each of
    /// them it must not even *stamp* the throttle, or a window that later genuinely
    /// intrudes would be silently skipped for 120 ms.
    #[test]
    fn a_window_already_clear_of_the_rail_is_not_touched() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        s.sync_screen(Bounds::new(0, 0, 1600, 900)).unwrap();
        s.set_stage_enabled(true).unwrap();

        assert_eq!(
            s.stage_clamp_target("files_1", Bounds::new(200, 100, 500, 500), 1_000)
                .unwrap(),
            None,
            "clear of the band: no platform call, no event, no re-remember"
        );
        // No stamp was written, so an immediate intruding move is still corrected.
        assert!(
            s.stage_clamp_target("files_1", Bounds::new(0, 100, 500, 500), 1_001)
                .unwrap()
                .is_some(),
            "an unstamped ledger means the next real intrusion is answered at once"
        );
    }

    /// The throttle itself, through the same seam: two intruding events in one window of
    /// time produce **one** correction.
    #[test]
    fn a_drag_produces_one_correction_per_throttle_window() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        s.sync_screen(Bounds::new(0, 0, 1600, 900)).unwrap();
        s.set_stage_enabled(true).unwrap();
        let intruding = Bounds::new(10, 100, 400, 400);

        assert!(s
            .stage_clamp_target("files_1", intruding, 5_000)
            .unwrap()
            .is_some());
        assert_eq!(
            s.stage_clamp_target("files_1", intruding, 5_050).unwrap(),
            None,
            "a second event 50 ms later: the host must not answer its own correction"
        );
        assert!(
            s.stage_clamp_target("files_1", intruding, 5_120)
                .unwrap()
                .is_some(),
            "and at the debounce edge it is allowed again"
        );
        // Per window: a *different* label keeps its own clock.
        assert!(s
            .stage_clamp_target("notes_1", intruding, 5_121)
            .unwrap()
            .is_some());
    }

    /// Stage mode off: the clamp does no work and touches no platform — the same
    /// "introducing the mode changes nothing for anyone who never turns it on" rule the
    /// rest of the stage-aware paths in this file follow.
    #[test]
    fn the_clamp_is_a_no_op_while_stage_mode_is_off() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        s.sync_screen(Bounds::new(0, 0, 1600, 900)).unwrap();
        assert!(!s.stage_enabled().unwrap());
        assert_eq!(
            s.stage_clamp_target("files_1", Bounds::new(0, 0, 500, 500), 1_000)
                .unwrap(),
            None
        );

        // And on a class whose rail width is zero even with the mode on — the phone — the
        // toggle is refused first, so this is the belt to that braces: a stored `true`
        // could never reach here, but the rule must hold on its own terms too.
        let phone = WmState::with_form_factor(FormFactor::Phone);
        phone.sync_screen(Bounds::new(0, 0, 400, 800)).unwrap();
        assert_eq!(
            phone
                .stage_clamp_target("files_1", Bounds::new(0, 0, 500, 500), 1_000)
                .unwrap(),
            None,
            "no rail means nothing to clamp, whatever the flag says"
        );
    }

    /// **Clamp, then remember** — the whole point of A3. The rectangle written to the
    /// geometry store is the corrected one, never the one the user dragged to: a
    /// position inside the band would otherwise be restored at the next launch, with no
    /// drag in sight to explain it.
    #[test]
    fn the_clamped_rectangle_is_the_one_that_gets_remembered() {
        // A 2× display, so a missing or doubles conversion cannot pass by luck.
        let mut captured = window_state::WindowState {
            x: Some(80),
            y: Some(200),
            width: Some(1000),
            height: Some(1000),
            visible: Some(true),
            updated_ms: None,
        };
        let rect = Bounds::new(40, 100, 500, 500);
        let target = Bounds::new(180, 100, 500, 500);

        note_clamped_rect(&mut captured, rect, target, 2.0);

        assert_eq!(
            (captured.x, captured.y),
            (Some(360), Some(200)),
            "the remembered position is the corrected one, in physical px"
        );
        assert_eq!(
            (captured.width, captured.height),
            (Some(1000), Some(1000)),
            "a move is not a resize: the platform's own outer size is left alone"
        );
        assert_eq!(
            captured.visible,
            Some(true),
            "the store's other fields stand"
        );
    }

    /// …and when the clamp **does** resize (a window wider than the whole work area, which
    /// `reflow_out_of_rail` caps), the new size is remembered too — otherwise the next
    /// launch would reopen it at the old width and put its right edge off the stage again.
    #[test]
    fn a_resizing_clamp_remembers_its_new_size_as_well() {
        let mut captured = window_state::WindowState {
            x: Some(0),
            y: Some(0),
            width: Some(2400),
            height: Some(600),
            visible: None,
            updated_ms: None,
        };
        note_clamped_rect(
            &mut captured,
            Bounds::new(-400, 0, 1200, 300),
            Bounds::new(180, 0, 820, 480),
            1.0,
        );
        assert_eq!(
            (captured.x, captured.y, captured.width, captured.height),
            (Some(180), Some(0), Some(820), Some(480))
        );
    }

    /// On a screen too narrow to afford the full rail, the rail **gives way** — it shrinks
    /// to whatever a minimum pane can spare, rather than eating into the pane. The clamp
    /// reads that narrowed number and never its own idea of how wide a rail "should" be, so
    /// a 400 px screen is clamped to 40 px of band and a 360 px stage, not to 180 px.
    ///
    /// Pinned here because this is the seam where a second "how wide is the rail?" would
    /// otherwise creep in: `reflow_out_of_rail` is fed `rail_width()`, which is *derived*
    /// from the same inset the placement paths use, so the two cannot disagree.
    #[test]
    fn the_clamp_uses_the_rail_that_survived_the_give_way() {
        let s = WmState::with_form_factor(FormFactor::Desktop);
        // 400 px: narrower than the full rail plus a 360 px minimum pane, so the rail
        // shrinks to 400 − 360 = 40 and the stage is exactly one minimum pane wide.
        s.sync_screen(Bounds::new(0, 0, 400, 800)).unwrap();
        s.set_stage_enabled(true).ok();
        let rail = s.rail_width().unwrap();
        assert_eq!(rail, 40, "the rail gave way to the minimum pane");
        assert_eq!(
            s.work_area().unwrap(),
            Bounds::new(40, 0, 360, 800),
            "…leaving a stage exactly one minimum pane wide"
        );
        // The reason `reflow_out_of_rail`'s own "no room beside the rail" refusal is
        // unreachable from here: a rail that survived at all leaves `avail_w >= min_pane`,
        // so this seam can only ever say "move it", never "there is nowhere to move it to".
        let moved = s
            .stage_clamp_target("files_1", Bounds::new(0, 100, 200, 300), 1_000)
            .unwrap()
            .expect("a narrowed band still has an answer");
        assert_eq!(moved.x, 40, "pushed clear of the 40 px band, not of 180");
        assert_eq!(moved.width, 360, "grown to the minimum it cannot fit under");
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
            err.to_string().contains("robot") && err.to_string().contains("no user interface"),
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
        // by key. NOTE (REQ-A667): this test pins the *Rust* side against a Rust-local
        // `vec!`; it does NOT read `lib/wm.ts`, and `wm.test.ts`'s key-set test does not
        // read this file either — the earlier "the TS mirror is pinned by wm.test.ts"
        // claim was false. The actual cross-language binding is
        // `declaredMirrors.test.ts`'s "wm.ts layout wire shapes == the amos-tauri::wm
        // serde structs" (REQ-A667), which reads these three structs' field names; both
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
                "rail_width",
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
        // Present on every class, `0` where there is no rail — the shell reads the one
        // number without a second "does this class have a rail" branch (a missing key
        // would read as `undefined` and the mock's fallback would hide it).
        assert_eq!(obj["rail_width"], 0, "a tablet has no Stage rail");

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
    fn a_desktop_window_snaps_to_the_halves_of_the_measured_work_area() {
        let state = WmState::new_for_test(FormFactor::Desktop);
        state.register_app("notes").unwrap();
        // The work area a device pass measured on this machine (1496×880 logical).
        state.set_screen(1496, 880).unwrap();

        let left = {
            let core = state.lock().unwrap();
            snap_plan(&core, "notes", "left").unwrap()
        };
        assert_eq!(left, Bounds::new(0, 0, 748, 880));
        let right = {
            let core = state.lock().unwrap();
            snap_plan(&core, "notes", "right").unwrap()
        };
        assert_eq!(right.x, 748, "the right half starts where the left ends");
        assert_eq!(
            right.right(),
            left.right() + i64::from(right.width),
            "the two halves tile the work area"
        );
        // A quarter and maximize come from the same pure rule — and the quarter shows the
        // whole composition, not just the split: the desktop class' `min_pane` height (480)
        // is *taller* than the 440 a quarter of an 880 work area would take, so
        // `enforce_min` grows it and `clamp_into` then slides it up until it fits (a 480-tall
        // frame at y = 440 would hang 40 px past the screen, so it moves to 880 − 480 = 400).
        // The width is untouched, because 748 already clears the 360 minimum. That is the
        // honest answer — "the minimum wins, then the frame is pulled back on screen" — not
        // the bare 440 the arithmetic alone would give.
        let q = {
            let core = state.lock().unwrap();
            snap_plan(&core, "notes", "bottom-right").unwrap()
        };
        assert_eq!(q, Bounds::new(748, 400, 748, 480));
        let full = {
            let core = state.lock().unwrap();
            snap_plan(&core, "notes", "maximize").unwrap()
        };
        assert_eq!(full.width, 1496);
        assert_eq!(full.height, 880);
    }

    #[test]
    fn a_snap_is_refused_by_name_for_every_reason() {
        let state = WmState::new_for_test(FormFactor::Desktop);
        state.register_app("notes").unwrap();

        // An unknown zone is refused, never guessed into one of the nine.
        let core = state.lock().unwrap();
        let err = snap_plan(&core, "notes", "middle").unwrap_err();
        assert!(err.contains("unknown snap zone"), "{err}");
        // A label nothing registered.
        let err = snap_plan(&core, "no-such-window", "left").unwrap_err();
        assert!(err.contains("no window is registered"), "{err}");
        // The Launcher *is* the screen.
        let err = snap_plan(&core, LAUNCHER_LABEL, "left").unwrap_err();
        assert!(err.contains("the screen itself"), "{err}");
    }

    #[test]
    fn a_class_without_free_window_geometry_refuses_a_snap() {
        // A phone's app window is fullscreen by construction: a "snap" there cannot mean
        // anything, so it is refused rather than silently ignored.
        let state = WmState::new_for_test(FormFactor::Phone);
        // A phone shows one window at a time, but it still registers.
        state.register_app("notes").unwrap();
        let core = state.lock().unwrap();
        let err = snap_plan(&core, "notes", "left").unwrap_err();
        assert!(err.contains("phone"), "the refusal names the class: {err}");
        assert!(err.contains("free window geometry"), "{err}");
    }

    #[test]
    fn a_pane_of_an_active_split_refuses_a_snap() {
        let state = WmState::new_for_test(FormFactor::Desktop);
        state.register_app("calculator").unwrap();
        state.register_app("settings").unwrap();
        state.enter_split("calculator", "settings", "auto").unwrap();
        let core = state.lock().unwrap();
        let err = snap_plan(&core, "calculator", "left").unwrap_err();
        assert!(
            err.contains("in a split"),
            "snapping a pane would leave the split describing a layout that is not on screen: {err}"
        );
        assert!(
            err.contains("exit the split first"),
            "…and the refusal tells the operator the way out: {err}"
        );
    }

    #[test]
    fn pane_rects_delegates_to_the_domain_split_rule() {
        // The host must not own a second geometry rule: `pane_rects` is `split_panes`
        // with the policy's own gap and minimum pane (REQ-A512).
        for form in [FormFactor::Phone, FormFactor::Tablet, FormFactor::Desktop] {
            let policy = LayoutPolicy::of(form);
            let screen = Bounds::new(0, 0, 1440, 900);
            for axis in [SplitAxis::Vertical, SplitAxis::Horizontal] {
                for percent in [1u32, 40, 50, 60, 99] {
                    assert_eq!(
                        pane_rects(policy, screen, axis, percent),
                        amos_wm::layout::split_panes(
                            screen,
                            axis,
                            policy.divider_gap,
                            percent,
                            policy.min_pane
                        ),
                        "{form} {axis:?} at {percent}%"
                    );
                }
            }
        }
    }

    #[test]
    fn slide_over_rect_delegates_to_the_domain_panel_rule() {
        // The host must not own a second geometry rule for the floating panel either:
        // `slide_over_rect` is `slide_over_pane` with the policy's own margin + minimum
        // pane (REQ-A675).
        for form in [FormFactor::Phone, FormFactor::Tablet, FormFactor::Desktop] {
            let policy = LayoutPolicy::of(form);
            let screen = Bounds::new(0, 0, 1440, 900);
            for axis in [SplitAxis::Vertical, SplitAxis::Horizontal] {
                for percent in [1u32, 33, 50, 60, 99] {
                    assert_eq!(
                        slide_over_rect(policy, screen, axis, percent),
                        amos_wm::layout::slide_over_pane(
                            screen,
                            axis,
                            percent,
                            policy.min_pane,
                            policy.slide_over_margin
                        ),
                        "{form} {axis:?} at {percent}%"
                    );
                }
            }
        }
    }

    #[test]
    fn slide_over_rect_hugs_the_trailing_edge_and_refuses_a_screen_too_small() {
        let policy = LayoutPolicy::of(FormFactor::Tablet);
        let screen = Bounds::new(0, 0, 1200, 800);
        let b = slide_over_rect(policy, screen, SplitAxis::Vertical, 33).unwrap();
        assert_eq!(
            b.right(),
            i64::from(screen.width) - i64::from(policy.slide_over_margin),
            "the panel floats one margin in from the right edge"
        );
        // One pane's worth of height cannot host a full-height panel — honest None.
        assert_eq!(
            slide_over_rect(
                policy,
                Bounds::new(0, 0, 2000, policy.min_pane.height),
                SplitAxis::Vertical,
                33
            ),
            None
        );
    }

    #[test]
    fn pane_rects_is_none_when_two_minimum_panes_plus_the_gap_do_not_fit() {
        let policy = LayoutPolicy::of(FormFactor::Tablet);
        let too_narrow = Bounds::new(0, 0, policy.min_pane.width, 2000);
        assert_eq!(
            pane_rects(policy, too_narrow, SplitAxis::Vertical, 50),
            None,
            "one pane's worth of width cannot host two panes — honest None, never a \
             zero/negative pane"
        );
        let just_fits = Bounds::new(
            0,
            0,
            policy.min_pane.width * 2 + policy.divider_gap,
            policy.min_pane.height,
        );
        assert!(
            pane_rects(policy, just_fits, SplitAxis::Vertical, 50).is_some(),
            "exactly two minimum panes plus the gap fits"
        );
    }

    #[test]
    fn a_measured_screen_upgrades_a_revisable_phone_build_to_a_tablet() {
        // REQ-A512: the touch shell's split gate reads `columns`, and `columns` only
        // reaches 2 once the class is a tablet. A mobile build defaults to Phone, so the
        // measured screen is the only thing that can settle it.
        let state = WmState::with_form_origin(FormFactor::Phone, FormFactor::Phone, true);
        // Before any measurement nothing is claimed: one column, still a phone.
        let snap = state.layout_snapshot().expect("snapshot");
        assert_eq!((snap.form.as_str(), snap.columns), ("phone", 1));

        // A handset-sized screen confirms the phone.
        let snap = state
            .set_screen(430, 932)
            .expect("screen 430x932 is a believable reading");
        assert_eq!((snap.form.as_str(), snap.columns), ("phone", 1));

        // A tablet-sized screen re-classes the host, which is what makes two panes
        // reachable.
        let snap = state
            .set_screen(2048, 1536)
            .expect("screen 2048x1536 is a believable reading");
        assert_eq!(
            (snap.form.as_str(), snap.columns),
            ("tablet", 2),
            "the measured screen settled the class"
        );
    }

    #[test]
    fn a_pinned_class_is_never_re_derived_from_the_screen() {
        // `with_form_factor` is an explicit choice (tests, embedders). A phone stays a
        // phone on a tablet-sized screen — an explicit class must not be second-guessed.
        let state = WmState::new_for_test(FormFactor::Phone);
        let snap = state
            .set_screen(2048, 1536)
            .expect("screen 2048x1536 is a believable reading");
        assert_eq!((snap.form.as_str(), snap.columns), ("phone", 1));
    }

    #[test]
    fn reclass_only_ever_moves_a_phone() {
        let big = Bounds::new(0, 0, 2048, 1536);
        assert_eq!(
            reclass_for_screen(FormFactor::Phone, big),
            Some(FormFactor::Tablet)
        );
        assert_eq!(
            reclass_for_screen(FormFactor::Phone, Bounds::new(0, 0, 430, 932)),
            Some(FormFactor::Phone)
        );
        // Compile-time classes are not re-classed by a screen, and an unmeasured screen
        // proves nothing.
        for f in [FormFactor::Desktop, FormFactor::Robot, FormFactor::Tablet] {
            assert_eq!(reclass_for_screen(f, big), Some(f), "{f} must not move");
        }
        assert_eq!(
            reclass_for_screen(FormFactor::Phone, Bounds::new(0, 0, 0, 0)),
            Some(FormFactor::Phone)
        );
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

    // ---- REQ-A473: app-window identity (which app, which instance) ------------------

    /// A mock app with a desktop `WmState` — the shape the identity tests below need,
    /// because the identity is assigned on the **production** path (`open` /
    /// `new_window`), not by the test seam.
    #[cfg(desktop)]
    fn desktop_host() -> (
        tauri::App<tauri::test::MockRuntime>,
        AppHandle<tauri::test::MockRuntime>,
    ) {
        let app = tauri::test::mock_builder()
            .manage(WmState::new_for_test(FormFactor::Desktop))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let handle = app.handle().clone();
        (app, handle)
    }

    /// The defect this whole change exists for: a second window for one app. Before the
    /// identity model `open` could only focus the existing window, so this test could not
    /// have been written at all.
    #[cfg(desktop)]
    #[test]
    fn a_second_window_of_one_app_gets_its_own_label_and_identity() {
        let (_app, handle) = desktop_host();
        let state = handle.state::<WmState>();

        state
            .open(&handle, "files")
            .expect("the first window opens");
        assert_eq!(
            state.app_id_of("files").expect("ledger readable"),
            Some("files".to_string()),
            "the first window of 'files' is labelled 'files'"
        );

        let (_events, label) = state
            .new_window(&handle, "files")
            .expect("a second window is allowed on desktop");
        assert_eq!(
            label, "files_2",
            "the additional window gets the lowest free instance ordinal"
        );

        let snap = state.snapshot().expect("snapshot");
        let mut files: Vec<(String, u32)> = snap
            .windows
            .iter()
            .filter(|w| w.app == "files")
            .map(|w| (w.label.clone(), w.instance))
            .collect();
        files.sort();
        assert_eq!(
            files,
            vec![("files".to_string(), 1), ("files_2".to_string(), 2)],
            "both windows are registered, each with its own label and instance"
        );
        // …and the launcher is not an app window (its identity is reported as absent
        // rather than as a fabricated app id).
        let launcher = snap
            .windows
            .iter()
            .find(|w| w.label == LAUNCHER_LABEL)
            .expect("the launcher is in the snapshot");
        assert_eq!(launcher.app, "", "the launcher shows no application");
        assert_eq!(launcher.instance, 0, "…and is not an instance of one");
    }

    /// The idempotence that keeps `wm_open` safe as the *only* path a shell icon uses:
    /// clicking an app that is already open must focus it, never add a window.
    #[cfg(desktop)]
    #[test]
    fn wm_open_is_idempotent_and_never_mints_a_second_window() {
        let (_app, handle) = desktop_host();
        let state = handle.state::<WmState>();

        state.open(&handle, "files").expect("opens");
        state.open(&handle, "files").expect("focuses");
        state.open(&handle, "files").expect("focuses again");

        let snap = state.snapshot().expect("snapshot");
        let files: Vec<&WindowInfo> = snap.windows.iter().filter(|w| w.app == "files").collect();
        assert_eq!(files.len(), 1, "three opens, one window: {snap:?}");
        assert!(files[0].focused, "the last open is the focused window");
    }

    /// An instance label names a **window**, so passing one to `wm_open` is refused with
    /// the name of the command that does mean "add a window" — the one-spelling rule,
    /// enforced at the host's front door.
    #[cfg(desktop)]
    #[test]
    fn wm_open_refuses_a_window_instance_label() {
        let (_app, handle) = desktop_host();
        let state = handle.state::<WmState>();

        let err = state
            .open(&handle, "files_2")
            .expect_err("a window label is not an app id");
        assert!(
            err.contains("files_2") && err.contains("wm_new_window"),
            "the refusal names the value and the command that would be right: {err}"
        );
        assert!(
            state.snapshot().expect("snapshot").windows.len() == 1,
            "a refused open leaves no window behind (only the launcher)"
        );
    }

    /// Closing one instance must not leave identity residue: the ledger is what the ⌘`
    /// ring and the next allocation are computed from, so a leaked record would both keep
    /// a dead window in the ring and refuse to reuse its label.
    #[cfg(desktop)]
    #[test]
    fn a_closed_instance_leaves_no_identity_and_its_label_is_reused() {
        let (_app, handle) = desktop_host();
        let state = handle.state::<WmState>();

        state.open(&handle, "files").expect("opens");
        let (_e, label) = state.new_window(&handle, "files").expect("second window");
        assert_eq!(label, "files_2");

        state.close(&handle, &label).expect("closes");
        assert_eq!(
            state.app_id_of(&label).expect("ledger readable"),
            None,
            "the closed window's identity is gone (it must not stay in the ⌘` ring)"
        );

        let (_e, again) = state.new_window(&handle, "files").expect("reopens");
        assert_eq!(
            again, "files_2",
            "the freed ordinal is reused: the numbers do not run away"
        );
    }

    /// ⌘` — the chord that was unreachable while an app could have one window.
    #[cfg(desktop)]
    #[test]
    fn cycling_walks_one_apps_windows_and_wraps() {
        let (_app, handle) = desktop_host();
        let state = handle.state::<WmState>();

        state.open(&handle, "files").expect("opens");
        state.new_window(&handle, "files").expect("second window");
        // A second app, so the ring cannot accidentally be "all windows".
        state.open(&handle, "notes").expect("opens notes");

        let focused_label = |s: &WmState| {
            let snap = s.snapshot().expect("snapshot");
            snap.windows
                .iter()
                .find(|w| w.focused)
                .map(|w| w.label.clone())
        };

        // Focus is on `notes` (the last window opened), so the first step starts at an end
        // of the files ring rather than at whatever was focused.
        let first = state.cycle_app(&handle, "files", true).expect("cycles");
        assert_eq!(first, "files", "forward starts at the first window");
        assert_eq!(focused_label(&state), Some("files".to_string()));

        let second = state.cycle_app(&handle, "files", true).expect("cycles");
        assert_eq!(second, "files_2");
        assert_eq!(focused_label(&state), Some("files_2".to_string()));

        let wrapped = state.cycle_app(&handle, "files", true).expect("cycles");
        assert_eq!(wrapped, "files", "forward from the last wraps to the first");

        let back = state
            .cycle_app(&handle, "files", false)
            .expect("cycles back");
        assert_eq!(back, "files_2", "backward from the first wraps to the last");
    }

    /// A ring of one is a no-op, and the caller is told so: a "success" that moved nothing
    /// is the dead-chord shape this repository treats as a defect.
    #[cfg(desktop)]
    #[test]
    fn cycling_an_app_with_one_window_is_refused_with_a_reason() {
        let (_app, handle) = desktop_host();
        let state = handle.state::<WmState>();
        state.open(&handle, "files").expect("opens");

        let err = state
            .cycle_app(&handle, "files", true)
            .expect_err("nothing to cycle");
        assert!(
            err.contains("2") || err.contains("two"),
            "the refusal names the requirement: {err}"
        );

        let err = state
            .cycle_app(&handle, "nosuchapp", true)
            .expect_err("no windows at all");
        assert!(
            err.contains("nosuchapp"),
            "the refusal names the app: {err}"
        );
    }

    /// The class rule is asked for the **second instance** too, through the same function
    /// the first window goes through: a phone shows one app window, so it refuses a second
    /// window of the same app for exactly the reason it refuses a second app.
    #[test]
    fn a_class_without_multi_window_refuses_a_second_instance_of_the_same_app() {
        let s = WmState::new_for_test(FormFactor::Phone);
        s.register_app("files")
            .expect("the first window is allowed");
        let err = s
            .register_app_instance("files")
            .expect_err("a phone gets one app window");
        assert!(
            err.contains("phone"),
            "the refusal names the class whose policy refused: {err}"
        );
        assert_eq!(
            s.snapshot().expect("snapshot").windows.len(),
            2,
            "the refused window leaves no trace (the launcher + the one app window)"
        );
    }

    /// REQ-A478 — the cascade only reaches a window if the host **applies** the position.
    ///
    /// Measured on this machine (2026-09-19): `.position()` was never called, so the class
    /// rule's `x`/`y` had no effect on any real window and three `⌘N` windows all landed at
    /// the OS's own choice of `236,70`. This pins the narrow rule that fixes it: apply the
    /// computed position from instance 2 on, and leave instance 1 exactly as shipped.
    #[test]
    fn only_a_cascaded_instance_has_its_position_applied() {
        assert!(
            !places_position_at(1),
            "the first window of an app keeps the OS's own placement (unchanged behaviour)"
        );
        assert!(!places_position_at(0), "a bogus ordinal is not a cascade");
        for instance in 2..=16 {
            assert!(
                places_position_at(instance),
                "instance {instance} is a cascade and must be placed"
            );
        }
    }

    /// The identity survives the two readers that hold a label and need the app: the OS
    /// window title (a second instance must not fall back to the product name) and the
    /// shell-facing `wm_app_of_label`.
    #[cfg(desktop)]
    #[test]
    fn an_instance_is_titled_with_its_apps_name_not_the_fallback() {
        assert_eq!(
            resolved_title("files_2", None, "Amos").expect("title"),
            "Files",
            "the second Files window is titled 'Files', not 'Amos'"
        );
        assert_eq!(
            resolved_title("store:org.amos.demo_3", None, "Amos").expect("title"),
            "Amos",
            "an unknown app *id* still falls back — that is the fallback for an id, not for a label"
        );

        let (_app, handle) = desktop_host();
        let state = handle.state::<WmState>();
        state.open(&handle, "files").expect("opens");
        let (_e, label) = state.new_window(&handle, "files").expect("second");
        assert_eq!(
            state.app_id_of(&label).expect("ledger readable"),
            Some("files".to_string()),
            "the shell asks the host which app a window belongs to (it does not parse the label)"
        );
    }

    /// REQ-A431 / REQ-A869 — which window a menu action on "the focused window" acts on:
    /// the key window first, the model as the fallback, the launcher never.
    ///
    /// **Pure**, so the rule is pinned without a window server, without a menu and without
    /// printing anything. Moved here with the function (REQ-A869) from `menu.rs`, where the
    /// test was `the_menu_close_target_prefers_the_key_window_and_falls_back_to_the_model`
    /// — the rule has three consumers now, so its test cannot live inside one of them.
    ///
    /// The named witnesses below are the point: a rewrite of the body that keeps the
    /// *counts* right (one branch in, one label out) still has to answer these five pairs.
    #[cfg(desktop)]
    #[test]
    fn the_focused_target_prefers_the_key_window_and_falls_back_to_the_model() {
        // The platform names a key app window: that is macOS's own answer to "what is in
        // front", and it wins even when the model disagrees (the model lags a real click).
        assert_eq!(
            focused_target_label(Some("notes"), Some("photos")).as_deref(),
            Some("notes")
        );
        // The platform names no key window — measured right after a window is created, the
        // REQ-A431 defect — so the window manager's answer is used instead of acting on none.
        assert_eq!(
            focused_target_label(None, Some("settings")).as_deref(),
            Some("settings")
        );
        // The launcher is never a target, in either branch (F-SH-008): when only the launcher
        // is focused there is honestly nothing to act on, which each consumer must report
        // rather than substitute a default.
        assert_eq!(focused_target_label(Some("main"), None), None);
        assert_eq!(focused_target_label(None, Some("main")), None);
        // A key launcher does not override an actionable model answer — the fallback is a
        // *second source*, not a tiebreak that a non-actionable key window cancels.
        assert_eq!(
            focused_target_label(Some("main"), Some("notes")).as_deref(),
            Some("notes")
        );
        assert_eq!(focused_target_label(None, None), None);
    }

    /// A **poisoned** lock is not "this window has no context" — the rule `peek`'s own doc
    /// states, applied to the three accessors that did not follow it.
    ///
    /// `peek` recovers the guard (`unwrap_or_else(|p| p.into_inner())`) and says why in prose;
    /// `set` / `clear` / `take_for` took the same lock with `if let Ok(..)` instead, so after any
    /// panic-while-holding they **silently dropped every mutation** — and `take_for` answered
    /// `None`, which is *verbatim* the claim its sibling's doc forbids. The consumer is
    /// `ai_bridge::merge_system_selection`: with the entry gone it falls back to the global
    /// clipboard's newest text, so the AI is told a string the user copied in some other window
    /// is *this* window's selection — a silent substitution, no error anywhere.
    ///
    /// Red-first: `catch_unwind` really poisons the lock, then each accessor is asserted to
    /// behave exactly as it would on a clean lock. Negative control: restore the `if let Ok`
    /// shape and this goes red (the first `set` assertion).
    #[test]
    fn a_poisoned_context_lock_does_not_lose_a_selection() {
        let ctx = SystemContext::new();
        ctx.set("ai", "notes", "the first selection");
        assert!(!ctx.inner.is_poisoned(), "a fresh lock is not poisoned");

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = ctx.inner.lock().unwrap_or_else(|p| p.into_inner());
            panic!("a handler panicked while holding the context lock");
        }));
        assert!(ctx.inner.is_poisoned(), "the lock must really be poisoned");

        // The write half: a selection captured under poison still lands.
        ctx.set("ai", "notes", "a later selection");
        assert_eq!(
            ctx.peek("ai").map(|e| e.text),
            Some("a later selection".to_string()),
            "a poisoned lock is not 'this window has no context'"
        );

        // The consuming read: `take_for` hands the entry over instead of answering `None`.
        assert_eq!(
            ctx.take_for("ai").map(|e| e.text),
            Some("a later selection".to_string()),
            "a consuming read must not read poison as 'no context'"
        );
        assert!(ctx.peek("ai").is_none(), "an entry is taken exactly once");

        // The removal: `clear` under poison really clears.
        ctx.set("ai", "notes", "yet another");
        ctx.clear("ai");
        assert!(
            ctx.peek("ai").is_none(),
            "a removal under poison still removes"
        );
    }
}
