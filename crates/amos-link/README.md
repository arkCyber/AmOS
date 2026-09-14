# amos-link — AmOS-Link, the robot middleware (ROS-class pub/sub)

AmOS-Link is the middleware that connects a robot's parts: a stereo pair and an IMU on one
board, a model server on a Mac mini, a control laptop joining over Wi-Fi/5G — **without
ROS**. It is a decentralized pub/sub bus with a message framing contract, ROS-like QoS,
peer discovery and a robot HAL. Part of **[Amos](../../README.md)**, an AI-first OS built
as one Cargo workspace.

> ⚠️ Amos is a research prototype — **not** qualified for flight/medical/DAL-A systems or
> any other safety-critical use (see the [root README](../../README.md)).

## What it is

Four pieces, in the order data flows:

```text
  1. keys      amos/<peer>/<channel>/<name>  + * / **        (keyexpr)
  2. framing   AMLK │ ver │ hdr │ crc32 │ bincode payload    (codec · qos · metrics)
  3. transport Broker (in-process) · Zenoh (across boards)   (broker · zenoh)
  4. discovery UDP beacons → PeerRegistry                    (discovery · lan)
       ▲                                                          │
       └──── node · telemetry · robot_hal · sequence · service ◄──┘
```

- **`Topic` keys** with `*` (one segment) / `**` (zero or more) matching, an **iterative**
  matcher (no recursion, bounded work under the registry lock), and `Channel`-implied QoS.
- **Framed, self-describing messages**: any `serde` type is a `Message`; every frame is
  `magic │ version │ bincode header │ CRC32 │ payload` with a 16 MiB ceiling checked on
  **both** sides before any allocation.
- **ROS-like QoS** reduced to three fields: `Reliability{BestEffort, Reliable}` × `depth` ×
  `DropPolicy{DropNewest, DropOldest}` — sensor streams are latest-wins, control streams
  back-pressure and are counted as `blocked`.
- **Discovery** two ways: beacons over the link's own transport (works on any transport,
  filters self-echo) and real UDP multicast beacons behind the `lan` feature, with a
  repeating announcer so a peer that joins later still learns one that booted earlier.
- **Honest counters + a verdict**: `published`/`delivered`/`dropped`/`blocked`/
  `decode_errors`/`encode_errors` never reset and are never estimates; `LinkHealth` folds
  them into `Unknown | Healthy | Degraded{reasons}` — `Unknown` means *no evidence yet*,
  deliberately not the same as healthy.
- **Robot HAL**: an agent's JSON intent is validated, expanded into a gait pose and
  encoded as CRC-checked motor frames over a `RobotHal` seam, with a latched e-stop and a
  deadman watchdog.
- **A return path**: a bridge can `reporting()` its **mode** back on
  `amos/<robot>/state/actuation` (armed / e-stopped + why / which gait / the last refusal),
  published **only when the mode changes** — so a commander can tell an applied command from
  a refused one, and a watchdog torque cut is visible to the very peer whose link died.

It is **not**: a scheduler (you own the control thread and its rate), a ROS compatibility
layer (no `.msg`/IDL, no DDS wire), or a replacement for the daemon's authenticated UDS
service bus. `docs/amos-link.md` §6 records every deliberate non-goal.

## Layout

| file | what |
|---|---|
| `src/keyexpr.rs` | `Topic` / `Channel`: validation, `*`/`**` matching, channel→QoS |
| `src/codec.rs` | `Message`, `Envelope`, `Header`, `Timestamp`, `Clock` (stamps from `amos-timesync`) |
| `src/qos.rs` | `Qos::sensor()/state()/control()` + `Qos::for_channel` |
| `src/broker.rs` | `Transport` seam + the in-process `Broker` (`Arc<[u8]>` fan-out, bounded topic inventory) |
| `src/pubsub.rs` | `Publisher<T>` / `Subscriber<T>` / `Received<T>` |
| `src/discovery.rs` | `Beacon`, `PeerRegistry` (TTL), `MockDiscovery`, `BusDiscovery`, `spawn_federation` |
| `src/lan.rs` | *(feature `lan`)* real UDP multicast beacons + `spawn_announcer` |
| `src/zenoh.rs` | *(feature `zenoh`)* the inter-board transport |
| `src/telemetry.rs` | `Heartbeat` + `NodeStatus` + `spawn_heartbeat` |
| `src/sequence.rs` | `SeqTracker`: per-publisher gaps/duplicates, so "a frame was lost" is a number |
| `src/robot_hal.rs` | `AgentAction` → `plan()` → `MotorFrame` (CRC16) → `RobotHal`; `RobotBridge` with e-stop + watchdog, and `reporting()` for the mode return path |
| `src/health.rs` | `LinkHealth::evaluate` — the fold from counters to a verdict |
| `src/node.rs` | `LinkNode`: identity + transport + clock + counters + peer table |
| `src/service.rs` | the tonic control plane (`proto/robot_link.proto`) mounted by `amos-ai` |

## Build & test

```bash
cargo test -p amos-link                     # unit + e2e + control-plane-over-UDS (offline)
cargo test -p amos-link --features amos-link/lan --lib    # real UDP beacons on loopback
cargo test -p amos-link --features amos-link/zenoh --lib  # transport config/env mapping
cargo clippy -p amos-link --all-targets -- -D warnings
cargo fmt -p amos-link -- --check
```

The Zenoh *session* round trip is `#[ignore]`d on purpose (it needs a real network):
`cargo test -p amos-link --features zenoh -- --ignored`.

## Examples

```bash
# The robot↔brain loop on one offline link: stereo out, control back, motor frames applied.
cargo run -p amos-link --example robot_brain_loop
```

| example | shows |
|---|---|
| `robot_brain_loop` | two nodes on one broker: a depth frame the brain decodes (latest-wins), its measured age, the control action that reaches the robot's bus, the 13 CRC-checked motor frames, the mode the brain reads back off `state`, the latched e-stop refusing motion (with the refusal reported), and the counters + health verdict |

What the run prints (real output, abbreviated):

```text
link up: dog1 + mini-brain over the in-process broker
brain <- amos/dog1/sensor/stereo_left 1280x720 seq=3 from dog1 age=0ms (dropped 2 stale frame(s): latest wins)
brain -> trot speed=0.8: matched=1 subscriber(s)
dog1 applied action #1: 13 motor frame(s), armed=true
  joint= 0 op=Enable arg=       0 frame=aa55000300000000495b
  …
dog1 gait: armed=true estop=false
brain -> e-stop: Estopped { reason: Commanded, frames: 12 }
motion while e-stopped: Refused { seq: 3, reason: "e-stop latched: send {\"action\":\"arm\"} to re-arm" }
counters: published=6 delivered=4 dropped=2 blocked=0 decode_errors=0
topics seen by dog1: ["amos/dog1/control/action", "amos/dog1/sensor/stereo_left"]
health: degraded: no_peers, clock_unsynced (latencies are bounds until amos-timesync calibrates the clock)
```

## Environment variables

| variable | meaning | read by |
|---|---|---|
| `AMOS_LINK_BEACON_ADDR` | beacon target `ip:port` (default `239.255.42.99:7446`) | `src/lan.rs` |
| `AMOS_LINK_ZENOH_ENDPOINT` | Zenoh endpoints, comma-separated (`tcp/10.0.0.7:7447`) | `src/zenoh.rs` |

## Honest boundaries

- **Discovery is not authentication.** A `lan` beacon is plaintext and forgeable; it is a
  *hint* telling a peer where to connect. The authenticated path is the daemon's UDS
  (peer-credential checked), never the beacon.
- **Not ROS.** No `.msg`/IDL, no `rostopic` compatibility, no DDS wire — a bridge into that
  ecosystem is a separate deployment component.
- **Not a scheduler.** `RobotBridge::step()` is one explicit step; the control thread and
  its frequency are the caller's (a real product runs 50–100 Hz).
- **`zenoh-pico` / MCU** is out of scope: this is the host/board-side Rust middleware, not a
  firmware library.
- **`shm`, `unstable` per-call QoS, encrypted transports**: deliberately not used — see
  `docs/amos-link.md` §4/§6 for each ❌ together with its reason.
- Cross-**board** multicast behaviour (switch IGMP, Wi-Fi power save) is a field
  verification item; the `lan` tests prove the protocol on loopback, not on a switch.

## Related

- [`docs/amos-link.md`](../../docs/amos-link.md) — design record: layering, the Zenoh audit
  (what is used and what is not), the control plane, and the §6 non-goals.
- [`proto/robot_link.proto`](../../proto/robot_link.proto) · generated reference:
  [`docs/api-grpc.md`](../../docs/api-grpc.md)
- [`crates/amos-link-cli`](../amos-link-cli/README.md) — the same middleware from a terminal,
  or a **running** daemon's node via `--socket`.
- `crates/amos-ai` mounts the control plane (`src/service.rs::mock_server`) on the shared
  UDS; `crates/amos-timesync` supplies the clock every envelope is stamped with.

