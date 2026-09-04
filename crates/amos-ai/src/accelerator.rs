//! Device acceleration domain: which chip AmOS is on and how a local inference
//! runtime should use it.
//!
//! AmOS is headed for **Qualcomm (Snapdragon)** and **MediaTek (Dimensity)**
//! Android devices. Both expose the portable Android **NNAPI** runtime and a
//! Vulkan GPU, plus vendor NPU SDKs (Qualcomm QNN/SNPE, MediaTek NeuroPilot).
//! This module turns that into a resolved, *honest* per-chip profile that a
//! local GGML/llama.cpp (or Ollama) backend can translate into offload args.
//!
//! Honesty rules (matching the rest of the daemon):
//! * `Auto` never *pretends* — it resolves to a concrete default for the current
//!   target, and the result is reported (never "auto" as if it were a real knob).
//! * An accelerator that requires an SDK we were not compiled with
//!   ([`Accel::compiled_in`]) is reported as unavailable so the caller never
//!   fabricates NPU usage.
//! * On a non-Android host we report [`SoCVendor::Host`] — never a made-up
//!   Qualcomm/MediaTek claim — unless the operator overrides via
//!   `AMOS_SOC_VENDOR` (bring-up / cross-compile).

/// Env var naming the accelerator strategy: `auto|cpu|vulkan|metal|nnapi|qnn|neuropilot|off`.
pub const AMOS_ACCEL_ENV: &str = "AMOS_ACCEL";
/// Env override naming the silicon vendor when auto-detection can't run
/// (e.g. cross-compiling or a bring-up harness): `qualcomm|mediatek|generic`.
pub const AMOS_SOC_VENDOR_ENV: &str = "AMOS_SOC_VENDOR";
/// Env override for the number of layers to offload to the accelerator.
pub const AMOS_GPU_LAYERS_ENV: &str = "AMOS_GPU_LAYERS";

/// Which silicon family AmOS is running on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoCVendor {
    /// Qualcomm Snapdragon (QNN/SNPE SDK, Adreno GPU, NNAPI).
    Qualcomm,
    /// MediaTek Dimensity/Helio (NeuroPilot SDK, Mali GPU, NNAPI).
    MediaTek,
    /// An Android device whose vendor couldn't be pinned down yet (bring-up seam).
    GenericAndroid,
    /// A non-Android host (macOS/Linux dev, CI) — never a fabricated device claim.
    Host,
}

impl SoCVendor {
    /// Detect the silicon from the environment / target, without linking any
    /// SDK. `AMOS_SOC_VENDOR=qualcomm|mediatek|generic` wins (bring-up seam).
    /// On a real device the System UI / daemon embedder should set it from
    /// `ro.boot.hardware` / `ro.soc.manufacturer` (see `docs/qcom-mtk-bringup.md`).
    pub fn detect() -> Self {
        match std::env::var(AMOS_SOC_VENDOR_ENV).as_deref() {
            Ok("qualcomm") => SoCVendor::Qualcomm,
            Ok("mediatek") | Ok("mtk") => SoCVendor::MediaTek,
            Ok(_) => SoCVendor::GenericAndroid,
            Err(_) => {
                // On Android without an override we cannot honestly name the
                // OEM, so report the generic seam rather than guessing QCOM/MTK.
                if cfg!(target_os = "android") {
                    SoCVendor::GenericAndroid
                } else {
                    SoCVendor::Host
                }
            }
        }
    }

    /// Short stable label for logs / status.
    pub fn label(self) -> &'static str {
        match self {
            SoCVendor::Qualcomm => "qualcomm",
            SoCVendor::MediaTek => "mediatek",
            SoCVendor::GenericAndroid => "android",
            SoCVendor::Host => "host",
        }
    }
}

/// A device-acceleration strategy for a local inference runtime.
///
/// `Auto` is a *resolver*, not a runtime value — resolve it with
/// [`AccelProfile::effective`] before translating to offload args.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accel {
    /// Pick the best accelerator for the current target automatically.
    Auto,
    /// CPU-only (no offload). Portable everywhere; the safe bring-up default.
    Cpu,
    /// Vulkan GPU (llama.cpp `-ngl` + `--device`); the portable GPU path on both
    /// Qualcomm (Adreno) and MediaTek (Mali) Android devices.
    Vulkan,
    /// Apple Metal (host macOS dev / Apple Silicon).
    Metal,
    /// Android NNAPI — the **portable NPU path shared by Qualcomm and MediaTek**.
    Nnapi,
    /// Qualcomm QNN / SNPE NPU SDK (vendor-specific; requires the `qnn` SDK).
    Qnn,
    /// MediaTek NeuroPilot NPU SDK (vendor-specific; requires `neuropilot` SDK).
    NeuroPilot,
    /// Acceleration explicitly disabled (same effect as [`Accel::Cpu`], but the
    /// operator asked for it rather than it being chosen).
    Off,
}

impl Accel {
    /// Parse an `AMOS_ACCEL` value (unknown → `None`, never a wrong guess).
    fn from_env_value(v: &str) -> Option<Accel> {
        match v.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Some(Accel::Auto),
            "cpu" => Some(Accel::Cpu),
            "vulkan" | "gpu" => Some(Accel::Vulkan),
            "metal" => Some(Accel::Metal),
            "nnapi" => Some(Accel::Nnapi),
            "qnn" | "snpe" => Some(Accel::Qnn),
            "neuropilot" | "mtk" => Some(Accel::NeuroPilot),
            "off" | "none" | "disabled" => Some(Accel::Off),
            _ => None,
        }
    }

    /// Is the SDK/native backend needed by this accelerator compiled in?
    ///
    /// `qnn`/`neuropilot` require their vendor SDKs (see
    /// `docs/qcom-mtk-bringup.md`); until the daemon is built against them they
    /// are honestly unavailable and `effective()` will refuse to pick them.
    pub fn compiled_in(self) -> bool {
        match self {
            // CPU/Vulkan/Metal/NNAPI are runtime backends (llama.cpp features),
            // not vendored SDKs we must compile against.
            Accel::Auto | Accel::Cpu | Accel::Vulkan | Accel::Metal | Accel::Nnapi => true,
            Accel::Qnn => cfg!(feature = "qnn"),
            Accel::NeuroPilot => cfg!(feature = "neuropilot"),
            Accel::Off => true,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Accel::Auto => "auto",
            Accel::Cpu => "cpu",
            Accel::Vulkan => "vulkan",
            Accel::Metal => "metal",
            Accel::Nnapi => "nnapi",
            Accel::Qnn => "qnn",
            Accel::NeuroPilot => "neuropilot",
            Accel::Off => "off",
        }
    }

    /// Human reason a request for this accelerator had to be downgraded, or
    /// `None` when it is fine as-is (for honest reporting).
    fn downgrade_reason(self) -> Option<&'static str> {
        if self.compiled_in() {
            None
        } else {
            Some("SDK not linked (see docs/qcom-mtk-bringup.md)")
        }
    }
}

/// A resolved accelerator profile: silicon vendor + chosen accelerator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccelProfile {
    pub vendor: SoCVendor,
    /// The operator's requested strategy (may be `Auto` before [`Self::effective`]).
    pub accel: Accel,
    /// Whether acceleration is enabled at all (`Config.enable_acceleration` /
    /// `AMOS_ACCEL=off`); when false the effective runtime is CPU.
    pub enabled: bool,
}

impl AccelProfile {
    /// Resolve a profile from the environment (the way `Config.enable_acceleration`
    /// and the daemon's `AMOS_*` knobs do).
    pub fn from_env() -> Self {
        let vendor = SoCVendor::detect();
        let accel = match std::env::var(AMOS_ACCEL_ENV) {
            Ok(v) => Accel::from_env_value(&v).unwrap_or(Accel::Auto),
            Err(_) => Accel::Auto,
        };
        let enabled = accel != Accel::Off;
        Self {
            vendor,
            accel,
            enabled,
        }
    }

    /// Turn the requested strategy into a concrete runtime accelerator, choosing
    /// a sensible default for the target and refusing vendor SDKs we aren't
    /// compiled against. Never returns `Auto`.
    ///
    /// * `auto` + Android → **NNAPI** (portable NPU on Qualcomm & MediaTek).
    /// * `auto` + macOS host → **Metal**; any other host → **CPU**.
    /// * an explicit vendor SDK that isn't compiled in → **CPU** (honest, logged).
    /// * acceleration disabled/`off` → **CPU**.
    pub fn effective(self) -> Accel {
        if !self.enabled {
            return Accel::Cpu;
        }
        match self.accel {
            Accel::Auto => {
                if cfg!(target_os = "android") {
                    // NNAPI is the common denominator across Snapdragon & Dimensity.
                    Accel::Nnapi
                } else if cfg!(target_os = "macos") {
                    Accel::Metal
                } else {
                    Accel::Cpu
                }
            }
            Accel::Cpu | Accel::Off => Accel::Cpu,
            other if !other.compiled_in() => Accel::Cpu,
            other => other,
        }
    }

    /// The accelerator that would actually run (never `Auto`, never an
    /// uncompiled SDK), plus the reason it had to differ from the request.
    /// Returns `(effective, reason_opt)` for honest reporting.
    pub fn resolve(self) -> (Accel, Option<&'static str>) {
        let effective = self.effective();
        let reason = if effective == Accel::Cpu && self.enabled && self.accel != Accel::Cpu {
            match self.accel {
                Accel::Off => None,
                Accel::Auto => None, // auto-defaulting to CPU (e.g. non-metal host)
                a => a.downgrade_reason(),
            }
        } else {
            None
        };
        (effective, reason)
    }

    /// Short log/status label, e.g. `"host/cpu"` or `"android/nnapi"`.
    pub fn label(self) -> String {
        format!("{}/{}", self.vendor.label(), self.effective().label())
    }

    /// Number of layers to offload for a llama.cpp-style runtime (`0` = none).
    /// Honest default: offload everything (999) when an accelerator is active,
    /// overridable via `AMOS_GPU_LAYERS`.
    pub fn n_gpu_layers(self) -> u32 {
        let eff = self.effective();
        if eff == Accel::Cpu {
            0
        } else {
            std::env::var(AMOS_GPU_LAYERS_ENV)
                .ok()
                .and_then(|v| v.trim().parse::<u32>().ok())
                .unwrap_or(999)
        }
    }

    /// Extra command-line args for a local llama.cpp engine, derived from the
    /// resolved accelerator. `--n-gpu-layers` is llama.cpp's portable offload
    /// switch: a CPU/disabled profile explicitly caps it at `0` so a leftover
    /// host/env default can never silently enable a GPU the profile didn't choose.
    pub fn llama_args(self) -> Vec<String> {
        let eff = self.effective();
        if eff == Accel::Cpu {
            // Explicitly cap offload at zero so a leftover env/host default can't
            // silently enable a GPU the profile did not choose.
            return vec!["--n-gpu-layers".to_string(), "0".to_string()];
        }
        vec![
            "--n-gpu-layers".to_string(),
            self.n_gpu_layers().to_string(),
        ]
    }

    /// Ollama-ism: Ollama exposes per-model device hints rather than CLI
    /// offload flags; this returns the operator-facing suggestion.
    pub fn ollama_hint(self) -> String {
        let eff = self.effective();
        if eff == Accel::Cpu {
            "cpu".to_string()
        } else {
            eff.label().to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a profile directly (no global-env reads) so tests are deterministic
    /// under cargo's default parallel test execution.
    fn profile(accel: Accel, vendor: SoCVendor) -> AccelProfile {
        AccelProfile {
            vendor,
            accel,
            enabled: true,
        }
    }

    /// `detect()` reads `AMOS_SOC_VENDOR` only; keep host + overrides in one test
    /// so no other test can race on that key.
    #[test]
    fn vendor_detection_host_and_overrides() {
        std::env::remove_var(AMOS_SOC_VENDOR_ENV);
        if !cfg!(target_os = "android") {
            assert_eq!(SoCVendor::detect(), SoCVendor::Host);
        }
        std::env::set_var(AMOS_SOC_VENDOR_ENV, "qualcomm");
        assert_eq!(SoCVendor::detect(), SoCVendor::Qualcomm);
        std::env::set_var(AMOS_SOC_VENDOR_ENV, "mediatek");
        assert_eq!(SoCVendor::detect(), SoCVendor::MediaTek);
        std::env::remove_var(AMOS_SOC_VENDOR_ENV);
    }

    #[test]
    fn auto_resolves_to_concrete_never_auto() {
        let p = profile(Accel::Auto, SoCVendor::Host);
        let eff = p.effective();
        assert_ne!(
            eff,
            Accel::Auto,
            "Auto must resolve to a concrete accelerator"
        );
        if cfg!(target_os = "android") {
            assert_eq!(eff, Accel::Nnapi, "auto on android → portable NNAPI NPU");
        } else if cfg!(target_os = "macos") {
            assert_eq!(eff, Accel::Metal);
        } else {
            assert_eq!(eff, Accel::Cpu);
        }
    }

    #[test]
    fn off_and_cpu_resolve_to_cpu_without_offload() {
        let off = profile(Accel::Off, SoCVendor::Host);
        assert_eq!(off.effective(), Accel::Cpu);
        assert_eq!(off.n_gpu_layers(), 0);
        assert_eq!(off.llama_args(), vec!["--n-gpu-layers", "0"]);

        let cpu = profile(Accel::Cpu, SoCVendor::Host);
        assert_eq!(cpu.effective(), Accel::Cpu);
        assert_eq!(cpu.n_gpu_layers(), 0);
    }

    #[test]
    fn qnn_without_feature_resolves_to_cpu_with_reason() {
        let p = profile(Accel::Qnn, SoCVendor::Qualcomm);
        let (eff, reason) = p.resolve();
        if cfg!(feature = "qnn") {
            assert_eq!(eff, Accel::Qnn);
            assert!(reason.is_none());
        } else {
            assert_eq!(eff, Accel::Cpu, "uncompiled QNN must not be claimed");
            assert!(reason.is_some(), "must explain the downgrade honestly");
        }
    }

    #[test]
    fn gpu_accel_produces_offload_args() {
        // Only this test touches AMOS_GPU_LAYERS_ENV, so the read is deterministic.
        std::env::remove_var(AMOS_GPU_LAYERS_ENV);
        let metal = profile(Accel::Metal, SoCVendor::Host);
        assert!(metal.n_gpu_layers() > 0, "a metal profile should offload");
        let args = metal.llama_args();
        assert_eq!(
            args.first().map(String::as_str),
            Some("--n-gpu-layers"),
            "llama args start with the offload switch: {args:?}"
        );
        std::env::remove_var(AMOS_GPU_LAYERS_ENV);
    }

    #[test]
    fn unknown_accel_env_value_is_ignored_not_guessed() {
        // from_env_value is private; exercise it through the public from_env().
        // Only this test writes AMOS_ACCEL_ENV, so no cross-test race.
        std::env::set_var(AMOS_ACCEL_ENV, "definitely-not-a-real-backend");
        let p = AccelProfile::from_env();
        assert_eq!(p.accel, Accel::Auto, "unknown value must fall back to Auto");
        std::env::remove_var(AMOS_ACCEL_ENV);
    }
}
