/**
 * Single-process pub/sub example for amos-link C API
 * 
 * This demonstrates publisher and subscriber in the same process,
 * sharing the same LinkNode (and thus the same in-process broker).
 * 
 * For cross-process communication, you would need a shared transport
 * layer like Zenoh (not yet exposed in the C API v1).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "amos_link.h"

void check_error() {
    const char* error = amos_link_last_error();
    if (error && error[0] != '\0') {
        fprintf(stderr, "Error: %s\n", error);
        amos_link_error_clear();
        exit(1);
    }
}

int main() {
    // Disable buffering for immediate output
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    
    printf("amos-link Single-Process Pub/Sub Example\n");
    printf("==========================================\n\n");
    
    // Create a single node (shared in-process broker)
    const char* peer_id = "demo-node";
    amos_link_node* node = amos_link_node_new(peer_id, NodeSensor);
    if (!node) {
        check_error();
        return 1;
    }
    
    char node_peer_id[64];
    amos_link_node_peer_id(node, node_peer_id, sizeof(node_peer_id));
    printf("✓ Node created: %s\n", node_peer_id);
    
    // Create publisher
    const char* topic = "amos/demo-node/sensor/temperature";
    amos_link_publisher* pub = amos_link_publisher_new(node, topic);
    if (!pub) {
        check_error();
        return 1;
    }
    printf("✓ Publisher created on topic: %s\n", topic);
    
    // Create subscriber with wildcard pattern
    const char* pattern = "amos/demo-node/sensor/*";
    struct Qos qos = amos_link_qos_default();
    qos.depth = 10;
    amos_link_subscriber* sub = amos_link_subscriber_new(node, pattern, qos);
    if (!sub) {
        check_error();
        return 1;
    }
    printf("✓ Subscriber created with pattern: %s\n", pattern);
    printf("\n");
    
    // Give subscriptions a moment to propagate
    usleep(100000); // 100ms
    
    // Publish 5 messages
    printf("Publishing messages...\n");
    for (int i = 1; i <= 5; i++) {
        char payload[64];
        float temp = 20.0 + (float)(rand() % 100) / 10.0;
        snprintf(payload, sizeof(payload), "{\"seq\":%d,\"temp\":%.1f}", i, temp);
        
        int result = amos_link_publisher_publish(pub, 
            (const uint8_t*)payload, strlen(payload));
        if (result != 0) {
            check_error();
            return 1;
        }
        printf("  [%d] Published: %s\n", i, payload);
        
        // Small delay between publishes
        usleep(50000); // 50ms
    }
    printf("\n");
    
    // Poll for received messages
    printf("Polling for messages...\n");
    amos_link_received received;
    uint8_t buffer[256];
    int received_count = 0;
    
    for (int attempt = 0; attempt < 20; attempt++) {
        amos_link_poll poll_result = amos_link_subscriber_poll(
            sub, &received, buffer, sizeof(buffer));
        
        if (poll_result == Ready) {
            received_count++;
            // Null-terminate the payload for printing
            buffer[received.payload_len] = '\0';
            
            printf("  [%d] Received from %s: %s\n", 
                received_count, received.peer_id, buffer);
            printf("      Topic: %s, Seq: %llu\n",
                received.topic, (unsigned long long)received.seq);
        } else if (poll_result == Pending) {
            // No message yet, wait a bit
            usleep(50000); // 50ms
        } else {
            fprintf(stderr, "  Poll error\n");
            check_error();
            break;
        }
        
        // Stop after receiving all 5 messages
        if (received_count >= 5) {
            break;
        }
    }
    
    printf("\n");
    if (received_count == 5) {
        printf("✓ Success! Received all 5 messages\n");
    } else {
        printf("⚠ Received %d out of 5 messages\n", received_count);
    }
    
    // Get subscription stats
    amos_link_sub_stats stats;
    if (amos_link_subscriber_stats(sub, &stats) == 0) {
        printf("\nSubscriber stats:\n");
        printf("  Received: %llu\n", (unsigned long long)stats.received);
        printf("  Dropped:  %llu\n", (unsigned long long)stats.dropped);
        printf("  Errors:   %llu\n", (unsigned long long)stats.decode_errors);
    }
    
    // Get node metrics
    amos_link_metrics metrics;
    if (amos_link_node_metrics(node, &metrics) == 0) {
        uint64_t pub = metrics.published;
        uint64_t del = metrics.delivered;
        uint64_t drop = metrics.dropped;
        uint32_t ratio = amos_link_metrics_delivery_ratio(&metrics);
        
        printf("\nNode metrics:\n");
        printf("  Published: %llu\n", (unsigned long long)pub);
        printf("  Delivered: %llu\n", (unsigned long long)del);
        printf("  Dropped:   %llu\n", (unsigned long long)drop);
        printf("  Delivery:  %u%%\n", ratio);
    }
    
    // Cleanup
    printf("\nCleaning up...\n");
    amos_link_publisher_drop(pub);
    amos_link_subscriber_drop(sub);
    amos_link_node_drop(node);
    
    printf("✓ Done\n");
    return 0;
}
