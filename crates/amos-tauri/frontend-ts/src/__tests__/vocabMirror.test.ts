import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ACCESS, DIRS, KINDS } from "../lib/media";
import { FORM_FACTORS } from "../lib/wm";
import { STATUSES } from "../lib/webmanDownloads";
import { PUSH_RESULT_KINDS, PERMISSION_STATUSES, PUSH_STATUS_FIELDS } from "../lib/pushNotifications";

/**
 * Cross-language vocabulary pinning. Each frontend vocabulary below is the **same set** the
 * Rust side emits on the wire — the media collections/kinds/access directions
 * (`amos-media::spec`), the window-form factors (`amos-wm::form`), and the download
 * lifecycle (`amos-tauri::webman_download`). A rename on either side is a wire break, and
 * nothing tied the two together: the frontend could rename a string and every frontend test
 * (and the `vocab-mirror-scan` gate) would still pass while a real host→UI payload silently
 * stopped matching. These tests read the **Rust authority** and require the two to agree
 * both ways, so the pair is checked at build time instead of discovered on a device.
 */

const RUST_ROOT = "../../../../";

function readRust(rel: string): string {
  return readFileSync(new URL(RUST_ROOT + rel, import.meta.url), "utf8");
}

/** The string literals of an `as_str` / `tag`-style match body: `… => "lit"`. */
function matchArmStrings(src: string, from: string, span = 600): string[] {
  const i = src.indexOf(from);
  expect(i).toBeGreaterThan(0);
  const body = src.slice(i, i + span);
  return [...body.matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
}

/** The variant names of a serde enum (lowercased = the `snake_case`/`lowercase` wire tag). */
function enumVariants(src: string, name: string): string[] {
  const m = new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  expect(m).not.toBeNull();
  return [...(m?.[1] ?? "").matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*,/gm)].map((x) => (x[1] ?? "").toLowerCase());
}

/**
 * The `pub` field names of a serde struct — the keys the frontend receives verbatim (no
 * `rename_all` on `PushStatus`, so the wire name is the Rust name; a struct that DID rename
 * would need its own mapping here, which is why the doc comment says so).
 *
 * Fields inside a `#[cfg]` are included — the mirror is about names, and a name that only
 * exists on one target is still a name the frontend must read.
 */
function structFields(src: string, name: string): string[] {
  const m = new RegExp(`struct ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  expect(m).not.toBeNull();
  return [...(m?.[1] ?? "").matchAll(/^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/gm)].map((x) => x[1] ?? "");
}

/**
 * Same as {@link enumVariants} but tolerant of **struct variants** (`Unavailable { reason: String }`),
 * where the variant name is followed by ` {`, not a comma. Anchored at line start and requiring a
 * leading capital, so field names (`reason`) and types (`String`, mid-line) are not picked up.
 */
function enumVariantNames(src: string, name: string): string[] {
  const m = new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  expect(m, `${name} not found`).not.toBeNull();
  return [...(m?.[1] ?? "").matchAll(/^\s*([A-Z][A-Za-z0-9]*)\b/gm)].map((x) => (x[1] ?? "").toLowerCase());
}

const sort = (xs: readonly string[]) => [...xs].sort();

describe("frontend vocabulary == its Rust wire authority", () => {
  test("media DIRS == amos-media StandardDir::tag()", () => {
    const rust = matchArmStrings(readRust("amos-media/src/spec.rs"), "pub const fn tag(self)", 600);
    expect(rust).toHaveLength(8);
    expect(sort(DIRS)).toEqual(sort(rust));
  });

  test("media KINDS == amos-media MediaKind::as_str()", () => {
    const rust = matchArmStrings(readRust("amos-media/src/spec.rs"), "pub const fn as_str(self)", 400);
    expect(rust).toHaveLength(5);
    expect(sort(KINDS)).toEqual(sort(rust));
  });

  test("media ACCESS == amos-media AccessKind variants (serde snake_case)", () => {
    const rust = enumVariants(readRust("amos-media/src/spec.rs"), "AccessKind");
    expect(rust).toEqual(["read", "write"]);
    expect(sort(ACCESS)).toEqual(sort(rust));
  });

  test("wm FORM_FACTORS == amos-wm FormFactor::as_str()", () => {
    const rust = matchArmStrings(readRust("amos-wm/src/form.rs"), "pub const fn as_str(self)", 300);
    expect(rust).toHaveLength(4);
    expect(sort(FORM_FACTORS)).toEqual(sort(rust));
  });

  test("webmanDownload STATUSES == amos-tauri DownloadStatus variants (serde lowercase)", () => {
    const rust = enumVariants(readRust("amos-tauri/src/webman_download.rs"), "DownloadStatus");
    expect(rust).toEqual(["pending", "downloading", "completed", "failed", "canceled"]);
    expect(sort(STATUSES)).toEqual(sort(rust));
  });

  // REQ-A668: `pushNotifications.ts` declared `PushResult.kind` and `RustPermissionStatus` as
  // mirrors of `push_notifications.rs`, but no test read that file — and `PushSettings.svelte`
  // branches on the permission strings, so a Rust rename would silently stop matching.
  test("push PUSH_RESULT_KINDS == amos-tauri PushResult variants (serde tag=kind, lowercase)", () => {
    const rust = enumVariantNames(readRust("amos-tauri/src/push_notifications.rs"), "PushResult");
    expect(rust).toEqual(["ok", "unavailable", "permissiondenied", "invalidtoken", "failed"]);
    expect(sort(PUSH_RESULT_KINDS)).toEqual(sort(rust));
  });

  test("push PERMISSION_STATUSES == amos-tauri PermissionStatus variants (serde lowercase)", () => {
    const rust = enumVariantNames(readRust("amos-tauri/src/push_notifications.rs"), "PermissionStatus");
    expect(rust).toEqual(["notdetermined", "denied", "authorized", "provisional"]);
    expect(sort(PERMISSION_STATUSES)).toEqual(sort(rust));
  });

  // REQ-A865: the panel draws its request button from `permission_backend`, and a field the
  // frontend reads but Rust never sends arrives as `undefined` — falsy — so the button would
  // disappear silently rather than fail. The variant mirrors above cannot see a *field*, so
  // the new one needs its own.
  test("push PUSH_STATUS_FIELDS == amos-tauri PushStatus fields", () => {
    const rust = structFields(readRust("amos-tauri/src/push_notifications.rs"), "PushStatus");
    expect(rust).toContain("permission_backend");
    expect(sort(PUSH_STATUS_FIELDS)).toEqual(sort(rust));
  });
});
