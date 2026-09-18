# amos-link-cc

The **C ABI** of the AmOS-Link robot middleware: a `cdylib`/`rlib` that lets C, C++ or any
POSIX toolchain join the pub/sub fabric the Rust daemons speak.

> Part of the AmOS workspace — the [root README](../../README.md) explains what AmOS is and
> how the layers fit together; this file only covers what lives in this directory.

## What it is

`amos-link-cc` mirrors the full `amos-link` surface across a hand-written C boundary: nodes,
publishers/subscribers with topic patterns, QoS, heartbeats, federation (peer discovery and
advertising), metrics and health evaluation. Handles are opaque C structs, `amos_link.h`
(generated from this crate by cbindgen) is the contract, and every entry point carries a
`# Safety` section in `src/lib.rs` stating what the caller owes it.

It is the C counterpart of [`amos-link`](../amos-link/README.md) (the Rust middleware) and
[`amos-link-cli`](../amos-link-cli/README.md) (the command-line client): same transport, same
keyexpr rules, same wire frame.

## Layout

| path | what |
|---|---|
| `src/lib.rs` | the whole ABI: `#[repr(C)]` mirrors, opaque handle types, and every `extern "C"` entry point with its safety contract |
| `amos_link.h` | the generated C header (checked in; regenerate with cbindgen — see below) |
| `cbindgen.toml` | header-generation config (naming, style) |
| `tests/abi_test.rs` | the ABI test suite: lifecycle, pub/sub roundtrip, framing, QoS, federation, metrics, error paths |
| `build.rs` | prints the cbindgen reminder; it does not generate the header itself |
| `c-headers/`, `cpp/` | headers shipped to C consumers, and the C++ wrapper sketch |
| `examples/` | C/C++ programs driven by `examples/Makefile` (not cargo examples — see `scripts/crate-readme-allowlist.json` for why) |

## Build & test

```bash
# the library: target/{debug,release}/libamos_link_cc.{dylib,so}
cargo build -p amos-link-cc

# regenerate the C header after changing a signature or a struct
cbindgen --config cbindgen.toml --crate amos-link-cc --output amos_link.h

# the test suite (92 tests: lifecycle, pub/sub roundtrip, framing, QoS, federation, metrics)
cargo test -p amos-link-cc

# the C examples (builds them against the header and the shared library)
make -C crates/amos-link-cc/examples
```

The crate is a workspace member, so root-level `cargo build` / `cargo test` / `cargo clippy`
include it, and the P0-1 gate (`deny(unwrap_used, expect_used, panic)`) applies to it like to
every other crate.

## Examples

### Basic pub/sub

```c
#include "amos_link.h"
#include <stdio.h>

int main(void) {
    amos_link_node *node = amos_link_node_new("my-robot", NodeRobot);
    if (!node) { fprintf(stderr, "%s\n", amos_link_last_error()); return 1; }

    amos_link_publisher *pub = amos_link_publisher_new(node, "amos/my-robot/sensor/imu");
    uint8_t payload[] = {0x01, 0x02, 0x03, 0x04};
    int rc = amos_link_publisher_publish(pub, payload, sizeof(payload));
    if (rc != 0) { fprintf(stderr, "%s\n", amos_link_last_error()); }

    amos_link_publisher_drop(pub);
    amos_link_node_drop(node);
    return rc;
}
```

### Subscribing to a pattern

```c
#include "amos_link.h"
#include <stdio.h>
#include <unistd.h>

int main(void) {
    amos_link_node *node = amos_link_node_new("my-sensor", NodeSensor);
    amos_link_subscriber *sub = amos_link_subscriber_new(
        node, "amos/*/sensor/*", amos_link_qos_sensor());

    amos_link_received received;
    uint8_t buffer[4096];
    for (;;) {
        amos_link_poll status =
            amos_link_subscriber_poll(sub, &received, buffer, sizeof(buffer));
        if (status == Ready) {
            printf("%zu bytes from %s on %s\n", received.payload_len,
                   received.peer_id, received.topic);
        } else if (status == Closed) {
            break;
        }
        usleep(10000); /* Pending: nothing yet */
    }

    amos_link_subscriber_drop(sub);   /* stops its reader thread */
    amos_link_node_drop(node);
    return 0;
}
```

### Federation and peers

```c
#include "amos_link.h"
#include <stdio.h>
#include <unistd.h>

int main(void) {
    amos_link_node *node = amos_link_node_new("my-robot", NodeRobot);

    /* advertise + discover every 50 ms */
    amos_link_federation_task *fed = amos_link_node_spawn_federation(node, 50);
    if (!fed) { fprintf(stderr, "%s\n", amos_link_last_error()); return 1; }

    sleep(2);

    amos_link_peer_view peers[16];
    size_t count = amos_link_node_peers(node, peers, 16);   /* writes at most 16 */
    for (size_t i = 0; i < count; i++) {
        printf("  %s (kind %d) last seen %llu ms ago\n",
               peers[i].id, (int)peers[i].kind,
               (unsigned long long)peers[i].last_seen_ms);
    }

    amos_link_federation_stop(fed);   /* takes the handle back */
    amos_link_node_drop(node);
    return 0;
}
```

### Metrics and health

`amos_link_metrics_delivery_ratio` answers **percent (0-100)** and `0` while nothing has been
published. `amos_link_evaluate_health` takes the metrics snapshot, the peer array and whether
the clock is synced, and answers a struct (`state` + a human-readable `reason`).

```c
#include "amos_link.h"
#include <stdio.h>

int main(void) {
    amos_link_node *node = amos_link_node_new("my-robot", NodeRobot);
    amos_link_publisher *pub = amos_link_publisher_new(node, "amos/my-robot/status");

    for (int i = 0; i < 100; i++) {
        uint8_t payload[8] = { (uint8_t)i };
        amos_link_publisher_publish(pub, payload, sizeof(payload));
    }

    amos_link_metrics metrics;
    if (amos_link_node_metrics(node, &metrics) != 0) {
        fprintf(stderr, "%s\n", amos_link_last_error());
    }
    printf("published=%llu delivered=%llu dropped=%llu blocked=%llu\n",
           (unsigned long long)metrics.published, (unsigned long long)metrics.delivered,
           (unsigned long long)metrics.dropped, (unsigned long long)metrics.blocked);
    printf("delivery: %u%%\n", amos_link_metrics_delivery_ratio(&metrics));

    amos_link_peer_view peers[16];
    size_t count = amos_link_node_peers(node, peers, 16);
    amos_link_health health = amos_link_evaluate_health(&metrics, peers, count, true);
    printf("health: %d (%s)\n", (int)health.state, health.reason);

    amos_link_publisher_drop(pub);
    amos_link_node_drop(node);
    return 0;
}
```

## API Reference

### Core types

| type | what |
|---|---|
| `amos_link_node` | a participant in the fabric (opaque handle) |
| `amos_link_publisher` | publishes on one topic |
| `amos_link_subscriber` | subscribes to a pattern, with a reader thread |
| `amos_link_heartbeat` | one node's liveness record (encode/decode across the wire) |
| `amos_link_federation_task` | a running advertise/discover task |

### Quality of service

```c
amos_link_qos amos_link_qos_default();     /* reliable, drop-newest, depth 64 */
amos_link_qos amos_link_qos_sensor();      /* best-effort, drop-oldest, depth 1 */
amos_link_qos amos_link_qos_state();       /* best-effort, drop-newest, depth 8 */
amos_link_qos amos_link_qos_control();     /* reliable, drop-newest, depth 64 */
amos_link_qos amos_link_qos_for_channel(amos_link_channel ch);
int           amos_link_qos_validate(amos_link_qos qos);   /* 0 = accepted */
```

### Topic patterns

Topics are `amos/<peer-id>/<channel>/<name>`, where `<channel>` is one of `sensor`, `control`,
`state`, `telemetry`, `brain`. Patterns accept `*` (one segment, e.g. `amos/*/sensor/imu`) and
`**` (zero or more segments, e.g. `amos/**/status`).

### Error handling

Entry points answer `0` on success, or a negative code (`-1` keyexpr, `-2` codec/null pointer,
`-3` frame, `-4` unsupported, `-5` transport, `-6` closed, `-7` robot). The sentence that goes
with it — and the "null pointer" explanation — lives in a **thread-local** buffer read with
`amos_link_last_error()`; that pointer stays valid until the next `amos-link-cc` call on the
## Honest boundaries

- **The crate is not new; its place in the build was.** It had been dropped from
  `workspace.members` (the manifest change sat in an unapplied stash), so for a while nothing
  compiled it, `cargo build -p amos-link-cc` failed, and its 92 ABI tests never ran in CI.
  Restored 2026-09-17 — see `CHANGELOG.md` (REQ-A388).
- **Three ABI defects were found while documenting it** (REQ-A388) and are fixed:
  `amos_link_publisher_publish` handed `NULL, 0` — the ordinary C spelling of "empty
  payload" — to `slice::from_raw_parts` (undefined behaviour);
  `amos_link_heartbeat_encode` wrote through a null `frame_out`;
  `amos_link_last_error` leaked a `Box` per call (`Box::leak`), so a C error loop leaked every
  byte it read. The first two now answer an error code, the third keeps its string in a
  thread-local.
- **Not every entry point checks its inputs.** `amos_link_frame_decode_header` decodes
  immediately: a null `frame`, or a `frame_len` larger than the buffer, is the caller's bug
  and will misbehave. The size a buffer must have is stated per function in `src/lib.rs`; the
  generated header carries no such prose (cbindgen only emits declarations).
- **`amos_link_heartbeat_encode` has no capacity parameter** — the contract is "writable for
  `AMLK_MAX_FRAME_BYTES`", which is a much stronger requirement than the ~60-byte frame it
  actually writes. `amos_link_frame_encode` takes a capacity; this one arguably should too,
  which is an ABI change and therefore a decision, not a cleanup.
- **`amos_link_topic_matches` is unreachable from C today**: nothing hands out a `Topic`
  value or pointer, so a C caller cannot produce a valid argument.
- **C-side examples are built by `examples/Makefile`**, not by cargo, and they are not part of
  `make check` — they are compiled only when someone runs that Makefile with a C toolchain.
- **No real-hardware or interop validation is recorded here.** The tests run in-process
  (node → publisher → subscriber roundtrip); nothing in this repository has driven this ABI
  from a C program against a second machine, and `amos_link.h` is checked in rather than
  regenerated in CI, so header/crate drift is only caught when someone runs cbindgen.
- The old README claimed "all FFI boundaries are validated for null pointers", ">95%
  coverage" and "no unwrap/panic in production code paths". The first two are not measured and
  were wrong; the third became true only with REQ-A388's panic gate. Its examples also
  disagreed with the real ABI (wrong `amos_link_evaluate_health` signature, `Robot` instead of
  `NodeRobot`, a float delivery ratio) — they are rewritten above against the checked-in
  header and `src/lib.rs`.

## Related

- [AmOS root README](../../README.md) — what the OS is, and where this crate sits
- [amos-link](../amos-link/README.md) — the Rust middleware this is an ABI for
- [amos-link-cli](../amos-link-cli/README.md) — the command-line client over the same fabric
- [docs/amos-link.md](../../docs/amos-link.md) — the link layer's design notes

## License

MIT OR Apache-2.0 — see the root `LICENSE` files.

same thread (the `strerror` contract), and `amos_link_error_clear()` empties it.
