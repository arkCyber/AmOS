# amos-identity — digital identity (DID) domain core

`did:key` encoding and parsing plus a deterministic key/wallet core: identity keys, a
keystore abstraction and signing — layered over **[`crates/amos-web3`](../amos-web3/README.md)**
for the curve maths. Part of **[Amos](../../README.md)**. Design record:
[`docs/identity-web3.md`](../../docs/identity-web3.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `did:key` **encode and parse** (`src/did.rs`): a `did:key:z…` identifier round-trips, and
  an unsupported multicodec is refused rather than half-decoded.
- `IdentityKey` / `Ed25519Key` / `Curve` (`src/key.rs`): a key derived from a caller-supplied
  seed is **deterministic** (same seed, same identity) — which is what makes tests and
  recovery reproducible.
- `src/keystore.rs` is the storage **seam**: the domain never reads a file directly, so the
  same logic runs against an in-memory store in tests and the platform store on a device.
- `src/sign.rs` signs and verifies through the same seam, so a signature's validity is a
  domain answer, not a platform one.

It is **not** a wallet, a network client or a verifiable-credential implementation: keys and
signatures only. The EVM/secp256k1 side lives in `crates/amos-web3`.

## Layout

| file | what |
|---|---|
| `src/did.rs` | `did:key` encode/parse, multicodec handling |
| `src/key.rs` | `IdentityKey`, `Ed25519Key`, `Curve` |
| `src/keystore.rs` | the key-storage seam |
| `src/sign.rs` | sign/verify over the seam |
| `src/error.rs` | `Error`, `Result` |

## Build & test

```bash
cargo test -p amos-identity
cargo clippy -p amos-identity --all-targets -- -D warnings
cargo fmt -p amos-identity -- --check
```

## Examples

```bash
# A key from a seed → its did:key → a signature and its verification.
cargo run -p amos-identity --example did_round_trip
```

| example | shows |
|---|---|
| `did_round_trip` | the same seed producing the same identity twice, the resulting `did:key`, a message signed and verified, a tampered message being rejected, and an unsupported `did:key` multicodec being refused |

## Honest boundaries

- **Seeds are the caller's responsibility**: this crate derives deterministically and never
  pretends a weak seed is strong.
- **No network resolution**: a `did:key` is self-describing by construction; `did:web` or
  registry lookups are not implemented.
- **No secure-element claim**: whether the platform keystore is hardware-backed is a device
  property; the seam only decides *where* the bytes live.
- **Not a wallet**: no balances, no transaction signing, no chain interaction.

## Related

- [`docs/identity-web3.md`](../../docs/identity-web3.md) — the DID + EVM design record.
- [`crates/amos-web3`](../amos-web3/README.md) — secp256k1, keccak256, EIP-191/712.
