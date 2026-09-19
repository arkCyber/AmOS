//! Virtual desktop (Spaces) management for AmOS Desktop.
//!
//! Provides multiple virtual desktops with independent window sets, similar to
//! macOS Spaces or Windows Virtual Desktops. Each Space maintains its own
//! collection of windows, allowing users to organize their workspace by context
//! (work, personal, development, etc.).
//!
//! ## Architecture
//!
//! - `SpaceManager`: Core state machine managing all Spaces and window assignments
//! - Integration with `wm.rs`: Windows are tagged with their Space ID
//! - Persistence: Space configuration saved to SharedStore
//! - Frontend bridge: Tauri commands for Space operations
//!
//! ## REQ-SPACES: Virtual Desktop Management
//!
//! Planned implementation: Q1 2027 → **Now in progress**
//! See: docs/SPACES_IMPLEMENTATION_PLAN.md

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::error::{AmosError, AmosResult, ErrorCode};
use crate::store::SharedStore;

/// Storage key for Spaces configuration in SharedStore
const SPACES_KEY: &str = "amos.desktop.spaces";

/// A virtual desktop (Space) containing a set of windows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Space {
    /// Unique identifier for this Space
    pub id: String,

    /// User-visible name (editable)
    pub name: String,

    /// Window labels belonging to this Space
    pub windows: Vec<String>,
}

impl Space {
    /// Create a new Space with the given ID and name
    pub fn new(id: String, name: String) -> Self {
        Self {
            id,
            name,
            windows: Vec::new(),
        }
    }
}

/// Serializable Space info for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceInfo {
    pub id: String,
    pub name: String,
    pub windows: Vec<String>,
}

impl From<&Space> for SpaceInfo {
    fn from(space: &Space) -> Self {
        Self {
            id: space.id.clone(),
            name: space.name.clone(),
            windows: space.windows.clone(),
        }
    }
}

/// Manager for all virtual desktops (Spaces)
#[derive(Debug)]
pub struct SpaceManager {
    /// All Spaces, indexed by ID
    spaces: Vec<Space>,

    /// Index of the currently active Space (0-based)
    active_index: usize,

    /// Next auto-increment ID for new Spaces
    next_id: usize,
}

impl SpaceManager {
    /// Create a new SpaceManager with a single default Space
    pub fn new() -> Self {
        let default_space = Space::new("space-0".to_string(), "桌面 1".to_string());

        Self {
            spaces: vec![default_space],
            active_index: 0,
            next_id: 1,
        }
    }

    /// Load SpaceManager from SharedStore, or create default if not found
    pub fn load(store: &SharedStore) -> Self {
        match store.get(SPACES_KEY) {
            Some(json) => {
                // Try to deserialize; fall back to default on error
                serde_json::from_str::<SpaceManager>(&json).unwrap_or_else(|_| {
                    tracing::warn!("[Spaces] Failed to deserialize, using default");
                    Self::new()
                })
            }
            None => Self::new(),
        }
    }

    /// Save SpaceManager to SharedStore
    pub fn save(&self, store: &SharedStore) -> AmosResult<()> {
        let json = serde_json::to_string(self).map_err(|e| {
            AmosError::new(
                ErrorCode::SpacesSerializationFailed,
                format!("Spaces serialization failed: {}", e),
            )
        })?;
        store.insert(SPACES_KEY, json);
        Ok(())
    }
    /// Get all Spaces
    pub fn list_spaces(&self) -> Vec<SpaceInfo> {
        self.spaces.iter().map(SpaceInfo::from).collect()
    }

    /// Get the currently active Space index
    pub fn active_space(&self) -> usize {
        self.active_index
    }

    /// Switch to the Space at the given index
    ///
    /// Returns `Err` if the index is out of bounds
    pub fn switch_space(&mut self, index: usize) -> AmosResult<()> {
        if index >= self.spaces.len() {
            return Err(AmosError::new(
                ErrorCode::SpacesIndexOutOfBounds,
                format!(
                    "Space index {} out of bounds (have {} spaces)",
                    index,
                    self.spaces.len()
                ),
            ));
        }

        self.active_index = index;
        Ok(())
    }

    /// Create a new Space with the given name
    ///
    /// Returns the ID of the newly created Space
    pub fn create_space(&mut self, name: String) -> String {
        let id = format!("space-{}", self.next_id);
        self.next_id += 1;

        let space = Space::new(id.clone(), name);
        self.spaces.push(space);

        id
    }

    /// Delete the Space with the given ID
    ///
    /// Returns `Err` if:
    /// - The Space doesn't exist
    /// - Trying to delete the last remaining Space
    pub fn delete_space(&mut self, id: &str) -> AmosResult<()> {
        if self.spaces.len() <= 1 {
            return Err(AmosError::new(
                ErrorCode::SpacesDeleteLast,
                "Cannot delete the last Space",
            ));
        }

        let index = self.spaces.iter().position(|s| s.id == id).ok_or_else(|| {
            AmosError::new(ErrorCode::SpacesNotFound, format!("Space {} not found", id))
        })?;

        // Remove the Space
        self.spaces.remove(index);

        // Adjust active_index if necessary
        if self.active_index >= self.spaces.len() {
            self.active_index = self.spaces.len() - 1;
        } else if self.active_index > index {
            self.active_index -= 1;
        }

        Ok(())
    }

    /// Move a window to a different Space
    ///
    /// Removes the window from its current Space (if any) and adds it to the target Space
    pub fn move_window_to_space(&mut self, window_label: &str, space_id: &str) -> AmosResult<()> {
        // Find the target Space
        let target_index = self
            .spaces
            .iter()
            .position(|s| s.id == space_id)
            .ok_or_else(|| {
                AmosError::new(
                    ErrorCode::SpacesNotFound,
                    format!("Space {} not found", space_id),
                )
            })?;

        // Remove window from all Spaces
        for space in &mut self.spaces {
            space.windows.retain(|w| w != window_label);
        }

        // Add to target Space
        self.spaces[target_index]
            .windows
            .push(window_label.to_string());

        Ok(())
    }

    /// Take a window out of **every** Space (REQ-A450) — the inverse of [`Self::move_window_to_space`],
    /// which can only move a window *between* Spaces.
    ///
    /// A window listed in no Space belongs to **every** Space (see [`Self::switch_plan`]): that is
    /// the state every window starts in, and the reason an unfiled window is never hidden. Without
    /// this method a window filed by mistake could only ever be moved to *another* desktop — never
    /// back — so the feature's own initial state was a **one-way door**, and the panel could only
    /// draw it as a placeholder it refused to accept.
    ///
    /// **Idempotent by design**: unfiling a window nothing has filed is not an error, because the
    /// caller is asking for an end state and that state already holds. Returns whether the ledger
    /// actually changed, so the caller can skip the platform work when it did not.
    pub fn unfile_window(&mut self, window_label: &str) -> bool {
        let mut changed = false;
        for space in &mut self.spaces {
            let before = space.windows.len();
            space.windows.retain(|w| w != window_label);
            changed |= space.windows.len() != before;
        }
        changed
    }

    /// Rename a Space
    pub fn rename_space(&mut self, id: &str, name: String) -> AmosResult<()> {
        let space = self.spaces.iter_mut().find(|s| s.id == id).ok_or_else(|| {
            AmosError::new(ErrorCode::SpacesNotFound, format!("Space {} not found", id))
        })?;

        space.name = name;
        Ok(())
    }

    /// Get the Space that contains the given window
    pub fn space_for_window(&self, window_label: &str) -> Option<&Space> {
        self.spaces
            .iter()
            .find(|s| s.windows.contains(&window_label.to_string()))
    }

    /// Get windows in the currently active Space
    pub fn active_space_windows(&self) -> &[String] {
        &self.spaces[self.active_index].windows
    }

    /// Check if a window belongs to the active Space
    pub fn is_window_in_active_space(&self, window_label: &str) -> bool {
        self.spaces[self.active_index]
            .windows
            .contains(&window_label.to_string())
    }

    /// The window work a switch to the **active** Space implies (REQ-A446): the labels that must
    /// disappear and the ones that must appear. Call it *after* [`Self::switch_space`], which is
    /// what makes "active" mean the destination.
    ///
    /// Until this existed the ledger was the whole feature: `switch_space` moved `active_index`,
    /// `SpacesPanel` showed the new desktop as current, and **every window stayed exactly where it
    /// was** — a switch that says it did something it did not do. These three semantics are stated
    /// here because a list of labels cannot express them, and the honest ones are not the
    /// convenient ones:
    ///
    ///   * a window listed in **no** Space belongs to **every** Space and is never touched. The
    ///     only way a window joins a Space is an explicit `move_window_to_space`, so an unassigned
    ///     window is not an oversight — it is a window nobody has filed yet, and hiding unfiled
    ///     windows would blank a desktop the first time this feature is turned on;
    ///   * the **screen window** (the Launcher, `crate::wm::is_screen_window`) is neither hidden
    ///     nor focused: it *is* the desktop, so hiding it leaves the user with no surface to click,
    ///     and focusing it would take the keyboard away from the app the user just returned to;
    ///   * a label filed under two Spaces is shown in the Space that owns it and hidden only when
    ///     the destination does not, so `hide` and `show` never name the same window.
    pub fn switch_plan(&self) -> (Vec<String>, Vec<String>) {
        let show: Vec<String> = self
            .active_space_windows()
            .iter()
            .filter(|label| !crate::wm::is_screen_window(label))
            .cloned()
            .collect();
        let mut hide: Vec<String> = Vec::new();
        for space in &self.spaces {
            for label in &space.windows {
                if self.is_window_in_active_space(label) || crate::wm::is_screen_window(label) {
                    continue;
                }
                if !hide.contains(label) {
                    hide.push(label.clone());
                }
            }
        }
        (hide, show)
    }
}

impl Default for SpaceManager {
    fn default() -> Self {
        Self::new()
    }
}

// Implement Serialize/Deserialize for SpaceManager
impl Serialize for SpaceManager {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("SpaceManager", 3)?;
        state.serialize_field("spaces", &self.spaces)?;
        state.serialize_field("active_index", &self.active_index)?;
        state.serialize_field("next_id", &self.next_id)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for SpaceManager {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct SpaceManagerData {
            spaces: Vec<Space>,
            active_index: usize,
            next_id: usize,
        }

        let data = SpaceManagerData::deserialize(deserializer)?;

        // Validate: must have at least one Space
        if data.spaces.is_empty() {
            return Err(serde::de::Error::custom(
                "SpaceManager must have at least one Space",
            ));
        }

        // Validate: active_index must be valid
        if data.active_index >= data.spaces.len() {
            return Err(serde::de::Error::custom("Invalid active_index"));
        }

        Ok(Self {
            spaces: data.spaces,
            active_index: data.active_index,
            next_id: data.next_id,
        })
    }
}

/// Global SpaceManager instance
pub type SpaceManagerState = Mutex<SpaceManager>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_manager_has_default_space() {
        let mgr = SpaceManager::new();
        assert_eq!(mgr.spaces.len(), 1);
        assert_eq!(mgr.spaces[0].id, "space-0");
        assert_eq!(mgr.spaces[0].name, "桌面 1");
        assert_eq!(mgr.active_index, 0);
    }

    #[test]
    fn create_space_increments_id() {
        let mut mgr = SpaceManager::new();
        let id1 = mgr.create_space("工作".to_string());
        let id2 = mgr.create_space("个人".to_string());

        assert_eq!(id1, "space-1");
        assert_eq!(id2, "space-2");
        assert_eq!(mgr.spaces.len(), 3);
    }

    #[test]
    fn switch_space_changes_active() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("Space 2".to_string());

        assert_eq!(mgr.active_space(), 0);
        mgr.switch_space(1).unwrap();
        assert_eq!(mgr.active_space(), 1);
    }

    #[test]
    fn switch_space_out_of_bounds_fails() {
        let mut mgr = SpaceManager::new();
        let result = mgr.switch_space(5);
        assert!(result.is_err());
    }

    #[test]
    fn cannot_delete_last_space() {
        let mut mgr = SpaceManager::new();
        let result = mgr.delete_space("space-0");
        assert!(result.is_err());
    }

    #[test]
    fn delete_space_adjusts_active_index() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("Space 2".to_string());
        mgr.create_space("Space 3".to_string());
        mgr.switch_space(2).unwrap();

        // Delete the middle Space
        mgr.delete_space("space-1").unwrap();

        // Active index should be adjusted
        assert_eq!(mgr.spaces.len(), 2);
        assert_eq!(mgr.active_index, 1);
    }

    #[test]
    fn move_window_removes_from_old_space() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("Space 2".to_string());

        // Add window to first Space
        mgr.spaces[0].windows.push("settings".to_string());

        // Move to second Space
        mgr.move_window_to_space("settings", "space-1").unwrap();

        assert!(!mgr.spaces[0].windows.contains(&"settings".to_string()));
        assert!(mgr.spaces[1].windows.contains(&"settings".to_string()));
    }

    #[test]
    fn serialize_deserialize_roundtrip() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("工作".to_string());
        mgr.switch_space(1).unwrap();

        let json = serde_json::to_string(&mgr).unwrap();
        let restored: SpaceManager = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.spaces.len(), mgr.spaces.len());
        assert_eq!(restored.active_index, mgr.active_index);
        assert_eq!(restored.next_id, mgr.next_id);
    }

    /// REQ-A297 phase-2 follow-up: every Spaces failure surface must carry a
    /// `spaces.*` code, not the borrowed `amos.sms.blank_id` (which would let a
    /// UI branch on "blank id" for an unrelated failure). One sample per
    /// documented code keeps the contract pinned.
    #[test]
    fn every_space_failure_uses_a_spaces_code() {
        let mut mgr = SpaceManager::new();

        // Out-of-bounds switch
        let e = mgr.switch_space(99).unwrap_err();
        assert_eq!(e.code(), "amos.spaces.index_out_of_bounds", "switch OOB");

        // Delete-last refusal (current manager has 1 space, so any delete → refuse)
        let e = mgr.delete_space("space-0").unwrap_err();
        assert_eq!(e.code(), "amos.spaces.delete_last");

        // Unknown id on delete / move_window / rename needs a populated manager
        // (so the delete-last guard doesn't shadow the not-found path).
        mgr.create_space("工作".into());

        let e = mgr.delete_space("space-bogus").unwrap_err();
        assert_eq!(e.code(), "amos.spaces.not_found");

        let e = mgr
            .move_window_to_space("settings", "space-bogus")
            .unwrap_err();
        assert_eq!(e.code(), "amos.spaces.not_found");

        let e = mgr.rename_space("space-bogus", "x".into()).unwrap_err();
        assert_eq!(e.code(), "amos.spaces.not_found");

        // Group collapses — every Spaces variant must map to "spaces" so a single
        // tracing filter scopes the entire surface.
        use crate::error::ErrorCode::*;
        assert_eq!(SpacesLockFailed.group(), "spaces");
        assert_eq!(SpacesSerializationFailed.group(), "spaces");
        assert_eq!(SpacesNotFound.group(), "spaces");
        assert_eq!(SpacesIndexOutOfBounds.group(), "spaces");
        assert_eq!(SpacesDeleteLast.group(), "spaces");
    }

    /// REQ-A446 — the switch must name the windows to move, not just the index. Before
    /// `switch_plan` the whole feature was the ledger: `spaces_switch` changed a number, the
    /// panel drew the new desktop as current, and every window stayed on screen.
    #[test]
    fn a_switch_plan_names_the_windows_that_change_side() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("工作".to_string());
        mgr.move_window_to_space("files", "space-0").unwrap();
        mgr.move_window_to_space("notes", "space-1").unwrap();

        let (hide, show) = mgr.switch_plan();
        assert_eq!(
            hide,
            vec!["notes".to_string()],
            "the other Space's window goes"
        );
        assert_eq!(show, vec!["files".to_string()], "this Space's window comes");

        mgr.switch_space(1).unwrap();
        let (hide, show) = mgr.switch_plan();
        assert_eq!(hide, vec!["files".to_string()]);
        assert_eq!(show, vec!["notes".to_string()]);
    }

    /// A window nobody filed is in **every** Space. The alternative (hide anything unfiled) would
    /// blank a desktop the first time Spaces is used, so it is pinned here rather than left to the
    /// reader of the loop.
    #[test]
    fn a_window_in_no_space_is_never_touched_by_a_switch() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("工作".to_string());
        mgr.move_window_to_space("notes", "space-1").unwrap();
        mgr.move_window_to_space("files", "space-0").unwrap();

        mgr.switch_space(1).unwrap();
        let (hide, show) = mgr.switch_plan();
        assert_eq!(hide, vec!["files".to_string()]);
        assert!(
            !hide.contains(&"settings".to_string()) && !show.contains(&"settings".to_string()),
            "an unfiled window is not named by either list"
        );
    }

    /// The screen window is the surface the Spaces live on, so a ledger that files it under
    /// another Space must not be able to hide the desktop — or to have the switch steal the
    /// keyboard back to it.
    #[test]
    fn the_screen_window_is_neither_hidden_nor_focused_by_a_switch() {
        const SCREEN: &str = "main";
        assert!(
            crate::wm::is_screen_window(SCREEN),
            "the label this test files away must be the screen window"
        );
        let mut mgr = SpaceManager::new();
        mgr.create_space("工作".to_string());
        mgr.move_window_to_space(SCREEN, "space-1").unwrap();

        let (hide, show) = mgr.switch_plan();
        assert!(hide.is_empty(), "the desktop is never hidden: {hide:?}");
        assert!(show.is_empty(), "and never focused: {show:?}");
    }

    /// A window may be filed under two Spaces at once. It belongs to the destination if either
    /// entry owns it, and it is never in both lists — a plan that hides and shows one label would
    /// leave the screen depending on the order the two loops ran.
    #[test]
    fn a_window_in_two_spaces_is_revealed_and_never_both() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("工作".to_string());
        mgr.move_window_to_space("files", "space-0").unwrap();
        // Filed again under the second Space *without* the first entry being corrected — the state
        // `move_window_to_space` cannot produce, but a hand-edited store can.
        mgr.spaces[1].windows.push("files".to_string());

        let (hide, show) = mgr.switch_plan();
        assert_eq!(show, vec!["files".to_string()]);
        assert!(
            hide.is_empty(),
            "the destination owns it, so it is not hidden"
        );
    }

    /// REQ-A450 — the inverse of `move_window_to_space`. Without it the feature's own initial state
    /// ("nobody has filed this window") was unreachable, so a window filed by mistake was stuck on
    /// some desktop forever.
    #[test]
    fn unfiling_takes_a_window_out_of_every_space() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("工作".to_string());
        mgr.move_window_to_space("files", "space-0").unwrap();
        // The degenerate state a hand-edited store can hold: filed under two Spaces at once.
        mgr.spaces[1].windows.push("files".to_string());
        mgr.move_window_to_space("notes", "space-1").unwrap();

        assert!(mgr.unfile_window("files"), "the ledger changed");
        assert!(
            mgr.spaces
                .iter()
                .all(|s| !s.windows.contains(&"files".to_string())),
            "every Space let it go, not just the first one found"
        );
        assert!(
            mgr.spaces[1].windows.contains(&"notes".to_string()),
            "another window's filing is untouched"
        );
    }

    /// Idempotent: the caller asks for an end state, and "not filed anywhere" already holds. The
    /// `false` return is what lets the command skip the platform work (and stay quiet).
    #[test]
    fn unfiling_a_window_nobody_filed_changes_nothing() {
        let mut mgr = SpaceManager::new();
        mgr.move_window_to_space("files", "space-0").unwrap();

        assert!(!mgr.unfile_window("settings"), "nothing to unfile");
        assert_eq!(
            mgr.active_space_windows(),
            &["files".to_string()],
            "the ledger is untouched"
        );
    }

    /// The property that makes "unfiled" honest: an unfiled window is named by **neither** list of
    /// the switch plan, which is why it stays on screen on every desktop.
    #[test]
    fn an_unfiled_window_is_never_named_by_a_switch_plan() {
        let mut mgr = SpaceManager::new();
        mgr.create_space("工作".to_string());
        mgr.move_window_to_space("files", "space-0").unwrap();
        mgr.move_window_to_space("notes", "space-1").unwrap();
        assert!(mgr.unfile_window("notes"));

        let (hide, show) = mgr.switch_plan();
        assert_eq!(show, vec!["files".to_string()]);
        assert!(
            !hide.contains(&"notes".to_string()),
            "the window belongs to every desktop now, so a switch must not hide it: {hide:?}"
        );
    }
}
