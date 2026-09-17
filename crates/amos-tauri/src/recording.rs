//! Call recording storage and metadata.
//!
//! Defines the on-device storage path for recorded calls and provides
//! a metadata index (JSON) for the UI to list/playback recordings.
//!
//! Contract:
//! - Recordings live under `<app_data>/recordings/<call_id>.m4a`
//! - Metadata index at `<app_data>/recordings.json`
//! - The actual audio capture belongs to the audio pipeline (future work)
//! - This module only manages the storage directory and metadata ledger

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// On-device recording root: <app_data>/recordings/
pub fn recording_dir(app_data: &Path) -> PathBuf {
    app_data.join("recordings")
}

/// Recording file path for a call: <recording_dir>/<call_id>.m4a
pub fn recording_path(app_data: &Path, call_id: &str) -> PathBuf {
    recording_dir(app_data).join(format!("{}.m4a", call_id))
}

/// Recording metadata (indexed in recordings.json)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingMeta {
    pub call_id: String,
    pub peer: String,
    pub started_at: i64,
    pub duration_sec: u32,
    pub file_size_bytes: u64,
}

/// Load the recording index from <app_data>/recordings.json
pub fn load_index(app_data: &Path) -> Result<Vec<RecordingMeta>, std::io::Error> {
    let path = app_data.join("recordings.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)?;
    serde_json::from_str(&content)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Save the recording index to <app_data>/recordings.json (atomic write)
pub fn save_index(app_data: &Path, index: &[RecordingMeta]) -> Result<(), std::io::Error> {
    let path = app_data.join("recordings.json");
    let content = serde_json::to_string_pretty(index)?;

    // Atomic write: tmp file + rename (same pattern as blocklist/sms_trash)
    let tmp = app_data.join("recordings.json.tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Add a new recording to the index and save atomically
pub fn add_recording(app_data: &Path, meta: RecordingMeta) -> Result<(), std::io::Error> {
    let mut index = load_index(app_data)?;
    // Deduplicate: if the call_id already exists, replace it
    index.retain(|r| r.call_id != meta.call_id);
    index.push(meta);
    save_index(app_data, &index)
}

/// Remove a recording from the index and delete the file
pub fn remove_recording(app_data: &Path, call_id: &str) -> Result<(), std::io::Error> {
    let mut index = load_index(app_data)?;
    index.retain(|r| r.call_id != call_id);
    save_index(app_data, &index)?;

    // Delete the file (ignore if it doesn't exist)
    let file = recording_path(app_data, call_id);
    if file.exists() {
        std::fs::remove_file(file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_path_uses_call_id() {
        let app_data = PathBuf::from("/data/app");
        let path = recording_path(&app_data, "tel_001");
        assert_eq!(path, PathBuf::from("/data/app/recordings/tel_001.m4a"));
    }

    #[test]
    fn recording_dir_is_under_app_data() {
        let app_data = PathBuf::from("/data/app");
        let dir = recording_dir(&app_data);
        assert_eq!(dir, PathBuf::from("/data/app/recordings"));
    }

    #[test]
    fn empty_index_loads_as_empty_vec() {
        let temp = tempfile::tempdir().unwrap();
        let index = load_index(temp.path()).unwrap();
        assert!(index.is_empty());
    }

    #[test]
    fn roundtrip_preserves_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let meta = vec![RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 120,
            file_size_bytes: 1024000,
        }];
        save_index(temp.path(), &meta).unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].call_id, "tel_001");
        assert_eq!(loaded[0].duration_sec, 120);
    }

    #[test]
    fn add_recording_creates_index_if_missing() {
        let temp = tempfile::tempdir().unwrap();
        let meta = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
        };
        add_recording(temp.path(), meta.clone()).unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], meta);
    }

    #[test]
    fn add_recording_deduplicates_by_call_id() {
        let temp = tempfile::tempdir().unwrap();
        let meta1 = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
        };
        let meta2 = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560120,
            duration_sec: 90,
            file_size_bytes: 768000,
        };
        add_recording(temp.path(), meta1).unwrap();
        add_recording(temp.path(), meta2.clone()).unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], meta2); // Second write wins
    }

    #[test]
    fn remove_recording_updates_index_and_deletes_file() {
        let temp = tempfile::tempdir().unwrap();
        let rec_dir = recording_dir(temp.path());
        std::fs::create_dir_all(&rec_dir).unwrap();

        let meta = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
        };
        add_recording(temp.path(), meta).unwrap();

        // Create a dummy file
        let file = recording_path(temp.path(), "tel_001");
        std::fs::write(&file, b"audio data").unwrap();
        assert!(file.exists());

        // Remove it
        remove_recording(temp.path(), "tel_001").unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert!(loaded.is_empty());
        assert!(!file.exists());
    }

    #[test]
    fn remove_recording_succeeds_if_file_missing() {
        let temp = tempfile::tempdir().unwrap();
        let meta = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
        };
        add_recording(temp.path(), meta).unwrap();
        // File was never created, but remove should still work
        remove_recording(temp.path(), "tel_001").unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert!(loaded.is_empty());
    }
}
