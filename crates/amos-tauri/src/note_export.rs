//! Notes export — write note text to a `.txt` file on disk.
//!
//! Cross-layer bridge for the Notes app's "export / share" action: the frontend
//! renders the notes to plain text and asks this command to persist it. The write
//! target directory is `$AMOS_EXPORT_DIR` when set (on Android point it at the
//! app's external files dir so the file is user-visible), else a stable
//! `amos-exports` subdir under the system temp dir. Honest boundary: surfacing a
//! *system* share sheet (Android SAF / `ACTION_SEND`) needs the Kotlin glue +
//! a real device and is not faked here — the command returns the on-disk path so
//! the UI can at least show where the file landed (or fall back to the clipboard).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Upper bound on a single exported `.txt` (1 MiB — comfortably larger than any
/// note while keeping the WebView IPC + file write cheap).
const MAX_TEXT_BYTES: u64 = 1 << 20;

/// Result of a successful export, returned to the WebView.
#[derive(Serialize)]
pub struct ExportOutcome {
    pub name: String,
    pub path: String,
    pub bytes: usize,
}

/// Directory for exports: `$AMOS_EXPORT_DIR`, else `<tmp>/amos-exports`.
fn export_dir() -> PathBuf {
    if let Some(p) = env::var("AMOS_EXPORT_DIR").ok().filter(|s| !s.is_empty()) {
        return PathBuf::from(p);
    }
    env::temp_dir().join("amos-exports")
}

/// Keep only filesystem-safe characters in a suggested basename: letters, digits,
/// `-`, `_`, `.` and CJK (Chinese note titles), everything else → `_`. Falls back
/// to `notes` when nothing survives. Never returns a path separator or an empty
/// string. Pure + testable.
fn sanitize_base(base: &str) -> String {
    let cleaned: String = base
        .trim()
        .chars()
        .map(|c| {
            let keep = c.is_ascii_alphanumeric()
                || c == '-'
                || c == '_'
                || c == '.'
                || ('\u{4e00}'..='\u{9fff}').contains(&c);
            if keep {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '_' || c == '.');
    if trimmed.is_empty() {
        "notes".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Write `text` to `dir/<base>.txt`, creating `dir` as needed. Appends `.txt`
/// unless the sanitised name already carries it. Pure + unit-tested.
fn write_txt(dir: &Path, base: &str, text: &str) -> Result<(PathBuf, usize), String> {
    if text.len() as u64 > MAX_TEXT_BYTES {
        return Err(format!(
            "export too large ({} bytes, limit {} KiB)",
            text.len(),
            MAX_TEXT_BYTES >> 10
        ));
    }
    let stem = sanitize_base(base);
    let name = if stem.to_ascii_lowercase().ends_with(".txt") {
        stem
    } else {
        format!("{stem}.txt")
    };
    fs::create_dir_all(dir).map_err(|e| format!("cannot create export dir: {e}"))?;
    let path = dir.join(&name);
    fs::write(&path, text).map_err(|e| format!("cannot write export: {e}"))?;
    let bytes = text.len();
    Ok((path, bytes))
}

/// Tauri command: persist `name` + `text` as a `.txt` in the export dir.
#[tauri::command]
pub fn notes_export_txt(name: String, text: String) -> Result<ExportOutcome, String> {
    let dir = export_dir();
    let (path, bytes) = write_txt(&dir, &name, &text)?;
    Ok(ExportOutcome {
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "amos-note-export-{tag}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn sanitize_removes_separators_and_keeps_cjk() {
        assert_eq!(sanitize_base("备忘录-2026-09-06"), "备忘录-2026-09-06");
        assert_eq!(sanitize_base("../etc/passwd"), "etc_passwd");
        assert_eq!(sanitize_base("a/b\\c:d?e*f"), "a_b_c_d_e_f");
        assert_eq!(sanitize_base("   "), "notes");
        assert_eq!(sanitize_base("已经带扩展名.txt"), "已经带扩展名.txt");
    }

    #[test]
    fn write_txt_persists_and_appends_txt() {
        let dir = temp_dir("write");
        let (path, bytes) = write_txt(&dir, "备忘录-2026-09-06", "买牛奶\n鸡蛋").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "买牛奶\n鸡蛋");
        assert_eq!(bytes, "买牛奶\n鸡蛋".len());
        assert!(path.to_string_lossy().ends_with(".txt"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_txt_does_not_double_the_extension() {
        let dir = temp_dir("ext");
        let (path, _) = write_txt(&dir, "notes.txt", "x").unwrap();
        let fname = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(fname, "notes.txt", "no double extension");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_export_is_rejected() {
        let dir = temp_dir("big");
        let big = "x".repeat(MAX_TEXT_BYTES as usize + 1);
        assert!(write_txt(&dir, "notes", &big).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn command_returns_outcome_or_err() {
        // export_dir() honours AMOS_EXPORT_DIR; the command itself just wraps
        // write_txt. Sanitisation + limits are covered above; here we sanity-check
        // that a realistic payload round-trips through write_txt + outcome shape.
        let dir = temp_dir("cmd");
        let (path, bytes) = write_txt(&dir, "备忘录", "正文").unwrap();
        assert!(path.exists());
        assert_eq!(bytes, "正文".len());
        let _ = fs::remove_dir_all(&dir);
    }
}
