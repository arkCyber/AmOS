//! `probe_media` — real-media acceptance probe for the local player's data path.
//!
//! Where `scan_dir` prints what a device *sees*, this example **exercises the
//! bytes**: it walks the player's real collections under `ROOT`, and for every
//! audio/video file it verifies that
//!   1. the container magic really matches the inferred type (a `.mp4` starts
//!      with an `ftyp` box, a `.mp3` with `ID3`/a frame sync, a `.wav` with
//!      `RIFF…WAVE`, …) — so a mislabelled file is caught, not assumed playable;
//!   2. `read_range(offset, len)` is **byte-exact** against the whole item for
//!      start / middle / tail / at-EOF / past-EOF / tiny windows; and
//!   3. a browser-style `Range: bytes=0-` request plans a valid `206` window.
//!
//! Exit code is non-zero if any check fails, so it can gate a real-media check.
//!
//! ```sh
//! # Host: point it at a folder that mirrors the Android layout
//! cargo run -p amos-media --example probe_media -- /tmp/amos-real-media
//! # Android (root test box) — same binary, real tree:
//! adb shell 'su -c /data/local/tmp/probe_media /storage/emulated/0'
//! ```

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use amos_media::mapping::extension_of;
use amos_media::{
    plan_response, status_for, HostFsProvider, MediaItem, MediaKind, MediaManager, MediaProvider,
    RangeSpec, ResponsePlan, StandardDir, MAX_RANGE_BYTES,
};

/// The collections the player scans (kept in sync with PlayerApp's list).
const COLLECTIONS: [StandardDir; 5] = [
    StandardDir::Music,
    StandardDir::Movies,
    StandardDir::Camera,
    StandardDir::Recordings,
    StandardDir::Download,
];

/// True when `bytes[off..off+magic.len()] == magic`.
fn at(bytes: &[u8], off: usize, magic: &[u8]) -> bool {
    bytes
        .get(off..off.saturating_add(magic.len()))
        .map(|s| s == magic)
        .unwrap_or(false)
}

/// Whether `bytes` carries the container magic its name implies. Unknown
/// containers return `true` (we never claim a file is broken without evidence).
fn magic_ok(name: &str, bytes: &[u8]) -> bool {
    let ext = extension_of(name).unwrap_or_default();
    match ext.as_str() {
        // ISO-BMFF family (mp4/mov/m4a/3gp): a box length then `ftyp`.
        "mp4" | "m4v" | "mov" | "m4a" | "m4b" | "3gp" | "3g2" => at(bytes, 4, b"ftyp"),
        "mp3" => {
            bytes.starts_with(b"ID3")
                || (bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0)
        }
        "wav" => bytes.starts_with(b"RIFF") && at(bytes, 8, b"WAVE"),
        "flac" => bytes.starts_with(b"fLaC"),
        "ogg" | "oga" | "opus" => bytes.starts_with(b"OggS"),
        // Matroska/WebM share the EBML header.
        "webm" | "mkv" | "mka" => bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]),
        "aac" => bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xF0) == 0xF0,
        _ => true,
    }
}

/// Verify one media item end-to-end. `Err` is a human-readable failure reason.
fn probe(m: &MediaManager, it: &MediaItem) -> Result<(), String> {
    let total = it
        .size_bytes
        .ok_or_else(|| "size is unknown (cannot plan ranges)".to_string())?;
    if total == 0 {
        return Err("file is empty".to_string());
    }
    if it.mime.is_none() {
        return Err("media item carries no MIME".to_string());
    }

    let all = m.load(it).map_err(|e| format!("load: {e}"))?;
    if all.len() as u64 != total {
        return Err(format!("load len {} != reported size {total}", all.len()));
    }
    if !magic_ok(&it.name, &all) {
        return Err(format!("container magic does not match `{}`", it.name));
    }

    // Windowed reads must equal the corresponding slice of the whole item.
    let mid = total / 2;
    for (off, len) in [
        (0_u64, 16_u64),
        (mid, 32),
        (total.saturating_sub(8), 8),
        (total, 4),     // at EOF → empty
        (total + 5, 4), // past EOF → empty
        (2, 3),         // tiny unaligned window
    ] {
        let got = m
            .read_range(it, off, len)
            .map_err(|e| format!("read_range({off},{len}): {e}"))?;
        let s = off.min(total) as usize;
        let e = off.saturating_add(len).min(total) as usize;
        if got != all[s..e] {
            return Err(format!("range ({off},{len}) is not byte-exact"));
        }
    }

    // A media element's first request is `Range: bytes=0-`.
    match plan_response(Some("bytes=0-"), total, MAX_RANGE_BYTES) {
        ResponsePlan::Partial {
            start,
            end,
            total: t,
        } => {
            if start != 0 || t != total {
                return Err(format!("plan start={start} total={t} != 0/{total}"));
            }
            let code = status_for(RangeSpec::Satisfiable { start, end });
            if code != 206 {
                return Err(format!("plan status {code} != 206"));
            }
        }
        other => return Err(format!("expected a 206 window, planned {other:?}")),
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(root_arg) = args.first() else {
        eprintln!("usage: probe_media <ROOT>");
        return ExitCode::from(2);
    };
    let provider: Arc<dyn MediaProvider> = Arc::new(HostFsProvider::new(PathBuf::from(root_arg)));
    let manager = MediaManager::new(provider);
    for c in COLLECTIONS {
        manager.grant_read(c);
    }

    let (mut seen, mut media, mut failures) = (0_usize, 0_usize, 0_usize);
    for c in COLLECTIONS {
        let items = match manager.list(c) {
            Ok(items) => items,
            Err(e) => {
                println!("SKIP {c:?}: {e}");
                continue;
            }
        };
        for it in items {
            seen += 1;
            if !matches!(it.kind, MediaKind::Audio | MediaKind::Video) {
                println!(
                    "--  {c:?}/{:<24} kind={:?} mime={} (not media — not queued)",
                    it.name,
                    it.kind,
                    it.mime.as_deref().unwrap_or("-")
                );
                continue;
            }
            media += 1;
            match probe(&manager, &it) {
                Ok(()) => println!(
                    "OK  {c:?}/{:<24} kind={:?} mime={} bytes={}",
                    it.name,
                    it.kind,
                    it.mime.as_deref().unwrap_or("-"),
                    it.size_bytes.unwrap_or(0)
                ),
                Err(e) => {
                    failures += 1;
                    println!("FAIL {c:?}/{}: {e}", it.name);
                }
            }
        }
    }

    println!("probe: {seen} files, {media} playable, {failures} failures");
    if failures == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
