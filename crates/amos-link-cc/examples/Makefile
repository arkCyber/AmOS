# Makefile for amos-link-cc examples
#
# Usage:
#   make                    # Build all examples
#   make simple_publisher   # Build specific example
#   make clean              # Clean build artifacts
#   make run-publisher      # Build and run publisher
#   make run-subscriber     # Build and run subscriber

# Detect OS
UNAME := $(shell uname -s)

# Library paths - use absolute path for linking
LIB_DIR = /Users/arksong/AmOS/target/release
INCLUDE_DIR = ..

# Compiler settings
CC = gcc
CFLAGS = -Wall -Wextra -O2 -I$(INCLUDE_DIR)
LDFLAGS = -L$(LIB_DIR) -lamos_link_cc

# Set library path environment variable based on OS
ifeq ($(UNAME),Darwin)
    LIB_PATH_VAR = DYLD_LIBRARY_PATH
else
    LIB_PATH_VAR = LD_LIBRARY_PATH
endif

# Targets
EXAMPLES = simple_publisher simple_subscriber federation request_response single_process_pubsub

.PHONY: all clean help run-single run-publisher run-subscriber run-federation run-server run-client

all: $(EXAMPLES)

simple_publisher: simple_publisher.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

simple_subscriber: simple_subscriber.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

federation: federation.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

request_response: request_response.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

single_process_pubsub: single_process_pubsub.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

# Run targets
run-single: single_process_pubsub
	@echo "Starting single-process pub/sub demo..."
	$(LIB_PATH_VAR)=$(LIB_DIR) ./single_process_pubsub

run-publisher: simple_publisher
	@echo "Starting publisher..."
	$(LIB_PATH_VAR)=$(LIB_DIR) ./simple_publisher

run-subscriber: simple_subscriber
	@echo "Starting subscriber..."
	$(LIB_PATH_VAR)=$(LIB_DIR) ./simple_subscriber

run-federation: federation
	@echo "Starting federation monitor..."
	$(LIB_PATH_VAR)=$(LIB_DIR) ./federation

run-server: request_response
	@echo "Starting RPC server..."
	$(LIB_PATH_VAR)=$(LIB_DIR) ./request_response server

run-client: request_response
	@echo "Starting RPC client..."
	$(LIB_PATH_VAR)=$(LIB_DIR) ./request_response client

clean:
	rm -f $(EXAMPLES)
	rm -rf *.dSYM

help:
	@echo "amos-link-cc Examples"
	@echo ""
	@echo "Available targets:"
	@echo "  all              - Build all examples"
	@echo "  clean            - Remove built executables"
	@echo ""
	@echo "Examples:"
	@echo "  single_process_pubsub - Complete pub/sub in one process (RECOMMENDED)"
	@echo "  simple_publisher      - Basic message publishing"
	@echo "  simple_subscriber     - Topic subscription with wildcards"
	@echo "  federation            - Peer discovery and monitoring"
	@echo "  request_response      - Request-response RPC pattern"
	@echo ""
	@echo "Run targets:"
	@echo "  make run-single       - Run the single-process pub/sub demo (START HERE)"
	@echo "  make run-publisher    - Run the publisher"
	@echo "  make run-subscriber   - Run the subscriber"
	@echo "  make run-federation   - Run the federation monitor"
	@echo "  make run-server       - Run the RPC server"
	@echo "  make run-client       - Run the RPC client"
	@echo ""
	@echo "Note: Build the Rust library first:"
	@echo "  cd ../.. && cargo build --release -p amos-link-cc"
