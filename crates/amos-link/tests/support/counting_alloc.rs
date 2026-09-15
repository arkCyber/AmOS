//! A counting global allocator, shared by the allocation-budget tests.
//!
//! Included with `#[path = "support/counting_alloc.rs"]` by **three** test binaries, each of
//! which holds exactly one `#[test]`. That shape is deliberate, and it is what closed the
//! previous round's honest boundary ("all three measurements live in one function because the
//! counter is process-wide and parallel tests would pollute each other"): the counter *is*
//! process-wide, so the way to get one measurement per test without sampling it is one
//! **process** per measurement — three test targets, one test each. `cargo test` runs each
//! target as its own process, so no other test can allocate inside a measured window.
//!
//! A thread-local counter would allow one binary with three tests, but reading a `thread_local`
//! from inside `alloc` is exactly the kind of thing that can recurse back into the allocator on
//! first touch — a stack overflow that looks like a flaky test. Separate processes cost a
//! compile and buy a proof that cannot be misread.

#![allow(dead_code)] // each test binary is one measurement; the shared helpers are used à la carte

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Cumulative bytes every allocation has asked the system allocator for.
static REQUESTED: AtomicUsize = AtomicUsize::new(0);

/// A pass-through allocator that only counts what is asked of it.
pub struct Counting;

// SAFETY: every method delegates to `System` with the caller's own `Layout` (forwarded
// unchanged, as `GlobalAlloc` requires) and returns its result untouched; the counter is an
// atomic add that cannot panic. No memory is moved, borrowed or freed differently from the
// system allocator, so the counting is observation only.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        REQUESTED.fetch_add(layout.size(), Ordering::Relaxed);
        // SAFETY: `layout` is the caller's own, forwarded unchanged.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr`/`layout` come from the matching allocation above.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        REQUESTED.fetch_add(new_size, Ordering::Relaxed);
        // SAFETY: the caller's own pointer/layout/size, forwarded unchanged.
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        REQUESTED.fetch_add(layout.size(), Ordering::Relaxed);
        // SAFETY: `layout` is the caller's own, forwarded unchanged.
        unsafe { System.alloc_zeroed(layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Bytes requested from the allocator so far (the running total, not a peak).
pub fn requested() -> usize {
    REQUESTED.load(Ordering::Relaxed)
}

/// Bytes `f` asked the allocator for, alongside its return value.
pub fn measure<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let before = requested();
    let value = f();
    (value, requested() - before)
}

/// Bytes a frame's own bookkeeping may cost on top of its payload: header serialization, a
/// `Vec`'s growth strategy, the decoded payload. A *second* copy of the payload — the defect
/// these tests exist to catch — needs far more.
pub const SLACK: usize = 64 * 1024;
