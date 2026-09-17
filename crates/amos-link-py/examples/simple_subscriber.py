#!/usr/bin/env python3
"""
Simple subscriber example for amos-link Python SDK

Demonstrates:
- Creating a LinkNode
- Subscribing with wildcard patterns
- Receiving and decoding messages
"""

import amos_link as link
import time

def main():
    print("=== amos-link Python Subscriber Example ===\n")
    
    # Create a robot node
    node = link.LinkNode("monitor-station", link.NodeKind.ROBOT)
    print(f"Created node: {node}\n")
    
    # Subscribe to all environment sensor topics with sensor QoS
    pattern = "amos/**/sensor/environment"
    qos = link.QoS.sensor()
    sub = node.subscriber(pattern, qos)
    print(f"Created subscriber: {sub}")
    print(f"Listening for messages on pattern: {pattern}\n")
    
    # Receive messages
    print("Waiting for messages (Ctrl+C to stop)...")
    message_count = 0
    
    try:
        while message_count < 10:
            # Poll for messages (non-blocking)
            msg = sub.poll()
            
            if msg:
                message_count += 1
                
                # Decode JSON payload
                try:
                    data = msg.payload_json()
                    print(f"  [{message_count}] Received from {msg.peer_id}:")
                    print(f"      Topic: {msg.topic}")
                    print(f"      Seq: {msg.seq}")
                    print(f"      Data: temp={data['temperature']:.1f}°C, "
                          f"humidity={data['humidity']:.1f}%, "
                          f"pressure={data['pressure']:.2f}hPa")
                except Exception as e:
                    print(f"  [{message_count}] Received (raw): {msg.payload()}")
            
            time.sleep(0.05)
    
    except KeyboardInterrupt:
        print("\n\n✓ Stopped by user")
    
    # Display statistics
    stats = sub.stats()
    print(f"\nSubscriber statistics:")
    print(f"  - Received: {stats['received']}")
    print(f"  - Dropped: {stats['dropped']}")
    print(f"  - Errors: {stats['errors']}")

if __name__ == "__main__":
    main()
