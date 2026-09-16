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
  **both** sides before any allocation. The CRC32 covers header ‖ payload and is computed
  **by streaming** the two slices through one hasher — no second copy of a frame is ever
  built (an earlier `[…].concat()` doubled a frame's peak memory, on the receive path
  before the checksum had even been verified; see `docs/amos-link.md` §3.3).
- **A header off the wire is re-asked, never believed**: `Deserialize` cannot run a
  constructor, so `Topic::new` / `PeerId::new` / `Timestamp::new` are bypassed by every derive
  — `Header::validate` asks each question again on `encode` **and** `decode`, `PeerInfo::validate`
  does the same for a beacon's `peer.id`, and `Heartbeat::validate` for a beat's payload `peer`
  and `stamp`. A peer cannot put a 400-byte "peer id" into the peer/sequence
  tables or a `nanos = 4e9` stamp into the latency arithmetic by writing bytes
  (`docs/amos-link.md` §3.8/§3.9).
- **A beat names exactly one peer.** Heartbeats are a self-description, so they are read through
  `Subscriber::recv_beat`: the payload's `peer` must equal the frame's (validated) publisher, or
  the beat is refused and counted like a frame that does not decode. Without that, one frame
  carries two identities — the CLI prints the payload's while it counts gaps against the framing's
  — and the control plane's `StreamHeartbeats` would put the payload's claim in front of every UI
  (`docs/amos-link.md` §3.9). This is a **consistency** rule, not authentication: see the
  boundaries below.
- **ROS-like QoS** reduced to three fields: `Reliability{BestEffort, Reliable}` × `depth` ×
  `DropPolicy{DropNewest, DropOldest}` — sensor streams are latest-wins, control streams
  back-pressure and are counted as `blocked`. **The profile is the subscription's, not one
  transport's**: the in-process broker and the Zenoh transport build the *same* two sinks
  (a one-slot latest-wins queue for `DropOldest` + depth 1, a bounded queue otherwise), so
  `Qos::sensor()` means "the consumer wakes up holding the newest frame" on a network link too
  — and the frames a full best-effort queue drops are counted on the subscription *and* the node
  (round 17 measured the opposite on a real TCP session: the network consumer got the **oldest**
  frame of its stall and both counters read 0; `docs/amos-link.md` §3.18).
- **Discovery** two ways: beacons over the link's own transport (works on any transport,
  filters self-echo) and real UDP multicast beacons behind the `lan` feature, with a
  repeating announcer so a peer that joins later still learns one that booted earlier.
  A node is **never its own peer**: the table refuses its own id (a multicast
  announcement reaches its own sender by default) and counts the refusals
  (`PeerRegistry::self_entries_refused`, `FederationTask::self_echoes`) instead of
  filtering silently.
- **Honest counters + a verdict**: `published`/`delivered`/`dropped`/`blocked`/
  `decode_errors`/`encode_errors` never reset and are never estimates; `LinkHealth` folds
  them into `Unknown | Healthy | Degraded{reasons}` — `Unknown` means *no evidence yet*,
  deliberately not the same as healthy — and a verdict is never cleaner than the instrument
  behind it: a sequence tracker that hit its ceiling reports `untracked_frames=N` rather than
  letting a partial loss figure read as a clean one (`docs/amos-link.md` §3.9).
- **Robot HAL**: an agent's JSON intent is validated, expanded into a gait pose and
  encoded as CRC-checked motor frames over a `RobotHal` seam, with a latched e-stop and a
  deadman watchdog. A torque cut comes back from the HAL as a **measured** frame count
  (`estop() -> Result<usize>`), so the report of a watchdog stop says what the bus really
  took instead of assuming one frame per joint.
- **A real byte-stream HAL** (`StreamRobotHal`): the frames go to a real descriptor — a motor
  controller's Unix socket, or a character device (a serial/UART port) — with the two
  properties a bus layer must have: **the whole batch validates before any byte moves**, and
  **the accepted count is the count written**. `armed()` is folded from the ops in **wire
  order**, so a batch that ends with an e-stop cannot report the drivers as energized.
  Port parameters (baud/`raw`) stay the deployment's job (see the boundaries below).
- **A return path**: a bridge can `reporting()` its **mode** back on
  `amos/<robot>/state/actuation` (armed / e-stopped + why / which gait / the last refusal),
  published **only when the mode changes** — so a commander can tell an applied command from
  a refused one, and a watchdog torque cut is visible to the very peer whose link died.
- **The wire is not trusted, on either side of the loop**: a motor frame and an actuation
  report are both *decoded from a peer*, so both validate on decode (`try_from` on the wire
  form). A report whose frame count, deadman period or refusal reason is outside its bound is
  refused as a **decode error** — counted by the subscription, logged with a bounded budget,
  and never folded into the control plane's table — instead of being stored, rendered and
  silently truncated into a `u32` on the way to the UI.
- **Bounded bookkeeping, and it says when it stops**: the broker's topic inventory caps at
  `MAX_TRACKED_TOPICS` (and reports `topics_complete()`); the per-**stream** sequence tracker
  caps at `MAX_TRACKED_STREAMS` (and reports `SeqEvent::Untracked` /
  `SeqSummary::is_complete()`). Both keys come off the wire, so a peer could otherwise mint a
  new one per frame — and a bounded table that *admits* it stopped is worth more than an
  unbounded one or a silent gap. The admission travels with the list it describes: the
  `NodeStatus` JSON carries `topics_complete`, and the control plane's `TopicList.complete`
  carries it to a caller that is **not** on this node's transport (which is the only place the
  local CLI could not print the caveat — `docs/amos-link.md` §3.8).
- **A beacon can say *where to connect* — when a deployment says so.** `spawn_federation_advertising`
  (and `PeerInfo::advertising`, which it uses) is the one path that fills a beacon's `endpoints`:
  the list is bounded twice, by `parse_endpoints` (per field: ≤8 endpoints, ≤128 bytes each) **and**
  by encoding the beacon it would emit — because those per-field bounds do not add up to the 512-byte
  frame, and a node whose beacons cannot be encoded would be invisible on the link with a `debug!`
  line as the only trace. Until this existed, `PeerInfo::with_endpoint` was called by **no** production
  code, so every peer table in every deployment rendered "no address" (`docs/amos-link.md` §3.14).
  The default is unchanged: an empty list advertises nothing, which is the only sound choice for a
  transport that self-discovers (Zenoh scouting, `lan` multicast).
- **The counters live in the transport, and the transport is the same object on every path.**
  `published`/`delivered`/`dropped` are recorded where the fact happens — `Broker` **and**
  `ZenohTransport` (round 15: until then only the broker counted, so a node on a real network
  reported `published=0 delivered=0` for its whole life while frames crossed the session in
  front of it). `Transport::metrics()` is how a node and its transport can be checked to share
  **one** counter set, and `LinkNode::with_parts` warns when they do not; an honest boundary
  remains: a drop *inside* Zenoh (a full `RingChannel`, a lost UDP datagram) is invisible from
  this side, so a network node's `dropped` is a **lower bound** (`docs/amos-link.md` §3.16).
- **An age is a measurement, and `0` is not a way to say "unknown".** `Received::age()` saturates
  to zero when a stamp is **ahead of this clock** (right for a *duration*, wrong for a
  *measurement*: `0` reads as "just now"), and every renderer owes the reader two things: state
  that the age is unknown rather than `0`, and say when `clock_synced` is false (every age is
  then a **bound**). The kernel cannot keep those promises for a caller, so it writes them down
  where the fact and the caveat meet (`docs/amos-link.md` §3.15).
- **A sequence number belongs to a stream — `(publisher, topic)` — and the loss figures say so.**
  `LinkNode::publisher::<T>(topic)` hands out a **counter per publisher object**, i.e. per topic,
  so a node that publishes a camera *and* an IMU (or that beats *and* publishes) reports several
  independent counters under one peer id. `SeqTracker` keys by that pair, which is what the frame
  stamps: keying by the publisher alone read a healthy multi-topic peer as a restarting one
  (`stale` runs) and — the half nobody could see — let a busy stream's high-water mark swallow a
  quiet stream's genuine `missing` frame (`docs/amos-link.md` §3.13).

It is **not**: a scheduler (you own the control thread and its rate), a ROS compatibility
layer (no `.msg`/IDL, no DDS wire), or a replacement for the daemon's authenticated UDS
service bus. `docs/amos-link.md` §6 records every deliberate non-goal.

## Layout

| file | what |
|---|---|
| `src/keyexpr.rs` | `Topic` / `Channel`: validation, `*`/`**` matching, channel→QoS |
| `src/codec.rs` | `Message`, `Envelope`, `Header`, `Timestamp`, `Clock` (stamps from `amos-timesync`); `Envelope::decode_header` reads the envelope **without copying the payload** (a rate/counter/forwarder needs only the header) |
| `src/qos.rs` | `Qos::sensor()/state()/control()` + `Qos::for_channel` |
| `src/broker.rs` | `Transport` seam + the in-process `Broker` (`Arc<[u8]>` fan-out, bounded topic inventory) |
| `src/pubsub.rs` | `Publisher<T>` / `Subscriber<T>` / `Received<T>` |
| `src/discovery.rs` | `Beacon`, `PeerRegistry` (TTL), `MockDiscovery`, `BusDiscovery`, `spawn_federation` / `spawn_federation_advertising`, `parse_endpoints` + `PeerInfo::advertising` (the only path that fills a beacon's endpoint list) |
| `src/lan.rs` | *(feature `lan`)* real UDP multicast beacons + `spawn_announcer` |
| `src/zenoh.rs` | *(feature `zenoh`)* the inter-board transport |
| `src/telemetry.rs` | `Heartbeat` + `NodeStatus` + `spawn_heartbeat` |
| `src/sequence.rs` | `SeqTracker`: per-**stream** `(publisher, topic)` gaps/duplicates, so "a frame was lost" is a number — and it names the stream it happened on |
| `src/rate.rs` | `RateTracker`: per-**stream** arrival rate **and bandwidth** (from *our* monotonic clock, never the frame's `stamp`; bytes are the framed size the link moved), with `RateEvidence` saying *why* when the figures cannot be stated — `0 Hz` would read as "the robot stopped" |
| `src/platform.rs` | the **platform profile**: what a machine has (actuator table + units + travel), what it accepts (vocabulary + classes + bounded parameters) and what it owes itself when the link dies (deadman + failsafe manoeuvre) — six built-in profiles (quadruped · manipulator · drone · ground-vehicle · surface-vessel · industrial-cell) that plan into the *shipping* `MotorFrame`, plus `Vocabulary`, the seam that gives `RobotBridge` a profile's words without a second safety core (`docs/robot-domains.md`) |
| `src/robot_hal.rs` | `AgentAction` → `plan()` → `MotorFrame` (CRC16) → `RobotHal`; `RobotBridge` with e-stop + watchdog, and `reporting()` for the mode return path |
| `src/health.rs` | `LinkHealth::evaluate` — the fold from counters to a verdict |
| `src/node.rs` | `LinkNode`: identity + transport + clock + counters + peer table |
| `src/service.rs` | the tonic control plane (`proto/robot_link.proto`) mounted by `amos-ai`; it also folds the return path (`ListActuations`) so a caller that is not on the link can read what each robot reports |

## Build & test

```bash
cargo test -p amos-link                     # unit + e2e + control-plane-over-UDS (offline)
cargo test -p amos-link --test robot_cases  # the application cases' asserted properties (10 cases)
cargo test -p amos-link --features lan      # + real UDP multicast beacons on loopback
cargo test -p amos-link --features zenoh    # + the transport config/env mapping
cargo clippy -p amos-link --all-targets -- -D warnings
cargo fmt -p amos-link -- --check
```

(These are the same steps `make lint`/`make test` run. They are *not* `--lib`: a whole test
file behind a feature — `tests/lan_multicast.rs` — is invisible to `--lib`, which is the gate
blind spot REQ-A243 fixed in the Makefile.)

The Zenoh *session* round trip is `#[ignore]`d on purpose (it needs a real network):
`cargo test -p amos-link --features zenoh -- --ignored`.

## Examples

The **robot application cases** live here — each one runs offline (one process, the in-process
broker) and uses the shipping code paths. [`docs/robot-apps.md`](../../docs/robot-apps.md) is the
catalogue: topology, topic/QoS contract, the asserted properties and the honest boundaries per case.

```bash
# The robot↔brain loop in miniature: stereo out, control back, motor frames applied.
cargo run -p amos-link --example robot_brain_loop
# Case ① one patrol, end to end: apply → report → deadman cut → refusal → re-arm.
cargo run -p amos-link --example patrol_mission
# Case ② three robots, one console: wildcards, per-stream figures, one deadman each.
cargo run -p amos-link --example fleet_console
# Case ③ a brain that is *not* on the link: the gRPC control plane over a Unix socket.
cargo run -p amos-link --example remote_brain
# Domain case ④ a multirotor: profile vocabulary, geofence, deadman, return-to-base.
cargo run -p amos-link --example uav_mission
# Domain case ⑤ a road vehicle: set-point stream, road limits, full braking, minimal-risk manoeuvre.
cargo run -p amos-link --example road_autonomy
```

The **platform profiles** behind cases ④/⑤ (and the other four machines: quadruped, manipulator,
surface vessel, industrial cell) are the subject of [`docs/robot-domains.md`](../../docs/robot-domains.md).

| example | shows |
|---|---|
| `robot_brain_loop` | two nodes on one broker: a depth frame the brain decodes (latest-wins), its measured age, the control action that reaches the robot's bus, the 13 CRC-checked motor frames, the mode the brain reads back off `state`, the latched e-stop refusing motion (with the refusal reported), and the counters + health verdict |
| `patrol_mission` | case ①: a patrol command applied (13 frames), the camera's `frames`/`span`/`rate`/`bytes`/`bw` on **one** line, a burst that latest-wins drops and counts, the deadman cutting torque when the link goes quiet (with the cut **measured** and reported), motion refused by the latch with a reason the commander can act on, and the re-arm that clears it |
| `fleet_console` | case ②: three robots under one wildcard console, the same table printed twice (which stream is *moving* and which one stopped — `patrol-03`'s camera reads `frames=1 rate=unknown(one frame so far …)`, never `0 Hz`), each robot's own deadman visible in the console's mode column, peer table + self-echo count + health verdict |
| `remote_brain` | case ③: a caller that is not on the link — `GetStatus`, a `Publish` whose payload the robot's **typed** subscriber decodes, `ListActuations` folding the robot's self-reported mode (attributed by the frame's publisher), the torque cut a silent brain caused seen from outside, and the topic inventory with its `complete` flag |
| `uav_mission` | domain case ④ (drone): the profile's own vocabulary (`takeoff`/`goto`/`rtl`/…), a set point refused while the drives are **disarmed**, a waypoint inside the fence accepted and one outside it refused *naming the limit*, the 300 ms deadman stopping the aircraft, and the mission layer flying the declared `return-to-base` manoeuvre through the same HAL |
| `road_autonomy` | domain case ⑤ (vehicle): a set-point stream at the profile's cadence, `lane_offset_mm`/`speed_mm_s`/`decel_mm_s2` refused outside the road's limits, `estop` planning **full braking plus a throttle cut** (a car has no torque to cut), and the deadman driving the vehicle's minimal-risk manoeuvre |

What the runs print (real output, abbreviated):


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
| `AMOS_LINK_BEACON_IFACE` | pin the beacon channel to one interface (a local IPv4 address). **Required on a multi-NIC board**: the outgoing datagram and the group join both bind to it, instead of the kernel choosing (which can send the beacon out the 5G modem while the camera board listens on Wi-Fi). A bad value is refused at startup, never ignored. | `src/lan.rs` |
| `AMOS_LINK_BEACON_LOOP` | multicast loopback switch (`1`/`0`, default: the platform's). Turning it off hides our own beacons from **every** local process, so it is not the correctness mechanism — the peer table's self-refusal is. | `src/lan.rs` |
| `AMOS_LINK_ZENOH_ENDPOINT` | Zenoh endpoints, comma-separated (`tcp/10.0.0.7:7447`) | `src/zenoh.rs` |

## Honest boundaries

- **One peer table, one verdict vocabulary — and the render types are `Serialize`-only.**
  `NodeStatus`, `PeerView`, `LinkHealth` and `HealthReason` are *renderings*: the status JSON a
  machine reads has a **flat** peer (`id`/`kind`/`endpoint`/`last_seen_ms`/`beacons` — the same five
  fields `proto.Peer` and the System UI carry) and a verdict whose reasons are the `detail()` tokens
  (`"decode_errors=3"`), i.e. the control plane's own words. They no longer derive `Deserialize`: a
  rendering that claimed to round-trip is how two spellings for one verdict stayed alive (see
  `docs/amos-link.md` §3.11). A consumer that needs to *read a document back* must define its own
  shape deliberately.
- **A peer's JSON carries its primary endpoint, not the list.** `PeerInfo.endpoints` stays in the
  Rust API; the document follows the proto (`endpoint`, one field). More endpoints would be a proto
  change first.
- **A robot's report is dated, and an age you cannot state is not printed as `0`.** The return path
  (`amos/<robot>/state/actuation`) reports `armed` / `estopped` / `gait` — claims about *right now* —
  so both renderers carry the report's age: the CLI prints `age=…` and its JSON carries `age_ms`
  beside the raw `stamp_ms`. A stamp of `0` (the proto's sentinel, not 1970) or one **in the future**
  (two unsynchronised clocks) yields `age=unknown(…)` / `age_ms: null`, never a number that would
  read as "just now". The age is a difference between *the reporter's* clock and the reader's, so on a
  link without a shared clock it is a **bound**, like every latency (`clock_synced: false`).
- **Discovery is not authentication.** A `lan` beacon is plaintext and forgeable; it is a
  *hint* telling a peer where to connect — and that hint can now actually carry an address
  (`--endpoint`/`AMOS_LINK_ENDPOINT`, `docs/amos-link.md` §3.14), which makes the sentence
  *truer*, not safer: an address in a peer table is a **claim by that peer**. The authenticated
  path is the daemon's UDS (peer-credential checked), never the beacon. The beat rule above is a
  **consistency** check in the same spirit: it makes "one frame, one identity" true, but a peer
  that lies in the frame *header* is outside what any check at this layer can catch.
- **Not ROS.** No `.msg`/IDL, no `rostopic` compatibility, no DDS wire — a bridge into that
  ecosystem is a separate deployment component.
- **Not a scheduler.** `RobotBridge::step()` is one explicit step; the control thread and
  its frequency are the caller's (a real product runs 50–100 Hz).
- **`zenoh-pico` / MCU** is out of scope: this is the host/board-side Rust middleware, not a
  firmware library.
- **Not a motor driver.** [`StreamRobotHal`] writes bytes to a device or a socket; it does not
  configure the port — termios (baud rate, `raw` mode, flow control) is the deployment's step
  before the node starts (`stty -F /dev/ttyUSB0 1M raw`). A wrong port setting still "succeeds"
  at this layer, which is why it is a bring-up item.
- **No real servo has been driven by this code.** The evidence is "correct CRC16 frames on a real
  descriptor" (`tests/hardware_hal.rs`), not "the joints moved".
- **The application cases test the middleware, not a robot.** ①–③ (`docs/robot-apps.md`) run the
  reference quadruped's HAL through `MockRobotHal`: they prove latest-wins, the deadman's *measured*
  frame count travelling back to the peer whose link died, a refusal that names how to recover,
  per-stream figures that state why they cannot be stated, and the control plane's fold — and
  nothing about a machine. The joint table is the quadruped's (`JOINTS=12`, `leg*3+(hip|thigh|knee)`,
  milli-degrees), so another form factor (a wheeled base, an arm, a drone) implements `RobotHal`;
  the *middleware* is form-factor-agnostic because it moves bytes, this layer is not. A case's
  figures are the arrivals **of the process that printed them** (a slow console under-reports and
  counts the frames it missed in `dropped`), and they are averages since the reader started, so a
  stream that stopped is visible as a `frames` column that no longer grows — never as `0 Hz`.
- **One OS, six machines — and the profile layer's boundaries are registered.** `src/platform.rs`
  describes a machine as data (actuators, vocabulary, safety envelope) and the quad*, manipulator,
  drone, vehicle, vessel and cell profiles all plan into the **same** `MotorFrame`, run `RobotBridge`'s
  **same** safety core and report on the **same** return path. What the abstraction does *not* do
  today, with its reason: a profile is capped at **12 actuators** (the frame's `id` bound is the
  reference machine's policy, `JointId::new`), the argument space is the reference policy
  (`SetPosition` ±90 000 mdeg, `SetTorque` 0..=100 000 mpercent and **non-negative** — so a vessel's
  astern thrust is not expressible yet, and a linear axis is a percentage of stroke rather than a
  distance), the shared return document's `gait` field stays the reference vocabulary (putting a
  drone's action key there is a payload-schema change with proto and UI consequences — a profile
  publishes its own mode on its own topic instead), and there is **no certification or real-time
  claim** anywhere in this layer. `docs/robot-domains.md` §5 lists all of them together with what the
  domain side still owes (MAVLink/CANopen/EtherCAT/OPC-UA, ISO 26262 / IEC 61508, deterministic
  timing, trajectory planning).
- **`shm`, `unstable` per-call QoS, encrypted transports**: deliberately not used — see
  `docs/amos-link.md` §4/§6 for each ❌ together with its reason.
- **Multicast on a real switch is still a field item**: the `lan` tests now prove the *protocol and
  the socket configuration* on a real multicast group over a real interface (`tests/lan_multicast.rs`),
  including the self-echo; what no loopback test can promise is the switch in between — IGMP
  snooping, STP, Wi-Fi power save — so pin the interface (`AMOS_LINK_BEACON_IFACE`) and verify on
  the real hardware.
- **Zenoh session round trips are tested; Zenoh *scouting* across hosts is not.** Two peers with
  explicit endpoints over TCP loopback are a real session and run in CI; `scouting_finds_a_peer_on_a_real_network`
  stays `#[ignore]`d because it needs a network someone else controls.
- **The bounds on a report are engineering limits, not laws.** `MAX_ACTUATION_FRAMES` (4096),
  `MAX_WATCHDOG_MS` (1 h) and `MAX_REFUSAL_REASON_BYTES` (512) are generous for the reference
  quadruped; a machine that legitimately exceeds one must raise it *here* (and keep the proto's
  `u32` in mind). The tracker's `MAX_TRACKED_STREAMS` is the same kind of number: past it the
  tracker refuses new streams `(publisher, topic)` and says so, rather than growing without bound.

## Related

- [`docs/amos-link.md`](../../docs/amos-link.md) — design record: layering, the Zenoh audit
  (what is used and what is not), the control plane, and the §6 non-goals.
- [`proto/robot_link.proto`](../../proto/robot_link.proto) · generated reference:
  [`docs/api-grpc.md`](../../docs/api-grpc.md)
- [`crates/amos-link-cli`](../amos-link-cli/README.md) — the same middleware from a terminal,
  or a **running** daemon's node via `--socket`.
- `crates/amos-ai` mounts the control plane (`src/service.rs::mock_server`) on the shared
  UDS; `crates/amos-timesync` supplies the clock every envelope is stamped with.

