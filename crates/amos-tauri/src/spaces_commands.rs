//! Tauri commands for Spaces (virtual desktop) management.
//!
//! Frontend bridge for the SpaceManager, exposing all Space operations
//! as Tauri commands. Each command operates on the global SpaceManager
//! state and persists changes to SharedStore.

use tauri::{AppHandle, State};

use crate::error::{AmosError, AmosResult, ErrorCode};
use crate::spaces::{SpaceInfo, SpaceManagerState};
use crate::store::SharedStore;
use crate::wm::WmState;

/// 一次空间切换的**结果读数**（REQ-A513）。
///
/// 为什么要有返回值：这个命令以前返回 `()` —— 于是 wire 上是 `null`，而前端的桥约定是
/// "**失败**也返回 `null`"（`lib/backend.invoke` 把错误吞进诊断台账）。两者撞在一起，
/// 前端那 5 个 mutation 包装器判 `result !== null` 就**永远为 false**：切换明明成功，
/// `MissionControl` 不关闭浮层、`SpacesPanel` 直接写一行"切换失败"。
///
/// 同一次改动把另一半也带回来：`apply_switch_plan` 早就把"账本动了、屏幕没动"的窗口
/// 作为 `(label, why)` **返回**给调用方（它的文档写着"由调用方决定多大声"），而这个调用方
/// 以前只把它们写进 `tracing::warn!`。一个用户看得见、别的模块看不见的状态不该只留在日志里。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SpaceSwitchReport {
    /// 切换后的活动桌面索引（与请求一致；成功即生效）。
    pub index: usize,
    /// 账本要求隐藏、但平台没能隐藏的窗口（`(label, 原因)`）。
    pub hide_failed: Vec<SwitchFailure>,
    /// 账本要求带到前台、但平台没能聚焦的窗口（`(label, 原因)`）。
    pub show_failed: Vec<SwitchFailure>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SwitchFailure {
    pub label: String,
    pub reason: String,
}

// One shape used at every Mutex::lock() site — keeps the `code` consistent
// across all 7 commands and lets a future `clippy::else_if_without_else` rule
// stay quiet. The `with_cause` form would be richer, but the inner MutexGuard
// poison error doesn't expose a useful underlying cause today.
fn lock_manager<'a>(
    spaces: &'a State<SpaceManagerState>,
) -> Result<std::sync::MutexGuard<'a, crate::spaces::SpaceManager>, AmosError> {
    spaces.lock().map_err(|e| {
        AmosError::with_cause(
            ErrorCode::SpacesLockFailed,
            "Failed to lock SpaceManager",
            e,
        )
    })
}

/// List all Spaces
#[tauri::command]
pub fn spaces_list(spaces: State<SpaceManagerState>) -> AmosResult<Vec<SpaceInfo>> {
    Ok(lock_manager(&spaces)?.list_spaces())
}

/// Get the index of the currently active Space
#[tauri::command]
pub fn spaces_active(spaces: State<SpaceManagerState>) -> AmosResult<usize> {
    Ok(lock_manager(&spaces)?.active_space())
}

/// Switch to the Space at the given index — **and move the windows** (REQ-A446).
///
/// The ledger half is one assignment; the visible half is the plan
/// [`crate::spaces::SpaceManager::switch_plan`] returns: hide what the destination does not own,
/// reveal what it does. Before this the command only did the first half, so the panel said
/// "桌面 2" while every window stayed exactly where it was — a command reporting an effect it did
/// not have. Each per-window failure is reported and not swallowed, because "the ledger moved it
/// and the screen did not" is the one state the user can see and nobody else can.
#[tauri::command]
pub fn spaces_switch(
    index: usize,
    app: AppHandle,
    wm: State<WmState>,
    spaces: State<SpaceManagerState>,
    store: State<SharedStore>,
) -> AmosResult<SpaceSwitchReport> {
    // The manager lock is released before any platform call: a window operation can block on the
    // OS, and holding the ledger while it does would stall every other Spaces command.
    let (hide, show) = {
        let mut mgr = lock_manager(&spaces)?;
        mgr.switch_space(index)?;
        mgr.save(&store)?;
        mgr.switch_plan()
    };

    // Hide first, then reveal: the destination's windows come forward onto a desktop that is
    // already clear, so what the user sees land is the reveal.
    let failures = apply_switch_plan(
        &hide,
        &show,
        |label| wm.hide(&app, label).map(|_| ()),
        |label| wm.focus(&app, label).map(|_| ()),
    );
    for (_, label, reason) in &failures {
        tracing::warn!(
            space = index,
            window = %label,
            error = %reason,
            "the space switch moved the ledger but not the screen for this window"
        );
    }
    // 台账动了、屏幕没动的那些窗口，**返回**给前端（不只留在日志里）：用户看得见它们，
    // 而壳需要拿到 label 才能说出"哪几个窗口没跟过来"。
    Ok(switch_report(index, failures))
}

/// 失败发生在切换的哪一半（隐藏 / 带到前台）。带着阶段返回，报告才能分栏 ——
/// 从前 `apply_switch_plan` 只回 `(label, reason)`，调用方**无法**知道那一项属于哪一步。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwitchPhase {
    Hide,
    Show,
}

/// 把 `apply_switch_plan` 的失败列表变成**命令的读数**（纯函数）。
///
/// 顺序即尝试顺序；两栏各自保序（`Vec` 不是集合 —— 同一个窗口在同一栏里只可能出现一次）。
fn switch_report(index: usize, failures: Vec<(SwitchPhase, String, String)>) -> SpaceSwitchReport {
    let mut hide_failed = Vec::new();
    let mut show_failed = Vec::new();
    for (phase, label, reason) in failures {
        let entry = SwitchFailure { label, reason };
        match phase {
            SwitchPhase::Hide => hide_failed.push(entry),
            SwitchPhase::Show => show_failed.push(entry),
        }
    }
    SpaceSwitchReport {
        index,
        hide_failed,
        show_failed,
    }
}

/// Make a switch plan visible on the platform and report every label it could not act on as
/// `(phase, label, why)`.
///
/// The two window operations are passed in rather than taken from a `&WmState` on purpose: the
/// command supplies `WmState::hide` / `WmState::focus` (which need the concrete `AppHandle`), while
/// this function — order, failure isolation, reporting — is the part that must be provable without
/// a window server. A label the ledger moved and the screen did not is the one state the user can
/// see and nobody else can, so it is **returned**, never dropped: the caller decides how loud to be.
fn apply_switch_plan<H, S>(
    hide: &[String],
    show: &[String],
    mut do_hide: H,
    mut do_focus: S,
) -> Vec<(SwitchPhase, String, String)>
where
    H: FnMut(&str) -> Result<(), String>,
    S: FnMut(&str) -> Result<(), String>,
{
    let mut failures = Vec::new();
    for label in hide {
        if let Err(e) = do_hide(label) {
            failures.push((SwitchPhase::Hide, label.clone(), e));
        }
    }
    for label in show {
        if let Err(e) = do_focus(label) {
            failures.push((SwitchPhase::Show, label.clone(), e));
        }
    }
    failures
}

/// Create a new Space with the given name
///
/// Returns the ID of the newly created Space
#[tauri::command]
pub fn spaces_create(
    name: String,
    spaces: State<SpaceManagerState>,
    store: State<SharedStore>,
) -> AmosResult<String> {
    let mut mgr = lock_manager(&spaces)?;
    let id = mgr.create_space(name);
    mgr.save(&store)?;
    Ok(id)
}

/// Delete the Space with the given ID
#[tauri::command]
pub fn spaces_delete(
    id: String,
    spaces: State<SpaceManagerState>,
    store: State<SharedStore>,
) -> AmosResult<()> {
    let mut mgr = lock_manager(&spaces)?;
    mgr.delete_space(&id)?;
    mgr.save(&store)?;
    Ok(())
}

/// Move a window to a different Space
#[tauri::command]
pub fn spaces_move_window(
    window_label: String,
    space_id: String,
    spaces: State<SpaceManagerState>,
    store: State<SharedStore>,
) -> AmosResult<()> {
    let mut mgr = lock_manager(&spaces)?;
    mgr.move_window_to_space(&window_label, &space_id)?;
    mgr.save(&store)?;
    Ok(())
}

/// Remove a window from every desktop — the inverse of `spaces_move_window` (REQ-A450).
///
/// A window in **no** Space belongs to every desktop, which is the state `switch_plan` leaves every
/// window in until someone files it. Revealing the window is the one part the plan cannot express:
/// the plan only knows what the *destination* owns, and a window nobody owns is outside it — so
/// after unfiling, the window is shown explicitly (it must be visible **now**, on whichever desktop
/// the user is on).
#[tauri::command]
pub fn spaces_unfile_window(
    window_label: String,
    app: AppHandle,
    wm: State<WmState>,
    spaces: State<SpaceManagerState>,
    store: State<SharedStore>,
) -> AmosResult<()> {
    let changed = {
        let mut mgr = lock_manager(&spaces)?;
        let changed = mgr.unfile_window(&window_label);
        if changed {
            mgr.save(&store)?;
        }
        changed
    };
    if !changed {
        // Nothing was filed, so the ledger did not move: no platform call and no log line. The
        // caller asked for an end state that already holds.
        return Ok(());
    }
    if let Err(e) = wm.focus(&app, &window_label) {
        tracing::warn!(
            window = %window_label,
            error = %e,
            "the window left every desktop but could not be revealed on this one"
        );
    }
    Ok(())
}

/// Rename a Space
#[tauri::command]
pub fn spaces_rename(
    id: String,
    name: String,
    spaces: State<SpaceManagerState>,
    store: State<SharedStore>,
) -> AmosResult<()> {
    let mut mgr = lock_manager(&spaces)?;
    mgr.rename_space(&id, name)?;
    mgr.save(&store)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// REQ-A446 — the applier's contract, exercised without a window server: hides run before
    /// reveals (so what the user sees land is the reveal), one window's failure never stops the
    /// sweep, and **every** failure comes back with the platform's own reason. "The ledger moved it
    /// and the screen did not" is the one state the user can see and nobody else can, so dropping
    /// one silently is exactly the defect this guards.
    #[test]
    fn the_applier_isolates_failures_and_reports_every_one() {
        let did = RefCell::new(Vec::<String>::new());
        let failures = apply_switch_plan(
            &["notes".to_string(), "ghost".to_string(), "mail".to_string()],
            &["files".to_string(), "also-gone".to_string()],
            |label| {
                if label == "ghost" {
                    Err(format!("window '{label}' is not registered"))
                } else {
                    did.borrow_mut().push(format!("hide:{label}"));
                    Ok(())
                }
            },
            |label| {
                if label == "also-gone" {
                    Err(format!("window '{label}' is not registered"))
                } else {
                    did.borrow_mut().push(format!("show:{label}"));
                    Ok(())
                }
            },
        );

        assert_eq!(
            *did.borrow(),
            vec![
                "hide:notes".to_string(),
                // `ghost` failed in between — and `mail` still ran, then the reveals.
                "hide:mail".to_string(),
                "show:files".to_string(),
            ],
            "hides before reveals, and one failure does not stop the sweep"
        );
        assert_eq!(
            failures,
            vec![
                (
                    SwitchPhase::Hide,
                    "ghost".to_string(),
                    "window 'ghost' is not registered".to_string()
                ),
                (
                    SwitchPhase::Show,
                    "also-gone".to_string(),
                    "window 'also-gone' is not registered".to_string()
                ),
            ],
            "both failures are reported **with their phase**, in the order they were attempted"
        );
    }

    /// REQ-A513 — the report splits the failures by half and carries the index. This is the value
    /// the frontend now reads: before it existed the command returned `()`, the wire value was
    /// `null` (the *same* value the bridge uses for a failure), and every mutation wrapper in
    /// `lib/spaces.ts` answered `false` even on success.
    #[test]
    fn the_report_splits_failures_by_half_and_carries_the_index() {
        let report = switch_report(
            2,
            vec![
                (SwitchPhase::Hide, "notes".to_string(), "gone".to_string()),
                (SwitchPhase::Show, "files".to_string(), "gone".to_string()),
                (SwitchPhase::Hide, "mail".to_string(), "gone".to_string()),
            ],
        );
        assert_eq!(report.index, 2);
        assert_eq!(
            report
                .hide_failed
                .iter()
                .map(|f| f.label.as_str())
                .collect::<Vec<_>>(),
            vec!["notes", "mail"],
            "hide failures keep their order and their half"
        );
        assert_eq!(report.show_failed.len(), 1);
        assert_eq!(report.show_failed[0].label, "files");
        assert_eq!(report.show_failed[0].reason, "gone");
    }

    /// The honest shape of a switch that worked: an index and two **empty** lists — not `()`,
    /// which the bridge cannot tell apart from a failure.
    #[test]
    fn a_clean_switch_reports_an_index_and_no_failures() {
        let report = switch_report(0, Vec::new());
        assert_eq!(report.index, 0);
        assert!(report.hide_failed.is_empty());
        assert!(report.show_failed.is_empty());
    }

    /// An empty plan is not an error and touches nothing — the honest result of switching to a
    /// Space whose windows are already where they belong, or of a desktop where nothing is filed.
    #[test]
    fn an_empty_plan_attempts_no_window_operation() {
        let calls = RefCell::new(0usize);
        let failures = apply_switch_plan(
            &[],
            &[],
            |_: &str| {
                *calls.borrow_mut() += 1;
                Ok(())
            },
            |_: &str| {
                *calls.borrow_mut() += 1;
                Ok(())
            },
        );
        assert!(failures.is_empty());
        assert_eq!(*calls.borrow(), 0, "no platform call is made");
    }
}
