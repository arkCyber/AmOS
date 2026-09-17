/* Simple Subscriber Example
 * 
 * Demonstrates subscribing to topics with wildcard patterns.
 * Receives and displays all matching messages.
 *
 * Build:
 *   gcc -o simple_subscriber simple_subscriber.c -L../../target/release -lamos_link_cc -I..
 *   export DYLD_LIBRARY_PATH=../../target/release  # macOS
 *   export LD_LIBRARY_PATH=../../target/release     # Linux
 *   ./simple_subscriber
 */

#include "../amos_link.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
    float temperature;
    float humidity;
    uint32_t seq;
} SensorData;

void check_error() {
    const char* error = amos_link_last_error();
    if (error && error[0] != '\0') {
        fprintf(stderr, "Error: %s\n", error);
        amos_link_error_clear();
        exit(1);
    }
}

int main(int argc, char** argv) {
    // Disable buffering for immediate output
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    
    const char* peer_id = (argc > 1) ? argv[1] : "weather-monitor";
    const char* pattern = (argc > 2) ? argv[2] : "amos/**/sensor/environment";
    
    printf("amos-link Simple Subscriber\n");
    printf("  Peer ID: %s\n", peer_id);
    printf("  Pattern: %s\n", pattern);
    printf("\n");
    fflush(stdout);
    
    // Create node
    amos_link_node* node = amos_link_node_new(peer_id, NodeRobot);
    if (!node) {
        check_error();
        return 1;
    }
    
    char node_peer_id[64];
    amos_link_node_peer_id(node, node_peer_id, sizeof(node_peer_id));
    printf("Node created: %s\n", node_peer_id);
    fflush(stdout);
    
    // Create subscriber with sensor QoS (best-effort, keep-last-1)
    struct Qos qos = amos_link_qos_sensor();
    amos_link_subscriber* sub = amos_link_subscriber_new(node, pattern, qos);
    if (!sub) {
        check_error();
        amos_link_node_drop(node);
        return 1;
    }
    
    printf("Subscriber created\n");
    fflush(stdout);
    
    // Start federation for peer discovery (required for cross-node communication)
    amos_link_federation_task* fed = amos_link_node_spawn_federation(node, 1000);
    if (fed) {
        printf("Federation started (discovery)\n");
        fflush(stdout);
    }
    
    printf("Waiting for messages (Ctrl+C to stop)...\n\n");
    fflush(stdout);
    
    // Receive loop
    amos_link_received received;
    uint8_t buffer[4096];
    uint64_t total_received = 0;
    
    while (1) {
        amos_link_poll status = amos_link_subscriber_poll(
            sub, 
            &received, 
            buffer, 
            sizeof(buffer)
        );
        
        if (status == Ready) {
            total_received++;
            
            printf("[%llu] From %s on %s\n",
                   total_received,
                   received.peer_id,
                   received.topic);
            printf("      seq=%llu, frame_len=%u, payload_len=%u\n",
                   received.seq,
                   received.frame_len,
                   received.payload_len);
            
            // Try to decode as SensorData
            if (received.payload_len == sizeof(SensorData)) {
                SensorData* data = (SensorData*)buffer;
                printf("      SensorData: temp=%.1f°C, humidity=%.1f%%, seq=%u\n",
                       data->temperature, data->humidity, data->seq);
            } else {
                // Print raw bytes
                printf("      Raw payload (%u bytes): ", received.payload_len);
                for (size_t i = 0; i < received.payload_len && i < 16; i++) {
                    printf("%02x ", buffer[i]);
                }
                if (received.payload_len > 16) {
                    printf("...");
                }
                printf("\n");
            }
            
            // Show subscriber stats every 10 messages
            if (total_received % 10 == 0) {
                amos_link_sub_stats stats;
                if (amos_link_subscriber_stats(sub, &stats) == 0) {
                    printf("\n  Subscriber stats: received=%llu, decode_errors=%llu\n\n",
                           stats.received, stats.decode_errors);
                }
            }
            
            printf("\n");
            
        } else if (status == Closed) {
            printf("Subscriber closed\n");
            break;
        } else {
            // Pending - no message yet
            usleep(10000);  // 10ms
        }
    }
    
    // Cleanup
    if (fed) {
        amos_link_federation_stop(fed);
    }
    amos_link_subscriber_drop(sub);
    amos_link_node_drop(node);
    
    printf("Received %llu total messages\n", total_received);
    return 0;
}
