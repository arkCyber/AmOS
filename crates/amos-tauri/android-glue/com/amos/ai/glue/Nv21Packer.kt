package com.amos.ai.glue

import java.nio.ByteBuffer

/**
 * Pure `YUV_420_888 -> NV21` packing — **no Android types**, so it is unit-testable
 * on a plain JVM (`src/test`, no Robolectric/device).
 *
 * The Camera2 default output (`YUV_420_888`) is *not* guaranteed to be tightly
 * packed:
 *
 *  * `rowStride` may exceed the row width (HAL padding),
 *  * `pixelStride` is `1` for planar I420 and `2` for semi-planar NV12/NV21, where
 *    the U and V planes alias one buffer,
 *  * a plane's `ByteBuffer.limit()` may **not** cover `rowStride * rows` — some
 *    HALs hand back a shorter window for the trailing row.
 *
 * The previous packer did `buffer.rewind()` and then `buffer.get(row * rowStride +
 * col * pixelStride)` with no upper bound, which mis-reads a short window and can
 * index past `limit()`. This packer instead:
 *
 *  * reads **within each buffer's `limit()` only** — unreadable trailing bytes
 *    stay `0` instead of throwing `IndexOutOfBoundsException`,
 *  * supports `pixelStride` `1` and `2` and any positive `rowStride`,
 *  * uses a bulk row copy when a luma row is contiguous (the common case),
 *  * returns `null` for a structurally unusable frame instead of throwing.
 *
 * The output is the AmOS `CameraFrame` NV21 layout (`width * height * 3 / 2`): the
 * luma plane followed by interleaved **V then U** chroma (matching
 * `amos_sensor::PixelFormat::Nv21`).
 */
internal object Nv21Packer {

    /**
     * Pack three plane windows into NV21, or `null` when the geometry is not a
     * usable even-sized `YUV_420_888` frame (non-positive/odd dims, non-positive
     * strides). Never throws for a short/short-windowed plane — those rows are
     * zero-filled.
     */
    fun pack(
        width: Int,
        height: Int,
        y: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        u: ByteBuffer,
        uRowStride: Int,
        uPixelStride: Int,
        v: ByteBuffer,
        vRowStride: Int,
        vPixelStride: Int,
    ): ByteArray? {
        if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0) return null
        if (yRowStride <= 0 || yPixelStride <= 0) return null
        if (uRowStride <= 0 || uPixelStride <= 0) return null
        if (vRowStride <= 0 || vPixelStride <= 0) return null

        val out = ByteArray(width * height * 3 / 2)
        copyPlane(y, yRowStride, yPixelStride, width, height, out, 0)

        // Chroma is half-resolution; interleave V then U (NV21 order). Read each
        // sample only when it lies inside that plane's own readable window.
        val cw = width / 2
        val ch = height / 2
        val uLimit = u.limit()
        val vLimit = v.limit()
        var o = width * height
        for (row in 0 until ch) {
            val uRowBase = row * uRowStride
            val vRowBase = row * vRowStride
            for (col in 0 until cw) {
                val ui = uRowBase + col * uPixelStride
                val vi = vRowBase + col * vPixelStride
                out[o++] = if (vi < vLimit) v.get(vi) else 0
                out[o++] = if (ui < uLimit) u.get(ui) else 0
            }
        }
        return out
    }

    /**
     * Copy a `cols x rows` plane into `dst` starting at `dstOffset`, dense (no
     * padding). Reads are clamped to `src.limit()`; any trailing byte that is not
     * readable is left as the array's default `0`.
     */
    private fun copyPlane(
        src: ByteBuffer,
        rowStride: Int,
        pixelStride: Int,
        cols: Int,
        rows: Int,
        dst: ByteArray,
        dstOffset: Int,
    ) {
        val limit = src.limit()
        var o = dstOffset
        if (pixelStride == 1) {
            // Contiguous row -> one bulk read (still bounded by the limit).
            for (row in 0 until rows) {
                val start = row * rowStride
                if (start < limit) {
                    val avail = minOf(cols, limit - start)
                    src.get(start, dst, o, avail)
                }
                o += cols
            }
            return
        }
        for (row in 0 until rows) {
            val rowBase = row * rowStride
            for (col in 0 until cols) {
                val i = rowBase + col * pixelStride
                dst[o++] = if (i < limit) src.get(i) else 0
            }
        }
    }
}
