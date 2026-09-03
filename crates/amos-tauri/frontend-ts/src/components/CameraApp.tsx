import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { capSet, grantCap, loadLedger, saveLedger, type Capability } from "../lib/permissions";
import { PHOTOS_KEY, newPhoto, newCapturePhoto, type Photo } from "../lib/photos";

export default function CameraApp() {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [live, setLive] = useState(false);
  const [hint, setHint] = useState("");
  const [retriable, setRetriable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);

  // OS permission gate: only start the camera feed after the user has allowed
  // the "camera" capability for the camera app (see lib/permissions.ts).
  const APP_ID = "camera";
  const CAMERA_CAP: Capability = "camera";
  const [perm, setPerm] = useState<"granted" | "ask" | "refused">(() =>
    capSet(loadLedger(), APP_ID, CAMERA_CAP) ? "granted" : "ask",
  );

  const allow = () => {
    saveLedger(grantCap(loadLedger(), APP_ID, CAMERA_CAP));
    setPerm("granted");
    setAttempt((n) => n + 1); // start the stream now that it's allowed
  };

  // Whether the browser can provide a camera at all (stable per environment).
  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  // (Re)acquire the camera feed whenever `attempt` increments (mount + retry).
  useEffect(() => {
    if (perm !== "granted") {
      // Not yet allowed → never touch the camera; show the ask/denied overlay.
      setLive(false);
      setRetriable(false);
      setHint(perm === "refused" ? t("camera.permDenied") : "");
      return;
    }
    if (!supported) {
      setHint(t("camera.noCamera"));
      setRetriable(false);
      return;
    }
    let cancelled = false;
    setLive(false);
    setHint(t("camera.starting"));
    setRetriable(false);
    navigator.mediaDevices!
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = s;
        try {
          if (videoRef.current) videoRef.current.srcObject = s;
        } catch {
          // Some runtimes refuse non-MediaStream objects (or aren't camera-backed);
          // still surface a live state so capture works in demo mode.
        }
        setLive(true);
        setHint("");
        setRetriable(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const name: unknown = (err as { name?: unknown })?.name;
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setHint(t("camera.denied"));
        } else {
          // NotFound / NotReadable / Overconstrained / Security → no usable camera.
          setHint(t("camera.noCamera"));
        }
        setRetriable(true); // allow the user to ask again (e.g. after granting)
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, supported, t, perm]);

  const retry = useCallback(() => {
    if (supported) setAttempt((n) => n + 1);
  }, [supported]);

  const capture = () => {
    const list = readStoreValue<Photo[]>(PHOTOS_KEY, []);
    const now = Date.now();
    const video = videoRef.current;
    let photo: Photo;
    if (live && video && typeof document !== "undefined") {
      // Real frame: draw the live video onto a canvas and store as a data URL.
      try {
        const cv = document.createElement("canvas");
        cv.width = 640;
        cv.height = 480;
        const ctx = cv.getContext && cv.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, 640, 480);
          const data = cv.toDataURL("image/jpeg", 0.8);
          photo = newCapturePhoto(`c${now}`, now, data);
        } else {
          photo = newPhoto(`c${now}`, now);
        }
      } catch {
        photo = newPhoto(`c${now}`, now);
      }
    } else {
      // Demo path: gradient placeholder photo (also works headless).
      photo = newPhoto(`c${now}`, now);
    }
    writeStoreValue(PHOTOS_KEY, [photo, ...list]);
    setHint(t("camera.saved"));
  };

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-white">
      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-black">
        <video ref={videoRef} autoPlay muted playsInline className={"h-full w-full object-cover " + (live ? "" : "hidden")} />
        {!live && <div className="text-6xl">🏔️</div>}
        {live && <div aria-hidden className="absolute inset-x-0 top-2 text-center text-[10px] tracking-widest text-white/50">● REC</div>}
        {perm !== "granted" && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-neutral-950/90 px-6 text-center">
            <div className="text-3xl">📷</div>
            <p className="text-sm text-white/90">{t("camera.permAsk")}</p>
            {perm === "refused" && (
              <p className="text-xs text-white/50">{t("camera.permDenied")}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={allow}
                className="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95"
              >
                {t("camera.allow")}
              </button>
              <button
                onClick={() => setPerm("refused")}
                className="rounded-full bg-white/15 px-4 py-1.5 text-sm text-white ring-1 ring-white/25 active:scale-95"
              >
                {t("camera.deny")}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col items-center gap-2 px-3 py-2">
        {hint ? <p className="text-xs text-white/70">{hint}</p> : <p className="text-xs text-white/40">· · ·</p>}
        {retriable && (
          <button
            onClick={retry}
            className="rounded-full bg-white/15 px-4 py-1.5 text-xs text-white ring-1 ring-white/25 transition active:scale-95"
          >
            {t("camera.retry")}
          </button>
        )}
        <button
          onClick={capture}
          aria-label="shutter"
          className="relative my-1 grid h-[78px] w-[78px] place-items-center rounded-full ring-[5px] ring-white transition active:scale-90"
        >
          <span className="h-[62px] w-[62px] rounded-full bg-white" />
        </button>
      </div>
    </div>
  );
}
