import { useEffect, useState } from "react";
import { captureBlob } from "../lib/cameraCapture";

/** Decode-to-first-frame cache (module-level: shared across re-renders/apps). */
const posterCache = new Map<string, string>();

/**
 * Renders a video's first frame as a poster image by seeking a hidden <video>
 * to frame 0 and drawing it to a canvas. Falls back to nothing (callers show a
 * 🎬 glyph) when a platform can't decode/draw — e.g. headless or non-bridged
 * shells — so it's safe to use anywhere without breaking the layout.
 */
export default function VideoThumb({ id }: { id: string }) {
  const cached = posterCache.get(id);
  const [poster, setPoster] = useState<string | undefined>(cached);

  useEffect(() => {
    if (posterCache.has(id)) return; // already decoding/cached
    let alive = true;
    let url: string | null = null;
    const release = () => {
      if (url) {
        URL.revokeObjectURL(url);
        url = null;
      }
    };
    captureBlob(id)
      .then((blob) => {
        if (!alive || !blob || typeof document === "undefined") return;
        try {
          if (typeof URL === "undefined" || !URL.createObjectURL) return;
          url = URL.createObjectURL(blob);
          const v = document.createElement("video");
          v.muted = true;
          v.playsInline = true;
          v.preload = "auto";
          const cv = document.createElement("canvas");
          const ctx = cv.getContext && cv.getContext("2d");
          v.onloadeddata = () => {
            if (!alive || !ctx) {
              release();
              return;
            }
            try {
              cv.width = v.videoWidth || 320;
              cv.height = v.videoHeight || 180;
              ctx.drawImage(v, 0, 0, cv.width, cv.height);
              const data = cv.toDataURL("image/jpeg", 0.72);
              posterCache.set(id, data);
              setPoster(data);
            } catch {
              /* can't draw — fall back to the 🎬 glyph */
            } finally {
              release();
            }
          };
          v.onerror = () => release();
          v.src = url;
        } catch {
          release();
        }
      })
      .catch(() => {
        /* unavailable → fallback glyph */
      });
    return () => {
      alive = false;
      release();
    };
  }, [id]);

  if (!poster) return null;
  return <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" />;
}
