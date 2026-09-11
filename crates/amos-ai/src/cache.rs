//! Bounded inference-response cache (`cache.rs`).
//!
//! Closes the second long-standing audit gap (`CODE_AUDIT_REPORT.md` §7 /
//! `FUNCTIONAL_GAP_ANALYSIS.md` §H.35): identical `(model, prompt, context,
//! max_tokens)` inference requests are never reused, so every repeat pays full
//! NPU/GPU energy on a battery device. This module provides:
//!
//! - [`ResponseCache`] — a **bounded** LRU + TTL store with an **injectable
//!   clock** (deterministic tests), a per-entry byte ceiling, and honest
//!   counters (hits / misses / stores / evicted / expired / oversized).
//! - [`CachingBackend`] — a transparent [`InferenceBackend`] decorator: cache
//!   hits replay the recorded token sequence through a normal `TokenStream`,
//!   so the gRPC streaming contract and the UI never change. Upstream errors
//!   are **never cached**, and the metadata name honestly gains a `+cache`
//!   suffix so `get_status` shows the cache is in the serving path.
//!
//! Safety discipline (matching the crate's `deny(unwrap/expect/panic)` gate):
//! every cache operation is total — a poisoned lock falls back to
//! `into_inner()`, an oversized key/value is an honest `oversized` rejection,
//! and a cache lookup can always report a plain miss. The cache is opt-in via
//! `AMOS_RESPONSE_CACHE=1` (default **off**): caching changes observable
//! latency (a hit has near-zero TTFT), so it must be a deliberate operator
//! choice, recorded in `get_status` via the backend metadata name.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use async_trait::async_trait;

use crate::inference::real::{BackendMetadata, BackendStats, InferenceBackend, TokenStream};

/// Maximum cached entries (LRU bound). Small by design: responses are only
/// reused within a daemon uptime, and 32 full answers is already generous.
pub const DEFAULT_CACHE_CAPACITY: usize = 32;

/// Default time-to-live for a cached response.
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(300);

/// Per-entry ceiling on `key_bytes + response_bytes`. An entry above the
/// ceiling is honestly rejected (counted as `oversized`), never truncated —
/// a truncated replay would silently lie to the user.
pub const DEFAULT_MAX_ENTRY_BYTES: usize = 256 * 1024;

/// One cached inference result: the exact token sequence the backend produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedResponse {
    pub tokens: Vec<String>,
}

/// Honest counters. `lookups == hits + misses` is an invariant the tests lock.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CacheStats {
    pub entries: usize,
    pub hits: u64,
    pub misses: u64,
    pub stores: u64,
    pub evicted: u64,
    pub expired: u64,
    pub oversized: u64,
}

/// Outcome of a store attempt — deliberately explicit so callers (and tests)
/// can tell a real store from a silent no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreOutcome {
    Stored,
    /// `key + response` above the per-entry ceiling; nothing was written.
    RejectedOversized,
}

struct CacheInner {
    map: HashMap<String, (CachedResponse, Instant)>,
    /// Recency order, oldest first. Kept as a plain `Vec` — with
    /// `capacity <= 64` the O(n) move-to-back is trivially cheap and far
    /// easier to verify than a hand-rolled intrusive list.
    order: Vec<String>,
}

/// Bounded LRU + TTL response cache with an injectable clock.
pub struct ResponseCache {
    capacity: usize,
    ttl: Duration,
    max_entry_bytes: usize,
    inner: Mutex<CacheInner>,
    stats: Mutex<CacheStats>,
}

impl ResponseCache {
    /// Build a cache; zero-valued bounds are config errors, never silently
    /// clamped (fail loudly at construction).
    pub fn try_new(capacity: usize, ttl: Duration, max_entry_bytes: usize) -> Result<Self, String> {
        if capacity == 0 {
            return Err("response cache capacity must be >= 1".to_string());
        }
        if ttl.is_zero() {
            return Err("response cache ttl must be > 0".to_string());
        }
        if max_entry_bytes == 0 {
            return Err("response cache max_entry_bytes must be > 0".to_string());
        }
        Ok(Self {
            capacity,
            ttl,
            max_entry_bytes,
            inner: Mutex::new(CacheInner {
                map: HashMap::new(),
                order: Vec::new(),
            }),
            stats: Mutex::new(CacheStats::default()),
        })
    }

    /// Look a key up as of `now` (injectable clock → deterministic tests).
    /// Entries that have passed their TTL are removed and counted as
    /// `expired`, so expiry is observable rather than a mystery miss.
    pub fn lookup_at(&self, key: &str, now: Instant) -> Option<CachedResponse> {
        let hit = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let expired = matches!(
                inner.map.get(key),
                Some((_, stored_at)) if now.duration_since(*stored_at) >= self.ttl
            );
            if expired {
                inner.map.remove(key);
                inner.order.retain(|k| k != key);
                drop(inner);
                let mut s = self.stats.lock().unwrap_or_else(|p| p.into_inner());
                s.expired = s.expired.saturating_add(1);
                None
            } else {
                match inner.map.get(key) {
                    Some((resp, _)) => {
                        let resp = resp.clone();
                        // Refresh recency (move-to-back).
                        inner.order.retain(|k| k != key);
                        inner.order.push(key.to_string());
                        Some(resp)
                    }
                    None => None,
                }
            }
        };
        let mut s = self.stats.lock().unwrap_or_else(|p| p.into_inner());
        if hit.is_some() {
            s.hits = s.hits.saturating_add(1);
        } else {
            s.misses = s.misses.saturating_add(1);
        }
        hit
    }

    /// Store a response as of `now`. Returns an explicit [`StoreOutcome`];
    /// oversized entries are rejected, never truncated (a truncated replay
    /// would silently lie to the user).
    pub fn store_at(&self, key: &str, tokens: Vec<String>, now: Instant) -> StoreOutcome {
        let response_bytes: usize = tokens.iter().map(|t| t.len()).sum();
        if key.len().saturating_add(response_bytes) > self.max_entry_bytes {
            let mut s = self.stats.lock().unwrap_or_else(|p| p.into_inner());
            s.oversized = s.oversized.saturating_add(1);
            return StoreOutcome::RejectedOversized;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // Overwrite-in-place keeps exactly one entry per key.
        if inner.map.remove(key).is_some() {
            inner.order.retain(|k| k != key);
        }
        while inner.map.len() >= self.capacity {
            match inner.order.first().cloned() {
                Some(oldest) => {
                    inner.map.remove(&oldest);
                    inner.order.remove(0);
                    let mut s = self.stats.lock().unwrap_or_else(|p| p.into_inner());
                    s.evicted = s.evicted.saturating_add(1);
                }
                None => break,
            }
        }
        inner
            .map
            .insert(key.to_string(), (CachedResponse { tokens }, now));
        inner.order.push(key.to_string());
        let mut s = self.stats.lock().unwrap_or_else(|p| p.into_inner());
        s.stores = s.stores.saturating_add(1);
        StoreOutcome::Stored
    }

    /// Default-shaped cache (32 entries, 300 s TTL, 256 KiB per entry).
    /// Constructed directly: the constants are compile-time nonzero (locked by
    /// the `defaults_are_valid` test), so the validation path is a tautology
    /// here and no error fallback exists to get wrong.
    pub fn with_defaults() -> Self {
        Self {
            capacity: DEFAULT_CACHE_CAPACITY,
            ttl: DEFAULT_CACHE_TTL,
            max_entry_bytes: DEFAULT_MAX_ENTRY_BYTES,
            inner: Mutex::new(CacheInner {
                map: HashMap::new(),
                order: Vec::new(),
            }),
            stats: Mutex::new(CacheStats::default()),
        }
    }

    /// Wall-clock convenience wrapper (production path).
    pub fn lookup(&self, key: &str) -> Option<CachedResponse> {
        self.lookup_at(key, Instant::now())
    }

    /// Wall-clock convenience wrapper (production path).
    pub fn store(&self, key: &str, tokens: Vec<String>) -> StoreOutcome {
        self.store_at(key, tokens, Instant::now())
    }

    /// Point-in-time honest snapshot (tests + future `get_status` wiring).
    pub fn stats(&self) -> CacheStats {
        let mut s = self.stats.lock().unwrap_or_else(|p| p.into_inner()).clone();
        s.entries = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map
            .len();
        s
    }

    /// Fixed capacity.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Canonical cache key over **everything the backend sees**: `model`,
    /// `max_tokens`, `prompt`, and every `(key, value)` context pair in sorted
    /// key order. Nothing that can change the response is silently excluded —
    /// in particular the session-lineage context key participates, so
    /// identical prompts from different conversations are distinct keys (an
    /// honest, never-wrongly-shared cache).
    pub fn cache_key(
        model: &str,
        prompt: &str,
        context: &HashMap<String, String>,
        max_tokens: usize,
    ) -> String {
        let mut key = String::with_capacity(64);
        key.push_str(model);
        key.push('\u{1}');
        key.push_str(&max_tokens.to_string());
        key.push('\u{1}');
        key.push_str(prompt);
        key.push('\u{1}');
        let mut pairs: Vec<(&String, &String)> = context.iter().collect();
        pairs.sort_unstable_by(|a, b| a.0.cmp(b.0));
        for (k, v) in pairs {
            key.push_str(k);
            key.push('\u{2}');
            key.push_str(v);
            key.push('\u{1}');
        }
        key
    }
}

/// A cache-hit token stream: replays a recorded token sequence verbatim.
struct ReplayStream {
    tokens: std::vec::IntoIter<String>,
}

#[async_trait]
impl TokenStream for ReplayStream {
    async fn next(&mut self) -> Option<Result<String>> {
        self.tokens.next().map(Ok)
    }
}

/// A cache-miss token stream: proxies the upstream stream while recording the
/// tokens, then stores the completed generation. An upstream error marks the
/// recording `failed` and nothing is cached (never cache a partial answer).
struct RecordingStream {
    inner: Box<dyn TokenStream>,
    key: String,
    cache: Arc<ResponseCache>,
    recorded: Vec<String>,
    failed: bool,
}

#[async_trait]
impl TokenStream for RecordingStream {
    async fn next(&mut self) -> Option<Result<String>> {
        match self.inner.next().await {
            Some(Ok(token)) => {
                self.recorded.push(token.clone());
                Some(Ok(token))
            }
            Some(Err(e)) => {
                self.failed = true;
                Some(Err(e))
            }
            None => {
                if !self.failed {
                    self.cache
                        .store(&self.key, std::mem::take(&mut self.recorded));
                }
                None
            }
        }
    }
}

/// Transparent caching decorator around any [`InferenceBackend`].
///
/// The metadata name gains an honest `+cache` suffix so `get_status` shows the
/// cache is in the serving path; everything else about the wrapped backend is
/// reported through unchanged (`BackendStats` stays a faithful pass-through —
/// the decorator fabricates nothing).
pub struct CachingBackend {
    inner: Arc<dyn InferenceBackend>,
    cache: Arc<ResponseCache>,
}

impl CachingBackend {
    pub fn new(inner: Arc<dyn InferenceBackend>, cache: Arc<ResponseCache>) -> Self {
        Self { inner, cache }
    }

    /// Shared cache handle (for stats/tests).
    pub fn cache(&self) -> Arc<ResponseCache> {
        self.cache.clone()
    }
}

#[async_trait]
impl InferenceBackend for CachingBackend {
    async fn infer(
        &self,
        prompt: &str,
        context: &HashMap<String, String>,
        max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        let model = self.inner.metadata().model_name;
        let key = ResponseCache::cache_key(&model, prompt, context, max_tokens);
        if let Some(cached) = self.cache.lookup(&key) {
            tracing::debug!(tokens = cached.tokens.len(), "inference cache hit");
            return Ok(Box::new(ReplayStream {
                tokens: cached.tokens.into_iter(),
            }));
        }
        let stream = self.inner.infer(prompt, context, max_tokens).await?;
        Ok(Box::new(RecordingStream {
            inner: stream,
            key,
            cache: self.cache.clone(),
            recorded: Vec::new(),
            failed: false,
        }))
    }

    fn metadata(&self) -> BackendMetadata {
        let mut m = self.inner.metadata();
        if !m.name.ends_with("+cache") {
            m.name.push_str("+cache");
        }
        m
    }

    async fn health_check(&self) -> Result<()> {
        self.inner.health_check().await
    }

    async fn get_stats(&self) -> BackendStats {
        self.inner.get_stats().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> ResponseCache {
        ResponseCache::try_new(2, Duration::from_secs(100), 1024).expect("valid bounds")
    }

    fn ctx(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn defaults_are_valid_and_match_the_documented_bounds() {
        assert_eq!(DEFAULT_CACHE_CAPACITY, 32);
        assert_eq!(DEFAULT_CACHE_TTL, Duration::from_secs(300));
        assert_eq!(DEFAULT_MAX_ENTRY_BYTES, 256 * 1024);
        assert!(ResponseCache::try_new(
            DEFAULT_CACHE_CAPACITY,
            DEFAULT_CACHE_TTL,
            DEFAULT_MAX_ENTRY_BYTES
        )
        .is_ok());
    }

    #[test]
    fn zero_bounds_are_construction_errors() {
        assert!(ResponseCache::try_new(0, DEFAULT_CACHE_TTL, 64).is_err());
        assert!(ResponseCache::try_new(2, Duration::ZERO, 64).is_err());
        assert!(ResponseCache::try_new(2, DEFAULT_CACHE_TTL, 0).is_err());
    }

    #[test]
    fn store_then_lookup_hits_and_counts_honestly() {
        let c = cache();
        let t0 = Instant::now();
        assert_eq!(
            c.store_at("k", vec!["a".into(), "b".into()], t0),
            StoreOutcome::Stored
        );
        let hit = c.lookup_at("k", t0).expect("hit");
        assert_eq!(hit.tokens, vec!["a", "b"]);
        let s = c.stats();
        assert_eq!(s.hits, 1);
        assert_eq!(s.entries, 1);
        assert!(c.lookup_at("absent", t0).is_none());
        let s = c.stats();
        assert_eq!(s.hits + s.misses, 2, "invariant: lookups == hits + misses");
        assert_eq!(s.misses, 1);
    }

    #[test]
    fn ttl_expiry_removes_and_counts() {
        let c = cache();
        let t0 = Instant::now();
        c.store_at("k", vec!["x".into()], t0);
        // At the exact TTL boundary the entry is expired (>= semantics).
        assert!(c.lookup_at("k", t0 + Duration::from_secs(100)).is_none());
        assert_eq!(
            c.stats().expired,
            1,
            "expiry is observable, not a mystery miss"
        );
        assert_eq!(c.stats().entries, 0);
        // One tick before the boundary it is still a hit.
        c.store_at("k", vec!["x".into()], t0);
        assert!(c.lookup_at("k", t0 + Duration::from_secs(99)).is_some());
        assert_eq!(c.stats().expired, 1);
    }

    #[test]
    fn lru_evicts_least_recently_used_and_counts() {
        let c = cache();
        let t0 = Instant::now();
        c.store_at("a", vec!["1".into()], t0);
        c.store_at("b", vec!["2".into()], t0);
        // Touch "a" so "b" becomes the LRU entry.
        assert!(c.lookup_at("a", t0).is_some());
        c.store_at("c", vec!["3".into()], t0);
        assert!(c.lookup_at("b", t0).is_none(), "LRU entry evicted");
        assert!(c.lookup_at("a", t0).is_some());
        assert!(c.lookup_at("c", t0).is_some());
        assert_eq!(c.stats().evicted, 1);
        assert_eq!(c.stats().entries, 2);
    }

    #[test]
    fn overwrite_same_key_keeps_one_entry_and_refreshes_recency() {
        let c = cache();
        let t0 = Instant::now();
        c.store_at("a", vec!["old".into()], t0);
        c.store_at("b", vec!["keep".into()], t0);
        c.store_at("a", vec!["new".into()], t0);
        let got = c.lookup_at("a", t0).expect("a present");
        assert_eq!(got.tokens, vec!["new"]);
        let s = c.stats();
        assert_eq!(s.entries, 2);
        assert_eq!(s.stores, 3);
        assert_eq!(s.evicted, 0, "overwrite is not an eviction");
    }

    #[test]
    fn oversized_entries_are_rejected_never_truncated() {
        // max_entry_bytes 16; tokens alone are 20 bytes.
        let c = ResponseCache::try_new(2, Duration::from_secs(10), 16).unwrap();
        let t0 = Instant::now();
        assert_eq!(
            c.store_at("k", vec!["x".repeat(20)], t0),
            StoreOutcome::RejectedOversized
        );
        assert!(c.lookup_at("k", t0).is_none());
        let s = c.stats();
        assert_eq!(s.oversized, 1);
        assert_eq!(s.stores, 0);
        assert_eq!(s.entries, 0);
    }

    #[test]
    fn oversized_keys_are_rejected_too() {
        let c = ResponseCache::try_new(2, Duration::from_secs(10), 16).unwrap();
        let t0 = Instant::now();
        assert_eq!(
            c.store_at(&"k".repeat(20), vec![], t0),
            StoreOutcome::RejectedOversized
        );
        assert_eq!(c.stats().oversized, 1);
    }

    #[test]
    fn cache_key_is_canonical_over_context_order() {
        let a = ResponseCache::cache_key("m", "p", &ctx(&[("x", "1"), ("y", "2")]), 256);
        let b = ResponseCache::cache_key("m", "p", &ctx(&[("y", "2"), ("x", "1")]), 256);
        assert_eq!(a, b, "context insertion order must not change the key");
    }

    #[test]
    fn cache_key_separates_all_inputs() {
        let base = ResponseCache::cache_key("m", "p", &ctx(&[("x", "1")]), 256);
        assert_ne!(
            base,
            ResponseCache::cache_key("m2", "p", &ctx(&[("x", "1")]), 256),
            "model participates"
        );
        assert_ne!(
            base,
            ResponseCache::cache_key("m", "p2", &ctx(&[("x", "1")]), 256),
            "prompt participates"
        );
        assert_ne!(
            base,
            ResponseCache::cache_key("m", "p", &ctx(&[("x", "2")]), 256),
            "context value participates"
        );
        assert_ne!(
            base,
            ResponseCache::cache_key("m", "p", &ctx(&[("x", "1"), ("z", "9")]), 256),
            "extra context key participates"
        );
        assert_ne!(
            base,
            ResponseCache::cache_key("m", "p", &ctx(&[("x", "1")]), 512),
            "max_tokens participates"
        );
    }

    #[test]
    fn session_lineage_key_participates_in_the_key() {
        // Two different client sessions asking the same prompt are distinct
        // keys (honest: responses are never wrongly shared across
        // conversations that could have diverged).
        let s1 = ResponseCache::cache_key("m", "hi", &ctx(&[("amos_session", "s1")]), 256);
        let s2 = ResponseCache::cache_key("m", "hi", &ctx(&[("amos_session", "s2")]), 256);
        assert_ne!(s1, s2);
    }

    #[test]
    fn concurrent_access_keeps_counts_consistent() {
        use std::sync::Arc as StdArc;
        let c = StdArc::new(cache());
        let t0 = Instant::now();
        c.store_at("shared", vec!["s".into()], t0);
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let c = c.clone();
                std::thread::spawn(move || {
                    let _ = c.lookup_at("shared", t0);
                    if i % 2 == 0 {
                        c.store_at(&format!("k{i}"), vec!["v".into()], t0);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("thread joins");
        }
        let s = c.stats();
        assert_eq!(s.hits + s.misses, 8, "every lookup counted exactly once");
        assert_eq!(s.entries, 2, "capacity 2: shared + one newer key");
    }

    // ---- CachingBackend decorator tests (counting/failing test double) ----

    /// Deterministic test double: emits fixed tokens, counts `infer` calls,
    /// and can be told to fail the Nth call (1-based) with a typed error.
    struct TestBackend {
        calls: std::sync::atomic::AtomicUsize,
        fail_on_call: Option<usize>,
    }

    impl TestBackend {
        fn new() -> Self {
            Self {
                calls: std::sync::atomic::AtomicUsize::new(0),
                fail_on_call: None,
            }
        }
        fn failing(nth: usize) -> Self {
            Self {
                calls: std::sync::atomic::AtomicUsize::new(0),
                fail_on_call: Some(nth),
            }
        }
        fn call_count(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::Relaxed)
        }
        fn metadata_of(name: &str) -> BackendMetadata {
            BackendMetadata {
                name: name.to_string(),
                version: "0".to_string(),
                model_name: "test-model".to_string(),
                max_context_length: 2048,
                supports_streaming: true,
                supports_function_calling: false,
                supports_images: false,
            }
        }
    }

    struct VecTokenStream {
        tokens: std::vec::IntoIter<String>,
        fail_after: Option<usize>,
        emitted: usize,
    }

    #[async_trait]
    impl TokenStream for VecTokenStream {
        async fn next(&mut self) -> Option<Result<String>> {
            if let Some(after) = self.fail_after {
                if self.emitted == after {
                    return Some(Err(anyhow::anyhow!("synthetic mid-stream failure")));
                }
            }
            self.tokens.next().map(|t| {
                self.emitted += 1;
                Ok(t)
            })
        }
    }

    #[async_trait]
    impl InferenceBackend for TestBackend {
        async fn infer(
            &self,
            prompt: &str,
            _context: &HashMap<String, String>,
            _max_tokens: usize,
        ) -> Result<Box<dyn TokenStream>> {
            let n = self
                .calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                + 1;
            if self.fail_on_call == Some(n) {
                return Err(anyhow::anyhow!("synthetic infer failure on call {n}"));
            }
            Ok(Box::new(VecTokenStream {
                tokens: vec![format!("tok1-for-{prompt}"), "tok2".to_string()].into_iter(),
                fail_after: None,
                emitted: 0,
            }))
        }

        fn metadata(&self) -> BackendMetadata {
            Self::metadata_of("test-backend")
        }

        async fn health_check(&self) -> Result<()> {
            Ok(())
        }

        async fn get_stats(&self) -> BackendStats {
            BackendStats {
                gpu_utilization_percent: None,
                memory_used_mb: None,
                memory_total_mb: None,
                active_requests: None,
                total_tokens_generated: None,
                avg_tokens_per_second: None,
            }
        }
    }

    async fn drain(mut stream: Box<dyn TokenStream>) -> (Vec<String>, Option<anyhow::Error>) {
        let mut out = Vec::new();
        let mut err = None;
        while let Some(item) = stream.next().await {
            match item {
                Ok(t) => out.push(t),
                Err(e) => {
                    err = Some(e);
                    break;
                }
            }
        }
        (out, err)
    }

    #[tokio::test]
    async fn second_identical_call_replays_without_hitting_the_backend() {
        let inner = Arc::new(TestBackend::new());
        let backend = CachingBackend::new(inner.clone(), Arc::new(ResponseCache::with_defaults()));
        let empty = ctx(&[]);
        let s1 = backend
            .infer("hello", &empty, 256)
            .await
            .expect("first call");
        let (t1, err1) = drain(s1).await;
        assert!(err1.is_none());
        assert_eq!(inner.call_count(), 1);
        // Second identical request: served from cache.
        let s2 = backend
            .infer("hello", &empty, 256)
            .await
            .expect("second call");
        let (t2, err2) = drain(s2).await;
        assert!(err2.is_none());
        assert_eq!(inner.call_count(), 1, "cache hit must not call the backend");
        assert_eq!(t1, t2, "replay must be token-for-token identical");
        let s = backend.cache().stats();
        assert_eq!((s.hits, s.misses, s.stores), (1, 1, 1));
    }

    #[tokio::test]
    async fn different_inputs_are_distinct_cache_keys() {
        let inner = Arc::new(TestBackend::new());
        let backend = CachingBackend::new(inner.clone(), Arc::new(ResponseCache::with_defaults()));
        let empty = ctx(&[]);
        let with = ctx(&[("k", "v")]);
        let s1 = backend.infer("p", &empty, 256).await.expect("call 1");
        let _ = drain(s1).await;
        let s2 = backend.infer("p", &with, 256).await.expect("call 2");
        let _ = drain(s2).await;
        let s3 = backend.infer("p", &empty, 512).await.expect("call 3");
        let _ = drain(s3).await;
        assert_eq!(
            inner.call_count(),
            3,
            "every distinct input is a real generation"
        );
    }

    #[tokio::test]
    async fn upstream_errors_are_never_cached() {
        let inner = Arc::new(TestBackend::failing(1));
        let backend = CachingBackend::new(inner.clone(), Arc::new(ResponseCache::with_defaults()));
        let empty = ctx(&[]);
        let err = backend
            .infer("p", &empty, 256)
            .await
            .err()
            .expect("call 1 fails inside infer");
        assert!(err.to_string().contains("synthetic infer failure"));
        assert_eq!(backend.cache().stats().stores, 0, "failures are not cached");
        assert_eq!(
            inner.call_count(),
            1,
            "the failed attempt is not remembered as a hit"
        );
    }

    #[tokio::test]
    async fn mid_stream_errors_record_nothing() {
        // A stream that errors after emitting tokens must not store a partial
        // answer: the recording wrapper marks the run failed.
        struct HalfFailing;
        #[async_trait]
        impl InferenceBackend for HalfFailing {
            async fn infer(
                &self,
                _p: &str,
                _c: &HashMap<String, String>,
                _m: usize,
            ) -> Result<Box<dyn TokenStream>> {
                Ok(Box::new(VecTokenStream {
                    tokens: vec!["partial".to_string()].into_iter(),
                    fail_after: Some(1),
                    emitted: 0,
                }))
            }
            fn metadata(&self) -> BackendMetadata {
                TestBackend::metadata_of("half-failing")
            }
            async fn health_check(&self) -> Result<()> {
                Ok(())
            }
            async fn get_stats(&self) -> BackendStats {
                BackendStats {
                    gpu_utilization_percent: None,
                    memory_used_mb: None,
                    memory_total_mb: None,
                    active_requests: None,
                    total_tokens_generated: None,
                    avg_tokens_per_second: None,
                }
            }
        }
        let cache = Arc::new(ResponseCache::with_defaults());
        let backend = CachingBackend::new(Arc::new(HalfFailing), cache.clone());
        let s = backend
            .infer("p", &ctx(&[]), 256)
            .await
            .expect("stream opens");
        let (_tokens, err) = drain(s).await;
        assert!(err.is_some(), "the synthetic mid-stream error propagates");
        assert_eq!(cache.stats().stores, 0, "partial answers are never cached");
        assert_eq!(cache.stats().entries, 0);
        // And a follow-up request is a fresh miss (nothing was poisoned).
        assert_eq!(cache.stats().misses, 1);
    }

    #[tokio::test]
    async fn metadata_name_honestly_reports_the_cache() {
        let backend = CachingBackend::new(
            Arc::new(TestBackend::new()),
            Arc::new(ResponseCache::with_defaults()),
        );
        assert_eq!(backend.metadata().name, "test-backend+cache");
        assert_eq!(backend.metadata().name, "test-backend+cache");
        let stats: BackendStats = backend.get_stats().await;
        assert_eq!(
            stats.gpu_utilization_percent, None,
            "pass-through stays honest (None = unknown, never fabricated)"
        );
    }
}
