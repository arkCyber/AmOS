import { useEffect, useState } from "react";

/**
 * Reactive browser connectivity. SSR-safe (defaults to online when there is no
 * navigator) and reflects live `online`/`offline` transitions instead of a
 * one-shot snapshot taken at mount time.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // Re-sync in case the flag drifted while no listener was attached.
    setOnline(navigator.onLine !== false);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
