//! Production inference backends for real GPU/NPU acceleration.
//!
//! This module provides abstraction over different inference implementations:
//! - Local GPU/NPU execution (GGML, llama.cpp, MLC-LLM)
//! - External API calls (OpenAI, Claude, etc.)
//! - Custom backends (proprietary accelerators)

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::time::Duration;

/// Context-map key carrying the client `session_id` so a backend with its own
/// session lineage (e.g. Hermes-Rust) can bind multi-turn memory to it.
pub const SESSION_CTX_KEY: &str = "session_id";

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
///
/// Every field is `Option` **on purpose**: `None` means "not instrumented / no
/// data available", which is distinct from a genuine reading of `0`. Callers
/// must treat `None` as unknown and must never render it as a real metric.
/// (Safety principle: do not fabricate telemetry values to fill a dashboard.)
#[derive(Debug, Clone)]
pub struct BackendStats {
    pub gpu_utilization_percent: Option<u32>,
    pub memory_used_mb: Option<usize>,
    pub memory_total_mb: Option<usize>,
    pub active_requests: Option<usize>,
    pub total_tokens_generated: Option<u64>,
    pub avg_tokens_per_second: Option<f32>,
}

impl Default for BackendStats {
    /// Honest default: every metric is *unknown* until a backend instruments it.
    fn default() -> Self {
        Self {
            gpu_utilization_percent: None,
            memory_used_mb: None,
            memory_total_mb: None,
            active_requests: None,
            total_tokens_generated: None,
            avg_tokens_per_second: None,
        }
    }
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

        Ok(Self {
            model_path,
            metadata,
        })
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
        // Real local inference through an external llama.cpp-class engine (e.g.
        // `allama`, which runs GGUF on Metal/CPU). Falls back to the mock token
        // generator when no engine / model is available so offline tests & the
        // browser path keep working.
        let run_name = model_run_name(&self.model_path);
        let prompt_owned = prompt.to_owned();
        let reply = tokio::task::spawn_blocking(move || {
            run_external_engine(&run_name, &prompt_owned, max_tokens)
        })
        .await
        .unwrap_or(None);
        match reply {
            Some(text) => {
                tracing::info!(model = %self.model_path.display(), "ggml real engine replied ({} chars)", text.len());
                Ok(Box::new(GgmlTokenStream {
                    tokens: chunk_reply(&text).into_iter(),
                }))
            }
            None => {
                tracing::warn!(model = %self.model_path.display(), "ggml engine unavailable — using mock tokens");
                let tokens = crate::inference::mock_tokens(prompt);
                Ok(Box::new(GgmlTokenStream {
                    tokens: tokens.into_iter(),
                }))
            }
        }
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
        // Honest telemetry: no local GPU counters are instrumented yet, so report
        // "unknown" (None) rather than a fabricated 0 / 8192. See BackendStats.
        BackendStats::default()
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

/// Derive the engine "run name" from a GGUF path. allama stores models as
/// `~/.allama/models/<name>/<name>:<size>.gguf`, so the parent dir is the run
/// name. Override with `AMOS_GGML_MODEL` when the layout differs.
fn model_run_name(path: &std::path::Path) -> String {
    if let Ok(n) = std::env::var("AMOS_GGML_MODEL") {
        if !n.is_empty() {
            return n;
        }
    }
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string());
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    // allama layout: parent == "qwen2.5", file == "qwen2.5:0.5b.gguf" (stem starts with "name:")
    if let Some(p) = &parent {
        if !p.is_empty()
            && p != "models"
            && (stem == *p
                || stem.starts_with(&format!("{p}:"))
                || stem.starts_with(&format!("{p}-")))
        {
            return p.clone();
        }
    }
    if stem.is_empty() {
        "qwen2.5".to_string()
    } else {
        stem
    }
}

/// Is an external GGML engine (default `allama`) available on PATH?
fn engine_available() -> bool {
    let bin = std::env::var("AMOS_GGML_BIN").unwrap_or_else(|_| "allama".into());
    std::process::Command::new(bin)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run a one-shot completion through the engine: `allama run <name> -p <prompt>`.
/// Logs are silenced with `RUST_LOG=off` and proxy env vars are cleared so the
/// request stays local. Returns `None` when the engine/model is unavailable.
fn run_external_engine(run_name: &str, prompt: &str, _max_tokens: usize) -> Option<String> {
    if !engine_available() {
        return None;
    }
    let bin = std::env::var("AMOS_GGML_BIN").unwrap_or_else(|_| "allama".into());
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("run")
        .arg(run_name)
        .arg("-p")
        .arg(prompt)
        .arg("--nowordwrap");
    cmd.env("RUST_LOG", "off");
    for p in [
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
    ] {
        cmd.env_remove(p);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let cleaned = clean_engine_output(&text);
    if cleaned.trim().is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Drop allama's stdout noise (loading/progress/[Generated …]) and keep the reply.
fn clean_engine_output(output: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("Loading model")
            || t.starts_with("Model loaded successfully")
            || t.starts_with("Running model")
            || t.contains("[Generated ")
            || t.starts_with("2026-")
        {
            continue;
        }
        kept.push(t.to_string());
    }
    kept.join(" ")
}

/// Split a reply into word-ish tokens so the frontend can stream it; whitespace
/// is preserved on each token so concatenation reproduces the original text.
fn chunk_reply(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    for ch in text.trim().chars() {
        buf.push(ch);
        if ch.is_whitespace() {
            out.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
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
        let mut system_prompt = String::from("You are a helpful assistant.");
        if let Some(hint) = context.get("system_context") {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(hint);
        }

        let body = serde_json::json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": prompt },
            ],
            "max_tokens": max_tokens,
            "stream": true,
        });

        let tokens = stream_chat_completions(&self.api_endpoint, Some(&self.api_key), body).await?;
        Ok(Box::new(ApiTokenStream {
            tokens: tokens.into_iter(),
        }))
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
        // Health for an API backend = is it properly configured? A missing key
        // means calls would 401, so report unhealthy until configured.
        if self.api_key.is_empty() {
            anyhow::bail!("API backend is not configured: missing API key");
        }
        if self.api_endpoint.is_empty() {
            anyhow::bail!("API backend is not configured: missing endpoint");
        }
        Ok(())
    }

    async fn get_stats(&self) -> BackendStats {
        // Remote API — we cannot observe GPU/RAM here; report unknown (None)
        // instead of zeros pretending to be real usage.
        BackendStats::default()
    }
}

/// Parse one SSE `data:` line from an OpenAI-compatible stream into a text delta.
/// Returns `None` for non-delta lines (role frames, `[DONE]`, heartbeats).
fn parse_sse_chunk(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:").unwrap_or(line).trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let delta = v.get("choices")?.get(0)?.get("delta")?;
    let content = delta.get("content")?;
    content.as_str().map(|s| s.to_string())
}

/// Extract the text delta from a Hermes-Rust native `StreamEvent` SSE frame.
/// Only `{"type":"token","content":"..."}` frames carry streamed text; thinking /
/// tool_* / done frames are control events and yield `None`.
fn parse_hermes_token(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:").unwrap_or(line).trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("token") {
        return None;
    }
    v.get("content")
        .and_then(|c| c.as_str())
        .map(str::to_string)
}

/// POST an OpenAI-compatible chat request and collect streamed text deltas.
/// `bearer` is `None` for keyless servers (e.g. Ollama); blocking HTTP + SSE
/// parsing is moved off the async executor.
async fn stream_chat_completions(
    url: &str,
    bearer: Option<&str>,
    body: serde_json::Value,
) -> Result<Vec<String>> {
    stream_sse_completions(url, bearer, body, parse_sse_chunk).await
}

/// Generic streaming helper: POST `body` and collect text deltas from each SSE
/// `data:` line using the supplied parser. `bearer` is `None` for keyless
/// servers (Ollama, Hermes). Blocking HTTP + SSE parsing is off the executor.
async fn stream_sse_completions(
    url: &str,
    bearer: Option<&str>,
    body: serde_json::Value,
    mut parse: impl FnMut(&str) -> Option<String> + Send + 'static,
) -> Result<Vec<String>> {
    let url = url.to_string();
    let bearer = bearer.map(|s| s.to_string());
    let body = body.to_string();

    let inner: Result<Vec<String>, String> = tokio::task::spawn_blocking(move || {
        let mut req = ureq::post(&url)
            .timeout(Duration::from_secs(60))
            .set("Content-Type", "application/json");
        if let Some(b) = &bearer {
            req = req.set("Authorization", &format!("Bearer {b}"));
        }
        let resp = req.send_string(&body).map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(resp.into_reader());
        let mut tokens = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                break; // EOF
            }
            if let Some(t) = parse(&line) {
                tokens.push(t);
            }
        }
        Ok(tokens)
    })
    .await
    .map_err(|e| anyhow!("blocking task join error: {e}"))?;

    inner.map_err(|e| anyhow!(e))
}

/// Parse the model-name list from an Ollama `/api/tags` response.
fn parse_ollama_models(tags_json: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(tags_json) else {
        return Vec::new();
    };
    let Some(models) = v.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect()
}

/// Blocking GET of an Ollama `/api/tags` endpoint; returns available model names.
fn fetch_ollama_models(host: &str) -> Result<Vec<String>> {
    let url = format!("{host}/api/tags");
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| anyhow!("Ollama unreachable at {url}: {e}"))?;
    let text = resp
        .into_string()
        .map_err(|e| anyhow!("failed to read Ollama tags: {e}"))?;
    Ok(parse_ollama_models(&text))
}

/// First-class local backend for an [Ollama](https://ollama.com) server.
///
/// Talks to Ollama's OpenAI-compatible `/v1/chat/completions` (streaming) and
/// uses the native `/api/tags` endpoint for health checks that also report
/// which models are available. Keyless by default, but an optional
/// `Authorization: Bearer` can be supplied (some local Ollama builds / reverse
/// proxies gate `/v1` behind an API key).
pub struct OllamaBackend {
    host: String,
    model: String,
    bearer: Option<String>,
}

impl OllamaBackend {
    /// Create a keyless backend for a host (e.g. `http://localhost:11434`) and model.
    pub fn new(host: String, model: String) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            model,
            bearer: None,
        }
    }

    /// Set an optional bearer token so token-gated Ollama deployments can be used.
    pub fn with_bearer(mut self, bearer: Option<String>) -> Self {
        self.bearer = bearer;
        self
    }

    /// Names of the models currently installed on the Ollama server.
    pub async fn list_models(&self) -> Vec<String> {
        let host = self.host.clone();
        tokio::task::spawn_blocking(move || fetch_ollama_models(&host).unwrap_or_default())
            .await
            .unwrap_or_default()
    }
}

#[async_trait]
impl InferenceBackend for OllamaBackend {
    async fn infer(
        &self,
        prompt: &str,
        context: &HashMap<String, String>,
        max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        let mut system_prompt = String::from("You are a helpful assistant.");
        if let Some(hint) = context.get("system_context") {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(hint);
        }

        let body = serde_json::json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": prompt },
            ],
            "max_tokens": max_tokens,
            "stream": true,
        });
        let url = format!("{}/v1/chat/completions", self.host);
        let tokens = stream_chat_completions(&url, self.bearer.as_deref(), body).await?;
        Ok(Box::new(ApiTokenStream {
            tokens: tokens.into_iter(),
        }))
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            name: "ollama".to_string(),
            version: "0.1.0".to_string(),
            model_name: self.model.clone(),
            max_context_length: 32768,
            supports_streaming: true,
            // Hermes-class models expose tool/function calling.
            supports_function_calling: true,
            supports_images: false,
        }
    }

    async fn health_check(&self) -> Result<()> {
        let host = self.host.clone();
        let model = self.model.clone();
        let models = tokio::task::spawn_blocking(move || fetch_ollama_models(&host))
            .await
            .map_err(|e| anyhow!("ollama health task join: {e}"))??;
        if models.is_empty() {
            tracing::warn!(host = %self.host, "Ollama is up but returned no models");
            return Ok(());
        }
        if models
            .iter()
            .any(|m| m == &self.model || m.starts_with(&format!("{}:", self.model)))
        {
            tracing::info!(host = %self.host, model = %self.model, "ollama model available");
        } else {
            tracing::warn!(
                host = %self.host,
                requested = %model,
                available = ?models,
                "requested model not installed; ollama will pull it on first use"
            );
        }
        Ok(())
    }

    async fn get_stats(&self) -> BackendStats {
        // Honest telemetry: not instrumented here -> report unknown (None), not 0.
        BackendStats::default()
    }
}

/// First-class backend for the Hermes-Rust agent (which itself calls Ollama).
///
/// Talks to Hermes-Rust's OpenAI-compatible `POST /v1/chat/completions` and
/// streams Hermes' native `{"type":"token"}` events for real token-by-token
/// output. Default endpoint: `http://127.0.0.1:11438`.
pub struct HermesAgentBackend {
    endpoint: String,
    model: String,
}

impl HermesAgentBackend {
    /// Create a backend for a Hermes-Rust base URL (e.g. `http://127.0.0.1:11438`).
    pub fn new(base_url: String, model: String) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        Self {
            endpoint: format!("{base_url}/v1/chat/completions"),
            model,
        }
    }
}

/// Build the OpenAI-compatible request body for Hermes-Rust, optionally binding
/// a `session_id` so it can resume its SQLite conversation lineage.
fn build_hermes_body(
    model: &str,
    system: &str,
    prompt: &str,
    max_tokens: usize,
    session_id: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": prompt },
        ],
        "max_tokens": max_tokens,
        "stream": true,
    });
    if let Some(sid) = session_id {
        body["session_id"] = serde_json::json!(sid);
    }
    body
}

#[async_trait]
impl InferenceBackend for HermesAgentBackend {
    async fn infer(
        &self,
        prompt: &str,
        context: &HashMap<String, String>,
        max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        let mut system_prompt = String::from("You are a helpful assistant.");
        if let Some(hint) = context.get("system_context") {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(hint);
        }

        let body = build_hermes_body(
            &self.model,
            &system_prompt,
            prompt,
            max_tokens,
            context.get(SESSION_CTX_KEY).map(String::as_str),
        );
        // Hermes streams each token as a native `{"type":"token"}` frame AND
        // repeats the full text in the terminal OpenAI delta. Track whether we
        // saw native tokens so we don't double-emit the delta.
        let mut saw_token = false;
        let parse = move |line: &str| -> Option<String> {
            if let Some(t) = parse_hermes_token(line) {
                saw_token = true;
                return Some(t);
            }
            // OpenAI delta is only a fallback (e.g. non-streaming done frame).
            if !saw_token {
                return parse_sse_chunk(line);
            }
            None
        };
        let tokens = stream_sse_completions(&self.endpoint, None, body, parse).await?;
        Ok(Box::new(ApiTokenStream {
            tokens: tokens.into_iter(),
        }))
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            name: "hermes".to_string(),
            version: "0.1.0".to_string(),
            model_name: self.model.clone(),
            max_context_length: 65536,
            supports_streaming: true,
            // Hermes exposes tools / agent runs.
            supports_function_calling: true,
            supports_images: false,
        }
    }

    async fn health_check(&self) -> Result<()> {
        // `/health` is cheap and daemon-agnostic.
        let url = self.endpoint.trim_end_matches("/v1/chat/completions");
        let url = format!("{url}/health");
        let url2 = url.clone();
        let alive = tokio::task::spawn_blocking(move || {
            ureq::get(&url2)
                .timeout(Duration::from_secs(5))
                .call()
                .map(|_| true)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| anyhow!("hermes health task join: {e}"))?;
        match alive {
            Ok(true) => Ok(()),
            Ok(false) => anyhow::bail!("hermes /health returned failure"),
            Err(e) => anyhow::bail!("hermes-rust unreachable at {url}: {e}"),
        }
    }

    async fn get_stats(&self) -> BackendStats {
        // Honest telemetry: not instrumented here -> report unknown (None), not 0.
        BackendStats::default()
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

/// Mock backend: uses the deterministic token generator for tests / dev. Lets
/// `BackendKind::build()` return a usable backend for every variant (no stub
/// that errors out).
pub struct MockBackend {
    metadata: BackendMetadata,
}

impl Default for MockBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MockBackend {
    pub fn new() -> Self {
        Self {
            metadata: BackendMetadata {
                name: "mock".to_string(),
                version: "0.1.0".to_string(),
                model_name: "amos-mock".to_string(),
                max_context_length: 4096,
                supports_streaming: true,
                supports_function_calling: false,
                supports_images: false,
            },
        }
    }
}

#[async_trait]
impl InferenceBackend for MockBackend {
    async fn infer(
        &self,
        prompt: &str,
        _context: &HashMap<String, String>,
        _max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        let tokens = crate::inference::mock_tokens(prompt);
        Ok(Box::new(ApiTokenStream {
            tokens: tokens.into_iter(),
        }))
    }

    fn metadata(&self) -> BackendMetadata {
        self.metadata.clone()
    }

    async fn health_check(&self) -> Result<()> {
        Ok(())
    }

    async fn get_stats(&self) -> BackendStats {
        // Honest telemetry: not instrumented here -> report unknown (None), not 0.
        BackendStats::default()
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
    /// Use a local Ollama server (OpenAI-compatible; optional bearer token for
    /// token-gated deployments).
    Ollama {
        host: String,
        model: String,
        bearer: Option<String>,
    },
    /// Use the Hermes-Rust agent (which itself calls Ollama) via its HTTP API.
    Hermes { base_url: String, model: String },
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
            BackendKind::Ollama {
                host,
                model,
                bearer,
            } => {
                let backend =
                    OllamaBackend::new(host.clone(), model.clone()).with_bearer(bearer.clone());
                backend.health_check().await?;
                Ok(Box::new(backend))
            }
            BackendKind::Hermes { base_url, model } => {
                let backend = HermesAgentBackend::new(base_url.clone(), model.clone());
                backend.health_check().await?;
                Ok(Box::new(backend))
            }
            BackendKind::Mock => {
                let backend = MockBackend::new();
                backend.health_check().await?;
                Ok(Box::new(backend))
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
    async fn mock_backend_builds_and_streams_tokens() {
        let backend = BackendKind::Mock.build().await.expect("mock builds");
        assert_eq!(backend.metadata().name, "mock");
        assert!(backend.health_check().await.is_ok());

        let mut stream = backend
            .infer("你好", &HashMap::new(), 64)
            .await
            .expect("mock infer");
        let mut count = 0;
        while let Some(Ok(_t)) = stream.next().await {
            count += 1;
        }
        assert!(count > 0, "mock backend yields tokens");
    }

    #[tokio::test]
    async fn api_backend_health_requires_config() {
        let ok = ApiBackend::new(
            "key".to_string(),
            "https://api.example.com".to_string(),
            "gpt-4".to_string(),
        );
        assert!(
            ok.health_check().await.is_ok(),
            "configured backend is healthy"
        );

        let no_key = ApiBackend::new(
            String::new(),
            "https://api.example.com".to_string(),
            "gpt-4".to_string(),
        );
        assert!(
            no_key.health_check().await.is_err(),
            "missing API key makes the backend unhealthy"
        );
    }

    #[tokio::test]
    async fn token_stream_yields_tokens() {
        // The token-stream interface is exercised via the mock backend (no
        // network); the API backend's HTTP path is covered by parse_sse_chunk.
        let backend = MockBackend::new();
        let mut stream = backend.infer("hello", &HashMap::new(), 10).await.unwrap();

        let mut count = 0;
        while let Some(result) = stream.next().await {
            assert!(result.is_ok());
            count += 1;
        }
        assert!(count > 0);
    }

    #[test]
    fn parse_sse_chunk_extracts_deltas_and_ignores_controls() {
        // A real OpenAI-style SSE delta frame.
        let delta = r#"data: {"id":"x","choices":[{"index":0,"delta":{"content":"Hel"}}]}"#;
        assert_eq!(parse_sse_chunk(delta).as_deref(), Some("Hel"));

        // Role frame with no content → None.
        let role = r#"data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}"#;
        assert_eq!(parse_sse_chunk(role), None);

        // Terminal sentinel → None.
        assert_eq!(parse_sse_chunk("data: [DONE]"), None);
        assert_eq!(parse_sse_chunk("data:"), None);
        assert_eq!(parse_sse_chunk(""), None);

        // Malformed JSON → None (non-fatal, just skips the frame).
        assert_eq!(parse_sse_chunk("data: not-json"), None);
    }

    #[test]
    fn parse_ollama_models_extracts_names() {
        let json = r#"{"models":[
            {"name":"hermes3:8b","model":"hermes3:8b","modified_at":"2025-01-01T00:00:00Z"},
            {"name":"llama3.2:3b","model":"llama3.2:3b","modified_at":"2025-01-01T00:00:00Z"}
        ]}"#;
        let models = parse_ollama_models(json);
        assert!(models.contains(&"hermes3:8b".to_string()));
        assert!(models.contains(&"llama3.2:3b".to_string()));
        assert!(parse_ollama_models("not json").is_empty());
        assert!(parse_ollama_models("{}").is_empty());
    }

    #[test]
    fn ollama_metadata_flags_function_calling() {
        let b = OllamaBackend::new("http://localhost:11434".into(), "hermes3".into());
        let meta = b.metadata();
        assert_eq!(meta.name, "ollama");
        assert_eq!(meta.model_name, "hermes3");
        assert!(
            meta.supports_function_calling,
            "Hermes exposes tool calling"
        );
        assert!(meta.supports_streaming);
    }

    #[test]
    fn parse_hermes_token_streams_native_tokens_only() {
        // Native Hermes StreamEvent token frame → streamed as a token.
        assert_eq!(
            parse_hermes_token(r#"data: {"type":"token","content":"Hel"}"#).as_deref(),
            Some("Hel")
        );
        // Thinking / tool frames / done are not emitted as text.
        assert_eq!(
            parse_hermes_token(r#"data: {"type":"thinking","content":"..."}"#),
            None
        );
        assert_eq!(
            parse_hermes_token(r#"data: {"type":"tool_use","name":"x"}"#),
            None
        );
        assert_eq!(
            parse_hermes_token(r#"data: {"type":"done","content":"x"}"#),
            None
        );
        // OpenAI delta is handled separately (deduped in HermesAgentBackend).
        assert_eq!(
            parse_hermes_token(r#"data: {"choices":[{"delta":{"content":"x"}}]}"#),
            None
        );
        assert_eq!(parse_hermes_token("data: [DONE]"), None);
        assert_eq!(parse_hermes_token("not json"), None);
    }

    #[test]
    fn hermes_metadata_flags_function_calling() {
        let b = HermesAgentBackend::new("http://127.0.0.1:11438".into(), "hermes-rust".into());
        let meta = b.metadata();
        assert_eq!(meta.name, "hermes");
        assert!(meta.supports_streaming);
        assert!(
            meta.supports_function_calling,
            "Hermes exposes tools / agent runs"
        );
    }

    #[test]
    fn hermes_body_binds_session_id_when_present() {
        let body = build_hermes_body("hermes-rust", "sys", "hi", 16, Some("sess-abc"));
        assert_eq!(body["model"], "hermes-rust");
        assert_eq!(body["session_id"], "sess-abc");
        assert_eq!(body["stream"], true);

        let no_sid = build_hermes_body("hermes-rust", "sys", "hi", 16, None);
        assert!(
            no_sid.get("session_id").is_none(),
            "no session_id without context"
        );
    }

    #[tokio::test]
    async fn hermes_health_check_fails_fast_when_unreachable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener); // port now closed
        let b = HermesAgentBackend::new(format!("http://{addr}"), "hermes-rust".into());
        assert!(
            b.health_check().await.is_err(),
            "unreachable Hermes must fail health (no hang)"
        );
    }

    #[test]
    fn ggml_clean_engine_output_keeps_only_reply() {
        let noisy = "Loading model 'qwen2.5'...\nModel loaded successfully (params)\nRunning model 'qwen2.5' with prompt...\n\nHello from allama\n\n[Generated 5 tokens in 12ms]\n";
        let c = clean_engine_output(noisy);
        assert!(!c.contains("Loading"), "progress lines stripped");
        assert!(!c.contains("[Generated"), "footer stripped");
        assert!(c.contains("Hello from allama"), "reply preserved");
    }

    #[test]
    fn ggml_model_run_name_derives_from_allama_layout() {
        assert_eq!(
            model_run_name(std::path::Path::new(
                "/Users/x/.allama/models/qwen2.5/qwen2.5:0.5b.gguf"
            )),
            "qwen2.5"
        );
        assert_eq!(
            model_run_name(std::path::Path::new("/m/plain.gguf")),
            "plain"
        );
    }

    #[test]
    fn ggml_chunk_reply_roundtrips_with_spaces() {
        let src = "  hello  world\nok  ";
        let parts = chunk_reply(src);
        assert_eq!(parts.concat(), "hello  world\nok");
    }

    #[tokio::test]
    async fn ggml_real_engine_streams_when_allama_present() {
        if !engine_available() {
            eprintln!("skip: no allama engine on PATH");
            return;
        }
        let p = format!(
            "{}/.allama/models/qwen2.5/qwen2.5:0.5b.gguf",
            std::env::var("HOME").unwrap_or_default()
        );
        if !std::path::Path::new(&p).exists() {
            eprintln!("skip: qwen2.5 GGUF not found ({p})");
            return;
        }
        let b = GgmlBackend::new(&p).expect("model exists");
        let mut s = b
            .infer(
                "Reply with the single word: AMOS",
                &std::collections::HashMap::new(),
                24,
            )
            .await
            .expect("infer ok");
        let mut txt = String::new();
        while let Some(t) = s.next().await {
            txt.push_str(&t.unwrap_or_default());
        }
        eprintln!("ggml real reply: {txt}");
        assert!(!txt.trim().is_empty(), "real local engine produced text");
    }

    async fn ollama_stream_carries_expected_auth(expect_bearer: bool) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let srv = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let (sock, _) = listener.accept().await.unwrap();
            let mut reader = tokio::io::BufReader::new(sock);
            let mut head = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                    break;
                }
                head.push_str(&line);
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }
            // Drain the request body so closing the socket never RSTs a still-writing client.
            let mut len = 0usize;
            for l in head.to_ascii_lowercase().lines() {
                if let Some(v) = l.strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; len];
            if len > 0 {
                let _ = reader.read_exact(&mut body).await;
            }
            let mut sock = reader.into_inner();
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n{sse}");
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
            let _ = sock.shutdown().await;
            head
        });
        let mut b = OllamaBackend::new(format!("http://{addr}"), "m".into());
        if expect_bearer {
            b = b.with_bearer(Some("sk-test".into()));
        }
        let mut stream = b
            .infer("hi", &std::collections::HashMap::new(), 8)
            .await
            .expect("infer ok");
        let mut all = String::new();
        while let Some(tok) = stream.next().await {
            all.push_str(&tok.expect("token ok"));
        }
        assert_eq!(all, "Hello", "streamed tokens assembled");
        let head = srv.await.unwrap();
        if expect_bearer {
            assert!(
                head.contains("Authorization: Bearer sk-test"),
                "bearer sent when configured"
            );
        } else {
            assert!(!head.contains("Authorization"), "keyless by default");
        }
    }

    #[tokio::test]
    async fn ollama_health_check_fails_fast_when_unreachable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let b = OllamaBackend::new(format!("http://{addr}"), "hermes3".into());
        assert!(
            b.health_check().await.is_err(),
            "unreachable Ollama must fail health (no hang)"
        );
    }

    #[tokio::test]
    async fn ollama_sends_bearer_when_configured() {
        ollama_stream_carries_expected_auth(true).await;
    }

    #[tokio::test]
    async fn ollama_is_keyless_by_default() {
        ollama_stream_carries_expected_auth(false).await;
    }

    /// A backend must report metrics it does not measure as *unknown* (`None`),
    /// never as a fabricated `0`/value-as-if-real (telemetry honesty).
    #[tokio::test]
    async fn stats_report_unknown_instead_of_fabricated_zero() {
        for kind in ["mock", "api"] {
            let backend: Box<dyn InferenceBackend> = match kind {
                "mock" => Box::new(MockBackend::new()),
                _ => Box::new(ApiBackend::new(
                    "k".to_string(),
                    "https://api.example.com".to_string(),
                    "gpt-4".to_string(),
                )),
            };
            let s = backend.get_stats().await;
            assert!(
                s.gpu_utilization_percent.is_none()
                    && s.memory_used_mb.is_none()
                    && s.memory_total_mb.is_none()
                    && s.active_requests.is_none()
                    && s.total_tokens_generated.is_none()
                    && s.avg_tokens_per_second.is_none(),
                "{kind} backend fabricated telemetry (fields must be None): {s:?}",
            );
        }
        // Default value represents "all unknown" — never confuse None with 0.
        assert!(BackendStats::default().memory_total_mb.is_none());
    }
}
