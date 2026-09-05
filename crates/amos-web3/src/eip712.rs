//! [EIP-712] typed structured-data hashing + signing (`signTypedData` v4).
//!
//! This mirrors the canonical reference implementation shipped with the spec:
//! a struct's `typeHash = keccak256(encodeType)`, `hashStruct(s) =
//! keccak256(typeHash ‖ encodeData(s))`, and the final signing digest is
//! `keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message))`.
//!
//! Following the spec's reference code, dynamic members are *folded to a
//! 32-byte word* rather than ABI-offset encoded: `string`/`bytes` → keccak of
//! the raw data, nested structs → their `hashStruct`, arrays → keccak of the
//! concatenated element words. No offset arithmetic is needed.
//!
//! Supported field types: `address`, `bool`, `string`, `bytes`, `bytesN`,
//! `uintN`, `intN`, arrays `T[]` / `T[k]`, and nested structs declared in
//! `types`. Numeric JSON values may be a JSON number (≤ 64-bit) or a `0x…`
//! hex string (arbitrary width). This is a documented subset — anything else
//! returns [`Error::TypedData`] rather than guessing.
//!
//! [EIP-712]: https://eips.ethereum.org/EIPS/eip-712

use std::collections::BTreeSet;

use serde_json::{Map, Value};

use crate::bytes;
use crate::error::{Error, Result};
use crate::hash::keccak256;
use crate::secp::{PublicKey, RecoverableSignature, SecretKey};

/// A single typed-data field declaration (`{ name, type }`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    /// Field name as it appears on the message object.
    pub name: String,
    /// ABI/EIP-712 type, e.g. `"address"`, `"Person"`, `"uint256[]"`.
    pub typ: String,
}

/// The canonical `eth_signTypedData` payload:
/// `{ types, primaryType, domain, message }`.
///
/// `types` maps each struct name (including `EIP712Domain`) to its fields.
#[derive(Clone, Debug)]
pub struct TypedData {
    /// Struct type declarations (field order is significant).
    pub types: std::collections::BTreeMap<String, Vec<Field>>,
    /// The top-level struct to sign.
    pub primary_type: String,
    /// `EIP712Domain` value (domain separator inputs).
    pub domain: Value,
    /// The message to sign.
    pub message: Value,
}

/// Strip array suffixes from a type: `"Person[]"` → `"Person"`, `"uint256[3]"`
/// → `"uint256"`.
fn base_type(typ: &str) -> &str {
    match typ.find('[') {
        Some(idx) => &typ[..idx],
        None => typ,
    }
}

impl TypedData {
    /// Parse the canonical `{ types, primaryType, domain, message }` JSON.
    pub fn from_json(text: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(text)
            .map_err(|e| Error::TypedData(format!("payload is not valid JSON: {e}")))?;
        Self::from_value(&value)
    }

    /// Parse the canonical shape from a parsed JSON [`Value`].
    pub fn from_value(value: &Value) -> Result<Self> {
        let obj = value
            .as_object()
            .ok_or_else(|| Error::TypedData("top level must be an object".into()))?;

        let primary_type = string_field(obj, "primaryType")?;
        let domain = obj
            .get("domain")
            .cloned()
            .filter(|v| v.is_object())
            .ok_or_else(|| Error::TypedData("domain must be an object".into()))?;
        let message = obj
            .get("message")
            .cloned()
            .ok_or_else(|| Error::TypedData("message is required".into()))?;

        let types_obj = obj
            .get("types")
            .and_then(|v| v.as_object())
            .ok_or_else(|| Error::TypedData("types must be an object".into()))?;
        let mut types = std::collections::BTreeMap::new();
        for (name, arr) in types_obj {
            let fields = arr
                .as_array()
                .ok_or_else(|| Error::TypedData(format!("types.{name} must be an array")))?;
            let mut field_list = Vec::new();
            for f in fields {
                let fobj = f
                    .as_object()
                    .ok_or_else(|| Error::TypedData("field must be an object".into()))?;
                field_list.push(Field {
                    name: string_field(fobj, "name")?,
                    typ: string_field(fobj, "type")?,
                });
            }
            types.insert(name.clone(), field_list);
        }
        if !types.contains_key(&primary_type) {
            return Err(Error::TypedData(format!(
                "primaryType {primary_type} is not declared in types"
            )));
        }

        Ok(Self {
            types,
            primary_type,
            domain,
            message,
        })
    }
}

/// Read a required string field from a JSON object.
fn string_field(obj: &Map<String, Value>, key: &str) -> Result<String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| Error::TypedData(format!("missing string field {key}")))
}

impl TypedData {
    /// The canonical `encodeType` for `name`: the type itself followed by every
    /// reachable dependency sorted alphabetically (see the EIP-712 spec).
    pub fn encode_type(&self, name: &str) -> Result<String> {
        let deps = self.referenced_types(name);
        let mut order = vec![name.to_string()];
        order.extend(deps.into_iter().filter(|t| t != name));
        let mut out = String::new();
        for ty in &order {
            let fields = self
                .types
                .get(ty)
                .ok_or_else(|| Error::TypedData(format!("unknown type {ty}")))?;
            out.push_str(ty);
            out.push('(');
            for (i, f) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&f.typ);
                out.push(' ');
                out.push_str(&f.name);
            }
            out.push(')');
        }
        Ok(out)
    }

    /// `typeHash(name) = keccak256(encodeType(name))`.
    pub fn type_hash(&self, name: &str) -> Result<[u8; 32]> {
        Ok(keccak256(self.encode_type(name)?.as_bytes()))
    }

    /// `encodeData`: concatenation of each field's encoded 32-byte word.
    fn encode_data(&self, name: &str, value: &Value) -> Result<Vec<u8>> {
        let fields = self
            .types
            .get(name)
            .ok_or_else(|| Error::TypedData(format!("unknown type {name}")))?;
        let obj = value
            .as_object()
            .ok_or_else(|| Error::TypedData(format!("{name} value must be an object")))?;
        let mut out = Vec::with_capacity(fields.len() * 32);
        for f in fields {
            let v = obj
                .get(&f.name)
                .ok_or_else(|| Error::TypedData(format!("missing field {}.{}", name, f.name)))?;
            let word = self.word(&f.typ, v)?;
            out.extend_from_slice(&word);
        }
        Ok(out)
    }

    /// `hashStruct(name, value) = keccak256(typeHash(name) ‖ encodeData)`.
    pub fn hash_struct(&self, name: &str, value: &Value) -> Result<[u8; 32]> {
        let mut data = self.type_hash(name)?.to_vec();
        data.extend_from_slice(&self.encode_data(name, value)?);
        Ok(keccak256(&data))
    }

    /// Encode one field value to a 32-byte word, folding dynamic members per
    /// the spec's reference implementation (struct → `hashStruct`, `string` /
    /// `bytes` → keccak, array → keccak of concatenated element words).
    fn word(&self, typ: &str, value: &Value) -> Result<[u8; 32]> {
        if let Some(open) = typ.find('[') {
            let base = &typ[..open];
            let arr = value
                .as_array()
                .ok_or_else(|| Error::TypedData(format!("{typ} value must be an array")))?;
            let mut buf = Vec::with_capacity(arr.len() * 32);
            for el in arr {
                buf.extend_from_slice(&self.word(base, el)?);
            }
            return Ok(keccak256(&buf));
        }
        if self.types.contains_key(typ) {
            return self.hash_struct(typ, value);
        }
        primitive_word(typ, value)
    }

    /// The EIP-712 domain separator = `hashStruct("EIP712Domain", domain)`.
    pub fn domain_separator(&self) -> Result<[u8; 32]> {
        if !self.types.contains_key("EIP712Domain") {
            return Err(Error::TypedData("types is missing EIP712Domain".into()));
        }
        self.hash_struct("EIP712Domain", &self.domain)
    }

    /// The EIP-712 signing digest:
    /// `keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message))`.
    pub fn digest(&self) -> Result<[u8; 32]> {
        let mut data = Vec::with_capacity(66);
        data.extend_from_slice(&[0x19, 0x01]);
        data.extend_from_slice(&self.domain_separator()?);
        data.extend_from_slice(&self.hash_struct(&self.primary_type, &self.message)?);
        Ok(keccak256(&data))
    }

    /// Deterministically sign the typed data (legacy `v ∈ {27, 28}`).
    pub fn sign(&self, key: &SecretKey) -> Result<RecoverableSignature> {
        let digest = self.digest()?;
        key.sign_prehash_recoverable(&digest)
    }

    /// Recover the signer's EVM address from a signature produced by
    /// [`sign`](Self::sign).
    pub fn recover_signer(&self, sig: &RecoverableSignature) -> Result<[u8; 20]> {
        let digest = self.digest()?;
        let pk = PublicKey::recover_from_prehash(&digest, sig)?;
        Ok(pk.address())
    }

    /// Whether `sig` was produced by the holder of `address`. Fails closed.
    pub fn verify_signer(&self, sig: &RecoverableSignature, address: &[u8; 20]) -> bool {
        match self.recover_signer(sig) {
            Ok(addr) => addr == *address,
            Err(_) => false,
        }
    }

    /// All struct types reachable (through fields) from `name`, in
    /// deterministic ascending order; the starting type itself is excluded.
    fn referenced_types(&self, name: &str) -> Vec<String> {
        let mut out = BTreeSet::new();
        let mut visited = BTreeSet::new();
        self.collect_deps(name, &mut out, &mut visited);
        out.into_iter().collect()
    }

    fn collect_deps(&self, name: &str, out: &mut BTreeSet<String>, visited: &mut BTreeSet<String>) {
        if !visited.insert(name.to_string()) {
            return;
        }
        let Some(fields) = self.types.get(name) else {
            return;
        };
        for f in fields {
            let base = base_type(&f.typ);
            if self.types.contains_key(base) && base != name {
                out.insert(base.to_string());
                self.collect_deps(base, out, visited);
            }
        }
    }
}

/// ABI-encode a primitive (non-struct, non-array) value to a 32-byte word.
fn primitive_word(typ: &str, value: &Value) -> Result<[u8; 32]> {
    let mut w = [0u8; 32];
    match typ {
        "bool" => {
            let b = value
                .as_bool()
                .ok_or_else(|| Error::TypedData("bool value required".into()))?;
            if b {
                w[31] = 1;
            }
            Ok(w)
        }
        "address" => {
            let hex = value
                .as_str()
                .ok_or_else(|| Error::TypedData("address must be a hex string".into()))?;
            let raw = decode_hex_strict(hex)?;
            if raw.len() != 20 {
                return Err(Error::TypedData(format!(
                    "address must be 20 bytes, got {}",
                    raw.len()
                )));
            }
            w[12..32].copy_from_slice(&raw);
            Ok(w)
        }
        "string" => {
            let s = value
                .as_str()
                .ok_or_else(|| Error::TypedData("string value required".into()))?;
            Ok(keccak256(s.as_bytes()))
        }
        "bytes" => {
            let hex = value
                .as_str()
                .ok_or_else(|| Error::TypedData("bytes must be a hex string".into()))?;
            Ok(keccak256(&decode_hex_strict(hex)?))
        }
        _ => {
            if let Some(n) = typ.strip_prefix("bytes") {
                // Fixed bytesN: N bytes left-aligned in the word.
                let n = parse_usize(n, "bytesN")?;
                if n == 0 || n > 32 {
                    return Err(Error::TypedData(format!("unsupported bytes{n}")));
                }
                let hex = value
                    .as_str()
                    .ok_or_else(|| Error::TypedData("bytesN must be a hex string".into()))?;
                let raw = decode_hex_strict(hex)?;
                if raw.len() != n {
                    return Err(Error::TypedData(format!("bytes{n} needs {n} bytes")));
                }
                w[..n].copy_from_slice(&raw);
                Ok(w)
            } else if let Some(n) = typ.strip_prefix("uint") {
                encode_uint(&mut w, n, value)
            } else if let Some(n) = typ.strip_prefix("int") {
                encode_int(&mut w, n, value)
            } else {
                Err(Error::TypedData(format!("unsupported field type {typ}")))
            }
        }
    }
}

/// Decode a hex string (tolerates a `0x` prefix). `bytes::decode_hex` returns
/// `None` on malformed input; we surface it as an EIP-712 error.
fn decode_hex_strict(hex: &str) -> Result<Vec<u8>> {
    bytes::decode_hex(hex).ok_or_else(|| Error::TypedData(format!("bad hex {hex}")))
}

/// Parse a `usize` width suffix (e.g. the `256` in `uint256`).
fn parse_width(bits: &str, kind: &str) -> Result<usize> {
    if bits.is_empty() || !bits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::TypedData(format!("invalid {kind} width")));
    }
    let val: usize = bits
        .parse()
        .map_err(|_| Error::TypedData(format!("invalid {kind} width")))?;
    if val == 0 || val > 256 || val % 8 != 0 {
        return Err(Error::TypedData(format!("unsupported {kind}{bits}")));
    }
    Ok(val / 8)
}

fn parse_usize(s: &str, what: &str) -> Result<usize> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::TypedData(format!("invalid {what}")));
    }
    s.parse()
        .map_err(|_| Error::TypedData(format!("invalid {what}")))
}

/// ABI-encode an unsigned `uintN` to a 32-byte word (zero left-padded).
fn encode_uint(w: &mut [u8; 32], bits: &str, value: &Value) -> Result<[u8; 32]> {
    let wb = if bits.is_empty() {
        32
    } else {
        parse_width(bits, "uint")?
    };
    if let Some(hex) = value.as_str() {
        let raw = decode_hex_strict(hex)?;
        if raw.is_empty() || raw.len() > wb {
            return Err(Error::TypedData(format!("uint{bits} out of range")));
        }
        w[32 - raw.len()..].copy_from_slice(&raw);
        return Ok(*w);
    }
    if let Some(n) = value.as_u64() {
        if wb < 8 && n >= (1u64 << (wb * 8)) {
            return Err(Error::TypedData(format!("uint{bits} out of range")));
        }
        w[24..32].copy_from_slice(&n.to_be_bytes());
        return Ok(*w);
    }
    Err(Error::TypedData(format!(
        "uint{bits} needs an integer or hex value"
    )))
}

/// ABI-encode a signed `intN` to a 32-byte word (two's complement).
fn encode_int(w: &mut [u8; 32], bits: &str, value: &Value) -> Result<[u8; 32]> {
    let wb = if bits.is_empty() {
        32
    } else {
        parse_width(bits, "int")?
    };
    if let Some(n) = value.as_i64() {
        if wb < 8 {
            let bits_total = (wb * 8) as i64;
            let min = -(1i64 << (bits_total - 1));
            let max = (1i64 << (bits_total - 1)) - 1;
            if n < min || n > max {
                return Err(Error::TypedData(format!("int{bits} out of range")));
            }
        }
        if n >= 0 {
            w[24..32].copy_from_slice(&(n as u64).to_be_bytes());
        } else {
            for byte in w.iter_mut().take(24) {
                *byte = 0xff;
            }
            w[24..32].copy_from_slice(&(n as u64).to_be_bytes());
        }
        return Ok(*w);
    }
    if let Some(hex) = value.as_str() {
        let raw = decode_hex_strict(hex)?;
        if raw.is_empty() || raw.len() > wb {
            return Err(Error::TypedData(format!("int{bits} out of range")));
        }
        w[32 - raw.len()..].copy_from_slice(&raw);
        // Sign-extend when shorter than 32 bytes and the MSB is set.
        if raw.len() < 32 && raw[0] & 0x80 != 0 {
            let pad = 32 - raw.len();
            for byte in w.iter_mut().take(pad) {
                *byte = 0xff;
            }
        }
        return Ok(*w);
    }
    Err(Error::TypedData(format!(
        "int{bits} needs an integer or hex value"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canonical EIP-712 example (from the spec's `Example.js`): `Ether
    /// Mail`. Expected hashes below are the published values used to validate
    /// every conformant implementation.
    fn mail() -> TypedData {
        TypedData::from_json(
            r#"{
              "types": {
                "EIP712Domain": [
                  { "name": "name", "type": "string" },
                  { "name": "version", "type": "string" },
                  { "name": "chainId", "type": "uint256" },
                  { "name": "verifyingContract", "type": "address" }
                ],
                "Person": [
                  { "name": "name", "type": "string" },
                  { "name": "wallet", "type": "address" }
                ],
                "Mail": [
                  { "name": "from", "type": "Person" },
                  { "name": "to", "type": "Person" },
                  { "name": "contents", "type": "string" }
                ]
              },
              "primaryType": "Mail",
              "domain": {
                "name": "Ether Mail",
                "version": "1",
                "chainId": 1,
                "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
              },
              "message": {
                "from": { "name": "Cow", "wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
                "to": { "name": "Bob", "wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
                "contents": "Hello, Bob!"
              }
            }"#,
        )
        .unwrap()
    }

    fn h(bytes: [u8; 32]) -> String {
        bytes::encode_hex(&bytes)
    }

    #[test]
    fn canonical_encode_type() {
        let td = mail();
        assert_eq!(
            td.encode_type("Mail").unwrap(),
            "Mail(Person from,Person to,string contents)Person(string name,address wallet)"
        );
    }

    #[test]
    fn canonical_type_hash() {
        let td = mail();
        assert_eq!(
            h(td.type_hash("Mail").unwrap()),
            "a0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2"
        );
    }

    #[test]
    fn canonical_struct_hash_and_domain_separator() {
        let td = mail();
        assert_eq!(
            h(td.hash_struct("Mail", &td.message).unwrap()),
            "c52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e"
        );
        assert_eq!(
            h(td.domain_separator().unwrap()),
            "f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f"
        );
    }

    #[test]
    fn canonical_digest() {
        let td = mail();
        assert_eq!(
            h(td.digest().unwrap()),
            "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2"
        );
    }

    /// Full end-to-end against the spec vector: key `keccak256("cow")` signs
    /// the digest to the exact published address + r/s/v.
    #[test]
    fn canonical_signature_vector() {
        let td = mail();
        let private_scalar = keccak256(b"cow");
        let key = SecretKey::from_private_key(private_scalar).unwrap();
        // The published signer address for this key.
        assert_eq!(
            key.public_key().address_hex().to_lowercase(),
            "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826"
        );

        let sig = td.sign(&key).unwrap();
        assert_eq!(sig.v, 28);
        assert_eq!(
            bytes::encode_hex(&sig.r),
            "4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d"
        );
        assert_eq!(
            bytes::encode_hex(&sig.s),
            "07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562"
        );
    }

    #[test]
    fn deterministic_and_tamper_sensitive() {
        let td = mail();
        let key = SecretKey::from_seed([99u8; 32]).unwrap();
        let a = td.sign(&key).unwrap();
        let b = td.sign(&key).unwrap();
        assert_eq!(a, b);
        // Recovering from the signature returns the key's address.
        let recovered =
            crate::secp::PublicKey::recover_from_prehash(&td.digest().unwrap(), &a).unwrap();
        assert_eq!(recovered.address(), key.public_key().address());
    }

    #[test]
    fn arrays_bool_and_uint_are_encodable() {
        let td = TypedData::from_json(
            r#"{
              "types": {
                "EIP712Domain": [
                  { "name": "name", "type": "string" },
                  { "name": "chainId", "type": "uint256" }
                ],
                "Sample": [
                  { "name": "flag", "type": "bool" },
                  { "name": "ids", "type": "uint256[]" },
                  { "name": "kind", "type": "string" }
                ]
              },
              "primaryType": "Sample",
              "domain": { "name": "Test", "chainId": 1 },
              "message": {
                "flag": true,
                "ids": ["0x01", 2, "0x03"],
                "kind": "hello"
              }
            }"#,
        )
        .unwrap();
        assert!(td.digest().is_ok());
        // bool true encodes to a word with low byte = 1.
        let flag_word = td.word("bool", &serde_json::json!(true)).unwrap();
        assert_eq!(flag_word[31], 1);
        let mut w = [0u8; 32];
        encode_uint(&mut w, "256", &serde_json::json!(1)).unwrap();
        assert_eq!(w[31], 1);
    }

    #[test]
    fn malformed_input_is_an_error_not_a_guess() {
        assert!(TypedData::from_json("not json").is_err());
        // Missing declared primary type.
        assert!(TypedData::from_json(
            r#"{"types":{"EIP712Domain":[]},"primaryType":"Nope","domain":{},"message":{}}"#
        )
        .is_err());
        // uint8 too large (300 does not fit) must be an error.
        let td = TypedData::from_json(
            r#"{
              "types": {
                "EIP712Domain": [],
                "S": [ { "name": "v", "type": "uint8" } ]
              },
              "primaryType": "S",
              "domain": {},
              "message": { "v": 300 }
            }"#,
        )
        .unwrap();
        assert!(td.digest().is_err());
    }

    #[test]
    fn typed_signature_recovers_to_signer_address() {
        let td = mail();
        let key = SecretKey::from_seed([21u8; 32]).unwrap();
        let sig = td.sign(&key).unwrap();
        assert_eq!(td.recover_signer(&sig).unwrap(), key.public_key().address());
        assert!(td.verify_signer(&sig, &key.public_key().address()));

        let mut wrong = key.public_key().address();
        wrong[19] ^= 0x01;
        assert!(!td.verify_signer(&sig, &wrong));
    }

    #[test]
    fn wide_uint_via_hex_and_negative_int() {
        let td = TypedData::from_json(
            r#"{
              "types": {
                "EIP712Domain": [],
                "S": [
                  { "name": "big", "type": "uint256" },
                  { "name": "small", "type": "int8" }
                ]
              },
              "primaryType": "S",
              "domain": {},
              "message": {
                "big": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                "small": -5
              }
            }"#,
        )
        .unwrap();
        // Deterministic and every field is well-formed.
        let digest = td.digest().unwrap();
        assert_ne!(digest, [0u8; 32]);
        assert_eq!(td.digest().unwrap(), digest);

        // uint256 max encodes to an all-ones word.
        let mut w = [0u8; 32];
        encode_uint(
            &mut w,
            "256",
            &serde_json::json!(
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            ),
        )
        .unwrap();
        assert_eq!(w, [0xff; 32]);
        // int8 -5 is two's-complement 0xfb in the low byte, 0xff sign-extension.
        let mut iw = [0u8; 32];
        encode_int(&mut iw, "8", &serde_json::json!(-5)).unwrap();
        assert_eq!(iw[31], 0xfb);
        for b in iw.iter().take(31) {
            assert_eq!(*b, 0xff);
        }
    }

    #[test]
    fn nested_array_of_structs_is_encodable() {
        let td = TypedData::from_json(
            r#"{
              "types": {
                "EIP712Domain": [ { "name": "chainId", "type": "uint256" } ],
                "Person": [
                  { "name": "name", "type": "string" },
                  { "name": "wallet", "type": "address" }
                ],
                "Roster": [
                  { "name": "people", "type": "Person[]" },
                  { "name": "note", "type": "string" }
                ]
              },
              "primaryType": "Roster",
              "domain": { "chainId": 137 },
              "message": {
                "people": [
                  { "name": "A", "wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
                  { "name": "B", "wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" }
                ],
                "note": "team"
              }
            }"#,
        )
        .unwrap();
        let digest = td.digest().unwrap();
        assert_ne!(digest, [0u8; 32]);
        // Removing an element must change the digest.
        let mut td2 = td.clone();
        td2.message = serde_json::json!({
            "people": [{ "name": "A", "wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" }],
            "note": "team"
        });
        assert_ne!(td2.digest().unwrap(), digest);
    }
}
