# Delivery notes — DID / Web3 signing domain core (2026-09-05)

Commit-message-ready summary + changeset + honest boundaries for the
`amos-identity` / `amos-web3` digital-identity & Web3-signing **domain-core**
work. Scope chosen with the author: **pure deterministic domain crates + tests
+ docs, no UI/daemon/proto wiring.**

## Suggested commit message

> **digital identity & Web3 signing domain core (Rust)**: new `amos-web3`
> (deterministic secp256k1 keys from seed, keccak256, EVM address derivation,
> EIP-191 `personal_sign` + EIP-712 typed-data hashing/signing; canonical low-s,
> no PRNG in the core) and `amos-identity` (`did:key` Ed25519+secp256k1
> multicodecs, unified `IdentityKey`, statement sign/verify against a DID, and
> a password-wrapped at-rest keystore with explicit salt/nonce seams), both
> registered in the workspace + delivery docs. Validated against the canonical
> EIP-712 "Ether Mail" vector (digest + exact r/s/v) and standard keccak/secp
> vectors. 36 tests, clippy `-D warnings` clean.

## Changeset

**Workspace**
- `Cargo.toml` — add `crates/amos-web3`, `crates/amos-identity` to members;
  add `amos-web3` / `amos-identity` to `[workspace.dependencies]`.
- `Cargo.lock` — new pure crypto deps: `k256`, `sha3`, `ed25519-dalek`(reuse),
  `bs58`, `hmac`, `pbkdf2`, `chacha20poly1305`, `generic-array`.

**New crate `amos-web3`** (`crates/amos-web3/src`)
- `lib.rs`, `error.rs`, `bytes.rs` (hex), `hash.rs` (keccak256), `secp.rs`,
  `eip191.rs`, `eip712.rs`. Public API: `SecretKey`/`PublicKey`/
  `RecoverableSignature`, `eip191::{personal_message_digest, sign_personal,
  recover_signer, verify_signer}`, `eip712::TypedData` (+ `from_json`,
  `domain_separator`, `digest`, `sign`, `recover_signer`/`verify_signer`,
  `encode_type`, `type_hash`, `hash_struct`). 25 unit tests.

**New crate `amos-identity`** (`crates/amos-identity/src`)
- `lib.rs`, `error.rs`, `key.rs` (`Curve`, `Ed25519Key`, `IdentityKey`),
  `did.rs` (`did:key` encode/parse), `sign.rs` (statement sign/verify +
  EIP-712 typed-data wallet bridge), `keystore.rs` (password-wrapped
  seal/unseal with versioned `FORMAT_MAGIC`). 16 unit tests.

**Docs**
- `docs/identity-web3.md` — design, data flow, honest seams.
- `docs/DELIVERY_NOTES_2026-09-05-did-web3.md` — this file.
- `README.md` — two doc links added.

## Design decisions

- **Deterministic core, no PRNG**; a 32-byte seed is used directly as the
  secp256k1 scalar (reject out-of-range rather than silently remap) — matches
  Ed25519 seed semantics and existing-key import.
- **Canonical low-s** signatures, `v ∈ {27,28}`, recoverable; verified against
  ethereumjs `ecsign` output.
- **EIP-712 reference implementation** (fold-dynamic-to-word), not ABI-offset.
- **Cross-crate proof**: secp256k1 `did:key` signs an EIP-191 statement, and
  verification recovers the EVM address and checks it equals the DID's embedded
  key — so DID identity and wallet are provably the same key.
- P0-1 gate honored (no `unwrap`/`expect`/`panic` outside tests; the one
  documented infallible `expect` in `sign_statement` is `#[allow]`ed).

## Honest boundaries (see `docs/identity-web3.md` §seams)

New-key entropy, keystore salt/nonce, persistence format, DID-trust (who the
DID belongs to), and all **UI / daemon / gRPC / OS-keystore** wiring are
deliberately **not** implemented here; they are later host layers over these
deterministic cores. EIP-712 supports only the documented field-type subset and
rejects unknown types loudly.

## Verification

```bash
cargo test -p amos-web3 -p amos-identity              # 41 unit tests + doctests
cargo clippy -p amos-web3 -p amos-identity --all-targets -- -D warnings  # clean
```

## Known limits / next steps

- Real-device Android Keystore / Secure Enclave and per-app capability gating
  of signing is a future OS-keystore seam.
- A wallet System-UI app (create/import key, show `did:key`, sign a typed
  message) plus a daemon keystore RPC would consume these crates.
- At-rest schema + backup/restore not yet specified.
