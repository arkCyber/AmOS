#!/usr/bin/env python3
"""
Multi-topic publisher-subscriber example for amos-link Python SDK.

This example demonstrates:
- Publishing to multiple topics
- Wildcard subscription patterns
- Different QoS profiles
- Message filtering
"""

import sys
import time
import json

# Add the python package to the path
sys.path.insert(0, '../python')

from amos_link import LinkNode, NodeKind, QoS, Reliability, DropPolicy

def main():
    print("=== amos-link Python SDK: Multi-Topic Example ===\n")
    
    # Create a LinkNode
    node = LinkNode("multi_topic_node", NodeKind.SENSOR)
    print(f"Created node: {node}\n")
    
    # Create publishers for different sensor types
    # Topics follow amos/<peer>/<channel>/<name> structure
    imu_pub = node.publisher("amos/multi_topic_node/sensor/imu")
    gps_pub = node.publisher("amos/multi_topic_node/sensor/gps")
    camera_pub = node.publisher("amos/multi_topic_node/sensor/camera")
    
    print("Created 3 publishers:")
    print(f"  - {imu_pub}")
    print(f"  - {gps_pub}")
    print(f"  - {camera_pub}\n")
    
    # Subscribe to all sensor topics using wildcard
    # ** matches zero or more segments
    all_sensors_sub = node.subscriber("amos/multi_topic_node/sensor/**", QoS.sensor())
    print(f"Created wildcard subscriber: {all_sensors_sub}\n")
    
    # Subscribe to only IMU with control QoS (reliable)
    imu_sub = node.subscriber("amos/multi_topic_node/sensor/imu", QoS.control())
    print(f"Created IMU subscriber: {imu_sub}\n")
    
    # Publish messages to different topics
    print("Publishing messages to different topics...")
    
    # IMU data
    imu_data = {"accel": [0.1, 0.2, 9.8], "gyro": [0.01, -0.02, 0.0]}
    imu_pub.publish_json(imu_data)
    print(f"  [IMU] Published: {json.dumps(imu_data)}")
    
    time.sleep(0.05)
    
    # GPS data
    gps_data = {"lat": 37.7749, "lon": -122.4194, "alt": 10.5}
    gps_pub.publish_json(gps_data)
    print(f"  [GPS] Published: {json.dumps(gps_data)}")
    
    time.sleep(0.05)
    
    # Camera metadata
    camera_data = {"frame_id": 1, "timestamp": time.time(), "resolution": "1920x1080"}
    camera_pub.publish_json(camera_data)
    print(f"  [Camera] Published: {json.dumps(camera_data)}")
    
    time.sleep(0.1)
    
    # Receive from wildcard subscriber
    print("\nReceiving from wildcard subscriber (amos/multi_topic_node/sensor/**):")
    for i in range(5):
        msg = all_sensors_sub.poll()
        if msg is not None:
            data = msg.payload_json()
            print(f"  Topic: {msg.topic}, Data: {json.dumps(data)}")
        else:
            time.sleep(0.01)
    
    # Receive from IMU-specific subscriber
    print("\nReceiving from IMU subscriber:")
    msg = imu_sub.poll()
    if msg is not None:
        data = msg.payload_json()
        print(f"  Topic: {msg.topic}, Data: {json.dumps(data)}")
    else:
        print("  No IMU message received")
    
    # Display metrics
    metrics = node.metrics()
    print(f"\nNode metrics:")
    print(f"  Published: {metrics.published}")
    print(f"  Delivered: {metrics.delivered}")
    print(f"  Delivery ratio: {metrics.delivery_ratio():.2%}")
    
    print("\n=== Example complete ===")

if __name__ == "__main__":
    main()
