//! Configuration management for the amos-ai daemon.
//!
//! Loads configuration from environment variables, command-line arguments,
//! and optional configuration files. Validates and provides sensible defaults.

use std::path::PathBuf;
use std::time::Duration;

/// Daemon configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Unix Domain Socket path for gRPC server.
    pub socket_path: PathBuf,

    /// Inference model identifier (e.g., "llama-7b", "qwen-4b").
    pub inference_model: String,

    /// Maximum tokens to generate per request.
    pub max_tokens: usize,

    /// Request timeout.
    pub request_timeout: Duration,

    /// Maximum concurrent inference sessions.
    pub max_concurrent_sessions: usize,

    /// Session inactivity timeout (sessions auto-close after this duration).
    pub session_timeout: Duration,

    /// Enable structured logging.
    pub structured_logging: bool,

    /// Log level filter (debug, info, warn, error).
    pub log_level: String,

    /// Number of worker threads for inference.
    pub worker_threads: usize,

    /// Memory limit for inference (MB).
    pub memory_limit_mb: usize,

    /// Enable GPU/NPU acceleration (if available).
    pub enable_acceleration: bool,

    /// Path to model weights file (optional).
    pub model_weights_path: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            socket_path: crate::resolve_socket(),
            inference_model: "amos-mock@0.1.0".to_string(),
            max_tokens: 2048,
            request_timeout: Duration::from_secs(30),
            max_concurrent_sessions: 16,
            session_timeout: Duration::from_secs(300),
            structured_logging: true,
            log_level: "info".to_string(),
            worker_threads: num_cpus::get(),
            memory_limit_mb: 2048,
            enable_acceleration: true,
            model_weights_path: None,
        }
    }
}

impl Config {
    /// Load configuration from environment variables.
    ///
    /// Environment variables take precedence:
    /// - `AMOS_SOCKET` - socket path
    /// - `AMOS_MODEL` - inference model
    /// - `AMOS_MAX_TOKENS` - max tokens
    /// - `AMOS_TIMEOUT_SECS` - request timeout in seconds
    /// - `AMOS_MAX_SESSIONS` - max concurrent sessions
    /// - `AMOS_SESSION_TIMEOUT_SECS` - session timeout in seconds
    /// - `RUST_LOG` - log level
    /// - `AMOS_MEMORY_LIMIT_MB` - memory limit
    /// - `AMOS_ACCELERATION` - enable GPU/NPU (true/false)
    /// - `AMOS_MODEL_PATH` - path to model weights
    pub fn from_env() -> Result<Self, String> {
        let mut config = Config::default();

        if let Ok(path) = std::env::var("AMOS_SOCKET") {
            if !path.is_empty() {
                config.socket_path = PathBuf::from(path);
            }
        }

        if let Ok(model) = std::env::var("AMOS_MODEL") {
            if !model.is_empty() {
                config.inference_model = model;
            }
        }

        if let Ok(tokens) = std::env::var("AMOS_MAX_TOKENS") {
            if let Ok(t) = tokens.parse::<usize>() {
                config.max_tokens = t;
            }
        }

        if let Ok(timeout) = std::env::var("AMOS_TIMEOUT_SECS") {
            if let Ok(t) = timeout.parse::<u64>() {
                config.request_timeout = Duration::from_secs(t);
            }
        }

        if let Ok(sessions) = std::env::var("AMOS_MAX_SESSIONS") {
            if let Ok(s) = sessions.parse::<usize>() {
                config.max_concurrent_sessions = s;
            }
        }

        if let Ok(timeout) = std::env::var("AMOS_SESSION_TIMEOUT_SECS") {
            if let Ok(t) = timeout.parse::<u64>() {
                config.session_timeout = Duration::from_secs(t);
            }
        }

        if let Ok(level) = std::env::var("RUST_LOG") {
            if !level.is_empty() {
                config.log_level = level;
            }
        }

        if let Ok(memory) = std::env::var("AMOS_MEMORY_LIMIT_MB") {
            if let Ok(m) = memory.parse::<usize>() {
                config.memory_limit_mb = m;
            }
        }

        if let Ok(accel) = std::env::var("AMOS_ACCELERATION") {
            config.enable_acceleration = accel.to_lowercase() == "true" || accel == "1";
        }

        if let Ok(path) = std::env::var("AMOS_MODEL_PATH") {
            if !path.is_empty() {
                config.model_weights_path = Some(PathBuf::from(path));
            }
        }

        config.validate()?;
        Ok(config)
    }

    /// Validate configuration values.
    pub fn validate(&self) -> Result<(), String> {
        if self.max_tokens == 0 {
            return Err("max_tokens must be > 0".to_string());
        }

        if self.max_tokens > 32768 {
            tracing::warn!("max_tokens is very high: {}", self.max_tokens);
        }

        if self.request_timeout.as_secs() == 0 {
            return Err("request_timeout must be > 0".to_string());
        }

        if self.max_concurrent_sessions == 0 {
            return Err("max_concurrent_sessions must be > 0".to_string());
        }

        if self.session_timeout.as_secs() == 0 {
            return Err("session_timeout must be > 0".to_string());
        }

        if self.memory_limit_mb < 256 {
            tracing::warn!("memory_limit_mb is very low: {} MB", self.memory_limit_mb);
        }

        if self.worker_threads == 0 {
            return Err("worker_threads must be > 0".to_string());
        }

        if let Some(ref path) = self.model_weights_path {
            if !path.exists() {
                tracing::warn!("model_weights_path does not exist: {}", path.display());
            }
        }

        Ok(())
    }

    /// Log the configuration (with sensitive values hidden).
    pub fn log_summary(&self) {
        tracing::info!(
            "Config: model={}, max_tokens={}, timeout={:.1}s, sessions={}, memory={}MB",
            self.inference_model,
            self.max_tokens,
            self.request_timeout.as_secs_f64(),
            self.max_concurrent_sessions,
            self.memory_limit_mb,
        );

        if self.enable_acceleration {
            tracing::info!("GPU/NPU acceleration: enabled");
        }

        if let Some(ref path) = self.model_weights_path {
            tracing::info!("Model weights: {}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        let config = Config::default();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn socket_path_respects_env() {
        std::env::set_var("AMOS_SOCKET", "/custom/path.sock");
        let config = Config::from_env().unwrap();
        assert_eq!(config.socket_path, PathBuf::from("/custom/path.sock"));
        std::env::remove_var("AMOS_SOCKET");
    }

    #[test]
    fn max_tokens_respects_env() {
        std::env::set_var("AMOS_MAX_TOKENS", "512");
        let config = Config::from_env().unwrap();
        assert_eq!(config.max_tokens, 512);
        std::env::remove_var("AMOS_MAX_TOKENS");
    }

    #[test]
    fn invalid_max_tokens_fails() {
        let config = Config {
            max_tokens: 0,
            ..Default::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn invalid_timeout_fails() {
        let config = Config {
            request_timeout: Duration::from_secs(0),
            ..Default::default()
        };
        assert!(config.validate().is_err());
    }
}
