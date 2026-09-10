//! Stable JSON wire contract between the SMS domain and its (Kotlin) glue /
//! UI. Kept pure + headless so parsing is unit-tested here, on the host, exactly
//! like every other domain crate. Never fabricates a value: a missing/wrong
//! field is an honest [`SmsError::Invalid`].

use serde_json::Value;

use crate::error::SmsError;
use crate::spec::{SmsMessage, SmsThread};

/// Parse the snapshot JSON produced by a provider/glue:
/// `{"threads":[{"id","address","display_name","last_text","last_ts_ms","unread"}]}`.
pub fn parse_snapshot(payload: &str) -> Result<Vec<SmsThread>, SmsError> {
    let v: Value = serde_json::from_str(payload)
        .map_err(|e| SmsError::Invalid(format!("unparseable snapshot: {e}")))?;
    let list = v
        .get("threads")
        .and_then(Value::as_array)
        .ok_or_else(|| SmsError::Invalid("snapshot missing 'threads' array".into()))?;
    let mut out = Vec::with_capacity(list.len());
    for (i, t) in list.iter().enumerate() {
        let id = req_str(t, "id", i)?;
        let address = req_str(t, "address", i)?;
        let display_name = opt_str(t, "display_name");
        let last_text = opt_str(t, "last_text");
        let last_ts_ms = req_i64(t, "last_ts_ms", i)?;
        let unread = opt_u32(t, "unread");
        out.push(SmsThread::new(
            id,
            address,
            display_name,
            last_text,
            last_ts_ms,
            unread,
        ));
    }
    Ok(out)
}

/// Parse one thread's messages JSON:
/// `{"thread_id","messages":[{id,from_me,text,ts_ms,read}]}`.
pub fn parse_messages(payload: &str) -> Result<Vec<SmsMessage>, SmsError> {
    let v: Value = serde_json::from_str(payload)
        .map_err(|e| SmsError::Invalid(format!("unparseable messages: {e}")))?;
    let thread_id = req_str(&v, "thread_id", 0)?;
    let list = v
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| SmsError::Invalid("messages missing 'messages' array".into()))?;
    let mut out = Vec::with_capacity(list.len());
    for (i, m) in list.iter().enumerate() {
        let id = req_str(m, "id", i)?;
        let from_me = m.get("from_me").and_then(Value::as_bool).unwrap_or(false);
        let text = opt_str(m, "text");
        let ts_ms = req_i64(m, "ts_ms", i)?;
        let read = m.get("read").and_then(Value::as_bool).unwrap_or(true);
        out.push(SmsMessage::new(
            thread_id.clone(),
            id,
            from_me,
            text,
            ts_ms,
            read,
        ));
    }
    Ok(out)
}

fn req_str(o: &Value, key: &str, idx: usize) -> Result<String, SmsError> {
    match o.get(key).and_then(Value::as_str) {
        Some(s) => Ok(s.to_string()),
        None => Err(SmsError::Invalid(format!(
            "missing string field '{key}' at index {idx}"
        ))),
    }
}

fn opt_str(o: &Value, key: &str) -> String {
    o.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn req_i64(o: &Value, key: &str, idx: usize) -> Result<i64, SmsError> {
    match o.get(key).and_then(Value::as_i64) {
        Some(n) => Ok(n),
        None => Err(SmsError::Invalid(format!(
            "missing integer field '{key}' at index {idx}"
        ))),
    }
}

fn opt_u32(o: &Value, key: &str) -> u32 {
    o.get(key)
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_snapshot() {
        let json = r#"{"threads":[
          {"id":"1","address":"13800138000","display_name":"家人","last_text":"回吗","last_ts_ms":1700000000000,"unread":1},
          {"id":"2","address":"10086","last_ts_ms":1690000000000}
        ]}"#;
        let ts = parse_snapshot(json).unwrap();
        assert_eq!(ts.len(), 2);
        assert_eq!(ts[0].display_name, "家人");
        assert_eq!(ts[0].unread, 1);
        // Optional fields default honestly.
        assert_eq!(ts[1].display_name, "");
        assert_eq!(ts[1].last_text, "");
        assert_eq!(ts[1].unread, 0);
    }

    #[test]
    fn rejects_garbage_snapshot() {
        assert!(parse_snapshot("{}").is_err());
        assert!(parse_snapshot("not json").is_err());
        assert!(parse_snapshot(r#"{"threads":[{"id":"1"}]}"#).is_err()); // missing fields
    }

    #[test]
    fn parses_messages_and_keeps_thread_id() {
        let json = r#"{"thread_id":"1","messages":[
          {"id":"m1","from_me":false,"text":"hi","ts_ms":1,"read":true},
          {"id":"m2","from_me":true,"text":"hey","ts_ms":2,"read":true}
        ]}"#;
        let msgs = parse_messages(json).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].thread_id, "1");
        assert!(!msgs[0].from_me);
        assert!(msgs[1].from_me);
    }
}
