//! `did_round_trip` — a seed becomes an identity, the identity becomes a `did:key`, and a
//! statement signed with it verifies (while a tampered one does not).
//!
//! Also shows the two refusals that matter: an unsupported `did:key` multicodec, and a
//! keystore lookup for an alias that was never stored.
//!
//! Usage:
//! ```text
//! cargo run -p amos-identity --example did_round_trip
//! ```

use amos_identity::did::{did_key_from_public_key, parse_did_key};
use amos_identity::keystore::Keystore;
use amos_identity::sign::{sign_statement, verify_statement};
use amos_identity::{Curve, IdentityKey};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The same seed derives the same identity — which is what makes recovery and tests
    // reproducible.
    let seed = [7u8; 32];
    let first = IdentityKey::from_seed(Curve::Ed25519, seed)?;
    let second = IdentityKey::from_seed(Curve::Ed25519, seed)?;
    let did = first.did()?;
    println!("did:key              {did}");
    println!("same seed → same did {}", did == second.did()?);

    // A different seed is a different identity (no collisions by accident).
    let other = IdentityKey::from_seed(Curve::Ed25519, [8u8; 32])?;
    println!("other seed → same did {}", did == other.did()?);

    // The did round-trips back to its curve + public key bytes.
    let (curve, public) = parse_did_key(&did)?;
    println!("parsed: curve={curve:?} public_bytes={}", public.len());
    println!(
        "re-encoded equals the original: {}",
        did_key_from_public_key(curve, &public)? == did
    );

    // Sign a statement and verify it against the *did* (not against a key we happen to hold).
    let statement = b"amos: this device belongs to its owner";
    let signature = sign_statement(&first, statement);
    println!(
        "signature well-formed={} hex={}…",
        signature.is_well_formed(),
        &signature.to_hex()[..16]
    );
    println!(
        "verify(statement)={}",
        verify_statement(&did, statement, &signature)
    );
    println!(
        "verify(tampered) ={}",
        verify_statement(&did, b"a different statement", &signature)
    );

    // A did:key with a multicodec this build does not support is refused, not half-parsed.
    match parse_did_key("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK") {
        Ok((curve, bytes)) => println!(
            "parsed a real-world ed25519 did: {curve:?}, {} bytes",
            bytes.len()
        ),
        Err(e) => println!("refused: {e}"),
    }
    match parse_did_key("did:key:zNOTAVALIDMULTICODEC") {
        Ok(_) => println!("UNEXPECTED: accepted an unsupported did:key"),
        Err(e) => println!("unsupported did:key refused: {e}"),
    }

    // A keystore is the seam storage goes through (in-memory here, platform on device).
    let mut store = Keystore::new();
    store.insert("primary", &first);
    println!("keystore aliases={:?} len={}", store.list(), store.len());
    println!(
        "round trip through the store: {}",
        store
            .get("primary")
            .transpose()?
            .map(|k| k.did().ok() == Some(did.clone()))
            .unwrap_or(false)
    );
    println!(
        "missing alias returns None: {}",
        store.get("nope").is_none()
    );
    Ok(())
}
