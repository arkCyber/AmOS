//! `sign_and_recover` — seed → EVM address → EIP-191 and EIP-712 signatures, all offline.
//!
//! Ethereum's signing rules are unforgiving about details (keccak256, not SHA3-256; the
//! `personal_sign` prefix; the EIP-712 domain separator). This example shows the whole path
//! and, just as importantly, that recovery returns the signer — and that a tampered payload
//! does **not** recover to it.
//!
//! Usage:
//! ```text
//! cargo run -p amos-web3 --example sign_and_recover
//! ```

use amos_web3::eip191::{personal_message_digest, recover_signer, sign_personal, verify_signer};
use amos_web3::eip712::TypedData;
use amos_web3::hash::keccak256;
use amos_web3::secp::SecretKey;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The same seed is the same key and therefore the same address, twice.
    let seed = [0x42u8; 32];
    let key = SecretKey::from_seed(seed)?;
    let again = SecretKey::from_seed(seed)?;
    let address = key.public_key().address_hex();
    println!("address             {address}");
    println!(
        "same seed → same address {}",
        address == again.public_key().address_hex()
    );

    // keccak256 (EVM) — not SHA3-256: they differ, and using the wrong one silently yields
    // wrong addresses.
    let digest = keccak256(b"");
    println!("keccak256(\"\")      {}", hex(&digest));

    // EIP-191 `personal_sign`.
    let message = b"AmOS: sign in as the device owner";
    let personal_digest = personal_message_digest(message);
    let sig = sign_personal(&key, message)?;
    let recovered = recover_signer(message, &sig)?;
    println!("eip191 digest        {}", hex(&personal_digest));
    println!("eip191 signature     {}", sig.to_hex());
    println!("recovered signer     0x{}", hex(&recovered));
    println!(
        "verify_signer        {}",
        verify_signer(message, &sig, &key.public_key().address())
    );
    println!(
        "tampered message     recovers to the signer? {}",
        recover_signer(b"another message", &sig)
            .map(|a| a == key.public_key().address())
            .unwrap_or(false)
    );

    // EIP-712 typed data: the same structure a wallet shows before signing.
    let typed_json = r#"{
      "types": {
        "EIP712Domain": [
          {"name": "name", "type": "string"},
          {"name": "version", "type": "string"},
          {"name": "chainId", "type": "uint256"}
        ],
        "Transfer": [
          {"name": "to", "type": "address"},
          {"name": "amount", "type": "uint256"}
        ]
      },
      "primaryType": "Transfer",
      "domain": {"name": "AmOS", "version": "1", "chainId": 1},
      "message": {
        "to": "0x000000000000000000000000000000000000dead",
        "amount": "0x0de0b6b3a7640000"
      }
    }"#;
    let typed = TypedData::from_json(typed_json)?;
    let tdigest = typed.digest()?;
    let tsig = typed.sign(&key)?;
    println!("eip712 digest        {}", hex(&tdigest));
    println!(
        "eip712 recovered     0x{}",
        hex(&typed.recover_signer(&tsig)?)
    );
    println!(
        "eip712 verify        {}",
        typed.verify_signer(&tsig, &key.public_key().address())
    );

    // A malformed seed is refused rather than silently zero-padded.
    match SecretKey::from_private_key([0u8; 32]) {
        Ok(_) => println!("UNEXPECTED: accepted an all-zero private key"),
        Err(e) => println!("all-zero private key refused: {e}"),
    }
    Ok(())
}

/// Lower-case hex, so the output is copy-pasteable into a block explorer.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
