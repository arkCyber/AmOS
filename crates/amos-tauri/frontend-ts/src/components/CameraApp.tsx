import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { PHOTOS_KEY, newPhoto, type Photo } from "../lib/photos";

export default function CameraApp() {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [live, setLive] = useState(false);
  const [hint, setHint] = useState("");
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setHint(t("camera.noCamera"));
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setLive(true);
      })
      .catch(() => setHint(t("camera.noCamera")));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const capture = () => {
    const list = readStoreValue<Photo[]>(PHOTOS_KEY, []);
    const photo = newPhoto(`c${Date.now()}`, Date.now());
    writeStoreValue(PHOTOS_KEY, [photo, ...list]);
    setHint(t("camera.saved"));
  };

  return (
    <div className="flex flex-col p-0">
      <div className="relative grid h-64 place-items-center overflow-hidden bg-black">
        <video ref={videoRef} autoPlay muted playsInline className={"h-full w-full object-cover " + (live ? "" : "hidden")} />
        {!live && <div className="text-6xl">🏔️</div>}
      </div>
      <p className="px-3 py-2 text-center text-xs opacity-70">{hint || (live ? "· · ·" : t("camera.noCamera"))}</p>
      <div className="flex justify-center py-3">
        <button
          onClick={capture}
          aria-label="shutter"
          className="h-16 w-16 rounded-full border-4 border-white bg-neutral-500/40 shadow active:scale-95"
        />
      </div>
    </div>
  );
}
