//! **In-process** llama.cpp backend (`llama-cpp-inproc` feature) — the seam, not
//! the binding.
//!
//! # STATUS — READ THIS FIRST
//!
//! Today the daemon runs local GGUF models through an **external subprocess**
//! ([`super::real::GgmlBackend`] → `allama` / `AMOS_GGML_BIN`). That is a
//! deliberate bring-up choice, but it costs a process spawn per generation and
//! a third-party binary on the device image. This module is the seam for running
//! llama.cpp *inside* the daemon instead.
//!
//! **It contains no working binding.** `LlamaCppInProcessBackend::new` always
//! fails with a typed [`BackendError`]:
//!
//! * [`BackendError::Provider`] when the `llama-cpp-inproc` feature is off — the
//!   runtime is not linked into this build;
//! * [`BackendError::NotImplemented`] when the feature is on but the FFI calls
//!   are still not written.
//!
//! It never returns a fabricated success and never falls back to the
//! deterministic mock, so `AMOS_BACKEND=llama-cpp` cannot silently degrade into
//! placeholder output.
//!
//! # What the real deliverable looks like (estimated 3–5 weeks)
//!
//! 1. Depend on a maintained binding (`llama-cpp-rs` / `llama_cpp-2`) **or**
//!    `bindgen` the upstream `llama.h` behind an `amos-llama-sys` crate, with a
//!    vendored/build-from-source `llama.cpp` (the RK3588 NPU path additionally
//!    needs Rockchip's llama.cpp fork for the RKNN offload backend, so the two
//!    modules converge on device — see `docs/rk3588-bringup.md`).
//! 2. Implement [`super::InferenceBackend`] for the backend: load the GGUF, build
//!    a context with the accelerator profile's `n_gpu_layers`
//!    ([`crate::accelerator::AccelProfile`]), run the prefill/decode loop, and
//!    stream tokens through [`super::TokenStream`].
//! 3. Keep `GgmlBackend` as the fallback engine; only flip
//!    `LlamaCppInProcessBackend::new` to `Ok` when the runtime genuinely loads.
//! 4. Add an end-to-end test that generates from a tiny GGUF and asserts a
//!    non-empty, non-mock reply.
//!
//! Until then, every path here is a typed refusal.

use anyhow::Result;
use async_trait::async_trait;
use std::collections::HashMap;

use super::real::{BackendError, BackendMetadata, BackendStats, InferenceBackend, TokenStream};

/// Upper bound on an operator-supplied GGUF path.
pub const MAX_LLAMA_MODEL_PATH_BYTES: usize = 4096;

/// Is this build linked against an in-process llama.cpp runtime?
pub fn llama_cpp_inproc_linked() -> bool {
    cfg!(feature = "llama-cpp-inproc")
}

/// In-process llama.cpp backend (bring-up seam — see the module docs).
#[derive(Debug)]
pub struct LlamaCppInProcessBackend {
    model_path: String,
    metadata: BackendMetadata,
}

impl LlamaCppInProcessBackend {
    /// Construct the backend for `model_path` (a GGUF file).
    ///
    /// Always fails today, with a typed error naming the missing piece (see the
    /// [`BackendError`] variants). Never a mock-backed success.
    pub fn new(model_path: impl Into<String>) -> std::result::Result<Self, BackendError> {
        let model_path = model_path.into();
        if model_path.trim().is_empty() {
            return Err(BackendError::ModelNotFound(
                "AMOS_BACKEND=llama-cpp requires AMOS_MODEL_PATH to name a .gguf model".to_string(),
            ));
        }
        if model_path.len() > MAX_LLAMA_MODEL_PATH_BYTES {
            return Err(BackendError::ModelNotFound(format!(
                "llama.cpp model path exceeds {MAX_LLAMA_MODEL_PATH_BYTES} bytes"
            )));
        }
        if !llama_cpp_inproc_linked() {
            return Err(BackendError::Provider(
                "llama.cpp is not linked into this build (no `llama-cpp-inproc` feature); the \
                 daemon's local engine today is the external `allama`/AMOS_GGML_BIN subprocess. \
                 Rebuild with `--features llama-cpp-inproc`."
                    .to_string(),
            ));
        }
        Err(BackendError::NotImplemented(
            "in-process llama.cpp binding not yet implemented (the `llama-cpp-inproc` feature \
             only declares the runtime is linked); see crates/amos-ai/src/inference/llama_cpp.rs"
                .to_string(),
        ))
    }

    /// The GGUF path this backend was asked to serve.
    pub fn model_path(&self) -> &str {
        &self.model_path
    }
}

#[async_trait]
impl InferenceBackend for LlamaCppInProcessBackend {
    async fn infer(
        &self,
        _prompt: &str,
        _context: &HashMap<String, String>,
        _max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        Err(anyhow::anyhow!(
            "in-process llama.cpp backend is a bring-up seam, not a working engine; the daemon's \
             local engine is the external `allama` subprocess path"
        ))
    }

    fn metadata(&self) -> BackendMetadata {
        self.metadata.clone()
    }

    async fn health_check(&self) -> Result<()> {
        Err(anyhow::anyhow!(
            "in-process llama.cpp backend unavailable (runtime not linked)"
        ))
    }

    async fn get_stats(&self) -> BackendStats {
        BackendStats::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gap 7 test 7.3-3: without the feature this must be a typed `Provider`
    /// error — not a mock, and not a silent success.
    #[test]
    fn llama_cpp_in_process_without_feature_returns_provider_error_not_mock() {
        let err =
            LlamaCppInProcessBackend::new("/models/tiny.gguf").expect_err("not linked -> refuse");
        if cfg!(feature = "llama-cpp-inproc") {
            assert!(matches!(err, BackendError::NotImplemented(_)));
        } else {
            match err {
                BackendError::Provider(msg) => assert!(
                    msg.contains("not linked"),
                    "the error must say the runtime is not linked: {msg}"
                ),
                other => panic!("expected Provider(...), got {other:?}"),
            }
        }
    }

    #[test]
    fn llama_cpp_in_process_refuses_blank_and_oversized_paths() {
        assert!(matches!(
            LlamaCppInProcessBackend::new(""),
            Err(BackendError::ModelNotFound(_))
        ));
        let huge = "y".repeat(MAX_LLAMA_MODEL_PATH_BYTES + 1);
        assert!(matches!(
            LlamaCppInProcessBackend::new(huge),
            Err(BackendError::ModelNotFound(_))
        ));
    }

    #[test]
    fn linked_probe_matches_the_feature() {
        assert_eq!(
            llama_cpp_inproc_linked(),
            cfg!(feature = "llama-cpp-inproc")
        );
    }
}
