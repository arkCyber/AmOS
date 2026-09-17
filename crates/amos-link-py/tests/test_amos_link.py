#!/usr/bin/env python3
"""
Unit tests for amos-link Python SDK.

This test suite follows aerospace-grade standards for comprehensive testing,
covering all major API surfaces, error conditions, and edge cases.
"""

import sys
import time
import json
import unittest

# Add the python package to the path
sys.path.insert(0, '../python')

from amos_link import (
    LinkNode, NodeKind, QoS, Reliability, DropPolicy,
    Timestamp, Publisher, Subscriber
)


class TestNodeKind(unittest.TestCase):
    """Test NodeKind enumeration."""
    
    def test_node_kind_values(self):
        """Verify all NodeKind variants are accessible."""
        self.assertIsNotNone(NodeKind.ROBOT)
        self.assertIsNotNone(NodeKind.SENSOR)
        self.assertIsNotNone(NodeKind.BRAIN)
        self.assertIsNotNone(NodeKind.ACTUATOR)
        self.assertIsNotNone(NodeKind.TOOL)
    
    def test_node_kind_repr(self):
        """Verify NodeKind has string representation."""
        robot = NodeKind.ROBOT
        self.assertIn("Robot", str(robot))


class TestReliability(unittest.TestCase):
    """Test Reliability enumeration."""
    
    def test_reliability_values(self):
        """Verify all Reliability variants are accessible."""
        self.assertIsNotNone(Reliability.BEST_EFFORT)
        self.assertIsNotNone(Reliability.RELIABLE)


class TestDropPolicy(unittest.TestCase):
    """Test DropPolicy enumeration."""
    
    def test_drop_policy_values(self):
        """Verify all DropPolicy variants are accessible."""
        self.assertIsNotNone(DropPolicy.DROP_OLDEST)
        self.assertIsNotNone(DropPolicy.DROP_NEWEST)


class TestQoS(unittest.TestCase):
    """Test QoS configuration."""
    
    def test_qos_default(self):
        """Verify default QoS can be created."""
        qos = QoS.default()
        self.assertIsNotNone(qos)
    
    def test_qos_sensor(self):
        """Verify sensor QoS profile."""
        qos = QoS.sensor()
        self.assertIsNotNone(qos)
    
    def test_qos_control(self):
        """Verify control QoS profile."""
        qos = QoS.control()
        self.assertIsNotNone(qos)
    
    def test_qos_state(self):
        """Verify state QoS profile."""
        qos = QoS.state()
        self.assertIsNotNone(qos)
    
    def test_qos_repr(self):
        """Verify QoS has string representation."""
        qos = QoS.default()
        self.assertIn("QoS", str(qos))


class TestTimestamp(unittest.TestCase):
    """Test Timestamp functionality."""
    
    def test_timestamp_now(self):
        """Verify Timestamp.now() works."""
        ts = Timestamp.now()
        self.assertIsNotNone(ts)
        self.assertGreater(ts.secs, 0)
        self.assertGreaterEqual(ts.nanos, 0)
        self.assertLess(ts.nanos, 1_000_000_000)
    
    def test_timestamp_create(self):
        """Verify Timestamp can be created with specific values."""
        ts = Timestamp(1234567890, 123456789)
        self.assertEqual(ts.secs, 1234567890)
        self.assertEqual(ts.nanos, 123456789)
    
    def test_timestamp_repr(self):
        """Verify Timestamp has string representation."""
        ts = Timestamp.now()
        self.assertIn("Timestamp", str(ts))


class TestLinkNode(unittest.TestCase):
    """Test LinkNode creation and basic operations."""
    
    def test_node_creation(self):
        """Verify LinkNode can be created."""
        node = LinkNode("test_node", NodeKind.ROBOT)
        self.assertIsNotNone(node)
        self.assertEqual(node.peer_id, "test_node")
        self.assertIsNotNone(node.kind)
    
    def test_node_metrics(self):
        """Verify node metrics are accessible."""
        node = LinkNode("metrics_node", NodeKind.SENSOR)
        metrics = node.metrics()
        self.assertIsNotNone(metrics)
        self.assertGreaterEqual(metrics.published, 0)
        self.assertGreaterEqual(metrics.delivered, 0)
        self.assertGreaterEqual(metrics.dropped, 0)
        self.assertGreaterEqual(metrics.errors, 0)
    
    def test_node_repr(self):
        """Verify LinkNode has string representation."""
        node = LinkNode("repr_node", NodeKind.BRAIN)
        self.assertIn("LinkNode", str(node))
        self.assertIn("repr_node", str(node))


class TestPublisher(unittest.TestCase):
    """Test Publisher functionality."""
    
    def setUp(self):
        """Create a node and publisher for each test."""
        self.node = LinkNode("pub_test_node", NodeKind.ROBOT)
        self.pub = self.node.publisher("test/topic")
    
    def test_publisher_creation(self):
        """Verify Publisher can be created."""
        self.assertIsNotNone(self.pub)
        self.assertEqual(self.pub.topic, "test/topic")
    
    def test_publish_bytes(self):
        """Verify publishing raw bytes."""
        data = b"Hello, amos-link!"
        self.pub.publish(data)
        # If no exception, publish succeeded
    
    def test_publish_json(self):
        """Verify publishing JSON data."""
        data = {"message": "test", "value": 42}
        self.pub.publish_json(data)
        # If no exception, publish succeeded
    
    def test_publisher_repr(self):
        """Verify Publisher has string representation."""
        self.assertIn("Publisher", str(self.pub))
        self.assertIn("test/topic", str(self.pub))


class TestSubscriber(unittest.TestCase):
    """Test Subscriber functionality."""
    
    def setUp(self):
        """Create a node and subscriber for each test."""
        self.node = LinkNode("sub_test_node", NodeKind.SENSOR)
        self.sub = self.node.subscriber("test/sub", QoS.default())
    
    def test_subscriber_creation(self):
        """Verify Subscriber can be created."""
        self.assertIsNotNone(self.sub)
        self.assertEqual(self.sub.pattern, "test/sub")
    
    def test_subscriber_stats(self):
        """Verify subscriber statistics are accessible."""
        stats = self.sub.stats()
        self.assertIsNotNone(stats)
        self.assertIn('received', stats)
        self.assertIn('dropped', stats)
        self.assertIn('decode_errors', stats)
    
    def test_subscriber_poll_empty(self):
        """Verify poll returns None when no messages."""
        msg = self.sub.poll()
        self.assertIsNone(msg)
    
    def test_subscriber_repr(self):
        """Verify Subscriber has string representation."""
        self.assertIn("Subscriber", str(self.sub))
        self.assertIn("test/sub", str(self.sub))


class TestPubSub(unittest.TestCase):
    """Test end-to-end publish-subscribe functionality."""
    
    def setUp(self):
        """Create a node with publisher and subscriber."""
        self.node = LinkNode("pubsub_node", NodeKind.ROBOT)
        self.pub = self.node.publisher("test/data")
        self.sub = self.node.subscriber("test/data", QoS.default())
    
    def test_pubsub_bytes(self):
        """Test publishing and receiving raw bytes."""
        test_data = b"Test message"
        self.pub.publish(test_data)
        time.sleep(0.05)
        
        msg = self.sub.poll()
        self.assertIsNotNone(msg, "Should receive published message")
        self.assertEqual(msg.topic, "test/data")
        self.assertEqual(msg.publisher, "pubsub_node")
        self.assertEqual(bytes(msg.payload()), test_data)
    
    def test_pubsub_json(self):
        """Test publishing and receiving JSON data."""
        test_data = {"sensor": "imu", "value": [1.0, 2.0, 3.0]}
        self.pub.publish_json(test_data)
        time.sleep(0.05)
        
        msg = self.sub.poll()
        self.assertIsNotNone(msg, "Should receive published message")
        received_data = msg.payload_json()
        self.assertEqual(received_data, test_data)
    
    def test_pubsub_sequence(self):
        """Test message sequencing."""
        # Publish multiple messages
        for i in range(3):
            self.pub.publish_json({"seq": i})
            time.sleep(0.02)
        
        # Receive and verify sequence numbers are increasing
        prev_seq = -1
        for _ in range(3):
            msg = self.sub.poll()
            if msg is not None:
                self.assertGreater(msg.seq, prev_seq)
                prev_seq = msg.seq
    
    def test_metrics_after_pubsub(self):
        """Verify metrics are updated after pub/sub."""
        initial_metrics = self.node.metrics()
        initial_published = initial_metrics.published
        
        self.pub.publish(b"metrics test")
        time.sleep(0.05)
        self.sub.poll()
        
        final_metrics = self.node.metrics()
        self.assertGreater(final_metrics.published, initial_published)


class TestWildcardSubscription(unittest.TestCase):
    """Test wildcard topic matching."""
    
    def setUp(self):
        """Create a node with wildcard subscriber."""
        self.node = LinkNode("wildcard_node", NodeKind.BRAIN)
        # Use QoS with depth > 1 to receive multiple messages
        qos = QoS(Reliability.BEST_EFFORT, 10, DropPolicy.DROP_NEWEST)
        self.sub = self.node.subscriber("amos/wildcard_node/sensor/*", qos)
    
    def test_wildcard_match(self):
        """Test that wildcard subscriber receives matching topics."""
        # Give subscriber time to be ready
        time.sleep(0.1)
        
        pub1 = self.node.publisher("amos/wildcard_node/sensor/imu")
        pub2 = self.node.publisher("amos/wildcard_node/sensor/gps")
        
        pub1.publish_json({"type": "imu"})
        pub2.publish_json({"type": "gps"})
        time.sleep(0.1)
        
        received_topics = []
        for _ in range(10):  # Increase attempts
            msg = self.sub.poll()
            if msg is not None:
                received_topics.append(msg.topic)
            else:
                time.sleep(0.01)
        
        # Should receive from both publishers
        self.assertIn("amos/wildcard_node/sensor/imu", received_topics)
        self.assertIn("amos/wildcard_node/sensor/gps", received_topics)


def run_tests():
    """Run all tests and return results."""
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return result.wasSuccessful()


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
