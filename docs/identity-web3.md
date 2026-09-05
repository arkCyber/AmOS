# Digital identity (DID) & Web3 signing — design & contract

Amos should let the *user* own an identity that isn't tied to a vendor: a
self-sovereign Decentralized Identifier (`did:key`) backed by a key on the
device, plus the ability to *prove control* with the same signatures the open
Web3 ecosystem speaks. This doc is the design + honest-boundary contract for
the two **domain-core crates** that encode that, with **no UI / daemon / gRPC
wiring** (that is the next, host layer).

## Scope

Two pure, deterministic Rust workspace crates, following the repo convention
(like `amos-appstore`, `amos-mail`, `amos-display`) that *domain logic lives in
a transport-agnostic core* and real platforms plug in behind seams later.

| Crate | Owns |
|-------|------|
| [`amos-web3`](../crates/amos-web3) | Low-level EVM crypto: deterministic secp256k1 keys, keccak256, EVM addresses, **EIP-191** `personal_sign`, **EIP-712** typed-data hashing/signing. |
| [`amos-identity`](../crates/amos-identity) | Higher-level identity: `Curve`, unified [`IdentityKey`] (Ed25519 + secp256k1), **`did:key`** encode/parse, statement sign/verify against a DID, and a password-wrapped at-rest **keystore**. |

`amos-identity` depends on `amos-web3` for its secp256k1 side (so `did:key ↔
wallet` are provably the same person) and on `ed25519-dalek` for Ed25519.

## Data flow

```text
            32-byte seed  (caller-supplied entropy seam)
                    │
   ┌────────────────┴───────────────────┐
   ▼                                    ▼
[IdentityKey]                       [Keystore]
 Ed25519 | Secp256k1(amos-web3)     alias → seed
   │                                    │ seal/unseal
   │ did()                             PBKDF2-HMAC-SHA256 + ChaCha20-Poly1305
   ▼                                    (salt+nonce = caller seam)
did:key:z…  ◀── did:key_from_public_key(curve, pubkey)
   │
   └─ sign_statement / verify_statement (against the DID)
```

## `amos-web3`

- **Determinism / entropy.** A `SecretKey` is built from a 32-byte seed used
  **directly** as the secp256k1 scalar (mirroring Ed25519 seed semantics and how
  an existing EVM private key is carried). Seeds outside `[1, n-1]` are
  rejected, never silently remapped. ECDSA nonces are deterministic (RFC 6979)
  and signatures are canonical **low-s**, `v ∈ {27, 28}`. There is **no
  randomness inside the crate** — generating a new wallet means the caller
  supplies 32 OS-entropy bytes.
- **API** (`crates/amos-web3/src`): `hash::keccak256`, `secp::{SecretKey,
  PublicKey, RecoverableSignature, SECP256K1_ORDER}`, `eip191::{sign_personal,
  recover_signer, verify_signer}`, `eip712::{TypedData, …}` (parse the canonical
  `{ types, primaryType, domain, message }` JSON, `domain_separator`,
  `digest`, `sign`, plus `encode_type`/`type_hash`/`hash_struct`).
- **EIP-712** follows the spec's reference implementation: dynamic members are
  folded to a 32-byte word (`string`/`bytes` → keccak, nested struct → its
  `hashStruct`, array → keccak of concatenated element words). Supported field
  types: `address`, `bool`, `string`, `bytes`, `bytesN`, `uintN`, `intN`,
  arrays `T[]`/`T[k]`, nested structs. Unknown types return `Error`, never a
  guess.

## `amos-identity`

- `key` — `Curve { Ed25519, Secp256k1 }`, `Ed25519Key`, and `IdentityKey`
  (build from a seed, export seed, `public_key_bytes`, `did()`).
- `did` — `did_key_from_public_key` / `parse_did_key` for multicodecs
  `0xed01` (Ed25519, 32-byte pubkey) and `0xe701` (secp256k1, 33-byte
  compressed pubkey), base58btc `z…` multibase.
- `sign` — `sign_statement`/`verify_statement`. Ed25519 signs the raw bytes;
  secp256k1 signs an **EIP-191** `personal_sign` and verification recovers the
  signer's EVM address and compares it to the DID's embedded key. Everything
  fails closed (`false` on malformed/tampered input). A **typed-data wallet
  bridge** (`sign_typed_data`/`verify_typed_data`) lets a secp256k1 identity
  sign/verify an [EIP-712] message against its `did:key`.
- `keystore` — alias-keyed wallet. At-rest `seal`/`from_sealed`: PBKDF2-HMAC-
  SHA256 key stretch + ChaCha20-Poly1305 authenticated encryption; every
  decrypted payload starts with a versioned `FORMAT_MAGIC` so the format can
  evolve safely. See seams.

## Correctness anchors (external test vectors)

- `keccak256("")` and `keccak256("abc")` standard vectors.
- secp256k1 scalar `1` → EVM address `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`.
- The canonical **EIP-712 "Ether Mail"** example: `encodeType`,
  `typeHash = 0xa0cedeb2…`, `hashStruct(Mail) = 0xc52c0ee5…`,
  `domainSeparator = 0xf2cee375…`, digest `0xbe609aee…`; and signing with key
  `keccak256("cow")` reproduces the published signer address
  `0xcd2a3d…dd826` and exact `(r, s, v)` — validating address derivation,
  EIP-712 digest, and deterministic RFC6979 ECDSA together.

## Honest seams / boundaries (deliberately not faked here)

1. **New-key entropy** — the OS/hardware RNG must feed the 32-byte seed.
2. **Keystore salt & AEAD nonce** — must be fresh random per seal; this crate
   takes them as parameters (tests use fixed values).
3. **At-rest persistence format** — `seal` returns an opaque blob; writing it
   to a file/IndexedDB and a stable on-disk schema are host concerns.
4. **`did:key` verification** — proves the *signature* matches the key embedded
   in the DID (self-consistency). Trusting that a given DID belongs to a real
   person / that an EVM address has funds is an application/registry concern,
   outside this core (the same note as `amos-appstore`'s publisher trust).
5. **No UI / daemon / gRPC** — a future wallet System-UI app, a daemon
   keystore RPC, and OS keystore (Android Keystore / Secure Enclave) integration
   are later host layers over these deterministic cores.
6. **EIP-712 subset** — only the documented field types; exotic fixed-point /
   custom encodings are rejected loudly.

## Verification

```bash
cargo test -p amos-web3 -p amos-identity          # 41 unit tests + doctests
cargo clippy -p amos-web3 -p amos-identity --all-targets -- -D warnings  # clean
```

Both crates honor the repo P0-1 gate (no `unwrap`/`expect`/`panic` in
non-test code; the single documented exception is `sign_statement`'s
infallible digest-sign).
