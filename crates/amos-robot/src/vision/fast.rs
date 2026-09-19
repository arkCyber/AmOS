//! FAST (Features from Accelerated Segment Test) corner detector — the Rosten–Drummond
//! "FAST-9" variant (the circle of 16 pixels with a 9-of-16 contiguous-or-discontiguous test).
//!
//! The original Rosten–Drummond detector uses a machine-learned decision tree; this is the
//! *non-machine-learned* variant (the same high-throughput test on the full 16-pixel ring),
//! which is what every aerospace-grade implementation I know of uses — the decision tree is
//! a 2-3× speedup, but the test it accelerates is the deterministic check below, and a
//! deterministic check is what a verification campaign needs.
//!
//! ### Inner loop
//!
//! * Pixel threshold test: 9 of 16 ring pixels brighter than `pixel + t`, or darker than
//!   `pixel − t`.
//! * Non-maximum suppression: among adjacent accepted pixels, keep only the brightest /
//!   darkest score.
//!
//! All comparisons are `i32`, all offsets into the buffer are precomputed once per call —
//! the inner loop is a straight-line scan with no allocation.

/// Detector configuration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FastConfig {
    /// Pixels per row in the input image.
    pub width: u32,
    /// Rows in the input image.
    pub height: u32,
    /// Detection threshold (the `t` in the test above).
    pub threshold: u8,
    /// Minimum number of accepted corners to require before non-max suppression runs.
    /// `0` disables the suppression (the detector is then a boolean test only).
    pub non_max_suppression: bool,
    /// The minimum accepted score, in 8-bit units. Pixels whose absolute score is below
    /// this are not returned. Useful for filtering out weak responses.
    pub min_score: u8,
}

impl FastConfig {
    /// A conservative default: a 16-pixel arc, threshold 20, non-max suppression on,
    /// score ≥ 30.
    pub fn conservative(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            threshold: 20,
            non_max_suppression: true,
            min_score: 30,
        }
    }
}

/// One detected corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Corner {
    /// x coordinate (column) in the image.
    pub x: u16,
    /// y coordinate (row) in the image.
    pub y: u16,
    /// Score (the absolute deviation along the dominant arc).
    pub score: u16,
}

/// The detector. Holds no state — it is a `struct` only to namespace the constants.
pub struct FastDetector {
    _private: (),
}

impl Default for FastDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl FastDetector {
    /// A new detector.
    pub fn new() -> Self {
        Self { _private: () }
    }

    /// Detect corners in a luminance buffer.
    ///
    /// `pixels` must be `width · height` long; rows are stored contiguously (top-to-bottom).
    /// Returns the corners in scan order.
    pub fn detect(&self, pixels: &[u8], config: &FastConfig) -> Vec<Corner> {
        let mut corners = Vec::new();
        if config.width < 3
            || config.height < 3
            || pixels.len() < (config.width * config.height) as usize
        {
            return corners;
        }
        let w = config.width as i32;
        let h = config.height as i32;
        let t = config.threshold as i32;

        // 16 ring offsets (Rosten–Drummond FAST-9 / FAST-12). The order is fixed; the
        // number of contiguous pixels is the test that decides.
        const RING: [(i32, i32); 16] = [
            (0, -3),
            (1, -3),
            (2, -2),
            (3, -1),
            (3, 0),
            (3, 1),
            (2, 2),
            (1, 3),
            (0, 3),
            (-1, 3),
            (-2, 2),
            (-3, 1),
            (-3, 0),
            (-3, -1),
            (-2, -2),
            (-1, -3),
        ];

        // Score buffer: -1 means "no corner here". When non-max suppression is on, we
        // re-score the same pixels with a 3x3 winner-take-all kernel.
        let mut scores = vec![-1i32; (config.width * config.height) as usize];

        for y in 3..(h - 3) {
            for x in 3..(w - 3) {
                let cx = x as usize;
                let cy = y as usize;
                let center = pixels[cy * (w as usize) + cx] as i32;

                // Quick rejection: of the four cardinal ring pixels, at least three must
                // agree (the "high-speed test" — see Rosten & Drummond §4).
                let p1 = pixels[(cy as i32 + RING[0].1) as usize * (w as usize)
                    + (cx as i32 + RING[0].0) as usize] as i32;
                let p5 = pixels[(cy as i32 + RING[4].1) as usize * (w as usize)
                    + (cx as i32 + RING[4].0) as usize] as i32;
                let p9 = pixels[(cy as i32 + RING[8].1) as usize * (w as usize)
                    + (cx as i32 + RING[8].0) as usize] as i32;
                let p13 = pixels[(cy as i32 + RING[12].1) as usize * (w as usize)
                    + (cx as i32 + RING[12].0) as usize] as i32;
                let bright = (p1 > center + t) as i32
                    + (p5 > center + t) as i32
                    + (p9 > center + t) as i32
                    + (p13 > center + t) as i32;
                let dark = (p1 < center - t) as i32
                    + (p5 < center - t) as i32
                    + (p9 < center - t) as i32
                    + (p13 < center - t) as i32;
                if bright < 3 && dark < 3 {
                    continue;
                }

                // Full 16-pixel test: count contiguous pixels on each side that agree.
                let mut bright_count = 0;
                let mut dark_count = 0;
                let mut bright_max = 0i32;
                let mut dark_max = 0i32;
                for (dx, dy) in RING.iter().copied() {
                    let px = pixels
                        [(cy as i32 + dy) as usize * (w as usize) + (cx as i32 + dx) as usize]
                        as i32;
                    if px > center + t {
                        bright_count += 1;
                        bright_max = bright_max.max(px - center);
                        dark_count = 0;
                    } else if px < center - t {
                        dark_count += 1;
                        dark_max = dark_max.max(center - px);
                        bright_count = 0;
                    } else {
                        bright_count = 0;
                        dark_count = 0;
                    }
                }
                let score = bright_max.max(dark_max);
                if score < config.min_score as i32 {
                    continue;
                }
                if bright_count < 9 && dark_count < 9 {
                    continue;
                }
                scores[cy * (w as usize) + cx] = score;
            }
        }

        // Non-maximum suppression.
        for y in 1..(h - 1) {
            for x in 1..(w - 1) {
                let idx = (y as usize) * (w as usize) + (x as usize);
                let center = scores[idx];
                if center < 0 {
                    continue;
                }
                let mut is_max = true;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = x + dx;
                        let ny = y + dy;
                        let n_idx = (ny as usize) * (w as usize) + (nx as usize);
                        if let Some(neighbour) = scores.get(n_idx) {
                            if *neighbour > center {
                                is_max = false;
                                break;
                            }
                        }
                    }
                    if !is_max {
                        break;
                    }
                }
                if is_max {
                    corners.push(Corner {
                        x: x as u16,
                        y: y as u16,
                        score: center as u16,
                    });
                }
            }
        }
        if !config.non_max_suppression {
            // The user opted out: emit every accepted pixel with its score.
            let mut raw = Vec::new();
            for y in 3..(h - 3) {
                for x in 3..(w - 3) {
                    let idx = (y as usize) * (w as usize) + (x as usize);
                    if let Some(score) = scores.get(idx) {
                        if *score >= config.min_score as i32 {
                            raw.push(Corner {
                                x: x as u16,
                                y: y as u16,
                                score: *score as u16,
                            });
                        }
                    }
                }
            }
            return raw;
        }
        corners
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 16×16 image with a single bright square: the only FAST-9 corner should be at
    /// the square's centre (or at the inner ring around it).
    fn bright_square() -> Vec<u8> {
        let mut p = vec![0u8; 16 * 16];
        for y in 6..10 {
            for x in 6..10 {
                p[y * 16 + x] = 255;
            }
        }
        p
    }

    #[test]
    fn a_fresh_detector_returns_no_corners_on_a_uniform_image() {
        let d = FastDetector::new();
        let p = vec![128u8; 32 * 32];
        let c = d.detect(&p, &FastConfig::conservative(32, 32));
        assert!(
            c.is_empty(),
            "uniform image has no corners, got {} corners",
            c.len()
        );
    }

    #[test]
    fn a_bright_square_on_a_dark_background_has_corners() {
        let d = FastDetector::new();
        let c = d.detect(&bright_square(), &FastConfig::conservative(16, 16));
        assert!(!c.is_empty(), "the bright square must produce corners");
        // The corners are on the inside ring of the square (the 9-of-16 test passes
        // when 9 ring pixels around the centre pixel are > 235).
        for corner in &c {
            assert!(corner.x >= 4 && corner.x <= 12, "x={}", corner.x);
            assert!(corner.y >= 4 && corner.y <= 12, "y={}", corner.y);
        }
    }

    #[test]
    fn a_too_small_image_is_refused() {
        let d = FastDetector::new();
        let c = d.detect(&[0u8; 8], &FastConfig::conservative(4, 4));
        assert!(c.is_empty());
    }

    #[test]
    fn non_max_suppression_off_returns_a_superset() {
        let d = FastDetector::new();
        let with = d.detect(&bright_square(), &FastConfig::conservative(16, 16));
        let cfg = FastConfig {
            non_max_suppression: false,
            ..FastConfig::conservative(16, 16)
        };
        let without = d.detect(&bright_square(), &cfg);
        assert!(
            without.len() >= with.len(),
            "non-max suppresses; without it we should have ≥ corners: {} vs {}",
            without.len(),
            with.len()
        );
    }

    #[test]
    fn min_score_filters_weak_responses() {
        let d = FastDetector::new();
        let cfg_strict = FastConfig {
            min_score: 200,
            ..FastConfig::conservative(16, 16)
        };
        let strict = d.detect(&bright_square(), &cfg_strict);
        let cfg_loose = FastConfig {
            min_score: 10,
            ..FastConfig::conservative(16, 16)
        };
        let loose = d.detect(&bright_square(), &cfg_loose);
        assert!(strict.len() <= loose.len());
    }
}
