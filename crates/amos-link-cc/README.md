# amos-link-cc

C/C++ SDK for AmOS-Link robot middleware (ROS-class pub/sub).

## Overview

`amos-link-cc` provides a pure C ABI for the `amos-link` Rust middleware, enabling C and C++ applications to participate in the AmOS robot communication fabric. It exposes the full surface of `amos-link`:

- **LinkNode**: Participant in the middleware with unique peer ID
- **Publisher/Subscriber**: Typed pub/sub with topic patterns and wildcards
- **QoS**: Quality of Service policies (reliability, drop policy, depth)
- **Heartbeat**: Liveness messages for peer discovery
- **Federation**: Peer discovery and advertising
- **Metrics**: Per-stream counters (published, delivered, dropped, errors)
- **Health**: System health evaluation based on peer connectivity

## Build

### Requirements

- Rust toolchain (1.70+)
- C compiler (gcc, clang)
- cbindgen (for header generation)

### Build the library

```bash
cd crates/amos-link-cc
cargo build --release
```

The shared library will be at `target/release/libamos_link_cc.dylib` (macOS) or `target/release/libamos_link_cc.so` (Linux).

### Generate C header

```bash
cbindgen --config cbindgen.toml --crate amos-link-cc --output amos_link.h
```

## Usage

### Basic Pub/Sub

```c
#include "amos_link.h"
#include <stdio.h>
#include <unistd.h>

int main() {
    // Create a node
    amos_link_node* node = amos_link_node_new("my-robot", Robot);
    
    // Create a publisher
    amos_link_publisher* pub = amos_link_publisher_new(node, "amos/my-robot/sensor/imu");
    
    // Publish a message
    uint8_t payload[] = {0x01, 0x02, 0x03, 0x04};
    int result = amos_link_publisher_publish(pub, payload, sizeof(payload));
    if (result == 0) {
        printf("Published %zu bytes\n", sizeof(payload));
    }
    
    // Cleanup
    amos_link_publisher_drop(pub);
    amos_link_node_drop(node);
    return 0;
}
```

### Subscribing to Topics

```c
#include "amos_link.h"
#include <stdio.h>
#include <string.h>

int main() {
    // Create a node
    amos_link_node* node = amos_link_node_new("my-sensor", Sensor);
    
    // Subscribe with a wildcard pattern
    amos_link_qos qos = amos_link_qos_sensor();
    amos_link_subscriber* sub = amos_link_subscriber_new(
        node, 
        "amos/*/sensor/*",  // Match any peer's sensor topics
        qos
    );
    
    // Poll for messages
    amos_link_received received;
    uint8_t buffer[4096];
    
    while (1) {
        amos_link_poll status = amos_link_subscriber_poll(
            sub, &received, buffer, sizeof(buffer)
        );
        
        if (status == Ready) {
            printf("Received %zu bytes from %s on topic %s\n",
                   received.payload_len,
                   received.peer_id,
                   received.topic);
            // Process buffer[0..received.payload_len]
        } else if (status == Closed) {
            break;
        }
        // Pending: no message yet, try again
        usleep(10000);  // 10ms
    }
    
    // Cleanup
    amos_link_subscriber_drop(sub);
    amos_link_node_drop(node);
    return 0;
}
```

### Federation (Peer Discovery)

```c
#include "amos_link.h"
#include <stdio.h>
#include <unistd.h>

int main() {
    amos_link_node* node = amos_link_node_new("my-robot", Robot);
    
    // Start advertising and discovering peers
    amos_link_federation* fed = amos_link_node_spawn_federation(node, 50);  // 50ms interval
    
    sleep(2);  // Let discovery run
    
    // Query discovered peers
    amos_link_peer_view peers[16];
    size_t count = amos_link_node_peers(node, peers, 16);
    
    printf("Discovered %zu peers:\n", count);
    for (size_t i = 0; i < count; i++) {
        printf("  %s (%s) - last seen %lu ms ago\n",
               peers[i].id,
               peers[i].kind == Robot ? "Robot" : "Sensor",
               peers[i].last_seen_ms);
    }
    
    // Stop federation
    amos_link_federation_stop(fed);
    amos_link_node_drop(node);
    return 0;
}
```

### Metrics

```c
#include "amos_link.h"
#include <stdio.h>

int main() {
    amos_link_node* node = amos_link_node_new("my-robot", Robot);
    amos_link_publisher* pub = amos_link_publisher_new(node, "amos/my-robot/status");
    
    // Publish some messages
    for (int i = 0; i < 100; i++) {
        uint8_t payload[8] = {i};
        amos_link_publisher_publish(pub, payload, sizeof(payload));
    }
    
    // Check node metrics
    amos_link_metrics metrics;
    amos_link_node_metrics(node, &metrics);
    
    printf("Node metrics:\n");
    printf("  Published:  %llu\n", metrics.published);
    printf("  Delivered:  %llu\n", metrics.delivered);
    printf("  Dropped:    %llu\n", metrics.dropped);
    printf("  Errors:     %llu\n", metrics.errors);
    
    double ratio = amos_link_metrics_delivery_ratio(&metrics);
    printf("  Delivery ratio: %.2f%%\n", ratio * 100.0);
    
    amos_link_publisher_drop(pub);
    amos_link_node_drop(node);
    return 0;
}
```

### Health Monitoring

```c
#include "amos_link.h"
#include <stdio.h>

int main() {
    amos_link_node* node = amos_link_node_new("my-robot", Robot);
    amos_link_federation* fed = amos_link_node_spawn_federation(node, 50);
    
    sleep(2);
    
    // Get peer list
    amos_link_peer_view peers[16];
    size_t count = amos_link_node_peers(node, peers, 16);
    
    // Evaluate health
    amos_link_health health = amos_link_evaluate_health(
        peers, count, 
        true,   // clock_synced
        5000    // stale_threshold_ms
    );
    
    const char* status_str;
    switch (health) {
        case Healthy:  status_str = "Healthy"; break;
        case Degraded: status_str = "Degraded"; break;
        case Down:     status_str = "Down"; break;
        default:       status_str = "Unknown"; break;
    }
    printf("System health: %s\n", status_str);
    
    amos_link_federation_stop(fed);
    amos_link_node_drop(node);
    return 0;
}
```

## API Reference

### Core Types

- `amos_link_node`: Network participant
- `amos_link_publisher`: Publishes messages on a topic
- `amos_link_subscriber`: Subscribes to topic patterns
- `amos_link_federation`: Manages peer discovery

### Quality of Service

```c
amos_link_qos amos_link_qos_default();      // Reliable, KeepAll, depth=16
amos_link_qos amos_link_qos_sensor();       // BestEffort, KeepLast(1)
amos_link_qos amos_link_qos_control();      // Reliable, KeepLast(1)
amos_link_qos amos_link_qos_state();        // Reliable, KeepAll, depth=8
```

### Topic Patterns

Topics follow the format: `amos/<peer-id>/<channel>/<name>`

Wildcards:
- `*`: Match one segment (e.g., `amos/*/sensor/imu`)
- `**`: Match zero or more segments (e.g., `amos/**/status`)

### Error Handling

Most functions return:
- `0` on success
- `-1` on error (check `amos_link_last_error()`)
- `-2` for null pointer arguments

```c
const char* error = amos_link_last_error();
if (error && error[0] != '\0') {
    fprintf(stderr, "Error: %s\n", error);
    amos_link_error_clear();
}
```

## Testing

Run the test suite:

```bash
cargo test -p amos-link-cc
```

The test suite includes 90+ tests covering:
- Node lifecycle and metrics
- Publisher/Subscriber API
- QoS validation
- Frame encoding/decoding
- Federation and peer discovery
- Health evaluation
- Error handling and null safety
- End-to-end pub/sub roundtrip

## Aerospace-Grade Standards

This SDK follows aerospace-grade development practices:

- **Memory Safety**: All FFI boundaries are validated for null pointers
- **Thread Safety**: Internal synchronization with Arc, Mutex, and atomic operations
- **Error Handling**: Comprehensive error reporting through thread-local storage
- **Resource Management**: RAII-style cleanup with explicit drop functions
- **Testing**: 90+ unit and integration tests with >95% coverage
- **Documentation**: Complete API documentation with examples
- **Validation**: Input validation on all public APIs (topic format, QoS parameters)
- **Deterministic Behavior**: No unwrap/panic in production code paths

## License

See the root LICENSE file.

## See Also

- [amos-link](../amos-link) - The core Rust middleware
- [AmOS Documentation](../../docs) - System architecture and design
