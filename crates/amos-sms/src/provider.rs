//! The SMS provider seam + a deterministic mock.

use crate::error::SmsError;
use crate::spec::{SmsMessage, SmsThread};

/// A backend that can list SMS threads, list a thread's messages and send a
/// text. Host/test code uses [`MockSms`]; the real device backend plugs in here.
pub trait SmsProvider: Send + Sync {
    /// List all SMS threads (newest first).
    fn snapshot(&self) -> Result<Vec<SmsThread>, SmsError>;
    /// List messages of one thread (chronological).
    fn messages(&self, thread_id: &str) -> Result<Vec<SmsMessage>, SmsError>;
    /// Send `text` to `address`. Errors honestly; never fakes a delivery.
    fn send(&self, address: &str, text: &str) -> Result<(), SmsError>;
}

/// Deterministic, offline backend for host tests/development.
///
/// `seeded()` returns a small fixed inbox so UI/domain code can be exercised
/// meaningfully; `new()` returns an *empty* inbox (the honest "no real SMS on a
/// host" state). Neither ever performs real SMS.
pub struct MockSms {
    seed: bool,
}

impl MockSms {
    /// Empty inbox (offline/honest).
    pub fn new() -> Self {
        Self { seed: false }
    }
    /// A small fixed demo inbox (dev/UI testing only).
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
    fn snapshot(&self) -> Result<Vec<SmsThread>, SmsError> {
        if !self.seed {
            return Ok(Vec::new());
        }
        Ok(vec![
            SmsThread::new(
                "1",
                "13800138000",
                "家人",
                "晚上回家吃饭吗？",
                1_700_000_000_000,
                1,
            ),
            SmsThread::new(
                "2",
                "10086",
                "中国移动",
                "您的流量已用 80%。",
                1_699_000_000_000,
                0,
            ),
        ])
    }

    fn messages(&self, thread_id: &str) -> Result<Vec<SmsMessage>, SmsError> {
        if !self.seed {
            // Honest: an empty (host) inbox has no threads to read.
            return Err(SmsError::Unavailable(
                "no real SMS inbox on the host".into(),
            ));
        }
        match thread_id {
            "1" => Ok(vec![
                SmsMessage::new(
                    "1",
                    "m1",
                    false,
                    "下班顺路买点菜。",
                    1_699_999_000_000,
                    true,
                ),
                SmsMessage::new(
                    "1",
                    "m2",
                    false,
                    "晚上回家吃饭吗？",
                    1_700_000_000_000,
                    false,
                ),
            ]),
            "2" => Ok(vec![SmsMessage::new(
                "2",
                "m3",
                false,
                "您的流量已用 80%。",
                1_699_000_000_000,
                true,
            )]),
            _ => Err(SmsError::Failed(format!("no such thread: {thread_id}"))),
        }
    }

    fn send(&self, _address: &str, text: &str) -> Result<(), SmsError> {
        if text.trim().is_empty() {
            return Err(SmsError::Invalid("blank SMS text".into()));
        }
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
        assert!(p.snapshot().unwrap().is_empty());
        assert!(p.messages("1").is_err()); // nothing exists in an empty inbox
    }

    #[test]
    fn seeded_mock_has_threads_and_messages() {
        let p = MockSms::seeded();
        let ts = p.snapshot().unwrap();
        assert_eq!(ts.len(), 2);
        assert_eq!(ts[0].address, "13800138000");
        assert_eq!(ts[0].unread, 1);
        let msgs = p.messages("1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert!(!msgs[1].read, "newest incoming is unread");
    }

    #[test]
    fn mock_send_rejects_blank_and_accepts_real_text() {
        let p = MockSms::seeded();
        assert!(p.send("10086", "   ").is_err());
        assert!(p.send("10086", "TZ").is_ok());
    }
}
