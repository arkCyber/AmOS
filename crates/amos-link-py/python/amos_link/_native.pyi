"""Type stubs for the `amos_link._native` extension module.

The name is not free: PEP 561 resolves the stub of the compiled submodule
`amos_link._native` to `amos_link/_native.pyi` (the previous spelling,
`amos_link_py.pyi`, named nothing the package exposes, so no tool ever read
it). `py.typed` next to `__init__.py` marks the package as typed.

Every class and member below is bound to the pyo3 surface in
`crates/amos-link-py/src/lib.rs` by `scripts/py-stub-scan.mjs` (REQ-A719):
the script reads both files as text and fails on any class/member that
exists on one side only, so a rename in Rust cannot leave a stale
suggestion in an editor without a red.
"""

from typing import Any, Dict, Optional

class NodeKind:
    """Node type classification for federation"""

    ROBOT: NodeKind
    SENSOR: NodeKind
    BRAIN: NodeKind
    ACTUATOR: NodeKind
    TOOL: NodeKind

class Reliability:
    """Message delivery reliability"""

    BEST_EFFORT: Reliability
    RELIABLE: Reliability

class DropPolicy:
    """What a bounded queue does when it is full"""

    DROP_NEWEST: DropPolicy
    DROP_OLDEST: DropPolicy

class QoS:
    """Quality of Service configuration"""

    def __init__(
        self, reliability: Reliability, depth: int, drop_policy: DropPolicy
    ) -> None: ...
    @staticmethod
    def default() -> QoS: ...
    @staticmethod
    def sensor() -> QoS: ...
    @staticmethod
    def control() -> QoS: ...
    @staticmethod
    def state() -> QoS: ...

class Timestamp:
    """High-precision timestamp"""

    def __init__(self, secs: int, nanos: int) -> None: ...
    @staticmethod
    def now() -> Timestamp: ...
    @property
    def secs(self) -> int: ...
    @property
    def nanos(self) -> int: ...

class LinkMetrics:
    """Node performance metrics"""

    @property
    def published(self) -> int: ...
    @property
    def delivered(self) -> int: ...
    @property
    def dropped(self) -> int: ...
    @property
    def errors(self) -> int: ...
    def delivery_ratio(self) -> float: ...

class LinkNode:
    """Network node for pub/sub communication"""

    def __init__(self, peer_id: str, kind: NodeKind) -> None: ...
    @property
    def peer_id(self) -> str: ...
    @property
    def kind(self) -> NodeKind: ...
    def metrics(self) -> LinkMetrics: ...
    def publisher(self, topic: str) -> Publisher: ...
    def subscriber(self, pattern: str, qos: Optional[QoS] = None) -> Subscriber: ...
    def spawn_federation(self, period_ms: int) -> FederationTask: ...

class Publisher:
    """Message publisher"""

    @property
    def topic(self) -> str: ...
    def publish(self, data: bytes) -> None: ...
    def publish_json(self, obj: Any) -> None: ...

class ReceivedMessage:
    """Received message with metadata"""

    topic: str
    publisher: str
    seq: int
    stamp: Timestamp
    def payload(self) -> bytes: ...
    def payload_str(self) -> str: ...
    def payload_json(self) -> Any: ...

class Subscriber:
    """Message subscriber"""

    @property
    def pattern(self) -> str: ...
    def poll(self) -> Optional[ReceivedMessage]: ...
    def recv(self, timeout_secs: Optional[float] = None) -> Optional[ReceivedMessage]: ...
    def stats(self) -> Dict[str, int]: ...

class FederationTask:
    """Background peer discovery task"""

    def stop(self) -> None: ...

__version__: str
