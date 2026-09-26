//! `screen_record.rs` — record the host screen to a real video file
//! (`~/Movies`).
//!
//! Why: the host could take a **still** ([`crate::screenshot`], REQ-A699) but had no
//! way to capture motion — the audit found `screencapture -v`, `MediaProjection` and
//! `MediaRecorder` with zero production hits. A screenshot answers "what did it look
//! like"; a bug report needs "what did it *do*". This module closes that gap the same
//! way the screenshot did: the pure, testable parts (naming, collision, destination,
//! argument shape, capability, the post-condition) are separated from the one platform
//! invocation, so the *rules* are exercised on any dev host.
//!
//! # Shape of the state machine
//!
//! Starting a recording is **not** a request/response: it spawns a long-lived child
//! (`ffmpeg -f avfoundation …`) that only stops when signalled or when its own `-t<secs>`
//! bound elapses. The process therefore lives in [`ScreenRecorder`] between commands,
//! and `screen_record_stop` is the only thing that seals the file.
//!
//! **The platform tool is not a detail here.** `screencapture -v` was the obvious
//! choice — a system tool, no dependency — and it cannot do this job: measured on
//! macOS 26.4.1 it buffers the whole recording and writes the file only on a clean exit,
//! and *every* signal (INT/TERM/QUIT/HUP/USR1/USR2) kills it with nothing written. A
//! Stop button built on it would return "the tool wrote no file" over a recording the
//! user had just watched. `ffmpeg` writes frames as it captures and finalizes the
//! container on SIGINT; the full measurement and the trade it buys are in
//! [`macos_record_command`] and `docs/screen-recording.md`.
//!
//! Two disciplines are copied from siblings rather than invented:
//!
//!   • **The generation counter** (`android-glue`'s `CameraGlue.kt`): a stop captures a
//!     generation; a late child-exit callback that compares unequal is *discarded* and
//!     cannot touch a newer session's state. Here the same rule is what stops a
//!     straggling stop from clearing a recording the user started a moment later.
//!   • **`confirm_written`** ([`crate::screenshot`]): the platform tool can exit **0**
//!     and leave a zero-byte file (a lost Screen Recording grant, a `MediaRecorder` that
//!     never got a surface). Handing back the path of a file that is not there — or is
//!     empty — is the "looks like it worked" lie this repo keeps removing, so the
//!     post-condition is **checked**, not assumed.
//!
//! # Honest boundaries (not defects left unstated)
//!
//!   • **macOS-only, and it needs `ffmpeg` on `PATH`.** Every other platform answers
//!     `available: false` from [`crate::screen_record::capability`] with the OS named, and
//!     macOS answers `false` with a reason naming the missing tool ([`capability_with_tool`]).
//!     The Android `MediaProjection` path is a separate piece of glue (device-only,
//!     unverified on a host); faking it here would be exactly the "one number that lies"
//!     shape.
//!   • **Screen Recording permission is the OS's.** A denied grant makes the tool fail —
//!     `ffmpeg` exits with its own error, on the dev host after the capture device was
//!     selected — which the spawn grace turns into a named start refusal rather than a
//!     phantom recording. The non-zero-size check catches the *empty* file; "the file has
//!     bytes but the pixels are wrong" is **not** detected and is never claimed.
//!   • **A crash while recording leaves the child running**, sealed only by its own
//!     `-t<secs>` bound. That bound is also the reason the duration ceiling holds even
//!     if `screen_record_stop` never arrives.
//!   • **Which screen `display` names is the tool's vocabulary.** The avfoundation index
//!     depends on the machine (cameras occupy the low indices), so it is looked up by
//!     name; a screen the host does not list is a refusal, not a fallback. Only the
//!     single-screen case is exercised on this host.
//!   • No device-emulator path; the Android half is unexercised on this host.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{State, WebviewWindow};

use crate::error::{AmosError, AmosResult, ErrorCode};

/// The directory recordings land in, relative to the user's home.
///
/// **Mirror** of `lib/media.ts::canonicalPath("movies")` — the Files app and the Player
/// app both read that collection, this module writes this one, and a test fails if they
/// drift (the same pin [`crate::screenshot::SCREENSHOT_REL_DIR`] carries).
///
/// # Why the collection root and not a `Screen Recordings/` subfolder
///
/// A subfolder would be tidier, but it would be **invisible**: the media providers list
/// a collection **non-recursively** (`amos-media`'s `HostFsProvider::list` is one
/// `read_dir` of `base/<canonical_path>`), so nothing would ever show a recording filed
/// one level down. Reaching it would mean a new [`StandardDir`]-equivalent collection —
/// a new wire tag whose Android `MediaStoreGlue` key does not exist and could not be
/// verified on this host, i.e. a UI listing a place no device backend can answer for.
///
/// So the recording lands where macOS itself puts one and where the vocabulary already
/// points: `Movies`, whose `default_kind` is `Video` — the honest kind for a `.mov`. The
/// filename (`Screen Recording <date> at <time>.mov`) is what tells it apart from the
/// user's own films; see `docs/screen-recording.md` for the trade in full.
pub const SCREEN_RECORDING_REL_DIR: &str = "Movies";

/// Shortest recording the host will accept (seconds). A zero-length request is a
/// mistake, not "record nothing" — the tool would write a file with no frames — so it is
/// **refused by name**, not rounded up to one second (see [`resolve_max_secs`]).
pub const MIN_RECORD_SECS: u32 = 1;

/// Longest recording the host will accept (seconds) — 30 minutes.
///
/// A request beyond it is **refused by name** ([`resolve_max_secs`] →
/// `ScreenRecordDurationOutOfRange`), not silently shortened: the caller who asked for an
/// hour and got a 30-minute file has no way to tell a truncated capture from a complete
/// one by looking at it. The resolved bound is also handed to the platform tool
/// (`-t<max_secs>`), so the ceiling still holds if the host process dies before it can
/// stop the child.
pub const MAX_RECORD_SECS: u32 = 30 * 60;

/// How long `screen_record_stop` waits for the tool to seal the file after SIGINT
/// before declaring the stop failed.
pub const STOP_WAIT_SECS: u64 = 15;

/// Capture frame rate. 30 rather than the display's refresh rate: the ceiling that
/// matters here is the file size a 30-minute recording leaves in `~/Movies`, and the
/// host has no portable way to ask for the panel's rate (see `docs/screen-recording.md`).
pub const RECORD_FRAMERATE: u32 = 30;

/// The macOS recording tool the module spawns. Not a system binary, so its presence is
/// a **capability fact** rather than an assumption — see [`ffmpeg_in_path`].
pub const RECORD_TOOL: &str = "ffmpeg";

/// How long `screen_record_start` lets the freshly-spawned tool live before it believes
/// the recording began. A tool that dies inside this window (a missing Screen Recording
/// grant, a bad argument) never started a recording, and saying otherwise would light
/// the REC indicator for a capture that is not happening.
pub const SPAWN_GRACE_MS: u64 = 250;

/// macOS-style filename for an instant: `Screen Recording 2026-09-20 at 14.03.05.mov`.
///
/// Pure given the two parts, so the *shape* is testable without a clock or a timezone.
pub fn filename_from_parts(date: &str, time: &str) -> String {
    format!("Screen Recording {date} at {time}.mov")
}

/// The filename for `now_ms` (ms since the Unix epoch), in **local** time.
///
/// Local, because a person reads this in Finder and expects their own wall clock. An
/// instant the calendar cannot represent still yields a name: the epoch number is unique
/// and honest, where a panic would lose the recording the user asked for.
pub fn filename_for(now_ms: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(now_ms).single() {
        Some(dt) => filename_from_parts(
            &dt.format("%Y-%m-%d").to_string(),
            &dt.format("%H.%M.%S").to_string(),
        ),
        None => format!("Screen Recording {now_ms}.mov"),
    }
}

/// `<home>/Movies`. Pure join, so the destination is testable.
pub fn screen_recording_dir_in(home: &Path) -> PathBuf {
    home.join(SCREEN_RECORDING_REL_DIR)
}

/// Resolve the caller's requested duration **at the command boundary**.
///
/// `None` (the caller named no bound) is accepted and means the ceiling. A number inside
/// `[MIN_RECORD_SECS, MAX_RECORD_SECS]` is accepted as asked. A number **outside** that
/// range is refused by name with [`ErrorCode::ScreenRecordDurationOutOfRange`], so the
/// caller can render an honest sentence without parsing the message — the same rule, for
/// the same reason, as `sensors::sensor_acquire`'s `rate_hz` bound.
///
/// # Why a refusal where this used to clamp
///
/// A clamp is the worse answer for a *duration*, because the substituted bound is
/// invisible in the artifact: someone who asked for an hour and silently got 30 minutes
/// holds a file that looks exactly like a complete one (REQ-A1795). The rounding is not
/// even a service to the caller — the honest answer to "for an hour" is "not more than
/// 30 minutes, ask again", not a capture that stops early. This reverses the earlier
/// "clamp, don't refuse" contract, which had no caller and left
/// `ScreenRecordDurationOutOfRange` a declared-but-unconstructed wire code.
///
/// The value returned is the one handed to the platform tool (`-t<secs>`), so the ceiling
/// still holds even if the host never gets to stop the child.
pub fn resolve_max_secs(requested: Option<u32>) -> Result<u32, AmosError> {
    match requested {
        None => Ok(MAX_RECORD_SECS),
        Some(secs) if (MIN_RECORD_SECS..=MAX_RECORD_SECS).contains(&secs) => Ok(secs),
        Some(secs) => Err(AmosError::new(
            ErrorCode::ScreenRecordDurationOutOfRange,
            format!("max_secs {secs} outside [{MIN_RECORD_SECS}, {MAX_RECORD_SECS}]"),
        )),
    }
}

/// macOS's recording tool: an H.264 `.mov` to `out`, captured from the avfoundation
/// screen device `device` and capped at `max_secs` seconds.
///
/// Compiled on macOS (its only caller) **and** under `test`, so the argument shape is
/// exercised on any dev host rather than being a macOS-only blind spot.
///
/// # Why `ffmpeg` and not `screencapture -v`
///
/// `screencapture -v` was the first choice (a system tool, no dependency) and it is
/// **wrong for a recording the host must be able to stop**. Measured on macOS 26.4.1
/// (2026-09-25), with `-V30`:
///
///   • It writes the `.mov` **only when it exits on its own**. Three seconds into a
///     recording there is no file on disk at all — the whole capture is buffered.
///   • **No signal seals it.** SIGINT (both `kill -INT` and a genuine pty `\x03`),
///     SIGTERM, SIGQUIT, SIGHUP, SIGUSR1 and SIGUSR2 each kill the process and leave
///     **nothing behind**. (An earlier shell measurement that "worked" was an artefact:
///     zsh backgrounds ignore SIGINT, so that run coasted to its 20s bound — the test
///     that caught this is `tests/screen_record_e2e.rs`.)
///
/// So every stop would have returned "the recording tool ran but wrote no file" over a
/// recording the user had just watched happen. `ffmpeg` does the job the module needs:
/// it writes frames **as it captures** (262 KB on disk three seconds in) and
/// **finalizes the container on SIGINT** (exit 255, a file `ffprobe` reads back with a
/// real duration). The trade is a runtime dependency, disclosed in
/// [`capability`]: no `ffmpeg` on `PATH` means `available: false`, not a silent fallback
/// to a tool that cannot stop.
///
/// `-t` is the ceiling, and it is the tool's own bound rather than ours — so it holds
/// even if the host process dies before it can stop the child, which is the same
/// guarantee `-V` gave.
#[cfg(any(target_os = "macos", test))]
pub fn macos_record_command(
    out: &Path,
    max_secs: u32,
    device: &str,
) -> (&'static str, Vec<String>) {
    (
        "ffmpeg",
        vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "avfoundation".to_string(),
            // The screen device offers uyvy422/yuyv422/nv12/0rgb/bgr0; asking for the
            // encoder's yuv420p makes ffmpeg print a warning per start.
            "-pixel_format".to_string(),
            "nv12".to_string(),
            "-capture_cursor".to_string(),
            "1".to_string(),
            "-framerate".to_string(),
            RECORD_FRAMERATE.to_string(),
            "-i".to_string(),
            device.to_string(),
            "-t".to_string(),
            max_secs.to_string(),
            "-c:v".to_string(),
            "h264".to_string(),
            "-y".to_string(),
            out.to_string_lossy().into_owned(),
        ],
    )
}

/// The command that **interrupts** a running recording by pid.
///
/// SIGINT, not SIGTERM/SIGKILL: `ffmpeg` installs a SIGINT/SIGTERM handler that stops
/// capturing and writes the container's trailer, so the `.mov` is playable. Measured on
/// this host: exit 255 within a quarter-second, file present and `ffprobe`-readable. A
/// signal it did *not* handle would leave a file that exists but will not open — which
/// the non-zero-size check alone would *not* catch, which is why the signal choice is
/// the correctness-critical part of the stop path rather than an implementation detail.
///
/// Note `ffmpeg`'s exit status on this path is **255** — a non-zero status that is a
/// *success* here. `screen_record_stop` never reads it as a verdict; the file's existence
/// and size are ([`confirm_written`]).
#[cfg(any(target_os = "macos", test))]
pub fn interrupt_command(pid: u32) -> (&'static str, Vec<String>) {
    ("kill", vec!["-INT".to_string(), pid.to_string()])
}

/// The `avfoundation` video index of the screen device for `screen`, read out of
/// `ffmpeg -f avfoundation -list_devices true -i ""` output.
///
/// Pure over the listing text, so the parse is exercised on any dev host against the
/// real shape ffmpeg prints (see the test) rather than being a device-only blind spot.
///
/// The listing interleaves camera and screen devices and **their indices depend on the
/// machine** — on the dev host the built-in camera is `[0]`, the desk-view camera `[1]`,
/// and the screen `[2]`. So the index is looked up by *name*, never assumed. Example
/// line:
///
/// ```text
/// [AVFoundation indev @ 0xaa8c18140] [2] Capture screen 0
/// ```
///
/// A screen that is not listed returns `None`, and the caller refuses by name: silently
/// capturing screen 0 instead would answer "recording" for a screen the caller did not
/// ask for.
pub fn screen_device_index(listing: &str, screen: u32) -> Option<u32> {
    let want = format!("Capture screen {screen}");
    for line in listing.lines() {
        // Drop the `[AVFoundation indev @ 0x…]` prefix first: the index bracket is *not*
        // the last `]` on the line, so a right-to-left split swallows the index.
        let Some((_, rest)) = line.split_once(']') else {
            continue;
        };
        let rest = rest.trim_start();
        // `[<index>] <name>` — the index is bracketed and the name follows.
        let Some(rest) = rest.strip_prefix('[') else {
            continue;
        };
        let Some((index, name)) = rest.split_once(']') else {
            continue;
        };
        let name = name.trim();
        if name == want {
            if let Ok(index) = index.trim().parse::<u32>() {
                return Some(index);
            }
        }
    }
    None
}

/// The platform's recording command writing to `out` on `device`, or `None` where this
/// module has no reader (honest "not implemented here", never a stub that pretends).
pub fn record_command(
    out: &Path,
    max_secs: u32,
    device: &str,
) -> Option<(&'static str, Vec<String>)> {
    #[cfg(target_os = "macos")]
    {
        Some(macos_record_command(out, max_secs, device))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (out, max_secs, device);
        None
    }
}

/// Whether this build can record the screen at all, and if not, why.
///
/// The honest-boundary shape [`crate::recording::RecordingCaptureStatus`] uses, for the
/// same reason: capability is a fact a surface must not round up, and the reason is the
/// host's own words so the UI cannot drift into a second story about why it is missing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScreenRecordCapability {
    /// A recording can be started *right now* on this build.
    pub available: bool,
    /// Why `available` is false, in the host's own words ("" when available).
    pub reason: String,
}

/// Fold (platform supports recording, the OS's name) into a [`ScreenRecordCapability`].
///
/// Pure, so every arm a UI can read is testable without a device. The invariant a caller
/// relies on and a test pins: `available == true` **iff** `reason` is empty. It holds
/// **by construction** — the reason is `""` on the supported arm and a non-empty sentence
/// naming the OS otherwise — so no arm can return "available" with a reason or
/// "unavailable" with an empty one.
pub fn capability_from(platform_supports_record: bool, os: &str) -> ScreenRecordCapability {
    let reason = if platform_supports_record {
        String::new()
    } else {
        format!(
            "screen recording is not available on {os} (this build records on macOS, and \
             on Android once the capture glue is bound to a foreground Activity)"
        )
    };
    ScreenRecordCapability {
        available: reason.is_empty(),
        reason,
    }
}

/// Fold (the OS can record, the recording tool was found, the tool's name) into a
/// [`ScreenRecordCapability`].
///
/// A second function rather than a widened [`capability_from`] because the two are
/// different facts and the *reason* has to be different: "this platform has no capture
/// path" is not "this platform records, but the tool it spawns is not installed". A user
/// can act on the second (install it) and cannot on the first.
///
/// The invariant is the same and holds the same way: the reason is non-empty on every
/// arm that is not available, and the reason is what names the missing piece. Pure, so
/// both arms are tested on any dev host.
pub fn capability_with_tool(
    platform_supports_record: bool,
    tool_found: bool,
    tool: &str,
) -> ScreenRecordCapability {
    if !platform_supports_record {
        // Nothing to check: the platform itself is the missing piece.
        return ScreenRecordCapability {
            available: false,
            reason: format!(
                "screen recording is not available on {}",
                std::env::consts::OS
            ),
        };
    }
    let reason = if tool_found {
        String::new()
    } else {
        format!(
            "screen recording on this host needs `{tool}` (it captures the screen through \
             avfoundation) and no `{tool}` was found on PATH; install it and start again"
        )
    };
    ScreenRecordCapability {
        available: reason.is_empty(),
        reason,
    }
}

/// Read the platform fact for [`capability_with_tool`] on this target.
///
/// Every other target answers `false` with a reason naming itself. The Android answer is
/// not "Android has `MediaProjection`" but "the Kotlin glue is reachable from here" — see
/// [`crate::screen_record_android::capability`]: until `MainActivity` has installed the JNI
/// binding there is no VM to call and no Activity for the consent dialog, so a blanket
/// `true` would advertise a button that cannot work.
pub fn capability() -> ScreenRecordCapability {
    #[cfg(feature = "android")]
    {
        crate::screen_record_android::capability()
    }
    #[cfg(not(feature = "android"))]
    {
        #[cfg(target_os = "macos")]
        {
            // Not `capability_from(true, …)`: the tool is a real precondition, and a
            // machine without it must say so rather than advertise a Start that spawns
            // nothing (the "capability read as an observation" shape).
            capability_with_tool(true, ffmpeg_in_path().is_some(), RECORD_TOOL)
        }
        #[cfg(not(target_os = "macos"))]
        {
            capability_from(false, std::env::consts::OS)
        }
    }
}

/// The first `dir/<name>` that exists, searching `path` left to right.
///
/// Pure over (path list, name, does-it-exist) so the search rule is tested without a
/// filesystem — the injected probe is what makes "the second entry wins" and "an empty
/// entry is skipped" assertable. An empty `PATH` entry means the current directory,
/// which is why `""` is skipped rather than joined onto.
pub fn found_in_path(path: &str, name: &str, exists: &impl Fn(&Path) -> bool) -> Option<PathBuf> {
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if exists(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// The `ffmpeg` this host will spawn, or `None` when it is not on `PATH`.
///
/// A probe, not a stored fact: [`capability`] reads it on every call, and
/// `screen_record_start` calls [`capability`] as its first act — so a tool the user
/// uninstalled since the UI last asked is caught before a spawn, rather than surfacing as
/// a `spawn()` error naming the OS.
pub fn ffmpeg_in_path() -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    found_in_path(&path, RECORD_TOOL, &|p| p.is_file())
}

/// Turn a finished recording into the command's answer: the tool must have left a
/// **non-empty** file behind.
///
/// `size_of` is injected (and answers `None` for "no file") so the rule is unit-tested
/// without running anything. Two failures are refused by name: no file at all, and a
/// file with zero bytes — the latter is what a denied Screen Recording grant or a
/// `MediaRecorder` with no surface produces while still exiting 0.
pub fn confirm_written(
    out: &Path,
    size_of: &impl Fn(&Path) -> Option<u64>,
) -> Result<String, String> {
    match size_of(out) {
        None => Err(format!(
            "the recording tool ran but wrote no file at {}",
            out.display()
        )),
        Some(0) => Err(format!(
            "the recording tool wrote an empty file at {} (no frames captured)",
            out.display()
        )),
        Some(_) => Ok(out.to_string_lossy().into_owned()),
    }
}

/// The host's answer about a recording session, live or idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScreenRecordStatus {
    /// A recording child is running and writing frames.
    pub recording: bool,
    /// A stop is **in flight**: the tool has been signalled and the file is being
    /// sealed. Distinct from `recording` so a UI can say "finishing…" instead of lying
    /// in either direction during the (short) window before the file is confirmed.
    pub stopping: bool,
    /// When the session started (ms since the Unix epoch); `0` when no session has begun.
    /// A `screen_record_stop` answer carries the **finished** session's start instant.
    pub started_ms: u64,
    /// Whole seconds since `started_ms`; `0` when no session has begun (and when a finished
    /// session did not report a start instant — `0` is the wire's "not known", never `now`).
    pub elapsed_secs: u64,
    /// The session's duration ceiling (seconds); `0` when no session has begun, and for a
    /// `screen_record_stop` answer, whose session has already ended.
    pub max_secs: u32,
    /// The file the session is writing — or, in a `screen_record_stop` answer, the file it
    /// wrote.
    pub out: Option<String>,
}

impl ScreenRecordStatus {
    /// The idle answer — no session, nothing to seal.
    pub fn idle() -> Self {
        Self {
            recording: false,
            stopping: false,
            started_ms: 0,
            elapsed_secs: 0,
            max_secs: 0,
            out: None,
        }
    }
}

/// One running recording.
///
/// macOS-only: it is a handle on a **child process**, which is the half of screen
/// recording Android does not have (there the session is the Kotlin glue's, and this
/// host holds nothing — see [`screen_record_android`]).
#[cfg(not(feature = "android"))]
struct Active {
    /// The platform tool. Held so the host can wait on its exit and reap it (a dropped
    /// `Child` that is still running becomes a zombie).
    child: tokio::process::Child,
    /// The pid the child reported at spawn, read **then** and carried here rather than
    /// re-derived at stop: `Child::id` answers `None` once the child has been reaped, and
    /// the only sentinel an absent pid has is `0`, which `kill` reads as "the whole process
    /// group". Storing the checked value is what keeps the stop path from ever naming a
    /// target it did not observe ([`screen_record_start`]).
    pid: u32,
    /// The file this session writes.
    out: PathBuf,
    /// When it started (ms since the Unix epoch).
    started_ms: u64,
    /// Its duration ceiling (seconds) — also passed to the tool as `-t`.
    max_secs: u32,
}

/// A session whose stop has been signalled but not yet confirmed.
#[cfg(not(feature = "android"))]
struct Stopping {
    out: PathBuf,
    started_ms: u64,
    max_secs: u32,
}

#[cfg(not(feature = "android"))]
#[derive(Default)]
struct Inner {
    active: Option<Active>,
    stopping: Option<Stopping>,
    /// Bumped on every start. A stop carries the generation it began under so a
    /// straggler cannot clear a session started after it (the `CameraGlue.kt` rule).
    generation: u64,
}

/// The host's screen-recording state: at most one session at a time.
///
/// A single-slot state machine rather than a set, because the platform has one screen:
/// two concurrent `ffmpeg -f avfoundation` writers would race for the same pixels and one
/// would land a truncated file. A second start is refused by name
/// (`ScreenRecordAlreadyRecording`) rather than silently replacing the first.
#[cfg(not(feature = "android"))]
pub struct ScreenRecorder {
    inner: tokio::sync::Mutex<Inner>,
}

/// Android's screen-recording state: **nothing**, stated as a type.
///
/// The session is the Kotlin glue's (`MediaProjection` + `MediaRecorder` held on a
/// foreground service), so this host has no slot to keep and no generation to guard —
/// the glue carries its own counter. The type stays a zero-sized placeholder so
/// `manage()` and every command signature are identical on both platforms, rather than
/// the command set forking by platform in `lib.rs`.
#[cfg(feature = "android")]
#[derive(Default)]
pub struct ScreenRecorder;

#[cfg(not(feature = "android"))]
impl Default for ScreenRecorder {
    fn default() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(Inner::default()),
        }
    }
}

impl ScreenRecorder {
    pub fn new() -> Self {
        // Android's `ScreenRecorder` is a unit struct (the Kotlin glue owns the session), so
        // `Self::default()` there would be `ScreenRecorder::default()` — which clippy reads as
        // an indirect way of writing `ScreenRecorder`.
        #[cfg(feature = "android")]
        let this = ScreenRecorder;
        #[cfg(not(feature = "android"))]
        let this = Self::default();
        this
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

/// The foreground rule for screen recording — the family
/// [`crate::clipboard::require_foreground`] already guards for `clipboard_read`,
/// the recordings ledger and the SMS/mail reads.
///
/// Starting or stopping a screen recording is a **capture of everything on the screen**,
/// which is a stronger disclosure than any ledger read. Without this, any window's
/// WebView could begin recording the user's whole desktop with one `invoke`, and the
/// frontend's capability ledger is a `$state` in the very JS context doing the
/// reaching, so it can never be the guard. The caller's label is injected by Tauri (not
/// an argument), so a caller cannot claim to be another window.
///
/// **`screen_record_status` is deliberately not gated**: it discloses only that a
/// recording is running, which the on-screen indicator ([`ScreenRecordIndicator`] in the
/// shell) is already displaying to anyone looking. Gating it would add a refusal with no
/// privacy gain and break the very indicator it protects.
pub fn require_screen_record_foreground(
    wm: &crate::wm::WmState,
    caller: &str,
) -> Result<(), AmosError> {
    crate::clipboard::require_foreground(wm, caller).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::ScreenRecordForegroundRequired,
            format!(
                "screen recording refused: {e} (only the window the user is looking at \
                 may start or stop a capture of the whole screen)"
            ),
            e,
        )
    })
}

/// The `avfoundation` device string for `screen`, asked of the tool itself.
///
/// Runs `ffmpeg -list_devices`, which prints its listing to **stderr** and then exits
/// non-zero ("Input/output error": there is no such input as `""`). That status is
/// **expected** and deliberately not read as a verdict — the listing on stderr is the
/// whole point of the call, and treating a non-zero exit as failure would make every
/// start fail on a host where the tool is working exactly as documented.
///
/// A screen the host does not list is a **named refusal**: falling back to screen 0
/// would answer "recording" for a screen the caller did not ask for, and the file would
/// be the wrong one with nothing to say so.
///
/// The other half of this pair covers every non-Android target *except* macOS: the start
/// path is shared, so the name has to exist there, and it answers with the honest refusal
/// rather than a placeholder device that something downstream might spawn with.
#[cfg(all(not(target_os = "macos"), not(feature = "android")))]
pub async fn screen_device_for(_screen: u32) -> Result<String, AmosError> {
    Err(AmosError::new(
        ErrorCode::ScreenRecordUnsupported,
        format!(
            "screen recording is not implemented on {}",
            std::env::consts::OS
        ),
    ))
}

#[cfg(all(target_os = "macos", not(feature = "android")))]
pub async fn screen_device_for(screen: u32) -> Result<String, AmosError> {
    let listing = tokio::process::Command::new(RECORD_TOOL)
        .args([
            "-hide_banner",
            "-f",
            "avfoundation",
            "-list_devices",
            "true",
            "-i",
            "",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            AmosError::new(
                ErrorCode::ScreenRecordSpawnFailed,
                format!("could not ask {RECORD_TOOL} which screens it sees: {e}"),
            )
        })?;
    let text = String::from_utf8_lossy(&listing.stderr);
    match screen_device_index(&text, screen) {
        Some(index) => Ok(index.to_string()),
        None => Err(AmosError::new(
            ErrorCode::ScreenRecordUnsupported,
            format!(
                "{RECORD_TOOL} lists no screen device named `Capture screen {screen}` on this \
                 host, so nothing was started (this is the one that was asked for; listing the \
                 screens a host does have is `{RECORD_TOOL} -f avfoundation -list_devices true \
                 -i \"\"`)"
            ),
        )),
    }
}

/// Choose a free destination without blocking the async runtime.
///
/// `std::fs::create_dir_all` and the collision `exists` probe are **blocking** calls, so
/// they run on the blocking pool — the same rule [`crate::screenshot`]'s synchronous
/// command sidesteps by not being `async`. The collision rule itself is
/// [`crate::screenshot::unique_in`]'s, reused rather than reimplemented so the two
/// capture kinds cannot disagree about what "already taken" means.
#[cfg(not(feature = "android"))]
async fn prepare_destination() -> Result<PathBuf, AmosError> {
    tokio::task::spawn_blocking(|| {
        let home = dirs::home_dir().ok_or("no home directory: cannot resolve Movies")?;
        let dir = screen_recording_dir_in(&home);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        Ok(crate::screenshot::unique_in(
            &dir,
            &filename_for(now_ms() as i64),
            &|p| p.exists(),
        ))
    })
    .await
    .map_err(|e| AmosError::new(ErrorCode::ScreenRecordSpawnFailed, format!("{e}")))?
    .map_err(|e: String| AmosError::new(ErrorCode::ScreenRecordSpawnFailed, e))
}

/// Tauri command: begin recording the screen into `~/Movies`.
///
/// Returns the live [`ScreenRecordStatus`] (not `()`): `invoke` resolves `null` for a
/// failed command, and a `Result<(), _>` also serializes its success as `null`, so a
/// void answer would make "recording" and "refused" the same value at the wire.
///
/// `max_secs` is a *request* resolved by [`resolve_max_secs`] **before either platform
/// starts anything**: a bound outside `[MIN_RECORD_SECS, MAX_RECORD_SECS]` is refused by
/// name, and the accepted bound is handed to the tool, so the ceiling holds even if the
/// host never gets to stop it. `display` is optional and only meaningful on a
/// multi-display host; its index semantics are the tool's.
#[tauri::command]
pub async fn screen_record_start(
    wm: State<'_, crate::wm::WmState>,
    recorder: State<'_, ScreenRecorder>,
    window: WebviewWindow,
    max_secs: Option<u32>,
    display: Option<u32>,
) -> AmosResult<ScreenRecordStatus> {
    require_screen_record_foreground(wm.inner(), window.label())?;

    let cap = capability();
    if !cap.available {
        return Err(AmosError::new(
            ErrorCode::ScreenRecordUnsupported,
            cap.reason,
        ));
    }

    // Resolve the bound once, for **both** platforms, and before anything is started: a
    // request the host will not honour is refused here rather than becoming a capture that
    // silently stops early. (Done above the `cfg` split so the rule cannot drift between
    // the two implementations, which is where it would be discovered last.)
    let max_secs = resolve_max_secs(max_secs)?;

    // Android has no child to own: the Kotlin glue holds the session and the consent
    // dialog means it may not exist until the user answers — see
    // `screen_record_android`, which is the whole of the platform difference from here on.
    #[cfg(feature = "android")]
    {
        // The host's slot stays empty on Android: the glue is the session's owner.
        let _ = &recorder;
        crate::screen_record_android::start(max_secs, display).await
    }

    #[cfg(not(feature = "android"))]
    {
        // Refuse a second start **before** touching the filesystem: naming the conflict is
        // the useful answer, and a refused start must not leave a stray empty file behind.
        {
            let inner = recorder.inner.lock().await;
            if inner.active.is_some() || inner.stopping.is_some() {
                return Err(AmosError::new(
                    ErrorCode::ScreenRecordAlreadyRecording,
                    "a screen recording is already in progress; stop it before starting another",
                ));
            }
        }

        // Which screen to capture is the tool's own vocabulary, so it is looked up from the
        // tool rather than translated by us — see [`screen_device_for`].
        let device = screen_device_for(display.unwrap_or(0)).await?;

        let out = prepare_destination().await?;
        let Some((program, args)) = record_command(&out, max_secs, &device) else {
            return Err(AmosError::new(
                ErrorCode::ScreenRecordUnsupported,
                format!(
                    "screen recording is not implemented on {}",
                    std::env::consts::OS
                ),
            ));
        };

        let mut child = tokio::process::Command::new(program)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| {
                AmosError::new(
                    ErrorCode::ScreenRecordSpawnFailed,
                    format!("could not start {program}: {e}"),
                )
            })?;
        // The pid is read **once**, here, and carried on the session — not re-read at stop.
        // A child that reported no id could not be signalled, so the start is refused now
        // rather than yielding a session no stop could seal; and storing the checked value
        // is what keeps `screen_record_stop` from having to invent a pid, where the only
        // sentinel an absent one has is `0` — and `kill -INT 0` signals the **whole process
        // group**, i.e. the host itself. An unreachable fold is still a fold that describes
        // a different act than the one intended (REQ-A1684).
        let pid = child.id().ok_or_else(|| {
            AmosError::new(
                ErrorCode::ScreenRecordSpawnFailed,
                format!("{program} started but reported no process id"),
            )
        })?;

        // **A spawn is not yet a recording.** `ffmpeg` dies inside the first second when it
        // cannot open the capture device — the missing-Screen-Recording-grant case is
        // exactly this, and it exits with its own error rather than lingering. Reporting
        // `recording: true` off the mere `spawn()` would light the REC indicator for a
        // capture that is not happening, which is the "capability read as an observation"
        // shape this repo keeps removing. So the birth is **observed**: after a short grace
        // the child must still be alive, or the start is refused by name. (The same grace is
        // why `SPAWN_GRACE_MS` is a floor on how fast a start can answer, and why
        // `tests/screen_record_e2e.rs` asserts the refusal's precondition rather than
        // assuming it.)
        tokio::time::sleep(std::time::Duration::from_millis(SPAWN_GRACE_MS)).await;
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(AmosError::new(
                    ErrorCode::ScreenRecordSpawnFailed,
                    format!(
                        "{program} exited immediately ({status}); no recording was started \
                     (a missing Screen Recording grant is one cause, but this code path \
                     only establishes the exit)"
                    ),
                ));
            }
            Ok(None) => {}
            Err(e) => {
                return Err(AmosError::new(
                    ErrorCode::ScreenRecordSpawnFailed,
                    format!("could not check whether {program} is still running: {e}"),
                ));
            }
        }

        let started_ms = now_ms();

        let mut inner = recorder.inner.lock().await;
        // Re-check under the lock the same conditions the fast path checked: a concurrent
        // start could have slipped in during the awaits above, and it must not be clobbered.
        if inner.active.is_some() || inner.stopping.is_some() {
            if let Err(e) = child.kill().await {
                // The refusal below is the user's answer; this reports the *other* fact — a
                // recorder we just spawned could not be stopped and may still be writing
                // `out` until its own `-t` bound ends it (REQ-A1913, Power of 10 #7).
                tracing::warn!(
                    pid,
                    error = %e,
                    "could not stop the concurrently-started screen recorder"
                );
            }
            return Err(AmosError::new(
                ErrorCode::ScreenRecordAlreadyRecording,
                "a screen recording was started concurrently; this one was not kept",
            ));
        }
        inner.generation = inner.generation.wrapping_add(1);
        inner.active = Some(Active {
            child,
            pid,
            out: out.clone(),
            started_ms,
            max_secs,
        });

        Ok(ScreenRecordStatus {
            recording: true,
            stopping: false,
            started_ms,
            elapsed_secs: 0,
            max_secs,
            out: Some(out.to_string_lossy().into_owned()),
        })
    }
}

/// Tauri command: signal the running recording to seal its file and confirm it landed.
///
/// The stop is a **two-phase** operation against a shared slot: under the lock the
/// session is removed and a [`Stopping`] marker (carrying the generation and the output
/// path) takes its place; the lock is then **released** before the child is awaited, so
/// `screen_record_status` keeps answering truthfully during the (up to
/// [`STOP_WAIT_SECS`]) seal window rather than blocking behind a lock. The generation
/// check when the marker is cleared is what stops a straggler from a previous session
/// from clearing a newer one.
#[tauri::command]
pub async fn screen_record_stop(
    wm: State<'_, crate::wm::WmState>,
    recorder: State<'_, ScreenRecorder>,
    window: WebviewWindow,
) -> AmosResult<ScreenRecordStatus> {
    require_screen_record_foreground(wm.inner(), window.label())?;

    // Android: the glue seals the recording synchronously and publishes its MediaStore row;
    // there is no child to signal or await, so the whole two-phase dance below is macOS's.
    #[cfg(feature = "android")]
    {
        // The host's slot is never populated on Android: the glue owns the session.
        let _ = &recorder;
        crate::screen_record_android::stop().await
    }

    #[cfg(not(feature = "android"))]
    {
        let (mut child, pid, out, started_ms, generation) = {
            let mut inner = recorder.inner.lock().await;
            let Some(active) = inner.active.take() else {
                return Err(AmosError::new(
                    ErrorCode::ScreenRecordNotRecording,
                    "no screen recording is in progress",
                ));
            };
            inner.stopping = Some(Stopping {
                out: active.out.clone(),
                started_ms: active.started_ms,
                max_secs: active.max_secs,
            });
            (
                active.child,
                active.pid,
                active.out,
                active.started_ms,
                inner.generation,
            )
        };

        // Signal on the way out; a failed signal is not fatal to the confirm below (the
        // tool's own `-t` bound will seal the file), but it *is* why we still wait.
        let (prog, args) = interrupt_command(pid);
        let _ = tokio::process::Command::new(prog)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;

        let sealed =
            tokio::time::timeout(std::time::Duration::from_secs(STOP_WAIT_SECS), child.wait())
                .await;

        let confirmed = match sealed {
            Ok(Ok(_status)) => {
                let size = tokio::fs::metadata(&out).await.map(|m| m.len()).ok();
                confirm_written(&out, &|_| size)
            }
            Ok(Err(e)) => Err(format!("could not wait for the recording tool: {e}")),
            Err(_) => {
                if let Err(e) = child.kill().await {
                    // The timeout below is the user's answer; this reports the *other* fact —
                    // the recording tool outlived both the interrupt and the kill and may still
                    // be appending to `out` until its own `-t` bound ends it (REQ-A1913).
                    tracing::warn!(
                        out = %out.display(),
                        error = %e,
                        "the recording tool did not stop and could not be killed"
                    );
                }
                Err(format!(
                "the recording tool did not finish within {STOP_WAIT_SECS}s of the stop request"
            ))
            }
        };

        // Clear the marker **only** if no newer session has started since (the generation
        // guard). A newer session could not have started while `active` was set, but the
        // await above released the lock, so this is the point where the rule matters.
        {
            let mut inner = recorder.inner.lock().await;
            if inner.generation == generation {
                inner.stopping = None;
            }
        }

        match confirmed {
            Ok(path) => {
                let elapsed = (now_ms().saturating_sub(started_ms)) / 1000;
                Ok(ScreenRecordStatus {
                    recording: false,
                    stopping: false,
                    started_ms,
                    elapsed_secs: elapsed,
                    max_secs: 0,
                    out: Some(path),
                })
            }
            Err(message) => Err(AmosError::new(
                ErrorCode::ScreenRecordConfirmFailed,
                message,
            )),
        }
    }
}

/// Tauri command: the host's answer about the current session (live, sealing or idle).
///
/// Not foreground-gated — see [`require_screen_record_foreground`] for why. Reads the
/// shared slot under a short lock, **reaping** a child that has already exited (its
/// `-t` bound elapsed, or a crash) so `recording` cannot stay `true` past the process
/// it describes. Never awaits a child, so it is cheap enough for a UI to poll for its
/// elapsed clock.
#[tauri::command]
pub async fn screen_record_status(
    recorder: State<'_, ScreenRecorder>,
) -> AmosResult<ScreenRecordStatus> {
    // Android keeps the session in the Kotlin glue (there is no child for this host to
    // reap), so the platform answers for itself — the retraction comment below is about a
    // process that can exit unobserved, and Android has no such process.
    #[cfg(feature = "android")]
    {
        let _ = &recorder;
        crate::screen_record_android::screen_status().await
    }

    #[cfg(not(feature = "android"))]
    {
        let mut inner = recorder.inner.lock().await;

        // **The running bit must be retractable.** A child can end on its own — its
        // `-t<max_secs>` bound elapsing is the designed path, a crash the accidental one —
        // and nothing else in the host would notice, because the child is only ever awaited
        // by an explicit stop. Reaping here is what stops the indicator from outliving the
        // process it describes (the "a transient bit that outlives its evidence" shape).
        let exited = match inner.active.as_mut() {
            Some(active) => matches!(active.child.try_wait(), Ok(Some(_))),
            None => false,
        };
        if exited {
            inner.active = None;
        }

        if let Some(active) = inner.active.as_ref() {
            let elapsed = (now_ms().saturating_sub(active.started_ms)) / 1000;
            return Ok(ScreenRecordStatus {
                recording: true,
                stopping: false,
                started_ms: active.started_ms,
                elapsed_secs: elapsed,
                max_secs: active.max_secs,
                out: Some(active.out.to_string_lossy().into_owned()),
            });
        }
        if let Some(stopping) = inner.stopping.as_ref() {
            let elapsed = (now_ms().saturating_sub(stopping.started_ms)) / 1000;
            return Ok(ScreenRecordStatus {
                recording: false,
                stopping: true,
                started_ms: stopping.started_ms,
                elapsed_secs: elapsed,
                max_secs: stopping.max_secs,
                out: Some(stopping.out.to_string_lossy().into_owned()),
            });
        }
        Ok(ScreenRecordStatus::idle())
    }
}

/// Tauri command: can this build record the screen, and if not, why (in the host's
/// own words)?
///
/// Returns the value directly rather than a `Result`, mirroring
/// `recordings_capture_status`: "this build cannot record" is a **fact**, not a failed
/// read, and wrapping it in `Err` would make a UI unable to tell it apart from the
/// command itself being missing.
#[tauri::command]
pub fn screen_record_capability() -> ScreenRecordCapability {
    capability()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_filename_has_macos_shape() {
        assert_eq!(
            filename_from_parts("2026-09-20", "14.03.05"),
            "Screen Recording 2026-09-20 at 14.03.05.mov"
        );
    }

    #[test]
    fn filename_for_a_real_instant_keeps_the_shape() {
        // 2026-09-20T00:00:00Z; the *value* depends on the test host's timezone, so
        // only the shape is asserted (a date, an `at`, a clock, a `.mov`).
        let name = filename_for(1_789_891_200_000);
        let rest = name
            .strip_prefix("Screen Recording ")
            .and_then(|s| s.strip_suffix(".mov"))
            .expect("the expected prefix/suffix");
        let (date, time) = rest.split_once(" at ").expect("a date `at` a time");
        assert_eq!(date.len(), 10, "YYYY-MM-DD: {date}");
        assert_eq!(time.len(), 8, "HH.MM.SS: {time}");
        assert_eq!(date.matches('-').count(), 2);
        assert_eq!(time.matches('.').count(), 2);
    }

    #[test]
    fn an_unrepresentable_instant_still_yields_a_recording_name() {
        let name = filename_for(i64::MAX);
        assert_eq!(name, format!("Screen Recording {}.mov", i64::MAX));
    }

    #[test]
    fn the_destination_is_the_dir_the_files_app_reads() {
        assert_eq!(
            screen_recording_dir_in(Path::new("/Users/me")),
            PathBuf::from("/Users/me/Movies")
        );
        // The wire spelling the frontend mirrors (`lib/media.ts`).
        assert_eq!(SCREEN_RECORDING_REL_DIR, "Movies");
    }

    #[test]
    fn an_absent_bound_is_the_ceiling_and_a_legal_one_is_kept() {
        assert_eq!(resolve_max_secs(None).ok(), Some(MAX_RECORD_SECS));
        assert_eq!(resolve_max_secs(Some(60)).ok(), Some(60));
        // Both bounds are **inclusive** — the boundary values are legal requests, and
        // `Some(MAX_RECORD_SECS)` in particular must not be refused by an off-by-one
        // (it is what a UI's "30 minutes" option sends).
        assert_eq!(
            resolve_max_secs(Some(MIN_RECORD_SECS)).ok(),
            Some(MIN_RECORD_SECS)
        );
        assert_eq!(
            resolve_max_secs(Some(MAX_RECORD_SECS)).ok(),
            Some(MAX_RECORD_SECS)
        );
    }

    #[test]
    fn a_bound_outside_the_range_is_refused_by_name_not_shortened() {
        // The defect this pins: a silent clamp turns "record for an hour" into a
        // 30-minute file that looks complete. Every out-of-range request must be a
        // **named** refusal — the wire code two surfaces already spell — so the caller can
        // say what went wrong without parsing a message (REQ-A1795).
        for requested in [0u32, u32::MAX, MAX_RECORD_SECS + 1] {
            let err = resolve_max_secs(Some(requested)).expect_err("must refuse");
            assert_eq!(err.code, ErrorCode::ScreenRecordDurationOutOfRange);
            // The message names both the request and the rule, so a log line alone is
            // actionable (the same shape as `sensors`' `rate_hz` refusal).
            assert!(err.message.contains(&requested.to_string()), "{err:?}");
            assert!(
                err.message.contains(&MAX_RECORD_SECS.to_string()),
                "{err:?}"
            );
        }
    }

    #[test]
    fn a_run_that_wrote_nothing_is_a_refusal_not_a_success() {
        // "No file" and "an empty file" are two distinct refusals — the second is what a
        // denied Screen Recording grant produces while the tool still exits 0.
        let out = Path::new("/shots/a.mov");
        assert!(confirm_written(out, &|_| None).is_err());
        assert!(confirm_written(out, &|_| Some(0)).is_err());
        assert_eq!(
            confirm_written(out, &|_| Some(2048)),
            Ok("/shots/a.mov".to_string())
        );
    }

    #[test]
    fn capability_never_reports_available_with_a_reason_nor_unavailable_without_one() {
        // The invariant a caller relies on: `available == reason.is_empty()`, by
        // construction, on **both** arms (a test of only one arm would pass under an
        // "always refuse" implementation).
        let yes = capability_from(true, "macos");
        assert!(yes.available);
        assert!(yes.reason.is_empty());

        let no = capability_from(false, "android");
        assert!(!no.available);
        assert!(!no.reason.is_empty());
        assert!(no.reason.contains("android"), "names the OS: {}", no.reason);
    }

    #[test]
    fn a_stopped_session_reports_idle_with_no_start() {
        let idle = ScreenRecordStatus::idle();
        assert!(!idle.recording && !idle.stopping);
        assert_eq!(idle.started_ms, 0);
        assert_eq!(idle.elapsed_secs, 0);
        assert_eq!(idle.max_secs, 0);
        assert_eq!(idle.out, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_record_moves_the_frames_to_the_given_path_within_the_bound() {
        let (program, args) = macos_record_command(Path::new("/tmp/a.mov"), 30, "2");
        assert_eq!(program, "ffmpeg");
        assert_eq!(
            args,
            vec![
                "-hide_banner".to_string(),
                "-loglevel".to_string(),
                "error".to_string(),
                "-f".to_string(),
                "avfoundation".to_string(),
                "-pixel_format".to_string(),
                "nv12".to_string(),
                "-capture_cursor".to_string(),
                "1".to_string(),
                "-framerate".to_string(),
                "30".to_string(),
                "-i".to_string(),
                "2".to_string(),
                // The ceiling is the *tool's* own bound, which is what makes it hold even
                // if the host dies before it can stop the child.
                "-t".to_string(),
                "30".to_string(),
                "-c:v".to_string(),
                "h264".to_string(),
                "-y".to_string(),
                "/tmp/a.mov".to_string(),
            ]
        );
        // The destination is the last word, so nothing after it can be mistaken for it.
        assert_eq!(args.last().map(String::as_str), Some("/tmp/a.mov"));
        assert!(record_command(Path::new("/tmp/a.mov"), 30, "2").is_some());

        // The interrupt is SIGINT (the signal that seals the file), by pid.
        let (kill, kargs) = interrupt_command(4242);
        assert_eq!(kill, "kill");
        assert_eq!(kargs, vec!["-INT".to_string(), "4242".to_string()]);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_have_no_record_command() {
        assert_eq!(record_command(Path::new("/tmp/a.mov"), 30, "2"), None);
    }

    /// The listing below is **captured from this dev host** (`ffmpeg 8.1.2`, macOS 26.4.1),
    /// including the noise lines ffmpeg interleaves — the parse has to survive them.
    const DEV_HOST_LISTING: &str = "\
[AVFoundation indev @ 0xaa8c18140] AVFoundation video devices:
[AVFoundation indev @ 0xaa8c18140] [0] MacBook Pro相机
[AVFoundation indev @ 0xaa8c18140] [1] MacBook Pro桌上视角相机
[AVFoundation indev @ 0xaa8c18140] [2] Capture screen 0
[AVFoundation indev @ 0xaa8c18140] AVFoundation audio devices:
[AVFoundation indev @ 0xaa8c18140] [0] MacBook Pro麦克风
";

    #[test]
    fn the_screen_device_is_found_by_name_not_by_position() {
        // The load-bearing property: on this host the screen is index **2**, not 0 — the
        // cameras take the low indices. An implementation that assumed 0 would record a
        // camera and still call it a screen recording.
        assert_eq!(screen_device_index(DEV_HOST_LISTING, 0), Some(2));
        // The audio device is also `[0]`; nothing may match it.
        assert_eq!(screen_device_index(DEV_HOST_LISTING, 1), None);
        // A screen the host does not list is `None`, so the caller refuses by name
        // instead of quietly capturing the first one.
        assert_eq!(screen_device_index("", 0), None);
        assert_eq!(
            screen_device_index("[x] [0] Capture screen 0x", 0),
            None,
            "a prefix match must not pass for the screen itself"
        );
    }

    #[test]
    fn a_second_screen_is_matched_by_its_own_number() {
        let listing = "[i] [3] Capture screen 0\n[i] [7] Capture screen 1\n";
        assert_eq!(screen_device_index(listing, 0), Some(3));
        assert_eq!(screen_device_index(listing, 1), Some(7));
        assert_eq!(screen_device_index(listing, 2), None);
    }

    #[test]
    fn the_path_search_takes_the_first_hit_and_skips_empty_entries() {
        let path = "/nope::/yes:/also";
        let found = found_in_path(path, "ffmpeg", &|p| p == Path::new("/yes/ffmpeg"));
        assert_eq!(found, Some(PathBuf::from("/yes/ffmpeg")));
        // An empty entry is the current directory, never a hit.
        assert_eq!(
            found_in_path(":/yes", "ffmpeg", &|p| p == Path::new("ffmpeg")),
            None
        );
        assert_eq!(found_in_path("/nope", "ffmpeg", &|_| false), None);
        // The positive control for the *name*: a same-named binary elsewhere is a hit
        // because it is the same name, and a different name is not.
        assert_eq!(
            found_in_path("/bin", "ffmpeg", &|p| p == Path::new("/bin/ffmpeg")),
            Some(PathBuf::from("/bin/ffmpeg"))
        );
        assert_eq!(
            found_in_path("/bin", "ffmpeg", &|p| p == Path::new("/bin/ffprobe")),
            None
        );
    }

    #[test]
    fn a_missing_tool_is_unavailable_with_the_tool_named() {
        // The invariant, on both arms of the *second* fold too: a supported platform
        // whose tool is missing must not answer "available".
        let missing = capability_with_tool(true, false, RECORD_TOOL);
        assert!(!missing.available);
        assert!(
            missing.reason.contains(RECORD_TOOL),
            "the reason must name the missing tool: {}",
            missing.reason
        );
        assert!(
            !missing.reason.contains("not available on"),
            "finding the tool installed and the platform having no capture path are \
             different facts and must not share a sentence: {}",
            missing.reason
        );

        let present = capability_with_tool(true, true, RECORD_TOOL);
        assert!(present.available);
        assert!(present.reason.is_empty());

        // Positive control: an unsupported *platform* is refused even with the tool
        // present, so the tool check cannot be the whole rule.
        let wrong_os = capability_with_tool(false, true, RECORD_TOOL);
        assert!(!wrong_os.available);
        assert!(!wrong_os.reason.is_empty());
    }

    /// Every `docs/….md` path this module's **doc comments** cite.
    ///
    /// Only document-comment lines (`//!` / `///`) are read, so a path that appears in an
    /// ordinary string literal is not mistaken for a citation — the distinction a
    /// whole-file scan gets wrong, and the one that keeps [`every_document_this_module_cites_exists`]
    /// from matching the fixture paths its own negative control spells in string literals.
    fn cited_docs_in_doc_comments(src: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for line in src.lines() {
            let trimmed = line.trim_start();
            if !(trimmed.starts_with("//!") || trimmed.starts_with("///")) {
                continue;
            }
            for (i, _) in line.match_indices("docs/") {
                let rest = &line[i..];
                let end = rest
                    .find(|c: char| {
                        !(c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
                    })
                    .unwrap_or(rest.len());
                let path = &rest[..end];
                if path.ends_with(".md") && !out.iter().any(|p| p == path) {
                    out.push(path.to_string());
                }
            }
        }
        out
    }

    /// A citation to a document that is not there is a promise this module cannot keep.
    ///
    /// The module's honest boundaries are **disclosed** in the `docs/….md` files it names —
    /// the frame-rate ceiling, the `ffmpeg`-vs-`screencapture` measurement and the
    /// destination's trade all point at `docs/screen-recording.md`. Nothing checked that:
    /// the repo's `docs-link-scan` resolves Markdown links inside `.md` files only, so a
    /// `docs/….md` path written in a Rust doc comment sits in **no** gate's window, and the
    /// citation shipped green while pointing at a file that did not exist
    /// (REQ-A1628 ∕ F-DEV-142).
    #[test]
    fn every_document_this_module_cites_exists() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("crates/<crate> has a repo root two levels above it");
        let cited = cited_docs_in_doc_comments(include_str!("screen_record.rs"));
        // Positive control: the module must still defer to a document somewhere. An empty
        // `cited` would make every assertion below vacuously true.
        assert!(
            !cited.is_empty(),
            "this module defers its honest boundaries to `docs/…` files and must cite at \
             least one of them"
        );
        for rel in &cited {
            assert!(
                root.join(rel).is_file(),
                "this module cites `{rel}`, a document that is not there — a promise it \
                 cannot keep"
            );
        }
    }

    #[test]
    fn the_citation_extractor_reads_doc_comments_and_ignores_code_strings() {
        // Positive control: a citation in a doc comment is found.
        assert_eq!(
            cited_docs_in_doc_comments("//! see `docs/a.md` for the trade"),
            vec!["docs/a.md".to_string()]
        );
        // Negative control: the *same* text in an ordinary string literal is not a citation
        // — this is what keeps the guard above from matching its own fixtures.
        assert!(cited_docs_in_doc_comments("let p = \"docs/a.md\";").is_empty());
        // A non-`.md` path is not a document citation.
        assert!(cited_docs_in_doc_comments("/// a docs/notes.txt is not a document").is_empty());
        // Duplicates collapse, and a missing document is *reported* so the guard can fail.
        assert_eq!(
            cited_docs_in_doc_comments("/// `docs/gone.md` and `docs/gone.md`"),
            vec!["docs/gone.md".to_string()]
        );
        assert!(cited_docs_in_doc_comments("/// no citation here").is_empty());
    }

    /// Every `F-<AREA>-<n>` FMEA id cited in a file's **comment lines**.
    ///
    /// Comments only (`//`, `///`, `//!`), the same discipline [`cited_docs_in_doc_comments`]
    /// applies to document paths and for the same reason: the guard's negative control spells
    /// an id inside an ordinary string literal, and a whole-file scan would demand a row for
    /// a token that is a test input rather than a citation.
    fn cited_fmea_ids_in(src: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for line in src.lines() {
            if !line.trim_start().starts_with("//") {
                continue;
            }
            for (i, _) in line.match_indices("F-") {
                let rest = &line[i..];
                let end = rest
                    .find(|c: char| !(c.is_ascii_uppercase() || c == '-' || c.is_ascii_digit()))
                    .unwrap_or(rest.len());
                let token = &rest[..end];
                if is_fmea_id(token) && !out.iter().any(|t| t == token) {
                    out.push(token.to_string());
                }
            }
        }
        out
    }

    /// `F-AREA-n`: an uppercase area, a dash, then digits — the shape both the doc's row
    /// parser (`fmea-gen.mjs`) and its duplicate check spell an id.
    fn is_fmea_id(token: &str) -> bool {
        let Some(rest) = token.strip_prefix("F-") else {
            return false;
        };
        let Some((area, num)) = rest.rsplit_once('-') else {
            return false;
        };
        !area.is_empty()
            && area.chars().all(|c| c.is_ascii_uppercase())
            && !num.is_empty()
            && num.chars().all(|c| c.is_ascii_digit())
    }

    /// An FMEA id cited by the newest subsystem must have a row to point at.
    ///
    /// The screen-recording subsystem's comments name the failures it inherits and the ones
    /// it introduces — `F-AND-007` (the REC marker blanked over a live capture `F-AND-011`
    /// leaves unblanked), `F-AND-013` (a finished capture's foreground service left running),
    /// `F-DEV-142` (a cited document that was not there). `F-DEV-141` was named by seven
    /// files (the Rust seam, `lib.rs`, the Kotlin wiring & the glue's host-JVM test, the
    /// disclosure doc, an Android permission scan) as *the* FMEA row for the Android capture
    /// binding — and no row carried it: `docs/FMEA.md` had no `F-DEV-141` row and the
    /// inventory had no entry. `fmea-gen --check` **saw** it, but only as a `[note]`
    /// (「cited in prose but carrying no table row」), never a failure, so a citation standing
    /// in for a registration shipped green — a note is exactly where a citation-as-row hides
    /// (REQ-A1657 ∕ F-DEV-141).
    ///
    /// Boundary: only the Rust half of the seam is scanned; the Kotlin files cite the same
    /// ids but are pinned from the device-only tests, not from here.
    #[test]
    fn every_fmea_id_this_subsystem_cites_has_a_row() {
        let sources: &[&str] = &[
            include_str!("screen_record.rs"),
            include_str!("screen_record_android.rs"),
        ];
        let inventory: &str = include_str!("../../../docs/FMEA.md");

        let mut cited: Vec<String> = Vec::new();
        for src in sources {
            for id in cited_fmea_ids_in(src) {
                if !cited.iter().any(|c| c == &id) {
                    cited.push(id);
                }
            }
        }
        // Positive control: the subsystem does cite registered failures. An empty `cited`
        // would make the loop below vacuously true.
        assert!(
            !cited.is_empty(),
            "the screen-recording subsystem names the failures it inherits and must cite at \
             least one FMEA id"
        );
        for id in &cited {
            assert!(
                inventory.contains(&format!("\n| {id} |")),
                "the screen-recording subsystem cites `{id}`, but docs/FMEA.md carries no row \
                 for it — a citation standing in for a registration"
            );
        }
    }

    #[test]
    fn the_fmea_citation_extractor_reads_comments_and_ignores_code_strings() {
        // Positive control: an id on a comment line is a citation, and duplicates collapse.
        assert_eq!(
            cited_fmea_ids_in("// see F-AND-013 and F-AND-013 again"),
            vec!["F-AND-013".to_string()]
        );
        // Both doc-comment forms are read, and the id stops at the first non-id character.
        assert_eq!(
            cited_fmea_ids_in("/// (REQ-A1621 ∕ F-AND-011)."),
            vec!["F-AND-011".to_string()]
        );
        assert_eq!(
            cited_fmea_ids_in("//! FMEA row (F-DEV-141) says so."),
            vec!["F-DEV-141".to_string()]
        );
        // Negative control: the *same* token in an ordinary string literal is not a citation —
        // this is what keeps the guard from demanding a row for its own negative-control fixture.
        assert!(cited_fmea_ids_in(r#"let fixture = "F-ZZZ-999";"#).is_empty());
        // Near-misses are not ids: no area, no digits, a lower-case area.
        assert!(cited_fmea_ids_in("// F-142 is not an id").is_empty());
        assert!(cited_fmea_ids_in("// F-abc-142 is not an id").is_empty());
        assert!(cited_fmea_ids_in("// no id here").is_empty());
    }
}
