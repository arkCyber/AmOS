//! Android runtime drivers: an abstraction so the Android-compat layer works
//! for real on any host.
//!
//! * [`WaydroidRuntime`] — drives the real Waydroid container via its CLI.
//! * [`DemoRuntime`] — an in-process runtime with a curated app list that
//!   "launches" apps (records + returns a window id). Used automatically when
//!   Waydroid is not installed, so the full pipeline (frontend -> gRPC ->
//!   daemon -> runtime) works end-to-end during development and in CI.
//! * [`auto`] — picks Waydroid when available, else the demo runtime.

use std::sync::{Arc, Mutex};

use amos_proto::android_compat::AndroidApp;

use crate::controller::{AndroidController, CommandRunner, ShellRunner};

/// The behaviour the Android-manager gRPC service needs from a runtime.
pub trait AndroidRuntime: Send + Sync {
    fn name(&self) -> &'static str;
    fn list_apps(&self) -> Result<Vec<AndroidApp>, String>;
    fn launch(&self, package_name: &str) -> Result<String, String>;
    /// PNG icon bytes for an app, if available (e.g. extracted from its APK).
    fn icon_for(&self, _package_name: &str) -> Option<Vec<u8>> {
        None
    }
}

/// Real Waydroid container runtime (default on device).
pub struct WaydroidRuntime<R: CommandRunner = ShellRunner> {
    ctl: AndroidController<R>,
}

impl WaydroidRuntime<ShellRunner> {
    pub fn new() -> Self {
        Self {
            ctl: AndroidController::new(),
        }
    }
}

impl Default for WaydroidRuntime<ShellRunner> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: CommandRunner> WaydroidRuntime<R> {
    pub fn with_runner(runner: R) -> Self {
        Self {
            ctl: AndroidController::with_runner(runner),
        }
    }
}

impl<R: CommandRunner> AndroidRuntime for WaydroidRuntime<R> {
    fn name(&self) -> &'static str {
        "waydroid"
    }

    fn list_apps(&self) -> Result<Vec<AndroidApp>, String> {
        self.ctl.list_installed_apps()
    }

    fn launch(&self, package_name: &str) -> Result<String, String> {
        self.ctl.launch_apk(package_name)
    }
}

/// In-process demo runtime: works without Waydroid so the OS is usable on the
/// host and in tests. Maintains a real app list and records launches.
pub struct DemoRuntime {
    apps: Arc<Mutex<Vec<AndroidApp>>>,
    launches: Arc<Mutex<Vec<String>>>,
}

impl Default for DemoRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoRuntime {
    pub fn new() -> Self {
        let apps = vec![
            AndroidApp {
                name: "微信".into(),
                package_name: "com.tencent.mm".into(),
                icon_path: "icons/com.tencent.mm.png".into(),
                activity: "com.tencent.mm.ui.LauncherUI".into(),
            },
            AndroidApp {
                name: "抖音".into(),
                package_name: "com.ss.android.ugc.aweme".into(),
                icon_path: "icons/com.ss.android.ugc.aweme.png".into(),
                activity: String::new(),
            },
            AndroidApp {
                name: "淘宝".into(),
                package_name: "com.taobao.taobao".into(),
                icon_path: "icons/com.taobao.taobao.png".into(),
                activity: String::new(),
            },
            AndroidApp {
                name: "高德地图".into(),
                package_name: "com.autonavi.minimap".into(),
                icon_path: "icons/com.autonavi.minimap.png".into(),
                activity: String::new(),
            },
        ];
        Self {
            apps: Arc::new(Mutex::new(apps)),
            launches: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Packages launched so far (for inspection / tests).
    pub fn launches(&self) -> Vec<String> {
        self.launches
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl AndroidRuntime for DemoRuntime {
    fn name(&self) -> &'static str {
        "demo"
    }

    fn list_apps(&self) -> Result<Vec<AndroidApp>, String> {
        Ok(self.apps.lock().unwrap_or_else(|p| p.into_inner()).clone())
    }

    fn launch(&self, package_name: &str) -> Result<String, String> {
        let exists = self
            .apps
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|a| a.package_name == package_name);
        if !exists {
            return Err(format!("package not installed: {package_name}"));
        }
        self.launches
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(package_name.to_string());
        Ok(format!("waydroid_demo_{package_name}"))
    }

    fn icon_for(&self, package_name: &str) -> Option<Vec<u8>> {
        let known = self
            .apps
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|a| a.package_name == package_name);
        known
            .then(|| crate::png::icon_png(package_name, 64))
            // Encode failures become a missing icon (None), never a panic.
            .and_then(|res| res.ok())
    }
}

/// Return true if `cmd` is an executable on `$PATH`.
fn has_command(cmd: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| dir.join(cmd).exists())
}

/// Pick the best available runtime: real Waydroid when present, else demo.
pub fn auto() -> Arc<dyn AndroidRuntime> {
    if has_command("waydroid") {
        Arc::new(WaydroidRuntime::new())
    } else {
        Arc::new(DemoRuntime::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CommandRunner;

    #[test]
    fn demo_lists_curated_apps() {
        let rt = DemoRuntime::new();
        let apps = rt.list_apps().unwrap();
        assert!(apps.len() >= 4);
        assert!(apps.iter().any(|a| a.package_name == "com.tencent.mm"));
    }

    #[test]
    fn demo_launch_returns_window_id_and_records() {
        let rt = DemoRuntime::new();
        let wid = rt.launch("com.tencent.mm").unwrap();
        assert_eq!(wid, "waydroid_demo_com.tencent.mm");
        assert_eq!(rt.launches(), vec!["com.tencent.mm"]);
    }

    #[test]
    fn demo_launch_rejects_unknown_package() {
        let rt = DemoRuntime::new();
        assert!(rt.launch("com.unknown.app").is_err());
    }

    #[test]
    fn demo_icon_for_known_package_is_png() {
        let rt = DemoRuntime::new();
        let icon = rt.icon_for("com.tencent.mm").expect("icon for known app");
        assert_eq!(
            &icon[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
    }

    #[test]
    fn demo_icon_none_for_unknown_package() {
        let rt = DemoRuntime::new();
        assert!(rt.icon_for("com.unknown.app").is_none());
    }

    #[test]
    fn waydroid_runtime_delegates_to_controller() {
        struct Fake;
        impl CommandRunner for Fake {
            fn run(&self, _p: &str, _a: &[&str]) -> std::io::Result<std::process::Output> {
                use std::os::unix::process::ExitStatusExt;
                Ok(std::process::Output {
                    status: std::process::ExitStatus::from_raw(0),
                    stdout: b"package:com.a.app\npackage:com.b.app\n".to_vec(),
                    stderr: Vec::new(),
                })
            }
        }
        let rt = WaydroidRuntime::with_runner(Fake);
        assert_eq!(rt.name(), "waydroid");
        let apps = rt.list_apps().unwrap();
        assert_eq!(apps.len(), 2);
        assert_eq!(rt.launch("com.a.app").unwrap(), "waydroid_com.a.app");
    }
}
