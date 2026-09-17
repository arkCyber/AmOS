#!/usr/bin/env python3
"""
Simple publisher-subscriber example for amos-link Python SDK.

This example demonstrates:
- Creating a LinkNode
- Publishing JSON messages
- Subscribing to topics
- Receiving and decoding messages
"""

import sys
import time
import json

# Add the python package to the path
sys.path.insert(0, '../python')

from amos_link import LinkNode, NodeKind, QoS, Reliability, DropPolicy

def main():
    print("=== amos-link Python SDK: Simple Pub/Sub Example ===\n")
    
    # Create a LinkNode for in-process communication
    node = LinkNode("python_node", NodeKind.ROBOT)
    print(f"Created node: {node}")
    print(f"Node ID: {node.peer_id}")
    print(f"Node kind: {node.kind}\n")
    
    # Create a publisher on the "sensors/temperature" topic
    pub = node.publisher("sensors/temperature")
    print(f"Created publisher: {pub}\n")
    
    # Create a subscriber with QoS that keeps more history
    # QoS(reliability, depth, drop_policy)
    # For depth > 1, must use DROP_NEWEST
    qos = QoS(Reliability.BEST_EFFORT, 10, DropPolicy.DROP_NEWEST)
    sub = node.subscriber("sensors/temperature", qos)
    print(f"Created subscriber: {sub}\n")
    
    # Small delay to ensure subscriber is ready
    time.sleep(0.1)
    
    # Publish 5 messages
    print("Publishing 5 temperature readings...")
    for i in range(5):
        temperature = 20.0 + i * 0.5
        message = {
            "sensor_id": "temp_01",
            "temperature": temperature,
            "unit": "celsius",
            "timestamp": time.time()
        }
        pub.publish_json(message)
        print(f"  Published: {json.dumps(message)}")
        time.sleep(0.1)
    
    print("\nReceiving messages...")
    received_count = 0
    timeout_count = 0
    max_timeout = 10
    
    while received_count < 5 and timeout_count < max_timeout:
        msg = sub.poll()
        if msg is not None:
            print(f"  Received from {msg.publisher} on topic {msg.topic}:")
            print(f"    Sequence: {msg.seq}")
            print(f"    Timestamp: {msg.stamp}")
            
            # Decode JSON payload
            try:
                data = msg.payload_json()
                print(f"    Data: {json.dumps(data)}")
            except Exception as e:
                print(f"    Error decoding JSON: {e}")
            
            received_count += 1
        else:
            time.sleep(0.01)
            timeout_count += 1
    
    # Display statistics
    print(f"\nReceived {received_count} out of 5 messages")
    
    # Node metrics
    metrics = node.metrics()
    print(f"\nNode metrics:")
    print(f"  Published: {metrics.published}")
    print(f"  Delivered: {metrics.delivered}")
    print(f"  Dropped: {metrics.dropped}")
    print(f"  Delivery ratio: {metrics.delivery_ratio():.2%}")
    
    # Subscriber stats
    stats = sub.stats()
    print(f"\nSubscriber stats:")
    print(f"  Received: {stats['received']}")
    print(f"  Dropped: {stats['dropped']}")
    print(f"  Decode errors: {stats['decode_errors']}")
    
    print("\n=== Example complete ===")

if __name__ == "__main__":
    main()
