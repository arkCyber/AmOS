import { describe, expect, test } from "bun:test";
import {
  edgeAtY,
  pastEdgeThreshold,
  homeDownToSpotlight,
  EDGE_TOP_PX,
  EDGE_BOTTOM_PX,
  EDGE_THRESHOLD_PX,
} from "../lib/edgeSwipe";

describe("edgeSwipe gesture decisions", () => {
  const H = 800;

  test("edgeAtY picks the top zone, bottom zone, or none", () => {
    expect(edgeAtY(0, H)).toBe("top");
    expect(edgeAtY(EDGE_TOP_PX, H)).toBe("top");
    expect(edgeAtY(EDGE_TOP_PX + 1, H)).toBeNull();
    expect(edgeAtY(H / 2, H)).toBeNull();
    expect(edgeAtY(H - EDGE_BOTTOM_PX - 1, H)).toBeNull(); // just above bottom zone
    expect(edgeAtY(H - EDGE_BOTTOM_PX, H)).toBe("bottom");
    expect(edgeAtY(H - 1, H)).toBe("bottom");
    // y must be strictly inside [0, h)
    expect(edgeAtY(H, H)).toBeNull();
    expect(edgeAtY(-1, H)).toBeNull();
    expect(edgeAtY(0, 0)).toBeNull(); // h <= 0 → never an edge
    expect(edgeAtY(5, -1)).toBeNull();
  });

  test("pastEdgeThreshold: top edge fires on downward travel only", () => {
    // top start, dragged down >= threshold
    expect(pastEdgeThreshold("top", 10, 10 + EDGE_THRESHOLD_PX)).toBe(true);
    expect(pastEdgeThreshold("top", 10, 10 + EDGE_THRESHOLD_PX + 20)).toBe(true);
    // too little, or moving up (wrong direction), is false
    expect(pastEdgeThreshold("top", 10, 10 + EDGE_THRESHOLD_PX - 1)).toBe(false);
    expect(pastEdgeThreshold("top", 10, 5)).toBe(false);
  });

  test("pastEdgeThreshold: bottom edge fires on upward travel only", () => {
    expect(pastEdgeThreshold("bottom", H - 4, H - 4 - EDGE_THRESHOLD_PX)).toBe(true);
    expect(pastEdgeThreshold("bottom", H - 4, H - 4 - EDGE_THRESHOLD_PX - 30)).toBe(true);
    expect(pastEdgeThreshold("bottom", H - 4, H - 4 - EDGE_THRESHOLD_PX + 1)).toBe(false);
    expect(pastEdgeThreshold("bottom", H - 4, H)).toBe(false); // moved down → no
  });

  test("homeDownToSpotlight: body downward swipe crosses threshold opens search", () => {
    const start = EDGE_TOP_PX + 60; // clearly in the home body, below the top edge
    expect(homeDownToSpotlight(start, start + EDGE_THRESHOLD_PX, H)).toBe(true);
    expect(homeDownToSpotlight(start, start + EDGE_THRESHOLD_PX + 40, H)).toBe(true);
  });

  test("homeDownToSpotlight: rejects top-edge starts, bottom-zone starts, tiny/up drags", () => {
    const H2 = 800;
    // Starts inside the reserved top status edge → stays Notification Center.
    expect(homeDownToSpotlight(EDGE_TOP_PX, EDGE_TOP_PX + 60, H2)).toBe(false);
    expect(homeDownToSpotlight(EDGE_TOP_PX + 1, EDGE_TOP_PX + 1 + 200, H2)).toBe(true);
    // Starts in the bottom (dock/Recents) zone → rejected.
    expect(homeDownToSpotlight(H2 - EDGE_BOTTOM_PX, H2 - EDGE_BOTTOM_PX + 40, H2)).toBe(false);
    // Upward / too-short drags never fire.
    const body = EDGE_TOP_PX + 100;
    expect(homeDownToSpotlight(body, body - 60, H2)).toBe(false); // upward
    expect(homeDownToSpotlight(body, body + EDGE_THRESHOLD_PX - 1, H2)).toBe(false);
    // Degenerate heights never fire.
    expect(homeDownToSpotlight(100, 300, 0)).toBe(false);
  });
});
