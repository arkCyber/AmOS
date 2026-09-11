package com.amos.ai.glue

import java.nio.ByteBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Host-JVM tests for [Nv21Packer] — the pure `YUV_420_888 -> NV21` math that used
 * to live (and crash) in `Nv21.copyRowStrided` on device.
 *
 * These run on the plain JVM: no Android types, no Robolectric, no device. The one
 * thing they cannot cover is a *direct* plane buffer whose native memory was freed
 * ("buffer is inaccessible") — that is a lifecycle race, fixed in [CameraGlue] and
 * verified on device (see `docs/android-glue.md`).
 *
 * Run: `scripts/android-glue-nv21-check.sh` (or `./gradlew :app:testArmDebugUnitTest`).
 */
class Nv21PackerTest {

    private fun bytes(vararg xs: Int): ByteBuffer =
        ByteBuffer.wrap(ByteArray(xs.size) { xs[it].toByte() })

    /** 4x2 planar I420 (tight strides): Y 4x2, U/V 2x1, `pixelStride` 1. */
    @Test
    fun packsTightPlanarI420InNv21VuOrder() {
        val out = packed(
            y = bytes(1, 2, 3, 4, 5, 6, 7, 8), yRowStride = 4, yPixelStride = 1,
            u = bytes(10, 11), uRowStride = 2, uPixelStride = 1,
            v = bytes(20, 21), vRowStride = 2, vPixelStride = 1,
        )
        // Y plane, then chroma interleaved V,U (NV21) — not U,V (NV12).
        assertArrayEquals(
            byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 20, 10, 21, 11),
            out,
        )
    }

    /**
     * Semi-planar where U and V alias one buffer (`pixelStride` 2): Android hands
     * back a V buffer that starts one byte into the shared U buffer. The packer
     * must read each plane from *its own* buffer start.
     */
    @Test
    fun packsSemiPlanarWhereUAndVShareOneBuffer() {
        val shared = bytes(10, 20, 11, 21) // u0,v0,u1,v1
        val u = shared.duplicate()
        val vAt = shared.duplicate()
        vAt.position(1)
        val v = vAt.slice() // starts at v0
        val out = packed(
            y = bytes(1, 2, 3, 4, 5, 6, 7, 8), yRowStride = 4, yPixelStride = 1,
            u = u, uRowStride = 4, uPixelStride = 2,
            v = v, vRowStride = 4, vPixelStride = 2,
        )
        assertArrayEquals(
            byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 20, 10, 21, 11),
            out,
        )
    }

    /** A padded luma `rowStride` (HAL alignment) must be skipped, not packed. */
    @Test
    fun ignoresLumaRowPadding() {
        val out = packed(
            y = bytes(1, 2, 3, 4, 99, 99, 5, 6, 7, 8, 99, 99), yRowStride = 6, yPixelStride = 1,
            u = bytes(10, 11), uRowStride = 2, uPixelStride = 1,
            v = bytes(20, 21), vRowStride = 2, vPixelStride = 1,
        )
        assertArrayEquals(
            byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 20, 10, 21, 11),
            out,
        )
    }

    /**
     * A plane whose `limit()` is shorter than `rowStride * rows` (some HALs) must
     * be zero-filled past its readable window — never an
     * `IndexOutOfBoundsException` (which is what the old absolute reads risked).
     */
    @Test
    fun shortChromaWindowIsZeroFilledNotThrowing() {
        val out = packed(
            y = bytes(1, 2, 3, 4, 5, 6, 7, 8), yRowStride = 4, yPixelStride = 1,
            u = bytes(10, 11), uRowStride = 2, uPixelStride = 1,
            v = bytes(20), vRowStride = 2, vPixelStride = 1, // only 1 readable byte
        )
        assertArrayEquals(
            byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 20, 10, 0, 11),
            out,
        )
    }

    @Test
    fun rejectsOddAndNonPositiveGeometry() {
        val y = bytes(1, 2, 3, 4)
        assertNull(
            Nv21Packer.pack(
                3, 2, y, 3, 1, bytes(1), 2, 1, bytes(1), 2, 1,
            ),
        )
        assertNull(
            Nv21Packer.pack(
                2, 3, y, 2, 1, bytes(1), 1, 1, bytes(1), 1, 1,
            ),
        )
        assertNull(
            Nv21Packer.pack(
                2, 2, y, 0, 1, bytes(1), 1, 1, bytes(1), 1, 1,
            ),
        )
        assertNull(
            Nv21Packer.pack(
                2, 2, y, 2, 0, bytes(1), 1, 1, bytes(1), 1, 1,
            ),
        )
    }

    private fun packed(
        y: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        u: ByteBuffer,
        uRowStride: Int,
        uPixelStride: Int,
        v: ByteBuffer,
        vRowStride: Int,
        vPixelStride: Int,
    ): ByteArray =
        Nv21Packer.pack(4, 2, y, yRowStride, yPixelStride, u, uRowStride, uPixelStride, v, vRowStride, vPixelStride)
            ?: error("pack returned null for a valid 4x2 frame")
}
