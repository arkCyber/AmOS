//! SMS domain types: a thread (per address) and its messages.

/// A conversation with one remote party (an address / phone number).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmsThread {
    /// Stable thread id (from the device, or a deterministic mock id).
    pub id: String,
    /// Remote address (digits, `+`-prefixed, etc.).
    pub address: String,
    /// Best-known display name (empty when unknown / not a contact).
    pub display_name: String,
    /// Text of the most recent message in this thread.
    pub last_text: String,
    /// Unix epoch ms of the most recent message.
    pub last_ts_ms: i64,
    /// Number of unread *incoming* messages.
    pub unread: u32,
}

impl SmsThread {
    /// Convenience constructor (keeps construction sites short and explicit).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: impl Into<String>,
        address: impl Into<String>,
        display_name: impl Into<String>,
        last_text: impl Into<String>,
        last_ts_ms: i64,
        unread: u32,
    ) -> Self {
        Self {
            id: id.into(),
            address: address.into(),
            display_name: display_name.into(),
            last_text: last_text.into(),
            last_ts_ms,
            unread,
        }
    }
}

/// One SMS message inside a thread.
#[derive(Debug, Clone, PartialEq)]
pub struct SmsMessage {
    /// Owning thread id.
    pub thread_id: String,
    /// Stable message id (device row id / mock id).
    pub id: String,
    /// `true` when we sent it (outgoing).
    pub from_me: bool,
    /// Message body.
    pub text: String,
    /// Unix epoch ms.
    pub ts_ms: i64,
    /// `true` when read (only meaningful for incoming).
    pub read: bool,
}

impl SmsMessage {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        thread_id: impl Into<String>,
        id: impl Into<String>,
        from_me: bool,
        text: impl Into<String>,
        ts_ms: i64,
        read: bool,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            id: id.into(),
            from_me,
            text: text.into(),
            ts_ms,
            read,
        }
    }
}
