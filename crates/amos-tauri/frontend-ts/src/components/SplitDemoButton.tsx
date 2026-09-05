import { useState } from "react";
import { wmSplitDemo, type LayoutSnapshot } from "../lib/wm";

export type SplitDemoStatus = "idle" | "running" | "done" | "offline" | "error";

/**
 * Dev trigger for the real multi-window host's `wm_split_demo`: pressing the
 * button runs the enter → resize/swap ×2 → exit cycle on the two front split
 * windows. Meant to be mounted in an *out-of-shell* dev window (not the single-page
 * `App.tsx`). Presentational + bridge-only, so it is DOM-testable headlessly.
 */
export function SplitDemoButton({
  onDone,
}: {
  onDone?: (snap: LayoutSnapshot | null) => void;
}) {
  const [status, setStatus] = useState<SplitDemoStatus>("idle");
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setStatus("running");
    setErr(null);
    try {
      const snap = await wmSplitDemo();
      if (snap === null) {
        setStatus("offline"); // not running inside a Tauri window
        return;
      }
      setStatus("done");
      onDone?.(snap);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  return (
    <div data-testid="split-demo">
      <button data-demo disabled={status === "running"} onClick={() => void run()}>
        {status === "running" ? "Running split demo…" : "Run split demo"}
      </button>
      <span data-status>{status}</span>
      {err && <span data-error>{err}</span>}
    </div>
  );
}
