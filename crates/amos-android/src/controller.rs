//! `AndroidController` — command-drives the Waydroid container and extracts
//! APK metadata. Command execution is abstracted behind [`CommandRunner`] so
//! the logic is fully unit-testable on any host (no Waydroid needed).

use std::io::Read;
use std::process::Output;

use amos_proto::android_compat::AndroidApp;
use zip::ZipArchive;

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
    /// Build with a custom runner (useful for tests / DI).
    pub fn with_runner(runner: R) -> Self {
        Self { runner }
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
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
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
