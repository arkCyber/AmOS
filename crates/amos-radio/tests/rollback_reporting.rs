//! A failed Airplane cascade that also fails to roll back must **say so** (REQ-A161,
//! the same class as REQ-A147 in the supervisor): `RadioManager::rollback_to` used to
//! discard all three results, so a device could be left with Airplane mode on and
//! Wi-Fi/Bluetooth switched off while the caller's error (the *cascade* failure) said
//! nothing about it. The manager cannot undo a provider failure — but it must not let
//! the broken restore hide behind the original error.
//!
//! Own test binary (its own process) because the capturing subscriber is process-wide.
//!
//! Honest scope: this proves the *reporting* of a failed rollback step and that a
//! rollback which works stays silent. It does not exercise a real radio stack (the
//! provider here is a test double), and it does not check the Android provider.

use std::sync::{Arc, Mutex};

use amos_radio::{RadioError, RadioManager, RadioMode, RadioProvider, RadioSnapshot, Result};

/// Captures everything the manager logs.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap_or_else(|p| p.into_inner())).to_string()
    }
}

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = CaptureWriter;
    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter(Arc::clone(&self.0))
    }
}

fn capture_logs() -> Capture {
    let cap = Capture::default();
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .with_writer(cap.clone())
        .try_init();
    cap
}

/// A provider that behaves like the mock except where a test says it must fail — so
/// the *cascade* and the *rollback* can be made to fail independently.
#[derive(Default)]
struct FlakyProvider {
    inner: Mutex<RadioSnapshot>,
    /// `(op, on)` pairs that must fail once. `op` is `airplane` / `wifi` / `bluetooth`.
    fail: Mutex<Vec<(&'static str, bool)>>,
}

impl FlakyProvider {
    fn new(initial: RadioSnapshot) -> Self {
        Self {
            inner: Mutex::new(initial),
            fail: Mutex::new(Vec::new()),
        }
    }

    fn fail_on(&self, op: &'static str, on: bool) {
        self.fail
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push((op, on));
    }

    fn holds(&self, f: impl FnOnce(&RadioSnapshot) -> bool) -> bool {
        f(&self.inner.lock().unwrap_or_else(|p| p.into_inner()))
    }

    fn apply(
        &self,
        op: &'static str,
        on: bool,
        set: impl FnOnce(&mut RadioSnapshot),
    ) -> Result<()> {
        let must_fail = {
            let mut fail = self.fail.lock().unwrap_or_else(|p| p.into_inner());
            match fail.iter().position(|(o, v)| *o == op && *v == on) {
                Some(i) => {
                    fail.remove(i);
                    true
                }
                None => false,
            }
        };
        if must_fail {
            return Err(RadioError::Provider(format!("{op} refused by the backend")));
        }
        set(&mut self.inner.lock().unwrap_or_else(|p| p.into_inner()));
        Ok(())
    }
}

#[async_trait::async_trait]
impl RadioProvider for FlakyProvider {
    async fn snapshot(&self) -> Result<RadioSnapshot> {
        Ok(*self.inner.lock().unwrap_or_else(|p| p.into_inner()))
    }

    async fn set_wifi(&self, on: bool) -> Result<()> {
        self.apply("wifi", on, |s| s.wifi = on)
    }

    async fn set_bluetooth(&self, on: bool) -> Result<()> {
        self.apply("bluetooth", on, |s| s.bluetooth = on)
    }

    async fn set_airplane(&self, on: bool) -> Result<()> {
        self.apply("airplane", on, |s| s.airplane = on)
    }

    async fn set_hotspot(&self, on: bool) -> Result<()> {
        self.apply("hotspot", on, |s| s.hotspot = on)
    }
}

fn radios_on() -> RadioSnapshot {
    RadioSnapshot {
        airplane: false,
        wifi: true,
        bluetooth: true,
        hotspot: true,
    }
}

/// The failing-rollback scenario: the cascade fails on Wi-Fi OFF, and neither Airplane
/// nor Wi-Fi can be put back. Returns the manager's error.
async fn failed_cascade_with_failed_rollback(provider: &Arc<FlakyProvider>) -> RadioError {
    provider.fail_on("wifi", false);
    provider.fail_on("airplane", false);
    provider.fail_on("wifi", true);
    let m = RadioManager::new(Arc::clone(provider) as Arc<dyn RadioProvider>);
    m.set(RadioMode::Airplane, true)
        .await
        .expect_err("the cascade failure is what the caller gets")
}

/// Own test binary *and* a single test: the capturing subscriber is process-wide, so a
/// second test in the same process would silently write into the first one's sink (the
/// same reason `amos-supervisor/tests/restart_failure_reporting.rs` holds one test).
#[tokio::test]
async fn a_failed_rollback_is_reported_while_a_working_one_stays_silent() {
    let cap = capture_logs();
    let provider = Arc::new(FlakyProvider::new(radios_on()));

    let err = failed_cascade_with_failed_rollback(&provider).await;
    assert!(
        matches!(&err, RadioError::Provider(msg) if msg.contains("wifi refused")),
        "the caller must see the *cascade* failure, got {err:?}"
    );

    // The device really is partially applied — the manager must not pretend otherwise:
    // the cascade left Airplane on while the rollback could not switch it back.
    assert!(
        provider.holds(|s| s.airplane),
        "the refused rollback leaves Airplane on — that half-applied state is what the \
         caller's error cannot express"
    );

    let log = cap.text();
    assert!(
        log.contains("airplane rollback failed") && log.contains("Wi-Fi rollback failed"),
        "every rollback step that failed must be named, got:\n{log}"
    );
    assert!(
        !log.contains("Bluetooth rollback failed"),
        "the step that succeeded must not be reported as failed, got:\n{log}"
    );
    assert!(
        log.contains("wifi refused by the backend"),
        "the log must carry the provider's own reason, got:\n{log}"
    );

    // A rollback that works is not a warning: same scenario with only the cascade failing.
    let provider2 = Arc::new(FlakyProvider::new(radios_on()));
    provider2.fail_on("wifi", false);
    let m2 = RadioManager::new(Arc::clone(&provider2) as Arc<dyn RadioProvider>);
    assert!(m2.set(RadioMode::Airplane, true).await.is_err());
    assert!(
        provider2.holds(|s| !s.airplane && s.wifi && s.bluetooth),
        "a working rollback restores every bit"
    );
    assert_eq!(
        cap.text().matches("rollback failed").count(),
        2,
        "only the two failures above may be reported, got:\n{}",
        cap.text()
    );
}
