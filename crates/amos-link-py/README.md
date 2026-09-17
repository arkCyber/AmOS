# amos-link Python SDK

Python bindings for the `amos-link` robot middleware, providing decentralized pub/sub communication following aerospace-grade standards.

## Features

- **Type-Safe API**: Full Python bindings for `amos-link` core functionality
- **In-Process Communication**: High-performance message passing within a single process
- **QoS Profiles**: Configurable reliability, history, and drop policies
- **Wildcard Subscriptions**: Subscribe to multiple topics with pattern matching
- **Federation**: Peer discovery via UDP multicast heartbeats
- **Metrics & Monitoring**: Built-in counters for published, delivered, and dropped messages
- **Thread-Safe**: All types use `Arc` for safe sharing across Python threads
- **Aerospace-Grade**: Comprehensive error handling, documentation, and testing

## Installation

### From Wheel

```bash
pip install /Users/arksong/AmOS/target/wheels/amos_link-0.1.0-cp38-abi3-macosx_11_0_arm64.whl
```

### Build from Source

```bash
cd crates/amos-link-py
maturin build --release
pip install target/wheels/amos_link-*.whl
```

### Development Mode

```bash
# Create a virtual environment first
python3 -m venv venv
source venv/bin/activate
maturin develop --release
```

## Quick Start

```python
from amos_link import LinkNode, NodeKind, QoS

# Create a node
node = LinkNode("robot1", NodeKind.ROBOT)

# Create a publisher
pub = node.publisher("amos/robot1/sensor/imu")

# Publish JSON data
pub.publish_json({
    "accel": [0.0, 0.0, 9.8],
    "gyro": [0.0, 0.0, 0.0]
})

# Create a subscriber
sub = node.subscriber("amos/robot1/sensor/imu", QoS.sensor())

# Receive messages
msg = sub.poll()
if msg is not None:
    data = msg.payload_json()
    print(f"Received: {data}")
```

## API Reference

### LinkNode

The main entry point for creating publishers and subscribers.

```python
node = LinkNode(peer_id: str, kind: NodeKind)
```

- `peer_id`: Unique identifier for this node
- `kind`: Node type (ROBOT, SENSOR, BRAIN, ACTUATOR, TOOL)

**Methods:**
- `publisher(topic: str) -> Publisher`: Create a publisher for a topic
- `subscriber(pattern: str, qos: Optional[QoS]) -> Subscriber`: Create a subscriber
- `spawn_federation(period_ms: int) -> FederationTask`: Start peer discovery
- `metrics() -> LinkMetrics`: Get node-wide metrics
- `peer()`: Get the node's peer ID (alternative to `peer_id` property)
- `uptime_ms() -> int`: Get node uptime in milliseconds

**Properties:**
- `peer_id`: Get the node's peer ID
- `kind`: Get the node kind

### Publisher

Publishes messages to a topic.

**Methods:**
- `publish(data: bytes)`: Publish raw bytes
- `publish_json(obj)`: Publish JSON-serializable Python object

**Properties:**
- `topic`: Get the publication topic

### Subscriber

Receives messages matching a topic pattern.

**Methods:**
- `poll() -> Optional[ReceivedMessage]`: Non-blocking receive
- `recv(timeout_secs: Optional[float]) -> Optional[ReceivedMessage]`: Blocking receive with optional timeout
- `stats() -> dict`: Get subscriber statistics

**Properties:**
- `pattern`: Get the subscription pattern

### ReceivedMessage

A received message with metadata.

**Methods:**
- `payload() -> bytes`: Get raw payload bytes
- `payload_str() -> str`: Decode payload as UTF-8 string
- `payload_json()`: Decode payload as JSON

**Properties:**
- `topic`: Topic this message was published to
- `publisher`: Publisher's peer ID (string)
- `seq`: Message sequence number
- `stamp`: Publication timestamp (Timestamp object)

### QoS

Quality of Service configuration.

```python
# Predefined profiles
QoS.default()  # Best-effort, keep-last 1
QoS.sensor()   # Best-effort, keep-last 10
QoS.control()  # Reliable, keep-all 100
QoS.state()    # Reliable, keep-last 1

# Custom QoS
qos = QoS(Reliability.BEST_EFFORT, 10, DropPolicy.DROP_NEWEST)
```

### NodeKind

Node type enumeration.

- `NodeKind.ROBOT`: Robot/actuator node
- `NodeKind.SENSOR`: Sensor data source
- `NodeKind.BRAIN`: Central processing/decision node
- `NodeKind.ACTUATOR`: Actuator control node
- `NodeKind.TOOL`: Tool or peripheral device

### Reliability

Message delivery guarantee.

- `Reliability.BEST_EFFORT`: Fast, no retransmission
- `Reliability.RELIABLE`: Guaranteed delivery

### DropPolicy

Queue overflow handling.

- `DropPolicy.DROP_OLDEST`: Discard oldest messages when queue is full (requires depth=1)
- `DropPolicy.DROP_NEWEST`: Discard newest messages when queue is full (use for depth > 1)

### Timestamp

Calibrated wall-clock timestamp.

```python
ts = Timestamp.now()
print(f"Seconds: {ts.secs}, Nanoseconds: {ts.nanos}")

# Create custom timestamp
ts = Timestamp(secs=1234567890, nanos=123456789)
```

### LinkMetrics

Node-wide message counters.

**Properties:**
- `published`: Total frames published
- `delivered`: Total frames delivered to subscribers
- `dropped`: Total frames dropped
- `delivery_ratio()`: Delivery success percentage (0-100)

### FederationTask

Manages peer discovery via UDP multicast.

**Methods:**
- `stop()`: Stop the federation task

## Examples

### Simple Pub/Sub

```bash
cd crates/amos-link-py/examples
python3 simple_pubsub.py
```

Demonstrates basic publishing and subscribing within a single process.

### Multi-Topic Communication

```bash
python3 multi_topic.py
```

Shows wildcard subscriptions and multiple publishers/subscribers.

### Federation

```bash
python3 federation.py
```

Demonstrates peer discovery and node heartbeats.

## Topic Naming Convention

Topics in `amos-link` follow a hierarchical structure:

```
amos/<peer_id>/<channel>/<name>
```

- `peer_id`: The publishing node's identifier
- `channel`: Message category (sensor, control, state, etc.)
- `name`: Specific topic name

**Examples:**
- `amos/robot1/sensor/imu` - IMU data from robot1
- `amos/brain/control/motors` - Motor commands from brain
- `amos/sensor_hub/sensor/temperature` - Temperature readings

**Wildcards:**
- `*` matches exactly one segment: `amos/*/sensor/imu` matches any peer's IMU data
- `**` matches zero or more segments: `amos/robot1/sensor/**` matches all sensor data from robot1

**Important:** Topics must not start with `/`. Use `amos/` as the root namespace.

## Testing

Run the comprehensive test suite:

```bash
cd crates/amos-link-py
python3 -m pytest tests/test_amos_link.py -v
```

The test suite includes:
- Unit tests for all API components
- End-to-end pub/sub tests
- Wildcard subscription tests
- Metrics validation
- Error handling verification

## Architecture

### Thread Safety

All Python wrapper types (`PyLinkNode`, `PyPublisher`, `PySubscriber`) use `Arc<T>` for safe sharing across Python threads. The Global Interpreter Lock (GIL) is released during blocking operations using `py.allow_threads()`.

### Error Handling

All Rust `LinkError` values are converted to `PyRuntimeError` with descriptive messages. Invalid inputs raise `PyValueError`.

### Memory Safety

PyO3 ensures proper lifetime management between Python and Rust. All references are bounds-checked and memory-safe.

### Async Integration

Asynchronous Rust operations (like `spawn_federation`) are wrapped using a Tokio runtime and exposed as synchronous Python methods.

## Limitations (v1)

- **In-Process Only**: `LinkNode::in_process` creates isolated brokers. Cross-process data communication is not supported in v1 (federation only handles peer discovery).
- **No Remote Transport**: UDP multicast is used for heartbeats, but message data stays in-process.
- **Blocking Recv**: The `recv()` method uses polling with sleep, not true async/await.

## Performance Considerations

- **Zero-Copy Deserialization**: Message payloads are decoded on-demand
- **Minimal Allocations**: Uses `Arc` for shared ownership without cloning
- **Lock-Free Where Possible**: Rust internals use atomic operations for metrics

## Aerospace-Grade Standards

This SDK follows aerospace-grade development practices:

1. **Comprehensive Testing**: Unit, integration, and end-to-end tests
2. **Error Handling**: All failure modes are explicit and documented
3. **Documentation**: API reference, examples, and architecture notes
4. **Type Safety**: Strong typing enforced at compile time (Rust) and runtime (Python)
5. **Memory Safety**: Rust's ownership system prevents memory bugs
6. **Thread Safety**: Explicit synchronization with `Arc` and `Mutex`
7. **Metrics**: Built-in observability for debugging and monitoring

## License

MIT OR Apache-2.0

## Contributing

This Python SDK is part of the AmOS project. See the main repository for contribution guidelines.

## Version

0.1.0 - Initial release with core pub/sub functionality
