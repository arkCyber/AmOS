//! `AndroidController` — command-drives the Waydroid container and extracts
//! APK metadata. Command execution is abstracted behind [`CommandRunner`] so
//! the logic is fully unit-testable on any host (no Waydroid needed).

use std::io::Read;
use std::process::Output;

use amos_proto::android_compat::AndroidApp;
use zip::ZipArchive;

use crate::capability::CapabilityLedger;

/// Abstraction over process execution so the controller can be tested with a
/// fake runner. The real implementation shells out to `waydroid`.
pub trait CommandRunner: Send + Sync {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<Output>;
}

/// Real runner: executes via the OS.
#[derive(Debug, Default, Clone, Copy)]
pub struct ShellRunner;

impl CommandRunner for ShellRunner {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<Output> {
        std::process::Command::new(program).args(args).output()
    }
}

/// Drives the Android container and exposes app-level operations.
pub struct AndroidController<R: CommandRunner = ShellRunner> {
    runner: R,
    /// Per-package capability ledger. Installing (or upgrading) a package
    /// **resets it to deny-by-default**, so a freshly installed build can never
    /// inherit a grant the host made to an earlier one — see [`Self::install_apk`]
    /// and the module docs of [`crate::capability`].
    ledger: CapabilityLedger,
}

impl Default for AndroidController {
    fn default() -> Self {
        Self::new()
    }
}

impl AndroidController<ShellRunner> {
    pub fn new() -> Self {
        Self {
            runner: ShellRunner,
            ledger: CapabilityLedger::new(),
        }
    }
}

/// Parse a `pm list packages`-style / waydroid app-list output.
pub fn parse_app_list(output: &str) -> Vec<AndroidApp> {
    let mut apps = Vec::new();
    for raw in output.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let pkg = if let Some(idx) = line.find("package:") {
            let rest = &line[idx + "package:".len()..];
            let end = rest.find('=').unwrap_or(rest.len());
            rest[..end].trim().to_string()
        } else {
            line.to_string()
        };
        if pkg.is_empty() {
            continue;
        }
        apps.push(AndroidApp {
            name: pkg.clone(),
            package_name: pkg,
            icon_path: String::new(),
            activity: String::new(),
        });
    }
    apps
}

/// The failure text for a non-zero container command.
///
/// Prefers the container's stderr, but never returns an **empty** string: a
/// command that fails without saying anything must still surface as a failure
/// (the same "no silent failure" rule the store applies to its own artifacts).
fn command_error(out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = stderr.trim();
    if msg.is_empty() {
        // `ExitStatus`'s own `Display` names a signal death (`signal: 9 (SIGKILL)`)
        // where `code()` would only ever say `None`. A container helper that was
        // *killed* is a different situation from one that exited non-zero, and the
        // operator reading the log needs to be able to tell them apart.
        format!("waydroid command failed ({}), no stderr", out.status)
    } else {
        msg.to_string()
    }
}

/// Extract a launcher icon from an APK (which is a ZIP archive).
///
/// Picks the largest `ic_launcher*` PNG/WebP entry as a stand-in for the
/// density bucket that a real extractor would choose. Returns raw image
/// bytes; the caller writes them to a web-served path and sets
/// `AndroidApp.icon_path` accordingly.
pub fn extract_icon_bytes(apk: &[u8]) -> anyhow::Result<Option<Vec<u8>>> {
    let mut archive = ZipArchive::new(std::io::Cursor::new(apk))?;
    let mut best: Option<(u64, Vec<u8>)> = None;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_ascii_lowercase();
        let is_icon =
            name.contains("ic_launcher") && (name.ends_with(".png") || name.ends_with(".webp"));
        if !is_icon {
            continue;
        }
        let size = file.size();
        let mut buf = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buf)?;
        if best.as_ref().map_or(true, |(s, _)| size > *s) {
            best = Some((size, buf));
        }
    }
    Ok(best.map(|(_, b)| b))
}

impl<R: CommandRunner> AndroidController<R> {
    /// Build with a custom runner (useful for tests / DI), with a fresh
    /// deny-by-default capability ledger.
    pub fn with_runner(runner: R) -> Self {
        Self {
            runner,
            ledger: CapabilityLedger::new(),
        }
    }

    /// The per-package capability ledger this controller keeps in
    /// deny-by-default order (see [`crate::capability`]). A policy hook reads it;
    /// only the host writes it, and every install resets its package entry.
    pub fn ledger(&self) -> &CapabilityLedger {
        &self.ledger
    }

    /// Launch an APK in the container; returns a surface/window id on success.
    pub fn launch_apk(&self, package_name: &str) -> Result<String, String> {
        let out = self
            .runner
            .run("waydroid", &["app", "launch", package_name])
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(format!("waydroid_{package_name}"))
        } else {
            Err(command_error(&out))
        }
    }

    /// List installed apps from the container.
    pub fn list_installed_apps(&self) -> Result<Vec<AndroidApp>, String> {
        let out = self
            .runner
            .run("waydroid", &["app", "list"])
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        Ok(parse_app_list(&stdout))
    }

    /// Force-stop an app in the container (the physical half of an LMK-proxy
    /// `Kill` decision). Runs `am force-stop` inside the container via
    /// `waydroid shell`, so the process is really gone — not just absent from
    /// the proxy's registry.
    pub fn force_stop(&self, package_name: &str) -> Result<(), String> {
        let out = self
            .runner
            .run("waydroid", &["shell", "am", "force-stop", package_name])
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(command_error(&out))
        }
    }

    /// Install a local APK into the container (`waydroid app install <path>`) —
    /// the container half of "an APK the store downloaded actually reaches the
    /// OS" (the last mile `docs/fdroid-audit.md` gap 1 names).
    ///
    /// On success the package is **reset to deny-by-default** in
    /// [`Self::ledger`]: any grant the host had made to a previously installed
    /// build of `package_name` is dropped, so an install or upgrade can never
    /// inherit capabilities the new build was not given.
    ///
    /// `package_name` is supplied by the caller because it is the store's app id
    /// (`AppManifest::id`) and `waydroid app install` does not reliably report it
    /// back. An empty path or package name is refused **before** any process
    /// runs, so a malformed call never reaches the container.
    ///
    /// Honest boundary: this drives the container CLI. It does not make the
    /// package's grants real — no interposer sits at the `AudioRecord` /
    /// `Camera.open` boundary yet (see `crate::capability`).
    pub fn install_apk(&self, apk_path: &str, package_name: &str) -> Result<(), String> {
        if apk_path.trim().is_empty() {
            return Err("install_apk: empty APK path".to_string());
        }
        // The path is handed to the container CLI as an **argv element**, so one
        // that starts with `-` would be parsed as a *flag* (`waydroid app install
        // --force`): a caller-chosen filename could change the command. Refuse it
        // rather than pass it through.
        if apk_path.starts_with('-') {
            return Err(format!(
                "install_apk: refusing an APK path that looks like a flag ({apk_path:?})"
            ));
        }
        if package_name.trim().is_empty() {
            return Err("install_apk: empty package name".to_string());
        }
        let out = self
            .runner
            .run("waydroid", &["app", "install", apk_path])
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            // Nothing was installed, so nothing is revoked: the ledger still
            // describes whatever build is *actually* in the container.
            return Err(command_error(&out));
        }
        self.ledger.revoke_all(package_name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::process::ExitStatusExt;

    /// A fake runner returning canned output.
    struct FakeRunner {
        out: Output,
    }
    impl CommandRunner for FakeRunner {
        fn run(&self, _program: &str, _args: &[&str]) -> std::io::Result<Output> {
            Ok(Output {
                status: self.out.status,
                stdout: self.out.stdout.clone(),
                stderr: self.out.stderr.clone(),
            })
        }
    }
    /// Every command the recording runner saw, as `(program, args)`.
    type Calls = std::sync::Arc<std::sync::Mutex<Vec<(String, Vec<String>)>>>;

    /// A fake runner that also records every command it was asked to run.
    struct RecordingRunner {
        out: Output,
        calls: Calls,
    }
    impl CommandRunner for RecordingRunner {
        fn run(&self, program: &str, args: &[&str]) -> std::io::Result<Output> {
            self.calls.lock().unwrap().push((
                program.to_string(),
                args.iter().map(|a| a.to_string()).collect(),
            ));
            Ok(Output {
                status: self.out.status,
                stdout: self.out.stdout.clone(),
                stderr: self.out.stderr.clone(),
            })
        }
    }

    fn ok_out(stdout: &str) -> Output {
        Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }
    fn err_out(stderr: &str) -> Output {
        Output {
            status: std::process::ExitStatus::from_raw(1),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn launch_apk_returns_window_id_on_success() {
        let ctl = AndroidController::with_runner(FakeRunner { out: ok_out("ok") });
        assert_eq!(
            ctl.launch_apk("com.tencent.mm").unwrap(),
            "waydroid_com.tencent.mm"
        );
    }

    #[test]
    fn launch_apk_reports_error_on_failure() {
        let ctl = AndroidController::with_runner(FakeRunner {
            out: err_out("no such app"),
        });
        let err = ctl.launch_apk("com.foo.bar").unwrap_err();
        assert!(err.contains("no such app"));
    }

    #[test]
    fn force_stop_succeeds_and_reports_failure() {
        // Success path.
        let ok = AndroidController::with_runner(FakeRunner { out: ok_out("") });
        assert!(ok.force_stop("com.tencent.mm").is_ok());

        // Failure path surfaces the container stderr.
        let bad = AndroidController::with_runner(FakeRunner {
            out: err_out("am: unknown command"),
        });
        let err = bad.force_stop("com.foo.bar").unwrap_err();
        assert!(err.contains("unknown command"));
    }

    #[test]
    fn install_apk_runs_waydroid_app_install_and_resets_the_ledger() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ctl = AndroidController::with_runner(RecordingRunner {
            out: ok_out("Success"),
            calls: calls.clone(),
        });
        // Grants from an earlier build of the same package must not survive.
        ctl.ledger().grant("com.a.app", "camera");
        ctl.ledger().grant("com.a.app", "storage");

        ctl.install_apk("/tmp/a.apk", "com.a.app").unwrap();

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[(
                "waydroid".to_string(),
                vec![
                    "app".to_string(),
                    "install".to_string(),
                    "/tmp/a.apk".to_string()
                ]
            )],
            "exactly `waydroid app install <path>`, no shell"
        );
        assert!(
            ctl.ledger().granted("com.a.app").is_empty(),
            "a freshly installed build is deny-by-default, not inheriting the old grants"
        );
    }

    #[test]
    fn a_failed_install_reports_stderr_and_leaves_the_ledger_alone() {
        let ctl = AndroidController::with_runner(RecordingRunner {
            out: err_out("INSTALL_FAILED_INVALID_APK"),
            calls: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        });
        ctl.ledger().grant("com.a.app", "camera");

        let err = ctl.install_apk("/tmp/bad.apk", "com.a.app").unwrap_err();
        assert!(err.contains("INSTALL_FAILED_INVALID_APK"), "{err}");
        assert!(
            ctl.ledger().is_granted("com.a.app", "camera"),
            "nothing was installed, so nothing is revoked"
        );
    }

    #[test]
    fn install_apk_refuses_empty_inputs_without_touching_the_container() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ctl = AndroidController::with_runner(RecordingRunner {
            out: ok_out(""),
            calls: calls.clone(),
        });
        assert!(ctl
            .install_apk("", "com.a.app")
            .unwrap_err()
            .contains("empty APK path"));
        assert!(ctl
            .install_apk("/tmp/a.apk", "   ")
            .unwrap_err()
            .contains("empty package name"));
        assert!(
            calls.lock().unwrap().is_empty(),
            "invalid input must not reach the container"
        );
    }

    #[test]
    fn a_silent_container_failure_is_never_an_empty_error() {
        // A non-zero exit with no stderr still has to read as a failure.
        let ctl = AndroidController::with_runner(FakeRunner { out: err_out("") });
        let err = ctl.install_apk("/tmp/a.apk", "com.a.app").unwrap_err();
        assert!(err.contains("no stderr"), "{err}");
        assert!(!err.is_empty());

        // A *killed* helper has no exit code at all: the message must name the
        // signal instead of degrading into "exit None".
        let killed = Output {
            status: std::process::ExitStatus::from_raw(9), // WIFSIGNALED(SIGKILL)
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        let ctl = AndroidController::with_runner(FakeRunner { out: killed });
        let err = ctl.install_apk("/tmp/a.apk", "com.a.app").unwrap_err();
        assert!(err.contains("signal"), "{err}");
        assert!(
            !err.contains("None"),
            "a signal death must not read as `exit None`: {err}"
        );
    }

    #[test]
    fn install_apk_refuses_a_path_that_looks_like_a_flag() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ctl = AndroidController::with_runner(RecordingRunner {
            out: ok_out(""),
            calls: calls.clone(),
        });
        let err = ctl.install_apk("--force", "com.a.app").unwrap_err();
        assert!(err.contains("looks like a flag"), "{err}");
        assert!(
            calls.lock().unwrap().is_empty(),
            "a flag-looking path must never reach the container"
        );
    }

    #[test]
    fn parse_pm_list_packages() {
        let out = "package:com.tencent.mm\npackage:com.taobao.taobao\n\n";
        let apps = parse_app_list(out);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].package_name, "com.tencent.mm");
        assert_eq!(apps[0].name, "com.tencent.mm");
    }

    #[test]
    fn parse_plain_lines() {
        let apps = parse_app_list("com.a.app\ncom.b.app");
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[1].package_name, "com.b.app");
    }

    #[test]
    fn extract_icon_from_fabricated_apk() {
        // Build a tiny valid APK (zip) containing a launcher icon.
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file(
                "res/mipmap-xxhdpi/ic_launcher.png",
                zip::write::FileOptions::default(),
            )
            .unwrap();
        let icon = b"\x89PNG fake icon bytes";
        writer.write_all(icon).unwrap();
        let apk = writer.finish().unwrap().into_inner();

        let got = extract_icon_bytes(&apk).unwrap().expect("icon found");
        assert_eq!(got, icon);
    }

    #[test]
    fn extract_icon_ignores_non_launcher_entries() {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file(
                "res/drawable/background.png",
                zip::write::FileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"bg").unwrap();
        let apk = writer.finish().unwrap().into_inner();
        assert!(extract_icon_bytes(&apk).unwrap().is_none());
    }
}
