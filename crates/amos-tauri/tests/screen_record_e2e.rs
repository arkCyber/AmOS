//! Headless screen-recording e2e: run the module's **real** device lookup / spawn /
//! observe / interrupt / confirm sequence and prove the host behaves the way the module
//! claims.
//!
//! This is the gate that separates "the pure rules are unit-tested" from "the host can
//! actually record the screen". It asks the tool for the screen device exactly the way
//! `.await`-ing [`screen_record::screen_device_for`] does, spawns
//! [`screen_record::macos_record_command`] with the exact arguments `screen_record_start`
//! builds, applies the same spawn grace, and then — depending on what the host did —
//! asserts the one thing that must hold.
//!
//! # Two honest outcomes, one assertion each
//!
//! Recording the screen fails in one of two ways, and the module's correctness depends
//! on both being *observed* rather than assumed:
//!
//!   • **The Screen Recording grant is missing** (or the host has no screen device).
//!     `ffmpeg` exits with its own error inside the grace window. The module must not
//!     report a recording, so this test asserts the precondition that refusal rests on:
//!     **a tool that exits inside the grace window wrote no file**.
//!   • **The grant is present.** The tool records until told to stop. This test then
//!     sends the same SIGINT `screen_record_stop` sends and asserts the post-condition
//!     `confirm_written` checks — a non-empty `.mov` — plus, when `ffprobe` is present,
//!     a real duration (which is the difference between "a file" and "a recording").
//!
//! The recorded **pixels** are never asserted: nothing here can say they are right, and
//! the module never claims they are.
//!
//! # Why this test exists at all
//!
//! It is also the gate that **caught the original design being wrong**. The first
//! version of the stop path spawned `screencapture -v` and sealed it with SIGINT. On
//! macOS 26.4.1 that tool buffers the whole recording and writes the file only on a
//! clean exit, and *no* signal seals it — so the success half of this test failed with
//! "the recording tool ran but wrote no file", which is exactly what a user pressing
//! Stop would have seen. See `macos_record_command`'s doc comment for the measurements.
//!
//! macOS-only; other platforms have no `record_command` to exercise.

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn a_real_spawn_is_observed_and_a_real_recording_confirms() {
    use amos_tauri_lib::screen_record::{
        confirm_written, ffmpeg_in_path, filename_for, interrupt_command, macos_record_command,
        screen_device_for, SPAWN_GRACE_MS,
    };
    use amos_tauri_lib::screenshot::unique_in;

    // No tool, no recording — and that is a *capability* answer, not this test's subject.
    // (Asserting a recording without it would be asserting the machine's software.)
    let Some(tool) = ffmpeg_in_path() else {
        eprintln!("no ffmpeg on PATH: the recording path cannot be exercised on this host");
        return;
    };

    let home = dirs::home_dir().expect("a home directory");
    let dir = home.join(amos_tauri_lib::screen_record::SCREEN_RECORDING_REL_DIR);
    std::fs::create_dir_all(&dir).expect("create the recordings dir");

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch")
        .as_millis() as i64;
    let out = unique_in(&dir, &filename_for(now), &|p| p.exists());
    assert!(!out.exists(), "a fresh name must not already exist");

    // The device name is the tool's, looked up the way the command looks it up — a test
    // that hard-coded the index would pass on this machine and record a camera on the
    // next one.
    let device = match screen_device_for(0).await {
        Ok(device) => device,
        Err(e) => {
            eprintln!("this host lists no capture screen: {e}");
            return;
        }
    };

    // A short bound so a lost stop still seals the file; the test stops it early.
    let (program, args) = macos_record_command(&out, 20, &device);
    assert_eq!(
        program,
        tool.file_name().unwrap_or_default().to_string_lossy()
    );
    let mut child = tokio::process::Command::new(&tool)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn the recording tool");

    tokio::time::sleep(std::time::Duration::from_millis(SPAWN_GRACE_MS)).await;

    if let Ok(Some(status)) = child.try_wait() {
        // The tool is already gone: no grant, or no device. This is the precondition
        // `screen_record_start`'s grace refuses on, so assert it holds — a tool that died
        // before recording began must have left nothing behind.
        assert!(
            !out.exists(),
            "a tool that exited immediately ({status}) must not have written a file"
        );
        eprintln!(
            "host has no screen-recording grant (or no screen device): {program} exited \
             {status} inside the {SPAWN_GRACE_MS}ms grace having written nothing — the \
             start-refusal path is exercised; the success path needs a granted host"
        );
        return;
    }

    // Alive: the recording really began. Stop it the way the host does.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // The frames are on disk *while* it records — the property `screencapture -v` did not
    // have, and the one that makes a stop able to confirm anything.
    let mid_run = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    assert!(
        mid_run > 0,
        "ffmpeg writes frames as it captures: 3s in, {} must not be empty",
        out.display()
    );

    let pid = child.id().expect("a pid");
    let (kill, kargs) = interrupt_command(pid);
    std::process::Command::new(kill)
        .args(&kargs)
        .status()
        .expect("send SIGINT");
    tokio::time::timeout(std::time::Duration::from_secs(15), child.wait())
        .await
        .expect("the tool seals within the stop window")
        .expect("the tool exits");

    let size = std::fs::metadata(&out).ok().map(|m| m.len());
    assert_eq!(
        confirm_written(&out, &|_| size),
        Ok(out.to_string_lossy().into_owned()),
        "the recording must exist and be non-empty"
    );
    eprintln!("wrote {} bytes to {}", size.unwrap_or(0), out.display());

    // Duration is the difference between "a file" and "a recording": a truncated or
    // header-only `.mov` would pass the size check but not this one.
    if let Ok(probe) = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &out.to_string_lossy(),
        ])
        .output()
    {
        if probe.status.success() {
            let text = String::from_utf8_lossy(&probe.stdout);
            let secs: f64 = text.trim().parse().unwrap_or(0.0);
            eprintln!("ffprobe duration: {secs}s");
            assert!(
                secs >= 1.0,
                "a ~3s recording must report a real duration: {secs}"
            );
        }
    }
}
