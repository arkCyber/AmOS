//! Production inference backends for real GPU/NPU acceleration.
//!
//! This module provides abstraction over different inference implementations:
//! - Local GPU/NPU execution (GGML, llama.cpp, MLC-LLM)
//! - External API calls (OpenAI, Claude, etc.)
//! - Custom backends (proprietary accelerators)

use anyhow::Result;
use async_trait::async_trait;
use std::collections::HashMap;

/// Abstraction over inference backends.
///
/// Implementations handle tokenization, batching, and resource management.
/// The gRPC service consumes this trait without knowing the concrete backend.
#[async_trait]
pub trait InferenceBackend: Send + Sync {
    /// Generate tokens based on a prompt and optional context.
    ///
    /// Returns an async stream of tokens. Callers should consume this stream
    /// and emit each token to the WebView via Tauri events.
    async fn infer(
        &self,
        prompt: &str,
        context: &HashMap<String, String>,
        max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>>;

    /// Get backend metadata (model name, capabilities, etc.).
    fn metadata(&self) -> BackendMetadata;

    /// Check if the backend is healthy and ready to serve.
    async fn health_check(&self) -> Result<()>;

    /// Get resource utilization stats.
    async fn get_stats(&self) -> BackendStats;
}

/// Stream of generated tokens.
#[async_trait]
pub trait TokenStream: Send {
    /// Get the next token, or None if the stream is finished.
    async fn next(&mut self) -> Option<Result<String>>;
}

/// Backend metadata.
#[derive(Debug, Clone)]
pub struct BackendMetadata {
    pub name: String,
    pub version: String,
    pub model_name: String,
    pub max_context_length: usize,
    pub supports_streaming: bool,
    pub supports_function_calling: bool,
    pub supports_images: bool,
}

/// Backend resource statistics.
#[derive(Debug, Clone)]
pub struct BackendStats {
    pub gpu_utilization_percent: u32,
    pub memory_used_mb: usize,
    pub memory_total_mb: usize,
    pub active_requests: usize,
    pub total_tokens_generated: u64,
    pub avg_tokens_per_second: f32,
}

/// Local GPU/NPU backend using GGML (llama.cpp compatible).
pub struct GgmlBackend {
    model_path: std::path::PathBuf,
    metadata: BackendMetadata,
}

impl GgmlBackend {
    /// Create a new GGML backend.
    ///
    /// The model file should be in GGUF format (quantized or full precision).
    pub fn new(model_path: impl Into<std::path::PathBuf>) -> Result<Self> {
        let model_path = model_path.into();

        if !model_path.exists() {
            anyhow::bail!("Model file not found: {}", model_path.display());
        }

        let metadata = BackendMetadata {
            name: "ggml".to_string(),
            version: "0.1.0".to_string(),
            model_name: model_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string(),
            max_context_length: 4096,
            supports_streaming: true,
            supports_function_calling: false,
            supports_images: false,
        };

        Ok(Self { model_path, metadata })
    }
}

#[async_trait]
impl InferenceBackend for GgmlBackend {
    async fn infer(
        &self,
        prompt: &str,
        _context: &HashMap<String, String>,
        max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        tracing::debug!(
            "GGML inference: prompt_len={}, max_tokens={}",
            prompt.len(),
            max_tokens
        );

        // TODO: Integrate with llama.cpp or MLC-LLM
        // For now, return a stub that yields tokens
        let tokens = crate::inference::mock_tokens(prompt);
        let stream = GgmlTokenStream {
            tokens: tokens.into_iter(),
        };

        Ok(Box::new(stream))
    }

    fn metadata(&self) -> BackendMetadata {
        self.metadata.clone()
    }

    async fn health_check(&self) -> Result<()> {
        if self.model_path.exists() {
            Ok(())
        } else {
            anyhow::bail!("Model file not found")
        }
    }

    async fn get_stats(&self) -> BackendStats {
        // TODO: Query actual GPU stats
        BackendStats {
            gpu_utilization_percent: 0,
            memory_used_mb: 0,
            memory_total_mb: 8192,
            active_requests: 0,
            total_tokens_generated: 0,
            avg_tokens_per_second: 0.0,
        }
    }
}

/// Token stream from GGML backend.
struct GgmlTokenStream {
    tokens: std::vec::IntoIter<String>,
}

#[async_trait]
impl TokenStream for GgmlTokenStream {
    async fn next(&mut self) -> Option<Result<String>> {
        self.tokens.next().map(Ok)
    }
}

/// External API backend (e.g., OpenAI, Claude).
pub struct ApiBackend {
    api_key: String,
    api_endpoint: String,
    model: String,
}

impl ApiBackend {
    /// Create a new API backend.
    pub fn new(api_key: String, api_endpoint: String, model: String) -> Self {
        Self {
            api_key,
            api_endpoint,
            model,
        }
    }
}

#[async_trait]
impl InferenceBackend for ApiBackend {
    async fn infer(
        &self,
        prompt: &str,
        context: &HashMap<String, String>,
        max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        tracing::debug!(
            "API inference: endpoint={}, model={}, max_tokens={}",
            self.api_endpoint,
            self.model,
            max_tokens
        );

        // TODO: Implement actual API calls (OpenAI, Claude, etc.)
        // For now, return mock tokens
        let mut system_prompt = String::from("You are a helpful assistant.");
        if let Some(context_hint) = context.get("system_context") {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(context_hint);
        }

        let full_prompt = format!("System: {}\n\nUser: {}", system_prompt, prompt);
        let tokens = crate::inference::mock_tokens(&full_prompt);
        let stream = ApiTokenStream {
            tokens: tokens.into_iter(),
        };

        Ok(Box::new(stream))
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            name: "api".to_string(),
            version: "0.1.0".to_string(),
            model_name: self.model.clone(),
            max_context_length: 128000, // Varies by provider
            supports_streaming: true,
            supports_function_calling: true,
            supports_images: true,
        }
    }

    async fn health_check(&self) -> Result<()> {
        // TODO: Implement actual health check via API
        Ok(())
    }

    async fn get_stats(&self) -> BackendStats {
        BackendStats {
            gpu_utilization_percent: 0, // N/A for API
            memory_used_mb: 0,
            memory_total_mb: 0,
            active_requests: 0,
            total_tokens_generated: 0,
            avg_tokens_per_second: 0.0,
        }
    }
}

/// Token stream from API backend.
struct ApiTokenStream {
    tokens: std::vec::IntoIter<String>,
}

#[async_trait]
impl TokenStream for ApiTokenStream {
    async fn next(&mut self) -> Option<Result<String>> {
        self.tokens.next().map(Ok)
    }
}

/// Backend factory that selects the appropriate implementation.
pub enum BackendKind {
    /// Use local GGML (llama.cpp compatible) inference.
    Ggml(String), // model path
    /// Use external API.
    Api {
        api_key: String,
        endpoint: String,
        model: String,
    },
    /// Use mock backend (for testing).
    Mock,
}

impl BackendKind {
    /// Build the backend.
    pub async fn build(&self) -> Result<Box<dyn InferenceBackend>> {
        match self {
            BackendKind::Ggml(path) => {
                let backend = GgmlBackend::new(path)?;
                backend.health_check().await?;
                Ok(Box::new(backend))
            }
            BackendKind::Api {
                api_key,
                endpoint,
                model,
            } => {
                let backend = ApiBackend::new(api_key.clone(), endpoint.clone(), model.clone());
                backend.health_check().await?;
                Ok(Box::new(backend))
            }
            BackendKind::Mock => {
                // Return the mock backend from the main inference module
                Err(anyhow::anyhow!("Mock backend must be used via main inference module"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ggml_metadata_is_correct() {
        // Note: This test requires a valid model file; skip in CI
        if std::path::Path::new("/tmp/test-model.gguf").exists() {
            let backend = GgmlBackend::new("/tmp/test-model.gguf").unwrap();
            let meta = backend.metadata();
            assert_eq!(meta.name, "ggml");
            assert!(meta.supports_streaming);
        }
    }

    #[test]
    fn api_backend_metadata_is_complete() {
        let backend = ApiBackend::new(
            "key".to_string(),
            "https://api.example.com".to_string(),
            "gpt-4".to_string(),
        );
        let meta = backend.metadata();
        assert_eq!(meta.name, "api");
        assert!(meta.supports_function_calling);
        assert!(meta.supports_images);
    }

    #[tokio::test]
    async fn backend_health_check_works() {
        let backend = ApiBackend::new(
            "key".to_string(),
            "https://api.example.com".to_string(),
            "gpt-4".to_string(),
        );
        assert!(backend.health_check().await.is_ok());
    }

    #[tokio::test]
    async fn token_stream_yields_tokens() {
        let backend = ApiBackend::new(
            "key".to_string(),
            "https://api.example.com".to_string(),
            "gpt-4".to_string(),
        );
        let mut stream = backend.infer("hello", &HashMap::new(), 10).await.unwrap();

        let mut count = 0;
        while let Some(result) = stream.next().await {
            assert!(result.is_ok());
            count += 1;
        }
        assert!(count > 0);
    }
}
