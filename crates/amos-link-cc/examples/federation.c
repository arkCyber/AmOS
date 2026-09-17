/* Federation Example
 * 
 * Demonstrates peer discovery and network monitoring.
 * Discovers other nodes in the network and monitors their health.
 *
 * Build:
 *   gcc -o federation federation.c -L../../target/release -lamos_link_cc -I..
 *   export DYLD_LIBRARY_PATH=../../target/release  # macOS
 *   export LD_LIBRARY_PATH=../../target/release     # Linux
 *   ./federation
 */

#include "../amos_link.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

void check_error() {
    const char* error = amos_link_last_error();
    if (error && error[0] != '\0') {
        fprintf(stderr, "Error: %s\n", error);
        amos_link_error_clear();
        exit(1);
    }
}

const char* node_kind_str(amos_link_node_kind kind) {
    switch (kind) {
        case NodeRobot: return "Robot";
        case NodeSensor: return "Sensor";
        case NodeBrain: return "Brain";
        case NodeActuator: return "Actuator";
        case NodeTool: return "Tool";
        default: return "Unknown";
    }
}

const char* health_str(amos_link_health_state health) {
    switch (health) {
        case Healthy: return "Healthy";
        case Degraded: return "Degraded";
        case Unknown: return "Unknown";
        default: return "Unknown";
    }
}

int main(int argc, char** argv) {
    const char* peer_id = (argc > 1) ? argv[1] : "monitor-station";
    int interval_ms = (argc > 2) ? atoi(argv[2]) : 100;
    
    printf("amos-link Federation Example\n");
    printf("  Peer ID: %s\n", peer_id);
    printf("  Beacon interval: %d ms\n", interval_ms);
    printf("\n");
    
    // Create node
    amos_link_node* node = amos_link_node_new(peer_id, NodeRobot);
    if (!node) {
        check_error();
        return 1;
    }
    
    char node_peer_id[64];
    amos_link_node_peer_id(node, node_peer_id, sizeof(node_peer_id));
    printf("Node created: %s\n", node_peer_id);
    
    // Get heartbeat topic
    char hb_topic[1024];
    amos_link_node_heartbeat_topic(node, hb_topic);
    printf("Heartbeat topic: %s\n", hb_topic);
    
    // Start federation (advertising + discovery)
    struct amos_link_federation_task* fed = amos_link_node_spawn_federation(node, interval_ms);
    if (!fed) {
        check_error();
        amos_link_node_drop(node);
        return 1;
    }
    
    printf("Federation started\n");
    printf("\nMonitoring network (Ctrl+C to stop)...\n\n");
    
    // Monitor loop
    amos_link_peer_view peers[32];
    amos_link_topic_entry topics[64];
    
    for (int iteration = 1; ; iteration++) {
        sleep(2);
        
        printf("=== Iteration %d ===\n", iteration);
        
        // Query discovered peers
        size_t peer_count = amos_link_node_peers(node, peers, 32);
        printf("\nDiscovered %zu peer(s):\n", peer_count);
        
        for (size_t i = 0; i < peer_count; i++) {
            printf("  [%zu] %s (%s)\n",
                   i + 1,
                   peers[i].id,
                   node_kind_str(peers[i].kind));
            printf("      Last seen: %llu ms ago\n", peers[i].last_seen_ms);
            printf("      Beacons:   %llu\n", peers[i].beacons);
            if (peers[i].endpoint[0] != '\0') {
                printf("      Endpoint:  %s\n", peers[i].endpoint);
            }
        }
        
        if (peer_count == 0) {
            printf("  (no peers discovered yet)\n");
        }
        
        // Query active topics
        size_t topic_count = amos_link_node_topics(node, topics, 64);
        printf("\nActive topic(s): %zu\n", topic_count);
        
        if (topic_count > 0 && topic_count <= 10) {
            for (size_t i = 0; i < topic_count; i++) {
                printf("  - %s\n", topics[i].topic);
            }
        } else if (topic_count > 10) {
            for (size_t i = 0; i < 5; i++) {
                printf("  - %s\n", topics[i].topic);
            }
            printf("  ... (%zu more topics)\n", topic_count - 5);
        }
        
        // Evaluate system health
        struct amos_link_metrics node_metrics;
        amos_link_node_metrics(node, &node_metrics);
        struct amos_link_health health = amos_link_evaluate_health(
            &node_metrics,
            peers,
            peer_count,
            true    // clock_synced (assume true for demo)
        );
        
        printf("\nSystem Health: %s\n", health_str(health.state));
        
        // Show node metrics
        amos_link_metrics metrics;
        if (amos_link_node_metrics(node, &metrics) == 0) {
            uint32_t ratio = amos_link_metrics_delivery_ratio(&metrics);
            printf("\nNode Metrics:\n");
            printf("  Published:  %llu\n", metrics.published);
            printf("  Delivered:  %llu\n", metrics.delivered);
            printf("  Dropped:    %llu\n", metrics.dropped);
            printf("  Delivery:   %u%%\n", ratio);
        }
        
        // Show node uptime
        uint64_t uptime_ms = amos_link_node_uptime_ms(node);
        printf("  Uptime:     %.1f seconds\n", uptime_ms / 1000.0);
        
        printf("\n");
    }
    
    // Cleanup (unreachable in this example)
    amos_link_federation_stop(fed);
    amos_link_node_drop(node);
    
    return 0;
}
