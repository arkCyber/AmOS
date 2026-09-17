"""
amos-link: Robot middleware with decentralized pub/sub

This module provides Python bindings for the amos-link robot middleware,
following aerospace-grade standards for safety, reliability, and documentation.

Example:
    >>> from amos_link import LinkNode, NodeKind, QoS
    >>> node = LinkNode("robot1", NodeKind.ROBOT)
    >>> pub = node.publisher("/sensors/imu")
    >>> pub.publish_json({"accel": [0, 0, 9.8]})
"""

from amos_link._native import (
    NodeKind,
    Reliability,
    DropPolicy,
    QoS,
    Timestamp,
    LinkMetrics,
    LinkNode,
    Publisher,
    Subscriber,
    ReceivedMessage,
    FederationTask,
    __version__,
)

__all__ = [
    "NodeKind",
    "Reliability",
    "DropPolicy",
    "QoS",
    "Timestamp",
    "LinkMetrics",
    "LinkNode",
    "Publisher",
    "Subscriber",
    "ReceivedMessage",
    "FederationTask",
    "__version__",
]
