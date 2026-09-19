//! 数据库操作模块（异步版）

use std::path::Path;
use std::sync::Arc;

use rusqlite::{params, Connection, TransactionBehavior};
use tokio::sync::Mutex;

use crate::config::MdmConfig;
use crate::error::MdmError;
use crate::models::*;

/// Hard ceiling on any list endpoint's page size (REQ-A411, `mdm #32`).
///
/// The admin endpoints are token-authenticated, but a *page* is still a resource: with no ceiling
/// one request reads the whole table, so a caller can make the server allocate and serialise an
/// unbounded number of rows. 500 is far above any console page and small enough that one response
/// is bounded by construction.
pub const MAX_LIST_ROWS: u32 = 500;

/// The page size a caller gets when it does not ask for one.
pub const DEFAULT_LIST_LIMIT: u32 = 100;

/// Validate a caller-supplied page window into `(limit, offset)`.
///
/// Out-of-range is **refused** (`MdmError::InvalidRequest` → 400) rather than clamped: a clamped
/// page silently answers a different question than the one asked, and the caller can only paginate
/// correctly if the server tells it what it got (the response echoes the applied window). The
/// database methods clamp to [`MAX_LIST_ROWS`] as well — that is the last line of defence, not the
/// contract.
/// The last line of defence for a page window: never hand SQLite a zero-size or oversized page
/// whatever the caller passed (the API layer refuses those with a 400 — see [`check_page`]).
fn clamp_list_limit(limit: u32) -> u32 {
    limit.clamp(1, MAX_LIST_ROWS)
}

pub fn check_page(limit: Option<u32>, offset: Option<u32>) -> Result<(u32, u32), MdmError> {
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT);
    if limit == 0 || limit > MAX_LIST_ROWS {
        return Err(MdmError::InvalidRequest(format!(
            "limit must be 1..={MAX_LIST_ROWS}, got {limit}"
        )));
    }
    Ok((limit, offset.unwrap_or(0)))
}

/// Everything one enrollment carries in. The ids and timestamps are minted **inside** the
/// transaction, so a caller cannot inject a stale `now` or a pre-chosen row id.
pub struct EnrollParams<'a> {
    pub organization_id: &'a str,
    /// The one-time enrollment token presented by the device (untrusted input).
    pub enrollment_token: &'a str,
    pub device_id: &'a str,
    pub device_name: &'a str,
    pub platform: &'a str,
    pub user_agent: &'a str,
    /// Who enrolled it (the organization's admin email), recorded on the device row.
    pub enrolled_by: Option<&'a str>,
}

/// What one successful enrollment produced: the device row and its **one-time** API key (the only
/// moment the raw key exists — the database stores a SHA-256 of it).
#[derive(Debug, Clone)]
pub struct EnrolledDevice {
    pub device: Device,
    pub api_key: String,
}

/// 数据库包装器（使用 Arc<Mutex<Connection>> 支持异步共享）
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// 创建新数据库连接
    pub async fn new<P: AsRef<Path> + Send + 'static>(path: P) -> Result<Self, MdmError> {
        let conn = tokio::task::spawn_blocking(move || -> Result<Connection, rusqlite::Error> {
            let conn = Connection::open(path)?;
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
            Ok(conn)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_tables().await?;
        Ok(db)
    }

    /// Open a fresh, in-memory database, fully schema-initialized.
    /// Intended for **tests only** — production code uses `new(path)`.
    ///
    /// REQ-A411: tests that exercise the admin/auth middleware need a
    /// `Database` value (because `AppState` requires one) but must not
    /// touch the on-disk database file. This constructor is the only
    /// sanctioned way to get one.
    ///
    /// `async` on purpose: the underlying connection is guarded by a
    /// `tokio::sync::Mutex`, so the schema initialization must run via
    /// `spawn_blocking` + `blocking_lock`, exactly like `new`.
    ///
    /// `allow(clippy::panic)`: test fixtures have no `Result`-typed
    /// caller, so a panicking init is the cleanest failure mode. The
    /// crate-level deny-lint forbids this everywhere else.
    #[cfg(any(test, feature = "test-helpers"))]
    #[allow(clippy::panic)]
    pub async fn open_in_memory_for_tests() -> Self {
        let db = Self::open_in_memory_raw_for_tests();
        if let Err(e) = db.init_tables().await {
            // `init_tables` failures in a test fixture mean the in-memory
            // schema cannot be created — propagate as a panic, since
            // there is no `Result`-typed caller in test code. We do not
            // use `.expect()` here because the crate-level `deny` forbids
            // it on non-test items; this path is `#[cfg(feature = "test-helpers")]`, but we
            // keep the pattern explicit anyway.
            panic!("init_tables on in-memory DB failed: {e}");
        }
        db
    }

    /// Sync half of `open_in_memory_for_tests`: open the SQLite handle
    /// without initializing the schema. Splitting it out lets the test
    /// helper build the `AppState` synchronously, then have the test
    /// (which is `#[tokio::test]`) call `init_tables().await` once.
    ///
    /// `allow(clippy::panic)`: see `open_in_memory_for_tests`.
    #[cfg(any(test, feature = "test-helpers"))]
    #[allow(clippy::panic)]
    fn open_in_memory_raw_for_tests() -> Self {
        // `Connection::open_in_memory` is sync and infallible under
        // normal conditions; if it fails we panic because there is no
        // recovery path in a test fixture.
        let conn = match Connection::open_in_memory() {
            Ok(c) => c,
            Err(e) => panic!("open_in_memory failed: {e}"),
        };
        if let Err(e) = conn.execute_batch("PRAGMA foreign_keys=ON;") {
            panic!("set pragmas on in-memory DB failed: {e}");
        }
        Self {
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    /// Insert a fixed-value enrollment token for integration tests.
    ///
    /// Production code uses `create_token`, which generates a random
    /// UUID token. Tests need a **known** token so they can pass it in
    /// the enroll request body. `#[cfg(feature = "test-helpers")]`-only.
    #[cfg(any(test, feature = "test-helpers"))]
    pub async fn seed_enrollment_token_for_test(
        &self,
        token: &str,
        org_id: &str,
        expires_at_ms: i64,
    ) -> Result<(), MdmError> {
        let now = chrono::Utc::now().timestamp_millis();
        let id = uuid::Uuid::new_v4().to_string();
        let token = token.to_string();
        let org_id = org_id.to_string();
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            conn.execute(
                "INSERT INTO enrollment_tokens (id, token, organization_id, used, expires_at, created_at)
                 VALUES (?, ?, ?, 0, ?, ?)",
                rusqlite::params![id, token, org_id, expires_at_ms, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(())
    }

    /// 初始化数据库表
    async fn init_tables(&self) -> Result<(), MdmError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS organizations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    admin_email TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS enrollment_tokens (
                    id TEXT PRIMARY KEY,
                    token TEXT NOT NULL UNIQUE,
                    organization_id TEXT NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0,
                    used_by_device_id TEXT,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (organization_id) REFERENCES organizations(id)
                );
                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY,
                    organization_id TEXT NOT NULL,
                    device_id TEXT NOT NULL UNIQUE,
                    device_name TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    user_agent TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    enrolled_at INTEGER NOT NULL,
                    last_sync_at INTEGER NOT NULL DEFAULT 0,
                    enrolled_by TEXT,
                    lock_message TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY (organization_id) REFERENCES organizations(id)
                );
                CREATE TABLE IF NOT EXISTS policies (
                    id TEXT PRIMARY KEY,
                    organization_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    config TEXT NOT NULL DEFAULT '{}',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    priority INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY (organization_id) REFERENCES organizations(id)
                );
                CREATE TABLE IF NOT EXISTS remote_commands (
                    id TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    payload TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at INTEGER NOT NULL,
                    executed_at INTEGER,
                    result TEXT,
                    FOREIGN KEY (device_id) REFERENCES devices(device_id)
                );
                CREATE TABLE IF NOT EXISTS api_keys (
                    id TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL UNIQUE,
                    key_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER,
                    FOREIGN KEY (device_id) REFERENCES devices(device_id)
                );
                CREATE INDEX IF NOT EXISTS idx_devices_org ON devices(organization_id);
                CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);
                CREATE INDEX IF NOT EXISTS idx_policies_org ON policies(organization_id);
                CREATE INDEX IF NOT EXISTS idx_commands_device ON remote_commands(device_id);
                CREATE INDEX IF NOT EXISTS idx_tokens_token ON enrollment_tokens(token);
                "#,
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(())
    }

    /// 确保存在默认组织
    pub async fn ensure_default_organization(&self) -> Result<(), MdmError> {
        let conn = self.conn.clone();
        let org_id =
            tokio::task::spawn_blocking(move || -> Result<Option<String>, rusqlite::Error> {
                let conn = conn.blocking_lock();
                let count: i64 =
                    conn.query_row("SELECT COUNT(*) FROM organizations", [], |row| row.get(0))?;
                if count == 0 {
                    Ok(Some(uuid::Uuid::new_v4().to_string()))
                } else {
                    Ok(None)
                }
            })
            .await
            .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
            .map_err(MdmError::Database)?;

        if let Some(org_id) = org_id {
            self.create_default_organization(&org_id).await?;
            tracing::info!("Created default organization: {}", org_id);
        }
        Ok(())
    }

    async fn create_default_organization(&self, org_id: &str) -> Result<(), MdmError> {
        let now = chrono::Utc::now().timestamp_millis();
        let org_id_owned = org_id.to_string();
        let conn = self.conn.clone();

        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            conn.execute(
                "INSERT INTO organizations (id, name, admin_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                params![org_id_owned, "AmOS Enterprise", "admin@amos.local", now, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;

        self.create_default_policies(org_id).await?;
        self.create_default_enrollment_token(org_id).await?;
        Ok(())
    }

    async fn create_default_policies(&self, org_id: &str) -> Result<(), MdmError> {
        let now = chrono::Utc::now().timestamp_millis();
        let org_id_owned = org_id.to_string();
        let conn = self.conn.clone();

        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            let policies = vec![
                ("execution_limit", "默认执行限制", r#"{"maxExecutionTime":300,"maxExecutionsPerDay":1000}"#),
                ("sharing_control", "默认分享控制", r#"{"allowSharing":true}"#),
            ];
            for (policy_type, name, config) in policies {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO policies (id, organization_id, type, name, description, config, enabled, priority, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![id, org_id_owned, policy_type, name, "", config, 1, 0, now, now],
                )?;
            }
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;

        tracing::info!("Created default policies");
        Ok(())
    }

    async fn create_default_enrollment_token(&self, org_id: &str) -> Result<String, MdmError> {
        let now = chrono::Utc::now().timestamp_millis();
        let one_week = 7 * 24 * 60 * 60 * 1000;
        let org_id_owned = org_id.to_string();
        let conn = self.conn.clone();

        // Generate a fresh random token. The previous hard-coded literal
        // (`AMOS-ENROLL-TOKEN-2024`) was committed to git; anyone with the
        // README could enroll a device on any default-config instance. We
        // still print the new value **once** to the log so the operator can
        // capture it before any enrollment attempt.
        let token = format!(
            "AMOS-ENROLL-{}",
            hex::encode(uuid::Uuid::new_v4().as_bytes())
        );

        let token_for_log = token.clone();
        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO enrollment_tokens (id, token, organization_id, used, expires_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![id, token, org_id_owned, 0, now + one_week, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;

        tracing::info!(
            "Created default enrollment token (capture this NOW, will not be logged again): {}",
            token_for_log
        );
        Ok(token_for_log)
    }

    // ========================================================================
    // 组织操作
    // ========================================================================

    pub async fn get_organization(&self, id: &str) -> Result<Option<Organization>, MdmError> {
        let id = id.to_string();
        let conn = self.conn.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<Option<Organization>, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let mut stmt = conn.prepare(
                "SELECT id, name, admin_email, created_at, updated_at FROM organizations WHERE id = ?"
            )?;
            let org = stmt.query_row(params![id], |row| {
                Ok(Organization {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    admin_email: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            }).optional()?;
            Ok(org)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(result)
    }

    pub async fn get_default_organization(&self) -> Result<Organization, MdmError> {
        let conn = self.conn.clone();
        let result =
            tokio::task::spawn_blocking(move || -> Result<Organization, rusqlite::Error> {
                let conn = conn.blocking_lock();
                let mut stmt = conn.prepare(
                "SELECT id, name, admin_email, created_at, updated_at FROM organizations LIMIT 1"
            )?;
                stmt.query_row([], |row| {
                    Ok(Organization {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        admin_email: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                })
            })
            .await
            .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
            .map_err(MdmError::Database)?;
        Ok(result)
    }

    // ========================================================================
    // 注册令牌操作
    // ========================================================================

    pub async fn get_enrollment_token(
        &self,
        token: &str,
    ) -> Result<Option<EnrollmentToken>, MdmError> {
        let token = token.to_string();
        let conn = self.conn.clone();
        let result = tokio::task::spawn_blocking(
            move || -> Result<Option<EnrollmentToken>, rusqlite::Error> {
                let conn = conn.blocking_lock();
                let mut stmt = conn.prepare(
                "SELECT id, token, organization_id, used, used_by_device_id, expires_at, created_at 
                 FROM enrollment_tokens WHERE token = ?"
            )?;
                let token_row = stmt
                    .query_row(params![token], |row| {
                        Ok(EnrollmentToken {
                            id: row.get(0)?,
                            token: row.get(1)?,
                            organization_id: row.get(2)?,
                            used: row.get::<_, i32>(3)? != 0,
                            used_by_device_id: row.get(4)?,
                            expires_at: row.get(5)?,
                            created_at: row.get(6)?,
                        })
                    })
                    .optional()?;
                Ok(token_row)
            },
        )
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(result)
    }

    /// Refuse a token whose claim cannot succeed, and say which of the two reasons it was.
    fn why_the_claim_failed(
        tx: &rusqlite::Transaction<'_>,
        token: &str,
        now_ms: i64,
    ) -> Result<MdmError, rusqlite::Error> {
        let row: Option<(i32, i64)> = tx
            .query_row(
                "SELECT used, expires_at FROM enrollment_tokens WHERE token = ?",
                params![token],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((used, _)) if used != 0 => MdmError::TokenAlreadyUsed,
            Some((_, expires_at)) if expires_at < now_ms => MdmError::InvalidToken,
            // A row that exists, is unused and is unexpired cannot reach here (the claim would have
            // matched it): report the least specific refusal rather than inventing a reason.
            _ => MdmError::InvalidToken,
        })
    }

    /// A device whose `device_id` is already taken is a *refused enrollment*, not a 500.
    fn map_device_insert_error(e: rusqlite::Error) -> MdmError {
        if let rusqlite::Error::SqliteFailure(err, _) = &e {
            if err.code == rusqlite::ErrorCode::ConstraintViolation {
                return MdmError::DeviceAlreadyEnrolled;
            }
        }
        MdmError::Database(e)
    }

    /// Enroll one device — claim the token, insert the device, mint its API key — **in one
    /// transaction** (REQ-A411, `mdm #12–#14`).
    ///
    /// The shape this replaced read the token, checked `used`, **then** marked it used, **then**
    /// inserted the device, **then** minted the key — and **discarded the result of the "mark
    /// used" UPDATE**. Two concurrent enrollments with one token both passed the check, so a single
    /// enrollment token could enroll more than one device; and a failure between the device insert
    /// and the key insert left a device that could never authenticate. The claim is now one
    /// conditional `UPDATE … WHERE used = 0 AND expires_at >= ?`: exactly one caller sees
    /// `rows == 1`, and every later step rolls back with it when it fails.
    ///
    /// `now_ms` is a parameter (not a `Utc::now()` inside) so a test can enroll "in the past" and
    /// prove the expiry is enforced by the same statement that claims the token.
    pub async fn enroll_device(
        &self,
        params: EnrollParams<'_>,
        config: &MdmConfig,
        now_ms: i64,
    ) -> Result<EnrolledDevice, MdmError> {
        let EnrollParams {
            organization_id,
            enrollment_token,
            device_id,
            device_name,
            platform,
            user_agent,
            enrolled_by,
        } = params;

        let row_id = uuid::Uuid::new_v4().to_string();
        let key_row_id = uuid::Uuid::new_v4().to_string();
        let api_key = format!(
            "{}{}",
            config.api_key_prefix,
            uuid::Uuid::new_v4().to_string().replace('-', "")
        );
        let key_hash = Self::hash_key(&api_key);

        let organization_id = organization_id.to_string();
        let enrollment_token = enrollment_token.to_string();
        let device_id = device_id.to_string();
        let device_name = device_name.to_string();
        let platform = platform.to_string();
        let user_agent = user_agent.to_string();
        let enrolled_by = enrolled_by.map(str::to_string);
        let conn = self.conn.clone();

        let result = tokio::task::spawn_blocking(move || -> Result<EnrolledDevice, MdmError> {
            let mut conn = conn.blocking_lock();
            // `Immediate` takes the write lock up front: the transaction's first statement is an
            // UPDATE, so a deferred transaction would only try to upgrade later and a busy-timeout
            // failure would surface as a confusing `SQLITE_BUSY` on the second statement.
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            // ① The claim. This one conditional UPDATE *is* the mutual exclusion — there is no
            // read-then-write window left for a second enrollment to slip through.
            let claimed = tx.execute(
                "UPDATE enrollment_tokens SET used = 1, used_by_device_id = ?
                 WHERE token = ? AND used = 0 AND expires_at >= ?",
                params![device_id, enrollment_token, now_ms],
            )?;
            if claimed == 0 {
                // Say *why*: an already-used token (409) and an unknown/expired one (401) are
                // different answers, and only one of them is worth retrying with a fresh token.
                return Err(Self::why_the_claim_failed(&tx, &enrollment_token, now_ms)?);
            }
            // ② The device. `device_id` is UNIQUE, so re-enrolling the same device is a constraint
            // violation — and the `?` below must roll the claim back, or a *refused* device would
            // burn the enrollment token. Pinned by `a_refused_device_does_not_burn_the_token`.
            tx.execute(
                "INSERT INTO devices (id, organization_id, device_id, device_name, platform, user_agent, status, enrolled_at, last_sync_at, enrolled_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    row_id, organization_id, device_id, device_name, platform, user_agent,
                    "active", now_ms, now_ms, enrolled_by, now_ms, now_ms
                ],
            )
            .map_err(Self::map_device_insert_error)?;

            // ③ The key. Same transaction, so a device row can never exist without one.
            tx.execute(
                "INSERT INTO api_keys (id, device_id, key_hash, created_at) VALUES (?, ?, ?, ?)",
                params![key_row_id, device_id, key_hash, now_ms],
            )?;

            tx.commit()?;

            Ok(EnrolledDevice {
                device: Device {
                    id: row_id,
                    organization_id,
                    device_id,
                    device_name,
                    platform,
                    user_agent,
                    status: DeviceStatus::Active,
                    enrolled_at: now_ms,
                    last_sync_at: now_ms,
                    enrolled_by,
                    lock_message: None,
                    created_at: now_ms,
                    updated_at: now_ms,
                },
                api_key,
            })
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?;
        result
    }

    pub async fn list_tokens(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<EnrollmentToken>, MdmError> {
        let limit = clamp_list_limit(limit);
        let conn = self.conn.clone();
        let result = tokio::task::spawn_blocking(
            move || -> Result<Vec<EnrollmentToken>, rusqlite::Error> {
                let conn = conn.blocking_lock();
                let mut stmt = conn.prepare(
                "SELECT id, token, organization_id, used, used_by_device_id, expires_at, created_at 
                 FROM enrollment_tokens ORDER BY created_at DESC LIMIT ? OFFSET ?"
            )?;
                let tokens = stmt
                    .query_map(params![limit, offset], |row| {
                        Ok(EnrollmentToken {
                            id: row.get(0)?,
                            token: row.get(1)?,
                            organization_id: row.get(2)?,
                            used: row.get::<_, i32>(3)? != 0,
                            used_by_device_id: row.get(4)?,
                            expires_at: row.get(5)?,
                            created_at: row.get(6)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(tokens)
            },
        )
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(result)
    }

    pub async fn create_token(
        &self,
        org_id: &str,
        expires_in_ms: i64,
    ) -> Result<EnrollmentToken, MdmError> {
        let now = chrono::Utc::now().timestamp_millis();
        let id = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4()
            .to_string()
            .to_uppercase()
            .replace("-", "");
        let org_id_owned = org_id.to_string();
        let token_clone = token.clone();
        let id_clone = id.clone();
        let conn = self.conn.clone();

        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            conn.execute(
                "INSERT INTO enrollment_tokens (id, token, organization_id, used, expires_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![id_clone, token_clone, org_id_owned, 0, now + expires_in_ms, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;

        Ok(EnrollmentToken {
            id,
            token,
            organization_id: org_id.to_string(),
            used: false,
            used_by_device_id: None,
            expires_at: now + expires_in_ms,
            created_at: now,
        })
    }

    // ========================================================================
    // 设备操作
    // ========================================================================

    pub async fn get_device(&self, device_id: &str) -> Result<Option<Device>, MdmError> {
        let device_id = device_id.to_string();
        let conn = self.conn.clone();
        let result =
            tokio::task::spawn_blocking(move || -> Result<Option<Device>, rusqlite::Error> {
                let conn = conn.blocking_lock();
                let mut stmt = conn.prepare(
                "SELECT id, organization_id, device_id, device_name, platform, user_agent, status,
                        enrolled_at, last_sync_at, enrolled_by, lock_message, created_at, updated_at
                 FROM devices WHERE device_id = ?"
            )?;
                let device = stmt
                    .query_row(params![device_id], |row| {
                        Ok(Device {
                            id: row.get(0)?,
                            organization_id: row.get(1)?,
                            device_id: row.get(2)?,
                            device_name: row.get(3)?,
                            platform: row.get(4)?,
                            user_agent: row.get(5)?,
                            status: DeviceStatus::from(row.get::<_, String>(6)?.as_str()),
                            enrolled_at: row.get(7)?,
                            last_sync_at: row.get(8)?,
                            enrolled_by: row.get(9)?,
                            lock_message: row.get(10)?,
                            created_at: row.get(11)?,
                            updated_at: row.get(12)?,
                        })
                    })
                    .optional()?;
                Ok(device)
            })
            .await
            .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
            .map_err(MdmError::Database)?;
        Ok(result)
    }

    pub async fn list_devices(
        &self,
        org_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Device>, MdmError> {
        let limit = clamp_list_limit(limit);
        let org_id = org_id.to_string();
        let conn = self.conn.clone();
        let result =
            tokio::task::spawn_blocking(move || -> Result<Vec<Device>, rusqlite::Error> {
                let conn = conn.blocking_lock();
                let mut stmt = conn.prepare(
                "SELECT id, organization_id, device_id, device_name, platform, user_agent, status,
                        enrolled_at, last_sync_at, enrolled_by, lock_message, created_at, updated_at
                 FROM devices WHERE organization_id = ? ORDER BY enrolled_at DESC LIMIT ? OFFSET ?"
            )?;
                let devices = stmt
                    .query_map(params![org_id, limit, offset], |row| {
                        Ok(Device {
                            id: row.get(0)?,
                            organization_id: row.get(1)?,
                            device_id: row.get(2)?,
                            device_name: row.get(3)?,
                            platform: row.get(4)?,
                            user_agent: row.get(5)?,
                            status: DeviceStatus::from(row.get::<_, String>(6)?.as_str()),
                            enrolled_at: row.get(7)?,
                            last_sync_at: row.get(8)?,
                            enrolled_by: row.get(9)?,
                            lock_message: row.get(10)?,
                            created_at: row.get(11)?,
                            updated_at: row.get(12)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(devices)
            })
            .await
            .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
            .map_err(MdmError::Database)?;
        Ok(result)
    }

    pub async fn update_device_sync(&self, device_id: &str) -> Result<(), MdmError> {
        let device_id = device_id.to_string();
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "UPDATE devices SET last_sync_at = ?, updated_at = ? WHERE device_id = ?",
                params![now, now, device_id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(())
    }

    pub async fn update_device_status(
        &self,
        device_id: &str,
        status: &DeviceStatus,
        lock_message: Option<&str>,
    ) -> Result<(), MdmError> {
        let device_id = device_id.to_string();
        let status_str = status.to_string();
        let lock_message_owned = lock_message.map(String::from);
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "UPDATE devices SET status = ?, lock_message = ?, updated_at = ? WHERE device_id = ?",
                params![status_str, lock_message_owned, now, device_id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(())
    }

    pub async fn delete_device(&self, device_id: &str) -> Result<bool, MdmError> {
        let device_id = device_id.to_string();
        let conn = self.conn.clone();
        // 一个 `delete_device` 必须把设备"扫干净"——`devices` 表上
        // `device_id` 是 `UNIQUE`，但 `api_keys` / `remote_commands` 是
        // 单独挂的 FK（`ON DELETE` 默认是 `NO ACTION`），所以光 `DELETE FROM devices`
        // 会留下孤儿记录。FK 已经声明但 SQLite 默认不开 `ON DELETE CASCADE`，
        // 这里显式先删从表、再删主表。
        let rows = tokio::task::spawn_blocking(move || -> Result<usize, rusqlite::Error> {
            let conn = conn.blocking_lock();
            conn.execute(
                "DELETE FROM api_keys WHERE device_id = ?",
                params![device_id],
            )?;
            conn.execute(
                "DELETE FROM remote_commands WHERE device_id = ?",
                params![device_id],
            )?;
            let rows = conn.execute(
                "DELETE FROM devices WHERE device_id = ?",
                params![device_id],
            )?;
            Ok(rows)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(rows > 0)
    }

    /// 撤销某设备的所有 pending 命令（lock/wipe 在设备未 sync 之前只走
    /// 这一条路径清理；状态机的"撤销"语义必须显式，而不是悄悄让
    /// ack 端把 `status='cancelled'` 当成"成功"——参见 `cancel_pending_commands`
    /// 的同义实现 `fail_pending_commands`）。
    pub async fn cancel_pending_commands(&self, device_id: &str) -> Result<usize, MdmError> {
        let device_id = device_id.to_string();
        let conn = self.conn.clone();
        let rows = tokio::task::spawn_blocking(move || -> Result<usize, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let now = chrono::Utc::now().timestamp_millis();
            let rows = conn.execute(
                "UPDATE remote_commands SET status = 'cancelled', executed_at = ?, result = 'cancelled_by_server' WHERE device_id = ? AND status = 'pending'",
                params![now, device_id],
            )?;
            Ok(rows)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(rows)
    }

    // ========================================================================
    // API 密钥操作
    // ========================================================================

    pub async fn validate_api_key(&self, device_id: &str, api_key: &str) -> Result<bool, MdmError> {
        let key_hash = Self::hash_key(api_key);
        let device_id_for_query = device_id.to_string();
        let key_hash_owned = key_hash.clone();
        let conn = self.conn.clone();

        let exists: Option<String> =
            tokio::task::spawn_blocking(move || -> Result<Option<String>, rusqlite::Error> {
                let conn = conn.blocking_lock();
                let mut stmt =
                    conn.prepare("SELECT id FROM api_keys WHERE device_id = ? AND key_hash = ?")?;
                let exists: Option<String> = stmt
                    .query_row(params![device_id_for_query, key_hash_owned], |row| {
                        row.get(0)
                    })
                    .optional()?;
                Ok(exists)
            })
            .await
            .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
            .map_err(MdmError::Database)?;

        if exists.is_some() {
            let device_id_owned = device_id.to_string();
            let conn = self.conn.clone();
            tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
                let conn = conn.blocking_lock();
                let now = chrono::Utc::now().timestamp_millis();
                conn.execute(
                    "UPDATE api_keys SET last_used_at = ? WHERE device_id = ? AND key_hash = ?",
                    params![now, device_id_owned, key_hash],
                )?;
                Ok(())
            })
            .await
            .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
            .map_err(MdmError::Database)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn hash_key(key: &str) -> String {
        // SHA-256 is the minimum acceptable hash for a stored API key: deterministic
        // across process restarts (DefaultHasher is randomised, see `std::collections`),
        // and gives a 64-hex-char footprint that fits the existing schema column.
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(key.as_bytes());
        hex::encode(digest)
    }

    // ========================================================================
    // 策略操作
    // ========================================================================

    pub async fn get_policies(
        &self,
        org_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Policy>, MdmError> {
        let limit = clamp_list_limit(limit);
        let org_id = org_id.to_string();
        let conn = self.conn.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<Vec<Policy>, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let mut stmt = conn.prepare(
                "SELECT id, organization_id, type, name, description, config, enabled, priority, created_at, updated_at
                 FROM policies WHERE organization_id = ? ORDER BY priority DESC LIMIT ? OFFSET ?"
            )?;
            let policies = stmt.query_map(params![org_id, limit, offset], |row| {
                let config_str: String = row.get(5)?;
                let config = serde_json::from_str(&config_str).unwrap_or_else(|_| serde_json::Value::Object(Default::default()));
                Ok(Policy {
                    id: row.get(0)?,
                    organization_id: row.get(1)?,
                    policy_type: row.get(2)?,
                    name: row.get(3)?,
                    description: row.get(4)?,
                    config,
                    enabled: row.get::<_, i32>(6)? != 0,
                    priority: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
            Ok(policies)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(result)
    }

    pub async fn get_policy(&self, id: &str) -> Result<Option<Policy>, MdmError> {
        let id = id.to_string();
        let conn = self.conn.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<Option<Policy>, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let mut stmt = conn.prepare(
                "SELECT id, organization_id, type, name, description, config, enabled, priority, created_at, updated_at
                 FROM policies WHERE id = ?"
            )?;
            let policy = stmt.query_row(params![id], |row| {
                let config_str: String = row.get(5)?;
                let config = serde_json::from_str(&config_str).unwrap_or_else(|_| serde_json::Value::Object(Default::default()));
                Ok(Policy {
                    id: row.get(0)?,
                    organization_id: row.get(1)?,
                    policy_type: row.get(2)?,
                    name: row.get(3)?,
                    description: row.get(4)?,
                    config,
                    enabled: row.get::<_, i32>(6)? != 0,
                    priority: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            }).optional()?;
            Ok(policy)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(result)
    }

    pub async fn create_policy(
        &self,
        org_id: &str,
        policy_type: &str,
        name: &str,
        description: Option<&str>,
        config: &serde_json::Value,
        priority: i32,
    ) -> Result<Policy, MdmError> {
        let now = chrono::Utc::now().timestamp_millis();
        let id = uuid::Uuid::new_v4().to_string();
        let config_str = serde_json::to_string(config).unwrap_or_default();

        let org_id_owned = org_id.to_string();
        let policy_type_owned = policy_type.to_string();
        let name_owned = name.to_string();
        let description_owned = description.map(String::from);
        let id_owned = id.clone();
        let conn = self.conn.clone();

        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            conn.execute(
                "INSERT INTO policies (id, organization_id, type, name, description, config, enabled, priority, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![id_owned, org_id_owned, policy_type_owned, name_owned, description_owned, config_str, 1, priority, now, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;

        Ok(Policy {
            id,
            organization_id: org_id.to_string(),
            policy_type: policy_type.to_string(),
            name: name.to_string(),
            description: description.map(String::from),
            config: config.clone(),
            enabled: true,
            priority,
            created_at: now,
            updated_at: now,
        })
    }

    pub async fn update_policy(
        &self,
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
        config: Option<&serde_json::Value>,
        enabled: Option<bool>,
        priority: Option<i32>,
    ) -> Result<bool, MdmError> {
        let now = chrono::Utc::now().timestamp_millis();

        // 构建 SQL
        let mut updates = vec!["updated_at = ?".to_string()];
        let mut values: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Integer(now)];

        if let Some(n) = name {
            updates.push("name = ?".to_string());
            values.push(rusqlite::types::Value::Text(n.to_string()));
        }
        if let Some(d) = description {
            updates.push("description = ?".to_string());
            values.push(rusqlite::types::Value::Text(d.to_string()));
        }
        if let Some(c) = config {
            updates.push("config = ?".to_string());
            values.push(rusqlite::types::Value::Text(
                serde_json::to_string(c).unwrap_or_default(),
            ));
        }
        if let Some(e) = enabled {
            updates.push("enabled = ?".to_string());
            values.push(rusqlite::types::Value::Integer(if e { 1 } else { 0 }));
        }
        if let Some(p) = priority {
            updates.push("priority = ?".to_string());
            values.push(rusqlite::types::Value::Integer(p as i64));
        }

        let id_owned = id.to_string();
        values.push(rusqlite::types::Value::Text(id_owned));

        let sql = format!("UPDATE policies SET {} WHERE id = ?", updates.join(", "));
        let conn = self.conn.clone();
        let rows = tokio::task::spawn_blocking(move || -> Result<usize, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let rows = conn.execute(&sql, rusqlite::params_from_iter(values))?;
            Ok(rows)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(rows > 0)
    }

    pub async fn delete_policy(&self, id: &str) -> Result<bool, MdmError> {
        let id = id.to_string();
        let conn = self.conn.clone();
        let rows = tokio::task::spawn_blocking(move || -> Result<usize, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let rows = conn.execute("DELETE FROM policies WHERE id = ?", params![id])?;
            Ok(rows)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(rows > 0)
    }

    // ========================================================================
    // 远程命令操作
    // ========================================================================

    pub async fn create_command(
        &self,
        device_id: &str,
        command_type: &str,
        payload: Option<&serde_json::Value>,
    ) -> Result<RemoteCommand, MdmError> {
        let now = chrono::Utc::now().timestamp_millis();
        let id = uuid::Uuid::new_v4().to_string();
        let payload_str = payload.map(|p| serde_json::to_string(p).unwrap_or_default());

        let id_owned = id.clone();
        let device_id_owned = device_id.to_string();
        let command_type_owned = command_type.to_string();
        let payload_owned = payload_str.clone();
        let conn = self.conn.clone();

        tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
            let conn = conn.blocking_lock();
            conn.execute(
                "INSERT INTO remote_commands (id, device_id, type, payload, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![
                    id_owned,
                    device_id_owned,
                    command_type_owned,
                    payload_owned,
                    "pending",
                    now
                ],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;

        Ok(RemoteCommand {
            id,
            device_id: device_id.to_string(),
            command_type: CommandType::from(command_type),
            payload: payload.cloned(),
            status: "pending".to_string(),
            created_at: now,
            executed_at: None,
            result: None,
        })
    }

    pub async fn get_pending_commands(
        &self,
        device_id: &str,
        limit: u32,
    ) -> Result<Vec<RemoteCommand>, MdmError> {
        let limit = clamp_list_limit(limit);
        let device_id = device_id.to_string();
        let conn = self.conn.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<Vec<RemoteCommand>, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let mut stmt = conn.prepare(
                "SELECT id, device_id, type, payload, status, created_at, executed_at, result
                 FROM remote_commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?"
            )?;
            let commands = stmt.query_map(params![device_id, limit], |row| {
                let payload_str: Option<String> = row.get(3)?;
                let payload = payload_str.and_then(|s| serde_json::from_str(&s).ok());
                Ok(RemoteCommand {
                    id: row.get(0)?,
                    device_id: row.get(1)?,
                    command_type: CommandType::from(row.get::<_, String>(2)?.as_str()),
                    payload,
                    status: row.get(4)?,
                    created_at: row.get(5)?,
                    executed_at: row.get(6)?,
                    result: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
            Ok(commands)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(result)
    }

    /// Acknowledge **this device's own** command (REQ-A411).
    ///
    /// Scoped by `device_id`: without it any caller could flip any command to `acknowledged` and
    /// write arbitrary text into the `result` an operator reads. Returns `false` (→ 404) rather
    /// than lying when the id is missing or belongs to another device.
    pub async fn ack_command(
        &self,
        command_id: &str,
        device_id: &str,
        result: Option<&str>,
    ) -> Result<bool, MdmError> {
        let command_id = command_id.to_string();
        let device_id = device_id.to_string();
        let result_owned = result.map(String::from);
        let conn = self.conn.clone();
        let rows = tokio::task::spawn_blocking(move || -> Result<usize, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let now = chrono::Utc::now().timestamp_millis();
            let rows = conn.execute(
                "UPDATE remote_commands SET status = 'acknowledged', executed_at = ?, result = ?
                 WHERE id = ? AND device_id = ?",
                params![now, result_owned, command_id, device_id],
            )?;
            Ok(rows)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?;
        Ok(rows? > 0)
    }
    pub async fn fail_command(&self, command_id: &str, error: &str) -> Result<bool, MdmError> {
        let command_id = command_id.to_string();
        let error_owned = error.to_string();
        let conn = self.conn.clone();
        let rows = tokio::task::spawn_blocking(move || -> Result<usize, rusqlite::Error> {
            let conn = conn.blocking_lock();
            let now = chrono::Utc::now().timestamp_millis();
            let rows = conn.execute(
                "UPDATE remote_commands SET status = 'failed', executed_at = ?, result = ? WHERE id = ?",
                params![now, error_owned, command_id],
            )?;
            Ok(rows)
        })
        .await
        .map_err(|e| MdmError::Internal(format!("spawn_blocking failed: {}", e)))?
        .map_err(MdmError::Database)?;
        Ok(rows > 0)
    }
}

// 为 rusqlite 添加 optional 方法
trait OptionalExt<T> {
    fn optional(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalExt<T> for rusqlite::Result<T> {
    fn optional(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

impl CommandType {
    pub fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "lock" => CommandType::Lock,
            "wipe" => CommandType::Wipe,
            "sync" => CommandType::Sync,
            "update_policy" => CommandType::UpdatePolicy,
            "unlock" => CommandType::Unlock,
            _ => CommandType::Sync,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway SQLite file per test (the crate's first tests: REQ-A411).
    ///
    /// A file, not `:memory:`, because `Database` owns exactly one connection and every call goes
    /// through it — an in-memory database would do, but the WAL pragmas from `new()` are part of
    /// what a real deployment gets, and a temp file keeps the tests on that path.
    struct TempDb {
        db: Database,
        path: std::path::PathBuf,
    }

    impl TempDb {
        async fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("amos-mdm-test-{}.db", uuid::Uuid::new_v4()));
            let db = Database::new(path.clone()).await.expect("a temp database");
            db.ensure_default_organization().await.expect("an org");
            Self { db, path }
        }

        async fn org_id(&self) -> String {
            self.db
                .get_default_organization()
                .await
                .expect("`new` created the default organization")
                .id
        }

        /// Read one value through the same connection from a blocking thread (an async test thread
        /// must not call `blocking_lock`).
        async fn text_where(&self, sql: &'static str, key: String) -> String {
            let conn = self.db.conn.clone();
            tokio::task::spawn_blocking(move || {
                let conn = conn.blocking_lock();
                conn.query_row(sql, params![key], |r| r.get(0))
                    .expect("the row exists")
            })
            .await
            .expect("the blocking read finished")
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let mut raw = self.path.clone().into_os_string();
                raw.push(suffix);
                let _ = std::fs::remove_file(std::path::PathBuf::from(raw));
            }
        }
    }

    fn params<'a>(token: &'a str, device_id: &'a str, org_id: &'a str) -> EnrollParams<'a> {
        EnrollParams {
            organization_id: org_id,
            enrollment_token: token,
            device_id,
            device_name: "Pixel",
            platform: "android",
            user_agent: "amos-test",
            enrolled_by: Some("admin@example.com"),
        }
    }

    fn config() -> MdmConfig {
        MdmConfig::default()
    }

    #[tokio::test]
    async fn an_enrollment_token_can_only_be_claimed_once() {
        let fx = TempDb::new().await;
        let org = fx.org_id().await;
        let token = fx.db.create_token(&org, 86_400_000).await.expect("a token");
        let now = chrono::Utc::now().timestamp_millis();

        let first = fx
            .db
            .enroll_device(params(&token.token, "device-1", &org), &config(), now)
            .await
            .expect("the first enrollment");
        assert_eq!(first.device.device_id, "device-1");
        assert_eq!(first.device.organization_id, org);
        assert_eq!(
            first.device.enrolled_by.as_deref(),
            Some("admin@example.com")
        );

        // The same token, a different device — the defect the transaction exists for: the old code
        // checked `used`, then marked it used and *threw the result away*, so both devices enrolled.
        match fx
            .db
            .enroll_device(params(&token.token, "device-2", &org), &config(), now)
            .await
        {
            Err(MdmError::TokenAlreadyUsed) => {}
            other => panic!("a spent token must be refused as used, got {other:?}"),
        }
        assert_eq!(
            fx.db
                .list_devices(&org, 100, 0)
                .await
                .expect("devices")
                .len(),
            1,
            "the refused enrollment must not have inserted a second device"
        );
    }

    #[tokio::test]
    async fn a_refused_device_does_not_burn_the_token() {
        // The other half of the transaction: a *failed* enrollment must roll the claim back, or a
        // device that simply retried would have destroyed the operator's token.
        let fx = TempDb::new().await;
        let org = fx.org_id().await;
        let first_token = fx.db.create_token(&org, 86_400_000).await.expect("t1");
        let second_token = fx.db.create_token(&org, 86_400_000).await.expect("t2");
        let now = chrono::Utc::now().timestamp_millis();

        fx.db
            .enroll_device(params(&first_token.token, "device-1", &org), &config(), now)
            .await
            .expect("the first device");

        // Re-enroll the *same* device with a fresh token: refused by the UNIQUE constraint…
        match fx
            .db
            .enroll_device(
                params(&second_token.token, "device-1", &org),
                &config(),
                now,
            )
            .await
        {
            Err(MdmError::DeviceAlreadyEnrolled) => {}
            other => panic!("a duplicate device must be refused by name, got {other:?}"),
        }

        // …and the fresh token is still unused, so it can enroll a *different* device.
        let row = fx
            .db
            .get_enrollment_token(&second_token.token)
            .await
            .expect("read back")
            .expect("the token row exists");
        assert!(
            !row.used,
            "the refused enrollment burned the token: the claim was not rolled back"
        );
        fx.db
            .enroll_device(
                params(&second_token.token, "device-2", &org),
                &config(),
                now,
            )
            .await
            .expect("the same token still works for another device");
    }

    #[tokio::test]
    async fn an_expired_or_unknown_token_is_refused_with_its_own_reason() {
        let fx = TempDb::new().await;
        let org = fx.org_id().await;
        // A token created with a negative lifetime is already expired at the instant it exists —
        // deterministic, with no clock arithmetic in the test.
        let expired = fx.db.create_token(&org, -1_000).await.expect("a token");
        let now = chrono::Utc::now().timestamp_millis();

        match fx
            .db
            .enroll_device(params(&expired.token, "device-1", &org), &config(), now)
            .await
        {
            Err(MdmError::InvalidToken) => {}
            other => panic!("an expired token must be InvalidToken, got {other:?}"),
        }
        match fx
            .db
            .enroll_device(params("NOT-A-TOKEN", "device-1", &org), &config(), now)
            .await
        {
            Err(MdmError::InvalidToken) => {}
            other => panic!("an unknown token must be InvalidToken, got {other:?}"),
        }
        // Neither attempt left anything behind.
        assert!(fx
            .db
            .list_devices(&org, 100, 0)
            .await
            .expect("devices")
            .is_empty());
    }

    #[tokio::test]
    async fn an_enrolled_device_gets_a_hashed_one_time_key() {
        let fx = TempDb::new().await;
        let org = fx.org_id().await;
        let token = fx.db.create_token(&org, 86_400_000).await.expect("a token");
        let enrolled = fx
            .db
            .enroll_device(
                params(&token.token, "device-1", &org),
                &config(),
                chrono::Utc::now().timestamp_millis(),
            )
            .await
            .expect("enrolled");

        // The raw key is returned exactly once and validates for *that* device.
        assert!(
            enrolled.api_key.starts_with("amos_"),
            "{}",
            enrolled.api_key
        );
        assert!(fx
            .db
            .validate_api_key("device-1", &enrolled.api_key)
            .await
            .expect("validates"));
        assert!(!fx
            .db
            .validate_api_key("device-2", &enrolled.api_key)
            .await
            .expect("validates"));
        assert!(!fx
            .db
            .validate_api_key("device-1", "amos_not-a-key")
            .await
            .expect("validates"));

        // …and the database holds the SHA-256, not the key.
        let stored = fx
            .text_where(
                "SELECT key_hash FROM api_keys WHERE device_id = ?",
                "device-1".to_string(),
            )
            .await;
        assert_eq!(stored, Database::hash_key(&enrolled.api_key));
        assert_ne!(stored, enrolled.api_key);
    }

    #[tokio::test]
    async fn a_page_is_bounded_and_a_bad_window_is_refused() {
        // The validator is the contract…
        assert_eq!(
            check_page(None, None).expect("defaults"),
            (DEFAULT_LIST_LIMIT, 0)
        );
        assert_eq!(check_page(Some(3), Some(7)).expect("explicit"), (3, 7));
        assert_eq!(
            check_page(Some(MAX_LIST_ROWS), None).expect("the ceiling is allowed"),
            (MAX_LIST_ROWS, 0)
        );
        for bad in [0, MAX_LIST_ROWS + 1] {
            match check_page(Some(bad), None) {
                Err(MdmError::InvalidRequest(message)) => {
                    assert!(message.contains("limit"), "{message}");
                }
                other => panic!("limit={bad} must be refused, got {other:?}"),
            }
        }

        // …and the SQL really applies it (limit + offset), so a page cannot be ignored downstream.
        let fx = TempDb::new().await;
        let org = fx.org_id().await;
        for device in ["device-1", "device-2", "device-3"] {
            let token = fx.db.create_token(&org, 86_400_000).await.expect("a token");
            fx.db
                .enroll_device(
                    params(&token.token, device, &org),
                    &config(),
                    chrono::Utc::now().timestamp_millis(),
                )
                .await
                .expect("enrolled");
        }
        let page = fx.db.list_devices(&org, 2, 0).await.expect("a page");
        assert_eq!(page.len(), 2, "LIMIT 2 must return two rows, not all three");
        let second = fx.db.list_devices(&org, 2, 2).await.expect("the tail");
        assert_eq!(second.len(), 1, "OFFSET 2 must land on the last row");
        // The database layer also clamps as its own last line of defence.
        assert_eq!(
            fx.db
                .list_devices(&org, MAX_LIST_ROWS + 100, 0)
                .await
                .expect("clamped")
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn a_command_can_only_be_acknowledged_by_its_own_device() {
        let fx = TempDb::new().await;
        let org = fx.org_id().await;
        for device in ["device-1", "device-2"] {
            let token = fx.db.create_token(&org, 86_400_000).await.expect("a token");
            fx.db
                .enroll_device(
                    params(&token.token, device, &org),
                    &config(),
                    chrono::Utc::now().timestamp_millis(),
                )
                .await
                .expect("enrolled");
        }
        let command = fx
            .db
            .create_command("device-1", "lock", None)
            .await
            .expect("a command");

        // Another device's ack must not touch it (REQ-A411: the endpoint had no auth at all, and the
        // update was scoped by id only).
        assert!(!fx
            .db
            .ack_command(&command.id, "device-2", Some("done"))
            .await
            .expect("the ack ran"));
        let pending = fx
            .db
            .get_pending_commands("device-1", DEFAULT_LIST_LIMIT)
            .await
            .expect("pending");
        assert_eq!(pending.len(), 1, "the command is still pending");
        assert_eq!(pending[0].result, None);

        // Its own device's ack lands, with the device's own result text.
        assert!(fx
            .db
            .ack_command(&command.id, "device-1", Some("done"))
            .await
            .expect("the ack ran"));
        assert!(fx
            .db
            .get_pending_commands("device-1", DEFAULT_LIST_LIMIT)
            .await
            .expect("pending")
            .is_empty());
        let result = fx
            .text_where(
                "SELECT result FROM remote_commands WHERE id = ?",
                command.id.clone(),
            )
            .await;
        assert_eq!(result, "done");
        // An unknown id is "not found", not a silent success.
        assert!(!fx
            .db
            .ack_command("no-such-command", "device-1", None)
            .await
            .expect("the ack ran"));
    }
}
