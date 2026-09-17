# amos-link-cc Examples

Practical examples demonstrating the amos-link C/C++ SDK.

## Building

First, build the amos-link-cc library:

```bash
cd ../..
cargo build --release -p amos-link-cc
```

Then build the examples:

```bash
cd crates/amos-link-cc/examples
make
```

## Examples

### Important: Cross-Process Communication

⚠️ **The current C API (v1) uses in-process broker only.**

- ✅ **Single-process pub/sub works** - publisher and subscriber in the same process
- ❌ **Cross-process pub/sub does NOT work** - separate processes cannot communicate data

Each `LinkNode` created with `amos_link_node_new()` gets its own isolated in-process broker. Federation enables peer discovery via UDP multicast, but **actual message data cannot cross process boundaries** in v1.

**Why?** The Rust `amos-link` supports multiple transport layers (Zenoh, network brokers), but the C API v1 exposes only the in-process variant for simplicity.

**Recommendation:** Design C applications to use pub/sub within a single process (see `single_process_pubsub.c`).

### 0. Single-Process Pub/Sub (`single_process_pubsub.c`) ⭐ **Start Here**

The recommended way to use amos-link in C. Demonstrates complete publisher and subscriber in one process.

**Run:**
```bash
make run-single
# or
./single_process_pubsub
```

**Example output:**
```
amos-link Single-Process Pub/Sub Example
==========================================

✓ Node created: demo-node
✓ Publisher created on topic: amos/demo-node/sensor/temperature
✓ Subscriber created with pattern: amos/demo-node/sensor/*

Publishing messages...
  [1] Published: {"seq":1,"temp":20.7}
  [2] Published: {"seq":2,"temp":24.9}
  ...

Polling for messages...
  [1] Received from demo-node: {"seq":1,"temp":20.7}
      Topic: amos/demo-node/sensor/temperature, Seq: 1
  ...

✓ Success! Received all 5 messages

Node metrics:
  Published: 5
  Delivered: 5
  Dropped:   0
  Delivery:  100%
```

### 1. Simple Publisher (`simple_publisher.c`)

Demonstrates basic message publishing. Publishes sensor data at 1 Hz with metrics reporting.

**Run:**
```bash
make run-publisher
# or
./simple_publisher [peer-id] [topic]
```

**Example output:**
```
amos-link Simple Publisher
  Peer ID: weather-sensor-01
  Topic:   amos/weather-sensor-01/sensor/environment

Node created: weather-sensor-01
Publisher created on topic: amos/weather-sensor-01/sensor/environment

Publishing sensor data (Ctrl+C to stop)...

[1] Published: temp=23.4°C, humidity=58.2%
[2] Published: temp=24.1°C, humidity=56.7%
...
```

### 2. Simple Subscriber (`simple_subscriber.c`)

Demonstrates subscribing to topics with wildcard patterns. Receives and displays all matching messages.

**Run:**
```bash
make run-subscriber
# or
./simple_subscriber [peer-id] [pattern]
```

**Example output:**
```
amos-link Simple Subscriber
  Peer ID: weather-monitor
  Pattern: amos/**/sensor/environment

Node created: weather-monitor
Subscriber created
Waiting for messages (Ctrl+C to stop)...

[1] From weather-sensor-01 on amos/weather-sensor-01/sensor/environment
      seq=1, frame_len=234, payload_len=12
      SensorData: temp=23.4°C, humidity=58.2%, seq=1
```

**Try it together:**

⚠️ **Note:** These will run in separate processes and **will NOT communicate** in v1. They will each publish/subscribe independently. For working pub/sub, see `single_process_pubsub.c`.

Terminal 1:
```bash
make run-publisher
```

Terminal 2:
```bash
make run-subscriber
```

### 3. Federation (`federation.c`)

Demonstrates peer discovery and network monitoring. Discovers other nodes and evaluates system health.

**Run:**
```bash
make run-federation
# or
./federation [peer-id] [beacon-interval-ms]
```

**Example output:**
```
amos-link Federation Example
  Peer ID: monitor-station
  Beacon interval: 100 ms

Node created: monitor-station
Heartbeat topic: amos/monitor-station/heartbeat
Federation started

Monitoring network (Ctrl+C to stop)...

=== Iteration 1 ===

Discovered 2 peer(s):
  [1] weather-sensor-01 (Sensor)
      Last seen: 145 ms ago
      Beacons:   12
  [2] weather-monitor (Robot)
      Last seen: 98 ms ago
      Beacons:   8

Active topic(s): 3
  - amos/weather-sensor-01/sensor/environment
  - amos/monitor-station/heartbeat
  - amos/weather-sensor-01/heartbeat

System Health: Healthy

Node Metrics:
  Published:  12
  Delivered:  12
  Dropped:    0
  Errors:     0
  Delivery:   100.0%
  Uptime:     2.1 seconds
```

**Try with multiple nodes:**

Terminal 1:
```bash
./federation node-1
```

Terminal 2:
```bash
./federation node-2
```

Terminal 3:
```bash
./federation node-3
```

Watch them discover each other!

### 4. Request-Response (`request_response.c`)

Demonstrates a request-response RPC pattern. A client sends computation requests and waits for responses from a server.

**Run the server:**
```bash
make run-server
# or
./request_response server
```

**Run the client (in another terminal):**
```bash
make run-client
# or
./request_response client
```

**Server output:**
```
=== Request-Response Server ===

Server node created
Server listening for requests...

Received request #1 from rpc-client: value=5
  -> Sent response: factorial(5) = 120

Received request #2 from rpc-client: value=7
  -> Sent response: factorial(7) = 5040
...
```

**Client output:**
```
=== Request-Response Client ===

Client node created
Client ready
Sending requests...

[1] Sending request: factorial(5)
  <- Received response: result=120

[2] Sending request: factorial(7)
  <- Received response: result=5040
...
```

## API Patterns

### Basic Pub/Sub

1. Create a node
2. Create publisher/subscriber
3. Publish messages / Poll for messages
4. Clean up with `_drop()` functions

### Federation

1. Create a node
2. Call `amos_link_node_spawn_federation()`
3. Query peers with `amos_link_node_peers()`
4. Stop with `amos_link_federation_stop()`

### Error Handling

```c
const char* error = amos_link_last_error();
if (error && error[0] != '\0') {
    fprintf(stderr, "Error: %s\n", error);
    amos_link_error_clear();
}
```

### Topic Patterns

- Exact: `amos/robot-1/sensor/imu`
- Single wildcard: `amos/*/sensor/imu` (any peer)
- Multi wildcard: `amos/**/sensor` (any depth)

### QoS Presets

```c
amos_link_qos_sensor()   // BestEffort, KeepLast(1) - high-rate data
amos_link_qos_control()  // Reliable, KeepLast(1)   - commands
amos_link_qos_state()    // Reliable, KeepAll(8)    - state updates
```

## Troubleshooting

### Library not found

**macOS:**
```bash
export DYLD_LIBRARY_PATH=../../target/release
```

**Linux:**
```bash
export LD_LIBRARY_PATH=../../target/release
```

Or run with:
```bash
DYLD_LIBRARY_PATH=../../target/release ./simple_publisher
```

### No messages received

**Most common issue:** Publisher and subscriber are in different processes. In v1, this will NOT work for data exchange.

✅ **Solution:** Use both publisher and subscriber in the same process (see `single_process_pubsub.c`).

For same-process pub/sub:
```c
amos_link_node* node = amos_link_node_new("my-peer", Robot);
amos_link_publisher* pub = amos_link_publisher_new(node, "topic");
amos_link_subscriber* sub = amos_link_subscriber_new(node, "topic", qos);
// Now publish and poll - messages will be delivered!
```

Federation discovery (peer awareness only, not data exchange):
```c
// On both nodes:
amos_link_federation* fed = amos_link_node_spawn_federation(node, 50);
sleep(1);  // Wait for discovery - peers will see each other but cannot exchange messages in v1
```

### Build failures

Make sure the library is built first:
```bash
cd ../.. && cargo build --release -p amos-link-cc
```

## Next Steps

- Read the [main README](../README.md) for complete API reference
- Check the [test suite](../tests/abi_test.rs) for more usage patterns
- See [amos-link documentation](../../amos-link/README.md) for architecture details
