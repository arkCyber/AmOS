# amos-link-cli — drive and inspect the robot middleware from a terminal

`amos-link-cli` is the terminal for **[AmOS-Link](../amos-link/README.md)**: it builds one
in-process link node and exercises the paths an operator cares about — publish, subscribe,
the topic inventory, a latency benchmark, discovery and the JSON→motor-frame translation —
or, with `--socket`, reads the **running** daemon's control plane instead of a local node.
Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

```text
amos-link-cli status                   # identity, counters, peers, clock freshness (JSON)
amos-link-cli topics                   # the topic inventory of a live node
amos-link-cli pub   --topic amos/dog1/control/joints --action '{"action":"trot"}'
amos-link-cli sub   --pattern 'amos/**' --count 3 --timeout-ms 2000   # 0 = wait forever
amos-link-cli bench --count 2000 --size 4096      # real publish→decode latency
amos-link-cli discover --peer dog1 --peer mini-brain
amos-link-cli discover --lan --peer dog1 --seconds 9   # real UDP beacons; the local node
                                                      # never appears as a peer — the
                                                      # filtered count is printed instead
amos-link-cli watch --seconds 5                   # heartbeat + federation: is the link alive
amos-link-cli state --timeout-ms 2000             # what robots report about themselves
amos-link-cli motor --action '{"action":"trot","speed":0.5}'   # frames + hex
amos-link-cli motor --action '{"action":"stand"}' --device /run/motor.sock  # …onto a real bus
```

Four honest notes about scope, all enforced in code rather than promised:

- `--transport zenoh` and `discover --lan` are the real network paths and need the matching
  build feature (`zenoh` / `lan`). Without it the command **says so** instead of silently
  using another transport.
- **Arguments are bounded where the platform is**: `--seconds` beyond what the clock can
  represent and `--size` above the wire ceiling (16 MiB − 64, since a larger bench payload
  could never be published) are refused at parse time with exit 2 — they used to panic
  (`overflow when adding duration to instant`) or abort (`capacity overflow`). A large
  `--count` stays legal ("keep publishing" is a legitimate request) and no longer reserves a
  vector it could never fill.
- `pub`/`sub` carry `AgentAction` payloads (text or JSON) — the one shape a human and an
  agent can both produce without a schema.
- `sub` waits for `--count` frames, so **without `--timeout-ms` it waits forever** when
  nothing is publishing — a scripted probe must bound it. Expiry is reported
  (`timeout after …ms with no frame (received N)`) and the run still exits 0: a bounded
  observation that saw nothing is a fact, not a failure.
- **The loss figures say what they cover.** The per-publisher sequence tracker is bounded
  (`MAX_TRACKED_STREAMS`, because its keys are publisher ids off the wire), so `sub`/`watch`
  print `untracked=` and `tracking=complete|full` beside `missing=`/`lost=`: when the table
  filled up, `tracking=full` is the honest answer, never a clean loss figure that quietly
  stopped accounting.
- Every command that joins the peer federation (`discover --bus`, `watch`, `discover --lan`)
  announces at the same cadence — a beacon every `TTL/3` (1 s for the default 3 s TTL), from
  one helper. Announcing faster is legal but it is wire noise, and it makes this node's own
  `published` counter read mostly its own beacons.

## Layout

| file | what |
|---|---|
| `src/main.rs` | the binary: args → `parse_args` → `run`, exit codes (2 = usage, 1 = failure) |
| `src/lib.rs` | `parse_from`/`parse_args` (manual parser, no clap), `run`, `USAGE`, and one function per command |
| `tests/cli_smoke.rs` | process-level smoke: runs the **shipped binary** (argv in, exit code + stdout out) |

## Build & test

```bash
cargo test -p amos-link-cli                     # unit (parser) + process-level smoke
cargo test -p amos-link-cli --features lan      # `discover --lan` compiles (real beacons)
cargo run -p amos-link-cli -- --help
cargo clippy -p amos-link-cli --all-targets --features lan,zenoh -- -D warnings
```

## Examples

```bash
# Embed the CLI's command set in a program (no shell): parse argv as data, run in-process.
cargo run -p amos-link-cli --example embed_commands
```

| example | shows |
|---|---|
| `embed_commands` | `parse_from` + `run` (what `main.rs` calls) used from a harness: runs `status`, `bench` and `motor` and prints what the shell would have printed |

## Remote mode (`--socket`)

`status` / `topics` / `pub` / `watch` accept `--socket <PATH>` and then talk to the
daemon's live control plane (`proto/robot_link.proto` over the UDS) instead of a local
node. Every line names the socket, so a local answer can never be mistaken for the robot's.
`status` additionally reports **what each robot says about its own actuation**
(`ListActuations`): armed / torque cut (and why) / gait / the last refusal — the same facts
`state` prints, read from the daemon that folded them instead of from the wire. A robot that
has not reported since the daemon started watching is named as absent, never as idle:

```bash
amos-link-cli status --socket /tmp/amos-ai.sock --json
amos-link-cli topics --socket /tmp/amos-ai.sock
amos-link-cli pub    --socket /tmp/amos-ai.sock --topic amos/dog1/control/joints \
                     --action '{"action":"trot"}' --count 2 --hz 2
amos-link-cli watch  --socket /tmp/amos-ai.sock --seconds 3   # the link's real heartbeats
```

`sub` / `state` / `bench` / `discover` need a **local data-plane node** and are refused by
name when `--socket` is present; `motor` needs no link at all and refuses `--socket` too.

## Environment variables

| variable | meaning | default |
|---|---|---|
| `AMOS_LINK_PEER` | this node's id when `--peer` is omitted | `amos-node` (per-command defaults for `bench`/`watch`/`motor`) |
| `AMOS_LINK_BEACON_ADDR` | beacon target for `discover --lan` | `239.255.42.99:7446` |
| `AMOS_LINK_ZENOH_ENDPOINT` | Zenoh endpoints for `--transport zenoh` | Zenoh's own default scouting |

## Honest boundaries

- **The CLI is not a robot.** Its own node is a tool: `bench`/`watch` default to
  `link-bench`/`link-watch` identities, and `discover --lan` is a bounded sweep
  (`--seconds`), never a daemon.
- **`motor --device` writes real bytes, and stops there.** The frames go to a Unix socket a
  controller listens on, or to a character device (a serial/UART port) — with the whole batch
  validated **before** the first byte, and the printed count being the count written (a bus that
  cannot be opened is exit 1 and says so, never "applied 13 frames"). What it does **not** do:
  configure the port (baud/`raw` is yours: `stty -F /dev/ttyUSB0 1M raw`), or prove a servo
  moved. `--device` belongs to `motor` alone — anywhere else it is a usage error (exit 2), never
  a silently ignored flag.
- **`--socket` reads the control plane only** — status, inventory, injection and the
  heartbeat stream. A data-plane command is refused rather than downgraded.
- **`pub --socket` injects bytes**, encoded exactly like a local publish (the `Message`
  trait's bincode), so typed subscribers decode it; the daemon stamps its own peer id,
  sequence and clock on the frame.
- Discovery over `lan` is **unauthenticated** (plaintext beacons); the authenticated path is
  the daemon's UDS.
- Exit codes are part of the contract: `0` ok, `1` failure (a refusal or an unreachable
  peer), `2` usage error.

## Related

- [`crates/amos-link`](../amos-link/README.md) — the middleware kernel this drives.
- [`docs/amos-link.md`](../../docs/amos-link.md) — design record + the operator cheatsheet.
- [`proto/robot_link.proto`](../../proto/robot_link.proto) — the control-plane contract.
