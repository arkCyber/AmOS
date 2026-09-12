//! Bounded on-disk log sink for the daemon (`FUNCTIONAL_GAP_ANALYSIS` #34: tracing
//! only ever went to stdout).
//!
//! The daemon is headless (init.rc / systemd unit), so stdout is frequently dropped
//! — with no file sink, an on-device failure could not be investigated after the
//! fact. This module adds a **bounded, self-rotating** file sink with **no new
//! dependency** (pure `std`):
//!
//! * `AMOS_LOG_DIR` — directory holding `amos-ai.log`. Unset ⇒ `$HOME/.amos/logs`;
//!   `off` / `none` / `0` / empty ⇒ **stdout only**.
//! * `AMOS_LOG_MAX_BYTES` — rotate once the active file reaches this (default 5 MiB).
//! * `AMOS_LOG_KEEP` — how many rotated files to keep (default 3, capped at 64).
//!
//! Honesty rules: every IO step is best-effort. A log file that cannot be opened
//! degrades to **stdout only** (one warning on stderr) and never aborts the daemon;
//! rotation only happens on a **line boundary**, so a file never ends mid-record.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Default active-file size before rotation (5 MiB).
pub const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Default number of rotated files kept.
pub const DEFAULT_KEEP: usize = 3;
/// Upper bound on `AMOS_LOG_KEEP` (a mis-set env must not fill the disk).
pub const MAX_KEEP: usize = 64;
/// Active log file name inside `AMOS_LOG_DIR`.
pub const LOG_FILE_NAME: &str = "amos-ai.log";

/// Where (and how much) to log to disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogFileConfig {
    pub dir: PathBuf,
    pub max_bytes: u64,
    pub keep: usize,
}

/// Parse `AMOS_LOG_MAX_BYTES`: a positive integer, else `None` (⇒ default).
pub fn parse_max_bytes(raw: &str) -> Option<u64> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    match t.parse::<u64>() {
        Ok(n) if n > 0 => Some(n),
        _ => None,
    }
}

/// Parse `AMOS_LOG_KEEP`: a positive integer, else `None` (⇒ default). Capped at
/// [`MAX_KEEP`] so a bad value cannot keep unlimited files.
pub fn parse_keep(raw: &str) -> Option<usize> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    match t.parse::<usize>() {
        Ok(n) if n > 0 => Some(n.min(MAX_KEEP)),
        _ => None,
    }
}

/// `true` for the documented "turn file logging off" spellings.
fn is_off(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "" | "off" | "none" | "0"
    )
}

impl LogFileConfig {
    /// Resolve the config from the process env (see the module docs).
    pub fn from_env() -> Option<Self> {
        Self::from_vars(
            std::env::var("AMOS_LOG_DIR").ok(),
            std::env::var("HOME").ok(),
            std::env::var("AMOS_LOG_MAX_BYTES").ok(),
            std::env::var("AMOS_LOG_KEEP").ok(),
        )
    }

    /// Pure policy (env is process-global, so this split keeps it unit-testable):
    /// `dir` unset ⇒ `home/.amos/logs`; an explicit "off" spelling or a missing home
    /// ⇒ `None` (stdout only).
    pub fn from_vars(
        dir: Option<String>,
        home: Option<String>,
        max_bytes: Option<String>,
        keep: Option<String>,
    ) -> Option<Self> {
        let chosen: PathBuf = match dir {
            Some(d) if is_off(&d) => return None,
            Some(d) => PathBuf::from(d.trim()),
            None => {
                let h = home?;
                if h.trim().is_empty() {
                    return None;
                }
                PathBuf::from(h.trim()).join(".amos").join("logs")
            }
        };
        Some(Self {
            dir: chosen,
            max_bytes: max_bytes
                .as_deref()
                .and_then(parse_max_bytes)
                .unwrap_or(DEFAULT_MAX_BYTES),
            keep: keep.as_deref().and_then(parse_keep).unwrap_or(DEFAULT_KEEP),
        })
    }

    /// The active log file path.
    pub fn path(&self) -> PathBuf {
        self.dir.join(LOG_FILE_NAME)
    }
}

/// Path of the `k`-th rotated file (`k >= 1`): `<log>.1`, `<log>.2`, …
fn rotated_path(path: &Path, k: usize) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(format!(".{k}"));
    PathBuf::from(s)
}

/// Append-only file that rotates itself once it reaches `max_bytes`, keeping at
/// most `keep` rotated siblings (`<log>.1` newest … `<log>.<keep>` oldest).
pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: fs::File,
    size: u64,
    /// Completed roll-overs (including the "keep nothing" truncation) since open.
    rotations: u64,
}

impl RotatingFile {
    /// Create `cfg.dir` if needed and open the active file in append mode.
    pub fn open(cfg: &LogFileConfig) -> io::Result<Self> {
        fs::create_dir_all(&cfg.dir)?;
        let path = cfg.path();
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            path,
            max_bytes: cfg.max_bytes,
            keep: cfg.keep,
            file,
            size,
            rotations: 0,
        })
    }

    /// Bytes currently in the active file.
    pub fn size(&self) -> u64 {
        self.size
    }

    /// Completed roll-overs since this file was opened.
    pub fn rotations(&self) -> u64 {
        self.rotations
    }

    /// Append one write as-is. Rotation is checked only when the write ends on a
    /// newline, so the active file never ends mid-record.
    pub fn append(&mut self, buf: &[u8]) -> io::Result<()> {
        self.file.write_all(buf)?;
        self.size += buf.len() as u64;
        if self.size >= self.max_bytes && buf.last() == Some(&b'\n') {
            self.rotate()?;
        }
        Ok(())
    }

    /// Shift `.<k>` → `.<k+1>`, drop the oldest, then `log` → `.1` and reopen empty.
    fn rotate(&mut self) -> io::Result<()> {
        if self.keep == 0 {
            // Keep no history: start the active file over.
            self.file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&self.path)?;
            self.size = 0;
            self.rotations += 1;
            return Ok(());
        }
        let _ = fs::remove_file(rotated_path(&self.path, self.keep));
        for k in (1..self.keep).rev() {
            let from = rotated_path(&self.path, k);
            if from.exists() {
                let _ = fs::rename(&from, rotated_path(&self.path, k + 1));
            }
        }
        fs::rename(&self.path, rotated_path(&self.path, 1))?;
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        self.size = 0;
        self.rotations += 1;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.append(buf)?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// `MakeWriter` used by the daemon: every event goes to **stdout** (unchanged
/// behaviour) *and* to the rotating file when one is configured and could be opened.
#[derive(Clone)]
pub struct TeeWriter {
    file: Arc<Mutex<Option<RotatingFile>>>,
    path: Option<PathBuf>,
    health: Arc<SinkHealth>,
    bytes: Arc<AtomicU64>,
    lost: Arc<AtomicU64>,
}

/// Hand-rollable snapshot of the sink's health, for the wire (`get_status`): an
/// operator must be able to see that the on-disk trail is intact — or how much of it
/// went missing — without reading the daemon's stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogSinkReport {
    /// A file sink is open (false ⇒ stdout only).
    pub enabled: bool,
    /// The active file (`""` when disabled).
    pub path: String,
    /// Bytes appended to the active file since start-up.
    pub bytes_written: u64,
    /// Bytes a failed write could not persist (the missing part of the trail).
    pub lost_bytes: u64,
    /// Failed write/flush/rotation attempts.
    pub write_failures: u64,
    /// Completed roll-overs since start-up.
    pub rotations: u64,
    /// Size of the active file right now.
    pub active_bytes: u64,
}

impl LogSinkReport {
    /// The honest report of "no file sink": `enabled=false` and every counter the
    /// zero of a sink that never persisted anything — never a fabricated reading.
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            path: String::new(),
            bytes_written: 0,
            lost_bytes: 0,
            write_failures: 0,
            rotations: 0,
            active_bytes: 0,
        }
    }
}

/// A live, cloneable view of the file sink for the serving path.
#[derive(Clone)]
pub struct LogSinkHandle {
    file: Arc<Mutex<Option<RotatingFile>>>,
    path: Option<PathBuf>,
    health: Arc<SinkHealth>,
    bytes: Arc<AtomicU64>,
    lost: Arc<AtomicU64>,
}

impl LogSinkHandle {
    /// Snapshot the sink's state. Cheap; safe to call per `get_status`.
    pub fn report(&self) -> LogSinkReport {
        let cells = self.file.lock().ok();
        let (rotations, active_bytes) = match cells.as_ref().and_then(|g| g.as_ref()) {
            Some(f) => (f.rotations(), f.size()),
            None => (0, 0),
        };
        LogSinkReport {
            enabled: self.path.is_some(),
            path: self
                .path
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            bytes_written: self.bytes.load(Ordering::Relaxed),
            lost_bytes: self.lost.load(Ordering::Relaxed),
            write_failures: self.health.failures(),
            rotations,
            active_bytes,
        }
    }
}

/// Counts file-sink failures and makes the **first** one loud.
///
/// A sink that starts failing (disk full, permissions changed, rotation impossible)
/// must not keep looking healthy: the daemon told the operator "file log sink active"
/// at startup, so losing the on-disk trail silently would be exactly the kind of
/// invisible failure this project audits for. The warning deliberately does **not** go
/// through `tracing`: tracing is the pipeline that is failing, so logging through it
/// would re-enter this writer and could recurse. One line on stderr, then silence —
/// the counter keeps counting for diagnostics (`TeeWriter::write_failures`).
#[derive(Debug, Default)]
struct SinkHealth {
    failures: AtomicU64,
    reported: AtomicBool,
}

impl SinkHealth {
    /// Record one failure; returns `true` only for the first one.
    fn note(&self) -> bool {
        self.failures.fetch_add(1, Ordering::Relaxed);
        !self.reported.swap(true, Ordering::Relaxed)
    }

    fn failures(&self) -> u64 {
        self.failures.load(Ordering::Relaxed)
    }
}

impl TeeWriter {
    /// Build the sink. An unavailable/unopenable file is reported once on stderr and
    /// then ignored — logging must never take the daemon down.
    pub fn new(cfg: Option<LogFileConfig>) -> Self {
        let mut opened_path: Option<PathBuf> = None;
        let file = cfg.and_then(|c| match RotatingFile::open(&c) {
            Ok(f) => {
                opened_path = Some(c.path());
                Some(f)
            }
            Err(e) => {
                eprintln!(
                    "amos-ai: file logging disabled ({}: {e})",
                    c.path().display()
                );
                None
            }
        });
        Self {
            file: Arc::new(Mutex::new(file)),
            path: opened_path,
            health: Arc::new(SinkHealth::default()),
            bytes: Arc::new(AtomicU64::new(0)),
            lost: Arc::new(AtomicU64::new(0)),
        }
    }

    /// A live handle for the serving path's `get_status` (cheap clone).
    pub fn handle(&self) -> LogSinkHandle {
        LogSinkHandle {
            file: self.file.clone(),
            path: self.path.clone(),
            health: self.health.clone(),
            bytes: self.bytes.clone(),
            lost: self.lost.clone(),
        }
    }

    /// Snapshot this writer's own sink state.
    pub fn report(&self) -> LogSinkReport {
        self.handle().report()
    }

    /// Whether a file sink is active (diagnostics / tests).
    pub fn file_enabled(&self) -> bool {
        self.file.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// How many file writes have failed since start-up (the on-disk trail may be
    /// incomplete when this is non-zero — the first failure was reported on stderr).
    pub fn write_failures(&self) -> u64 {
        self.health.failures()
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TeeWriter {
    type Writer = TeeHandle;
    fn make_writer(&'a self) -> Self::Writer {
        TeeHandle {
            file: self.file.clone(),
            health: self.health.clone(),
            bytes: self.bytes.clone(),
            lost: self.lost.clone(),
        }
    }
}

/// One event's writer: stdout first (the live stream), then the file (best-effort).
pub struct TeeHandle {
    file: Arc<Mutex<Option<RotatingFile>>>,
    health: Arc<SinkHealth>,
    bytes: Arc<AtomicU64>,
    lost: Arc<AtomicU64>,
}

impl TeeHandle {
    /// Append to the file, remembering (and reporting once) a failure — never silent.
    /// Byte accounting is what lets `get_status` say *how much* of the trail is
    /// missing instead of just "something failed".
    fn to_file(&self, buf: &[u8], what: &str) {
        let result = match self.file.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(f) if what == "write" => f.append(buf),
                Some(f) => f.flush(),
                None => Ok(()),
            },
            Err(_) => Ok(()), // poisoning already means "no usable sink"
        };
        match result {
            Ok(()) => {
                self.bytes.fetch_add(buf.len() as u64, Ordering::Relaxed);
            }
            Err(e) => {
                self.lost.fetch_add(buf.len() as u64, Ordering::Relaxed);
                if self.health.note() {
                    eprintln!(
                        "amos-ai: file log sink {what} failed ({e}); continuing on stdout only \
                         (on-disk trail may be incomplete)"
                    );
                }
            }
        }
    }
}

impl Write for TeeHandle {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = io::stdout().write_all(buf);
        self.to_file(buf, "write");
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        let _ = io::stdout().flush();
        self.to_file(&[], "flush");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tracing_subscriber::fmt::MakeWriter;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A unique, empty temp directory per test (no `tempfile` dependency).
    fn tmpdir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let d =
            std::env::temp_dir().join(format!("amos-ai-logfile-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn cfg(dir: &Path, max_bytes: u64, keep: usize) -> LogFileConfig {
        LogFileConfig {
            dir: dir.to_path_buf(),
            max_bytes,
            keep,
        }
    }

    #[test]
    fn config_policy_prefers_explicit_dir_else_home() {
        let explicit =
            LogFileConfig::from_vars(Some("/tmp/x".into()), Some("/h".into()), None, None).unwrap();
        assert_eq!(explicit.dir, PathBuf::from("/tmp/x"));
        assert_eq!(explicit.max_bytes, DEFAULT_MAX_BYTES);
        assert_eq!(explicit.keep, DEFAULT_KEEP);
        assert_eq!(
            LogFileConfig::from_vars(None, Some("/h".into()), None, None)
                .unwrap()
                .dir,
            PathBuf::from("/h/.amos/logs")
        );
        // Missing HOME cannot be invented.
        assert!(LogFileConfig::from_vars(None, None, None, None).is_none());
        // Explicit "off" spellings disable the file sink.
        for off in ["off", "none", "0", "", "  "] {
            assert!(
                LogFileConfig::from_vars(Some(off.into()), Some("/h".into()), None, None).is_none()
            );
        }
    }

    #[test]
    fn env_sizes_are_parsed_and_bounded() {
        assert_eq!(parse_max_bytes("1024"), Some(1024));
        assert_eq!(parse_max_bytes(" 2048 "), Some(2048));
        assert_eq!(parse_max_bytes("0"), None); // 0 = "never rotate" is refused
        assert_eq!(parse_max_bytes("nope"), None);
        assert_eq!(parse_keep("2"), Some(2));
        assert_eq!(parse_keep("0"), None);
        assert_eq!(parse_keep("9999"), Some(MAX_KEEP)); // bounded, never unlimited
        let c = LogFileConfig::from_vars(
            Some("/tmp/y".into()),
            None,
            Some("64".into()),
            Some("1".into()),
        )
        .unwrap();
        assert_eq!((c.max_bytes, c.keep), (64, 1));
    }

    #[test]
    fn append_creates_the_file_and_counts_bytes() {
        let dir = tmpdir("append");
        let mut f = RotatingFile::open(&cfg(&dir, 1024, 3)).unwrap();
        f.append(b"hello\n").unwrap();
        assert_eq!(f.size(), 6);
        assert_eq!(
            fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap(),
            "hello\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_on_a_line_boundary_and_keeps_at_most_keep_files() {
        let dir = tmpdir("rotate");
        // 16-byte records, rotate at 32 bytes ⇒ every 2 records.
        let mut f = RotatingFile::open(&cfg(&dir, 32, 2)).unwrap();
        for i in 0..6 {
            f.append(format!("line-{i:0>10}\n").as_bytes()).unwrap();
            assert!(f.size() < 32, "rotation must leave a small active file");
        }
        let active = fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        assert!(active.len() < 32, "active file is bounded by max_bytes");
        assert!(dir.join("amos-ai.log.1").exists());
        assert!(dir.join("amos-ai.log.2").exists());
        assert!(!dir.join("amos-ai.log.3").exists());
        // Bounded history: the newest records survive, the oldest are gone.
        let all: String = ["amos-ai.log.2", "amos-ai.log.1", "amos-ai.log"]
            .iter()
            .map(|n| fs::read_to_string(dir.join(n)).unwrap())
            .collect();
        assert!(!all.contains("line-0000000000"));
        assert!(all.contains("line-0000000005"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_giant_write_without_newline_does_not_rotate_mid_record() {
        let dir = tmpdir("partial");
        let mut f = RotatingFile::open(&cfg(&dir, 8, 1)).unwrap();
        f.append(b"no-newline-yet").unwrap(); // 14 > 8 but unfinished
        assert_eq!(f.size(), 14);
        assert!(!dir.join("amos-ai.log.1").exists());
        f.append(b"\n").unwrap(); // now the record is complete
        assert!(dir.join("amos-ai.log.1").exists());
        assert_eq!(f.size(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tee_writes_the_file_and_degrades_honestly() {
        let dir = tmpdir("tee");
        let tee = TeeWriter::new(Some(cfg(&dir, 1024, 1)));
        assert!(tee.file_enabled());
        {
            let mut w = tee.make_writer();
            w.write_all(b"event\n").unwrap();
            w.flush().unwrap();
        }
        assert_eq!(
            fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap(),
            "event\n"
        );

        // No config ⇒ stdout only (never an error).
        assert!(!TeeWriter::new(None).file_enabled());

        // Unopenable dir (a FILE sits where the directory should be) ⇒ degrade, no panic.
        let blocked = tmpdir("blocked");
        fs::write(&blocked, b"not a dir").unwrap();
        let degraded = TeeWriter::new(Some(cfg(&blocked.join("sub"), 1024, 1)));
        assert!(!degraded.file_enabled());
        // …and it still accepts writes (stdout only).
        degraded.make_writer().write_all(b"still fine\n").unwrap();
        let _ = fs::remove_file(&blocked);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sink_health_reports_only_the_first_failure() {
        let h = SinkHealth::default();
        assert_eq!(h.failures(), 0);
        assert!(h.note(), "the first failure must be reported");
        assert!(!h.note(), "later failures must not spam the console");
        assert!(!h.note());
        assert_eq!(h.failures(), 3, "…but they are still counted (diagnostics)");
    }

    #[test]
    fn a_runtime_sink_failure_is_counted_and_not_swallowed() {
        // Rotation cannot complete when the target name is occupied by a non-empty
        // directory, so every append past the cap fails. Pre-fix that error was
        // discarded by the writer (`let _ =`): the operator kept reading "file log sink
        // active" while the on-disk trail silently stopped growing.
        let dir = tmpdir("runtime-fail");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(dir.join(format!("{LOG_FILE_NAME}.1")).join("occupied")).unwrap();

        // The sink itself surfaces the error…
        let mut f = RotatingFile::open(&cfg(&dir, 4, 1)).unwrap();
        assert!(
            f.append(b"hello\n").is_err(),
            "an impossible rotation must be reported, not discarded"
        );

        // …and a writer keeps serving stdout while counting the damage.
        let tee = TeeWriter::new(Some(cfg(&dir, 4, 1)));
        assert!(tee.file_enabled());
        assert_eq!(tee.write_failures(), 0);
        {
            let mut w = tee.make_writer();
            w.write_all(b"event\n").unwrap(); // 6 bytes → triggers the failing rotation
            w.flush().unwrap();
        }
        assert_eq!(tee.write_failures(), 1, "the failure must be counted");
        // Cloned handles share the accounting (the MakeWriter contract).
        assert_eq!(tee.clone().write_failures(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn report_of_a_disabled_sink_is_the_honest_zero() {
        let tee = TeeWriter::new(None);
        let r = tee.report();
        assert_eq!(r, LogSinkReport::disabled());
        assert!(!r.enabled);
        assert!(
            r.path.is_empty(),
            "no path may be invented for a sink that isn't there"
        );
        assert_eq!((r.bytes_written, r.lost_bytes, r.write_failures), (0, 0, 0));
    }

    #[test]
    fn report_counts_bytes_rotations_and_losses() {
        let dir = tmpdir("report");
        // Small cap so a couple of writes roll the file over.
        let tee = TeeWriter::new(Some(cfg(&dir, 12, 1)));
        let mut w = tee.make_writer();
        w.write_all(b"aaaa\n").unwrap(); // 5 bytes
        w.write_all(b"bbbb\n").unwrap(); // 10 → below the cap
        let mid = tee.report();
        assert!(mid.enabled);
        assert!(mid.path.ends_with(LOG_FILE_NAME), "path: {}", mid.path);
        assert_eq!(mid.bytes_written, 10);
        assert_eq!(
            (mid.write_failures, mid.lost_bytes, mid.rotations),
            (0, 0, 0)
        );
        w.write_all(b"cccc\n").unwrap(); // 15 ≥ 12 and newline-terminated → rotates
        let rolled = tee.report();
        assert_eq!(rolled.rotations, 1, "a completed roll-over is counted");
        assert_eq!(rolled.bytes_written, 15);
        assert_eq!(rolled.active_bytes, 0, "a fresh file after rotation");
        drop(w);

        // Now make rotation impossible. The active file is empty right after the
        // roll-over, so the write must itself exceed the cap to attempt a rotation.
        fs::remove_file(dir.join(format!("{LOG_FILE_NAME}.1"))).unwrap();
        fs::create_dir_all(dir.join(format!("{LOG_FILE_NAME}.1")).join("occupied")).unwrap();
        tee.make_writer().write_all(b"deadbeefdead\n").unwrap(); // 13 ≥ 12
        let after = tee.report();
        assert_eq!(after.write_failures, 1, "the failed rotation is counted");
        assert_eq!(after.lost_bytes, 13, "the bytes that never made it to disk");
        assert_eq!(
            after.bytes_written, 15,
            "…and they are not counted as written"
        );
        assert_eq!(after.rotations, 1, "a failed rotation is not a rotation");
        let _ = fs::remove_dir_all(&dir);
    }
}
