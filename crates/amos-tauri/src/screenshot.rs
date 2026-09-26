//! `screenshot.rs` — take a REAL screenshot of the host screen into
//! `~/Pictures/Screenshots` (REQ-A699).
//!
//! Why: the desktop shell owns a full window model (multi-window, snapping, Spaces,
//! multi-display) but had **no way to capture what is on the screen** — the audit
//! (`docs/DESKTOP_GAP_ANALYSIS_2026_SEP20.md` §A4) found zero production hits for
//! `screencapture`/`screenshot`. This module closes that gap the same way
//! [`crate::host_battery`] reads the real host battery: a thin platform invocation with
//! the pure, testable part (naming, collision, destination) separated out.
//!
//! Destination: `~/Pictures/Screenshots` — the **same** directory `lib/media.ts`'s
//! `canonicalPath("screenshots")` resolves, so the capture shows up in the Photos app
//! with no extra wiring. The two spellings are pinned together by a test.
//!
//! Front door: `File ▸ Take Screenshot` in the in-app menu bar. It is **not** bound to
//! `⌘⇧3` on purpose: macOS reserves `⌘⇧3/4/5` for its own screenshot tool and consumes
//! the chord before any window sees it, so a WebView binding would be dead exactly on
//! the platform this command targets.
//!
//! Honest boundaries (not defects left unstated):
//!   • **macOS-only**, for now. Other platforms return a typed refusal naming the OS —
//!     never a fabricated "success" (the Android `MediaProjection` path is a separate
//!     piece of work, and faking it locally is the "one number that lies" shape this
//!     repo keeps removing).
//!   • **Screen Recording permission is the OS's**: on a first run macOS may prompt, and
//!     until it is granted the platform tool can write a degraded capture (desktop
//!     picture only). We report what the tool did — a file either exists or it does not —
//!     and never claim the pixels are right.
//!   • No real-device verification of the captured image (this ran on a macOS dev host
//!     with a Screen Recording grant; a denied grant is unexercised).

use std::path::{Path, PathBuf};

/// The directory captures land in, relative to the user's home.
///
/// **Mirror** of `lib/media.ts::canonicalPath("screenshots")` — the Photos app reads
/// that spelling, this module writes this one, and a test fails if they drift.
pub const SCREENSHOT_REL_DIR: &str = "Pictures/Screenshots";

/// macOS-style filename for an instant: `Screenshot 2026-09-20 at 14.03.05.png`.
///
/// Pure given the two parts, so the *shape* is testable without a clock or a timezone.
pub fn filename_from_parts(date: &str, time: &str) -> String {
    format!("Screenshot {date} at {time}.png")
}

/// The filename for `now_ms` (ms since the Unix epoch), in **local** time.
///
/// Local, because a person reads this in Finder and expects their own wall clock. An
/// instant the calendar cannot represent (a nonsense system clock) still yields a
/// capture: the epoch number is unique and honest, where a panic or a refusal would
/// lose the screen the user asked to save.
pub fn filename_for(now_ms: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(now_ms).single() {
        Some(dt) => filename_from_parts(
            &dt.format("%Y-%m-%d").to_string(),
            &dt.format("%H.%M.%S").to_string(),
        ),
        None => format!("Screenshot {now_ms}.png"),
    }
}

/// `dir/base`, or the first free `dir/stem (n).ext` when that name is taken.
///
/// The collision rule is macOS's own (a second capture in the same second must not
/// overwrite the first). `exists` is injected so the rule is unit-tested without a
/// filesystem. The scan is **bounded**: a directory holding a thousand captures of the
/// same second is a bug, not a reason to loop forever — the first name is then returned
/// and the platform tool overwrites, which is the honest alternative to an unbounded walk.
pub fn unique_in(dir: &Path, base: &str, exists: &impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(base);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s, e),
        _ => (base, ""),
    };
    for n in 2..1000u32 {
        let candidate = if ext.is_empty() {
            dir.join(format!("{stem} ({n})"))
        } else {
            dir.join(format!("{stem} ({n}).{ext}"))
        };
        if !exists(&candidate) {
            return candidate;
        }
    }
    first
}

/// `<home>/Pictures/Screenshots`. Pure join, so the destination is testable.
pub fn screenshot_dir_in(home: &Path) -> PathBuf {
    home.join(SCREENSHOT_REL_DIR)
}

/// The refusal a platform with no capture tool owes the caller, **naming the OS**.
///
/// One spelling for both the pre-check ([`resolve_capture_dir`]) and the run
/// ([`run_capture`]), so the two can never phrase the same refusal differently.
fn unsupported_refusal(os: &str) -> String {
    format!("screenshot capture is not implemented on {os} (macOS only for now)")
}

/// Whether this build has a capture tool. [`capture_command`] is the one authority, so
/// this bit cannot drift from what a run would actually spawn.
fn capture_supported() -> bool {
    capture_command(Path::new("")).is_some()
}

/// The directory a capture should land in — or the refusal owed **first** (REQ-A1905).
///
/// The order is the whole point and is what this seam exists to pin. Resolving the home
/// directory first (the shipped order) has two harms, both measured: on a platform that
/// *does* have a home (Linux/Windows) the command went on to **create**
/// `~/Pictures/Screenshots` as a side effect of a capture it then refused; and on Android
/// — where there is no home directory — it answered 「no home directory」 instead of the
/// 「not implemented on android」 this module's own honest boundary promises (the device
/// answered exactly that, `screenshot_capture ERR no home directory: cannot resolve
/// Pictures/Screenshots`, 2026-09-26). Answering a question the platform can already
/// settle, before doing work that only the wrong answer justifies, is the fix.
///
/// Pure (the support bit and the home are injected), so both orders' difference is pinned
/// without a filesystem or a device.
pub fn resolve_capture_dir(
    supported: bool,
    os: &str,
    home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if !supported {
        return Err(unsupported_refusal(os));
    }
    home.map(|h| screenshot_dir_in(&h))
        .ok_or_else(|| "no home directory: cannot resolve Pictures/Screenshots".to_string())
}

/// macOS's capture tool writing a silent (`-x`, no shutter sound) PNG to `out`.
///
/// Compiled on macOS (its only caller) **and** under `test`, so the argument shape is
/// exercised on any dev host rather than being a macOS-only blind spot.
#[cfg(any(target_os = "macos", test))]
pub fn macos_capture_command(out: &Path) -> (&'static str, Vec<String>) {
    (
        "screencapture",
        vec!["-x".to_string(), out.to_string_lossy().into_owned()],
    )
}

/// The platform's capture command writing to `out`, or `None` where this module has no
/// reader (honest "not implemented here", never a stub that pretends).
pub fn capture_command(out: &Path) -> Option<(&'static str, Vec<String>)> {
    #[cfg(target_os = "macos")]
    {
        Some(macos_capture_command(out))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = out;
        None
    }
}

/// Run the platform capture into `out`, or a typed refusal naming why it could not.
///
/// The no-tool arm is **defence in depth**: [`screenshot_capture`] already refuses an
/// unsupported platform through [`resolve_capture_dir`], so a caller arriving here has a
/// tool — but a caller that resolved its directory by another route still gets the same
/// refusal ([`unsupported_refusal`], one spelling with the pre-check).
fn run_capture(out: &Path) -> Result<(), String> {
    let Some((program, args)) = capture_command(out) else {
        return Err(unsupported_refusal(std::env::consts::OS));
    };
    let status = std::process::Command::new(program)
        .args(&args)
        .status()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    if !status.success() {
        return Err(format!("{program} exited with {status}"));
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Turn a capture run into the command's answer: the tool must have left a file behind.
///
/// The subtle failure this exists for: the platform tool can exit **0** and write nothing
/// (a lost Screen Recording grant, a tool that did not recognise its arguments). Reporting
/// a path to a file that is not there is exactly the "looks like it worked" lie this repo
/// keeps removing — so the post-condition is checked, not assumed. `exists` is injected so
/// the rule is unit-tested without running anything.
fn confirm_written(out: &Path, exists: &impl Fn(&Path) -> bool) -> Result<String, String> {
    if !exists(out) {
        return Err(format!(
            "the capture tool ran but wrote no file at {}",
            out.display()
        ));
    }
    Ok(out.to_string_lossy().into_owned())
}

/// Tauri command: capture the screen into `~/Pictures/Screenshots`, returning the
/// **absolute path** of the file that was written.
///
/// `Err(String)` is a typed refusal — an unsupported platform (named, and settled
/// **before** any directory is resolved or created), no home directory, an unwritable
/// directory, the tool failing, or (the subtle one) the tool reporting success while
/// leaving no file behind. A capture that did not happen must not look like one that did
/// — and a refusal must not do the work only a capture would justify.
#[tauri::command]
pub fn screenshot_capture() -> Result<String, String> {
    let dir = resolve_capture_dir(capture_supported(), std::env::consts::OS, dirs::home_dir())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let out = unique_in(&dir, &filename_for(now_ms()), &|p| p.exists());
    run_capture(&out)?;
    confirm_written(&out, &|p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn a_filename_has_macos_shape() {
        assert_eq!(
            filename_from_parts("2026-09-20", "14.03.05"),
            "Screenshot 2026-09-20 at 14.03.05.png"
        );
    }

    #[test]
    fn filename_for_a_real_instant_keeps_the_shape() {
        // 2026-09-20T00:00:00Z; the *value* depends on the test host's timezone, so
        // only the shape is asserted (a date, an `at`, a clock, a `.png`).
        let name = filename_for(1_789_891_200_000);
        let rest = name
            .strip_prefix("Screenshot ")
            .and_then(|s| s.strip_suffix(".png"))
            .expect("the expected prefix/suffix");
        let (date, time) = rest.split_once(" at ").expect("a date `at` a time");
        assert_eq!(date.len(), 10, "YYYY-MM-DD: {date}");
        assert_eq!(time.len(), 8, "HH.MM.SS: {time}");
        assert_eq!(date.matches('-').count(), 2);
        assert_eq!(time.matches('.').count(), 2);
    }

    #[test]
    fn an_unrepresentable_instant_still_yields_a_capture_name() {
        // A clock so far out chrono cannot render it locally: never a panic, never a
        // refusal — the epoch number is unique and honest.
        let name = filename_for(i64::MAX);
        assert_eq!(name, format!("Screenshot {}.png", i64::MAX));
    }

    #[test]
    fn a_free_name_is_used_as_is() {
        let dir = Path::new("/shots");
        let out = unique_in(dir, "Screenshot 2026-09-20 at 14.03.05.png", &|_| false);
        assert_eq!(
            out,
            PathBuf::from("/shots/Screenshot 2026-09-20 at 14.03.05.png")
        );
    }

    #[test]
    fn a_taken_name_gets_the_next_free_ordinal_before_the_extension() {
        let dir = Path::new("/shots");
        let base = "Screenshot 2026-09-20 at 14.03.05.png";
        // The first and the " (2)" name are taken; " (3)" is free.
        let taken: HashSet<PathBuf> = [
            dir.join(base),
            PathBuf::from("/shots/Screenshot 2026-09-20 at 14.03.05 (2).png"),
        ]
        .into_iter()
        .collect();
        let out = unique_in(dir, base, &|p| taken.contains(p));
        assert_eq!(
            out,
            PathBuf::from("/shots/Screenshot 2026-09-20 at 14.03.05 (3).png")
        );
    }

    #[test]
    fn a_name_without_an_extension_still_gets_an_ordinal() {
        let dir = Path::new("/shots");
        let taken: HashSet<PathBuf> = [dir.join("note")].into_iter().collect();
        assert_eq!(
            unique_in(dir, "note", &|p| taken.contains(p)),
            PathBuf::from("/shots/note (2)")
        );
    }

    #[test]
    fn the_destination_is_the_dir_photos_reads() {
        assert_eq!(
            screenshot_dir_in(Path::new("/Users/me")),
            PathBuf::from("/Users/me/Pictures/Screenshots")
        );
        // The wire spelling the frontend mirrors (`lib/media.ts`).
        assert_eq!(SCREENSHOT_REL_DIR, "Pictures/Screenshots");
    }

    #[test]
    fn a_run_that_wrote_nothing_is_a_refusal_not_a_success() {
        // The tool exits 0 but leaves no file (a lost Screen Recording grant, a
        // misparsed argument): the command must refuse rather than hand back the path
        // of a screenshot that does not exist.
        let out = Path::new("/shots/a.png");
        assert!(confirm_written(out, &|_| false).is_err());
        assert_eq!(
            confirm_written(out, &|_| true),
            Ok("/shots/a.png".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_capture_is_a_silent_png_to_the_given_path() {
        let (program, args) = macos_capture_command(Path::new("/tmp/a.png"));
        assert_eq!(program, "screencapture");
        assert_eq!(args, vec!["-x".to_string(), "/tmp/a.png".to_string()]);
        assert!(capture_command(Path::new("/tmp/a.png")).is_some());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_have_no_capture_command() {
        assert_eq!(capture_command(Path::new("/tmp/a.png")), None);
    }

    #[test]
    fn an_unsupported_platform_is_named_not_blamed_on_the_home_directory() {
        // Android: no home directory *and* no tool. The message the user reads must be
        // the one the module promises ("not implemented on <OS>"), not a home-dir error
        // that names neither the platform nor the real reason. Measured on the device
        // (2026-09-26) the shipped order answered 「no home directory」.
        assert_eq!(
            resolve_capture_dir(false, "android", None).unwrap_err(),
            "screenshot capture is not implemented on android (macOS only for now)"
        );
        // Linux/Windows: a home *is* resolvable, and the shipped order went on to
        // create `~/Pictures/Screenshots` for a capture it then refused. The platform
        // is settled first, so nothing is resolved to create.
        assert_eq!(
            resolve_capture_dir(false, "linux", Some(PathBuf::from("/home/me"))).unwrap_err(),
            "screenshot capture is not implemented on linux (macOS only for now)"
        );
    }

    #[test]
    fn a_supported_platform_with_no_home_is_the_home_refusal() {
        assert_eq!(
            resolve_capture_dir(true, "macos", None).unwrap_err(),
            "no home directory: cannot resolve Pictures/Screenshots"
        );
    }

    #[test]
    fn a_supported_platform_with_a_home_resolves_the_photos_directory() {
        assert_eq!(
            resolve_capture_dir(true, "macos", Some(PathBuf::from("/Users/me"))).unwrap(),
            PathBuf::from("/Users/me/Pictures/Screenshots")
        );
    }

    #[test]
    fn the_command_settles_support_before_it_touches_the_filesystem() {
        // The seam is only load-bearing if `screenshot_capture` goes through it: a
        // command that still resolved `dirs::home_dir()` first would refuse with the
        // home message on Android however correct the seam is. Pin the call order in
        // the command body itself.
        let src = include_str!("screenshot.rs");
        let body = src
            .split("pub fn screenshot_capture")
            .nth(1)
            .expect("the command body");
        let resolve = body
            .find("resolve_capture_dir(")
            .expect("the command resolves through the seam");
        let create = body
            .find("create_dir_all(")
            .expect("the command creates the directory");
        assert!(
            resolve < create,
            "support must be settled before the directory is created"
        );
    }
}
