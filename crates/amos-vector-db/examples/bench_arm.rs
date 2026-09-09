//! `bench_arm` — the **honest device benchmark** for the flat vector index.
//!
//! This is what answers the product question "how fast is exact local retrieval
//! on the ARM chip?" — but per this repo's rules the answer is only ever
//! *measured here*, on the real device, and never claimed up front.
//!
//! It builds an in-memory `FlatIndex` of `COUNT` unit-normalised random vectors
//! of dimension `DIM` (defaults: 20_000 × 384, a realistic personal knowledge
//! base of thousands of chunks at a small-embedding dimension), then times the
//! ingest pass and `QUERIES` top-5 cosine searches, printing per-op timings.
//!
//! Deterministic (fixed LCG seed) so runs are reproducible and comparable.
//!
//! Usage:
//! ```text
//! cargo run -p amos-vector-db --example bench_arm -- [COUNT] [DIM]
//! cargo run -p amos-vector-db --example bench_arm -- 50000 768
//! ```

use std::time::Instant;

use amos_vector_db::{FlatIndex, Metric, Result, Vector};

/// Small deterministic PRNG (no external deps, reproducible runs).
struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg(seed)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(144_269_504_088_963_407);
        self.0
    }
    /// Uniform-ish value in `[0, 1)`, always finite.
    fn unit(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32) / ((1u64 << 24) as f32)
    }
}

fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().fold(0.0_f32, |a, x| a + x * x).sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

fn arg(iter: &mut impl Iterator<Item = String>, default: usize) -> usize {
    iter.next().and_then(|s| s.parse().ok()).unwrap_or(default)
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let count = arg(&mut args, 20_000);
    let dim = arg(&mut args, 384);
    let queries = 1_000;

    let idx = FlatIndex::new(dim)?;
    let mut rng = Lcg::new(0x5eed_1234_u64);

    // ---- ingest ----
    let mut idx = idx;
    let t0 = Instant::now();
    for i in 0..count {
        let mut data = Vec::with_capacity(dim);
        for _ in 0..dim {
            data.push(rng.unit());
        }
        let v = Vector::new(format!("chunk-{i}"), normalize(data))?;
        idx.add(v)?;
    }
    let ingest = t0.elapsed();

    // ---- query ----
    let t1 = Instant::now();
    let mut returned = 0usize;
    for _ in 0..queries {
        let mut q = Vec::with_capacity(dim);
        for _ in 0..dim {
            q.push(rng.unit());
        }
        let q = normalize(q);
        let hits = idx.search(&q, Metric::Cosine, 5)?;
        returned += hits.len();
    }
    let query_time = t1.elapsed();

    let ingest_ms = ingest.as_secs_f64() * 1e3;
    let per_query_ms = query_time.as_secs_f64() * 1e3 / queries as f64;
    let per_insert_us = ingest.as_secs_f64() * 1e6 / count as f64;

    let where_note = if cfg!(target_os = "android") {
        "NOTE: measured on this Android device (release, exact flat scan)."
    } else {
        "NOTE: measured on this host only — build for aarch64-linux-android and run on the real device for the ARM figure."
    };

    println!(
        "amos-vector-db bench | count={count} dim={dim} queries={queries} returned={returned}\n\
         ingest total {ingest_ms:.1} ms  ({per_insert_us:.2} us/insert)\n\
         top-5 search {per_query_ms:.4} ms/query (flat, exact, cosine)\n\
         {where_note}"
    );
    Ok(())
}
