//! The SMS provider seam + a deterministic mock.

use std::collections::BTreeMap;

use crate::error::SmsError;
use crate::folder::{SmsFolder, SmsFolderCounts};
use crate::spec::{SmsMessage, SmsThread};
use crate::validate::{normalize_address, validate_text};

/// [`SmsProvider::name`] of the honest host/offline mock. Callers can compare
/// against this to tell "no real device backend" from a real one.
pub const MOCK_PROVIDER: &str = "mock";

/// A backend that can list SMS threads per folder, list a thread's messages and
/// send a text. Host/test code uses [`MockSms`]; the real device backend plugs in
/// here.
///
/// Providers **must** validate sends ([`normalize_address`] + [`validate_text`])
/// and must never report success for something they did not hand to the
/// platform. A read that fails because a permission is missing returns
/// [`SmsError::PermissionDenied`], never an empty list.
pub trait SmsProvider: Send + Sync {
    /// Stable backend id ("mock", "android-sms", …) so callers can tell a real
    /// device provider from the honest host mock without guessing.
    fn name(&self) -> &'static str;
    /// Threads of one folder (newest first). An unknown folder is a caller error,
    /// never silently the inbox.
    fn snapshot(&self, folder: SmsFolder) -> Result<Vec<SmsThread>, SmsError>;
    /// Messages of one thread (chronological). `folder = None` means "every
    /// message of that conversation"; `Some(f)` restricts to that folder's rows.
    fn messages(
        &self,
        thread_id: &str,
        folder: Option<SmsFolder>,
    ) -> Result<Vec<SmsMessage>, SmsError>;
    /// Distinct thread counts per folder (folder tabs / badges).
    fn counts(&self) -> Result<SmsFolderCounts, SmsError>;
    /// Send `text` to `address`. Errors honestly; never fakes a delivery.
    fn send(&self, address: &str, text: &str) -> Result<(), SmsError>;
}

/// One seeded demo row (single source of truth for the mock's three folders).
struct Row {
    folder: SmsFolder,
    thread: &'static str,
    address: &'static str,
    display: &'static str,
    id: &'static str,
    from_me: bool,
    text: &'static str,
    ts: i64,
    read: bool,
}

/// The fixed demo rows: two conversations split across the three folders, so a
/// UI can exercise inbox / sent / drafts meaningfully offline.
fn seeded_rows() -> Vec<Row> {
    use SmsFolder::*;
    vec![
        Row {
            folder: Inbox,
            thread: "1",
            address: "13800138000",
            display: "家人",
            id: "m1",
            from_me: false,
            text: "下班顺路买点菜。",
            ts: 1_699_999_000_000,
            read: true,
        },
        Row {
            folder: Inbox,
            thread: "1",
            address: "13800138000",
            display: "家人",
            id: "m2",
            from_me: false,
            text: "晚上回家吃饭吗？",
            ts: 1_700_000_000_000,
            read: false,
        },
        Row {
            folder: Sent,
            thread: "1",
            address: "13800138000",
            display: "家人",
            id: "m3",
            from_me: true,
            text: "好的，六点到家。",
            ts: 1_699_999_500_000,
            read: true,
        },
        Row {
            folder: Inbox,
            thread: "2",
            address: "10086",
            display: "中国移动",
            id: "m4",
            from_me: false,
            text: "您的流量已用 80%。",
            ts: 1_699_000_000_000,
            read: true,
        },
        Row {
            folder: Sent,
            thread: "3",
            address: "10086",
            display: "中国移动",
            id: "m5",
            from_me: true,
            text: "TD",
            ts: 1_698_000_000_000,
            read: true,
        },
        Row {
            folder: Draft,
            thread: "3",
            address: "10086",
            display: "中国移动",
            id: "m6",
            from_me: true,
            text: "【草稿】想问下流量包怎么退订",
            ts: 1_697_000_000_000,
            read: true,
        },
    ]
}

/// Deterministic, offline backend for host tests/development.
///
/// `seeded()` returns a small fixed inbox + sent + drafts set so UI/domain code
/// can be exercised meaningfully; `new()` returns an *empty* store (the honest
/// "no real SMS on a host" state). Neither ever performs real SMS.
pub struct MockSms {
    seed: bool,
}

impl MockSms {
    /// Empty store (offline/honest).
    pub fn new() -> Self {
        Self { seed: false }
    }
    /// A small fixed demo store across all folders (dev/UI testing only).
    pub fn seeded() -> Self {
        Self { seed: true }
    }
}

impl Default for MockSms {
    fn default() -> Self {
        Self::new()
    }
}

impl SmsProvider for MockSms {
    fn name(&self) -> &'static str {
        MOCK_PROVIDER
    }

    fn snapshot(&self, folder: SmsFolder) -> Result<Vec<SmsThread>, SmsError> {
        if !self.seed {
            return Ok(Vec::new());
        }
        // Group this folder's rows by thread: newest row = preview; unread counts
        // only exist in the inbox (sent/drafts are ours, never "unread").
        let rows = seeded_rows();
        let mut by_thread: BTreeMap<&str, (&Row, u32)> = BTreeMap::new();
        for row in rows.iter().filter(|r| r.folder == folder) {
            let entry = by_thread.entry(row.thread).or_insert((row, 0));
            if row.ts > entry.0.ts {
                entry.0 = row;
            }
            if folder == SmsFolder::Inbox && !row.from_me && !row.read {
                entry.1 += 1;
            }
        }
        let mut threads: Vec<SmsThread> = by_thread
            .into_values()
            .map(|(row, unread)| {
                SmsThread::new(
                    row.thread,
                    row.address,
                    row.display,
                    row.text,
                    row.ts,
                    unread,
                )
            })
            .collect();
        threads.sort_by_key(|a| std::cmp::Reverse(a.last_ts_ms)); // newest first
        Ok(threads)
    }

    fn messages(
        &self,
        thread_id: &str,
        folder: Option<SmsFolder>,
    ) -> Result<Vec<SmsMessage>, SmsError> {
        if thread_id.trim().is_empty() {
            return Err(SmsError::Invalid("blank SMS thread id".into()));
        }
        if !self.seed {
            // Honest: an empty (host) store has no threads to read.
            return Err(SmsError::Unavailable(
                "no real SMS inbox on the host".into(),
            ));
        }
        let rows = seeded_rows();
        let mut scoped: Vec<&Row> = rows
            .iter()
            .filter(|r| r.thread == thread_id && folder.map_or(true, |f| r.folder == f))
            .collect();
        scoped.sort_by_key(|r| r.ts); // chronological
        Ok(scoped
            .into_iter()
            .map(|r| SmsMessage::new(r.thread, r.id, r.from_me, r.text, r.ts, r.read))
            .collect())
    }

    fn counts(&self) -> Result<SmsFolderCounts, SmsError> {
        if !self.seed {
            return Ok(SmsFolderCounts::default());
        }
        let rows = seeded_rows();
        let distinct = |f: SmsFolder| {
            let mut threads: Vec<&str> = rows
                .iter()
                .filter(|r| r.folder == f)
                .map(|r| r.thread)
                .collect();
            threads.sort_unstable();
            threads.dedup();
            threads.len() as u32
        };
        Ok(SmsFolderCounts {
            inbox: distinct(SmsFolder::Inbox),
            sent: distinct(SmsFolder::Sent),
            draft: distinct(SmsFolder::Draft),
        })
    }

    fn send(&self, address: &str, text: &str) -> Result<(), SmsError> {
        // Validate exactly like the real backend (domain-level contract).
        let _address = normalize_address(address)?;
        validate_text(text)?;
        // Honest mock: we accept the request but never claim a real delivery.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_mock_is_honest_no_sms() {
        let p = MockSms::new();
        for f in SmsFolder::ALL {
            assert!(p.snapshot(f).unwrap().is_empty(), "{f:?} must be empty");
        }
        assert_eq!(p.counts().unwrap(), SmsFolderCounts::default());
        assert!(p.messages("1", None).is_err()); // nothing exists in an empty store
    }

    #[test]
    fn seeded_mock_has_threads_and_messages_per_folder() {
        let p = MockSms::seeded();
        let inbox = p.snapshot(SmsFolder::Inbox).unwrap();
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox[0].address, "13800138000");
        assert_eq!(inbox[0].unread, 1); // newest incoming is unread
                                        // The inbox preview is the newest *inbox* row, not a sent one.
        assert_eq!(inbox[0].last_text, "晚上回家吃饭吗？");

        let sent = p.snapshot(SmsFolder::Sent).unwrap();
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|t| t.unread == 0), "sent is never unread");
        assert_eq!(sent[0].last_text, "好的，六点到家。");

        let drafts = p.snapshot(SmsFolder::Draft).unwrap();
        assert_eq!(drafts.len(), 1);
        assert!(drafts[0].last_text.starts_with("【草稿】"));

        // Counts mirror the distinct threads per folder.
        assert_eq!(
            p.counts().unwrap(),
            SmsFolderCounts {
                inbox: 2,
                sent: 2,
                draft: 1
            }
        );
    }

    #[test]
    fn messages_can_be_restricted_to_a_folder() {
        let p = MockSms::seeded();
        // Whole conversation: inbox + sent rows of thread 1, chronological.
        let all = p.messages("1", None).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.windows(2).all(|w| w[0].ts_ms <= w[1].ts_ms));
        let inbox = p.messages("1", Some(SmsFolder::Inbox)).unwrap();
        assert_eq!(inbox.len(), 2);
        assert!(inbox.iter().all(|m| !m.from_me));
        let sent = p.messages("1", Some(SmsFolder::Sent)).unwrap();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].from_me);
        // A folder with no rows for that thread is an honest empty list.
        assert!(p.messages("1", Some(SmsFolder::Draft)).unwrap().is_empty());
    }

    #[test]
    fn mock_send_rejects_blank_and_accepts_real_text() {
        let p = MockSms::seeded();
        assert!(p.send("10086", "   ").is_err());
        assert!(p.send("10086", "TZ").is_ok());
    }

    #[test]
    fn providers_are_identified_and_sends_are_validated() {
        let p = MockSms::seeded();
        assert_eq!(p.name(), "mock");
        // Blank/oversized/bad-address sends are rejected at the domain boundary.
        assert!(p.send("", "hi").is_err());
        assert!(p.send("abc", "hi").is_err());
        assert!(p.send("+86 138-0013-8000", "hi").is_ok()); // separators normalized
        assert!(p
            .send("10086", &"a".repeat(crate::validate::MAX_TEXT_CHARS + 1))
            .is_err());
        // A blank thread id is a caller bug, not "no messages".
        assert!(p.messages("  ", None).is_err());
    }
}
