//! MDM 服务器配置

use serde::{Deserialize, Serialize};

/// MDM 服务器配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MdmConfig {
    /// 监听地址
    pub listen_address: String,
    /// 数据库路径
    pub database_path: String,
    /// JWT 密钥（保留字段，尚未启用 JWT 流程）
    pub jwt_secret: String,
    /// API 密钥前缀（设备端使用）
    pub api_key_prefix: String,
    /// 默认同步间隔（秒）
    pub default_sync_interval: u64,
    /// 令牌过期时间（秒）
    pub token_expiry_secs: u64,
    /// SHA-256(hex) 形式的管理员共享令牌；为空时拒绝所有 `/api/admin/*`
    /// 请求（fail-closed）。由 `main.rs` 在启动时从 `--admin-token` /
    /// `MDM_ADMIN_TOKEN` 派生；首次启动无任何配置时随机生成并只打印到日志。
    pub admin_token_hash: String,
}

impl Default for MdmConfig {
    fn default() -> Self {
        Self {
            listen_address: "127.0.0.1:9001".into(),
            database_path: "./amos-mdm.db".into(),
            jwt_secret: "amos-mdm-secret-key-change-in-production".into(),
            api_key_prefix: "amos_".into(),
            default_sync_interval: 3600,           // 1 hour
            token_expiry_secs: 365 * 24 * 60 * 60, // 1 year
            // Empty by default: `main.rs` overrides this on every boot with
            // either the CLI / env var or a freshly-generated secret. The
            // empty default exists only so `MdmConfig::default()` keeps
            // compiling for downstream test scaffolding.
            admin_token_hash: String::new(),
        }
    }
}

impl MdmConfig {
    /// 从环境变量加载配置
    pub fn from_env() -> Self {
        Self {
            listen_address: std::env::var("MDM_LISTEN_ADDRESS")
                .unwrap_or_else(|_| "127.0.0.1:9001".into()),
            database_path: std::env::var("MDM_DATABASE_PATH")
                .unwrap_or_else(|_| "./amos-mdm.db".into()),
            jwt_secret: std::env::var("MDM_JWT_SECRET")
                .unwrap_or_else(|_| "amos-mdm-secret-key-change-in-production".into()),
            api_key_prefix: std::env::var("MDM_API_KEY_PREFIX").unwrap_or_else(|_| "amos_".into()),
            default_sync_interval: std::env::var("MDM_SYNC_INTERVAL")
                .unwrap_or_else(|_| "3600".into())
                .parse()
                .unwrap_or(3600),
            token_expiry_secs: std::env::var("MDM_TOKEN_EXPIRY")
                .unwrap_or_else(|_| "31536000".into())
                .parse()
                .unwrap_or(31536000),
            admin_token_hash: std::env::var("MDM_ADMIN_TOKEN_HASH").unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    //! Tests for `MdmConfig`.
    //!
    //! `MdmConfig::default()` is what `main.rs` falls back to when no env
    //! vars are set; `from_env` is what production callers use. We pin the
    //! defaults so a silent change ("oh let's just bump that to 60s for
    //! the demo") fails the suite.
    //!
    //! The env-mutation tests are serial: every test that calls
    //! `std::env::set_var` runs in the same process and could clobber a
    //! sibling. We use serial_test's `serial` macro if present, otherwise
    // we serialize by hand with a static Mutex.
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn default_values_are_documented() {
        let c = MdmConfig::default();
        assert_eq!(c.listen_address, "127.0.0.1:9001");
        assert_eq!(c.database_path, "./amos-mdm.db");
        assert_eq!(c.api_key_prefix, "amos_");
        assert_eq!(c.default_sync_interval, 3600);
        assert_eq!(c.token_expiry_secs, 365 * 24 * 60 * 60);
        // admin_token_hash MUST be empty by default — see module doc.
        assert!(
            c.admin_token_hash.is_empty(),
            "default admin_token_hash must be empty so fail-closed is the starting posture"
        );
    }

    #[test]
    fn from_env_returns_defaults_when_no_vars_are_set() {
        let _g = ENV_LOCK.lock().unwrap();
        // Clear all MDM_* vars to ensure we hit the defaults.
        for k in [
            "MDM_LISTEN_ADDRESS",
            "MDM_DATABASE_PATH",
            "MDM_JWT_SECRET",
            "MDM_API_KEY_PREFIX",
            "MDM_SYNC_INTERVAL",
            "MDM_TOKEN_EXPIRY",
            "MDM_ADMIN_TOKEN_HASH",
        ] {
            std::env::remove_var(k);
        }
        let c = MdmConfig::from_env();
        assert_eq!(c.listen_address, "127.0.0.1:9001");
        assert_eq!(c.api_key_prefix, "amos_");
        assert_eq!(c.admin_token_hash, "");
    }

    #[test]
    fn from_env_reads_listen_address() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("MDM_LISTEN_ADDRESS", "0.0.0.0:9100");
        let c = MdmConfig::from_env();
        assert_eq!(c.listen_address, "0.0.0.0:9100");
        std::env::remove_var("MDM_LISTEN_ADDRESS");
    }

    #[test]
    fn from_env_reads_api_key_prefix() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("MDM_API_KEY_PREFIX", "amosv2_");
        let c = MdmConfig::from_env();
        assert_eq!(c.api_key_prefix, "amosv2_");
        std::env::remove_var("MDM_API_KEY_PREFIX");
    }

    #[test]
    fn from_env_falls_back_when_sync_interval_is_garbage() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("MDM_SYNC_INTERVAL", "not-a-number");
        let c = MdmConfig::from_env();
        // `.unwrap_or(3600)` keeps the daemon alive on a misconfigured
        // value rather than panic'ing. Pin the fallback.
        assert_eq!(c.default_sync_interval, 3600);
        std::env::remove_var("MDM_SYNC_INTERVAL");
    }

    #[test]
    fn from_env_falls_back_when_token_expiry_is_garbage() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("MDM_TOKEN_EXPIRY", "10x");
        let c = MdmConfig::from_env();
        assert_eq!(c.token_expiry_secs, 31_536_000);
        std::env::remove_var("MDM_TOKEN_EXPIRY");
    }

    #[test]
    fn from_env_reads_admin_token_hash() {
        let _g = ENV_LOCK.lock().unwrap();
        let hash = "a".repeat(64);
        std::env::set_var("MDM_ADMIN_TOKEN_HASH", &hash);
        let c = MdmConfig::from_env();
        assert_eq!(c.admin_token_hash, hash);
        std::env::remove_var("MDM_ADMIN_TOKEN_HASH");
    }
}
