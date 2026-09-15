//! `linux_apps` — native Linux desktop applications, as a **host-owned** listing +
//! launch surface.
//!
//! Commands:
//!   * `linux_is_available` — is this host Linux?
//!   * `linux_apps` — the applications the host itself found in the XDG directories
//!   * `linux_launch(id)` — run one of **those** applications
//!
//! The listing comes from `~/.local/share/applications`, `/usr/local/share/applications`
//! and `/usr/share/applications` (the XDG standard), parsed by the shared, pure
//! [`crate::desktop_entry`] parser. Nothing here is invented: an entry that cannot be
//! parsed into a runnable program is left out and counted, not shown as a nameless row.
//!
//! Two rules worth naming, because the first version of this file broke both:
//!
//! * **Availability is runtime, not `cfg`.** The module compiles on every desktop
//!   target; `linux_is_available()` is the honest runtime answer (`env::consts::OS`).
//!   Anything else makes "this host is Linux" a property of how the binary was built.
//! * **The launch path is a trust boundary.** `linux_launch` used to take an
//!   `exec: String` from the WebView and `Command::new(it).spawn()` — an arbitrary
//!   program from any script in any WebView. It now takes the **id of an app this
//!   host enumerated** and refuses anything else.
//!
//! The `Exec=` line is split into a program + arguments with `%` field codes removed
//! (see [`crate::desktop_entry::argv`]): the host has no file/URL to substitute, and
//! passing `%U` through as an argument hands the app a junk parameter.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::desktop_entry::{self, Argv};

/// One native Linux desktop application.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxApp {
    /// Stable identifier (the `.desktop` file stem, sanitized). The only thing
    /// `linux_launch` accepts.
    pub id: String,
    /// Display name (`Name=`).
    pub name: String,
    /// `Icon=` — a name or a path, as written; `null` when absent.
    pub icon: Option<String>,
    /// The `.desktop` file this came from (diagnosis), else an empty string.
    pub desktop_path: String,
    /// The program this app runs (argv[0] of `Exec=`).
    pub exec: String,
    /// Arguments from `Exec=`, with `%` field codes removed.
    pub args: Vec<String>,
    /// First `Categories=` token (`Network`, `Office`, …), when present.
    pub category: Option<String>,
}

/// Longest id this host will echo back to a caller (characters).
const MAX_ECHOED_ID_CHARS: usize = 64;

/// True when this binary is running on a Linux host.
pub fn on_linux() -> bool {
    std::env::consts::OS == "linux"
}

/// XDG-compliant application directories, user first (the order a desktop
/// environment resolves duplicates in).
fn app_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/applications"));
    } else {
        // Not a silent skip: without a home directory the user's own applications
        // are unreachable, and the operator should see that in the log.
        tracing::warn!(
            target: "amos::linux_apps",
            "no home directory; user applications are not listed"
        );
    }
    dirs.push(PathBuf::from("/usr/local/share/applications"));
    dirs.push(PathBuf::from("/usr/share/applications"));
    dirs
}

/// A stable, bounded id from a `.desktop` file name.
///
/// The file stem is sanitized because ids travel to the WebView and back: a name
/// with separators or spaces must not become an address of any kind, and an
/// unusable one yields `None` rather than an empty id.
fn id_of(path: &Path) -> Option<String> {
    let stem = path.file_stem().and_then(|s| s.to_str())?;
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

/// Turn one entry into a `LinuxApp`, or say why it is not one.
fn app_from_entry(path: &Path) -> Result<LinuxApp, String> {
    let text = desktop_entry::read_bounded(path)?;
    let entry = desktop_entry::parse(&text).ok_or("no usable [Desktop Entry] group")?;
    if !entry.is_launchable_app() {
        return Err("not a launchable Application entry".to_string());
    }
    let argv = desktop_entry::argv(&entry.exec).ok_or("Exec= has no program")?;
    // `env FOO=bar prog` entries are kept **as written** and run through `env`
    // itself: unwrapping them here would silently drop the variables the entry
    // declared (several launchers set e.g. `GDK_BACKEND` that way).
    let id = id_of(path).ok_or("no usable id")?;
    Ok(LinuxApp {
        id,
        name: entry.name,
        icon: entry.icon,
        desktop_path: path.to_str().unwrap_or_default().to_string(),
        exec: argv.program,
        args: argv.args,
        category: entry.category,
    })
}

/// Every application this host can find: deduplicated by id across the XDG
/// directories (the earlier version's "dedup" was `or_insert(()).is_empty()`, which
/// is *always* true — so duplicates from `/usr/share` and `~/.local/share` were all
/// listed twice), capped, and honest about what it left out.
fn list_apps() -> Vec<LinuxApp> {
    let scan = desktop_entry::scan_desktop_files(&app_dirs());
    let mut apps: Vec<LinuxApp> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut skipped_entries = 0usize;

    for file in scan.files {
        match app_from_entry(&file) {
            Ok(app) => {
                // User directories come first in `app_dirs()`, and the walk is
                // breadth-first, so the first id seen is the user's own entry —
                // which is the one a desktop environment would show.
                if seen.insert(app.id.clone()) {
                    apps.push(app);
                }
            }
            Err(_) => skipped_entries += 1,
        }
    }

    if scan.unreadable_dirs > 0
        || scan.skipped_depth > 0
        || scan.skipped_cap > 0
        || skipped_entries > 0
    {
        tracing::info!(
            target: "amos::linux_apps",
            unreadable_dirs = scan.unreadable_dirs,
            skipped_depth = scan.skipped_depth,
            skipped_cap = scan.skipped_cap,
            skipped_entries,
            listed = apps.len(),
            "linux_apps: some entries were not listed (see the counters)"
        );
    }
    apps
}

/// Resolve an id this host itself listed. `Err` names the reason.
fn app_by_id(id: &str) -> Result<LinuxApp, String> {
    if id.is_empty() || id.chars().count() > MAX_ECHOED_ID_CHARS {
        return Err("unknown app id".to_string());
    }
    list_apps()
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("no Linux app with id '{id}' is installed"))
}

/// Run one enumerated application.
fn launch(id: &str) -> Result<String, String> {
    if !on_linux() {
        return Err("Linux apps are only available on a Linux host".to_string());
    }
    let app = app_by_id(id)?;
    spawn_app(&app).map_err(|e| format!("could not launch '{}': {e}", app.name))?;
    tracing::info!(
        target: "amos::linux_apps",
        id = %app.id,
        exec = %app.exec,
        "linux app launched"
    );
    Ok(app.name)
}

/// Spawn an app's `Exec=` program + arguments.
///
/// The child outlives this call — that is what launching means — so it is
/// deliberately not waited on (waiting would pin a Tauri command thread until the
/// user closed the app), and its stdio is detached rather than inherited.
fn spawn_app(app: &LinuxApp) -> std::io::Result<std::process::Child> {
    Command::new(&app.exec)
        .args(&app.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

/// `Exec=` as a program + arguments (the shape a launcher runs), without running
/// anything. Kept next to [`spawn_app`] so the two always agree.
pub fn plan(app: &LinuxApp) -> Argv {
    Argv {
        program: app.exec.clone(),
        args: app.args.clone(),
    }
}

/* ---- Tauri commands --------------------------------------------------------- */

/// Is this host Linux? (Linux apps exist only where their `.desktop` files do.)
#[tauri::command]
pub fn linux_is_available() -> bool {
    on_linux()
}

/// The installed Linux desktop applications (empty on a non-Linux host).
#[tauri::command]
pub fn linux_apps() -> Vec<LinuxApp> {
    if !on_linux() {
        tracing::info!(
            target: "amos::linux_apps",
            host = std::env::consts::OS,
            "this host is not Linux; linux_apps answers an empty list"
        );
        return Vec::new();
    }
    list_apps()
}

/// Launch one enumerated Linux app by id.
#[tauri::command]
pub fn linux_launch(id: String) -> Result<String, String> {
    launch(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("amos-linuxapps-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn entry(id: &str, body: &str) -> LinuxApp {
        let dir = scratch(id);
        let path = dir.join(format!("{id}.desktop"));
        std::fs::write(&path, body).expect("write");
        app_from_entry(&path).expect("entry parses")
    }

    #[test]
    fn an_entry_becomes_a_program_plus_arguments() {
        let app = entry(
            "org.gnome.Nautilus",
            "[Desktop Entry]\nType=Application\nName=Files\nExec=nautilus --new-window %U\n\
             Icon=system-file-manager\nCategories=System;Utility;\n",
        );
        assert_eq!(app.id, "org.gnome.Nautilus", "dots are legal in an id");
        assert_eq!(app.name, "Files");
        assert_eq!(app.icon.as_deref(), Some("system-file-manager"));
        assert_eq!(app.category.as_deref(), Some("System"));
        assert_eq!(plan(&app).program, "nautilus");
        assert_eq!(
            plan(&app).args,
            vec!["--new-window"],
            "%U is dropped, not passed through as a literal argument"
        );
    }

    #[test]
    fn env_wrapped_entries_keep_their_variables() {
        // Several launchers write `Exec=env VAR=1 prog`. The variables belong to the
        // entry, so the app runs through `env` with them intact.
        let app = entry(
            "env.wrapped",
            "[Desktop Entry]\nName=Wrapped\nExec=env GDK_BACKEND=x11 app %U\n",
        );
        assert_eq!(app.exec, "env");
        assert_eq!(app.args, vec!["GDK_BACKEND=x11", "app"]);
    }

    #[test]
    fn entries_we_cannot_run_are_refused_with_a_reason() {
        let dir = scratch("refuse");
        let no_name = dir.join("noname.desktop");
        std::fs::write(&no_name, "[Desktop Entry]\nExec=app\n").expect("write");
        assert!(app_from_entry(&no_name).is_err());

        let hidden = dir.join("hidden.desktop");
        std::fs::write(
            &hidden,
            "[Desktop Entry]\nName=Hidden\nExec=app\nNoDisplay=true\n",
        )
        .expect("write");
        assert!(app_from_entry(&hidden).unwrap_err().contains("launchable"));

        let only_field_code = dir.join("fieldcode.desktop");
        std::fs::write(&only_field_code, "[Desktop Entry]\nName=X\nExec=%U\n").expect("write");
        assert!(app_from_entry(&only_field_code)
            .unwrap_err()
            .contains("no program"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_are_sanitized_and_bounded() {
        assert_eq!(
            id_of(Path::new("/usr/share/applications/firefox.desktop")).as_deref(),
            Some("firefox")
        );
        assert_eq!(id_of(Path::new("/x/  .desktop")), None, "nothing usable");
        assert_eq!(id_of(Path::new("/")), None, "no file stem");

        let long = format!("/x/{}.desktop", "z".repeat(300));
        assert_eq!(
            id_of(Path::new(&long)).map(|i| i.chars().count()),
            Some(MAX_ECHOED_ID_CHARS)
        );
    }

    /// The defect this rewrite exists for: `linux_launch` used to `Command::new()` a
    /// caller-supplied string. An id must resolve only against our own enumeration.
    #[test]
    fn a_path_is_not_an_id_and_is_refused() {
        for hostile in ["/bin/sh", "../../usr/bin/env", "-rf"] {
            let err = app_by_id(hostile).unwrap_err();
            assert!(
                err.contains("no Linux app with id") || err.contains("unknown app id"),
                "a path-like id must never resolve to a program: {err}"
            );
        }
        assert!(app_by_id("").is_err());
        assert!(
            app_by_id(&"a".repeat(200)).is_err(),
            "an over-long id is refused before any lookup"
        );
    }

    #[test]
    fn launching_a_known_id_on_a_non_linux_host_is_reported() {
        // This checkout runs on macOS too: the honest answer is a refusal, not a
        // spawn. (The id is irrelevant — availability is checked first.)
        if !on_linux() {
            let err = launch("anything").unwrap_err();
            assert!(err.contains("only available on a Linux host"), "{err}");
            assert!(!linux_is_available());
            assert!(
                linux_apps().is_empty(),
                "no invented apps on a non-Linux host"
            );
        }
    }
}
