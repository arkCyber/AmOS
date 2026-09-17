#!/usr/bin/env python3
"""
Simple publisher example for amos-link Python SDK

Demonstrates:
- Creating a LinkNode
- Publishing messages to a topic
- Monitoring node metrics
"""

import amos_link as link
import time
import json

def main():
    print("=== amos-link Python Publisher Example ===\n")
    
    # Create a robot node
    node = link.LinkNode("weather-station-01", link.NodeKind.ROBOT)
    print(f"Created node: {node}\n")
    
    # Create a publisher on a specific topic
    topic = "amos/weather-station-01/sensor/environment"
    pub = node.publisher(topic)
    print(f"Created publisher: {pub}\n")
    
    # Publish sensor data
    print("Publishing sensor readings...")
    for i in range(10):
        # Create sensor reading as JSON
        reading = {
            "sequence": i,
            "temperature": 20.0 + i * 0.5,
            "humidity": 65.0 - i * 0.3,
            "pressure": 1013.25 + i * 0.1,
        }
        
        # Publish as JSON
        pub.publish_json(reading)
        print(f"  [{i+1}/10] Published: temp={reading['temperature']:.1f}°C, "
              f"humidity={reading['humidity']:.1f}%, pressure={reading['pressure']:.2f}hPa")
        
        time.sleep(0.1)
    
    print("\n✓ Published 10 messages")
    
    # Display metrics
    metrics = node.metrics()
    print(f"\nNode metrics: {metrics}")
    print(f"  - Published: {metrics.published}")
    print(f"  - Delivered: {metrics.delivered}")
    print(f"  - Delivery ratio: {metrics.delivery_ratio()*100:.1f}%")

if __name__ == "__main__":
    main()
