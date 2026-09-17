#!/usr/bin/env python3
"""Quick test to check if Topic::pattern is being used"""

from amos_link import LinkNode, NodeKind, QoS

# Create a node
node = LinkNode("test", NodeKind.ROBOT)

# Try to create a subscriber with a wildcard
try:
    sub = node.subscriber("amos/test/sensor/**", QoS.sensor())
    print("SUCCESS: Subscriber created with wildcard pattern")
    print(f"Pattern: {sub.pattern}")
except ValueError as e:
    print(f"FAILED: {e}")
