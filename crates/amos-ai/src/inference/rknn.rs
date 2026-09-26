//! Rockchip **RK3588 NPU (RKNN)** inference backend — the bring-up *seam*, not
//! the binding.
//!
//! # STATUS — READ THIS FIRST
//!
//! **This file contains no working RKNN binding.** It is an honest placeholder
//! that makes `AMOS_ACCEL=rknn` / `AMOS_BACKEND=rknn` *selectable and testable*
//! while guaranteeing the daemon can never claim NPU acceleration it does not
//! have. `Rk3588Backend::new` fails on every build, with a typed error that names
//! which piece is missing: [`BackendError::Provider`] when the `rknn` feature is
//! off (the SDK is not linked) and [`BackendError::NotImplemented`] when it is on
//! (the FFI calls are not written yet). `infer` therefore never returns a
//! fabricated success or a silent fall back to the deterministic mock.
//!
//! # What the real deliverable looks like (estimated 4–6 weeks)
//!
//! 1. **FFI surface.** The RK3588 exposes `librknnrt.so` (the RKNN runtime) with
//!    a C API (`rknn_init`, `rknn_query`, `rknn_inputs_set`, `rknn_run`,
//!    `rknn_outputs_get`, `rknn_destroy`, plus the zero-copy `rknn_mem_*`
//!    family). Generate the wrapper with `bindgen` from
//!    `include/rknn_api.h` in the Rockchip `rknn-toolkit2` SDK, behind a
//!    `-sys` crate (`amos-rknn-sys`) that links `librknnrt.so` via
//!    `cargo:rustc-link-lib`.
//! 2. **Model format.** LLM weights must be converted on a *host* with
//!    `rknn-toolkit2` (`rknn.load_...` → `rknn.build` → `model.rknn`); the
//!    device cannot convert at runtime. This is why the daemon takes a `.rknn`
//!    path, not a `.gguf`.
//! 3. **Wiring.** Implement [`super::InferenceBackend`] for `Rk3588Backend`:
//!    tokenize, run the prefill/decode loop with `rknn_inputs_set` /
//!    `rknn_run` / `rknn_outputs_get`, stream tokens through the existing
//!    [`super::TokenStream`]. NPU core-mask selection (3-core RK3588) and
//!    `rknn_set_core_mask` are bring-up decisions.
//! 4. **Then and only then** flip `Accel::Rk3588Npu::compiled_in()` to report
//!    availability (it is `cfg!(feature = "rknn")` today) *and* make
//!    [`Rk3588Backend::new`] return `Ok` when the SDK is genuinely linked —
//!    a *runtime* probe of the loaded `librknnrt.so`, not just the feature flag.
//!
//! Until step 4 lands, every path here is a typed refusal. See
//! `docs/rk3588-bringup.md` for the full onboarding checklist.

use anyhow::Result;
use async_trait::async_trait;
use std::collections::HashMap;

use super::real::{BackendError, BackendMetadata, BackendStats, InferenceBackend, TokenStream};

/// The docs page an operator should read when RKNN is requested but unavailable.
pub const RKNN_BRINGUP_DOC: &str = "docs/rk3588-bringup.md";

/// Upper bound on an operator-supplied `.rknn` model path (same rationale as
/// [`crate::bundled_model::MAX_MODEL_PATH_BYTES`]).
pub const MAX_RKNN_MODEL_PATH_BYTES: usize = 4096;

/// Is this build linked against the RKNN runtime (`rknn` feature)?
pub fn rknn_sdk_linked() -> bool {
    cfg!(feature = "rknn")
}

/// Rockchip RK3588 NPU backend (bring-up seam — see the module docs).
#[derive(Debug)]
pub struct Rk3588Backend {
    model_path: String,
    metadata: BackendMetadata,
}

impl Rk3588Backend {
    /// Construct the backend for `model_path` (a `.rknn` model).
    ///
    /// Always fails today, with a **typed** error that says exactly which step
    /// is missing:
    /// * [`BackendError::Provider`] when the `rknn` feature (the linked SDK) is
    ///   absent — "the SDK is not linked";
    /// * [`BackendError::NotImplemented`] when the feature is on but the FFI
    ///   calls have not been written yet.
    ///
    /// It never returns a mock-backed "success" (F-NPU-001).
    pub fn new(model_path: impl Into<String>) -> std::result::Result<Self, BackendError> {
        let model_path = model_path.into();
        if model_path.trim().is_empty() {
            return Err(BackendError::ModelNotFound(
                "AMOS_BACKEND=rknn requires AMOS_MODEL_PATH to name a .rknn model".to_string(),
            ));
        }
        if model_path.len() > MAX_RKNN_MODEL_PATH_BYTES {
            return Err(BackendError::ModelNotFound(format!(
                "rknn model path exceeds {MAX_RKNN_MODEL_PATH_BYTES} bytes"
            )));
        }
        if !rknn_sdk_linked() {
            return Err(BackendError::Provider(format!(
                "RKNN SDK not linked — this build has no `rknn` feature, so librknnrt.so is not \
                 available. Rebuild with `--features rknn` on an RK3588 toolchain; see {RKNN_BRINGUP_DOC}"
            )));
        }
        // The feature is on, but the FFI calls are still not written: refuse
        // explicitly rather than pretend the model is loaded.
        Err(BackendError::NotImplemented(format!(
            "rknn binding not yet implemented (the `rknn` feature only declares the SDK is \
             linked). See {RKNN_BRINGUP_DOC} — this is the seam, not the binding."
        )))
    }

    /// The `.rknn` model path this backend was asked to serve.
    pub fn model_path(&self) -> &str {
        &self.model_path
    }
}

#[async_trait]
impl InferenceBackend for Rk3588Backend {
    async fn infer(
        &self,
        _prompt: &str,
        _context: &HashMap<String, String>,
        _max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        // Unreachable in practice (construction already failed), but stated
        // honestly: an RKNN engine that is not linked cannot generate tokens,
        // and we will not substitute the deterministic mock.
        Err(anyhow::anyhow!(
            "RK3588 NPU backend is a bring-up seam, not a working engine — see {RKNN_BRINGUP_DOC}"
        ))
    }

    fn metadata(&self) -> BackendMetadata {
        self.metadata.clone()
    }

    async fn health_check(&self) -> Result<()> {
        Err(anyhow::anyhow!(
            "RK3588 NPU backend unavailable (librknnrt.so not linked) — see {RKNN_BRINGUP_DOC}"
        ))
    }

    async fn get_stats(&self) -> BackendStats {
        // Honest telemetry: no engine, no NPU counters (never a fabricated 0).
        BackendStats::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gap 7 test 7.3-4: constructing the RK3588 backend without a linked SDK
    /// yields a typed `Provider` error — never a fabricated success and never a
    /// `MockBackend` stand-in.
    #[test]
    fn rk3588_backend_new_without_sdk_returns_provider_error() {
        let err = Rk3588Backend::new("/models/llm.rknn").expect_err("no SDK -> refuse");
        if cfg!(feature = "rknn") {
            assert!(
                matches!(err, BackendError::NotImplemented(_)),
                "with the feature on but no binding, the error must be NotImplemented: {err:?}"
            );
        } else {
            match err {
                BackendError::Provider(msg) => {
                    assert!(
                        msg.contains("RKNN SDK not linked"),
                        "the error must name the missing SDK: {msg}"
                    );
                    assert!(
                        msg.contains(RKNN_BRINGUP_DOC),
                        "the error must point at the bring-up doc: {msg}"
                    );
                }
                other => panic!("expected Provider(...), got {other:?}"),
            }
        }
        // The availability probe is the feature gate and nothing else — it can
        // never report "linked" on a build that was not compiled with `rknn`.
        assert_eq!(rknn_sdk_linked(), cfg!(feature = "rknn"));
    }

    /// A blank or over-cap model path is refused before anything else, with the
    /// typed `ModelNotFound` variant.
    #[test]
    fn rk3588_backend_refuses_blank_and_oversized_paths() {
        assert!(matches!(
            Rk3588Backend::new("   "),
            Err(BackendError::ModelNotFound(_))
        ));
        let huge = "x".repeat(MAX_RKNN_MODEL_PATH_BYTES + 1);
        assert!(matches!(
            Rk3588Backend::new(huge),
            Err(BackendError::ModelNotFound(_))
        ));
    }
}
