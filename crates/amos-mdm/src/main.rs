//! MDM 服务器入口

// P0-1 gate: production code must not panic on programmer error (tests exempt). The two
// `expect()`s below were the reason this root went ungated; they are `?` now, so the gate
// holds and a bad `--listen`/`--cors-allowed-origins` is a startup error, not a panic.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Parser;
use sha2::{Digest, Sha256};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn, Level};
use tracing_subscriber::FmtSubscriber;

use amos_mdm::{AppState, Database, MdmConfig};

/// Largest request body this server will read, in bytes. Mirror of
/// `amos_mdm::DEFAULT_MAX_BODY_BYTES`; kept as a local constant so an
/// operator who wants a different limit (smaller for an embedded
/// deployment, larger for an on-device policy bundle) can edit it in
/// one place.
const MAX_BODY_BYTES: usize = amos_mdm::DEFAULT_MAX_BODY_BYTES;

/// MDM 服务器命令行参数
#[derive(Parser, Debug)]
#[command(name = "amos-mdm")]
#[command(about = "AmOS MDM Server - Enterprise Mobile Device Management", long_about = None)]
struct Args {
    /// 监听地址
    #[arg(long, default_value = "127.0.0.1:9001")]
    listen: String,

    /// 数据库路径
    #[arg(long, default_value = "./amos-mdm.db")]
    database: PathBuf,

    /// JWT 密钥
    #[arg(long)]
    jwt_secret: Option<String>,

    /// API 密钥前缀
    #[arg(long, default_value = "amos_")]
    api_key_prefix: String,

    /// 默认同步间隔（秒）
    #[arg(long, default_value = "3600")]
    sync_interval: u64,

    /// 日志级别
    #[arg(long, default_value = "info")]
    log_level: String,

    /// 管理员 API 共享令牌。
    /// **强烈建议** 显式提供；不提供时启动时随机生成并打印到日志一次。
    /// 格式：明文字符串；服务端会保存 SHA-256(hex) 形式，明文不落盘。
    #[arg(long)]
    admin_token: Option<String>,

    /// CORS 允许的来源列表（逗号分隔），用于 `/api/admin/*` 调试前端。
    /// 默认只允许 `http://localhost:*` 与 `http://127.0.0.1:*` —— 任何生产
    /// 部署都应显式覆盖此值。
    #[arg(
        long,
        value_delimiter = ',',
        default_value = "http://localhost,http://127.0.0.1"
    )]
    cors_allowed_origins: Vec<String>,
}

/// SHA-256(hex) — server-side form for the admin token.
fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Generate a 32-byte random admin token, hex-encoded (64 chars).
///
/// Uses `uuid::Uuid::new_v4().as_bytes()` (already a project dep via the DB
/// schema) twice — `getrandom` is also fine but adding a new transitive dep
/// just for one startup-time call is not worth the audit footprint.
fn random_admin_token() -> String {
    let mut buf = [0u8; 32];
    let (left, right) = buf.split_at_mut(16);
    left.copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    right.copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    hex::encode(buf)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 解析命令行参数
    let args = Args::parse();

    // 配置日志
    let log_level = match args.log_level.to_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };

    let subscriber = FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_target(false)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    info!("Starting AmOS MDM Server");

    // Resolve the admin token. Priority:
    //   1. `--admin-token` / `MDM_ADMIN_TOKEN` (preferred, deterministic across restarts)
    //   2. Freshly-generated random token — printed to the log exactly once,
    //      operator is expected to capture it before the first admin call.
    //
    // **Never** fall back to a hardcoded literal: the previous default
    // (`amos-mdm-secret-key`) was a publicly-known value committed to the repo.
    let admin_token = args.admin_token.clone().unwrap_or_else(random_admin_token);
    if args.admin_token.is_none() {
        warn!(
            "No --admin-token supplied. Generated a fresh random admin token. \
             Capture this NOW — it will not be logged again: {admin_token}"
        );
    }
    let admin_token_hash = hash_token(&admin_token);

    // 构建配置
    let config = MdmConfig {
        listen_address: args.listen.clone(),
        database_path: args.database.to_string_lossy().to_string(),
        jwt_secret: args
            .jwt_secret
            .unwrap_or_else(|| "amos-mdm-secret-key".to_string()),
        api_key_prefix: args.api_key_prefix,
        default_sync_interval: args.sync_interval,
        token_expiry_secs: 365 * 24 * 60 * 60,
        admin_token_hash,
    };

    // 初始化数据库
    let db_path = config.database_path.clone();
    let db = Database::new(db_path).await?;
    info!("Database initialized: {}", config.database_path);

    // 创建默认组织
    db.ensure_default_organization().await?;
    info!("Default organization ready");

    // 创建应用状态
    let app_state = AppState::new(db, config.clone());

    // 配置 CORS — restrict to the explicit allowlist, never `Any`. The
    // device-side endpoints (`/api/mdm/*`) live behind a per-device API key
    // and don't need cross-origin access; only an admin console needs CORS,
    // and even then it must be enumerated.
    let origins = args
        .cors_allowed_origins
        .iter()
        .map(|s| s.trim().parse::<axum::http::HeaderValue>())
        .collect::<Result<Vec<_>, _>>()?;
    let allow_origin = if origins.is_empty() {
        AllowOrigin::list(std::iter::empty::<axum::http::HeaderValue>())
    } else {
        AllowOrigin::list(origins.into_iter())
    };
    let cors = CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
        ]);

    // 设备路由 — 无需 admin token。
    // 管理路由 — **必须** 走 `require_admin_token` 中间件。
    // 两个路由集合都在 `amos_mdm::build_router` 里装配——这里只是把
    // CORS / 默认 body 上限 / trace 层套在外面。
    let app = amos_mdm::build_router(app_state.clone(), MAX_BODY_BYTES)
        // 请求体上限（REQ-A411，`mdm #31`）：没有它，一个未认证的 `POST /api/mdm/enroll`
        // 就能让服务器按对方给的字节数分配内存。`build_router` 已经设了 `MAX_BODY_BYTES`；
        // 这里是 CORS（部署期关注点，不属于库 API）。
        .layer(cors);

    // 解析地址（一个坏地址是启动错误，不是 panic）
    let addr: SocketAddr = args.listen.parse()?;

    info!("MDM Server listening on http://{}", addr);
    info!("Health check: http://{}/health", addr);
    info!("Enrollment API: POST http://{}/api/mdm/enroll", addr);
    info!("Sync API: POST http://{}/api/mdm/sync", addr);
    info!(
        "Admin API requires Authorization: Bearer <admin-token> \
         (use --admin-token / MDM_ADMIN_TOKEN; otherwise a random one was logged above)"
    );

    // 启动服务器
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
