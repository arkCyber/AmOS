package com.amos.ai.glue

import android.media.Image

/**
 * Packs an `ImageFormat.YUV_420_888` [Image] (the Android Camera2 default output)
 * into the **NV21** byte layout AmOS carries on `CameraFrame` (a `W×H` Y plane
 * followed by interleaved VU chroma). Requires even width and height, matching
 * `amos_sensor::PixelFormat::Nv21`.
 *
 * This is a thin adapter: it only pulls each plane's own `ByteBuffer` + strides and
 * hands them to [Nv21Packer], which holds the (host-testable, bounds-safe) math.
 * Every accessor here can throw when the image's native memory has been freed
 * (`IllegalStateException: buffer is inaccessible` — see [CameraGlue]); the caller
 * is expected to run this inside its per-frame guard.
 */
internal object Nv21 {

    fun packYuv420ToNv21(image: Image): ByteArray? {
        val width = image.width
        val height = image.height
        if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0) return null

        val planes = image.planes
        // Plane 0 = Y, plane 1 = U (Cb), plane 2 = V (Cr) for YUV_420_888.
        if (planes.size < 3) return null
        val y = planes[0]
        val u = planes[1]
        val v = planes[2]
        return Nv21Packer.pack(
            width = width,
            height = height,
            y = y.buffer,
            yRowStride = y.rowStride,
            yPixelStride = y.pixelStride,
            u = u.buffer,
            uRowStride = u.rowStride,
            uPixelStride = u.pixelStride,
            v = v.buffer,
            vRowStride = v.rowStride,
            vPixelStride = v.pixelStride,
        )
    }
}
