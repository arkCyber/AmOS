//! Minimal, dependency-light PNG encoder used to produce distinct app icons.
//!
//! Draws a solid RGBA tile whose color is derived deterministically from a
//! seed (e.g. the package name), so every app gets a distinct icon without
//! needing any image/font rasterization. On a real device the Waydroid runtime
//! can instead extract the actual `ic_launcher` from the APK; this generator
//! is what the in-process `DemoRuntime` serves so the Launcher shows real
//! `<img>` icons end-to-end on any host.

use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for i in 0..256u32 {
        let mut c = i;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        table[i as usize] = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut c = Vec::with_capacity(12 + data.len());
    c.extend_from_slice(&(data.len() as u32).to_be_bytes());
    c.extend_from_slice(tag);
    c.extend_from_slice(data);
    c.extend_from_slice(&crc32(&c[4..]).to_be_bytes());
    c
}

/// Encode a deterministic solid-color RGBA PNG of `size`×`size`.
/// Returns an error (instead of panicking) if the in-memory zlib pass fails —
/// callers turn that into a missing icon rather than a crash.
pub fn icon_png(seed: &str, size: u32) -> Result<Vec<u8>, String> {
    // FNV-1a hash of the seed -> RGB color.
    let mut h: u32 = 0x811C_9DC5;
    for b in seed.bytes() {
        h = (h ^ b as u32).wrapping_mul(0x0100_0193);
    }
    let (r, g, b) = ((h >> 16) as u8, (h >> 8) as u8, h as u8);

    // Scanlines: a leading filter byte 0, then RGBA pixels.
    let n = size as usize;
    let pixel = [r, g, b, 255];
    let mut raw = Vec::with_capacity(n * n * 4 + n);
    for _ in 0..n {
        raw.push(0u8);
        raw.extend_from_slice(&pixel.repeat(n));
    }
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&raw)
        .map_err(|e| format!("zlib encode: {e}"))?;
    let idat = enc.finish().map_err(|e| format!("zlib finish: {e}"))?;

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // depth=8, color=RGBA, comp/filter/interlace=0

    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    out.extend_from_slice(&chunk(b"IHDR", &ihdr));
    out.extend_from_slice(&chunk(b"IDAT", &idat));
    out.extend_from_slice(&chunk(b"IEND", &[]));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    #[test]
    fn produces_valid_png_with_signature_and_chunks() {
        let png = icon_png("com.tencent.mm", 64).expect("icon_png encodes");
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        // Has IHDR, IDAT, IEND markers.
        let s = String::from_utf8_lossy(&png);
        assert!(s.contains("IHDR") && s.contains("IDAT") && s.contains("IEND"));
    }

    #[test]
    fn idat_inflates_to_expected_size() {
        let size = 32u32;
        let png = icon_png("com.taobao.taobao", size).expect("icon_png encodes");
        // Find IDAT data and decompress it.
        let idat_start = png
            .windows(4)
            .position(|w| w == b"IDAT")
            .map(|i| i + 4)
            .expect("IDAT present");
        let len = u32::from_be_bytes([
            png[idat_start - 8],
            png[idat_start - 7],
            png[idat_start - 6],
            png[idat_start - 5],
        ]) as usize;
        let mut dec = ZlibDecoder::new(&png[idat_start..idat_start + len]);
        let mut raw = Vec::new();
        dec.read_to_end(&mut raw).expect("inflate");
        assert_eq!(raw.len(), (size * size * 4 + size) as usize);
    }

    #[test]
    fn different_seeds_give_different_colors() {
        let a = icon_png("com.a", 8).expect("png a");
        let b = icon_png("com.b", 8).expect("png b");
        // IDAT differs (different raw bytes).
        assert_ne!(a, b);
    }
}
