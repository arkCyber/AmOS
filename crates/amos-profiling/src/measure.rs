//! Tiny wall-time helper for measuring a single inference call around `Instant`.

use std::time::{Duration, Instant};

/// Run `f` and return its result together with the elapsed wall time.
///
/// Works whether the body is sync or async-invoking-sync: `Instant::elapsed` is
/// monotonic and safe across an `await`. This is the primitive a wrapper around
/// the actual model call uses to produce the `Duration` fed to a
/// [`ProfileTracker`](crate::ProfileTracker).
pub fn time<F, T>(f: F) -> (T, Duration)
where
    F: FnOnce() -> T,
{
    let start = Instant::now();
    let out = f();
    let wall = start.elapsed();
    (out, wall)
}

/// Run `f`, then hand `(result, wall)` to a consumer that returns `R`. Saves the
/// caller from juggling the tuple when they only want the final value (e.g. the
/// decoded string + its recorded `Duration`).
pub fn time_and<T, R, F, C>(f: F, consume: C) -> R
where
    F: FnOnce() -> T,
    C: FnOnce(T, Duration) -> R,
{
    let start = Instant::now();
    let out = f();
    let wall = start.elapsed();
    consume(out, wall)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_returns_value_and_elapsed() {
        let (v, wall) = time(|| 42u32);
        assert_eq!(v, 42);
        assert!(wall >= Duration::ZERO);
    }

    #[test]
    fn time_and_forwards_result_and_wall() {
        let summed = time_and(
            || vec![1u32, 2, 3],
            |v, wall| {
                assert!(wall >= Duration::ZERO);
                v.into_iter().sum::<u32>()
            },
        );
        assert_eq!(summed, 6);
    }
}
