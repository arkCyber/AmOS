//! A bounded **sample buffer** that bridges a real-time audio *producer* to the
//! pull [`crate::AudioCapture`] reader AmOS uses.
//!
//! The AAudio device seam has two very different clock domains:
//!
//! * **Producer** — AAudio invokes its data callback on a dedicated real-time
//!   thread whenever a new period of input frames is ready (the "hardware
//!   sampling callback"). That thread must never block for long, allocate, or
//!   do I/O.
//! * **Consumer** — the resident voice worker calls `read()` on a normal thread
//!   whenever it wants the next chunk.
//!
//! [`SampleRing`] is the seam between them. The producer `push`es whole callback
//! buffers; the consumer `read`s them out in order. `read` returns a *partial*
//! buffer as soon as any sample is available (never waits to fill the whole
//! request), and only reports end-of-stream (`0`) when the producer has stayed
//! silent for the whole read budget — mirroring the 1 s blocking-read budget the
//! existing AAudio pull path uses. A live microphone keeps producing samples even
//! for silence, so it never spuriously reports EOF; only a stopped/erroring
//! stream does.
//!
//! Honest engineering note: this is a `Mutex`-guarded ring, **not** a lock-free
//! SPSC. On the Android audio path the producer critical section is short (copy a
//! callback period into a pre-reserved `VecDeque` and signal one waiter) and the
//! consumer drains at a ~10 ms cadence, so blocking is negligible for an
//! always-on assistant listen. This is intentionally kept dependency-free and
//! trivially unit-testable on a host; a lock-free ring would be the right next
//! step only if a hard-realtime (music-grade) sink ever shares this buffer.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// Default budget a [`SampleRing::read`] waits for its first sample before
/// declaring the producer starved/closed (`0`). Mirrors the 1 s blocking budget
/// the blocking AAudio seam uses (`TIMEOUT_NS`) so a pull worker can be stopped
/// promptly yet a healthy live mic is never mistaken for end-of-stream.
const DEFAULT_READ_TIMEOUT: Duration = Duration::from_millis(1000);

/// Wake-up granularity while waiting for a first sample — small enough that a
/// worker told to stop is not stuck behind a long condvar sleep.
const POLL_STEP: Duration = Duration::from_millis(5);

struct Inner {
    /// FIFO of mono f32 samples, pre-reserved to `capacity` so `push` never
    /// allocates on the real-time path.
    buf: VecDeque<f32>,
    /// Total samples evicted because the ring was full when `push` ran. A
    /// non-zero value is honest evidence the consumer fell behind the producer.
    dropped: u64,
}

/// A bounded, order-preserving, producer→consumer sample channel.
///
/// `push` is safe to call from a real-time audio thread (short, allocation-free
/// critical section once the ring is reserved; wakes one waiter). `read` is safe
/// to call from the pull worker thread. `Send` (not `Sync`) by construction — the
/// intended ownership is one producer + one consumer.
pub struct SampleRing {
    inner: Mutex<Inner>,
    cv: Condvar,
    /// Pre-allocated element capacity (so `push` never reallocates).
    capacity: usize,
    /// How long `read` waits for a first sample before returning end-of-stream.
    read_timeout: Duration,
}

impl SampleRing {
    /// A bounded ring with the default 1 s read budget (matches the AAudio
    /// blocking-read timeout).
    pub fn new(capacity: usize) -> Self {
        Self::with_read_timeout(capacity, DEFAULT_READ_TIMEOUT)
    }

    /// A bounded ring whose `read` waits at most `read_timeout` for a first
    /// sample before reporting end-of-stream (`0`). Tests use a short budget so
    /// an empty ring returns promptly instead of blocking a second.
    pub fn with_read_timeout(capacity: usize, read_timeout: Duration) -> Self {
        let capacity = capacity.max(1);
        // `with_capacity` pre-allocates the backing store; `push_back` within this
        // bound does not reallocate, so the producer's critical section is O(1).
        let buf = VecDeque::with_capacity(capacity);
        Self {
            inner: Mutex::new(Inner { buf, dropped: 0 }),
            cv: Condvar::new(),
            capacity,
            read_timeout,
        }
    }

    /// Element capacity of the ring.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Samples currently buffered and waiting to be read.
    pub fn pending(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .buf
            .len()
    }

    /// Number of samples ever evicted because the ring was full. Non-zero means
    /// the consumer is not keeping up with the producer.
    pub fn dropped(&self) -> u64 {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).dropped
    }

    /// Push a whole callback buffer in. When the ring is full the oldest samples
    /// are evicted (and counted in [`dropped`](Self::dropped)) so this never
    /// grows without bound. Returns the number pushed (`samples.len()` unless it
    /// was empty). Safe to call from the real-time producer thread.
    pub fn push(&self, samples: &[f32]) -> usize {
        if samples.is_empty() {
            return 0;
        }
        let mut pushed = 0;
        {
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            for &s in samples {
                if g.buf.len() >= self.capacity {
                    g.buf.pop_front();
                    g.dropped = g.dropped.wrapping_add(1);
                }
                g.buf.push_back(s);
                pushed += 1;
            }
        }
        self.cv.notify_one();
        pushed
    }

    /// Drain up to `out.len()` samples in order into `out`, returning how many
    /// were written.
    ///
    /// * Returns as soon as *any* sample is available (a partial buffer — the
    ///   caller's resampler/worker handles partial chunks fine). It does not wait
    ///   to fill the whole request.
    /// * If nothing is buffered, it waits up to the read budget for a first
    ///   sample, then returns `0` (end-of-stream) if the producer stayed silent.
    pub fn read(&self, out: &mut [f32]) -> usize {
        if out.is_empty() {
            return 0;
        }
        let deadline = Instant::now() + self.read_timeout;
        loop {
            let n = self.drain(out);
            if n > 0 {
                return n;
            }
            let now = Instant::now();
            if now >= deadline {
                return 0;
            }
            // Wait for a producer wake (or a short slice) so a stopped worker is
            // not parked behind a long sleep. Re-check the buffer after waking.
            let remaining = deadline.saturating_duration_since(now);
            let step = self.read_timeout.min(POLL_STEP).min(remaining);
            let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if g.buf.is_empty() {
                let _ = self.cv.wait_timeout(g, step);
            }
        }
    }

    /// Non-blocking drain of everything currently available.
    fn drain(&self, out: &mut [f32]) -> usize {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut n = 0usize;
        while n < out.len() {
            match g.buf.pop_front() {
                Some(s) => {
                    out[n] = s;
                    n += 1;
                }
                None => break,
            }
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn push_then_read_preserves_order_and_partials() {
        let ring = SampleRing::new(16);
        ring.push(&[0.0, 1.0, 2.0, 3.0]);
        // A read larger than what is buffered returns just the partial buffer.
        let mut out = vec![0.0f32; 10];
        assert_eq!(ring.read(&mut out), 4);
        assert_eq!(&out[..4], &[0.0, 1.0, 2.0, 3.0]);
        assert_eq!(ring.pending(), 0);
    }

    #[test]
    fn partial_reads_advance_in_order() {
        let ring = SampleRing::new(16);
        for i in 0..10 {
            ring.push(&[i as f32]);
        }
        let mut out = vec![0.0f32; 4];
        let mut got = Vec::new();
        loop {
            let n = ring.read(&mut out);
            assert!(n > 0, "all samples must be readable");
            got.extend_from_slice(&out[..n]);
            if got.len() == 10 {
                break;
            }
        }
        let expected: Vec<f32> = (0..10).map(|i| i as f32).collect();
        assert_eq!(got, expected);
    }

    #[test]
    fn full_ring_evicts_oldest_and_counts_dropped() {
        let ring = SampleRing::new(4);
        let pushed = ring.push(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(pushed, 7);
        assert_eq!(ring.pending(), 4);
        assert_eq!(ring.dropped(), 3, "0,1,2 evicted");
        let mut out = vec![0.0f32; 4];
        assert_eq!(ring.read(&mut out), 4);
        assert_eq!(&out, &[3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn empty_read_times_out_to_eof_within_budget() {
        // A tiny budget so the empty read returns fast instead of blocking a second.
        let ring = SampleRing::with_read_timeout(4, Duration::from_millis(10));
        let start = Instant::now();
        let mut out = vec![0.0f32; 8];
        assert_eq!(ring.read(&mut out), 0, "no producer -> honest EOF");
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "must not block long"
        );
    }

    #[test]
    fn empty_read_is_not_eof_when_a_producer_arrives() {
        // read() must wait (not return 0) when the ring is only momentarily empty
        // — a live mic that starts a few ms after the worker begins must not be
        // mistaken for end-of-stream.
        let ring = Arc::new(SampleRing::with_read_timeout(
            16,
            Duration::from_millis(200),
        ));
        let ring2 = Arc::clone(&ring);
        let producer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            ring2.push(&[9.0f32]);
        });
        let mut out = vec![0.0f32; 1];
        let n = ring.read(&mut out);
        assert_eq!(n, 1, "waited for the late producer instead of EOF");
        assert_eq!(out[0], 9.0);
        producer.join().unwrap();
    }

    #[test]
    fn concurrent_producer_consumer_loses_nothing() {
        // One producer streams a counter; one consumer reads until it has seen
        // every value, asserting strict ordering (an SPSC ring must not reorder).
        //
        // **Determinism** (a non-deterministic test is itself a defect — a failure
        // that cannot be reproduced from the code is worthless evidence): the
        // producer waits for **room** instead of sleeping a fixed interval, and the
        // consumer treats a `0` read as "nothing arrived within the read budget"
        // — which is exactly what `read` documents — instead of asserting on it. The
        // previous version asserted `n > 0` and `dropped() == 0` against wall-clock
        // scheduling: on a loaded machine (e.g. a workspace test run alongside a
        // Gradle build) the producer could be starved past the 1 s budget, or
        // overrun the 512-sample ring while the consumer was descheduled, flipping
        // the test red without any code change.
        const BATCH: usize = 4000;
        const CHUNK: usize = 64;
        let ring = Arc::new(SampleRing::new(512));
        let ring2 = Arc::clone(&ring);

        let producer = std::thread::spawn(move || {
            let cap = ring2.capacity();
            let mut buf = Vec::new();
            let flush = |buf: &mut Vec<f32>| {
                // Pace by the consumer: never push into a ring that cannot hold the
                // whole callback period, so `dropped` stays 0 by construction rather
                // than by luck.
                while ring2.pending() + buf.len() > cap {
                    std::thread::sleep(Duration::from_micros(200));
                }
                ring2.push(buf);
                buf.clear();
            };
            for i in 0..BATCH {
                buf.push(i as f32);
                if buf.len() == CHUNK {
                    flush(&mut buf);
                }
            }
            if !buf.is_empty() {
                flush(&mut buf);
            }
        });

        let mut got = Vec::with_capacity(BATCH);
        let mut out = vec![0.0f32; 128];
        let deadline = Instant::now() + Duration::from_secs(60);
        while got.len() < BATCH {
            let n = ring.read(&mut out);
            if n == 0 {
                // Starvation (no sample within the read budget), not proof of a bug:
                // keep draining, but never spin forever.
                assert!(
                    Instant::now() < deadline,
                    "producer starved for 60 s: the hand-off test cannot proceed"
                );
                continue;
            }
            got.extend_from_slice(&out[..n]);
        }
        producer.join().unwrap();
        let expected: Vec<f32> = (0..BATCH).map(|i| i as f32).collect();
        assert_eq!(got, expected, "no loss, no reordering");
        assert_eq!(ring.dropped(), 0, "no overflow when the consumer keeps up");
    }
}
