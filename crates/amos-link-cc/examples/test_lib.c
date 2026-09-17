#include "../amos_link.h"
#include <stdio.h>

int main() {
    printf("Starting test...\n");
    fflush(stdout);
    
    amos_link_node* node = amos_link_node_new("test", NodeSensor);
    printf("Node created: %p\n", (void*)node);
    fflush(stdout);
    
    if (node) {
        amos_link_node_drop(node);
        printf("Node dropped successfully\n");
    } else {
        printf("Failed to create node: %s\n", amos_link_last_error());
    }
    fflush(stdout);
    
    return 0;
}
