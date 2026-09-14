# amos-web3 — EVM digital-signature domain core

Deterministic secp256k1 keys from a 32-byte seed, keccak256, EVM address derivation,
EIP-191 `personal_sign` and EIP-712 typed-data hashing — implemented in pure Rust, offline,
with no node connection. Part of **[Amos](../../README.md)**. Design record:
[`docs/identity-web3.md`](../../docs/identity-web3.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `secp.rs`: a key from a seed is **deterministic** (same seed → same key → same address),
  which is what makes recovery and tests reproducible; a malformed seed is refused.
- `hash.rs`: keccak256 (the EVM hash, not SHA3-256 — a distinction this crate gets right and
  documents, because getting it wrong silently produces wrong addresses).
- `eip191.rs` / `eip712.rs`: the two signing hashes apps actually require. EIP-712 builds the
  domain separator and the struct hash, with the dependency walk **iterative** (no recursion
  over attacker-controlled type declarations).
- `bytes.rs`: hex/byte helpers with strict parsing (a truncated signature is an error, not a
  best-effort value).

It is **not** an RPC client or a wallet: no JSON-RPC, no balances, no transaction broadcast,
no chain ids beyond what a signature needs.

## Layout

| file | what |
|---|---|
| `src/secp.rs` | key derivation, signing, ECDSA recovery |
| `src/hash.rs` | keccak256 (EVM) |
| `src/eip191.rs` | `personal_sign` hashing |
| `src/eip712.rs` | typed-data hashing + domain separator |
| `src/bytes.rs` | strict hex/byte helpers |
| `src/error.rs` | the error type |

## Build & test

```bash
cargo test -p amos-web3
cargo clippy -p amos-web3 --all-targets -- -D warnings
cargo fmt -p amos-web3 -- --check
```

## Examples

```bash
# Seed → address → EIP-191 and EIP-712 signatures, all offline.
cargo run -p amos-web3 --example sign_and_recover
```

| example | shows |
|---|---|
| `sign_and_recover` | the same seed producing the same EVM address twice, an EIP-191 `personal_sign` and an EIP-712 typed-data hash, signature recovery returning the signer, and a tampered payload failing to recover to it |

## Honest boundaries

- **Keys here are software keys**: there is no secure element, no hardware wallet and no key
  attestation in this crate.
- **No transaction construction**: this crate signs hashes; building and broadcasting a
  transaction is an application concern.
- **No consensus/chain state**: addresses and signatures are computed offline.
- **Crypto is not audited**: the curves are implemented on `secp256k1`/`sha3`, but the
  composition (EIP-712 in particular) is a prototype, as the design record states.

## Related

- [`docs/identity-web3.md`](../../docs/identity-web3.md) — the DID + EVM design record and its
  honest boundaries.
- [`crates/amos-identity`](../amos-identity/README.md) — `did:key`, keystore and signing.
