package com.amos.ai.glue

import android.media.Image
import java.nio.ByteBuffer

/**
 * Packs an `ImageFormat.YUV_420_888` [Image] (the Android Camera2 default output)
 * into the **NV21** byte layout AmOS carries on `CameraFrame` (a `W×H` Y plane
 * followed by interleaved VU chroma). Requires even width and height, matching
 * `amos_sensor::PixelFormat::Nv21`.
 */
internal object Nv21 {

    fun packYuv420ToNv21(image: Image): ByteArray? {
        val width = image.width
        val height = image.height
        if (width % 2 != 0 || height % 2 != 0) return null

        val planes = image.planes
        // Plane 0 = Y, plane 1 = U (Cb), plane 2 = V (Cr) for YUV_420_888.
        if (planes.size < 3) return null
        val y = copyRowStrided(planes[0], width, height)
        val u = copyRowStrided(planes[1], width / 2, height / 2)
        val v = copyRowStrided(planes[2], width / 2, height / 2)

        val nv21 = ByteArray(width * height * 3 / 2)
        System.arraycopy(y, 0, nv21, 0, y.size)
        var o = y.size
        for (i in u.indices) {
            // NV21 interleaves V then U.
            nv21[o++] = v[i]
            nv21[o++] = u[i]
        }
        return nv21
    }

    /** Copy a strided plane into a dense byte array of `cols * rows`. */
    private fun copyRowStrided(plane: Image.Plane, cols: Int, rows: Int): ByteArray {
        val buffer: ByteBuffer = plane.buffer
        buffer.rewind()
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        val out = ByteArray(cols * rows)
        if (rowStride == cols && pixelStride == 1) {
            buffer.get(out)
            return out
        }
        var o = 0
        for (row in 0 until rows) {
            var base = row * rowStride
            for (col in 0 until cols) {
                out[o++] = buffer.get(base)
                base += pixelStride
            }
        }
        return out
    }
}
