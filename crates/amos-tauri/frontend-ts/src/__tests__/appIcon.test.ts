import { describe, expect, test } from "bun:test";
import {
  BESPOKE_IDS,
  bespokeFace,
  bespokeGlyphSvg,
  isBespokeTile,
  tileBackground,
  toneOf,
} from "../lib/appIcon";

/**
 * Pure contract tests for the framework-agnostic launcher-tile model
 * (src/lib/appIcon.ts). These lock the SINGLE SOURCE OF TRUTH both the React
 * AppIcon.tsx and the Svelte AppIcon.svelte consume, so either renderer can
 * never silently drift the tile's colour/geometry.
 */

describe("toneOf / tileBackground (deterministic per-app tint)", () => {
  test("is a deterministic hash of the id (stable across calls)", () => {
    const ids = ["clock", "phone", "messages", "ai", "interpreter", "mail", "files"];
    for (const id of ids) {
      expect(toneOf(id)).toBe(toneOf(id));
      expect(toneOf(id)).toMatch(/^linear-gradient\(135deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/i);
    }
  });

  test("different ids may share a tone but never throw (bounded palette)", () => {
    // Every known id maps to one of the 10 bounded tonal families.
    const seen = new Set<string>();
    for (const id of ["clock", "notes", "photos", "music", "mail", "store", "files"]) {
      seen.add(toneOf(id));
    }
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.size).toBeLessThanOrEqual(10);
  });

  test("bespoke ids resolve a dedicated face; others fall back to the tonal tone", () => {
    for (const id of BESPOKE_IDS) {
      expect(bespokeFace(id), id).toBeTruthy();
    }
    expect(bespokeFace("clock")).toContain("linear-gradient");
    expect(bespokeFace("notes")).not.toBeNull();
    const clockFace = bespokeFace("clock") as string;
    expect(tileBackground("clock")).toBe(clockFace);
    expect(tileBackground("phone")).toBe(toneOf("phone")); // non-bespoke falls back
  });
});

describe("isBespokeTile", () => {
  test("true exactly for the bespoke registry", () => {
    for (const id of BESPOKE_IDS) expect(isBespokeTile(id)).toBe(true);
    expect(isBespokeTile("phone")).toBe(false);
    expect(isBespokeTile("messages")).toBe(false);
    expect(isBespokeTile("nope")).toBe(false);
  });
});

describe("bespokeGlyphSvg (markup single-source)", () => {
  test("every bespoke id yields a non-empty, well-formed <svg> root", () => {
    for (const id of BESPOKE_IDS) {
      const svg = bespokeGlyphSvg(id);
      expect(svg, id).toBeTruthy();
      expect(svg!.startsWith("<svg viewBox=\"0 0 72 72\"")).toBe(true);
      expect(svg!.endsWith("</svg>")).toBe(true);
      expect(svg!.includes("aria-hidden=\"true\"")).toBe(true);
      // A glyph must actually carry vector content, not an empty shell.
      expect(svg!.length).toBeGreaterThan(150);
    }
  });

  test("non-bespoke ids return null (renderers must fall back to the emoji glyph)", () => {
    expect(bespokeGlyphSvg("phone")).toBeNull();
    expect(bespokeGlyphSvg("mail")).toBeNull();
  });

  test("distinct ids produce distinct geometry", () => {
    const seen = new Set<string>();
    for (const id of BESPOKE_IDS) seen.add(bespokeGlyphSvg(id)!);
    expect(seen.size).toBe(BESPOKE_IDS.length);
  });

  test("geometry is deterministic (no randomness)", () => {
    for (const id of BESPOKE_IDS) {
      expect(bespokeGlyphSvg(id)).toBe(bespokeGlyphSvg(id));
    }
  });
});
