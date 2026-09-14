# amos-network-guard — egress data-plane firewall (anti-telemetry)

A pure policy model plus a `NetworkGuard` seam: which destinations may leave the device, with
a deterministic mock for tests and two root-gated backends (`vpn` for a rootless per-app
tunnel, `nftables` for AOSP/rooted rules). Part of **[Amos](../../README.md)**. Design
record: [`docs/anti-telemetry-egress-guard.md`](../../docs/anti-telemetry-egress-guard.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `Policy` / `RuleSet` / `Destination` / `Effect` model the decision: a normalized domain
  (`normalize_domain`) or address maps to allow/deny, and the model is pure — the same
  question always gets the same answer.
- `NetworkGuard` is the seam. `MockNetworkGuard` records what it was asked and answers
  deterministically; `VpnNetworkGuard` (feature `vpn`) and `NftablesNetworkGuard` (feature
  `nftables`) are the real backends, and both need privileges the host does not have.
- `audit.rs` (`EgressEvent`, `EgressKind`, `EgressCounter`) keeps the record of what was seen
  and decided, so a blocked flow is explainable after the fact.

It is **not** an antivirus or a TLS inspector: it decides *whether* a destination is allowed,
not what the payload means.

## Layout

| file | what |
|---|---|
| `src/policy.rs` | `Policy`, `RuleSet`, `Destination`, `Effect`, `normalize_domain` |
| `src/guard.rs` | `NetworkGuard` seam + `MockNetworkGuard` |
| `src/audit.rs` | `EgressEvent`, `EgressKind`, `EgressCounter` |
| `src/vpn.rs` | *(feature `vpn`)* the rootless per-app tunnel backend |
| `src/nftables.rs` | *(feature `nftables`)* the AOSP/rooted rule backend |
| `src/error.rs` | `Error`, `Result` |

## Build & test

```bash
cargo test -p amos-network-guard
cargo check -p amos-network-guard --features nftables,vpn   # both backends compile
cargo run -p amos-network-guard --example probe_permission  # what this host may do
cargo clippy -p amos-network-guard --all-targets --features nftables,vpn -- -D warnings
```

## Examples

```bash
# Decide a few destinations against a policy, and ask the host what it could enforce.
cargo run -p amos-network-guard --example probe_permission
```

| example | shows |
|---|---|
| `probe_permission` | the policy deciding allowed/denied destinations (with domain normalization), the mock backend recording the calls, and the privilege probe that says whether a real backend could be installed **on this host** |

## Honest boundaries

- **The real backends need root or a VPN service**: the probe reports the truth ("not
  permitted here") instead of pretending enforcement is active.
- **DNS is not intercepted**: a policy on a domain can be bypassed by a resolved IP unless
  the backend also covers addresses.
- **This is not a security boundary against a hostile app with root** — like every egress
  control on Android, it is a policy layer.
- **No payload inspection**: telemetry detection by content belongs to
  [`crates/amos-telemetry-spy`](../amos-telemetry-spy/README.md).

## Related

- [`docs/anti-telemetry-egress-guard.md`](../../docs/anti-telemetry-egress-guard.md) — the
  policy model and the two backends.
- [`proto/netguard.proto`](../../proto/netguard.proto) — the service contract.
- [`crates/amos-telemetry-spy`](../amos-telemetry-spy/README.md) — the passive observer.
