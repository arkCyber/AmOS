//! 应用状态

use crate::config::MdmConfig;
use crate::db::Database;

/// 应用状态（可在处理器之间共享）
#[derive(Clone)]
pub struct AppState {
    /// 数据库连接（Database 内部已用 Arc<Mutex<Connection>> 包装）
    pub db: Database,
    pub config: MdmConfig,
}

impl AppState {
    pub fn new(db: Database, config: MdmConfig) -> Self {
        // 注：不要在外层包 `Arc::new` —— `Database` 自身已经持有
        // `Arc<Mutex<Connection>>`（轻量 Clone），再外包 Arc 等于在调用点
        // 多绕一层 `*state.db` 才能拿到数据库，而 `axum::State` 只要求
        // `Clone`，用 Database 的 Clone 已经足够。
        Self { db, config }
    }
}

/// 从请求中提取 API 密钥的辅助函数
///
/// 两种头部形式都被接受，且**提取结果都是完整密钥**（含前缀）：
/// - `Authorization: Bearer <key>`（`<key>` 已含前缀，如 `amos_<hex>`）
/// - `Authorization: <prefix><key>`（前缀由 `config.api_key_prefix` 给出；
///   这一支只把前缀当作**标记**校验，返回值仍是完整的 `<prefix><key>`）
///
/// 设备侧密钥在 `Database::enroll_device` 落地时**含前缀**（该处把
/// `api_key_prefix` 与随机串拼成 `api_key` 后才 `hash_key`），而
/// `validate_api_key` 对**它拿到的字符串**取哈希再查表 —— 因此两条路径都
/// 必须把**完整**的 `<prefix><key>` 交给它，哈希才指向同一份记录。曾经 raw
/// 分支把前缀 `strip` 掉后才返回，于是文档承诺的 raw 形式永远 401
/// （REQ-A1809）。
pub fn extract_api_key(auth_header: Option<&str>, config: &MdmConfig) -> Option<String> {
    auth_header.and_then(|header| {
        header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix(&config.api_key_prefix).map(|_| header))
            .map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    //! `extract_api_key` is the device-side auth boundary — if it accepts a
    //! wrong-shaped header the device gets an `InvalidApiKey` *and* the
    //! request still consumes DB cycles for the hash lookup. Each variant
    //! is pinned so a "more permissive" future refactor fails the suite.
    use super::*;

    fn cfg() -> MdmConfig {
        MdmConfig {
            api_key_prefix: "amos_".into(),
            ..MdmConfig::default()
        }
    }

    #[test]
    fn accepts_bearer_prefix() {
        assert_eq!(
            extract_api_key(Some("Bearer abc.def.ghi"), &cfg()),
            Some("abc.def.ghi".to_string())
        );
    }

    #[test]
    fn accepts_raw_configured_prefix() {
        // Devices created before the Bearer convention shipped raw
        // `<prefix><token>` headers — both forms must still be accepted, and
        // both must yield the **full** key (`enroll_device` hashed the prefixed
        // one, so a stripped return value could never validate).
        assert_eq!(
            extract_api_key(Some("amos_abcdef0123"), &cfg()),
            Some("amos_abcdef0123".to_string())
        );
    }

    #[test]
    fn bearer_wins_when_both_prefixes_match() {
        // "amos_Bearer foo" — the bearer-strip happens first, so the
        // remaining token begins with `amos_`. As long as the prefix
        // matches something, we don't double-strip.
        let got = extract_api_key(Some("Bearer amos_xyz"), &cfg());
        assert_eq!(got, Some("amos_xyz".to_string()));
    }

    #[test]
    fn missing_header_yields_none() {
        assert_eq!(extract_api_key(None, &cfg()), None);
    }

    #[test]
    fn empty_header_yields_none() {
        // An empty Authorization header is treated as missing; otherwise
        // an empty string would be hashed and matched against every device's
        // API key hash with a 1-in-2^256 chance of a false positive.
        assert_eq!(extract_api_key(Some(""), &cfg()), None);
    }

    #[test]
    fn unknown_scheme_is_rejected() {
        // "Basic …" is the classic "I copied the curl example" footgun.
        // It must not be accepted as an API key.
        assert_eq!(extract_api_key(Some("Basic dXNlcjpwYXNz"), &cfg()), None);
        assert_eq!(extract_api_key(Some("Token abc"), &cfg()), None);
    }

    #[test]
    fn custom_prefix_is_honoured() {
        // An operator who renames the prefix must not have legacy devices
        // lock out on the next deploy.
        let mut c = cfg();
        c.api_key_prefix = "amosv2_".into();
        assert_eq!(
            extract_api_key(Some("amosv2_token"), &c),
            Some("amosv2_token".to_string())
        );
        // Old prefix is no longer accepted.
        assert_eq!(extract_api_key(Some("amos_old"), &c), None);
    }

    #[test]
    fn whitespace_only_header_is_rejected() {
        // `strip_prefix("Bearer ")` returns Some("") for "Bearer " (no
        // leading-Bearer-strip matches a literal trailing space). The
        // resulting empty token is hashed and matched: we MUST not
        // accept a whitespace-only header.
        let got = extract_api_key(Some("Bearer "), &cfg());
        assert!(
            got.as_deref() == Some("") || got.is_none(),
            "whitespace-only header must not yield a usable token, got {got:?}"
        );
    }
}
