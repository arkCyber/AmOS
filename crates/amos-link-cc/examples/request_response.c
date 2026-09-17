/* Request-Response Example
 * 
 * Demonstrates a request-response pattern using pub/sub.
 * A client sends requests and waits for responses from a server.
 *
 * Build:
 *   gcc -o request_response request_response.c -L../../target/release -lamos_link_cc -I..
 *   export DYLD_LIBRARY_PATH=../../target/release  # macOS
 *   export LD_LIBRARY_PATH=../../target/release     # Linux
 *   
 * Run server:
 *   ./request_response server
 * 
 * Run client (in another terminal):
 *   ./request_response client
 */

#include "../amos_link.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>

// Request/Response message format
typedef struct {
    uint32_t request_id;
    uint32_t value;
} Request;

typedef struct {
    uint32_t request_id;
    uint32_t result;
} Response;

void check_error() {
    const char* error = amos_link_last_error();
    if (error && error[0] != '\0') {
        fprintf(stderr, "Error: %s\n", error);
        amos_link_error_clear();
        exit(1);
    }
}

void run_server() {
    printf("=== Request-Response Server ===\n\n");
    
    // Create node
    amos_link_node* node = amos_link_node_new("rpc-server", NodeRobot);
    if (!node) {
        check_error();
        return;
    }
    
    printf("Server node created\n");
    
    // Subscribe to requests
    struct Qos qos = amos_link_qos_control();  // Reliable delivery
    amos_link_subscriber* req_sub = amos_link_subscriber_new(
        node,
        "amos/*/rpc/request",
        qos
    );
    if (!req_sub) {
        check_error();
        amos_link_node_drop(node);
        return;
    }
    
    // Publisher for responses
    amos_link_publisher* resp_pub = amos_link_publisher_new(
        node,
        "amos/rpc-server/rpc/response"
    );
    if (!resp_pub) {
        check_error();
        amos_link_subscriber_drop(req_sub);
        amos_link_node_drop(node);
        return;
    }
    
    printf("Server listening for requests...\n\n");
    
    // Process requests
    amos_link_received received;
    uint8_t buffer[4096];
    uint64_t requests_processed = 0;
    
    while (1) {
        amos_link_poll status = amos_link_subscriber_poll(
            req_sub,
            &received,
            buffer,
            sizeof(buffer)
        );
        
        if (status == Ready) {
            if (received.payload_len == sizeof(Request)) {
                Request* req = (Request*)buffer;
                
                printf("Received request #%u from %s: value=%u\n",
                       req->request_id,
                       received.peer_id,
                       req->value);
                
                // Process: compute factorial (simple example)
                uint32_t result = 1;
                for (uint32_t i = 2; i <= req->value && i <= 12; i++) {
                    result *= i;
                }
                
                // Send response
                Response resp;
                resp.request_id = req->request_id;
                resp.result = result;
                
                int pub_result = amos_link_publisher_publish(
                    resp_pub,
                    (const uint8_t*)&resp,
                    sizeof(resp)
                );
                
                if (pub_result == 0) {
                    printf("  -> Sent response: factorial(%u) = %u\n\n",
                           req->value, result);
                    requests_processed++;
                } else {
                    fprintf(stderr, "  -> Failed to send response\n\n");
                    check_error();
                }
                
                if (requests_processed % 10 == 0) {
                    printf("Processed %llu requests\n\n", requests_processed);
                }
            }
        } else if (status == Closed) {
            printf("Subscriber closed\n");
            break;
        } else {
            usleep(10000);  // 10ms
        }
    }
    
    // Cleanup
    amos_link_publisher_drop(resp_pub);
    amos_link_subscriber_drop(req_sub);
    amos_link_node_drop(node);
}

void run_client() {
    printf("=== Request-Response Client ===\n\n");
    
    // Create node
    amos_link_node* node = amos_link_node_new("rpc-client", NodeSensor);
    if (!node) {
        check_error();
        return;
    }
    
    printf("Client node created\n");
    
    // Publisher for requests
    amos_link_publisher* req_pub = amos_link_publisher_new(
        node,
        "amos/rpc-client/rpc/request"
    );
    if (!req_pub) {
        check_error();
        amos_link_node_drop(node);
        return;
    }
    
    // Subscribe to responses
    struct Qos qos = amos_link_qos_control();
    amos_link_subscriber* resp_sub = amos_link_subscriber_new(
        node,
        "amos/*/rpc/response",
        qos
    );
    if (!resp_sub) {
        check_error();
        amos_link_publisher_drop(req_pub);
        amos_link_node_drop(node);
        return;
    }
    
    printf("Client ready\n");
    printf("Sending requests...\n\n");
    
    srand(time(NULL));
    
    for (uint32_t request_id = 1; request_id <= 20; request_id++) {
        // Send request
        Request req;
        req.request_id = request_id;
        req.value = (rand() % 10) + 1;  // 1-10
        
        printf("[%u] Sending request: factorial(%u)\n",
               request_id, req.value);
        
        int pub_result = amos_link_publisher_publish(
            req_pub,
            (const uint8_t*)&req,
            sizeof(req)
        );
        
        if (pub_result != 0) {
            fprintf(stderr, "  Failed to send request\n\n");
            check_error();
            continue;
        }
        
        // Wait for response with timeout
        amos_link_received received;
        uint8_t buffer[4096];
        int timeout_count = 0;
        int max_timeout = 100;  // 1 second total
        
        while (timeout_count < max_timeout) {
            amos_link_poll status = amos_link_subscriber_poll(
                resp_sub,
                &received,
                buffer,
                sizeof(buffer)
            );
            
            if (status == Ready) {
                if (received.payload_len == sizeof(Response)) {
                    Response* resp = (Response*)buffer;
                    
                    if (resp->request_id == request_id) {
                        printf("  <- Received response: result=%u\n\n",
                               resp->result);
                        break;
                    } else {
                        printf("  (Ignoring response for request #%u)\n",
                               resp->request_id);
                    }
                }
            } else if (status == Closed) {
                printf("  Subscriber closed\n");
                goto cleanup;
            }
            
            usleep(10000);  // 10ms
            timeout_count++;
        }
        
        if (timeout_count >= max_timeout) {
            printf("  <- Timeout waiting for response\n\n");
        }
        
        sleep(1);  // Rate limit
    }
    
    printf("Client finished sending %u requests\n", 20);
    
cleanup:
    // Cleanup
    amos_link_subscriber_drop(resp_sub);
    amos_link_publisher_drop(req_pub);
    amos_link_node_drop(node);
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <server|client>\n", argv[0]);
        return 1;
    }
    
    if (strcmp(argv[1], "server") == 0) {
        run_server();
    } else if (strcmp(argv[1], "client") == 0) {
        run_client();
    } else {
        fprintf(stderr, "Unknown mode: %s (use 'server' or 'client')\n", argv[1]);
        return 1;
    }
    
    return 0;
}
