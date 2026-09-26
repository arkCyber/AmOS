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

/// The **short edge** (logical px) at which a mobile build that was given no
/// operator hint is treated as a tablet.
///
/// Phone and tablet are the same `aarch64-linux-android` target, so the class is a
/// runtime decision ([`LayoutPolicy::columns_for`]); this is the threshold that
/// decision uses to *name* the class. It matches the 600 px band `columns_for`
/// already widens at, so a class that measures as a tablet here is exactly one that
/// gets two content columns there — the two rules cannot disagree.
///
/// The short edge is used, not the width: a large handset in landscape can be as
/// wide as a small tablet, but its short edge stays a handset's, and a tablet keeps a
/// tablet's short edge in either orientation. Typical short edges: handset ≈ 390–430,
/// tablet ≈ 800–1024.
pub const TABLET_MIN_SHORT_EDGE: u32 = 600;

/// How far each **later** window of one application is offset from the previous one (px).
///
/// macOS's own cascade step is about this much, and it is deliberately small: it must make
/// "there is another window behind this one" visible without moving a window so far that its
/// content lands somewhere else. See [`LayoutPolicy::initial_window_for`].
pub const CASCADE_STEP: i32 = 24;

/// Width of the **Stage Manager rail** — the persistent strip that parks windows
/// off-stage (`docs/stage-manager.md`).
///
/// Only a class whose windows the user may freely move has a stage at all, so this
/// is a number for [`FormFactor::Desktop`] and zero everywhere else — see
/// [`LayoutPolicy::stage_rail_width`], which is the only reader. 180 px is what
/// macOS's own rail settles at for a one-line window title.
pub const STAGE_RAIL_WIDTH: u32 = 180;

/// Most windows [`LayoutPolicy::arrange_stage`] will lay out in one pass.
///
/// The arrange grid is a bounded allocation (Power of 10 #3): past this the function
/// **refuses** rather than building an Nth-pane sliver. A stage with more windows
/// than this needs some of them parked, and the caller can say so with the count.
pub const MAX_STAGE_WINDOWS: usize = 16;

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
    /// No hint was given and the **measured** screen decided the class
    /// ([`FormFactor::resolve_runtime`]). Reported so a tablet that named itself is
    /// never confused with one an operator chose.
    Measured,
}

impl HintSource {
    /// Stable key for logs / status surfaces.
    pub const fn as_str(self) -> &'static str {
        match self {
            HintSource::BuildDefault => "build-default",
            HintSource::Env => "env",
            HintSource::Measured => "measured",
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

/// Resolve the runtime form factor from an optional `AMOS_FORM_FACTOR` hint, the
/// class the build was compiled for, **and the measured screen**.
///
/// This is [`resolve_hint`] plus the one thing only a running device knows: a build
/// compiled for `Phone` may in fact be a tablet, because the two share one Android
/// target. Rule order:
///
/// * a hint that parses → that form factor, [`HintSource::Env`] (an operator's choice
///   is never second-guessed by a measurement);
/// * a hint that does **not** parse → `Err`, exactly as [`resolve_hint`] (the caller
///   falls back and **must report it** — never a silent guess);
/// * no hint → the build's class, **except** a `Phone` build whose measured screen has
///   a short edge of at least [`TABLET_MIN_SHORT_EDGE`]: that is a tablet, reported as
///   [`HintSource::Measured`].
///
/// A screen that has not been measured yet (a zero edge — see `columns_for(0)`) proves
/// nothing, so the build's own class is kept and the source stays
/// [`HintSource::BuildDefault`]; the caller re-resolves once the real size arrives.
/// Only `Phone` is ever upgraded: `Desktop` and `Robot` are compile-time classes and
/// `Tablet` is already a tablet.
pub fn resolve_runtime(
    raw: Option<&str>,
    from_build: FormFactor,
    screen: Size,
) -> Result<(FormFactor, HintSource), String> {
    let (form, source) = resolve_hint(raw, from_build)?;
    // A measurement never overrides an operator's hint, nor a class that is not the
    // ambiguous one.
    if source == HintSource::Env || form != FormFactor::Phone {
        return Ok((form, source));
    }
    // An unmeasured screen is not evidence: keep the build's answer.
    if screen.width == 0 || screen.height == 0 {
        return Ok((form, source));
    }
    let short_edge = if screen.width < screen.height {
        screen.width
    } else {
        screen.height
    };
    if short_edge >= TABLET_MIN_SHORT_EDGE {
        Ok((FormFactor::Tablet, HintSource::Measured))
    } else {
        Ok((FormFactor::Phone, HintSource::Measured))
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

/// Narrow a 64-bit coordinate to a `Bounds` field without ever wrapping.
///
/// The arrange grid adds offsets bounded by the stage's own extent, so on any real
/// screen this is the identity; it exists so an absurd stage handed in by a caller
/// cannot turn a right-hand offset into a **negative** position (Power of 10 #2 —
/// bounded arithmetic, no silent wrap).
const fn to_i32(v: i64) -> i32 {
    if v > i32::MAX as i64 {
        i32::MAX
    } else if v < i32::MIN as i64 {
        i32::MIN
    } else {
        v as i32
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
    /// Inset from every screen edge for a floating **Slide Over** panel (px). A
    /// floating panel is a window *over* the working surface, so it never touches an
    /// edge: this is the gap that makes it read as floating rather than as a third
    /// pane. Unused on classes that never offer Slide Over (`multi_window == false`).
    pub slide_over_margin: u32,
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
                slide_over_margin: 8,
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
                slide_over_margin: 12,
                max_columns: 2,
                initial_window: Size::new(900, 1200),
            },
            FormFactor::Desktop => Self {
                form,
                multi_window: true,
                free_resize: true,
                divider_gap: 8,
                min_pane: Size::new(360, 480),
                slide_over_margin: 8,
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
                slide_over_margin: 0,
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

    /// The window the **`instance`-th** window of an application opens at, on `screen`.
    ///
    /// REQ-A478 (measured on this machine 2026-09-19): once an application can own several
    /// windows, opening each one at [`LayoutPolicy::initial_window_in`] puts every window
    /// **exactly on top of the previous one** — three `wm_new_window` calls produced three
    /// windows at the same `236,70 1024×720` (the AX window list, byte-for-byte identical
    /// geometry), so the user cannot see that anything happened and the windows are
    /// indistinguishable to the mouse. macOS cascades; this is that cascade, as the class's
    /// own rule:
    ///
    /// * `instance` 1 is exactly [`LayoutPolicy::initial_window_in`] — the behaviour that
    ///   shipped, **unchanged**, which is what keeps this additive;
    /// * each later instance steps one [`CASCADE_STEP`] right and down;
    /// * the result goes through `enforce_min` then `clamp_into(screen)`, so a cascade can
    ///   never push a window off the screen (the screen is a physical fact and wins);
    /// * the step is `saturating_mul`ed, so an absurd ordinal cannot overflow into a
    ///   negative position (Power of 10 rule 2: bounded).
    ///
    /// Honest boundary: this is the **initial** placement of a window the host is creating
    /// right now. A window the user has moved is never re-placed, and nothing here is
    /// persisted — the host deliberately keeps no geometry ledger (see
    /// `WmState::reclamp_windows`).
    pub fn initial_window_for(self, screen: Bounds, instance: u32) -> Bounds {
        let base = self.initial_window_in(screen);
        self.cascade_from(
            (base.x, base.y),
            Size::new(base.width, base.height),
            screen,
            instance,
        )
    }

    /// The rect the `instance`-th window of an application should open at when the app's
    /// first window sits at `anchor` (logical px), with `size` for the new window.
    ///
    /// Split out of [`LayoutPolicy::initial_window_for`] because the **anchor is a fact only
    /// the platform has**: `fit_window` builds its rect at `(0, 0)` and clamps, so the
    /// domain's own base position is the screen's origin — measured on this machine
    /// 2026-09-19, the first Files window that macOS placed itself sat at `236,70` while the
    /// domain's answer was the corner, and cascading from the corner put instance 2 at
    /// `24,24`: a second window in the corner is not a cascade from the first one.
    ///
    /// Rules (each of them is pinned by the tests below):
    /// * `instance <= 1` ⇒ exactly `Bounds::new(anchor, size)` clamped: the first window is
    ///   the anchor itself;
    /// * each later instance steps one [`CASCADE_STEP`] right and down from the anchor;
    /// * the result is `enforce_min`ed and `clamp_into(screen)`ed, so a cascade can never
    ///   push a window off the screen;
    /// * the step is `saturating_mul`ed ⇒ an absurd ordinal cannot overflow (Power of 10 #2).
    pub fn cascade_from(
        self,
        anchor: (i32, i32),
        size: Size,
        screen: Bounds,
        instance: u32,
    ) -> Bounds {
        let base = Bounds::new(anchor.0, anchor.1, size.width, size.height);
        if instance <= 1 {
            return base.enforce_min(self.min_pane).clamp_into(screen);
        }
        let steps = i32::try_from(instance.saturating_sub(1)).unwrap_or(i32::MAX);
        let shift = steps.saturating_mul(CASCADE_STEP);
        let moved = Bounds::new(
            anchor.0.saturating_add(shift),
            anchor.1.saturating_add(shift),
            base.width,
            base.height,
        );
        moved.enforce_min(self.min_pane).clamp_into(screen)
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

    /// Width of the persistent Stage Manager rail on this class, or **0** when the
    /// class has no stage.
    ///
    /// A rail is a place to park a window the user may drag back onto the stage, so
    /// the test is whether the class lets the user move windows at all
    /// ([`LayoutPolicy::free_resize`]) — not `multi_window`, which a tablet sets true
    /// for *panes* it lays out itself. Only [`FormFactor::Desktop`] answers non-zero.
    /// Every reader of [`STAGE_RAIL_WIDTH`] goes through here, so a class cannot end
    /// up with half a rail.
    pub const fn stage_rail_width(self) -> u32 {
        match self.form {
            FormFactor::Desktop => STAGE_RAIL_WIDTH,
            FormFactor::Phone | FormFactor::Tablet | FormFactor::Robot => 0,
        }
    }

    /// The **work area** left for app windows once the Stage Manager rail is taken
    /// out of the left edge of `area`.
    ///
    /// The rail **gives way first**: an area too narrow for both a rail and
    /// [`LayoutPolicy::min_pane`] shrinks the rail — down to nothing — rather than
    /// starving the pane. A window narrower than `min_pane` is unusable; a cramped
    /// rail merely looks cramped.
    ///
    /// A class with no rail and an unmeasured area (a zero width) are both a
    /// **no-op**: the input rect comes back untouched, so a caller may apply this on
    /// every placement path unconditionally — `stage_work_area` on a phone is the
    /// identity, exactly as `free_resize = false` makes it inert there.
    pub const fn stage_work_area(self, area: Bounds) -> Bounds {
        let rail = self.stage_rail_width();
        if rail == 0 || area.width == 0 {
            return area;
        }
        let max_rail = area.width.saturating_sub(self.min_pane.width);
        let rail = if rail > max_rail { max_rail } else { rail };
        if rail == 0 {
            return area;
        }
        Bounds::new(
            area.x.saturating_add(to_i32(rail as i64)),
            area.y,
            area.width - rail,
            area.height,
        )
    }

    /// Lay `count` windows out on `stage` in a gap-separated grid that tiles it,
    /// returning one rect per window **in row-major order**.
    ///
    /// The grid starts at `ceil(sqrt(count))` columns — so one window fills the
    /// stage, two sit side by side, three to four are a 2×2 on a tall stage — and
    /// **widens** (fewer rows, more columns) until every cell can hold
    /// [`LayoutPolicy::min_pane`]. That second rule is what makes a wide, short
    /// desktop work: 1260×808 cannot stack two 480-tall panes, so three windows
    /// there are three columns rather than a refusal. A row that is not full
    /// **spreads across the whole width**, so a short row reads as full-width windows
    /// rather than columns with a hole.
    ///
    /// Refusals are `None`, never a sliver and never an overlap — the same honesty
    /// [`crate::layout::split_panes`] applies to a divider:
    ///
    /// * more than [`MAX_STAGE_WINDOWS`] windows — an unbounded allocation, and
    ///   that many windows on one stage is a caller that should be parking some;
    /// * the stage cannot give every cell at least [`LayoutPolicy::min_pane`] once
    ///   the [`LayoutPolicy::divider_gap`] gaps are taken out.
    ///
    /// `count == 0` is `Some(vec![])`: arranging an empty stage is a no-op, not an
    /// error, so "Tidy" on nothing must not report a failure.
    ///
    /// Honest boundary: this is geometry. Nothing here moves a real window — the host
    /// applies the rects and must report what it applied.
    pub fn arrange_stage(self, stage: Bounds, count: usize) -> Option<Vec<Bounds>> {
        if count == 0 {
            return Some(Vec::new());
        }
        if count > MAX_STAGE_WINDOWS {
            return None;
        }
        let n = count as u32;
        let gap = self.divider_gap;
        // Smallest `cols` with `cols² ≥ count`: 1→1, 2→2, 3→2, 4→2, 5→3, 9→3, 10→4, 16→4.
        // Bounded because `count ≤ MAX_STAGE_WINDOWS` (Power of 10 #2).
        let mut cols = 1u32;
        while cols.saturating_mul(cols) < n {
            cols += 1;
        }
        // Widen the grid until every cell can hold a pane. A short stage fails the
        // height test at 2 rows and passes it at 1; a narrow one fails at `count`
        // columns. If no width up to `count` fits, the stage cannot host them all and
        // we refuse — never a sliver.
        let rows = loop {
            if cols > n {
                return None;
            }
            let rows = n.div_ceil(cols);
            let (Some(row_area_h), Some(widest_row_w)) = (
                stage.height.checked_sub(gap.saturating_mul(rows - 1)),
                stage.width.checked_sub(gap.saturating_mul(cols - 1)),
            ) else {
                cols += 1;
                continue;
            };
            // The narrowest cell sits in the widest row (the one with `cols` items);
            // every row shares the height evenly, so one height check covers them all.
            if widest_row_w / cols >= self.min_pane.width
                && row_area_h / rows >= self.min_pane.height
            {
                break rows;
            }
            cols += 1;
        };

        // The gaps come out of the stage before any cell is measured. Both subtractions
        // were proven above, so they cannot fail here.
        let row_area_h = stage.height.checked_sub(gap.saturating_mul(rows - 1))?;

        let base_h = row_area_h / rows;
        let mut out = Vec::with_capacity(count);
        let mut placed = 0u32;
        for row in 0..rows {
            let in_row = {
                let left = n - placed;
                if left > cols {
                    cols
                } else {
                    left
                }
            };
            // Every row but the last is `base_h`; the last takes the remainder so the
            // grid reaches the stage's bottom edge exactly.
            let h = if row == rows - 1 {
                row_area_h - base_h * (rows - 1)
            } else {
                base_h
            };
            let row_area_w = stage.width.checked_sub(gap.saturating_mul(in_row - 1))?;
            let base_w = row_area_w / in_row;
            let y = stage.y as i64 + i64::from(row) * i64::from(base_h.saturating_add(gap));
            for col in 0..in_row {
                let w = if col == in_row - 1 {
                    row_area_w - base_w * (in_row - 1)
                } else {
                    base_w
                };
                let x = stage.x as i64 + i64::from(col) * i64::from(base_w.saturating_add(gap));
                out.push(Bounds::new(to_i32(x), to_i32(y), w, h));
            }
            placed += in_row;
        }
        Some(out)
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
    fn resolve_runtime_upgrades_only_a_phone_whose_short_edge_is_a_tablet() {
        // A handset's short edge (≈390–430) stays a phone — and the source says the
        // measurement, not the build default, decided it.
        for short in [1u32, 390, 430, 599] {
            assert_eq!(
                resolve_runtime(None, FormFactor::Phone, Size::new(short, 2160)),
                Ok((FormFactor::Phone, HintSource::Measured)),
                "short edge {short} is still a handset"
            );
        }
        // At the 600 px band the same build is a tablet, in either orientation.
        assert_eq!(
            resolve_runtime(None, FormFactor::Phone, Size::new(600, 1024)),
            Ok((FormFactor::Tablet, HintSource::Measured)),
            "the 600 px band starts exactly here"
        );
        assert_eq!(
            resolve_runtime(None, FormFactor::Phone, Size::new(1024, 600)),
            Ok((FormFactor::Tablet, HintSource::Measured)),
            "landscape is the same tablet: the short edge is what decides"
        );
        assert_eq!(
            resolve_runtime(None, FormFactor::Phone, Size::new(2048, 1536)),
            Ok((FormFactor::Tablet, HintSource::Measured))
        );
        // The threshold is the one `columns_for` widens at, so a class named a tablet
        // here is exactly one that gets two columns there — no drift.
        assert_eq!(
            TABLET_MIN_SHORT_EDGE, 600,
            "must match the 600 px band in columns_for"
        );
        let as_tablet = LayoutPolicy::of(FormFactor::Tablet);
        assert_eq!(as_tablet.columns_for(TABLET_MIN_SHORT_EDGE), 2);
        assert_eq!(
            LayoutPolicy::of(FormFactor::Phone).columns_for(TABLET_MIN_SHORT_EDGE - 1),
            1,
            "just below the threshold is still one column"
        );
    }

    #[test]
    fn resolve_runtime_never_upgrades_a_measured_phone_off_a_compile_time_class() {
        // Desktop and Robot are compile-time facts; a big screen cannot turn either
        // into a tablet.
        for f in [FormFactor::Desktop, FormFactor::Robot] {
            assert_eq!(
                resolve_runtime(None, f, Size::new(3840, 2160)),
                Ok((f, HintSource::BuildDefault)),
                "{f} must not be re-classed by the screen"
            );
        }
        // A tablet is already a tablet: it is not reported as "measured" for free.
        assert_eq!(
            resolve_runtime(None, FormFactor::Tablet, Size::new(2048, 1536)),
            Ok((FormFactor::Tablet, HintSource::BuildDefault))
        );
    }

    #[test]
    fn resolve_runtime_keeps_the_build_class_until_the_screen_is_measured() {
        // A 0×0 reading is "not measured yet", not "a tiny handset": claiming
        // `Measured` here would be a lie the caller would act on.
        for screen in [Size::new(0, 0), Size::new(1200, 0), Size::new(0, 1200)] {
            assert_eq!(
                resolve_runtime(None, FormFactor::Phone, screen),
                Ok((FormFactor::Phone, HintSource::BuildDefault)),
                "{screen:?} proves nothing"
            );
        }
    }

    #[test]
    fn resolve_runtime_lets_an_operator_hint_win_over_the_measurement() {
        // A deliberately-wrong-but-explicit hint is honoured: the operator owns the
        // class, and forcing a phone on a big screen is a legitimate test setup.
        assert_eq!(
            resolve_runtime(Some("phone"), FormFactor::Phone, Size::new(2048, 1536)),
            Ok((FormFactor::Phone, HintSource::Env)),
            "an explicit phone hint is not overridden by a tablet-sized screen"
        );
        assert_eq!(
            resolve_runtime(Some("tablet"), FormFactor::Phone, Size::new(400, 800)),
            Ok((FormFactor::Tablet, HintSource::Env)),
            "an explicit tablet hint needs no measurement"
        );
        // The unknown-value rule is unchanged: still an Err, never a guess.
        let err = resolve_runtime(Some("laptop"), FormFactor::Phone, Size::new(2048, 1536))
            .expect_err("an unknown hint must be refused");
        assert!(err.contains("AMOS_FORM_FACTOR"), "{err}");
        assert!(err.contains("laptop"), "{err}");
    }

    #[test]
    fn measured_is_a_distinct_reported_source() {
        assert_eq!(HintSource::BuildDefault.as_str(), "build-default");
        assert_eq!(HintSource::Env.as_str(), "env");
        assert_eq!(HintSource::Measured.as_str(), "measured");
        assert_ne!(HintSource::Measured, HintSource::BuildDefault);
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

    /// REQ-A478 — the cascade, measured on this machine (three `⌘N` windows opened at the
    /// same `236,70 1024×720`, i.e. exactly on top of each other).
    #[test]
    fn a_later_window_of_one_app_is_cascaded_but_stays_on_screen() {
        let screen = Bounds::new(0, 0, 1440, 900);
        let policy = LayoutPolicy::of(FormFactor::Desktop);

        // The first window is byte-for-byte what shipped: this change is additive.
        assert_eq!(
            policy.initial_window_for(screen, 1),
            policy.initial_window_in(screen),
            "instance 1 must not move a single pixel"
        );
        assert_eq!(
            policy.initial_window_for(screen, 0),
            policy.initial_window_in(screen),
            "a bogus ordinal is not a reason to move a window"
        );

        // Each later instance steps right and down by exactly one step.
        let base = policy.initial_window_in(screen);
        for (instance, steps) in [(2u32, 1i32), (3, 2), (4, 3)] {
            let placed = policy.initial_window_for(screen, instance);
            assert_eq!(
                placed.x,
                base.x + steps * CASCADE_STEP,
                "instance {instance}"
            );
            assert_eq!(
                placed.y,
                base.y + steps * CASCADE_STEP,
                "instance {instance}"
            );
            assert_eq!(
                (placed.width, placed.height),
                (base.width, base.height),
                "the cascade moves a window, it does not resize it"
            );
        }

        // A cascade can never walk off the screen: late instances are clamped back inside.
        let late = policy.initial_window_for(screen, 16);
        assert!(
            late.right() <= screen.right() && late.bottom() <= screen.bottom(),
            "instance 16 must still be on screen: {late:?}"
        );
        assert!(late.x >= screen.x && late.y >= screen.y, "{late:?}");

        // …and the invariant holds on every class and screen we can be given, including the
        // unmeasured one and an absurd ordinal (bounded arithmetic, Power of 10 rule 2).
        for f in FormFactor::ALL {
            let p = LayoutPolicy::of(f);
            for s in [
                Bounds::new(0, 0, 1440, 900),
                Bounds::new(0, 0, 0, 0),
                Bounds::new(-500, -300, 800, 600),
            ] {
                for instance in [1u32, 2, 9, 16, u32::MAX] {
                    let b = p.initial_window_for(s, instance);
                    assert!(b.width >= 1 && b.height >= 1, "{f} {instance}: {b:?}");
                    if s.width > 0 && s.height > 0 {
                        assert!(
                            b.x >= s.x
                                && b.y >= s.y
                                && b.right() <= s.right()
                                && b.bottom() <= s.bottom(),
                            "{f} instance {instance} escaped {s:?}: {b:?}"
                        );
                    }
                }
            }
        }
    }

    /// A rail exists exactly where the user may move a window. REQ-A1545 ∕ F-WM-028.
    #[test]
    fn stage_rail_width_is_zero_for_every_class_without_a_rail() {
        for f in FormFactor::ALL {
            let p = LayoutPolicy::of(f);
            let rail = p.stage_rail_width();
            assert_eq!(
                rail > 0,
                p.free_resize,
                "{f}: a rail is a place to park a window the user may drag, so it \
                 exists iff free_resize (rail={rail}, free_resize={})",
                p.free_resize
            );
        }
        assert_eq!(
            LayoutPolicy::of(FormFactor::Desktop).stage_rail_width(),
            STAGE_RAIL_WIDTH
        );
        // The tablet is the interesting negative control: it *does* allow two windows
        // (`multi_window`), and still has no rail — its panes are laid out by
        // `split_panes`, not dragged by the user.
        let tablet = LayoutPolicy::of(FormFactor::Tablet);
        assert!(tablet.multi_window, "the tablet still shows two windows");
        assert_eq!(tablet.stage_rail_width(), 0);
        assert_eq!(LayoutPolicy::of(FormFactor::Robot).stage_rail_width(), 0);
    }

    /// The inset gives way before the pane does. REQ-A1545 ∕ F-WM-028.
    #[test]
    fn the_inset_never_starves_a_minimum_pane() {
        let desktop = LayoutPolicy::of(FormFactor::Desktop);
        let min = desktop.min_pane;

        // A roomy area: the rail is taken in full out of the left edge.
        let big = desktop.stage_work_area(Bounds::new(0, 0, 1920, 1080));
        assert_eq!((big.x, big.y), (STAGE_RAIL_WIDTH as i32, 0));
        assert_eq!(big.width, 1920 - STAGE_RAIL_WIDTH);
        assert_eq!(big.height, 1080);

        // An offset area keeps its origin relationship.
        let off = desktop.stage_work_area(Bounds::new(-500, -300, 1920, 1080));
        assert_eq!(off.x, -500 + STAGE_RAIL_WIDTH as i32);
        assert_eq!(off.y, -300);

        // Narrow areas: the rail shrinks first, so a minimum pane always fits.
        // 400 = rail 180 + pane 220 would starve the pane ⇒ rail gives back 40.
        let narrow = desktop.stage_work_area(Bounds::new(0, 0, 400, 800));
        assert_eq!(narrow.width, min.width, "the pane keeps its minimum");
        assert_eq!(narrow.x, 40, "…and exactly the remainder goes to the rail");
        // At (or below) the pane minimum there is no rail left at all: no-op.
        for w in [0u32, 1, min.width - 1, min.width] {
            let area = Bounds::new(7, 9, w, 800);
            assert_eq!(
                desktop.stage_work_area(area),
                area,
                "width {w} cannot afford a rail beside a minimum pane"
            );
        }
        // An unmeasured area (0×0) is a no-op, like `columns_for(0) == 1`.
        let unmeasured = Bounds::new(0, 0, 0, 0);
        assert_eq!(desktop.stage_work_area(unmeasured), unmeasured);

        // A class with no rail is the identity on every area.
        for f in [FormFactor::Phone, FormFactor::Tablet, FormFactor::Robot] {
            let p = LayoutPolicy::of(f);
            for area in [
                Bounds::new(0, 0, 1920, 1080),
                Bounds::new(7, 9, 400, 800),
                Bounds::new(0, 0, 0, 0),
            ] {
                assert_eq!(p.stage_work_area(area), area, "{f} must not inset");
            }
        }

        // Property: the work area is always inside the area, always leaves a minimum
        // pane when the area could hold one, and never reports a zero width.
        for f in FormFactor::ALL {
            let p = LayoutPolicy::of(f);
            for w in [0u32, 1, 100, 359, 360, 400, 539, 540, 541, 1920, u32::MAX] {
                let area = Bounds::new(-50, -50, w, 800);
                let work = p.stage_work_area(area);
                // An unmeasured area stays unmeasured — a no-op, not an invented 1 px.
                if w == 0 {
                    assert_eq!(work, area, "{f}: 0-width is a no-op");
                    continue;
                }
                assert!(work.width >= 1, "{f} @ {w}: zero-width work area");
                assert!(work.right() <= area.right(), "{f} @ {w}: escaped right");
                assert!(
                    work.bottom() <= area.bottom() && work.y >= area.y,
                    "{f} @ {w}"
                );
                assert_eq!(work.height, area.height, "{f} @ {w}: height untouched");
                if w >= p.min_pane.width {
                    assert!(
                        work.width >= p.min_pane.width,
                        "{f} @ {w}: starved the pane ({} < {})",
                        work.width,
                        p.min_pane.width
                    );
                } else {
                    assert_eq!(work, area, "{f} @ {w}: nothing to take");
                }
            }
        }
    }

    /// Arrange: the shapes the doc promises. REQ-A1545 ∕ F-WM-028.
    #[test]
    fn arrange_gives_one_window_the_centre_and_two_windows_halves() {
        let d = LayoutPolicy::of(FormFactor::Desktop);
        // A tall stage: two 480-tall rows fit, so the `ceil(sqrt)` grid is used.
        let tall = Bounds::new(0, 0, 2380, 1348);

        // One window fills the stage — centred in the only sense that matters here:
        // it is the whole thing.
        let one = d.arrange_stage(tall, 1).expect("one window always fits");
        assert_eq!(one, vec![tall]);

        // Two: side by side, gap between, both edges reached.
        let two = d.arrange_stage(tall, 2).expect("two fit");
        assert_eq!(two.len(), 2);
        assert_eq!(two[0].x, 0);
        assert_eq!(
            two[0].right() + i64::from(d.divider_gap),
            i64::from(two[1].x)
        );
        assert_eq!(two[1].right(), tall.right());
        assert_eq!(two[0].y, 0);
        assert_eq!(two[0].height, tall.height);

        // Three on a tall stage: two above, one below — the short row spreads across
        // the full width rather than leaving a hole.
        let three = d.arrange_stage(tall, 3).expect("three fit");
        assert_eq!(three.len(), 3);
        assert_eq!(
            three[0].right() + i64::from(d.divider_gap),
            i64::from(three[1].x)
        );
        assert_eq!(
            three[2].width, tall.width,
            "the lone bottom pane is full width"
        );
        assert_eq!(three[2].bottom(), tall.bottom());
        assert_eq!(
            three[0].bottom() + i64::from(d.divider_gap),
            i64::from(three[2].y)
        );

        // …but a *wide, short* stage cannot stack two 480-tall panes, so the grid
        // widens to one row of three instead of refusing. This is the laptop case.
        let short = Bounds::new(0, 0, 1260, 808);
        let wide = d
            .arrange_stage(short, 3)
            .expect("three columns, not a refusal");
        assert_eq!(wide.len(), 3);
        assert_eq!(wide[0].y, 0, "one row: every cell spans the full height");
        assert_eq!(wide[0].height, short.height);
        assert!(wide[2].right() <= short.right(), "{wide:?}");

        // Four: a 2×2 on the tall stage.
        let four = d.arrange_stage(tall, 4).expect("four fit here");
        assert_eq!(four.len(), 4);
        assert_eq!(
            four[0].bottom() + i64::from(d.divider_gap),
            i64::from(four[2].y)
        );

        // The same four windows on the short stage cannot fit at any grid and are
        // refused — never a sliver, never an overlap.
        assert_eq!(d.arrange_stage(short, 4), None);

        // An empty stage is a no-op, not an error — "Tidy" on nothing must not fail.
        assert_eq!(d.arrange_stage(tall, 0), Some(Vec::new()));

        // More windows than the grid is allowed to allocate is a refusal, not a
        // silently truncated layout.
        assert_eq!(d.arrange_stage(tall, MAX_STAGE_WINDOWS + 1), None);
        assert_eq!(d.arrange_stage(tall, 1000), None);
    }

    /// Arrange never overlaps, never leaves the stage, and refuses rather than
    /// producing a sliver. REQ-A1545 ∕ F-WM-028.
    #[test]
    fn arrange_never_overlaps_and_never_leaves_the_stage() {
        for f in FormFactor::ALL {
            let p = LayoutPolicy::of(f);
            for stage in [
                Bounds::new(0, 0, 2380, 1348),
                Bounds::new(0, 0, 1260, 808),
                Bounds::new(-800, -600, 1920, 1080),
                Bounds::new(0, 0, 0, 0),
                Bounds::new(0, 0, 100, 100),
                Bounds::new(0, 0, 360, 480),
            ] {
                for count in 0..=(MAX_STAGE_WINDOWS + 4) {
                    let Some(rects) = p.arrange_stage(stage, count) else {
                        continue;
                    };
                    assert_eq!(rects.len(), count, "{f} {count} lost a window");
                    for (i, r) in rects.iter().enumerate() {
                        assert!(r.width >= 1 && r.height >= 1, "{f} {count} #{i}: {r:?}");
                        if stage.width > 0 && stage.height > 0 {
                            assert!(
                                r.x >= stage.x
                                    && r.y >= stage.y
                                    && r.right() <= stage.right()
                                    && r.bottom() <= stage.bottom(),
                                "{f} {count} #{i} escaped {stage:?}: {r:?}"
                            );
                        }
                        // Never a sliver: a laid-out cell must be a usable pane.
                        assert!(
                            r.width >= p.min_pane.width && r.height >= p.min_pane.height,
                            "{f} {count} #{i} is below min_pane {:?}: {r:?}",
                            p.min_pane
                        );
                    }
                    for i in 0..rects.len() {
                        for j in (i + 1)..rects.len() {
                            let (a, b) = (rects[i], rects[j]);
                            let disjoint = a.right() <= b.x as i64
                                || b.right() <= a.x as i64
                                || a.bottom() <= b.y as i64
                                || b.bottom() <= a.y as i64;
                            assert!(disjoint, "{f} {count}: {a:?} overlaps {b:?}");
                        }
                    }
                }
            }
        }
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
