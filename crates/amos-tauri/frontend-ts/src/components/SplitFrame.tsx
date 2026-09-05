import type { ReactNode } from "react";
import { layoutSurfaces, paneCss, type LayoutSnapshot } from "../lib/wm";

/**
 * Presentational split-screen stage: lays out the visible surfaces (`notes` +
 * `maps`, side by side when a split is active) using the pure `lib/wm` geometry.
 *
 * * Pure/DOM-testable — it never talks to Tauri; the caller supplies a normalized
 *   `LayoutSnapshot` and a `render(label)` that returns the surface's content.
 * * Only surfaces that are actually visible are mounted (a window not in the
 *   split is hidden, so it can't cover the stage).
 */
export interface SplitFrameProps {
  snapshot: LayoutSnapshot;
  /** The surfaces that may be shown (e.g. the open windows). */
  surfaces: string[];
  /** Render the content of one surface by label. */
  render: (label: string) => ReactNode;
}

export function SplitFrame({ snapshot, surfaces, render }: SplitFrameProps) {
  const placements = layoutSurfaces(snapshot, surfaces);
  return (
    <div
      className="wm-stage"
      data-testid="wm-stage"
      style={{
        position: "relative",
        width: snapshot.screen_w || undefined,
        height: snapshot.screen_h || undefined,
        overflow: "hidden",
      }}
    >
      {placements.map(({ label, rect }) => {
        const css = paneCss(rect);
        return (
          <div
            key={label}
            data-surface={label}
            style={{
              position: "absolute",
              left: css.left,
              top: css.top,
              width: css.width,
              height: css.height,
            }}
          >
            {render(label)}
          </div>
        );
      })}
    </div>
  );
}
