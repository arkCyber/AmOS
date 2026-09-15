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

# Every one of the above also takes --json: one document per result, or one object per line
# where the command streams. `topics --json | jq .topics` works; so does `motor --json`.
amos-link-cli topics --json
amos-link-cli motor --action '{"action":"arm"}' --json
```

Honest notes about scope, all enforced in code rather than promised:

- `--transport zenoh` and `discover --lan` are the real network paths and need the matching
  build feature (`zenoh` / `lan`). Without it the command **says so** instead of silently
  using another transport.
- **A measurement is never improved by a missing fact.** `bench` prints the percentiles of the
  frames it could *measure* (`(n=…)`), and any frame whose stamp is ahead of this clock is
  **counted, not sampled** (`skewed`, and the histogram is `null` when nothing was measurable)
  — `0 µs` is what the primitive saturates to, not a latency (`docs/amos-link.md` §3.15).
- **The counters mean the same thing on `--transport zenoh` as on the broker** (§3.16). The
  transport owns the node's counter set (`Transport::metrics`) and records `published` on every
  successful `put` and `delivered`/`dropped` as frames reach a subscriber queue — before this,
  nothing outside the in-process broker counted anything, so `status`/`watch` showed
  `published=0 delivered=0` on a real network while frames were crossing it. Two boundaries stay
  honest: a drop *inside* Zenoh (a full ring buffer, a lost UDP datagram) is not visible here, so
  a network node's `dropped` is a **lower bound**, and `blocked` is genuinely 0 there (`put`
  does not back-pressure our publisher).
- **The subscriber's QoS is the same subscription on both transports** (§3.18, round 17): the
  network side now builds the *same* sink the broker builds — a one-slot latest-wins queue for
  `DropOldest` + depth 1, a bounded queue otherwise — so `sub --pattern 'amos/*/sensor/**'` hands
  a lagging consumer the **newest** frame over Zenoh too, and `sub.stats().dropped` (the `dropped`
  in `sub`'s closing line, and the node's own counter) accounts for the frames a full best-effort
  queue discards. Before this, the network relay did a blocking `send` for every reliability: the
  consumer got the **oldest** frame of its stall and `dropped` read `0` while frames vanished.
- **`hz` measures arrivals, and says when it cannot** (§3.19, round 18): one line per stream per
  second — `rate publisher=dog1 topic=amos/dog1/sensor/imu frames=120 span=2.00s rate=59.5Hz` — with
  `frames` and `span` on the same line so the arithmetic can be checked. The rate is
  `(frames − 1) / span` over **arrival** instants from *this* machine's monotonic clock (never the
  frame's own `stamp`, so an uncalibrated clock does not weaken it), and it needs no payload type:
  a stream whose messages this build cannot decode is still measured (the envelope is read with
  `Envelope::decode_header`, which borrows the payload instead of copying it). A stream with one
  frame, or with less than `MIN_RATE_SPAN` (500 ms) of arrivals, prints **why there is no rate**
  instead of `0 Hz` — `0` would read as "the robot stopped publishing", a claim about the robot
  rather than about our window. `--json` carries `rate_hz: null` plus the stable `why` token
  (`single-frame` / `span-too-short`). It is a **data-plane** command (refused with `--socket`), and
  the figure is the average since the run started — a stall shows as `frames` that stop growing, not
  as an invented windowed rate.
- **Arguments are bounded where the platform is**: `--seconds` beyond what the clock can
  represent and `--size` above the wire ceiling (16 MiB − 64, since a larger bench payload
  could never be published) are refused at parse time with exit 2 — they used to panic
  (`overflow when adding duration to instant`) or abort (`capacity overflow`). A large
  `--count` stays legal ("keep publishing" is a legitimate request) and no longer reserves a
  vector it could never fill.
- **A flag a command cannot act on is refused, not ignored.** `bench --pattern 'amos/**'`
  filtered nothing, `sub --hz 5` throttled nothing, `motor --topic …` published nothing —
  all three used to *run*, so an operator was told something about the run that was not true.
  They are now exit-2 usage errors that name both the flag and the command (`--device` had
  this rule from the start; it now covers the parser's whole surface). The same rule applies
  across modes: `status --socket X --peer dog1` is refused, because a `--socket` run reads the
  **daemon's** identity and `--peer` would look like a filter and filter nothing.
  `--json`, `-h/--help` and `-V/--version` mean the same thing everywhere, so they are the
  exceptions: every command honors them.
- **`--count 0` is refused.** `pub --count 0` used to print *nothing* and exit 0 — a silent
  no-op indistinguishable from a successful publish. A run that neither publishes nor waits
  cannot report anything either, so the count must be positive.
- `pub`/`sub` carry `AgentAction` payloads (text or JSON) — the one shape a human and an
  agent can both produce without a schema.
- `sub` waits for `--count` frames, so **without `--timeout-ms` it waits forever** when
  nothing is publishing — a scripted probe must bound it. Expiry is reported
  (`timeout after …ms with no frame (received N)`) and the run still exits 0: a bounded
  observation that saw nothing is a fact, not a failure.
- **The loss figures say what they cover — and what a "stream" is.** A sequence number belongs to
  a **stream** = one publisher on one topic (`LinkNode::publisher::<T>(topic)` hands out a counter
  per topic, so a robot that publishes a camera *and* an IMU — or that beats *and* publishes — has
  several counters under one peer id). The tracker keys by that pair, so `streams=` counts streams
  and `missing=` means "frames that never arrived on some stream", not "this peer's counters
  disagreed". The tracker is also bounded (`MAX_TRACKED_STREAMS`, because its keys are
  `(publisher, topic)` pairs off the wire), so `sub`/`watch` print `untracked=` and
  `tracking=complete|full` beside `missing=`/`lost=`: when the table filled up, `tracking=full` is
  the honest answer, never a clean loss figure that quietly stopped accounting. When frames *were*
  lost, `sub` prints one line per stream below the totals
  (`lost peer=dog1 topic=amos/dog1/sensor/imu missing=2 in 1 gap(s)`) — the totals say how many,
  those lines say where.
- Every command that joins the peer federation (`discover --bus`, `watch`, `discover --lan`)
  announces at the same cadence — a beacon every `TTL/3` (1 s for the default 3 s TTL), from
  one helper. Announcing faster is legal but it is wire noise, and it makes this node's own
  `published` counter read mostly its own beacons.
- **`--endpoint` is how this node says where it can be reached.** A beacon is a connect hint
  (`docs/amos-link.md` §6.3), and until this flag existed the hint had **no way to carry an
  address**: both producers built their beacon with `PeerInfo::new`, so every peer table in
  every deployment said "no address". `--endpoint` (repeatable, and comma-separated inside one
  value) is honoured by the commands that **announce** — `watch`, `discover --bus`,
  `discover --lan` (`$AMOS_LINK_ENDPOINT` is the deployment-wide form) — and is a usage error
  anywhere else, including on the offline `discover`, which seeds a table of peers *you* name
  and says nothing about this node. The list is bounded exactly like the beacon (≤8 endpoints,
  ≤128 bytes each, and the **whole frame** must fit in 512 bytes), so a value this node could
  never emit is refused **at startup** (exit 1, naming the frame) instead of leaving a node
  that is silently invisible on the LAN. Omitting it keeps the previous behaviour byte for
  byte: no address announced (`watch` prints `advertising=none (no address announced)`, and the
  JSON carries `"advertised": []`).

## Layout

| file | what |
|---|---|
| `src/main.rs` | the binary: args → `parse_args` → `run`, exit codes (2 = usage, 1 = failure) |
| `src/lib.rs` | `parse_from`/`parse_args` (manual parser, no clap), `run`, `USAGE`, the flag-scope table (`FLAGS`/`honors`/`check_flag_scope`), and one function per command |
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

`state --timeout-ms 2000` watches the return path — and every report is **dated**: the human line
ends with `age=2.4s` and the JSON carries `age_ms` beside the raw `stamp_ms`. A report whose age
cannot be stated says so (`age=unknown(no stamp)`, `age=unknown(stamp is 5000ms in the future — that
clock is not this clock)`; `age_ms: null`) instead of printing a number that would read as
"just now". `status --socket` dates the reports it reads out of the daemon's folded table the same
way, which is where an age actually matters: `armed=true` from an hour ago is not "armed now"
(`docs/amos-link.md` §3.12).

**The same rule governs the frames** (`docs/amos-link.md` §3.15). `sub` and `watch` print an age
per line, `bench` measures one per frame, and a stamp **ahead of this clock** is not an age: it is
two clocks disagreeing, so those lines read `age=unknown(stamp is 5000ms in the future — that clock
is not this clock)` and `age_ms: null`. It used to read `age=0ms` (the primitive underneath
*saturates to* zero for a backwards clock, which is right for a duration and wrong for a
measurement) —
and `bench` used to count that `0` as a **0 µs sample**, i.e. a run against a skewed clock reported
*lower* p50/p99 than the link could justify. `bench` now counts those frames instead
(`skewed`, and `latency_us.samples` says what the percentiles are made of): a measurement is never
allowed to improve because a fact was missing.

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

`status --socket` reads **the same document** a local `status` prints (plus `remote`, naming the
socket that answered, and `actuations`, the robots' self-reports the daemon folded): same keys, same
shapes, same vocabulary. The daemon's **peer table** is on the wire (`GetStatus.peers`) and is now
rendered — the human form prints the table below the summary line, and `--json` puts it under `peers`
as an **array** of the same flat rows `discover --json` uses (`id`/`kind`/`endpoint`/`last_seen_ms`/
`beacons`; `beacons: 0` = declared by hand). Before this, `peers` was a *number* remotely and an
*array* locally, and the verdict was a *string* remotely and an *object* locally — one command, two
dialects (see `docs/amos-link.md` §3.11).

**One RPC a daemon may not have is not a reason to fail the command** (§3.17). `ListActuations`
arrived with the return path; a daemon built before it answers `Unimplemented`, and `status` then
prints everything that *was* answered (identity, counters, peers, inventory, verdict) with one line
in place of the robots — `robots reported: not answered by this daemon (no ListActuations — an older
build); the status above was answered` — and `actuations: null` in the JSON (never `[]`, which would
claim the fleet said nothing). `actuations` therefore has **three states**: `null` = not answered,
`[]` = answered and nobody reported, `[…]` = those robots reported. Any *other* failure still fails
the command: a daemon that has the RPC and cannot serve it is a real fault, not a version skew.

## Environment variables

| variable | meaning | default |
|---|---|---|
| `AMOS_LINK_PEER` | this node's id when `--peer` is omitted | `amos-node` (per-command defaults for `bench`/`watch`/`motor`) |
| `AMOS_LINK_ENDPOINT` | the addresses this node **announces** when `--endpoint` is omitted (comma-separated). Read only by the announcing commands (`watch`, `discover --lan`/`--bus`) — a deployment variable must not be able to fail a `status` | none (announce no address) |
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
  the daemon's UDS. This also qualifies `--endpoint`: an address in a peer table is what **that
  peer said**, not who it is — the flag makes the "connect here" hint expressible and refuses a
  value the node could never emit, and nothing more.
- **A process cannot observe its own beacon** (a node is never its own peer), so "the CLI
  really put the endpoint in the beacon" is proven by *another* node's table in
  `amos-link-cli`'s unit test `the_cli_announces_the_endpoint_the_operator_gave` (two nodes on
  one shared broker) — not by the lines this CLI prints about itself, which only echo what the
  operator typed. A negative control passed on exactly that gap, which is why the test exists.
  Real hardware (two boards on one switch) is still a field item.
- **`--json` shapes are per command, and say which they are.** A one-shot command prints one
  document (`status`, `topics`, `bench`, `motor`, `discover`); a streaming one prints one
  object per line, per event, and **every** line is one — `sub`
  (`subscribed`/`frame`/`timeout`/`stats`), `state` (`watching`/`report`/`timeout`/`stats`) and
  `watch`, local or `--socket`
  (`watching`/`heartbeat`/`status`/`summary`). That last part used to be false: each streamer
  printed a **prose header first** (plus a prose timeout/stats/summary), so `watch --json | jq`
  failed on line 1 while USAGE promised "one JSON object per line for the commands that stream"
  — the facts moved into the header/summary events, nothing was dropped
  (`docs/amos-link.md` §3.14). Two more consequences worth knowing:
  **progress is not in the document** — the `+ peer` lines a `--lan` sweep prints as beacons
  arrive are suppressed, and the document carries what the sweep converged on (`peers`,
  `self_refused`, `seconds`, `ttl_ms`, `transport`, and `advertised` — what this node announced
  about itself); and a value that
  the human form prints as a placeholder is JSON `null` instead (`discover`'s endpoint column
  prints `-`, the document prints `null`), so a machine never has to know a human's
  conventions. `status --socket` adds `remote` to its document, so an answer always names the
  node that gave it. The human form is unchanged by any of this: those lines are printed only
  when `--json` is absent.
- Exit codes are part of the contract: `0` ok, `1` failure (a refusal or an unreachable
  peer), `2` usage error.

## Related

- [`crates/amos-link`](../amos-link/README.md) — the middleware kernel this drives.
- [`docs/amos-link.md`](../../docs/amos-link.md) — design record + the operator cheatsheet.
- [`proto/robot_link.proto`](../../proto/robot_link.proto) — the control-plane contract.
