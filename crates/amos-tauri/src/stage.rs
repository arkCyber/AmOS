//! Stage Manager host adapter: the rail that parks windows off-stage, plus the
//! one-shot "tidy" that lays the stage out (`docs/stage-manager.md`).
//!
//! `crates/amos-wm` owns the geometry (`LayoutPolicy::stage_rail_width`,
//! `::stage_work_area`, `::arrange_stage`, and `amos_wm::stage::{overlaps_rail,
//! reflow_out_of_rail}`); this module owns the *ledger* half — which windows are on
//! the stage and which are parked — and the Tauri commands the shell calls.
//!
//! # The view is **derived**, never a second ledger
//!
//! "Parked" is not a list this module keeps. It is `WindowInfo.state == "Hidden"` for an
//! app window, read back from [`WmState::snapshot`] — the model the window manager
//! already maintains. That is what makes the rail follow the truth for free: closing a
//! parked window removes it from the window list, and the rail stops drawing it without
//! anybody telling the rail. A second `parked: HashSet<label>` here would be the classic
//! two-ledger drift (the mistake `crate::wm`'s `bind`/`unbind` comment warns about), and
//! its first symptom would be a rail tile for a window that no longer exists.
//!
//! The one exception is a window a **Spaces** switch hid: it reaches the model as the same
//! `Hidden` a user's "park this window" writes, so the rail asks the Spaces ledger which
//! labels those are ([`views_of`], `crate::spaces::SpaceManager::hidden_by_switch`) rather
//! than guessing from the model. That is still derivation — the answer comes from the manager
//! that owns the fact, not from a copy kept here.
//!
//! # Why the parking verbs are the window manager's own
//!
//! `stage_park` is [`WmState::hide`] and `stage_bring` is [`WmState::reveal`] — not new
//! (`reveal`, not `open`: `open` is the launch verb whose identity gate refuses an app's
//! second window, and the rail draws a tile for exactly that window — see [`stage_bring`].)
//! A stage that moved windows by some third mechanism would need its own
//! event stream and its own focus rules; reusing these means the Dock's running dot, the
//! ⌘Tab list and `wm-changed` all keep working on a parked window exactly as they do on
//! a ⌘H one.
//!
//! # What this module does **not** do
//!
//! It does not draw the rail. The rail is DOM inside the launcher window, and the
//! guarantee that app windows cannot cover it is **geometric** — every placement path
//! insets through [`WmState`]'s policy — not z-order. See `docs/stage-manager.md` for
//! why that trade was taken and what it costs.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use amos_wm::form::LayoutPolicy;
use amos_wm::layout::Bounds;

use crate::error::{AmosError, AmosResult, ErrorCode};
use crate::spaces::SpaceManagerState;
use crate::store::SharedStore;
use crate::wm::{finish_layout, is_screen_window, WmSnapshot, WmState};

/// One window parked on the rail.
///
/// Deliberately **no `title` field**. The human name of a window in AmOS comes from one
/// resolver (`svelte/locale.svelte.ts::windowName`) which the i18n layer feeds; a title
/// minted here in Rust could only be the raw app id, and the shell would then have two
/// names for one window that disagree in every non-English locale — the exact drift
/// REQ-A473 removed for the window title itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StageWindow {
    /// The Tauri window label (`files`, `files_2`).
    pub label: String,
    /// The **app id** this window shows (`WindowInfo::app`).
    pub app: String,
    /// Which instance of that app (`WindowInfo::instance`).
    pub instance: u32,
}

/// The Stage Manager's whole observable state (REQ-A1546).
///
/// **No geometry.** The one number a shell needs to draw the rail — how many pixels it
/// takes out of the left edge — is a *layout* fact and is reported there
/// (`LayoutSnapshot::rail_width`, cut from the same `screen_w/h` the shell already draws
/// the stage from). Reporting it here as well would give the rail and the desktop-icon
/// inset two independent readings of one number, which is how they come to disagree.
/// This struct is therefore the **view**: is the mode on, and who is where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StageSnapshot {
    /// Is the mode on? Always `false` on a class with no rail.
    pub enabled: bool,
    /// The windows **on** the stage (shown or focused, this host's own), in the model's
    /// order. Same record as [`StageWindow`] rather than a bare label, so the shell can name
    /// an on-stage window through the one resolver (`locale.svelte.ts::windowName`) instead
    /// of printing its raw wire label — and the shell reads the length to gate "Tidy".
    pub on_stage: Vec<StageWindow>,
    /// The rail view: one entry per parked window, in the model's order.
    pub parked: Vec<StageWindow>,
}

/// The rail view plus the on-stage list, derived from a window snapshot.
///
/// Pure over `snapshot`, so the rule is exercised without a window server — the same
/// shape [`WmState::minimize_target`] and `snap_plan` use.
///
/// * **parked** = `state == "Hidden"` **and** `kind == "App"` **and** not external, **and**
///   not hidden by a Spaces switch. A hidden *System* surface (a dialog) is not a window the
///   user parked, and an external container surface has no window for the rail to bring back.
///   The Launcher can never be hidden at all (the window manager refuses it), so it needs no
///   clause here — the `kind` test excludes it anyway rather than relying on that.
/// * **on_stage** = everything this host owns that is not hidden: `Focused` and `Shown`
///   app windows plus system surfaces, minus the Launcher ([`is_screen_window`]) and
///   minus external surfaces.
///
/// # Why a Spaces-hidden window is not "parked"
///
/// A desktop switch hides a window through the very same [`WmState::hide`] a user's "park
/// this window" uses, so the window model alone shows one state for two different acts. The
/// rail must not offer a tile for the wrong one: the window belongs to *another desktop*,
/// nothing here was parked, and "bring it back" would show a window on a Space that does not
/// own it — after which the next switch hides it again. `hidden_by_spaces` is that
/// distinction, and it is the *only* place this view consults a second manager: `on_stage` is
/// untouched by it, because a Spaces-hidden window is hidden in the model already.
///
/// This is deliberately the Spaces ledger's own answer
/// (`crate::spaces::SpaceManager::hidden_by_switch`) and not a mark kept on each window — see
/// that method for why (REQ-A1686).
fn views_of(
    snapshot: &WmSnapshot,
    hidden_by_spaces: &[String],
) -> (Vec<StageWindow>, Vec<StageWindow>) {
    let mut on_stage = Vec::new();
    let mut parked = Vec::new();
    for w in &snapshot.windows {
        if w.external {
            continue;
        }
        let record = StageWindow {
            label: w.label.clone(),
            app: w.app.clone(),
            instance: w.instance,
        };
        if w.state == "Hidden" {
            // A hidden app window is on the rail — unless a desktop switch is what hid it,
            // in which case it is another Space's window, not something the user parked.
            if w.kind == "App" && !hidden_by_spaces.iter().any(|l| l == &w.label) {
                parked.push(record);
            }
            continue;
        }
        if !is_screen_window(&w.label) {
            on_stage.push(record);
        }
    }
    (on_stage, parked)
}

fn lock<T>(result: Result<T, String>) -> AmosResult<T> {
    result.map_err(|e| AmosError::with_cause(ErrorCode::StageLockFailed, "lock failed", e))
}

/// The error a [`WmState::set_stage_enabled`] refusal becomes, told apart by `rail`.
///
/// That call refuses for exactly two reasons, and the class's rail width is the one fact that
/// separates them:
///
/// * **no rail** (`rail == 0`) — the *policy* refusal, which `StageUnsupported` names;
/// * anything else with a rail present — the window-manager **lock**, which the rest of this
///   module reports through [`lock`] as `StageLockFailed`, and whose own reason is kept as the
///   cause rather than being replaced by a literal.
///
/// Folding both into `StageUnsupported` told a desktop user 「此设备没有舞台栏，无法打开舞台
/// 管理器」 for a lock that had nothing to do with the form factor — a cause the call never
/// established. `rail` is read **before** the call for that reason: read after it, a poisoned
/// lock fails the reading too and the distinction is unobtainable.
fn stage_enable_refusal(reason: String, rail: u32) -> AmosError {
    if rail > 0 {
        AmosError::with_cause(ErrorCode::StageLockFailed, "lock failed", reason)
    } else {
        AmosError::new(ErrorCode::StageUnsupported, reason)
    }
}

/// The `SharedStore` key the Stage mode preference is persisted under (REQ-A1755).
///
/// `docs/stage-manager.md` §3.2 calls the on/off state a **preference**, and a preference
/// is a fact about the user that outlives one run: [`stage_set_enabled`] writes it here and
/// [`apply_persisted`] seeds `WmCore::stage_enabled` from it at boot. Without a stored
/// value the mode would silently reset to OFF on every launch — which is the failure
/// [`ErrorCode::StagePersistFailed`] names ("the Stage mode preference could not be
/// persisted") and the reason the code exists rather than being dead.
///
/// The value is `"1"` (on) or `"0"` (off), matching this store's string-valued shape.
pub const STAGE_ENABLED_KEY: &str = "amos.wm.stage_enabled";

/// The stored form of the preference. `"1"`/`"0"` rather than a word so the reader is a
/// single equality with no parse (see [`stage_pref_is_on`]).
fn stage_pref_value(enabled: bool) -> &'static str {
    if enabled {
        "1"
    } else {
        "0"
    }
}

/// Does a stored value mean "Stage mode was on"? Only the exact `"1"` does: any other
/// value (absent, `"0"`, or garbage from an older/foreign writer) is **off** — the mode
/// defaults OFF (`docs/stage-manager.md` §4), so an unreadable preference must not turn it
/// on by accident.
fn stage_pref_is_on(raw: Option<&str>) -> bool {
    raw == Some("1")
}

/// Would this toggle fail to persist? A **change** to a store with no backing file is the
/// one persistence failure this host can observe ([`SharedStore::path`] is `None`). A
/// no-op toggle (the mode already is what was asked) stores nothing, so it is never a
/// refusal — the mode is what the user asked for either way. Pure, so the command's guard
/// is exercised without an `AppHandle`.
fn stage_persist_refusal(current: bool, enabled: bool, has_backing_file: bool) -> bool {
    current != enabled && !has_backing_file
}

/// Seed Stage mode from the persisted preference, at boot.
///
/// A **reported** refusal, not a fatal one: a stored `"1"` on a class whose policy has no
/// rail is refused by [`WmState::set_stage_enabled`] itself, and booting with a warning is
/// better than failing the whole launch over one preference (the same shape
/// `rotation::apply_persisted` follows for a stored lock the display cannot honour). On a
/// class that *has* a rail this is the line that makes the mode survive a restart.
pub fn apply_persisted(store: &SharedStore, state: &WmState) {
    if !stage_pref_is_on(store.get(STAGE_ENABLED_KEY).as_deref()) {
        return;
    }
    if let Err(reason) = state.set_stage_enabled(true) {
        tracing::warn!(
            target: "amos::stage",
            reason = %reason,
            "a stored Stage mode preference could not be re-applied; booting with the mode off"
        );
    }
}

/// The windows a Spaces switch is hiding right now.
///
/// Read and **released** before any window-manager call: `spaces_commands::spaces_switch`
/// holds the manager across its `wm.hide`, so the app's lock order on that path is
/// spaces → window manager, and a reader that kept the manager guard while locking the window
/// manager would invert it. The owned `Vec` is why this cannot happen by accident — the guard
/// drops at the end of this function, so no caller is holding it.
///
/// A poisoned Spaces lock is reported as the **Spaces** lock failing, not as a stage one: it
/// is the ledger that could not be read, and `StageLockFailed` would send a reader to the
/// wrong manager.
fn hidden_by_spaces(spaces: &State<'_, SpaceManagerState>) -> AmosResult<Vec<String>> {
    let mgr = spaces.lock().map_err(|e| {
        AmosError::with_cause(
            ErrorCode::SpacesLockFailed,
            "Failed to lock SpaceManager",
            e,
        )
    })?;
    Ok(mgr.hidden_by_switch())
}

/// Build the snapshot the commands answer with.
///
/// `hidden_by_spaces` is threaded in rather than read here so that the *pure* rule
/// ([`views_of`]) is exercised with it directly — the excluded labels are a parameter of the
/// view, not a second lock taken inside it.
fn snapshot_of(state: &WmState, hidden_by_spaces: &[String]) -> AmosResult<StageSnapshot> {
    let windows = lock(state.snapshot())?;
    let enabled = lock(state.stage_enabled())?;
    let (on_stage, parked) = views_of(&windows, hidden_by_spaces);
    Ok(StageSnapshot {
        enabled,
        on_stage,
        parked,
    })
}

/// Read the whole Stage Manager state.
///
/// Read-only and **never** gated on the mode being on: a shell has to be able to ask "is
/// Stage Manager on?" to draw its own toggle, so refusing here would make the off state
/// unreadable.
#[tauri::command]
pub fn stage_snapshot(
    state: State<'_, WmState>,
    spaces: State<'_, SpaceManagerState>,
) -> AmosResult<StageSnapshot> {
    snapshot_of(&state, &hidden_by_spaces(&spaces)?)
}

/// Turn Stage Manager on or off, answering the state now in effect.
///
/// Refused ([`ErrorCode::StageUnsupported`]) on a class with no rail — see
/// [`WmState::set_stage_enabled`], which owns that rule and re-fits any live split.
///
/// The mode is a **preference**, so the change is written to [`STAGE_ENABLED_KEY`] and
/// [`apply_persisted`] reads it back at boot. A change that cannot be stored is refused
/// ([`ErrorCode::StagePersistFailed`]) **before the mode moves**: reporting failure while
/// the host had in fact toggled would leave the shell drawing a mode the host denies — the
/// one disagreement the host-owned state exists to prevent. A no-op toggle (the mode is
/// already what was asked for) stores nothing and so needs no durable store.
///
/// Switching the mode **on** re-clamps every open window with
/// [`WmState::reclamp_windows`], which now works against the work area rather than the
/// whole screen. Without this, turning the mode on would draw a rail *over* the windows
/// that were already open — the one failure the rail's geometric guarantee exists to
/// prevent, arrived at from the other direction. Switching it **off** needs no reflow:
/// the strip simply stops being reserved, and every window is still on screen.
///
/// It ends with [`crate::wm::finish_layout`] because it is a layout mutation like any
/// other: the work area moved, so a live split's panes were re-fitted and have to be
/// re-applied to the real windows, and the shell has to learn the new `rail_width` through
/// `layout-changed` before it can inset the rail and the desktop icon grid.
#[tauri::command]
pub fn stage_set_enabled(
    app: AppHandle,
    state: State<'_, WmState>,
    store: State<'_, SharedStore>,
    spaces: State<'_, SpaceManagerState>,
    enabled: bool,
) -> AmosResult<StageSnapshot> {
    // Refuse an unstorable *change* before the mode moves ([`stage_persist_refusal`]).
    // `path().is_none()` is a store with no backing file (`SharedStore::memory`), the one
    // persistence failure this host can observe: the value would not survive a restart, so
    // the mode would be a lie at the next boot. A no-op toggle stores nothing, so it is
    // never refused — the mode is already what was asked for.
    if stage_persist_refusal(
        lock(state.stage_enabled())?,
        enabled,
        store.path().is_some(),
    ) {
        return Err(AmosError::new(
            ErrorCode::StagePersistFailed,
            "the Stage mode preference has no durable store to be persisted to",
        ));
    }
    // Read the class's rail width **before** the call: it is what tells the call's two
    // failures apart ([`stage_enable_refusal`]), and read after them it would be
    // unobtainable for the case that most needs the distinction — a poisoned lock fails the
    // reading too, so `?` here reports the lock honestly instead of letting a lock failure
    // wear the form-factor refusal's sentence.
    let rail = lock(state.policy())?.stage_rail_width();
    if let Err(reason) = state.set_stage_enabled(enabled) {
        return Err(stage_enable_refusal(reason, rail));
    }
    store.insert(STAGE_ENABLED_KEY, stage_pref_value(enabled).to_string());
    if enabled {
        lock(state.reclamp_windows(&app))?;
    }
    let layout = lock(state.layout_snapshot())?;
    lock(finish_layout(&app, &state, &layout))?;
    snapshot_of(&state, &hidden_by_spaces(&spaces)?)
}

/// Why parking `label` would be refused, or `Ok(())`.
///
/// Pure over the window model, so every refusal is unit-tested without a window server:
///
/// * the mode is off — parking is a Stage Manager verb, and with no rail there is
///   nowhere for the window to go (it would be a plain ⌘H wearing a stage's clothes);
/// * the label names the **Launcher** ([`is_screen_window`]) — it *is* the stage, so
///   parking it would hide the surface that draws the rail;
/// * the label names a window in an **active split** — its rectangle belongs to the
///   split session, so hiding one pane would leave the split describing a layout that is
///   not on screen (the rule [`WmState::minimize_target`] already states for minimize);
/// * the label is not a registered window.
pub fn park_target(state: &WmState, label: &str) -> AmosResult<()> {
    if !lock(state.stage_enabled())? {
        return Err(AmosError::new(
            ErrorCode::StageDisabled,
            format!("stage_park('{label}') needs Stage Manager to be on"),
        ));
    }
    if is_screen_window(label) {
        return Err(AmosError::new(
            ErrorCode::StageWindowIsScreen,
            format!("'{label}' is the desktop itself, not a window that can be parked"),
        ));
    }
    if let Some((a, b)) = lock(state.split_labels())? {
        if a == label || b == label {
            return Err(AmosError::new(
                ErrorCode::StageWindowInSplit,
                format!("window '{label}' is in a split — exit the split before parking it"),
            ));
        }
    }
    let known = lock(state.snapshot())?
        .windows
        .iter()
        .any(|w| w.label == label);
    if !known {
        return Err(AmosError::new(
            ErrorCode::StageWindowUnknown,
            format!("window '{label}' is not registered"),
        ));
    }
    Ok(())
}

/// Park `label` on the rail.
///
/// A refusal is by **name**, never a silent no-op — the discipline
/// [`WmState::snap_window`] follows, and for the same reason: "the rail says parked and
/// the window is still on screen" is the one failure the user can see and the ledger
/// cannot.
#[tauri::command]
pub fn stage_park(
    app: AppHandle,
    state: State<'_, WmState>,
    spaces: State<'_, SpaceManagerState>,
    label: String,
) -> AmosResult<StageSnapshot> {
    park_target(&state, &label)?;
    lock(state.hide(&app, &label))?;
    snapshot_of(&state, &hidden_by_spaces(&spaces)?)
}

/// Why bringing `label` back onto the stage would be refused, or `Ok(())`.
///
/// Pure over the window model, so it is unit-tested without a window server — the same
/// shape [`park_target`] uses, and for the same reason: the rail's verbs refuse **by
/// name**, never silently.
///
/// * the mode is off — a bring is a Stage Manager verb, and with no rail there is no stage
///   to bring the window onto;
/// * the label is not a registered window. The rail's tiles are a *view* of the model
///   ([`views_of`]), and between the snapshot a tile was drawn from and the click on it the
///   window can close. Without this arm such a bring reached [`WmState::open`], which does
///   **not** create only the first instance — the refusal came back as a bare `String` with
///   no `amos.stage.*` code, so the shell could only print the cause-less 「操作失败」.
///
/// Deliberately **no** `StageWindowIsScreen` arm: the Launcher is never on the rail
/// ([`views_of`] excludes it), so there is no tile that could ask for it.
pub fn bring_target(state: &WmState, label: &str) -> AmosResult<()> {
    if !lock(state.stage_enabled())? {
        return Err(AmosError::new(
            ErrorCode::StageDisabled,
            format!("stage_bring('{label}') needs Stage Manager to be on"),
        ));
    }
    let known = lock(state.snapshot())?
        .windows
        .iter()
        .any(|w| w.label == label);
    if !known {
        return Err(AmosError::new(
            ErrorCode::StageWindowUnknown,
            format!("window '{label}' is not registered"),
        ));
    }
    Ok(())
}

/// Bring a parked window back onto the stage.
///
/// The window is *shown and focused*: a rail tile is a click on a window, and one that came
/// back unfocused would leave the user typing into whatever was behind it.
///
/// This is [`WmState::reveal`], **not** [`WmState::open`]. `open` is the launch verb and
/// refuses every label that is not an app's *first* window (its identity gate, REQ-A473) —
/// so a rail tile for a second instance (`notes_2`, which [`views_of`] makes its own tile)
/// could be parked and never brought back, and the refusal wore `StageLockFailed`'s
/// sentence. `reveal` shows the registered window the label already names.
#[tauri::command]
pub fn stage_bring(
    app: AppHandle,
    state: State<'_, WmState>,
    spaces: State<'_, SpaceManagerState>,
    label: String,
) -> AmosResult<StageSnapshot> {
    bring_target(&state, &label)?;
    let hidden = hidden_by_spaces(&spaces)?;
    // A window a **Space switch** is hiding still opens here — the window manager's own verb
    // is the authority, and this command is not the authority on which desktop a window
    // belongs to. What the rail promises is narrower and is enforced where it is drawn: such a
    // window gets no tile ([`views_of`]), so no surface offers this call for one.
    lock(state.reveal(&app, &label))?;
    snapshot_of(&state, &hidden)
}

/// Lay every on-stage window out in a grid over the work area ("Tidy").
///
/// The geometry is `LayoutPolicy::arrange_stage` — pure, tested in `amos-wm` and
/// **refused** (`None`) when the work area cannot give every window its minimum pane, or
/// when there are more windows than the grid will allocate. A refusal here is the honest
/// answer, not a partial layout that the user cannot tell from a complete one.
///
/// Applying is the same two calls [`WmState::snap_window`] makes, through
/// [`apply_tidy`], which reports each window's platform error per window rather than
/// aborting the loop: a half-applied tidy is exactly the state a reader has to be able to
/// see, so the ones that failed are named instead of being dropped behind an early `?`.
#[tauri::command]
pub fn stage_arrange(
    app: AppHandle,
    state: State<'_, WmState>,
    spaces: State<'_, SpaceManagerState>,
) -> AmosResult<StageSnapshot> {
    if !lock(state.stage_enabled())? {
        return Err(AmosError::new(
            ErrorCode::StageDisabled,
            "stage_arrange needs Stage Manager to be on".to_string(),
        ));
    }
    let hidden = hidden_by_spaces(&spaces)?;
    let policy = lock(state.policy())?;
    // The work area, through the host's own seam (not `policy.stage_work_area(screen)`):
    // that is the one function that knows the mode is on, so the tidy grid and every
    // placement inset cannot disagree about where the stage ends.
    let work = lock(state.work_area())?;
    // The on-stage set comes from the **same** rule the rail view uses ([`views_of`]), so
    // "Tidy" can only ever lay out the windows the rail is showing as on-stage — a second
    // filter written here is how the two come to disagree about what is on the stage.
    let (on_stage, _) = views_of(&lock(state.snapshot())?, &hidden);
    let labels: Vec<String> = on_stage.into_iter().map(|w| w.label).collect();

    // An empty stage is a no-op, not an error: "Tidy" with nothing to tidy must not
    // report a failure. `arrange_stage(…, 0)` is `Some(vec![])` for exactly this.
    let Some(plan) = stage_plan(policy, work, &labels) else {
        return Err(AmosError::new(
            ErrorCode::StageArrangeImpossible,
            format!(
                "cannot arrange {} window(s) in {}x{} at the class minimum of {}x{}",
                labels.len(),
                work.width,
                work.height,
                policy.min_pane.width,
                policy.min_pane.height
            ),
        ));
    };

    let refused = apply_tidy(&plan, |label, target| {
        let Some(w) = app.get_webview_window(label) else {
            return Err("no platform window for this label".to_string());
        };
        w.set_position(tauri::LogicalPosition::new(
            f64::from(target.x),
            f64::from(target.y),
        ))
        .and_then(|()| {
            w.set_size(tauri::LogicalSize::new(
                f64::from(target.width),
                f64::from(target.height),
            ))
        })
        .map_err(|e| e.to_string())
    });
    for label in &refused {
        tracing::warn!(
            target: "amos::stage",
            label = %label,
            "a tidy rect could not be applied; the other windows are still laid out"
        );
    }
    // The count of refusals is in the line, not only in the per-window warnings above: a
    // reader grepping one line must not be able to mistake a partial tidy for a complete
    // one. (`applied` is the plan length minus the refusals, stated rather than inferred.)
    tracing::info!(
        windows = plan.len(),
        refused = refused.len(),
        "stage manager tidied the stage"
    );
    snapshot_of(&state, &hidden)
}

/// Pair each label with its grid cell — the pure half of [`stage_arrange`].
///
/// Returns `None` exactly when [`LayoutPolicy::arrange_stage`] refuses, so the reason
/// the host reports is the reason the geometry gave.
pub fn stage_plan(
    policy: LayoutPolicy,
    work: Bounds,
    labels: &[String],
) -> Option<Vec<(String, Bounds)>> {
    let rects = policy.arrange_stage(work, labels.len())?;
    Some(labels.iter().cloned().zip(rects).collect())
}

/// Apply a tidy plan through `place`, answering the labels the applier **refused**.
///
/// The plan is applied in order — the order [`stage_plan`] paired the labels in — and a
/// refusal does **not** abort the loop. That is the whole reason this is a named function
/// rather than eight lines inside the command: "Tidy" is a batch of independent window
/// moves, and the interesting failure is a *partial* one, which the caller has to be able
/// to see. Returning the refused labels (rather than logging inside) lets the caller put
/// the count in its one summary line, and lets a test assert both halves of the rule
/// without a window server.
///
/// An empty plan applies nothing and refuses nothing: "Tidy" on an empty stage is a
/// no-op, not a failure.
pub fn apply_tidy<F>(plan: &[(String, Bounds)], mut place: F) -> Vec<String>
where
    F: FnMut(&str, Bounds) -> Result<(), String>,
{
    let mut refused = Vec::new();
    for (label, target) in plan {
        if place(label, *target).is_err() {
            refused.push(label.clone());
        }
    }
    refused
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wm::{WindowInfo, WmSnapshot};

    fn win(label: &str, app: &str, instance: u32, kind: &str, state: &str) -> WindowInfo {
        WindowInfo {
            id: 0,
            label: label.to_string(),
            app: app.to_string(),
            instance,
            kind: kind.to_string(),
            state: state.to_string(),
            focused: state == "Focused",
            external: false,
        }
    }

    fn snap(windows: Vec<WindowInfo>) -> WmSnapshot {
        WmSnapshot {
            focused: None,
            windows,
        }
    }

    /** The labels of a view group, which is what most assertions here are about. */
    fn labels(views: &[StageWindow]) -> Vec<String> {
        views.iter().map(|w| w.label.clone()).collect()
    }

    /// REQ-A1546 — the rail is the model's `Hidden` state, not a second list.
    #[test]
    fn the_rail_view_follows_the_hidden_state() {
        let (on_stage, parked) = views_of(
            &snap(vec![
                win("main", "", 0, "Launcher", "Shown"),
                win("files", "files", 1, "App", "Focused"),
                win("settings", "settings", 1, "App", "Shown"),
                win("notes", "notes", 1, "App", "Hidden"),
                win("notes_2", "notes", 2, "App", "Hidden"),
            ]),
            &[],
        );
        // The Launcher is never "on stage" — it *is* the stage.
        assert_eq!(
            labels(&on_stage),
            vec!["files".to_string(), "settings".to_string()]
        );
        assert_eq!(
            parked,
            vec![
                StageWindow {
                    label: "notes".into(),
                    app: "notes".into(),
                    instance: 1
                },
                StageWindow {
                    label: "notes_2".into(),
                    app: "notes".into(),
                    instance: 2
                },
            ],
            "instance 2 of an app is its own rail tile"
        );
    }

    /// An on-stage window carries its **app id** as well as its label, so the shell names it
    /// through the one resolver instead of printing a raw wire label (`files_2`).
    #[test]
    fn an_on_stage_window_carries_its_app_id_for_the_name_resolver() {
        let (on_stage, _) = views_of(
            &snap(vec![
                win("main", "", 0, "Launcher", "Focused"),
                win("files_2", "files", 2, "App", "Shown"),
            ]),
            &[],
        );
        assert_eq!(
            on_stage,
            vec![StageWindow {
                label: "files_2".into(),
                app: "files".into(),
                instance: 2
            }]
        );
    }

    /// A hidden *system* surface was not parked by the user, so it is not on the rail —
    /// and it is not on the stage either (it is hidden). Nothing invents a tile for it.
    #[test]
    fn a_hidden_system_surface_is_not_a_parked_window() {
        let (on_stage, parked) = views_of(
            &snap(vec![
                win("main", "", 0, "Launcher", "Focused"),
                win("dialog", "", 0, "System", "Hidden"),
                win("files", "files", 1, "App", "Shown"),
            ]),
            &[],
        );
        assert!(
            parked.is_empty(),
            "a dialog is not something the user parked"
        );
        assert_eq!(labels(&on_stage), vec!["files".to_string()]);
    }

    /// An external container surface has no platform window, so the rail cannot bring
    /// one back: it is excluded from both views rather than drawn as a dead tile.
    #[test]
    fn an_external_surface_is_in_neither_view() {
        let mut ext = win("legacy:1", "", 0, "App", "Shown");
        ext.external = true;
        let (on_stage, parked) = views_of(
            &snap(vec![win("main", "", 0, "Launcher", "Shown"), ext]),
            &[],
        );
        assert!(on_stage.is_empty());
        assert!(parked.is_empty());
    }

    /// REQ-A1686 — a window a **desktop switch** hid is not a window the user parked.
    ///
    /// The two acts put the same `Hidden` in the model (a switch hides through the same
    /// [`WmState::hide`]), so without the Spaces ledger's own answer the rail drew a tile for
    /// another desktop's window and "bring it back" showed it on a Space that does not own it.
    ///
    /// The negative control is the second half: a genuinely parked window is still on the rail
    /// while the same switch is in effect, so the exclusion is a filter on *those* labels and
    /// not a switch that empties the rail.
    #[test]
    fn a_window_hidden_by_a_space_switch_is_not_parked_on_the_rail() {
        let model = snap(vec![
            win("main", "", 0, "Launcher", "Shown"),
            win("files", "files", 1, "App", "Shown"),
            win("notes", "notes", 1, "App", "Hidden"),
            win("maps", "maps", 1, "App", "Hidden"),
        ]);
        let (on_stage, parked) = views_of(&model, &["maps".to_string()]);
        assert_eq!(
            labels(&parked),
            vec!["notes".to_string()],
            "only the window the user parked is on the rail"
        );
        assert_eq!(
            labels(&on_stage),
            vec!["files".to_string()],
            "the switch's window is hidden, so it is not on the stage either"
        );
        // Positive control: with no switch in effect both hidden windows are parked, so the
        // assertion above is about the label list and not about `Hidden` never reaching the
        // rail.
        let (_, parked) = views_of(&model, &[]);
        assert_eq!(
            labels(&parked),
            vec!["notes".to_string(), "maps".to_string()]
        );
    }

    /// A failed enable on a class that **has** a rail cannot be the policy refusal — that
    /// refusal is "no rail" and nothing else — so it is the window-manager lock, and the
    /// rest of this module reports a lock failure as `StageLockFailed` (`lock()`'s rule;
    /// `error.rs::ErrorCode::StageLockFailed`'s doc says so verbatim). Folding it into
    /// `StageUnsupported` told a desktop user 「此设备没有舞台栏，无法打开舞台管理器」
    /// (`stage.errorUnsupported`) — a cause the call never established.
    #[test]
    fn a_failed_enable_on_a_class_with_a_rail_is_a_lock_failure() {
        let rail = LayoutPolicy::of(amos_wm::form::FormFactor::Desktop).stage_rail_width();
        assert!(rail > 0, "the premise: a desktop has a rail");
        let reason = "poisoned lock: another task failed inside".to_string();
        let e = stage_enable_refusal(reason.clone(), rail);
        assert_eq!(e.code, ErrorCode::StageLockFailed);
        // The reason the lock gave is kept — the fold replaced it with the literal
        // "lock failed" and dropped the cause entirely.
        assert_eq!(e.cause, vec![reason]);
    }

    /// The one *policy* refusal keeps `StageUnsupported` — and keeps its own sentence, which
    /// is the wording `WmState::set_stage_enabled` documents.
    #[test]
    fn a_failed_enable_on_a_class_without_a_rail_is_stage_unsupported() {
        let rail = LayoutPolicy::of(amos_wm::form::FormFactor::Phone).stage_rail_width();
        assert_eq!(rail, 0, "the premise: a phone has no rail");
        let sentence = "form factor 'Phone' has no Stage Manager rail, so Stage mode \
                        cannot be turned on here"
            .to_string();
        let e = stage_enable_refusal(sentence.clone(), rail);
        assert_eq!(e.code, ErrorCode::StageUnsupported);
        assert_eq!(e.message, sentence);
    }

    /// REQ-A1546 — the tidy plan is label↔cell pairing, and it refuses exactly when the
    /// geometry refuses.
    #[test]
    fn a_tidy_plan_pairs_every_label_with_a_cell_and_refuses_with_the_geometry() {
        let policy = LayoutPolicy::of(amos_wm::form::FormFactor::Desktop);
        let roomy = Bounds::new(0, 0, 2380, 1348);
        let labels: Vec<String> = ["files", "settings", "notes"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        let plan = stage_plan(policy, roomy, &labels).expect("three windows fit");
        assert_eq!(plan.len(), 3);
        for (i, (label, _)) in plan.iter().enumerate() {
            assert_eq!(label, &labels[i], "the pairing keeps the caller's order");
        }

        // An empty stage is a no-op, not a refusal.
        assert_eq!(stage_plan(policy, roomy, &[]), Some(Vec::new()));

        // More windows than the grid allocates, and a work area below the class
        // minimum, are both refusals — never a sliver and never a partial plan.
        let many: Vec<String> = (0..(amos_wm::form::MAX_STAGE_WINDOWS + 1))
            .map(|i| format!("w{i}"))
            .collect();
        assert_eq!(stage_plan(policy, roomy, &many), None);
        assert_eq!(
            stage_plan(policy, Bounds::new(0, 0, 500, 400), &labels),
            None
        );
    }

    /// The plan that `stage_plan` paired is the plan that gets **applied**: every label
    /// reaches the applier once, with its own cell, in the model's order.
    #[test]
    fn arrange_applies_a_rect_to_every_stage_window() {
        let policy = LayoutPolicy::of(amos_wm::form::FormFactor::Desktop);
        let work = Bounds::new(180, 0, 2380 - 180, 1348);
        let labels: Vec<String> = ["files", "settings", "notes"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        let plan = stage_plan(policy, work, &labels).expect("three windows fit");

        let mut applied: Vec<(String, Bounds)> = Vec::new();
        let refused = apply_tidy(&plan, |label, target| {
            applied.push((label.to_string(), target));
            Ok(())
        });

        assert!(refused.is_empty());
        assert_eq!(
            applied, plan,
            "the applied pairing is the planned pairing, order included"
        );
        // And the cells really are the geometry's: non-overlapping, inside the stage.
        let rects: Vec<Bounds> = plan.iter().map(|(_, r)| *r).collect();
        for (i, a) in rects.iter().enumerate() {
            assert!(
                a.x >= work.x && a.right() <= work.right(),
                "{a:?} leaves the stage"
            );
            for b in &rects[i + 1..] {
                let disjoint = a.right() <= i64::from(b.x)
                    || b.right() <= i64::from(a.x)
                    || a.bottom() <= i64::from(b.y)
                    || b.bottom() <= i64::from(a.y);
                assert!(disjoint, "{a:?} overlaps {b:?}");
            }
        }
    }

    /// "Tidy" with nothing on the stage is a **no-op**, not a failure — and it calls the
    /// platform zero times, so an empty desktop cannot produce a storm of window writes.
    #[test]
    fn arrange_on_an_empty_stage_is_a_no_op_not_an_error() {
        let policy = LayoutPolicy::of(amos_wm::form::FormFactor::Desktop);
        let work = Bounds::new(180, 0, 2200, 1348);
        let plan = stage_plan(policy, work, &[]).expect("an empty stage is not a refusal");
        assert!(plan.is_empty());

        let mut calls = 0usize;
        let refused = apply_tidy(&plan, |_, _| {
            calls += 1;
            Ok(())
        });
        assert_eq!(calls, 0, "nothing to apply means no platform call");
        assert!(refused.is_empty());
    }

    /// A refused rect does **not** abort the batch, and it is **named** — the whole reason
    /// `apply_tidy` returns the refusals instead of logging them: a reader (and the
    /// caller's one summary line) must be able to tell a complete tidy from a half-applied
    /// one, which is the state the user would otherwise see and nobody would explain.
    #[test]
    fn a_refused_rect_does_not_abort_the_rest_of_the_tidy() {
        let plan: Vec<(String, Bounds)> = vec![
            ("files".to_string(), Bounds::new(0, 0, 100, 100)),
            ("settings".to_string(), Bounds::new(100, 0, 100, 100)),
            ("notes".to_string(), Bounds::new(200, 0, 100, 100)),
        ];
        let mut applied: Vec<String> = Vec::new();
        let refused = apply_tidy(&plan, |label, _| {
            if label == "settings" {
                return Err("the platform refused it".to_string());
            }
            applied.push(label.to_string());
            Ok(())
        });

        assert_eq!(
            applied,
            vec!["files".to_string(), "notes".to_string()],
            "the window after the refused one is still laid out"
        );
        assert_eq!(
            refused,
            vec!["settings".to_string()],
            "…and the refused one is named, not swallowed"
        );
    }

    /// A desktop window model with one app's first window registered — the shape the two
    /// `bring_target` cases below need.
    fn state_with_notes() -> WmState {
        let s = WmState::new_for_test(amos_wm::form::FormFactor::Desktop);
        s.register_app("notes").expect("registers notes");
        s
    }

    /// The bring half of [`park_target`]'s rule: a bring is refused by **name**, and the two
    /// ways it can be are the mode being off and the label not being a window we own.
    ///
    /// The negative controls are the second half — a registered label *is* accepted and a
    /// second instance is accepted too, so the assertions above are about which label and not
    /// about `bring_target` refusing everything.
    #[test]
    fn bring_target_refuses_a_disabled_stage_and_an_unregistered_label() {
        let s = state_with_notes();

        let e = bring_target(&s, "notes").expect_err("the mode is off");
        assert_eq!(e.code, ErrorCode::StageDisabled);

        assert!(s.set_stage_enabled(true).unwrap());
        assert!(bring_target(&s, "notes").is_ok(), "a window we own");

        let e = bring_target(&s, "ghost").expect_err("no such window");
        assert_eq!(e.code, ErrorCode::StageWindowUnknown);
    }

    /// REQ-A1706 — the rail draws a tile for an app's **second** window, and that tile's bring
    /// must not be refused *for being a second window*.
    ///
    /// [`views_of`] gives `notes_2` its own rail tile (asserted in
    /// `the_rail_view_follows_the_hidden_state`), so clicking it runs `stage_bring("notes_2")`.
    /// The command used to call [`WmState::open`], which is the *launch* verb: its identity
    /// gate refuses every label that is not an app's first window (REQ-A473), so a second
    /// instance could be parked and then **never brought back** — and because the refusal is a
    /// bare `String`, [`lock`] dressed it as `StageLockFailed` and the user read 「锁失败」 for
    /// a window that was simply a second instance.
    ///
    /// The premise is asserted on the domain that owns the rule — the label really is not an
    /// app's first window — so this test fails if `is_first()` is ever widened to accept it
    /// (at which point the distinction this pins would no longer exist).
    #[test]
    fn a_second_instance_can_be_brought_back_even_though_the_launch_verb_refuses_it() {
        let s = state_with_notes();
        let second = s.register_app_instance("notes").expect("registers notes_2");
        assert_eq!(second, "notes_2", "the identity scheme's own label");
        assert!(s.set_stage_enabled(true).unwrap());

        let identity = amos_wm::identity::identity_of_label(&second).expect("a valid label");
        assert!(
            !identity.is_first(),
            "the premise: '{}' names instance {} of '{}', so the launch verb's gate rejects it",
            second,
            identity.instance,
            identity.app
        );

        // …and the bring path accepts it: the tile the rail drew is a window that comes back.
        assert!(
            bring_target(&s, &second).is_ok(),
            "a second instance is a window on the rail, not an unregistered label"
        );
    }

    /// REQ-A1754 — every face that *describes* the bring verb must name the verb the host
    /// actually calls.
    ///
    /// REQ-A1706 corrected the host from `WmState::open` (the launch verb, whose identity gate
    /// refuses a second instance) to [`WmState::reveal`], and the two **sibling** faces — this
    /// seam's frontend doc and `docs/stage-manager.md` — were not corrected with it. That is the
    /// `project_rule_stated_on_one_accessor_not_applied_to_siblings` shape: the correction landed
    /// on the one face that was being edited and the two that said the same thing kept saying it.
    ///
    /// It is a live hazard, not a cosmetic one: `reveal` really does display-and-focus (it reaches
    /// the same `core.wm.open(id)`), so the stale sentence *reads true* while naming the one verb
    /// that would refuse the `notes_2` tile the rail draws — a future fixer reading the frontend
    /// seam would "restore" the host to `open` and re-break the second instance.
    ///
    /// Why no existing gate sees it: `WmState::open` is a real, resolvable identifier, so
    /// `claim-scan` is correctly indifferent to it; the defect is not the *symbol* but the
    /// *pairing* of the command with the symbol, which no token-resolution pass can judge.
    ///
    /// The assertion is the positive one — each face still names the verb — because the faces
    /// legitimately *mention* `open` to say it is **not** the one used; requiring the absence of
    /// the token would fail on the corrected text this test exists to protect.
    #[test]
    fn every_face_that_describes_the_bring_verb_names_the_verb_the_host_calls() {
        const SEAM: &str = include_str!("../frontend-ts/src/lib/stage.ts");
        const DOC: &str = include_str!("../../../docs/stage-manager.md");

        for (face, src) in [("lib/stage.ts", SEAM), ("docs/stage-manager.md", DOC)] {
            assert!(
                src.contains("WmState::reveal"),
                "{face} no longer names `WmState::reveal` — if the bring verb changed, every \
                 face that describes it must change with the host"
            );
        }

        // Positive control on the other axis: a rewrite that deleted the bring path must not pass
        // by going quiet. These are words each face uses *only* about this command.
        assert!(
            SEAM.contains("stageBring"),
            "lib/stage.ts must still wrap the bring command this test pins"
        );
        assert!(
            DOC.contains("stage_bring"),
            "docs/stage-manager.md must still document the bring command this test pins"
        );
    }

    /// REQ-A1755 — the stored form round-trips: what [`stage_pref_value`] writes,
    /// [`stage_pref_is_on`] reads back as the same boolean (for the one value that is *on*;
    /// the off value is asserted separately because `"0"` is also the negative control).
    #[test]
    fn the_stored_preference_round_trips() {
        assert!(stage_pref_is_on(Some(stage_pref_value(true))));
        assert!(!stage_pref_is_on(Some(stage_pref_value(false))));
    }

    /// The reader accepts the **exact** `"1"` and nothing else: the mode defaults OFF
    /// (§4), so an absent, stale, or garbage value must not turn it on by accident. The
    /// `Some("0")`/`Some("")`/`None` controls are the ones that would catch a reader widened
    /// to `is_some()` or to a truthy parse.
    #[test]
    fn only_the_exact_on_value_means_on() {
        assert!(stage_pref_is_on(Some("1")));
        assert!(!stage_pref_is_on(Some("0")));
        assert!(!stage_pref_is_on(Some("true")));
        assert!(!stage_pref_is_on(Some("")));
        assert!(!stage_pref_is_on(None));
    }

    /// The refusal is a **change** to a store with no backing file — the truth table pins
    /// both axes and, crucially, the no-op row: a toggle that asks for the mode it is already
    /// in stores nothing, so it can never be refused (the guard runs *before* the mode moves,
    /// so a refusal there would reject a no-op the user cannot even perceive).
    #[test]
    fn only_an_unstorable_change_is_refused() {
        // (current, enabled, has_backing_file) -> refused
        assert!(
            !stage_persist_refusal(false, false, false),
            "no-op, no store"
        );
        assert!(!stage_persist_refusal(true, true, false), "no-op, no store");
        assert!(
            !stage_persist_refusal(false, true, true),
            "a change, storable"
        );
        assert!(
            !stage_persist_refusal(true, false, true),
            "a change, storable"
        );
        assert!(
            stage_persist_refusal(false, true, false),
            "a change, unstorable"
        );
        assert!(
            stage_persist_refusal(true, false, false),
            "a change, unstorable"
        );
    }

    /// REQ-A1755 — [`apply_persisted`] is what makes the mode survive a restart. On a class
    /// with a rail a stored `"1"` seeds the flag; every other stored value (absent, `"0"`,
    /// garbage) leaves it OFF. The `"0"` case is the negative control that fails if the
    /// reader is widened to "any stored value".
    #[test]
    fn apply_persisted_seeds_the_flag_from_the_store() {
        let store = SharedStore::memory();
        let s = state_with_notes();

        apply_persisted(&store, &s);
        assert!(!s.stage_enabled().unwrap(), "absent means off");

        store.insert(STAGE_ENABLED_KEY, "0".to_string());
        apply_persisted(&store, &s);
        assert!(!s.stage_enabled().unwrap(), "an explicit off stays off");

        store.insert(STAGE_ENABLED_KEY, "yes".to_string());
        apply_persisted(&store, &s);
        assert!(!s.stage_enabled().unwrap(), "garbage is not on");

        store.insert(STAGE_ENABLED_KEY, "1".to_string());
        apply_persisted(&store, &s);
        assert!(s.stage_enabled().unwrap(), "a stored on comes back on");
    }

    /// The other half of [`apply_persisted`]'s contract: a stored `"1"` on a class whose
    /// policy has **no rail** is refused by [`WmState::set_stage_enabled`] and booted off
    /// with a warning — never fatal to the launch. Without this the reader could only be
    /// trusted on the form factor it was written for.
    #[test]
    fn apply_persisted_boots_off_when_the_class_has_no_rail() {
        let store = SharedStore::memory();
        store.insert(STAGE_ENABLED_KEY, "1".to_string());
        let phone = WmState::new_for_test(amos_wm::form::FormFactor::Phone);

        apply_persisted(&store, &phone);
        assert!(
            !phone.stage_enabled().unwrap(),
            "a phone has no rail to reserve, so the stored preference cannot be honoured"
        );
    }
}
