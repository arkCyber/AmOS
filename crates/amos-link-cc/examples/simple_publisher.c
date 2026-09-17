/* Simple Publisher Example
 * 
 * Demonstrates basic message publishing in amos-link.
 * Publishes sensor data at regular intervals.
 *
 * Build:
 *   gcc -o simple_publisher simple_publisher.c -L../../target/release -lamos_link_cc -I..
 *   export DYLD_LIBRARY_PATH=../../target/release  # macOS
 *   export LD_LIBRARY_PATH=../../target/release     # Linux
 *   ./simple_publisher
 */

#include "../amos_link.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>

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
    
    const char* peer_id = (argc > 1) ? argv[1] : "weather-sensor-01";
    const char* topic = (argc > 2) ? argv[2] : "amos/weather-sensor-01/sensor/environment";
    
    printf("amos-link Simple Publisher\n");
    printf("  Peer ID: %s\n", peer_id);
    printf("  Topic:   %s\n", topic);
    printf("\n");
    
    // Create node
    amos_link_node* node = amos_link_node_new(peer_id, NodeSensor);
    if (!node) {
        check_error();
        return 1;
    }
    
    // Get node info
    char node_peer_id[64];
    amos_link_node_peer_id(node, node_peer_id, sizeof(node_peer_id));
    printf("Node created: %s\n", node_peer_id);
    
    // Create publisher
    amos_link_publisher* pub = amos_link_publisher_new(node, topic);
    if (!pub) {
        check_error();
        amos_link_node_drop(node);
        return 1;
    }
    
    // Verify publisher topic
    char pub_topic[1024];
    amos_link_publisher_topic(pub, pub_topic, sizeof(pub_topic));
    printf("Publisher created on topic: %s\n\n", pub_topic);
    
    // Start federation for peer discovery (optional, enables cross-node communication)
    amos_link_federation_task* fed = amos_link_node_spawn_federation(node, 1000);
    if (fed) {
        printf("Federation started (advertising + discovery)\n\n");
    }
    
    // Publish loop
    printf("Publishing sensor data (Ctrl+C to stop)...\n\n");
    
    srand(time(NULL));
    for (uint32_t seq = 1; ; seq++) {
        // Generate sensor data
        SensorData data;
        data.temperature = 20.0f + (rand() % 100) / 10.0f;  // 20-30°C
        data.humidity = 40.0f + (rand() % 300) / 10.0f;     // 40-70%
        data.seq = seq;
        
        // Publish
        int result = amos_link_publisher_publish(
            pub,
            (const uint8_t*)&data,
            sizeof(data)
        );
        
        if (result == 0) {
            printf("[%u] Published: temp=%.1f°C, humidity=%.1f%%\n",
                   seq, data.temperature, data.humidity);
        } else {
            fprintf(stderr, "[%u] Publish failed\n", seq);
            check_error();
        }
        
        // Show metrics every 10 messages
        if (seq % 10 == 0) {
            amos_link_metrics metrics;
            if (amos_link_node_metrics(node, &metrics) == 0) {
                uint32_t ratio = amos_link_metrics_delivery_ratio(&metrics);
                printf("  Metrics: pub=%llu, del=%llu, drop=%llu, enc_err=%llu, dec_err=%llu (%u%% delivery)\n\n",
                       metrics.published, metrics.delivered, 
                       metrics.dropped, metrics.encode_errors, metrics.decode_errors,
                       ratio);
            }
        }
        
        sleep(1);  // 1 Hz
    }
    
    // Cleanup (unreachable in this example)
    if (fed) {
        amos_link_federation_stop(fed);
    }
    amos_link_publisher_drop(pub);
    amos_link_node_drop(node);
    
    return 0;
}
