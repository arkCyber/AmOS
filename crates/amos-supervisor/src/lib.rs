//! `amos-supervisor` — a small process supervisor for the Amos CLI daemon layer.
//!
//! The Amos OS runs several long-lived, memory-hungry CLI daemons (inference,
//! agent orchestrator, wallet, P2P…). This crate spawns, monitors, and
//! *hot-restarts* them so a crash never takes the OS core down:
//!
//! * each daemon gets a **restart policy** (max attempts + exponential backoff),
//! * an unexpected exit triggers an automatic restart,
//! * `stop()` / `shutdown_all()` tear the children down cleanly.
//!
//! It is transport-agnostic: the same supervisor can manage `amos-ai`,
//! a Web3 wallet binary, or a NAS/P2P daemon.
//!
//! # Example
//! ```no_run
//! use amos_supervisor::{DaemonSpec, Supervisor};
//!
//! # async fn run() {
//! let sup = Supervisor::new();
//! sup.start(DaemonSpec::simple("inference", "sleep", ["9999"])).await.unwrap();
//! sup.stop("inference").await.unwrap();
//! # }
//! ```

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio::task::JoinHandle;

/// How a daemon should behave when it exits unexpectedly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestartPolicy {
    /// Maximum automatic restarts before the daemon is marked `Crashed`.
    pub max_restarts: u32,
    /// Base backoff delay (seconds) before the first restart.
    pub backoff_secs: u64,
    /// Backoff multiplier per restart attempt (exponential).
    pub backoff_factor: u32,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_restarts: 5,
            backoff_secs: 1,
            backoff_factor: 2,
        }
    }
}

impl RestartPolicy {
    /// Compute the backoff delay for a given restart attempt (1-based).
    fn delay_for(&self, attempt: u32) -> Duration {
        let factor = self.backoff_factor.max(1);
        let secs = self
            .backoff_secs
            .saturating_mul(factor.saturating_pow(attempt.saturating_sub(1)) as u64)
            .min(300); // cap at 5 minutes
        Duration::from_secs(secs)
    }
}

/// Describes a CLI daemon to supervise.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonSpec {
    /// Unique name used to address the daemon (status / stop / restart).
    pub name: String,
    /// Executable (resolved via `$PATH` unless it contains a path separator).
    pub program: String,
    /// Command-line arguments.
    pub args: Vec<String>,
    /// Extra environment variables.
    pub env: Vec<(String, String)>,
    /// Restart behaviour on unexpected exit.
    pub restart: RestartPolicy,
}

impl DaemonSpec {
    /// Convenience constructor with a default restart policy and no env.
    pub fn simple<I, S>(name: &str, program: &str, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            name: name.to_string(),
            program: program.to_string(),
            args: args.into_iter().map(Into::into).collect(),
            env: Vec::new(),
            restart: RestartPolicy::default(),
        }
    }
}

/// Lifecycle state of a supervised daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonStatus {
    /// Spawned but not yet confirmed running.
    Starting,
    /// Alive and being monitored.
    Running,
    /// Was running, crashed, and is waiting out the backoff before restart.
    Restarting { attempt: u32 },
    /// Stopped by an explicit call to `stop` / `shutdown_all`.
    Stopped,
    /// Exhausted its restart budget; the supervisor gave up.
    Crashed { restarts: u32 },
}

struct Daemon {
    spec: DaemonSpec,
    child: Option<Child>,
    status: DaemonStatus,
    restarts: u32,
    stop_requested: bool,
    /// Explicit recycle requested via `restart()`: the monitor resets the restart
    /// budget and immediately spawns a fresh child (no backoff wait).
    restart_requested: bool,
    /// Wakes the monitor loop so `stop()` can interrupt a running child or a
    /// pending backoff sleep (fixes the race where the monitor already owns the
    /// `Child` and `stop()` could not terminate the process).
    notify: Arc<Notify>,
}

impl Daemon {
    fn new(spec: DaemonSpec) -> Self {
        Self {
            spec,
            child: None,
            status: DaemonStatus::Starting,
            restarts: 0,
            stop_requested: false,
            restart_requested: false,
            notify: Arc::new(Notify::new()),
        }
    }
}

/// Supervises a set of named child daemons.
pub struct Supervisor {
    daemons: Arc<RwLock<HashMap<String, Arc<Mutex<Daemon>>>>>,
    tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            daemons: Arc::new(RwLock::new(HashMap::new())),
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register and spawn a daemon, then begin monitoring it.
    pub async fn start(&self, spec: DaemonSpec) -> Result<(), String> {
        let name = spec.name.clone();
        let daemon = Arc::new(Mutex::new(Daemon::new(spec)));
        spawn_child(&name, &daemon).await?;
        self.daemons
            .write()
            .await
            .insert(name.clone(), daemon.clone());

        let monitor = tokio::spawn(monitor(name.clone(), daemon));
        self.tasks.lock().await.insert(name, monitor);
        Ok(())
    }
}

/// Spawn (or restart) a daemon's child process and mark it running.
async fn spawn_child(name: &str, daemon: &Arc<Mutex<Daemon>>) -> Result<(), String> {
    let (program, args, env) = {
        let d = daemon.lock().await;
        (
            d.spec.program.clone(),
            d.spec.args.clone(),
            d.spec.env.clone(),
        )
    };
    let mut cmd = Command::new(&program);
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    // Headless: daemons don't read stdin; silence stdout, keep stderr for logs.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{name}' ({program}): {e}"))?;

    let mut d = daemon.lock().await;
    d.child = Some(child);
    d.status = DaemonStatus::Running;
    Ok(())
}

/// Take the live child out of a daemon, if any.
async fn take_child(daemon: &Arc<Mutex<Daemon>>) -> Option<Child> {
    daemon.lock().await.child.take()
}

async fn stop_requested(daemon: &Arc<Mutex<Daemon>>) -> bool {
    daemon.lock().await.stop_requested
}

/// Kill and reap a child owned by the monitor (no lock held across the await).
async fn terminate(mut child: Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Monitor loop: poll a running child with a non-blocking `try_wait`, honouring a
/// stop via a shared flag + `Notify`. The monitor owns the live `Child` for the
/// child's whole life, so `stop()` can never race `child.take()`: it only sets the
/// flag and wakes us, and this loop terminates the process it holds. A stop during
/// the backoff window is also honoured (no "resurrection" after an explicit stop).
async fn monitor(name: String, daemon: Arc<Mutex<Daemon>>) {
    let mut child = match take_child(&daemon).await {
        Some(c) => c,
        None => return, // no live child (already stopped / spawn failed)
    };

    loop {
        // Stop requested → terminate the process we own and finish.
        if stop_requested(&daemon).await {
            terminate(child).await;
            let mut d = daemon.lock().await;
            d.status = DaemonStatus::Stopped;
            return;
        }

        // Explicit restart → recycle the process we own right now (reset budget).
        if daemon.lock().await.restart_requested {
            {
                let mut d = daemon.lock().await;
                d.restart_requested = false;
                d.restarts = 0;
                d.status = DaemonStatus::Starting;
            }
            terminate(child).await;
            if spawn_child(&name, &daemon).await.is_err() {
                let mut d = daemon.lock().await;
                d.status = DaemonStatus::Crashed {
                    restarts: d.restarts,
                };
                return;
            }
            match take_child(&daemon).await {
                Some(c) => child = c,
                None => return,
            }
            continue;
        }

        match child.try_wait() {
            Ok(Some(_)) => {} // exited naturally
            Ok(None) => {
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }
            Err(_) => {} // treat as exited; dropping the child reaps it
        }

        // Child exited: apply the restart policy (or honour a stop).
        let (restart, backoff) = {
            let mut d = daemon.lock().await;
            if d.stop_requested {
                d.status = DaemonStatus::Stopped;
                (false, Duration::ZERO)
            } else if d.restarts < d.spec.restart.max_restarts {
                d.restarts += 1;
                let attempt = d.restarts;
                d.status = DaemonStatus::Restarting { attempt };
                (true, d.spec.restart.delay_for(attempt))
            } else {
                d.status = DaemonStatus::Crashed {
                    restarts: d.restarts,
                };
                (false, Duration::ZERO)
            }
        };
        if !restart {
            return;
        }

        // Interruptible backoff: an explicit stop during the wait must not let the
        // daemon resurrect; an explicit restart cuts the wait short. We race the
        // sleep against the stop/restart Notify.
        tracing::warn!(daemon = %name, "daemon exited; restarting in {:?}", backoff);
        let notify = daemon.lock().await.notify.clone();
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = notify.notified() => {}
        }
        {
            let mut d = daemon.lock().await;
            if d.stop_requested {
                d.status = DaemonStatus::Stopped;
                return;
            }
            // Restart during the backoff: drop the wait and respawn immediately.
            if d.restart_requested {
                d.restart_requested = false;
                d.restarts = 0;
                d.status = DaemonStatus::Starting;
            }
        }

        if spawn_child(&name, &daemon).await.is_err() {
            let mut d = daemon.lock().await;
            d.status = DaemonStatus::Crashed {
                restarts: d.restarts,
            };
            return;
        }
        // Take the freshly spawned child for continued polling.
        match take_child(&daemon).await {
            Some(c) => child = c,
            None => return,
        }
    }
}

impl Supervisor {
    /// Stop a daemon: mark it stopped and terminate its child.
    ///
    /// The monitor owns a running child, so `stop()` never races `child.take()`:
    /// it sets the stop flag (terminating any child still parked in the daemon) and
    /// wakes the monitor, which then kills the child it holds / aborts the backoff.
    pub async fn stop(&self, name: &str) -> Result<(), String> {
        let (mut child, notify) = {
            let daemon = self
                .daemons
                .read()
                .await
                .get(name)
                .ok_or_else(|| format!("daemon '{name}' is not managed"))?
                .clone();
            let mut g = daemon.lock().await;
            g.stop_requested = true;
            g.status = DaemonStatus::Stopped;
            (g.child.take(), g.notify.clone())
        };
        // Directly terminate a child that hasn't been claimed by the monitor yet.
        if let Some(mut c) = child.take() {
            let _ = c.kill().await;
            let _ = c.wait().await;
        }
        // Wake the monitor so it kills the child it owns (or aborts a backoff).
        notify.notify_one();

        // Wait (bounded) for the monitor to kill + reap the child it owns, so
        // `stop()` / `shutdown_all()` return only after the process is actually
        // gone. Aborting the monitor task right away would orphan the child.
        let task = self.tasks.lock().await.remove(name);
        if let Some(t) = task {
            let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
        }
        Ok(())
    }

    /// Explicitly restart a daemon that is currently supervised (running, or
    /// waiting out a backoff). Resets the crash budget and spawns a fresh child
    /// immediately. Returns an error for an unknown or already-stopped/crashed
    /// daemon whose monitor has exited — for those, use `start` again.
    pub async fn restart(&self, name: &str) -> Result<(), String> {
        let (alive, notify) = {
            let daemon = self
                .daemons
                .read()
                .await
                .get(name)
                .ok_or_else(|| format!("daemon '{name}' is not managed"))?
                .clone();
            let g = daemon.lock().await;
            let alive = matches!(
                g.status,
                DaemonStatus::Running | DaemonStatus::Restarting { .. }
            );
            (alive, g.notify.clone())
        };
        if !alive {
            return Err(format!("daemon '{name}' is not running; use start instead"));
        }
        {
            let daemon = self
                .daemons
                .read()
                .await
                .get(name)
                .ok_or_else(|| format!("daemon '{name}' is not managed"))?
                .clone();
            daemon.lock().await.restart_requested = true;
        }
        notify.notify_one();
        Ok(())
    }

    /// Recycle every supervised daemon that is currently running/backing off.
    /// Stopped/crashed daemons are left alone (their monitors have exited).
    pub async fn restart_all(&self) {
        let names: Vec<String> = self.daemons.read().await.keys().cloned().collect();
        for name in names {
            let _ = self.restart(&name).await;
        }
    }

    /// Return the current status of a daemon, if it is managed.
    pub async fn status(&self, name: &str) -> Option<DaemonStatus> {
        let daemon = self.daemons.read().await.get(name)?.clone();
        let guard = daemon.lock().await;
        Some(guard.status.clone())
    }

    /// Snapshot of all managed daemons and their statuses.
    pub async fn list(&self) -> Vec<(String, DaemonStatus)> {
        let d = self.daemons.read().await;
        let mut out: Vec<(String, DaemonStatus)> = Vec::new();
        for (name, daemon) in d.iter() {
            out.push((name.clone(), daemon.lock().await.status.clone()));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Stop every managed daemon and abort its monitor task (graceful shutdown).
    pub async fn shutdown_all(&self) {
        let names: Vec<String> = self.daemons.read().await.keys().cloned().collect();
        for name in names {
            let _ = self.stop(&name).await;
        }
        let tasks = self.tasks.lock().await;
        for t in tasks.values() {
            t.abort();
        }
    }
}

/// A top-level config file describing a set of daemons to supervise.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisorConfig {
    pub daemons: Vec<DaemonSpec>,
}

/// Load a supervisor config from a JSON file.
pub fn load_config(path: &Path) -> anyhow::Result<SupervisorConfig> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let config: SupervisorConfig = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))?;
    Ok(config)
}

/// Convenience: start every daemon in a config under one `Supervisor`.
pub async fn start_all(
    sup: &Supervisor,
    config: &SupervisorConfig,
) -> Vec<(String, Result<(), String>)> {
    let mut out = Vec::new();
    for spec in &config.daemons {
        let r = sup.start(spec.clone()).await;
        out.push((spec.name.clone(), r));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn load_config_round_trips_and_parses_restart() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("amos-sup-config-{}.json", std::process::id()));
        let cfg = SupervisorConfig {
            daemons: vec![DaemonSpec {
                name: "ai".into(),
                program: "amos-ai".into(),
                args: vec!["--socket".into(), "/tmp/amos-ai.sock".into()],
                env: vec![("AMOS_BACKEND".into(), "mock".into())],
                restart: RestartPolicy {
                    max_restarts: 2,
                    backoff_secs: 3,
                    backoff_factor: 4,
                },
            }],
        };
        std::fs::write(&path, serde_json::to_string(&cfg).unwrap()).unwrap();
        let loaded = load_config(&path).expect("load config");
        assert_eq!(loaded.daemons.len(), 1);
        assert_eq!(loaded.daemons[0].name, "ai");
        assert_eq!(loaded.daemons[0].restart.max_restarts, 2);
        assert_eq!(loaded.daemons[0].env[0].0, "AMOS_BACKEND");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_config_rejects_missing_or_bad_file() {
        let dir = std::env::temp_dir();
        assert!(load_config(&dir.join("nope.json")).is_err());

        let bad = dir.join(format!("amos-sup-bad-{}.json", std::process::id()));
        std::fs::write(&bad, "not json").unwrap();
        assert!(load_config(&bad).is_err());
        let _ = std::fs::remove_file(&bad);
    }

    #[tokio::test]
    async fn start_all_starts_every_daemon() {
        let sup = Supervisor::new();
        let cfg = SupervisorConfig {
            daemons: vec![
                DaemonSpec::simple("s1", "sleep", ["30"]),
                DaemonSpec::simple("s2", "sleep", ["30"]),
            ],
        };
        let results = start_all(&sup, &cfg).await;
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|(_, r)| r.is_ok()), "both daemons start");
        assert_eq!(sup.status("s1").await, Some(DaemonStatus::Running));
        assert_eq!(sup.status("s2").await, Some(DaemonStatus::Running));
        sup.shutdown_all().await;
    }

    #[tokio::test]
    async fn start_runs_and_stop_terminates() {
        let sup = Supervisor::new();
        sup.start(DaemonSpec::simple("sleeper", "sleep", ["30"]))
            .await
            .unwrap();
        assert_eq!(sup.status("sleeper").await, Some(DaemonStatus::Running));

        sup.stop("sleeper").await.unwrap();
        assert_eq!(sup.status("sleeper").await, Some(DaemonStatus::Stopped));
    }

    #[tokio::test]
    async fn crash_daemon_restarts_then_crashes_after_budget() {
        let sup = Supervisor::new();
        // `false` exits immediately → the supervisor should restart it.
        let mut spec = DaemonSpec::simple("boom", "false", Vec::<&str>::new());
        spec.restart.max_restarts = 2;
        spec.restart.backoff_secs = 0;
        sup.start(spec).await.unwrap();

        // Give the monitor time to exhaust the restart budget.
        tokio::time::sleep(Duration::from_millis(300)).await;
        match sup.status("boom").await {
            Some(DaemonStatus::Crashed { restarts: 2 }) => {}
            other => panic!("expected Crashed{{restarts:2}}, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_unknown_and_errors() {
        let sup = Supervisor::new();
        assert_eq!(
            sup.status("missing").await,
            None,
            "unknown daemon has no status"
        );
        assert!(
            sup.stop("missing").await.is_err(),
            "stopping unknown daemon errors"
        );
        assert!(sup.list().await.is_empty(), "no daemons managed yet");

        sup.start(DaemonSpec::simple("sleeper", "sleep", ["30"]))
            .await
            .unwrap();
        let list = sup.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].0, "sleeper");
        sup.shutdown_all().await;
        assert_eq!(sup.status("sleeper").await, Some(DaemonStatus::Stopped));
    }

    #[tokio::test]
    async fn restart_replaces_the_child_process() {
        let sup = Supervisor::new();
        let pidfile =
            std::env::temp_dir().join(format!("amos-sup-restart-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);
        let script = format!("echo $$ > {}; exec sleep 30", pidfile.display());
        sup.start(DaemonSpec::simple("svc", "sh", ["-c", &script]))
            .await
            .unwrap();
        for _ in 0..100 {
            if pidfile.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid1: u32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        sup.restart("svc").await.unwrap();

        // The restarted child re-writes the pidfile with a *new* pid.
        let mut pid2 = pid1;
        for _ in 0..100 {
            if let Ok(txt) = std::fs::read_to_string(&pidfile) {
                if let Ok(p) = txt.trim().parse::<u32>() {
                    if p != pid1 {
                        pid2 = p;
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(pid2, pid1, "restart() must spawn a fresh child (new pid)");
        assert_eq!(sup.status("svc").await, Some(DaemonStatus::Running));

        let alive = std::process::Command::new("kill")
            .arg("-0")
            .arg(pid2.to_string())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(alive, "restarted child (pid {pid2}) is running");

        // And restart() rejects a daemon that is not being supervised.
        assert!(
            sup.restart("missing").await.is_err(),
            "unknown daemon cannot be restarted"
        );
        sup.shutdown_all().await;
        let _ = std::fs::remove_file(&pidfile);
    }

    #[tokio::test]
    async fn stop_terminates_a_long_running_child() {
        let sup = Supervisor::new();
        let pidfile =
            std::env::temp_dir().join(format!("amos-sup-proc-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);
        // `sh -c 'echo $$ > pidfile; exec sleep 30'`: pidfile holds the live pid
        // (exec keeps the same pid), so we can prove stop actually killed it.
        let script = format!("echo $$ > {}; exec sleep 30", pidfile.display());
        sup.start(DaemonSpec::simple("runner", "sh", ["-c", &script]))
            .await
            .unwrap();

        // Wait until the pidfile is written and the daemon is Running.
        for _ in 0..100 {
            if pidfile.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(pidfile.exists(), "daemon wrote its pidfile");
        assert_eq!(sup.status("runner").await, Some(DaemonStatus::Running));

        sup.stop("runner").await.unwrap();
        // Give the monitor time to kill + reap the child.
        tokio::time::sleep(Duration::from_millis(300)).await;

        let pid: u32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let alive = std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(
            !alive,
            "stop() must have terminated the daemon process (pid {pid})"
        );
        assert_eq!(sup.status("runner").await, Some(DaemonStatus::Stopped));
        let _ = std::fs::remove_file(&pidfile);
    }

    #[tokio::test]
    async fn stop_during_backoff_does_not_resurrect() {
        let sup = Supervisor::new();
        // `false` exits immediately → first crash parks the monitor in a 1s backoff.
        let mut spec = DaemonSpec::simple("boom", "false", Vec::<&str>::new());
        spec.restart.max_restarts = 100;
        spec.restart.backoff_secs = 1;
        spec.restart.backoff_factor = 1;
        sup.start(spec).await.unwrap();

        // Wait until the first crash puts it into the Restarting backoff window.
        let mut saw_restarting = false;
        for _ in 0..50 {
            if sup.status("boom").await == Some(DaemonStatus::Restarting { attempt: 1 }) {
                saw_restarting = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(saw_restarting, "daemon crashed into its backoff window");

        // Stop while it is backing off: it must NOT come back.
        sup.stop("boom").await.unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(
            sup.status("boom").await,
            Some(DaemonStatus::Stopped),
            "an explicit stop during backoff must not resurrect the daemon"
        );
        sup.shutdown_all().await;
    }

    async fn read_pid(pidfile: &std::path::Path) -> u32 {
        std::fs::read_to_string(pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    async fn wait_pidfile(pidfile: &std::path::Path) {
        for _ in 0..100 {
            if pidfile.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("daemon never wrote its pidfile {}", pidfile.display());
    }

    #[tokio::test]
    async fn restart_all_recycles_every_running_child() {
        let sup = Supervisor::new();
        let dir = std::env::temp_dir();
        let pa = dir.join(format!("amos-sup-ra-{}-a.pid", std::process::id()));
        let pb = dir.join(format!("amos-sup-ra-{}-b.pid", std::process::id()));
        let _ = std::fs::remove_file(&pa);
        let _ = std::fs::remove_file(&pb);
        let sa = format!("echo $$ > {}; exec sleep 30", pa.display());
        let sb = format!("echo $$ > {}; exec sleep 30", pb.display());
        sup.start(DaemonSpec::simple("a", "sh", ["-c", &sa]))
            .await
            .unwrap();
        sup.start(DaemonSpec::simple("b", "sh", ["-c", &sb]))
            .await
            .unwrap();
        wait_pidfile(&pa).await;
        wait_pidfile(&pb).await;
        let a1 = read_pid(&pa).await;
        let b1 = read_pid(&pb).await;

        sup.restart_all().await;

        let mut a2 = a1;
        let mut b2 = b1;
        for _ in 0..100 {
            if let Ok(t) = std::fs::read_to_string(&pa) {
                if let Ok(p) = t.trim().parse::<u32>() {
                    a2 = p;
                }
            }
            if let Ok(t) = std::fs::read_to_string(&pb) {
                if let Ok(p) = t.trim().parse::<u32>() {
                    b2 = p;
                }
            }
            if a2 != a1 && b2 != b1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(a2, a1, "daemon a got a fresh pid after restart_all");
        assert_ne!(b2, b1, "daemon b got a fresh pid after restart_all");
        assert_eq!(sup.status("a").await, Some(DaemonStatus::Running));
        assert_eq!(sup.status("b").await, Some(DaemonStatus::Running));
        let alive = |pid: u32| {
            std::process::Command::new("kill")
                .arg("-0")
                .arg(pid.to_string())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        assert!(alive(a2) && alive(b2), "restarted children are running");
        sup.shutdown_all().await;
        let _ = std::fs::remove_file(&pa);
        let _ = std::fs::remove_file(&pb);
    }

    #[tokio::test]
    async fn shutdown_all_terminates_every_child() {
        let sup = Supervisor::new();
        let dir = std::env::temp_dir();
        let pa = dir.join(format!("amos-sup-sd-{}-a.pid", std::process::id()));
        let pb = dir.join(format!("amos-sup-sd-{}-b.pid", std::process::id()));
        let _ = std::fs::remove_file(&pa);
        let _ = std::fs::remove_file(&pb);
        let sa = format!("echo $$ > {}; exec sleep 30", pa.display());
        let sb = format!("echo $$ > {}; exec sleep 30", pb.display());
        sup.start(DaemonSpec::simple("a", "sh", ["-c", &sa]))
            .await
            .unwrap();
        sup.start(DaemonSpec::simple("b", "sh", ["-c", &sb]))
            .await
            .unwrap();
        wait_pidfile(&pa).await;
        wait_pidfile(&pb).await;
        let a1 = read_pid(&pa).await;
        let b1 = read_pid(&pb).await;

        // Graceful stop of everything: returns only after children are dead.
        sup.shutdown_all().await;

        let alive = |pid: u32| {
            std::process::Command::new("kill")
                .arg("-0")
                .arg(pid.to_string())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        assert!(
            !alive(a1) && !alive(b1),
            "shutdown_all() must not orphan child daemons ({a1}, {b1})"
        );
        assert_eq!(sup.status("a").await, Some(DaemonStatus::Stopped));
        assert_eq!(sup.status("b").await, Some(DaemonStatus::Stopped));
        let _ = std::fs::remove_file(&pa);
        let _ = std::fs::remove_file(&pb);
    }
}

#[cfg(test)]
mod backoff_property {
    use super::*;

    const MAX_BACKOFF: u64 = 300; // delay_for caps at 5 minutes

    #[test]
    fn exponential_growth_is_capped_and_monotone() {
        let p = RestartPolicy {
            max_restarts: 5,
            backoff_secs: 1,
            backoff_factor: 2,
        };
        let seq: Vec<u64> = (0u32..16).map(|a| p.delay_for(a).as_secs()).collect();
        for &v in &seq {
            assert!(v <= MAX_BACKOFF, "backoff must never exceed the cap");
        }
        // base=1, factor=2 -> 1,1,2,4,...,256,300,300,...
        assert_eq!(seq[0], 1); // attempt 0 ≈ first attempt
        assert_eq!(seq[1], 1);
        assert_eq!(seq[2], 2);
        assert_eq!(seq[9], 256);
        assert_eq!(seq[10], 300);
        assert_eq!(seq[15], 300);
        for w in seq.windows(2) {
            assert!(w[0] <= w[1], "backoff must be non-decreasing: {w:?}");
        }
    }

    #[test]
    fn hostile_inputs_saturate_without_panic_or_overflow() {
        let big = RestartPolicy {
            max_restarts: 0,
            backoff_secs: u64::MAX / 2,
            backoff_factor: u32::MAX,
        };
        for a in [0u32, 1, 2, 7, 1000, u32::MAX] {
            let d = big.delay_for(a);
            assert!(
                d.as_secs() <= MAX_BACKOFF,
                "attempt {a} backoff {d:?} over cap"
            );
        }
        // backoff_secs 0 stays 0 for any attempt.
        let zero = RestartPolicy {
            max_restarts: 0,
            backoff_secs: 0,
            backoff_factor: 99,
        };
        assert_eq!(zero.delay_for(1000).as_secs(), 0);
        // factor 0 is clamped to 1 (constant base, no runaway zero).
        let one = RestartPolicy {
            max_restarts: 0,
            backoff_secs: 2,
            backoff_factor: 0,
        };
        assert_eq!(one.delay_for(1).as_secs(), 2);
        assert_eq!(one.delay_for(500).as_secs(), 2);
    }

    #[test]
    fn delay_is_deterministic_and_total_for_every_attempt() {
        let p = RestartPolicy {
            max_restarts: 4,
            backoff_secs: 3,
            backoff_factor: 3,
        };
        for a in 0u32..1000 {
            let d = p.delay_for(a);
            assert_eq!(d, p.delay_for(a), "delay must be deterministic per attempt");
            assert!(d.as_secs() <= MAX_BACKOFF);
        }
    }
}
