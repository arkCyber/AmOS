/**
 * filesCloud.ts — Local "cloud" snapshot for the Files app.
 *
 * A real cloud sync service (iCloud / Google Drive / Dropbox) is not available in the
 * AmOS demo/host shell.  Instead, this module provides the **local snapshot** model:
 *
 *   1. User saves a snapshot of their device files (external collections) to
 *      localStorage under `amos.files.cloud`.
 *   2. The snapshot is a read-only mirror of the device collections at save time,
 *      with human-readable metadata (total size, entry count, collections included).
 *   3. User can restore the snapshot (imports the device file list back into
 *      externalFiles view), or delete it to free localStorage.
 *
 * This is the "local cloud" that AmOS Files actually supports without a cloud account.
 * The design is deliberately simple: one named snapshot at a time, stored as JSON
 * in localStorage, serialised through the same write-through `systemStoreSet` bridge
 * so it survives boot and appears in other WebViews.
 *
 * Snapshots are **not merged** with the live device file list — the restore flow
 * shows the diff and the user chooses.  This avoids silent data divergence.
 */

import { totalExternalBytes, type ExternalFile } from "./externalFiles";
import {
  readStoreValue,
  removeStoreValue,
  writeStoreValueChecked,
} from "./amosStore";
import { filesCloudValidate } from "./backend";
import { previewBytesLabel } from "./filesPreview";

/** The snapshot shape persisted in localStorage. */
export interface CloudSnapshot {
  /** Human label set at save time. */
  label: string;
  /** When the snapshot was taken (epoch ms). */
  savedAt: number;
  /** Collections included. */
  collections: string[];
  /**
   * Total byte size across all collections, or `null` when it cannot be measured.
   *
   * `ExternalFile.sizeBytes` is `number | null` at the wire: `null` means the platform
   * did not report that file's size. The snapshot header is the same claim the live
   * device-files header makes one line below it, so it follows the same rule
   * ([`totalExternalBytes`]): one unmeasured size withholds the total, and `0` is stored
   * only when every file really reads 0 (or the list is empty).
   */
  totalBytes: number | null;
  /** Total file count. */
  fileCount: number;
  /** The actual entries (minimal shape: id/name/kind/collection/size/ts). */
  files: CloudFile[];
}

export interface CloudFile {
  id: string;
  name: string;
  kind: string;
  collection: string;
  sizeBytes: number | null;
  ts: number;
}

const SNAPSHOT_KEY = "amos.files.cloud";

/** Promotes an `ExternalFile` to the minimal shape we store. */
export function toCloudFile(f: ExternalFile): CloudFile {
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    collection: f.collection,
    sizeBytes: f.sizeBytes,
    ts: f.ts,
  };
}

/** Build a snapshot from a flat list of `ExternalFile` rows and a user label. */
export function buildSnapshot(label: string, files: ExternalFile[]): CloudSnapshot {
  const collections = [...new Set(files.map((f) => f.collection))].sort();
  return {
    label,
    savedAt: Date.now(),
    collections,
    // The **same** rule the live device-files header follows (`totalExternalBytes`): a
    // partial sum is not "the total". The snapshot stores per-file `sizeBytes`, so a
    // reader could re-derive this — but only if it is told what the aggregate means, and
    // the wire field is the one carrier every reader shares.
    totalBytes: totalExternalBytes(files),
    fileCount: files.length,
    files: files.map(toCloudFile),
  };
}

/** Save a snapshot to localStorage.  Returns `false` when the write fails
 *  (full quota / storage unavailable, or the Rust validator rejects the
 *  snapshot as inconsistent — e.g. `file_count` ≠ `files.length`).
 *  When the validator rejects, the reason is logged so operators can debug
 *  legacy / corrupt snapshots without it leaking to the i18n surface. */
export async function saveSnapshot(snapshot: CloudSnapshot): Promise<boolean> {
  const validated = await filesCloudValidate(snapshot);
  if (!validated) {
    // Bridge rejected (validator failed) — never silently discard.
    console.warn("[filesCloud] saveSnapshot rejected by validator");
    return false;
  }
  if (!writeStoreValueChecked(SNAPSHOT_KEY, validated)) {
    console.warn("[filesCloud] saveSnapshot writeStoreValueChecked failed");
    return false;
  }
  return true;
}

/** Load the current snapshot, or `null` when none has been saved. */
export function loadSnapshot(): CloudSnapshot | null {
  return readStoreValue<CloudSnapshot | null>(SNAPSHOT_KEY, null);
}

/** Delete the saved snapshot.  Returns `true` on success. */
export function deleteSnapshot(): boolean {
  // One call, so localStorage, the Rust mirror and the change event stay one story. The hand-
  // rolled version removed the local key and told the bridge `""` — an empty string is not JSON,
  // so a reader parsing the mirrored value threw instead of seeing "absent" (REQ-A412).
  return removeStoreValue(SNAPSHOT_KEY);
}

/**
 * Human-readable size summary, or `"—"` when the total could not be measured.
 *
 * Delegates to `previewBytesLabel` so the byte→label rule (units, 1024 divisor,
 * integer/decimal/round thresholds) has a **single** JS implementation, bound to the Rust
 * `size_label` vectors by `filesPreview.test.ts`. The `null` arm is stated here rather than
 * left to `previewBytesLabel`, whose contract is about a *number* that is out of range —
 * the two must not be conflated, or a `null` total would silently ride the same path as a
 * negative one and a future change to either would move the other.
 */
export function formatSnapshotSize(bytes: number | null): string {
  if (bytes === null) return "—";
  return previewBytesLabel(bytes);
}
