#!/usr/bin/env python3
"""
Single-process pub/sub example for amos-link Python SDK

Demonstrates:
- Publisher and subscriber in the same process
- Sharing a LinkNode
- Message flow verification
"""

import amos_link as link
import time

def main():
    print("=== amos-link Python Single-Process Pub/Sub Example ===\n")
    
    # Create a single node shared by publisher and subscriber
    node = link.LinkNode("test-node", link.NodeKind.ROBOT)
    print(f"Created node: {node}\n")
    
    # Create publisher and subscriber on the same node
    topic = "amos/test/data"
    pub = node.publisher(topic)
    sub = node.subscriber("amos/test/*", link.QoS.default())
    
    print(f"Created publisher: {pub}")
    print(f"Created subscriber: {sub}\n")
    
    # Publish messages
    print("Publishing 5 messages...")
    for i in range(5):
        message = {"id": i, "value": i * 10, "name": f"message-{i}"}
        pub.publish_json(message)
        print(f"  Published: {message}")
        time.sleep(0.05)
    
    print("\nWaiting for messages...")
    time.sleep(0.1)
    
    # Receive messages
    received_count = 0
    for _ in range(10):
        msg = sub.poll()
        if msg:
            received_count += 1
            data = msg.payload_json()
            print(f"  Received [{msg.seq}]: {data}")
        time.sleep(0.05)
    
    print(f"\n✓ Published 5 messages, received {received_count} messages")
    
    # Display metrics and stats
    metrics = node.metrics()
    stats = sub.stats()
    
    print(f"\nNode metrics:")
    print(f"  - Published: {metrics.published}")
    print(f"  - Delivered: {metrics.delivered}")
    print(f"  - Delivery ratio: {metrics.delivery_ratio()*100:.1f}%")
    
    print(f"\nSubscriber stats:")
    print(f"  - Received: {stats['received']}")
    print(f"  - Dropped: {stats['dropped']}")
    print(f"  - Errors: {stats['errors']}")

if __name__ == "__main__":
    main()
