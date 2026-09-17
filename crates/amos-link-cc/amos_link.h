/* amos-link C/C++ SDK — AmOS-Link robot middleware
 * Pure C ABI: loadable from any C/C++ toolchain.
 *
 * Build:  cargo build -p amos-link-cc
 * Header: cbindgen --config cbindgen.toml --crate amos-link-cc --output amos_link.h
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* Opaque types */
typedef struct Topic Topic;


#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#define AMLK_VERSION 1

#define AMLK_MAX_FRAME_BYTES (((((4 + 1) + 4) + 4) + ((16 * 1024) * 1024)) + 4096)

#define AMLK_MAX_PAYLOAD_BYTES ((16 * 1024) * 1024)

#define AMLK_MAX_PEER_ID_LEN 63

#define AMLK_MAX_TOPIC_LEN 1024

#define AMLK_MAX_ENDPOINT_LEN 128

#define AMLK_QOS_MAX_DEPTH 4096

enum amos_link_channel
#if __STDC_VERSION__ >= 202311L
  : uint8_t
#endif // __STDC_VERSION__ >= 202311L
 {
  ChannelSensor = 0,
  ChannelControl = 1,
  ChannelState = 2,
  ChannelTelemetry = 3,
  ChannelBrain = 4,
};
#if __STDC_VERSION__ >= 202311L
typedef enum amos_link_channel amos_link_channel;
#else
typedef uint8_t amos_link_channel;
#endif // __STDC_VERSION__ >= 202311L

/**
 * FFI mirror of [`amos_link::qos::Reliability`].
 */
enum amos_link_reliability
#if __STDC_VERSION__ >= 202311L
  : uint8_t
#endif // __STDC_VERSION__ >= 202311L
 {
  ReliabilityBestEffort = 0,
  ReliabilityReliable = 1,
};
#if __STDC_VERSION__ >= 202311L
typedef enum amos_link_reliability amos_link_reliability;
#else
typedef uint8_t amos_link_reliability;
#endif // __STDC_VERSION__ >= 202311L

/**
 * FFI mirror of [`amos_link::qos::DropPolicy`].
 */
enum amos_link_drop_policy
#if __STDC_VERSION__ >= 202311L
  : uint8_t
#endif // __STDC_VERSION__ >= 202311L
 {
  DropPolicyDropNewest = 0,
  DropPolicyDropOldest = 1,
};
#if __STDC_VERSION__ >= 202311L
typedef enum amos_link_drop_policy amos_link_drop_policy;
#else
typedef uint8_t amos_link_drop_policy;
#endif // __STDC_VERSION__ >= 202311L

enum amos_link_node_kind
#if __STDC_VERSION__ >= 202311L
  : uint8_t
#endif // __STDC_VERSION__ >= 202311L
 {
  NodeRobot = 0,
  NodeBrain = 1,
  NodeSensor = 2,
  NodeActuator = 3,
  NodeTool = 4,
};
#if __STDC_VERSION__ >= 202311L
typedef enum amos_link_node_kind amos_link_node_kind;
#else
typedef uint8_t amos_link_node_kind;
#endif // __STDC_VERSION__ >= 202311L

enum amos_link_poll
#if __STDC_VERSION__ >= 202311L
  : int32_t
#endif // __STDC_VERSION__ >= 202311L
 {
  Pending = 0,
  Ready = 1,
  Closed = 2,
};
#if __STDC_VERSION__ >= 202311L
typedef enum amos_link_poll amos_link_poll;
#else
typedef int32_t amos_link_poll;
#endif // __STDC_VERSION__ >= 202311L

enum amos_link_health_state
#if __STDC_VERSION__ >= 202311L
  : uint8_t
#endif // __STDC_VERSION__ >= 202311L
 {
  Unknown = 0,
  Healthy = 1,
  Degraded = 2,
};
#if __STDC_VERSION__ >= 202311L
typedef enum amos_link_health_state amos_link_health_state;
#else
typedef uint8_t amos_link_health_state;
#endif // __STDC_VERSION__ >= 202311L

/**
 * FFI mirror of [`amos_link::qos::Qos`].
 * Note: `depth` is `usize` in Rust (platform-dependent); we use `u32` for C ABI
 * stability and clamp to [`MAX_DEPTH`] in the constructor.
 */
typedef struct Qos {
  amos_link_reliability reliability;
  uint32_t depth;
  amos_link_drop_policy drop_policy;
} Qos;
#define Qos_MAX_DEPTH 4096

/**
 * FFI mirror of [`amos_link::codec::Timestamp`].
 */
typedef struct Timestamp {
  uint64_t secs;
  uint32_t nanos;
} Timestamp;

typedef struct amos_link_frame_header {
  char topic[1024];
  uint32_t topic_len;
  char peer_id[64];
  uint64_t seq;
  uint64_t stamp_secs;
  uint32_t stamp_nanos;
  uint32_t payload_len;
} amos_link_frame_header;

typedef struct amos_link_node {
  uint8_t _0;
} amos_link_node;

typedef struct amos_link_publisher {
  uint8_t _0;
} amos_link_publisher;

typedef struct amos_link_subscriber {
  uint8_t _0;
} amos_link_subscriber;

typedef struct amos_link_received {
  char topic[1024];
  char peer_id[64];
  uint64_t seq;
  uint64_t stamp_secs;
  uint32_t stamp_nanos;
  uint32_t frame_len;
  uint32_t payload_len;
} amos_link_received;

typedef struct amos_link_sub_stats {
  uint64_t received;
  uint64_t dropped;
  uint64_t decode_errors;
} amos_link_sub_stats;

typedef struct amos_link_metrics {
  uint64_t published;
  uint64_t delivered;
  uint64_t dropped;
  uint64_t blocked;
  uint64_t decode_errors;
  uint64_t encode_errors;
} amos_link_metrics;

typedef struct amos_link_health {
  amos_link_health_state state;
  char reason[256];
} amos_link_health;

typedef struct amos_link_peer_view {
  char id[64];
  amos_link_node_kind kind;
  char endpoint[128];
  uint64_t last_seen_ms;
  uint64_t beacons;
} amos_link_peer_view;

typedef struct amos_link_topic_entry {
  char topic[1024];
} amos_link_topic_entry;

typedef struct amos_link_heartbeat {
  uint8_t _0;
} amos_link_heartbeat;

typedef struct amos_link_heartbeat_fields {
  char peer_id[64];
  uint64_t seq;
  uint64_t stamp_secs;
  uint32_t stamp_nanos;
  uint64_t uptime_ms;
} amos_link_heartbeat_fields;

typedef struct amos_link_federation_task {
  uint8_t _0;
} amos_link_federation_task;

#define AMLK_MAGIC { 65, 77, 76, 75, }

int32_t amos_link_peer_id_validate(const char *id);

int32_t amos_link_peer_id_new(const char *id, char *out);

int32_t amos_link_topic_validate(const char *expr);

int32_t amos_link_topic_validate_pattern(const char *expr);

int32_t amos_link_topic_channel(const char *peer,
                                amos_link_channel channel,
                                const char *name,
                                char *out);

int32_t amos_link_topic_peer_pattern(const char *peer, char *out);

bool amos_link_topic_matches(const Topic *topic, const Topic *pattern);

struct Qos amos_link_qos_new(amos_link_reliability reliability,
                             uint32_t depth,
                             amos_link_drop_policy drop_policy);

struct Qos amos_link_qos_sensor(void);

struct Qos amos_link_qos_state(void);

struct Qos amos_link_qos_control(void);

struct Qos amos_link_qos_default(void);

struct Qos amos_link_qos_for_channel(amos_link_channel channel);

int32_t amos_link_qos_validate(struct Qos qos);

struct Timestamp amos_link_timestamp_now(void);

struct Timestamp amos_link_timestamp_new(uint64_t secs, uint32_t nanos);

uint64_t amos_link_timestamp_as_nanos(struct Timestamp stamp);

uint64_t amos_link_timestamp_unix_ms(struct Timestamp stamp);

double amos_link_timestamp_since_secs(struct Timestamp earlier, struct Timestamp later);

bool amos_link_timestamp_is_valid(struct Timestamp stamp);

/**
 * Encode a bincode payload into a full wire frame synchronously.
 */
uintptr_t amos_link_frame_encode(const char *topic_str,
                                 const char *peer_id_str,
                                 uint64_t seq,
                                 struct Timestamp stamp,
                                 const uint8_t *payload,
                                 uintptr_t payload_len,
                                 uint8_t *frame_out,
                                 uintptr_t frame_out_cap);

/**
 * Decode only the frame header (payload slice is borrowed, not copied).
 */
int32_t amos_link_frame_decode_header(const uint8_t *frame,
                                      uintptr_t frame_len,
                                      struct amos_link_frame_header *h);

/**
 * Decode a wire frame and return its payload bytes.
 */
int32_t amos_link_frame_decode_payload(const uint8_t *frame,
                                       uintptr_t frame_len,
                                       uint8_t *payload_out,
                                       uintptr_t payload_cap);

/**
 * CRC32 of a single buffer.
 */
uint32_t amos_link_crc32(const uint8_t *data, uintptr_t len);

/**
 * CRC32 of header || payload combined.
 */
uint32_t amos_link_crc32_combine(const uint8_t *header,
                                 uintptr_t h_len,
                                 const uint8_t *payload,
                                 uintptr_t p_len);

struct amos_link_node *amos_link_node_new(const char *peer_id, amos_link_node_kind kind);

struct amos_link_node *amos_link_node_clone(const struct amos_link_node *node);

void amos_link_node_drop(struct amos_link_node *node);

int32_t amos_link_node_peer_id(const struct amos_link_node *node, char *buf, uintptr_t cap);

amos_link_node_kind amos_link_node_get_kind(const struct amos_link_node *node);

uint64_t amos_link_node_uptime_ms(const struct amos_link_node *node);

const char *amos_link_version(void);

int32_t amos_link_node_heartbeat_topic(const struct amos_link_node *node, char *buf);

struct amos_link_publisher *amos_link_publisher_new(const struct amos_link_node *node,
                                                    const char *topic_str);

void amos_link_publisher_drop(struct amos_link_publisher *pubr);

int32_t amos_link_publisher_publish(const struct amos_link_publisher *pubr,
                                    const uint8_t *payload,
                                    uintptr_t payload_len);

int32_t amos_link_publisher_topic(const struct amos_link_publisher *pubr, char *buf, uintptr_t cap);

struct amos_link_subscriber *amos_link_subscriber_new(const struct amos_link_node *node,
                                                      const char *pattern_str,
                                                      struct Qos qos);

void amos_link_subscriber_drop(struct amos_link_subscriber *sub);

amos_link_poll amos_link_subscriber_poll(const struct amos_link_subscriber *sub,
                                         struct amos_link_received *received,
                                         uint8_t *payload_buf,
                                         uintptr_t payload_cap);

amos_link_poll amos_link_subscriber_recv(const struct amos_link_subscriber *sub,
                                         struct amos_link_received *received,
                                         uint8_t *payload_buf,
                                         uintptr_t payload_cap);

int32_t amos_link_subscriber_stats(const struct amos_link_subscriber *sub,
                                   struct amos_link_sub_stats *stats);

bool amos_link_subscriber_has_pending(const struct amos_link_subscriber *sub);

int32_t amos_link_node_metrics(const struct amos_link_node *node,
                               struct amos_link_metrics *metrics);

uint32_t amos_link_metrics_delivery_ratio(const struct amos_link_metrics *m);

struct amos_link_health amos_link_evaluate_health(const struct amos_link_metrics *metrics,
                                                  const struct amos_link_peer_view *peers,
                                                  uintptr_t num_peers,
                                                  bool clock_synced);

uintptr_t amos_link_node_peers(const struct amos_link_node *node,
                               struct amos_link_peer_view *peers_out,
                               uintptr_t max_peers);

uintptr_t amos_link_node_topics(const struct amos_link_node *node,
                                struct amos_link_topic_entry *topics_out,
                                uintptr_t max_topics);

struct amos_link_heartbeat *amos_link_node_heartbeat(const struct amos_link_node *node);

int32_t amos_link_heartbeat_encode(const struct amos_link_heartbeat *beat, uint8_t *frame_out);

void amos_link_heartbeat_drop(struct amos_link_heartbeat *beat);

int32_t amos_link_heartbeat_decode(const uint8_t *frame,
                                   uintptr_t frame_len,
                                   struct amos_link_heartbeat_fields *fields);

struct amos_link_federation_task *amos_link_node_spawn_federation(const struct amos_link_node *node,
                                                                  uint64_t period_ms);

struct amos_link_federation_task *amos_link_node_spawn_federation_advertising(const struct amos_link_node *node,
                                                                              uint64_t period_ms,
                                                                              const char *endpoint);

void amos_link_federation_stop(struct amos_link_federation_task *task);

const char *amos_link_last_error(void);

void amos_link_error_clear(void);
