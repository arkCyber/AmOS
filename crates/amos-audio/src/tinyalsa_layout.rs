//! The AOSP **TinyALSA `pcm.h` facts AmOS authenticates against** — the FFI
//! layout, the enum values and the period sizing `crate::android::tinyalsa`
//! depends on, kept in one place *a host build can test*.
//!
//! Why this module exists (audit finding F-SH-112 / REQ-A642): the device seam
//! (`crate::android::tinyalsa`) is compiled only for Android, so the layout
//! contract it relies on — the field order of `struct pcm_config`, the values of
//! `enum pcm_format` / `enum pcm_flags`, and the period sizing — lived *only*
//! inside that cfg'd-out file. The seam's `header_layout_notes()` said the facts
//! were "surfaced so Android bring-up tests can assert the header has not
//! drifted", but **no test ever called it**: the facts were spelled three ways
//! (the notes string, the `fmt`/`flags` constants, the `PcmConfig` field order)
//! and nothing checked they agreed. A transcription slip in any one of them —
//! a swapped field, `PCM_IN` written as `PCM_OUT` — would compile everywhere and
//! only surface on a device as a wrong flags word handed to `pcm_open` or a
//! garbage `period_size`. That this is not hypothetical is the second finding
//! here (REQ-A1806): the module *itself* shipped `PCM_MONO`/`PCM_STEREO` — bits
//! `0x1`/`0x2`, which `pcm.h` spells `PCM_MMAP`/`PCM_NOIRQ` — and OR-ed the
//! "mono" bit into **every** `pcm_open` flags word, so capture opened
//! `0x10000001` and playback `0x1`, both requesting **mmap** on a handle the
//! seam then drives with the non-mmap `pcm_read`/`pcm_write`.
//!
//! Moving the pure-Rust facts here (no `extern "C"`, no android cfg) lets a
//! **host** test pin every one of them, so the contract is checked on every
//! `cargo test -p amos-audio` instead of only on a device. The FFI seam now
//! `use`s these definitions instead of carrying its own copy, so there is one
//! spelling to keep true.

/// `enum pcm_format` values AmOS uses (`pcm.h`).
pub mod fmt {
    /// `PCM_FORMAT_INVALID`.
    pub const PCM_FORMAT_INVALID: i32 = -1;
    /// `PCM_FORMAT_S16_LE` — the mono 16-bit little-endian format the seam opens.
    pub const PCM_FORMAT_S16_LE: i32 = 0;
    /// `PCM_FORMAT_S32_LE`.
    pub const PCM_FORMAT_S32_LE: i32 = 1;
}

/// `enum pcm_flags` values AmOS uses (`pcm.h`).
pub mod flags {
    /// `PCM_OUT` (playback direction).
    pub const PCM_OUT: u32 = 0x0000_0000;
    /// `PCM_IN` (capture direction).
    pub const PCM_IN: u32 = 0x1000_0000;
    /// `PCM_MMAP` — bit `0x1`. There is **no** `PCM_MONO`/`PCM_STEREO` in the
    /// header: channel count is a `pcm_config` field, so the low bits are all
    /// non-channel flags (`PCM_MMAP`, `PCM_NOIRQ`, …) — OR-ing a "mono" bit here
    /// silently asks the driver for mmap.
    pub const PCM_MMAP: u32 = 0x0000_0001;
    /// `PCM_NOIRQ` — bit `0x2`.
    pub const PCM_NOIRQ: u32 = 0x0000_0002;
}

/// Mirrors `struct pcm_config` (`pcm.h`): **field order and width must match**,
/// because the C ABI reads this by pointer. Every field is 4 bytes; the struct
/// is `9 * 4 = 36` bytes with no padding (asserted host-side).
#[repr(C)]
pub struct PcmConfig {
    pub channels: u32,
    pub rate: u32,
    pub period_size: u32,
    pub period_count: u32,
    pub format: i32,
    pub start_threshold: u32,
    pub stop_threshold: u32,
    pub silence_threshold: u32,
    pub avail_min: i32,
}

impl PcmConfig {
    /// Sensible defaults for a blocking mono S16 stream. `period_size` is one
    /// ~20 ms period at the requested rate.
    pub fn new(rate: u32, capture: bool) -> Self {
        let period_size = (rate / 50).max(160);
        let period_count = 4u32;
        Self {
            channels: 1,
            rate,
            period_size,
            period_count,
            format: fmt::PCM_FORMAT_S16_LE,
            start_threshold: period_size,
            stop_threshold: period_size * period_count,
            silence_threshold: 0,
            avail_min: if capture { period_size as i32 } else { 1 },
        }
    }
}

/// The flags word handed to `pcm_open` for this direction — the direction bit
/// alone, since mono is expressed by `PcmConfig::channels = 1`.
pub fn open_flags(capture: bool) -> u32 {
    if capture {
        flags::PCM_IN
    } else {
        flags::PCM_OUT
    }
}

/// The `pcm.h` facts AmOS depends on, as one greppable line, so a bring-up check
/// can assert (via `cargo test -p amos-audio`) that a constant and this summary
/// still agree.
pub fn header_layout_notes() -> &'static str {
    "pcm_config{channels,rate,period_size,period_count,format,start_threshold,\
     stop_threshold,silence_threshold,avail_min}; S16_LE=0; PCM_IN=0x10000000; PCM_MMAP=0x1"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    /// The C ABI reads `PcmConfig` by pointer, so its layout is the contract: a
    /// swapped or resized field silently corrupts `pcm_open`.
    #[test]
    fn pcm_config_layout_matches_the_header() {
        assert_eq!(
            size_of::<PcmConfig>(),
            9 * 4,
            "nine 4-byte fields, no padding"
        );
        assert_eq!(offset_of!(PcmConfig, channels), 0);
        assert_eq!(offset_of!(PcmConfig, rate), 4);
        assert_eq!(offset_of!(PcmConfig, period_size), 8);
        assert_eq!(offset_of!(PcmConfig, period_count), 12);
        assert_eq!(offset_of!(PcmConfig, format), 16);
        assert_eq!(offset_of!(PcmConfig, start_threshold), 20);
        assert_eq!(offset_of!(PcmConfig, stop_threshold), 24);
        assert_eq!(offset_of!(PcmConfig, silence_threshold), 28);
        assert_eq!(offset_of!(PcmConfig, avail_min), 32);
    }

    /// The enum values are `pcm.h`'s, not ours to choose: the direction bit is
    /// OR-ed into the flags word handed to `pcm_open`, so a wrong bit opens the
    /// wrong direction (or asks the driver for a mode the seam cannot drive).
    #[test]
    fn enum_values_match_the_header() {
        assert_eq!(fmt::PCM_FORMAT_INVALID, -1);
        assert_eq!(fmt::PCM_FORMAT_S16_LE, 0);
        assert_eq!(fmt::PCM_FORMAT_S32_LE, 1);
        assert_eq!(flags::PCM_OUT, 0x0000_0000);
        assert_eq!(flags::PCM_IN, 0x1000_0000);
        // The low bits are not a channel count: the header spells them mmap/noirq.
        assert_eq!(flags::PCM_MMAP, 0x0000_0001);
        assert_eq!(flags::PCM_NOIRQ, 0x0000_0002);
        // The direction bit and the mode bits are disjoint, so the capture word
        // built by `open_flags` carries no mode bit.
        assert_eq!(
            flags::PCM_IN & flags::PCM_MMAP,
            0,
            "direction and mmap disjoint"
        );
        assert_eq!(
            flags::PCM_IN & flags::PCM_NOIRQ,
            0,
            "direction and noirq disjoint"
        );
    }

    /// `pcm.h`'s `enum pcm_flags` has no `PCM_MONO`/`PCM_STEREO`: bit `0x1` is
    /// `PCM_MMAP` and bit `0x2` is `PCM_NOIRQ`. Mono is carried by
    /// `PcmConfig.channels` (already `1`), and the seam drives the non-mmap
    /// `pcm_read`/`pcm_write`, so the flags word must be the direction bit alone
    /// — not the direction bit OR-ed with a bit the header calls something else.
    #[test]
    fn open_flags_carry_the_direction_bit_and_nothing_else() {
        assert_eq!(open_flags(true), flags::PCM_IN, "capture: direction only");
        assert_eq!(
            open_flags(false),
            flags::PCM_OUT,
            "playback: direction only"
        );
        assert_eq!(
            open_flags(true) & flags::PCM_MMAP,
            0,
            "capture must not request mmap"
        );
        assert_eq!(
            open_flags(false) & flags::PCM_MMAP,
            0,
            "playback must not request mmap"
        );
        // The header's low bits are all non-channel flags, never a channel count.
        assert_eq!(flags::PCM_MMAP, 0x0000_0001);
        assert_eq!(flags::PCM_NOIRQ, 0x0000_0002);
    }

    /// Period sizing is what stops the ring/periods going wrong: one ~20 ms
    /// period, a 4-period buffer, and a capture `avail_min` of one period
    /// (playback starts at 1 sample). This is the arithmetic the device seam
    /// feeds straight into `pcm_open`.
    #[test]
    fn period_sizing_is_the_documented_shape() {
        let cap = PcmConfig::new(16_000, true);
        assert_eq!(cap.channels, 1);
        assert_eq!(cap.rate, 16_000);
        assert_eq!(cap.period_size, 320, "16000/50 = 320 samples ~ 20 ms");
        assert_eq!(cap.period_count, 4);
        assert_eq!(cap.format, fmt::PCM_FORMAT_S16_LE);
        assert_eq!(cap.start_threshold, 320);
        assert_eq!(cap.stop_threshold, 1_280, "4 periods");
        assert_eq!(cap.silence_threshold, 0);
        assert_eq!(cap.avail_min, 320, "capture unblocks on a full period");

        let out = PcmConfig::new(16_000, false);
        assert_eq!(out.avail_min, 1, "playback starts on the first sample");

        // A slow rate floors at 160 samples, so a period is never degenerate.
        assert_eq!(PcmConfig::new(4_000, true).period_size, 160);
    }

    /// The drift guard the seam's doc *claimed* existed: the human-readable
    /// summary and the machine constants are two spellings of the same facts,
    /// and they must agree. This is the one place the documented intent
    /// ("assert the header has not drifted") is actually established.
    #[test]
    fn header_layout_notes_agree_with_the_constants() {
        let notes = header_layout_notes();
        // Field order, left to right.
        for field in [
            "channels",
            "rate",
            "period_size",
            "period_count",
            "format",
            "start_threshold",
            "stop_threshold",
            "silence_threshold",
            "avail_min",
        ] {
            assert!(notes.contains(field), "notes omit field `{field}`: {notes}");
        }
        // The three values a transcription slip would most likely corrupt.
        assert!(
            notes.contains(&format!("S16_LE={}", fmt::PCM_FORMAT_S16_LE)),
            "S16_LE value drifted from the constant: {notes}"
        );
        assert!(
            notes.contains(&format!("PCM_IN=0x{:08X}", flags::PCM_IN)),
            "PCM_IN value drifted from the constant: {notes}"
        );
        assert!(
            notes.contains(&format!("PCM_MMAP=0x{:X}", flags::PCM_MMAP)),
            "PCM_MMAP value drifted from the constant: {notes}"
        );
    }
}
