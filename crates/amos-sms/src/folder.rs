//! SMS folders (inbox / sent / drafts) — the view a thread list is read through.
//!
//! Android stores every SMS row in one table (`content://sms`) tagged with a
//! `type`; a folder is that tag. Mirroring the same three views the platform SMS
//! app shows keeps the domain honest: a "thread" is per-address, but *which*
//! messages a folder lists is decided by `type` — the same conversation appears
//! in the inbox, sent and drafts folders with different contents.

use crate::error::SmsError;

/// A view over the SMS rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SmsFolder {
    /// Received messages (`Telephony.Sms.MESSAGE_TYPE_INBOX` = 1).
    Inbox,
    /// Messages we sent (`MESSAGE_TYPE_SENT` = 2).
    Sent,
    /// Unsent drafts (`MESSAGE_TYPE_DRAFT` = 3).
    Draft,
}

impl SmsFolder {
    /// Every folder, in the order a UI shows them.
    pub const ALL: [SmsFolder; 3] = [SmsFolder::Inbox, SmsFolder::Sent, SmsFolder::Draft];

    /// Stable wire/glue name (snake, lower-case) — also the JSON value the
    /// Kotlin glue receives and the frontend sends.
    pub fn wire(self) -> &'static str {
        match self {
            SmsFolder::Inbox => "inbox",
            SmsFolder::Sent => "sent",
            SmsFolder::Draft => "draft",
        }
    }

    /// Parse a wire name. Unknown names are an honest caller error (never
    /// silently treated as the inbox).
    pub fn from_wire(name: &str) -> Result<Self, SmsError> {
        match name.trim().to_ascii_lowercase().as_str() {
            "inbox" => Ok(SmsFolder::Inbox),
            "sent" => Ok(SmsFolder::Sent),
            "draft" | "drafts" => Ok(SmsFolder::Draft),
            other => Err(SmsError::Invalid(format!(
                "unknown SMS folder {other:?} (expected inbox|sent|draft)"
            ))),
        }
    }

    /// Android `Telephony.Sms.MESSAGE_TYPE_*` for this folder — the value the
    /// glue filters `content://sms` by.
    pub fn android_type(self) -> u32 {
        match self {
            SmsFolder::Inbox => 1,
            SmsFolder::Sent => 2,
            SmsFolder::Draft => 3,
        }
    }
}

/// Per-folder item counts (thread counts, for folder tabs/badges).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SmsFolderCounts {
    pub inbox: u32,
    pub sent: u32,
    pub draft: u32,
}

impl SmsFolderCounts {
    /// Count for one folder.
    pub fn of(&self, folder: SmsFolder) -> u32 {
        match folder {
            SmsFolder::Inbox => self.inbox,
            SmsFolder::Sent => self.sent,
            SmsFolder::Draft => self.draft,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_round_trip_and_map_to_android_types() {
        assert_eq!(SmsFolder::Inbox.wire(), "inbox");
        assert_eq!(SmsFolder::Sent.wire(), "sent");
        assert_eq!(SmsFolder::Draft.wire(), "draft");
        assert_eq!(SmsFolder::Inbox.android_type(), 1);
        assert_eq!(SmsFolder::Sent.android_type(), 2);
        assert_eq!(SmsFolder::Draft.android_type(), 3);
        for f in SmsFolder::ALL {
            assert_eq!(SmsFolder::from_wire(f.wire()).unwrap(), f);
        }
        assert_eq!(SmsFolder::from_wire(" Drafts ").unwrap(), SmsFolder::Draft);
    }

    #[test]
    fn unknown_folder_is_an_honest_error() {
        assert!(SmsFolder::from_wire("").is_err());
        assert!(SmsFolder::from_wire("outbox").is_err());
        assert!(SmsFolder::from_wire("inbox; DROP TABLE").is_err());
    }

    #[test]
    fn counts_are_addressed_by_folder() {
        let c = SmsFolderCounts {
            inbox: 3,
            sent: 2,
            draft: 1,
        };
        assert_eq!(c.of(SmsFolder::Inbox), 3);
        assert_eq!(c.of(SmsFolder::Sent), 2);
        assert_eq!(c.of(SmsFolder::Draft), 1);
        assert_eq!(SmsFolderCounts::default().of(SmsFolder::Inbox), 0);
    }
}
