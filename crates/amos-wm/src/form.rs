//! Form-factor / layout-policy domain (pure `std`).
//!
//! AmOS ships to more than one *kind of device*: a handset, a large touch device,
//! a PC-class shell with real windows, and a headless robot board (the daemon is
//! the product there — `docs/no-ui-android.md`, `docs/amos-link.md`). This module
//! answers the two questions the windowing shell must not hard-code:
//!
//!   1. **Which class are we?** — [`FormFactor`], resolved from the class the
//!      build was compiled for plus an optional `AMOS_FORM_FACTOR` hint. Only two
//!      classes are knowable at *compile* time (Tauri's `cfg(desktop)` /
//!      `cfg(mobile)`), because a phone and a tablet are the **same**
//!      `aarch64-linux-android` target: phone-vs-tablet is a **runtime** decision
//!      (measured screen), which is what [`LayoutPolicy::columns_for`] encodes.
//!   2. **What may the shell do here?** — [`LayoutPolicy`]: may more than one app
//!      window be visible at once, may the user freely resize/move windows, how
//!      wide is the split divider, how small may a pane get, and how many content
//!      columns this form factor ever shows.
//!
//! Like [`crate::layout`] / [`crate::split`] this is transport- and
//! platform-agnostic decision logic: the `amos-tauri` host reads the policy and
//! applies it to real `WebviewWindow`s. Every value is `Copy` and static — no
//! screen size, no allocation, no I/O — so the host can hold it in its state and
//! re-derive it at will (Power of 10 #2/#3: static, bounded resources).
//!
//! ```text
//! AMOS_FORM_FACTOR ─┐
//!                   ├─► resolve_hint() ─► FormFactor ─► LayoutPolicy::of()
//! build class ──────┘                        │                │
//!   (cfg(desktop) = desktop, else phone)     │                ├─► columns_for(width)
//!                                            │                └─► split_axis(screen)
//!                                            └─► as_str() ("desktop") ─► UI
//! ```

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::layout::{at_least, Bounds, Size, SplitAxis};

/// The environment variable an operator uses to override the detected class.
///
/// Documented in `docs/multi-window.md`; `scripts/env-doc-scan.mjs` fails if a doc
/// promises a knob that no code reads.
pub const FORM_FACTOR_ENV: &str = "AMOS_FORM_FACTOR";

/// The device class AmOS is running as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FormFactor {
    /// Handset: one fullscreen surface at a time.
    Phone,
    /// Large touch device: still one fullscreen surface, but wide enough for two
    /// content columns (and, once the split UI lands, two panes).
    Tablet,
    /// PC / laptop: several windows the user may freely move and resize.
    Desktop,
    /// Robot / headless: **no UI is shipped at all** (see [`FormFactor::has_ui`]);
    /// the daemon is the product.
    Robot,
}

impl FormFactor {
    /// Every form factor, in a stable order (docs, tests, pickers).
    pub const ALL: [FormFactor; 4] = [
        FormFactor::Phone,
        FormFactor::Tablet,
        FormFactor::Desktop,
        FormFactor::Robot,
    ];

    /// Stable key used on the wire (`LayoutSnapshot.form`) **and** as the accepted
    /// `AMOS_FORM_FACTOR` value. One spelling, three consumers (host state, UI,
    /// operator) — the doc cannot drift from the parser.
    pub const fn as_str(self) -> &'static str {
        match self {
            FormFactor::Phone => "phone",
            FormFactor::Tablet => "tablet",
            FormFactor::Desktop => "desktop",
            FormFactor::Robot => "robot",
        }
    }

    /// Does this class present a user interface at all?
    ///
    /// `Robot` is the headless class (`amos-tauri` is not built for it; the daemon
    /// and `amos-wm` are), so a policy's window numbers are **inert** there. Kept
    /// explicit instead of implied, so a shell can refuse to render.
    pub const fn has_ui(self) -> bool {
        !matches!(self, FormFactor::Robot)
    }

    /// Parse an `AMOS_FORM_FACTOR` value (surrounding whitespace tolerated, case
    /// ignored). An unknown value is **not** guessed — mirroring
    /// `amos_ai::accelerator`'s "unknown → `None`, never a wrong guess" rule.
    pub fn parse(raw: &str) -> Option<Self> {
        let trimmed = raw.trim();
        FormFactor::ALL
            .into_iter()
            .find(|f| f.as_str().eq_ignore_ascii_case(trimmed))
    }
}

impl fmt::Display for FormFactor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a resolved [`FormFactor`] came from — reported (never silent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HintSource {
    /// No hint was given: the class the build was compiled for was used.
    BuildDefault,
    /// `AMOS_FORM_FACTOR` named a form factor and was honoured.
    Env,
}

impl HintSource {
    /// Stable key for logs / status surfaces.
    pub const fn as_str(self) -> &'static str {
        match self {
            HintSource::BuildDefault => "build-default",
            HintSource::Env => "env",
        }
    }
}

/// Resolve the runtime form factor from an optional `AMOS_FORM_FACTOR` hint plus
/// the class the build was compiled for.
///
/// * no hint → the build's class ([`HintSource::BuildDefault`]);
/// * a known name → that form factor ([`HintSource::Env`]);
/// * anything else (typo, empty string, a value from another project) → **`Err`**
///   carrying the raw value.
///
/// The caller decides whether to fall back and **must report it**: this function
/// never guesses, because a silently-ignored knob is worse than a missing one
/// (the rationale `scripts/env-doc-scan.mjs` is built on).
pub fn resolve_hint(
    raw: Option<&str>,
    from_build: FormFactor,
) -> Result<(FormFactor, HintSource), String> {
    match raw {
        None => Ok((from_build, HintSource::BuildDefault)),
        Some(value) => match FormFactor::parse(value) {
            Some(form) => Ok((form, HintSource::Env)),
            None => Err(format!(
                "{FORM_FACTOR_ENV}={value:?} is not a known form factor \
                 (phone|tablet|desktop|robot); ignoring it"
            )),
        },
    }
}

/// Why a class refused one more app window ([`LayoutPolicy::check_app_window`]).
///
/// A refusal is data, not a string: the host turns it into the operator-visible
/// sentence (`Display`), and a caller that needs to *decide* can match on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppWindowRefusal {
    /// The class that refused.
    pub form: FormFactor,
    /// How many app windows this host already had when it was asked.
    pub open: usize,
}

impl fmt::Display for AppWindowRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "form factor '{}' does not allow multiple app windows \
             (multi_window=false); {} app window(s) already open",
            self.form, self.open
        )
    }
}

/// What the host should do with the **shell window** at boot (see
/// [`LayoutPolicy::shell_fit`]).
///
/// The rule is deliberately narrow: the handset default is a hard-coded *config* value
/// that nobody chose on this device, so replacing it is not a fight with the user — any
/// other size is (the user or the OS picked it) and is left alone. Headless classes
/// never touch geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFit {
    /// Nothing to do: this size is somebody's choice, or this class *is* the handset.
    Leave,
    /// Give the shell this exact size (the class's `initial_window`).
    Resize(Size),
    /// Let the shell fill the desktop's usable area. **The platform decides that area**
    /// (menu bar, Dock, display notches) — which is exactly why this is "maximize" and
    /// not a size this crate would have to guess. A PC shell belongs *in* the desktop
    /// it runs on instead of sitting in a fixed 1024×720 slab (measured: that slab
    /// overhung a 1496×967 desktop's right edge and covered half of it — REQ-A233).
    Maximize,
}

/// Cap one edge to what `available` can actually show.
///
/// `available` is raised to 1 first: a not-yet-measured screen (0×0 — see
/// `columns_for(0) == 1`) must not produce a zero-size window, and a window can
/// never be wider than the screen it is drawn on.
const fn cap_edge(preferred: u32, available: u32) -> u32 {
    let available = at_least(available, 1);
    if preferred > available {
        available
    } else {
        preferred
    }
}

/// What the windowing shell may do on a given form factor.
///
/// Every field is `Copy` and bounded: this is a *constant per class* — no screen
/// size, no allocation — so the host holds one and re-derives the screen-relative
/// answers ([`LayoutPolicy::columns_for`], [`LayoutPolicy::split_axis`]) whenever
/// the window area changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutPolicy {
    /// The class this policy describes.
    pub form: FormFactor,
    /// May more than one app window be visible at once?
    pub multi_window: bool,
    /// May the user freely move/resize windows (as opposed to always-fullscreen)?
    pub free_resize: bool,
    /// Divider width between two split panes (px).
    pub divider_gap: u32,
    /// Minimum size any split pane must keep.
    pub min_pane: Size,
    /// Largest number of content columns this class ever shows (1..=4).
    pub max_columns: u8,
    /// Size a **new app window** opens at on this class. Was a hard-coded
    /// `480×820` phone slab in the host adapter, which made every app open at
    /// handset geometry even on a PC (`crates/amos-tauri/src/wm.rs`).
    pub initial_window: Size,
}

impl LayoutPolicy {
    /// The policy for `form`. Deterministic, side-effect free, `const`.
    ///
    /// `Phone` and `Desktop` deliberately keep the values the host used before
    /// this domain existed (gap 8, min 360×480), so introducing the domain
    /// changes **no** behaviour on either compile target; `Tablet` widens the
    /// divider and relaxes the pane minimum, `Desktop` adds free resize and
    /// multi-window.
    pub const fn of(form: FormFactor) -> Self {
        match form {
            FormFactor::Phone => Self {
                form,
                multi_window: false,
                free_resize: false,
                divider_gap: 8,
                min_pane: Size::new(360, 480),
                max_columns: 1,
                // Unchanged from the host's previous hard-coded value.
                initial_window: Size::new(480, 820),
            },
            FormFactor::Tablet => Self {
                form,
                multi_window: true,
                free_resize: false,
                divider_gap: 12,
                min_pane: Size::new(320, 480),
                max_columns: 2,
                initial_window: Size::new(900, 1200),
            },
            FormFactor::Desktop => Self {
                form,
                multi_window: true,
                free_resize: true,
                divider_gap: 8,
                min_pane: Size::new(360, 480),
                max_columns: 4,
                initial_window: Size::new(1024, 720),
            },
            // Headless: `has_ui() == false`, so these window numbers are never
            // used. They are kept inside the same valid ranges as every other
            // class (pane ≥ 1×1, columns 1..=4) so no downstream arithmetic can
            // build a zero-sized pane even if a caller ignores `has_ui`.
            FormFactor::Robot => Self {
                form,
                multi_window: false,
                free_resize: false,
                divider_gap: 8,
                min_pane: Size::new(1, 1),
                max_columns: 1,
                initial_window: Size::new(1, 1),
            },
        }
    }

    /// How many content columns a screen `screen_width` px wide supports — always
    /// `1..=max_columns`.
    ///
    /// This is the **runtime** phone-vs-tablet decision (the two share one
    /// compiled target), and it is integer-only with no lower bound assumption:
    /// width 0 (a window that has not been measured yet) yields one column.
    pub const fn columns_for(self, screen_width: u32) -> u8 {
        let by_width: u8 = if screen_width >= 1280 {
            4
        } else if screen_width >= 900 {
            3
        } else if screen_width >= 600 {
            2
        } else {
            1
        };
        if by_width < self.max_columns {
            by_width
        } else {
            self.max_columns
        }
    }

    /// The split orientation matching a screen's aspect: side-by-side once the
    /// screen is at least as wide as it is tall (more horizontal room), otherwise
    /// stacked. Ties go to [`SplitAxis::Vertical`] so the answer is deterministic
    /// for every input, including 0×0.
    pub const fn split_axis(self, screen: Size) -> SplitAxis {
        if screen.width >= screen.height {
            SplitAxis::Vertical
        } else {
            SplitAxis::Horizontal
        }
    }

    /// May this class host **one more app window**, given `open_app_windows` already
    /// open ones?
    ///
    /// `multi_window == false` means *one app window at a time* — a handset is a
    /// single fullscreen surface, and a headless board has no screen at all — so a
    /// **second** app window is refused. The refusal carries the class and the count
    /// instead of a bare "no", and it is a `Result` (not a bool) so the host cannot
    /// forget to say why.
    ///
    /// This is the **one** place the rule lives: both the host's register path and
    /// its Tauri window-creation path ask this, and the answer is whatever the
    /// caller already counted — no second counting rule to drift.
    pub const fn check_app_window(self, open_app_windows: usize) -> Result<(), AppWindowRefusal> {
        if self.multi_window || open_app_windows == 0 {
            Ok(())
        } else {
            Err(AppWindowRefusal {
                form: self.form,
                open: open_app_windows,
            })
        }
    }

    /// Fit a window whose preferred size is `preferred` onto `screen`.
    ///
    /// One rule used by **both** "where does a new window open"
    /// ([`LayoutPolicy::initial_window_in`]) and "where must an existing window be
    /// pulled back to" (the host's re-clamp): if the two disagreed, a window could be
    /// created at a size the re-clamp would immediately refuse.
    ///
    /// Authority order: `preferred` → `min_pane` (never below the class minimum) →
    /// `screen` (never larger than the surface it is drawn on; the screen wins over
    /// `min_pane` because it is a physical fact) → fully inside the screen.
    pub const fn fit_window(self, preferred: Size, screen: Bounds) -> Bounds {
        let grown = Bounds::new(0, 0, preferred.width, preferred.height).enforce_min(self.min_pane);
        let capped = Bounds::new(
            grown.x,
            grown.y,
            cap_edge(grown.width, screen.width),
            cap_edge(grown.height, screen.height),
        );
        capped.clamp_into(screen)
    }

    /// Where a **new app window** opens on `screen`.
    ///
    /// The class's `initial_window` is only a *preference*: it is grown to `min_pane`
    /// and capped by the screen ([`LayoutPolicy::fit_window`]). A window larger than
    /// the screen cannot be shown at all, and the user would otherwise see
    /// `initial_window`'s 1024x720 slab hanging off a small desktop.
    pub const fn initial_window_in(self, screen: Bounds) -> Bounds {
        self.fit_window(self.initial_window, screen)
    }

    /// What to do with the shell window `current` (logical px) when the config declares
    /// it as `handset_default` — see [`ShellFit`] for the rule and why it is narrow.
    pub const fn shell_fit(self, current: Size, handset_default: Size) -> ShellFit {
        if !self.form.has_ui() {
            return ShellFit::Leave;
        }
        if current.width != handset_default.width || current.height != handset_default.height {
            return ShellFit::Leave; // somebody already chose this size — never fought
        }
        match self.form {
            // A phone *is* the handset default: nothing to change.
            FormFactor::Phone => ShellFit::Leave,
            // A tablet asks for its own portrait size.
            FormFactor::Tablet => ShellFit::Resize(self.initial_window),
            // A PC shell belongs *in* the desktop, edge to edge (REQ-A233).
            FormFactor::Desktop => ShellFit::Maximize,
            // Headless (already excluded by `has_ui`, kept explicit for exhaustiveness).
            FormFactor::Robot => ShellFit::Leave,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `use super::*` does not re-export the module's own imports, so the two
    // layout types are named explicitly here.
    use crate::layout::{Size, SplitAxis};

    #[test]
    fn wire_keys_are_stable_and_every_class_parses_back() {
        assert_eq!(FormFactor::Phone.as_str(), "phone");
        assert_eq!(FormFactor::Tablet.as_str(), "tablet");
        assert_eq!(FormFactor::Desktop.as_str(), "desktop");
        assert_eq!(FormFactor::Robot.as_str(), "robot");
        assert_eq!(FormFactor::ALL.len(), 4, "no class may be missing from ALL");
        for f in FormFactor::ALL {
            assert_eq!(
                FormFactor::parse(f.as_str()),
                Some(f),
                "{f} must parse back"
            );
            assert_eq!(f.to_string(), f.as_str(), "Display and the wire key agree");
        }
    }

    #[test]
    fn parse_tolerates_case_and_space_but_never_guesses() {
        assert_eq!(FormFactor::parse("  DESKTOP "), Some(FormFactor::Desktop));
        assert_eq!(FormFactor::parse("Tablet"), Some(FormFactor::Tablet));
        // Values we do not recognise must read as "unknown", not as a near miss.
        for bad in ["", " ", "pc", "handset", "desktops", "phone2", "undefined"] {
            assert_eq!(FormFactor::parse(bad), None, "{bad:?} must not be guessed");
        }
    }

    #[test]
    fn resolve_hint_reports_where_the_class_came_from() {
        assert_eq!(
            resolve_hint(None, FormFactor::Phone),
            Ok((FormFactor::Phone, HintSource::BuildDefault)),
            "no hint = the build's own class"
        );
        assert_eq!(
            resolve_hint(Some("tablet"), FormFactor::Phone),
            Ok((FormFactor::Tablet, HintSource::Env))
        );
        // An explicit hint wins even over the class the build was compiled for.
        assert_eq!(
            resolve_hint(Some("robot"), FormFactor::Desktop),
            Ok((FormFactor::Robot, HintSource::Env))
        );
    }

    #[test]
    fn resolve_hint_refuses_an_unknown_value_and_names_it() {
        let err = resolve_hint(Some("laptop"), FormFactor::Tablet).unwrap_err();
        assert!(err.contains("AMOS_FORM_FACTOR"), "{err}");
        assert!(
            err.contains("laptop"),
            "the rejected value is quoted: {err}"
        );
        assert!(err.contains("phone|tablet|desktop|robot"), "{err}");
        // An empty variable is an unusable *value*, not "no hint at all".
        assert!(resolve_hint(Some(""), FormFactor::Phone).is_err());
        assert_eq!(HintSource::BuildDefault.as_str(), "build-default");
        assert_eq!(HintSource::Env.as_str(), "env");
    }

    #[test]
    fn only_robot_is_headless() {
        assert!(!FormFactor::Robot.has_ui(), "the robot class ships no UI");
        for f in [FormFactor::Phone, FormFactor::Tablet, FormFactor::Desktop] {
            assert!(f.has_ui(), "{f} presents a UI");
        }
    }

    #[test]
    fn phone_and_desktop_policies_keep_the_values_the_host_used_before() {
        // Regression pin: `amos-tauri/src/wm.rs` used `SPLIT_GAP = 8` and
        // `SPLIT_MIN = 360×480` as constants. Introducing the policy domain must
        // not move a single pixel on either compile target (Android = phone,
        // desktop host = desktop).
        for f in [FormFactor::Phone, FormFactor::Desktop] {
            let p = LayoutPolicy::of(f);
            assert_eq!(p.divider_gap, 8, "{f} keeps the legacy divider");
            assert_eq!(
                p.min_pane,
                Size::new(360, 480),
                "{f} keeps the legacy pane minimum"
            );
        }
        assert!(!LayoutPolicy::of(FormFactor::Phone).multi_window);
        assert!(!LayoutPolicy::of(FormFactor::Phone).free_resize);
        assert!(LayoutPolicy::of(FormFactor::Desktop).multi_window);
        assert!(LayoutPolicy::of(FormFactor::Desktop).free_resize);
    }

    #[test]
    fn tablet_may_show_two_windows_but_not_free_resize() {
        let t = LayoutPolicy::of(FormFactor::Tablet);
        assert!(t.multi_window, "two panes are the tablet's whole point");
        assert!(
            !t.free_resize,
            "a touch device has no drag-resize affordance"
        );
        assert_eq!(t.max_columns, 2);
        assert_ne!(t, LayoutPolicy::of(FormFactor::Desktop));
    }

    #[test]
    fn robot_policy_stays_valid_even_though_it_is_inert() {
        let p = LayoutPolicy::of(FormFactor::Robot);
        assert!(!p.multi_window && !p.free_resize);
        assert!(
            p.min_pane.width >= 1 && p.min_pane.height >= 1,
            "never a zero-sized pane"
        );
        assert!((1..=4).contains(&p.max_columns), "columns stay in range");
        assert_eq!(p.columns_for(4000), 1);
    }

    #[test]
    fn columns_for_respects_the_width_bands_and_the_class_ceiling() {
        let t = LayoutPolicy::of(FormFactor::Tablet);
        assert_eq!(t.columns_for(0), 1, "an unmeasured screen gets one column");
        assert_eq!(t.columns_for(599), 1);
        assert_eq!(t.columns_for(600), 2, "the 600px band starts exactly here");
        assert_eq!(t.columns_for(899), 2);
        assert_eq!(
            t.columns_for(900),
            2,
            "3 by width, capped by the tablet ceiling"
        );
        assert_eq!(t.columns_for(u32::MAX), 2);

        let d = LayoutPolicy::of(FormFactor::Desktop);
        assert_eq!(d.columns_for(899), 2);
        assert_eq!(d.columns_for(900), 3);
        assert_eq!(d.columns_for(1279), 3);
        assert_eq!(
            d.columns_for(1280),
            4,
            "the 1280px band starts exactly here"
        );
        assert_eq!(d.columns_for(u32::MAX), 4);

        let p = LayoutPolicy::of(FormFactor::Phone);
        assert_eq!(p.columns_for(0), 1);
        assert_eq!(p.columns_for(4000), 1, "a phone is one column at any width");
    }

    #[test]
    fn columns_are_always_bounded_for_every_class_and_width() {
        for f in FormFactor::ALL {
            let p = LayoutPolicy::of(f);
            for w in [0u32, 1, 599, 600, 899, 900, 1279, 1280, u32::MAX] {
                let c = p.columns_for(w);
                assert!(c >= 1, "{f} @ {w}px must not report zero columns");
                assert!(c <= p.max_columns, "{f} @ {w}px exceeded its own ceiling");
                assert!(c <= 4, "{f} @ {w}px exceeded the documented 4-column max");
            }
        }
    }

    #[test]
    fn split_axis_follows_the_aspect_with_a_deterministic_tie() {
        let p = LayoutPolicy::of(FormFactor::Tablet);
        assert_eq!(
            p.split_axis(Size::new(1920, 1080)),
            SplitAxis::Vertical,
            "landscape sits side by side"
        );
        assert_eq!(
            p.split_axis(Size::new(1080, 1920)),
            SplitAxis::Horizontal,
            "portrait stacks"
        );
        assert_eq!(
            p.split_axis(Size::new(500, 500)),
            SplitAxis::Vertical,
            "a square screen ties to vertical"
        );
        assert_eq!(
            p.split_axis(Size::new(0, 0)),
            SplitAxis::Vertical,
            "a screen nobody has measured yet is still answered"
        );
        assert_eq!(p.split_axis(Size::new(0, 1)), SplitAxis::Horizontal);
    }

    #[test]
    fn only_a_desktop_aligns_with_the_desktop_and_a_tablet_takes_its_own_size() {
        let handset = Size::new(480, 820);
        // The handset itself: nothing to do — an Android shell is byte-identical.
        assert_eq!(
            LayoutPolicy::of(FormFactor::Phone).shell_fit(handset, handset),
            ShellFit::Leave
        );
        // Desktop: the hard-coded config default is replaced by "fill the desktop" — a PC
        // shell belongs *in* the screen it runs on, and the platform owns the usable area
        // (menu bar, Dock) so the host must not guess a size (REQ-A233).
        assert_eq!(
            LayoutPolicy::of(FormFactor::Desktop).shell_fit(handset, handset),
            ShellFit::Maximize
        );
        // Tablet: its own portrait size (a real tablet is that shape).
        assert_eq!(
            LayoutPolicy::of(FormFactor::Tablet).shell_fit(handset, handset),
            ShellFit::Resize(Size::new(900, 1200))
        );
        // Headless never touches geometry, not even at the handset default.
        assert_eq!(
            LayoutPolicy::of(FormFactor::Robot).shell_fit(handset, handset),
            ShellFit::Leave
        );
    }

    #[test]
    fn a_size_somebody_already_chose_is_never_fought() {
        let handset = Size::new(480, 820);
        let desktop = LayoutPolicy::of(FormFactor::Desktop);
        let tablet = LayoutPolicy::of(FormFactor::Tablet);
        for chosen in [
            Size::new(1280, 800), // the user resized the shell
            Size::new(1496, 967), // already desktop-sized (maximized a moment ago)
            Size::new(1024, 720), // the old class size: still somebody's choice now
            Size::new(480, 900),  // only one edge moved
            Size::new(481, 820),
            Size::new(0, 0), // an unmeasured window is not "the default" either
        ] {
            assert_eq!(
                desktop.shell_fit(chosen, handset),
                ShellFit::Leave,
                "desktop: {chosen:?} must be left alone"
            );
            assert_eq!(
                tablet.shell_fit(chosen, handset),
                ShellFit::Leave,
                "tablet: {chosen:?} must be left alone"
            );
        }
        // The exact handset default is the one and only thing that gets replaced.
        assert_eq!(desktop.shell_fit(handset, handset), ShellFit::Maximize);
        assert_eq!(
            tablet.shell_fit(handset, handset),
            ShellFit::Resize(Size::new(900, 1200))
        );
    }

    #[test]
    fn the_policy_is_a_pure_function_of_the_class() {
        for f in FormFactor::ALL {
            assert_eq!(LayoutPolicy::of(f).form, f);
            assert_eq!(
                LayoutPolicy::of(f),
                LayoutPolicy::of(f),
                "{f} must be stable"
            );
        }
    }

    #[test]
    fn a_new_window_opens_at_handset_geometry_only_on_a_phone() {
        // Regression pin: the host adapter used to hard-code `.inner_size(480, 820)`
        // for every app window on every class.
        assert_eq!(
            LayoutPolicy::of(FormFactor::Phone).initial_window,
            Size::new(480, 820)
        );
        // The other classes must not open a handset-*sized* slab on a big screen.
        // Area is the honest measure here: a desktop window is landscape, so its
        // height is legitimately below the phone's (my first assertion demanded
        // both edges exceed the phone's and failed on the correct implementation).
        let phone_area = LayoutPolicy::of(FormFactor::Phone).initial_window.area();
        for f in [FormFactor::Tablet, FormFactor::Desktop] {
            let w = LayoutPolicy::of(f).initial_window;
            assert!(
                w.area() > phone_area,
                "{f} opens at {w:?} ({} px²), no roomier than the phone slab ({phone_area} px²)",
                w.area()
            );
        }
        let d = LayoutPolicy::of(FormFactor::Desktop);
        assert!(
            d.initial_window.width > d.initial_window.height,
            "a desktop window opens landscape"
        );
        assert!(
            LayoutPolicy::of(FormFactor::Tablet).initial_window.height
                > LayoutPolicy::of(FormFactor::Tablet).initial_window.width,
            "a tablet window opens portrait"
        );
    }
    /// The multi-window gate: `multi_window == false` means **one app window at a
    /// time**, and the refusal says which class and how many were already open.
    #[test]
    fn a_class_without_multi_window_refuses_the_second_app_window() {
        let phone = LayoutPolicy::of(FormFactor::Phone);
        assert_eq!(
            phone.check_app_window(0),
            Ok(()),
            "the first window is fine"
        );

        let refusal = phone
            .check_app_window(1)
            .expect_err("the second is refused");
        assert_eq!(refusal.form, FormFactor::Phone);
        assert_eq!(refusal.open, 1);
        let text = refusal.to_string();
        assert!(text.contains("phone"), "{text}");
        assert!(text.contains("multi_window=false"), "{text}");
        assert!(text.contains("1 app window"), "{text}");

        // A headless class carries the same flag, so it is the same answer.
        assert!(LayoutPolicy::of(FormFactor::Robot)
            .check_app_window(1)
            .is_err());

        // Classes that *do* allow several never refuse on the count.
        for f in [FormFactor::Tablet, FormFactor::Desktop] {
            let p = LayoutPolicy::of(f);
            assert!(p.multi_window, "{f} is a multi-window class");
            for open in [0, 1, 7, 1_000] {
                assert_eq!(p.check_app_window(open), Ok(()), "{f} with {open} open");
            }
        }
    }

    /// A new window opens at the class's size, never below its own minimum pane,
    /// and never hanging off the screen — in that order of authority.
    #[test]
    fn a_new_window_opens_on_screen_and_at_least_min_pane() {
        let desktop = LayoutPolicy::of(FormFactor::Desktop);
        let big = Bounds::new(0, 0, 1920, 1080);
        let opened = desktop.initial_window_in(big);
        assert_eq!((opened.x, opened.y), (0, 0));
        assert_eq!(
            (opened.width, opened.height),
            (desktop.initial_window.width, desktop.initial_window.height),
            "on a screen that fits it, the class preference is honoured"
        );

        // A small screen caps it: a 1024×720 slab must not hang off a 800×600 area.
        let small = Bounds::new(0, 0, 800, 600);
        let capped = desktop.initial_window_in(small);
        assert_eq!((capped.width, capped.height), (800, 600));
        assert!(capped.right() <= small.right() && capped.bottom() <= small.bottom());

        // A screen *smaller* than `min_pane` wins over the minimum: it is a physical
        // fact, `min_pane` is a preference. (Still never zero-sized.)
        let tiny = Bounds::new(0, 0, 100, 40);
        let squeezed = desktop.initial_window_in(tiny);
        assert_eq!((squeezed.width, squeezed.height), (100, 40));
        assert!(squeezed.width >= 1 && squeezed.height >= 1);

        // A screen that has not been measured (0×0) yields a 1×1 window, not a
        // zero-size one — the same "unmeasured ⇒ most conservative" rule
        // `columns_for(0) == 1` follows.
        let unmeasured =
            LayoutPolicy::of(FormFactor::Phone).initial_window_in(Bounds::new(0, 0, 0, 0));
        assert_eq!((unmeasured.width, unmeasured.height), (1, 1));

        // An offset screen slides the window inside it (`clamp_into`)…
        let offset = Bounds::new(100, 50, 400, 300);
        let placed = LayoutPolicy::of(FormFactor::Tablet).initial_window_in(offset);
        assert!(placed.x >= offset.x && placed.y >= offset.y, "{placed:?}");
        assert!(placed.right() <= offset.right() && placed.bottom() <= offset.bottom());

        // …and `min_pane` still grows a *class* preference that is too small: the
        // phone's 480×820 on a wide screen keeps its class minimum.
        let phone = LayoutPolicy::of(FormFactor::Phone);
        let grown = phone.initial_window_in(Bounds::new(0, 0, 4000, 4000));
        assert!(grown.width >= phone.min_pane.width && grown.height >= phone.min_pane.height);
    }

    #[test]
    fn every_class_can_hold_one_minimum_pane_and_one_column() {
        // A policy must never be self-contradictory: an initial window smaller
        // than `min_pane` could not host the single pane its class allows.
        for f in FormFactor::ALL {
            let p = LayoutPolicy::of(f);
            assert!(
                p.initial_window.width >= p.min_pane.width
                    && p.initial_window.height >= p.min_pane.height,
                "{f} opens at {:?}, below its own minimum pane {:?}",
                p.initial_window,
                p.min_pane
            );
            assert!(p.min_pane.width >= 1 && p.min_pane.height >= 1);
            assert!((1..=4).contains(&p.max_columns));
        }
    }
}
