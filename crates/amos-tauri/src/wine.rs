//! `wine` — Windows apps under Wine, as a **host-owned** listing + launch surface.
//!
//! Commands:
//!   * `wine_is_available` — is `wine` on this host's `PATH`?
//!   * `wine_apps` — the Windows apps the host itself found in the Wine prefixes
//!   * `wine_launch(id)` — run one of **those** apps
//!
//! Two rules this module follows, both learned the hard way elsewhere in this repo:
//!
//! 1. **Availability is a runtime fact, never a `cfg`.** The module compiles on
//!    every desktop target and answers `wine_is_available()` at runtime — the same
//!    rule `amos-wm::form` applies to "phone vs tablet" (one compiled target, two
//!    devices). The first version of this file was registered in `lib.rs` under
//!    `#[cfg(target_os = "darwin")]`, which is not a `target_os` value at all
//!    (`macos` is): the commands were **never registered**, and
//!    `scripts/tauri-command-scan.mjs` reported all six as unreachable.
//! 2. **The launch path is a trust boundary.** `wine_launch` used to take an
//!    `exe_path: String` from the WebView and run `wine <it>`, so any script inside
//!    any WebView (a third-party web bundle runs in one) could hand us an arbitrary
//!    path. It now takes the **id of an app this host enumerated** and refuses
//!    everything else — the caller can address the menu, not the filesystem.
//!
//! Honest boundaries: "no Wine installed" is not an error (the UI shows an empty
//! state); the listing reads real `.desktop` entries out of the prefixes and
//! **invents nothing**; whatever it could not read (oversized entries, the depth
//! and file caps, unreadable directories) is counted in the log instead of being
//! silently absent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::desktop_entry::{self, Argv};

/// One Windows application Wine can run, as found by this host.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WineApp {
    /// Stable identifier: the entry's file stem, or the exe's own stem. This is the
    /// **only** thing `wine_launch` accepts.
    pub id: String,
    /// Display name from the entry (`Name=`).
    pub name: String,
    /// The path the entry declares for the executable (Windows-style
    /// `C:\…\app.exe`, or the `/unix` path Wine itself writes), verbatim.
    pub exe_path: String,
    /// The `.desktop` file this came from (diagnosis), else the exe path's parent.
    pub desktop_path: Option<String>,
    /// The `WINEPREFIX` this app belongs to: the entry's own when its `Exec=`
    /// carried one, otherwise the prefix that was scanned.
    pub prefix: Option<String>,
}

/// Longest id this host will echo back to a caller (characters). Ids come from file
/// names, and an error message must not become a data sink.
const MAX_ECHOED_ID_CHARS: usize = 64;

/// Is `wine` on `PATH`? (`wine --version`, exit status only.)
pub fn wine_available() -> bool {
    Command::new("wine")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Wine prefixes to scan, in order.
///
/// `None` for the home directory is **not** replaced by an empty path: the first
/// version used `unwrap_or_default()`, which quietly turned `~/.wine` into the
/// *relative* `./.wine` and would have listed apps out of whatever directory the
/// host happened to be started in.
fn wine_prefix_dirs() -> Option<Vec<PathBuf>> {
    let home = dirs::home_dir()?;
    Some(vec![
        home.join(".wine"),
        home.join("Library/Application Support/Wine/prefixes/default"),
    ])
}

/// The `Start Menu/Programs` trees inside one prefix.
fn start_menu_dirs(prefix: &Path) -> Vec<PathBuf> {
    [
        "drive_c/users/Public/Start Menu/Programs",
        "drive_c/users/Shared/Start Menu/Programs",
        "drive_c/programdata/Microsoft/Windows/Start Menu/Programs",
        "drive_c/ProgramData/Microsoft/Windows/Start Menu/Programs",
    ]
    .iter()
    .map(|sub| prefix.join(sub))
    .collect()
}

/// The executable token of a Wine entry: the first token that names a `.exe`.
///
/// Wine writes both forms — `wine start /unix /home/me/.wine/drive_c/…/a.exe` and
/// `wine "C:\Program Files\…\a.exe"` — and in both the exe is the token carrying
/// the extension. `None` (no `.exe` token) means we cannot say what to run, so the
/// entry is not listed rather than shown with a launch that would fail.
fn exe_token(argv: &Argv) -> Option<String> {
    argv.args
        .iter()
        .chain(std::iter::once(&argv.program))
        .find(|t| t.to_ascii_lowercase().ends_with(".exe"))
        .cloned()
}

/// A stable, bounded id from a file stem (falling back to the exe's stem).
fn id_of(path: &Path, exe: &str) -> Option<String> {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .or_else(|| {
            Path::new(exe)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })?;
    let cleaned: String = stem
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(MAX_ECHOED_ID_CHARS)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Read one entry and turn it into a `WineApp`, or say why it is not one.
fn app_from_entry(path: &Path, prefix: &Path) -> Result<WineApp, String> {
    let text = desktop_entry::read_bounded(path)?;
    let entry = desktop_entry::parse(&text).ok_or("no usable [Desktop Entry] group")?;
    if !entry.is_launchable_app() {
        return Err("not a launchable Application entry".to_string());
    }
    let raw = desktop_entry::argv(&entry.exec).ok_or("Exec= has no program")?;
    let (vars, argv) = desktop_entry::env_prefix(&raw);
    let exe = exe_token(&argv).ok_or("Exec= names no .exe")?;
    let id = id_of(path, &exe).ok_or("no usable id")?;
    let declared = vars
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("WINEPREFIX"))
        .map(|(_, v)| v.clone());
    Ok(WineApp {
        id,
        name: entry.name,
        exe_path: exe,
        desktop_path: path.to_str().map(str::to_string),
        // No WINEPREFIX in the entry: the prefix we are scanning *is* the one the
        // app belongs to, so say so instead of leaving Wine to guess a default.
        prefix: declared.or_else(|| prefix.to_str().map(str::to_string)),
    })
}

/// Every Wine app this host can find: deduplicated by executable (the same app
/// appears under several start-menu trees), capped, and honest about what it could
/// not read.
fn list_apps() -> Vec<WineApp> {
    let Some(prefixes) = wine_prefix_dirs() else {
        tracing::warn!(
            target: "amos::wine",
            "no home directory; Wine prefixes cannot be located"
        );
        return Vec::new();
    };

    let mut apps: Vec<WineApp> = Vec::new();
    let mut seen_exe: HashSet<String> = HashSet::new();
    let mut unreadable_dirs = 0usize;
    let mut skipped_entries = 0usize;

    for prefix in prefixes.iter().filter(|p| p.is_dir()) {
        let scan = desktop_entry::scan_desktop_files(&start_menu_dirs(prefix));
        unreadable_dirs += scan.unreadable_dirs;
        skipped_entries += scan.skipped_depth + scan.skipped_cap;
        for file in scan.files {
            match app_from_entry(&file, prefix) {
                Ok(app) => {
                    if seen_exe.insert(app.exe_path.clone()) {
                        apps.push(app);
                    }
                }
                Err(_) => skipped_entries += 1,
            }
        }
    }

    if unreadable_dirs > 0 || skipped_entries > 0 {
        tracing::info!(
            target: "amos::wine",
            unreadable_dirs,
            skipped_entries,
            listed = apps.len(),
            "wine_apps: some entries were not listed (see the counters)"
        );
    }
    apps
}

/// Resolve an id this host itself listed. `Err` names the reason.
fn app_by_id(id: &str) -> Result<WineApp, String> {
    if id.is_empty() || id.chars().count() > MAX_ECHOED_ID_CHARS {
        return Err("unknown app id".to_string());
    }
    list_apps()
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("no Wine app with id '{id}' is installed"))
}

/// Run one enumerated app.
///
/// `id` must come from [`list_apps`] — this function never takes a path, which is
/// what keeps a WebView from naming an executable.
fn launch(id: &str) -> Result<String, String> {
    if !wine_available() {
        return Err("Wine is not installed on this host".to_string());
    }
    let app = app_by_id(id)?;

    let mut cmd = Command::new("wine");
    if let Some(prefix) = app.prefix.as_deref() {
        cmd.env("WINEPREFIX", prefix);
    }
    // The child outlives this call (that is the point of launching). It is
    // deliberately not waited on — waiting would block a Tauri command thread until
    // the user closes the app — so its stdio is detached instead of inherited, and
    // the reaping is the platform's business once our process exits.
    cmd.arg(&app.exe_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not launch '{}': {e}", app.name))?;

    tracing::info!(target: "amos::wine", id = %app.id, exe = %app.exe_path, "wine app launched");
    Ok(app.name)
}

/* ---- Tauri commands --------------------------------------------------------- */

/// Is Wine available on this host?
#[tauri::command]
pub fn wine_is_available() -> bool {
    wine_available()
}

/// The Windows apps Wine can run here (empty when Wine is absent — not an error).
#[tauri::command]
pub fn wine_apps() -> Vec<WineApp> {
    if !wine_available() {
        tracing::info!(
            target: "amos::wine",
            "wine is not on PATH; wine_apps answers an empty list"
        );
        return Vec::new();
    }
    list_apps()
}

/// Launch one enumerated Wine app by id.
#[tauri::command]
pub fn wine_launch(id: String) -> Result<String, String> {
    launch(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry_text(exec: &str) -> String {
        format!("[Desktop Entry]\nType=Application\nName=Notepad\nExec={exec}\n")
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("amos-wine-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("start menu")).expect("temp dir");
        dir
    }

    fn write_entry(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join("start menu").join(name);
        std::fs::write(&path, text).expect("write entry");
        path
    }

    #[test]
    fn the_executable_is_the_token_carrying_the_exe_extension() {
        let unix = desktop_entry::argv("wine start /unix /home/me/.wine/drive_c/app.exe")
            .expect("program");
        assert_eq!(
            exe_token(&unix).as_deref(),
            Some("/home/me/.wine/drive_c/app.exe")
        );

        let windows =
            desktop_entry::argv("wine \"C:\\Program Files\\App\\app.EXE\"").expect("program");
        assert_eq!(
            exe_token(&windows).as_deref(),
            Some("C:\\Program Files\\App\\app.EXE")
        );

        // No .exe anywhere: we cannot say what to run, so nothing is invented.
        let none = desktop_entry::argv("wine start notepad").expect("program");
        assert_eq!(exe_token(&none), None);
    }

    #[test]
    fn ids_are_bounded_and_never_empty() {
        let p = Path::new("/x/Start Menu/Notepad.desktop");
        assert_eq!(id_of(p, "app.exe").as_deref(), Some("Notepad"));

        // A hostile file name cannot smuggle separators or spaces into an id…
        let weird = Path::new("/x/../../etc/passwd.desktop");
        assert_eq!(id_of(weird, "app.exe").as_deref(), Some("passwd"));

        // …nor make it arbitrarily long.
        let huge_name = format!("/x/{}.desktop", "a".repeat(500));
        let id = id_of(Path::new(&huge_name), "app.exe").expect("id");
        assert_eq!(id.chars().count(), MAX_ECHOED_ID_CHARS);

        // An unusable stem falls back to the exe's own stem…
        assert_eq!(
            id_of(Path::new("/x/---.desktop"), "/y/Things/app.exe").as_deref(),
            Some("---")
        );
        // …and an entry whose stem sanitizes to nothing has no id at all.
        assert_eq!(id_of(Path::new("/x/  .desktop"), "/y/  "), None);
    }

    #[test]
    fn an_entry_becomes_an_app_with_its_prefix() {
        let dir = scratch("app");
        let path = write_entry(
            &dir,
            "Notepad.desktop",
            &entry_text(
                "env WINEPREFIX=\"/home/me/.wine\" wine start /unix /home/me/.wine/drive_c/np.exe",
            ),
        );
        let app = app_from_entry(&path, &dir).expect("parses into an app");
        assert_eq!(app.id, "Notepad");
        assert_eq!(app.name, "Notepad");
        assert_eq!(app.exe_path, "/home/me/.wine/drive_c/np.exe");
        assert_eq!(app.prefix.as_deref(), Some("/home/me/.wine"));
        assert_eq!(app.desktop_path.as_deref(), path.to_str());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entries_we_cannot_launch_are_refused_with_a_reason() {
        let dir = scratch("refuse");
        // No .exe to run.
        let no_exe = write_entry(&dir, "a.desktop", &entry_text("wine notepad"));
        assert!(app_from_entry(&no_exe, &dir).unwrap_err().contains(".exe"));
        // Deliberately hidden.
        let hidden = write_entry(
            &dir,
            "b.desktop",
            "[Desktop Entry]\nName=Hidden\nExec=wine /x/a.exe\nNoDisplay=true\n",
        );
        assert!(app_from_entry(&hidden, &dir)
            .unwrap_err()
            .contains("launchable"));
        // Not an entry at all.
        let junk = write_entry(&dir, "c.desktop", "this is not a desktop entry\n");
        assert!(app_from_entry(&junk, &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The defect this rewrite exists for: the launch path accepted a caller-supplied
    /// path. It now accepts only ids the host itself enumerated.
    #[test]
    fn a_path_is_not_an_id_and_is_refused() {
        let long_id = "a".repeat(200);
        for hostile in ["/bin/sh", "../../etc/passwd", long_id.as_str()] {
            let err = app_by_id(hostile).unwrap_err();
            assert!(
                err.contains("no Wine app with id") || err.contains("unknown app id"),
                "a path-like id must never resolve to an app: {err}"
            );
        }
        assert!(app_by_id("").is_err(), "an empty id is not an app");
    }

    #[test]
    fn the_listing_is_bounded_and_deduplicated_by_executable() {
        let dir = scratch("list");
        let prefix = dir.join("prefix");
        let programs = prefix.join("drive_c/users/Public/Start Menu/Programs");
        std::fs::create_dir_all(&programs).expect("tree");
        // Two entries, same exe (the duplicate menus Wine creates)…
        for name in ["One.desktop", "Two.desktop"] {
            std::fs::write(
                programs.join(name),
                entry_text("wine start /unix C:/app.exe"),
            )
            .expect("write");
        }
        let scan = desktop_entry::scan_desktop_files(&start_menu_dirs(&prefix));
        assert_eq!(scan.files.len(), 2, "both are found…");
        let listed: Vec<WineApp> = scan
            .files
            .iter()
            .filter_map(|f| app_from_entry(f, &prefix).ok())
            .collect();
        assert_eq!(listed.len(), 2, "…and both parse");
        let unique: HashSet<_> = listed.iter().map(|a| a.exe_path.clone()).collect();
        assert_eq!(unique.len(), 1, "the same exe is one app to Wine");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
