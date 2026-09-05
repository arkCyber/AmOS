import { useCallback, useEffect, useState } from "react";
import {
  normalizeLayout,
  onLayoutChanged,
  primaryWindow,
  secondaryWindow,
  splitActive,
  wmLayoutSetScreen,
  wmLayoutSnapshot,
  wmSplit,
  wmSplitExit,
  wmSplitMove,
  wmSplitResize,
  wmSplitSwap,
  type LayoutSnapshot,
  type SplitAxis,
} from "./wm";

export interface WindowLayoutActions {
  refresh(): Promise<void>;
  setScreen(width: number, height: number): Promise<boolean>;
  split(primary: string, secondary: string, axis: SplitAxis): Promise<boolean>;
  resize(percent: number): Promise<boolean>;
  move(delta: number): Promise<boolean>;
  swap(): Promise<boolean>;
  exit(): Promise<boolean>;
}

/**
 * Shell hook that owns the layout snapshot and the split actions, so a component
 * can drive `SplitFrame`. On mount it loads the current layout; every action
 * round-trips the Tauri command and replaces the snapshot with the authoritative
 * reply (`null` when not inside Tauri → the UI shows an empty/offline state).
 */
export function useWindowLayout(): {
  snapshot: LayoutSnapshot | null;
  active: boolean;
  /** The window in the primary pane (host hint after a swap/resize), if any. */
  primary: string | null;
  /** The window in the secondary pane, if any. */
  secondary: string | null;
  actions: WindowLayoutActions;
} {
  const [snapshot, setSnapshot] = useState<LayoutSnapshot | null>(null);

  const refresh = useCallback(async () => {
    const raw = await wmLayoutSnapshot();
    setSnapshot(raw ? normalizeLayout(raw) : null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Stay in sync when the *host* broadcasts a layout change (another surface
  // split/resized): refresh from the event payload, no command round-trip needed.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onLayoutChanged((snap) => {
      if (!cancelled) setSnapshot(snap);
    }).then((un) => {
      if (cancelled) {
        un();
      } else {
        unlisten = un;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function apply(p: Promise<LayoutSnapshot | null>): Promise<boolean> {
    const raw = await p;
    if (raw) {
      setSnapshot(normalizeLayout(raw));
      return true;
    }
    return false;
  }

  const actions: WindowLayoutActions = {
    refresh,
    setScreen: (w, h) => apply(wmLayoutSetScreen(w, h)),
    split: (a, b, axis) => apply(wmSplit(a, b, axis)),
    resize: (percent) => apply(wmSplitResize(percent)),
    move: (delta) => apply(wmSplitMove(delta)),
    swap: () => apply(wmSplitSwap()),
    exit: () => apply(wmSplitExit()),
  };

  return {
    snapshot,
    active: !!snapshot && splitActive(snapshot),
    primary: snapshot ? primaryWindow(snapshot) : null,
    secondary: snapshot ? secondaryWindow(snapshot) : null,
    actions,
  };
}
