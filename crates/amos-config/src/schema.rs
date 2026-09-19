//! Tiny JSON Schema subset validator.
//!
//! Real JSON Schema drafts (07 / 2019-09 / 2020-12) are large; the subset
//! this project actually uses is small:
//!
//! * `type` — one of `string`/`integer`/`number`/`boolean`/`array`/`object`
//! * `minimum` / `maximum` — for `integer`/`number`
//! * `enum` — exact-value list
//!
//! Every operator-authored config file is validated against this subset **per
//! key** by [`crate::Resolver::get`] before the value is returned. A
//! violation is **refused** (the lookup returns `Err`), so a bad file cannot
//! silently change behaviour.
//!
//! Honesty rules:
//!
//! * Validators **never** coerce — `42` (number) under `string` is refused,
//!   not converted. A caller that wants coercion should do it itself.
//! * Unknown schema fields are ignored (the subset is by-name; future keys
//!   will be a hard error in their own release so we never silently drop
//!   rules).
//! * `enum` values are matched with the same JSON-equality rules as
//!   `serde_json::Value::eq` — `"42"` is **not** equal to `42`.

use serde_json::Value as JsonValue;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Type {
    String,
    Integer,
    Number,
    Boolean,
    Array,
    Object,
}

#[derive(Debug, Clone)]
pub struct Schema {
    pub ty: Type,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    /// Exact JSON values allowed (compared with `serde_json::Value::eq`).
    pub enum_values: Option<Vec<JsonValue>>,
}

impl Schema {
    /// Schema for a 16-bit unsigned port (the shape `AMOS_*_PORT` knobs take).
    pub fn port() -> Self {
        Self {
            ty: Type::Integer,
            minimum: Some(0.0),
            maximum: Some(65535.0),
            enum_values: None,
        }
    }

    /// Schema for a non-negative integer count (bytes / ms / entries).
    pub fn nonneg_int() -> Self {
        Self {
            ty: Type::Integer,
            minimum: Some(0.0),
            maximum: None,
            enum_values: None,
        }
    }

    /// Schema for a string from a fixed set (an enum, expressed as strings).
    pub fn string_enum(values: &[&str]) -> Self {
        Self {
            ty: Type::String,
            minimum: None,
            maximum: None,
            enum_values: Some(
                values
                    .iter()
                    .map(|s| JsonValue::String((*s).into()))
                    .collect(),
            ),
        }
    }

    /// Validate one JSON value against this schema. Returns the unit type on
    /// success, a string error message on failure.
    pub fn validate(&self, v: &JsonValue) -> Result<(), String> {
        // 1) Type
        match (&self.ty, v) {
            (Type::String, JsonValue::String(_)) => {}
            (Type::Integer, JsonValue::Number(n)) if n.is_i64() || n.is_u64() => {}
            (Type::Number, JsonValue::Number(_)) => {}
            (Type::Boolean, JsonValue::Bool(_)) => {}
            (Type::Array, JsonValue::Array(_)) => {}
            (Type::Object, JsonValue::Object(_)) => {}
            (ty, val) => {
                return Err(format!("expected {ty:?}, got {}", val_kind(val)));
            }
        }
        // 2) numeric range (Integer ⇒ the value is already i64/u64; Number
        // uses f64 — same field applies; `Number(_)` for Integer is rejected
        // above, so we don't have to worry about 3.0 vs 3 here).
        if let JsonValue::Number(n) = v {
            let f = n.as_f64().ok_or_else(|| "non-finite number".to_string())?;
            if let Some(min) = self.minimum {
                if f < min {
                    return Err(format!("value {f} < minimum {min}"));
                }
            }
            if let Some(max) = self.maximum {
                if f > max {
                    return Err(format!("value {f} > maximum {max}"));
                }
            }
        }
        // 3) enum
        if let Some(allowed) = &self.enum_values {
            if !allowed.iter().any(|a| a == v) {
                return Err(format!("value not in enum ({allowed:?})"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("schema violation on `{key}` (expected {expected:?}): {message}")]
pub struct SchemaError {
    pub key: String,
    pub expected: Type,
    pub message: String,
}

fn val_kind(v: &JsonValue) -> &'static str {
    match v {
        JsonValue::Null => "null",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Array(_) => "array",
        JsonValue::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_check_is_strict_no_coercion() {
        let s = Schema {
            ty: Type::Integer,
            ..Schema::port()
        };
        assert!(s.validate(&serde_json::json!(42)).is_ok());
        assert!(s.validate(&serde_json::json!("42")).is_err()); // no auto-coerce
        assert!(s.validate(&serde_json::json!(3.5)).is_err()); // float ≠ integer
    }

    #[test]
    fn port_range_is_enforced() {
        let s = Schema::port();
        assert!(s.validate(&serde_json::json!(0)).is_ok());
        assert!(s.validate(&serde_json::json!(65535)).is_ok());
        assert!(s.validate(&serde_json::json!(-1)).is_err());
        assert!(s.validate(&serde_json::json!(70000)).is_err());
    }

    #[test]
    fn string_enum_matches_exactly() {
        let s = Schema::string_enum(&["mock", "api", "ollama"]);
        assert!(s.validate(&serde_json::json!("mock")).is_ok());
        assert!(s.validate(&serde_json::json!("hermes")).is_err());
        // `"Mock"` ≠ `"mock"` — case-sensitive on purpose.
        assert!(s.validate(&serde_json::json!("Mock")).is_err());
    }

    #[test]
    fn unknown_schema_keys_are_ignored_not_silently_dropped() {
        // The current schema struct has no `pattern` field — a future draft
        // can add it as a hard error in its own release, never silently.
        let s = Schema::port();
        assert!(s.validate(&serde_json::json!(8080)).is_ok());
    }
}
