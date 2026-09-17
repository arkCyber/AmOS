/**
 * device-probe-media-export.js — device-side acceptance for REQ-A350 (a memo must
 * be a file the user can find), evaluated **inside the running AmOS WebView**.
 *
 * This is not a node module: `scripts/device-ui-eval.mjs --file <this>` reads the
 * whole file and evaluates it as one expression, so the body is a single async IIFE
 * and must be run with `--await`. See `make device-media-probe`.
 *
 * What it does (read-only, so it never triggers a permission dialog):
 *   1. reports whether the real host bridge is reachable at all — the *only* surface
 *      a CDP client can touch is `window.__TAURI_INTERNALS__.invoke`; the app's own
 *      `invoke` (frontend-ts/src/lib/backend.ts:147) is module-local, so a probe that
 *      "calls invoke" without the internals path instead measures nothing;
 *   2. lists the camera collection (the real DCIM read — proves the bridge returns
 *      actual items and shows their shape);
 *   3. lists the recordings collection and looks for the exported-file pattern.
 *
 * How to use it as the REQ-A350 acceptance (before/after, on the device):
 *   1. `make device-media-probe` -> note `recordings.count` and `matches`;
 *   2. in the recorder, record (or pick a seed memo) and tap 保存到「录音」;
 *   3. `make device-media-probe` again -> `count` must be +1 and a name matching
 *      /^Amos-\d{8}-\d{6}\.wav$/ must appear. If the row said "已保存" but nothing
 *      appeared, the export lied — that is exactly the failure this checks.
 *
 * Errors are reported verbatim, never swallowed: a collection that throws says so.
 *
 * **Settling (REQ-A361).** Two device rounds were spent concluding "the export wrote nothing"
 * because `media_list` was read immediately after the write: Android's MediaStore inserts with
 * `IS_PENDING=1` and only publishes afterwards, and the shell's `/sdcard` (FUSE) view lags as
 * well. Both readings were wrong, and the file was there. So the probe can now **wait for its
 * expectation** instead of sampling once: set `window.__probeExpect = { collection, name }`
 * (or `{ collection, prefix }`) before running it and it polls until the item appears,
 * reporting `found` and `settledMs` — or `timedOut` after `window.__probeTimeoutMs`
 * (default 8000). For filesystem questions always prefer `content query
 * content://media/...` + the canonical `/storage/emulated/0/...` path over `ls /sdcard/...`.
 */
(async () => {
  const report = { bridge: "unknown", camera: null, recordings: null, notes: [] };
  const wait = window.__probeExpect;
  const timeoutMs = Number(window.__probeTimeoutMs) || 8000;
  const startedAt = Date.now();

  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    report.bridge = "MISSING";
    report.notes.push("window.__TAURI_INTERNALS__.invoke is not a function — the host bridge is not injected into this WebView");
    return report;
  }
  report.bridge = "ok";
  report.title = document.title;
  report.href = String(location.href).slice(0, 120);

  const list = async (collection) => {
    try {
      const items = await internals.invoke("media_list", { collection });
      const arr = Array.isArray(items) ? items : [];
      const names = arr.map((it) => (it && (it.name ?? it.file_name)) || "").filter(Boolean);
      return { count: arr.length, names: names.slice(0, 20), sample: arr[0] ?? null };
    } catch (err) {
      // Honest: an unwired/refused collection must look different from an empty one.
      return { error: String((err && err.message) || err) };
    }
  };

  const matches = (listing) =>
    !!listing &&
    Array.isArray(listing.names) &&
    listing.names.some((n) => (wait && wait.name ? n === wait.name : wait && wait.prefix ? n.startsWith(wait.prefix) : false));

  report.camera = await list("camera");
  report.recordings = await list("recordings");
  if (report.recordings && Array.isArray(report.recordings.names)) {
    report.recordings.matches = report.recordings.names.filter((n) => /^Amos-\d{8}-\d{6}\.\w+$/.test(n));
  }
  if (report.camera && report.camera.count === 0) {
    report.notes.push("camera collection is empty — either the device really has no photos, or the DCIM read is not wired");
  }

  // Bounded settle loop: re-ask the *expected* collection until it shows what we are waiting
  // for. This is the fix for the two false "nothing was written" readings above.
  if (wait && wait.collection) {
    report.expect = { collection: wait.collection, name: wait.name ?? null, prefix: wait.prefix ?? null };
    let listing = wait.collection === "camera" ? report.camera : wait.collection === "recordings" ? report.recordings : null;
    while (Date.now() - startedAt < timeoutMs && !matches(listing)) {
      await new Promise((r) => setTimeout(r, 150));
      listing = await list(wait.collection);
      if (wait.collection === "camera") report.camera = listing;
      if (wait.collection === "recordings") report.recordings = listing;
    }
    report.found = matches(listing);
    report.settledMs = Date.now() - startedAt;
    if (!report.found) report.timedOut = true;
  }
  return report;
})()
