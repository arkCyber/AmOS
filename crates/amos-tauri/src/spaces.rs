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

use std::sync::Mutex;
use serde::{Deserialize, Serialize};

use crate::store::SharedStore;
use crate::error::{AmosError, AmosResult, ErrorCode};

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
            AmosError::new(ErrorCode::SpacesSerializationFailed, format!("Spaces serialization failed: {}", e))
        })?;
        store.insert(SPACES_KEY, json);
        Ok(())
    }    /// Get all Spaces
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
                format!("Space index {} out of bounds (have {} spaces)", index, self.spaces.len())
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
                "Cannot delete the last Space"
            ));
        }

        let index = self.spaces.iter().position(|s| s.id == id)
            .ok_or_else(|| AmosError::new(ErrorCode::SpacesNotFound, format!("Space {} not found", id)))?;
        
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
        let target_index = self.spaces.iter().position(|s| s.id == space_id)
            .ok_or_else(|| AmosError::new(ErrorCode::SpacesNotFound, format!("Space {} not found", space_id)))?;
        
        // Remove window from all Spaces
        for space in &mut self.spaces {
            space.windows.retain(|w| w != window_label);
        }
        
        // Add to target Space
        self.spaces[target_index].windows.push(window_label.to_string());
        
        Ok(())
    }
    
    /// Rename a Space
    pub fn rename_space(&mut self, id: &str, name: String) -> AmosResult<()> {
        let space = self.spaces.iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| AmosError::new(ErrorCode::SpacesNotFound, format!("Space {} not found", id)))?;
        
        space.name = name;
        Ok(())
    }
    
    /// Get the Space that contains the given window
    pub fn space_for_window(&self, window_label: &str) -> Option<&Space> {
        self.spaces.iter().find(|s| s.windows.contains(&window_label.to_string()))
    }
    
    /// Get windows in the currently active Space
    pub fn active_space_windows(&self) -> &[String] {
        &self.spaces[self.active_index].windows
    }
    
    /// Check if a window belongs to the active Space
    pub fn is_window_in_active_space(&self, window_label: &str) -> bool {
        self.spaces[self.active_index].windows.contains(&window_label.to_string())
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
            return Err(serde::de::Error::custom("SpaceManager must have at least one Space"));
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

    let e = mgr.move_window_to_space("settings", "space-bogus").unwrap_err();
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
}
