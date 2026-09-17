#!/usr/bin/env python3
"""
Federation and peer discovery example for amos-link Python SDK.

This example demonstrates:
- Starting federation for peer discovery
- Monitoring node heartbeats
- Advertising node presence
"""

import sys
import time

# Add the python package to the path
sys.path.insert(0, '../python')

from amos_link import LinkNode, NodeKind

def main():
    print("=== amos-link Python SDK: Federation Example ===\n")
    
    # Create multiple nodes of different kinds
    robot_node = LinkNode("robot_01", NodeKind.ROBOT)
    sensor_node = LinkNode("sensor_01", NodeKind.SENSOR)
    brain_node = LinkNode("brain_01", NodeKind.BRAIN)
    
    print("Created nodes:")
    print(f"  - {robot_node}")
    print(f"  - {sensor_node}")
    print(f"  - {brain_node}\n")
    
    # Start federation on each node (heartbeat every 1 second)
    print("Starting federation tasks...")
    robot_fed = robot_node.spawn_federation(1000)
    sensor_fed = sensor_node.spawn_federation(1000)
    brain_fed = brain_node.spawn_federation(1000)
    print("Federation tasks started\n")
    
    # Let federation run for a few seconds
    print("Running federation for 5 seconds...")
    print("(Nodes are advertising their presence via UDP multicast)")
    time.sleep(5)
    
    # Create publishers and test communication
    print("\nTesting pub/sub between federated nodes...")
    robot_pub = robot_node.publisher("robot/status")
    sensor_sub = sensor_node.subscriber("robot/status", None)
    
    # Publish a message
    robot_pub.publish_json({"status": "active", "battery": 85})
    print("Robot published status message")
    
    time.sleep(0.1)
    
    # Try to receive (note: in-process broker limitation)
    msg = sensor_sub.poll()
    if msg is not None:
        print(f"Sensor received: {msg.payload_json()}")
    else:
        print("No message received (expected - nodes use separate in-process brokers)")
    
    # Display metrics for each node
    print("\nNode metrics:")
    for name, node in [("Robot", robot_node), ("Sensor", sensor_node), ("Brain", brain_node)]:
        metrics = node.metrics()
        print(f"  {name}: published={metrics.published}, delivered={metrics.delivered}")
    
    # Stop federation tasks
    print("\nStopping federation tasks...")
    robot_fed.stop()
    sensor_fed.stop()
    brain_fed.stop()
    print("Federation tasks stopped")
    
    print("\n=== Example complete ===")

if __name__ == "__main__":
    main()
