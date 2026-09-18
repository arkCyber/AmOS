//! Tauri commands for Spaces (virtual desktop) management.
//!
//! Frontend bridge for the SpaceManager, exposing all Space operations
//! as Tauri commands. Each command operates on the global SpaceManager
//! state and persists changes to SharedStore.

use tauri::State;

use crate::error::{AmosError, AmosResult, ErrorCode};
use crate::spaces::{SpaceInfo, SpaceManagerState};
use crate::store::SharedStore;

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

/// Switch to the Space at the given index
#[tauri::command]
pub fn spaces_switch(
    index: usize,
    spaces: State<SpaceManagerState>,
    store: State<SharedStore>,
) -> AmosResult<()> {
    let mut mgr = lock_manager(&spaces)?;
    mgr.switch_space(index)?;
    mgr.save(&store)?;
    Ok(())
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
